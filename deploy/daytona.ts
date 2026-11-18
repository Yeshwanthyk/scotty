import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { daytonaApi, daytonaShapes, daytonaSnapshot } from "../src/places/daytona.js";
import { placeCatalog, placeKeys } from "../src/places/place.js";
import type { PlaceDeploy } from "./places.ts";

export class DaytonaError extends Schema.TaggedError<DaytonaError>()("DaytonaError", {
  message: Schema.String,
}) {}

const Snapshot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
  errorReason: Schema.optional(Schema.NullOr(Schema.String)),
});
const Snapshots = Schema.Struct({ items: Schema.Array(Snapshot), totalPages: Schema.Number });
const Sandboxes = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) });

const request = (key: string, path: string, init?: { method: string; body?: object }) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${daytonaApi}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${key}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    catch: () => new DaytonaError({ message: `Could not reach Daytona for ${path}` }),
  });

const decoded = <A, I>(key: string, path: string, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const response = yield* request(key, path);
    if (response.status === 404) return undefined;
    if (!response.ok)
      return yield* new DaytonaError({
        message: `Daytona answered ${response.status} for ${path}`,
      });
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new DaytonaError({ message: `Daytona sent no JSON for ${path}` }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new DaytonaError({ message: `Daytona sent an unknown ${path}` })),
    );
  });

const done = (response: Response) =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve());

const snapshotPrefix = (stage: string, image: string) => {
  const digest = /@sha256:([a-f0-9]{64})$/.exec(image)?.[1] ?? "";
  return `scotty-${stage}-${digest.slice(0, 12)}`;
};

const ensureSnapshots = (key: string, prefix: string, image: string) =>
  Effect.forEach(
    placeCatalog.daytona.sizes,
    (size) =>
      Effect.gen(function* () {
        const shape = daytonaShapes[size];
        const name = daytonaSnapshot(prefix, size);
        const path = `/snapshots/${encodeURIComponent(name)}`;
        const existing = yield* decoded(key, path, Snapshot);
        if (
          existing === undefined ||
          existing.state === "error" ||
          existing.state === "build_failed"
        ) {
          if (existing !== undefined)
            yield* done(
              yield* request(key, `/snapshots/${encodeURIComponent(existing.id)}`, {
                method: "DELETE",
              }),
            );
          const made = yield* request(key, "/snapshots", {
            method: "POST",
            body: {
              name,
              imageName: image.replace(/^index\.docker\.io\//, "docker.io/"),
              cpu: shape.cpu,
              memory: shape.memory,
              disk: shape.disk,
            },
          });
          yield* done(made);
          if (!made.ok)
            return yield* new DaytonaError({
              message: `Daytona refused snapshot ${name} with ${made.status}`,
            });
        }
        const ready = yield* decoded(key, path, Snapshot).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (snapshot) =>
              snapshot === undefined ||
              (snapshot.state !== "pending" &&
                snapshot.state !== "pulling" &&
                snapshot.state !== "building"),
            times: 360,
          }),
        );
        if (ready?.state !== "active")
          return yield* new DaytonaError({
            message: `Daytona snapshot ${name} is ${ready?.state ?? "missing"}${ready?.errorReason ? `: ${ready.errorReason}` : ""}`,
          });
      }),
    { concurrency: "unbounded", discard: true },
  );

const stageSnapshots = (key: string, stage: string) =>
  Effect.gen(function* () {
    const found: { readonly id: string; readonly name: string }[] = [];
    for (let page = 1; ; page++) {
      const listed = yield* decoded(key, `/snapshots?limit=100&page=${page}`, Snapshots);
      found.push(
        ...(listed?.items ?? []).filter((snapshot) => snapshot.name.startsWith(`scotty-${stage}-`)),
      );
      if (listed === undefined || page >= listed.totalPages) return found;
    }
  });

const stageSandboxes = (key: string, stage: string) =>
  decoded(
    key,
    `/sandbox?labels=${encodeURIComponent(JSON.stringify({ "scotty-stage": stage }))}`,
    Sandboxes,
  ).pipe(Effect.map((listed) => (listed?.items ?? []).map((sandbox) => sandbox.id)));

const removeDaytona = (key: string, stage: string) =>
  Effect.gen(function* () {
    for (const id of yield* stageSandboxes(key, stage))
      yield* done(yield* request(key, `/sandbox/${encodeURIComponent(id)}`, { method: "DELETE" }));
    for (const snapshot of yield* stageSnapshots(key, stage))
      yield* done(
        yield* request(key, `/snapshots/${encodeURIComponent(snapshot.id)}`, { method: "DELETE" }),
      );
  });

const daytonaLeftovers = (key: string, stage: string) =>
  Effect.gen(function* () {
    const sandboxes = yield* stageSandboxes(key, stage);
    const snapshots = yield* stageSnapshots(key, stage);
    return [
      ...sandboxes.map((id) => `Daytona sandbox ${id}`),
      ...snapshots.map((snapshot) => `Daytona snapshot ${snapshot.name}`),
    ];
  });

export const daytonaDeploy = {
  name: "Daytona",
  env: placeKeys.daytona.env,
  prepare: (key, stage, image) => {
    const prefix = snapshotPrefix(stage, image);
    return ensureSnapshots(key, prefix, image).pipe(Effect.as({ SCOTTY_DAYTONA_SNAPSHOT: prefix }));
  },
  remove: removeDaytona,
  leftovers: daytonaLeftovers,
} satisfies PlaceDeploy;
