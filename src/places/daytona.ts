import { Effect, Schedule, Schema } from "effect";
import {
  acceptSocket,
  type daytonaSizes,
  PlaceFailed,
  type Place,
  type Port,
  type Size,
} from "./place.js";

export const daytonaApi = "https://app.daytona.io/api";

/** Daytona's shape for each size it offers; a snapshot fixes it, so each has its own snapshot. */
export const daytonaShapes = {
  "standard-1": { cpu: 1, memory: 4, disk: 8 },
  "standard-2": { cpu: 2, memory: 8, disk: 10 },
} satisfies Record<(typeof daytonaSizes)[number], { cpu: number; memory: number; disk: number }>;
export const daytonaSnapshot = (prefix: string, size: typeof Size.Type) => `${prefix}-${size}`;

const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  recoverable: Schema.optional(Schema.Boolean),
});
const Sandboxes = Schema.Struct({ items: Schema.Array(Sandbox) });
const Preview = Schema.Struct({ url: Schema.String, token: Schema.String });
type Op = typeof PlaceFailed.fields.op.Type;

const running = new Set(["started", "starting", "creating", "restoring", "pending_build"]);
const resting = new Set(["stopped", "stopping", "archived", "archiving"]);
const label = (session: string, gen: number) => ({ "scotty-session": `${session}/${gen}` });

/**
 * A Daytona sandbox from the stage's snapshot for the session's size. Pause stops it and keeps
 * its disk; Daytona archives a long-stopped sandbox, which start still brings back. Ports go
 * through Daytona's preview proxy with the sandbox's preview token, which changes on every start.
 */
export const daytonaPlace: (input: {
  readonly key: (op: Op) => Effect.Effect<string, PlaceFailed>;
  readonly snapshot: string | undefined;
  readonly stage: string;
}) => Place = ({ key, snapshot, stage }) => {
  const previews = new Map<string, typeof Preview.Type>();
  const forget = (handle: string) => {
    for (const cached of previews.keys())
      if (cached.startsWith(`${handle}:`)) previews.delete(cached);
  };
  const send = (op: Op, path: string, init?: { readonly method: string; readonly body?: object }) =>
    Effect.gen(function* () {
      const bearer = yield* key(op);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${daytonaApi}${path}`, {
            method: init?.method ?? "GET",
            headers: {
              authorization: `Bearer ${bearer}`,
              ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          }),
        catch: () => new PlaceFailed({ op }),
      });
      if (response.ok) return response;
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
      if (response.status === 404) return undefined;
      yield* Effect.logWarning("Daytona refused", { op, status: response.status });
      return yield* new PlaceFailed({ op });
    });
  const act = (op: Op, path: string, method: string) =>
    send(op, path, { method }).pipe(
      Effect.flatMap((response) =>
        response === undefined
          ? Effect.succeed(false)
          : Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
              Effect.as(true),
            ),
      ),
    );
  const read = <A, I>(
    op: Op,
    path: string,
    schema: Schema.Codec<A, I>,
    init?: { readonly method: string; readonly body?: object },
  ) =>
    Effect.gen(function* () {
      const response = yield* send(op, path, init);
      if (response === undefined) return undefined;
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new PlaceFailed({ op }),
      });
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => new PlaceFailed({ op })),
      );
    });
  const state = (op: Op, handle: string) =>
    read(op, `/sandbox/${encodeURIComponent(handle)}`, Sandbox);
  const settle = (op: Op, handle: string, until: (state: string) => boolean) =>
    state(op, handle).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (sandbox) =>
          sandbox === undefined ||
          until(sandbox.state) ||
          sandbox.state === "destroyed" ||
          sandbox.state === "error",
        times: 180,
      }),
    );
  const start = (op: Op, handle: string) =>
    Effect.gen(function* () {
      forget(handle);
      const before = yield* state(op, handle);
      if (before === undefined || before.state === "destroyed" || before.state === "destroying")
        return "gone" as const;
      if (before.state === "error") {
        if (before.recoverable !== true) return "gone" as const;
        yield* act(op, `/sandbox/${encodeURIComponent(handle)}/recover`, "POST");
      } else if (before.state !== "started") {
        if (!(yield* act(op, `/sandbox/${encodeURIComponent(handle)}/start`, "POST")))
          return "gone" as const;
      }
      const after = yield* settle(op, handle, (current) => current === "started");
      if (after?.state === "started") return "running" as const;
      if (after === undefined || after.state === "destroyed" || after.state === "error")
        return "gone" as const;
      return yield* new PlaceFailed({ op });
    });
  const preview = (handle: string, port: number) =>
    Effect.gen(function* () {
      const cached = previews.get(`${handle}:${port}`);
      if (cached !== undefined) return cached;
      const answer = yield* read(
        "port",
        `/sandbox/${encodeURIComponent(handle)}/ports/${port}/preview-url`,
        Preview,
      );
      if (answer === undefined) return yield* new PlaceFailed({ op: "port" });
      previews.set(`${handle}:${port}`, answer);
      return answer;
    });
  const proxied = (target: typeof Preview.Type) => {
    const at = (url: string) => {
      const { pathname, search } = new URL(url);
      return `${target.url.replace(/\/$/, "")}${pathname}${search}`;
    };
    const headers = (given?: Headers | Record<string, string>) => {
      const merged = new Headers(given);
      merged.delete("host");
      merged.set("x-daytona-preview-token", target.token);
      merged.set("x-daytona-skip-preview-warning", "true");
      return merged;
    };
    return {
      fetch: (url, init) =>
        fetch(at(url), {
          ...(init?.method === undefined ? {} : { method: init.method }),
          headers: headers(init?.headers),
          ...(init?.body === undefined ? {} : { body: init.body }),
          redirect: "manual",
        }),
      socket: (url, given, signal) => {
        const upgrade = headers(given);
        upgrade.set("upgrade", "websocket");
        const pending = fetch(at(url), { headers: upgrade });
        signal.addEventListener("abort", () =>
          pending.then(
            (late) => {
              acceptSocket(late)?.close();
            },
            () => undefined,
          ),
        );
        return pending.then((response) => (signal.aborted ? undefined : acceptSocket(response)));
      },
    } satisfies Port;
  };
  return {
    create: (input) =>
      Effect.gen(function* () {
        const labels = label(input.session, input.gen);
        const listed = yield* read(
          "create",
          `/sandbox?labels=${encodeURIComponent(JSON.stringify(labels))}`,
          Sandboxes,
        );
        const existing = listed?.items.find(
          (item) => item.state !== "destroyed" && item.state !== "destroying",
        );
        if (existing !== undefined) {
          if ((yield* start("create", existing.id)) === "running") return existing.id;
          return yield* new PlaceFailed({ op: "create" });
        }
        if (snapshot === undefined) {
          yield* Effect.logError("No Daytona snapshot: deploy with DAYTONA_API_KEY set");
          return yield* new PlaceFailed({ op: "create" });
        }
        const made = yield* read("create", "/sandbox", Sandbox, {
          method: "POST",
          body: {
            snapshot: daytonaSnapshot(snapshot, input.size),
            env: { SCOTTY_SUPERVISOR_KEY: input.key, SCOTTY_SESSION: input.session },
            labels: { ...labels, "scotty-stage": stage },
            autoStopInterval: 0,
            autoDeleteInterval: -1,
            public: false,
          },
        });
        if (made === undefined) return yield* new PlaceFailed({ op: "create" });
        const ready = yield* settle("create", made.id, (current) => current === "started");
        if (ready?.state !== "started") return yield* new PlaceFailed({ op: "create" });
        return made.id;
      }),
    pause: (handle) =>
      Effect.gen(function* () {
        forget(handle);
        if (!(yield* act("pause", `/sandbox/${encodeURIComponent(handle)}/stop`, "POST")))
          return "gone" as const;
        const after = yield* settle("pause", handle, (current) => resting.has(current));
        if (after === undefined || after.state === "destroyed" || after.state === "error")
          return "gone" as const;
        if (resting.has(after.state)) return "paused" as const;
        return yield* new PlaceFailed({ op: "pause" });
      }),
    resume: (handle) => start("resume", handle),
    remove: (handle) =>
      Effect.gen(function* () {
        forget(handle);
        yield* act("remove", `/sandbox/${encodeURIComponent(handle)}`, "DELETE");
      }),
    status: (handle) =>
      state("status", handle).pipe(
        Effect.map((sandbox) =>
          sandbox === undefined
            ? ("gone" as const)
            : running.has(sandbox.state)
              ? ("running" as const)
              : resting.has(sandbox.state) ||
                  (sandbox.state === "error" && sandbox.recoverable === true)
                ? ("paused" as const)
                : ("gone" as const),
        ),
      ),
    port: (handle, port) => preview(handle, port).pipe(Effect.map(proxied)),
    tunnel: true,
  };
};
