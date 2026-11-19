import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boatApi, boatImage, boatSnapshotBinding } from "../src/places/boat.js";
import { placeCatalog } from "../src/places/place.js";
import type { PlaceDeploy } from "./places.ts";

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", {
  message: Schema.String,
}) {}

const Saved = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  error: Schema.optional(Schema.String),
});
const OneSaved = Schema.Struct({ snapshot: Saved });
const SavedList = Schema.Struct({ snapshots: Schema.Array(Saved) });
const Sandbox = Schema.Struct({ id: Schema.String, state: Schema.String });
const OneSandbox = Schema.Struct({ sandbox: Sandbox });
const Sandboxes = Schema.Struct({
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.optional(
    Schema.Struct({
      hasMore: Schema.optional(Schema.Boolean),
      nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const Finished = Schema.Struct({ exitCode: Schema.NullOr(Schema.Number), stderr: Schema.String });
const Refusal = Schema.Struct({ code: Schema.optional(Schema.String) });

const request = (
  key: string,
  path: string,
  init?: {
    readonly method: string;
    readonly body?: object;
    readonly headers?: Readonly<Record<string, string>>;
  },
) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${boatApi}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${key}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          ...init?.headers,
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    catch: () => new BoatError({ message: `Could not reach Boat for ${path}` }),
  });

const refused = (response: Response, path: string) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
    Effect.orElseSucceed(() => ({ code: undefined })),
    Effect.flatMap(
      ({ code }) =>
        new BoatError({
          message: `Boat answered ${response.status}${code === undefined ? "" : ` ${code}`} for ${path}`,
        }),
    ),
  );

const decoded = <A, I>(
  key: string,
  path: string,
  schema: Schema.Codec<A, I>,
  init?: {
    readonly method: string;
    readonly body?: object;
    readonly headers?: Readonly<Record<string, string>>;
  },
) =>
  Effect.gen(function* () {
    const response = yield* request(key, path, init);
    if (response.status === 404) {
      yield* done(response);
      return undefined;
    }
    if (!response.ok) return yield* refused(response, path);
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new BoatError({ message: `Boat sent no JSON for ${path}` }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new BoatError({ message: `Boat sent an unknown ${path}` })),
    );
  });

const done = (response: Response) =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve());

const removeSandbox = (key: string, id: string) =>
  Effect.gen(function* () {
    const path = `/sandboxes/${encodeURIComponent(id)}`;
    const response = yield* request(key, path, {
      method: "DELETE",
      headers: { "x-ascii-confirm-delete": id },
    });
    if (!response.ok && response.status !== 404) return yield* refused(response, path);
    yield* done(response);
  });

const snapshotName = (stage: string, image: string) => {
  const digest = /@sha256:([a-f0-9]{64})$/.exec(image)?.[1] ?? "";
  return `scotty-${stage.toLowerCase()}-${digest.slice(0, 12)}`;
};

const poll = <A>(read: Effect.Effect<A, BoatError>, until: (value: A) => boolean, times: number) =>
  Effect.gen(function* () {
    for (let left = times; ; left--) {
      const value = yield* read;
      if (until(value) || left <= 1) return value;
      yield* Effect.sleep("5 seconds");
    }
  });

const savedSnapshot = (key: string, name: string) =>
  decoded(key, `/saved-snapshots/${encodeURIComponent(name)}`, OneSaved).pipe(
    Effect.map((answer) => answer?.snapshot),
  );

const settledSnapshot = (key: string, name: string) =>
  poll(
    savedSnapshot(key, name),
    (snapshot) => snapshot === undefined || snapshot.status !== "saving",
    360,
  );

const buildSnapshot = (key: string, stage: string, name: string, image: string) =>
  Effect.gen(function* () {
    const made = yield* decoded(key, "/sandboxes", OneSandbox, {
      method: "POST",
      headers: { "idempotency-key": `${name}-builder` },
      body: {
        type: "small",
        ttlSeconds: 3600,
        noEnv: true,
        name: `${name}-builder`,
        labels: { "scotty-stage": stage, "scotty-role": "builder" },
      },
    });
    if (made === undefined)
      return yield* new BoatError({ message: "Boat made no sandbox to build the snapshot" });
    const builder = made.sandbox.id;
    return yield* Effect.gen(function* () {
      const path = `/sandboxes/${encodeURIComponent(builder)}`;
      const ready = yield* poll(
        decoded(key, path, OneSandbox),
        (answer) =>
          answer === undefined ||
          ["ready", "idle", "running", "error"].includes(answer.sandbox.state),
        120,
      );
      if (ready === undefined || !["ready", "idle", "running"].includes(ready.sandbox.state))
        return yield* new BoatError({
          message: `Boat builder ${builder} is ${ready?.sandbox.state ?? "missing"}`,
        });
      const pulled = image.replace(/^index\.docker\.io\//, "docker.io/");
      const loaded = yield* decoded(key, `${path}/commands`, Finished, {
        method: "POST",
        body: {
          command: `docker pull ${pulled} && docker tag ${pulled} ${boatImage} && (docker rmi ${pulled} || true)`,
          timeoutSeconds: 600,
        },
      });
      if (loaded?.exitCode !== 0)
        return yield* new BoatError({
          message: `Boat could not load the session image: ${loaded?.stderr.slice(-400) ?? "no answer"}`,
        });
      yield* decoded(key, "/saved-snapshots", OneSaved, {
        method: "POST",
        body: { sandboxId: builder, name },
      });
      yield* settledSnapshot(key, name);
    }).pipe(Effect.ensuring(removeSandbox(key, builder).pipe(Effect.ignore)));
  });

const ensureSnapshot = (key: string, stage: string, name: string, image: string) =>
  Effect.gen(function* () {
    const existing = yield* savedSnapshot(key, name);
    if (existing === undefined || existing.status === "failed")
      yield* buildSnapshot(key, stage, name, image);
    const settled = yield* settledSnapshot(key, name);
    if (settled?.status !== "ready")
      return yield* new BoatError({
        message: `Boat snapshot ${name} is ${settled?.status ?? "missing"}${settled?.error === undefined ? "" : `: ${settled.error}`}`,
      });
  });

const stageSnapshots = (key: string, stage: string) =>
  decoded(
    key,
    `/saved-snapshots?namePrefix=${encodeURIComponent(`scotty-${stage.toLowerCase()}-`)}`,
    SavedList,
  ).pipe(Effect.map((listed) => (listed?.snapshots ?? []).map((snapshot) => snapshot.name)));

const removeSnapshot = (key: string, name: string) =>
  Effect.gen(function* () {
    const path = `/saved-snapshots/${encodeURIComponent(name)}`;
    const response = yield* request(key, path, { method: "DELETE" });
    if (!response.ok && response.status !== 404) return yield* refused(response, path);
    yield* done(response);
  });

const stageSandboxes = (key: string, stage: string) =>
  Effect.gen(function* () {
    const found: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = yield* decoded(
        key,
        `/sandboxes?limit=200&label=${encodeURIComponent(`scotty-stage=${stage}`)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        Sandboxes,
      );
      found.push(...(page?.sandboxes ?? []).map((sandbox) => sandbox.id));
      const next = page?.pageInfo?.nextCursor ?? undefined;
      if (page?.pageInfo?.hasMore !== true || next === undefined) return found;
      cursor = next;
    }
  });

export const boatDeploy = {
  name: "Boat",
  env: placeCatalog.boat.key.env,
  prepare: (key, stage, image) => {
    const name = snapshotName(stage, image);
    return Effect.gen(function* () {
      yield* ensureSnapshot(key, stage, name, image);
      for (const older of yield* stageSnapshots(key, stage))
        if (older !== name) yield* removeSnapshot(key, older);
      return { [boatSnapshotBinding]: name };
    });
  },
  remove: (key, stage) =>
    Effect.gen(function* () {
      for (const id of yield* stageSandboxes(key, stage)) yield* removeSandbox(key, id);
      for (const name of yield* stageSnapshots(key, stage)) yield* removeSnapshot(key, name);
    }),
  leftovers: (key, stage) =>
    Effect.gen(function* () {
      const sandboxes = yield* stageSandboxes(key, stage);
      const snapshots = yield* stageSnapshots(key, stage);
      return [
        ...sandboxes.map((id) => `Boat sandbox ${id}`),
        ...snapshots.map((name) => `Boat saved snapshot ${name}`),
      ];
    }),
} satisfies PlaceDeploy;
