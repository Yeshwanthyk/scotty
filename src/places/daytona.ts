import { Effect, Schedule, Schema } from "effect";
import {
  type placeCatalog,
  PlaceFailed,
  PortFailed,
  type Place,
  type Port,
  type Size,
  upgrade,
} from "./place.js";

export const daytonaApi = "https://app.daytona.io/api";

/** Daytona's shape for each size it offers; a snapshot fixes it, so each has its own snapshot. */
export const daytonaShapes = {
  "standard-1": { cpu: 1, memory: 4, disk: 8 },
  "standard-2": { cpu: 2, memory: 8, disk: 10 },
} satisfies Record<
  (typeof placeCatalog.daytona.sizes)[number],
  { cpu: number; memory: number; disk: number }
>;
export const daytonaSnapshotBinding = "SCOTTY_DAYTONA_SNAPSHOT";

const drain = (response: Response) =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/** The HTTP status Daytona answers a sandbox listing made with `key`, or 0 when it can't be reached. */
export const checkDaytonaKey = (key: string) =>
  Effect.tryPromise(() =>
    fetch(`${daytonaApi}/sandbox?labels=${encodeURIComponent("{}")}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  ).pipe(
    Effect.tap(drain),
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0),
  );
export const daytonaSnapshot = (prefix: string, size: typeof Size.Type) => `${prefix}-${size}`;

const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  recoverable: Schema.optional(Schema.Boolean),
});
const Sandboxes = Schema.Struct({ items: Schema.Array(Sandbox) });
const Preview = Schema.Struct({ url: Schema.String, token: Schema.String });
type Op = typeof PlaceFailed.fields.op.Type;

type Phase = "up" | "rising" | "falling" | "resting" | "recoverable" | "gone";
const phases = new Map<string, Phase>([
  ["started", "up"],
  ["starting", "rising"],
  ["creating", "rising"],
  ["restoring", "rising"],
  ["pending_build", "rising"],
  ["destroying", "gone"],
  ["destroyed", "gone"],
  ["stopping", "falling"],
  ["archiving", "falling"],
  ["stopped", "resting"],
  ["archived", "resting"],
]);
const phase = (sandbox: typeof Sandbox.Type | undefined) => {
  const known: Phase =
    sandbox === undefined
      ? "gone"
      : (phases.get(sandbox.state) ??
        (sandbox.state !== "error"
          ? "rising"
          : sandbox.recoverable === true
            ? "recoverable"
            : "gone"));
  return known;
};
const label = (session: string, gen: number) => ({ "scotty-session": `${session}/${gen}` });

/**
 * A Daytona sandbox from the stage's snapshot for the session's size. Pause stops it and keeps
 * its disk; Daytona archives a long-stopped sandbox, which start still brings back. Ports go
 * through Daytona's preview proxy with the sandbox's preview token, which changes on every start.
 */
export const daytonaPlace: (input: {
  readonly key: (op: Op) => Effect.Effect<string, PlaceFailed>;
  readonly env: Readonly<Record<string, unknown>>;
}) => Place = ({ key, env }) => {
  const rawSnapshot = env[daytonaSnapshotBinding];
  const snapshot = typeof rawSnapshot === "string" && rawSnapshot !== "" ? rawSnapshot : undefined;
  const rawStage = env["ALCHEMY_STAGE"];
  const stage = typeof rawStage === "string" ? rawStage : "";
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
      yield* drain(response);
      if (response.status === 404) return undefined;
      yield* Effect.logWarning("Daytona refused", { op, status: response.status });
      return yield* new PlaceFailed({ op });
    });
  const act = (op: Op, path: string, method: string) =>
    send(op, path, { method }).pipe(
      Effect.flatMap((response) =>
        response === undefined ? Effect.succeed(false) : drain(response).pipe(Effect.as(true)),
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
  const path = (handle: string, action = "") =>
    `/sandbox/${encodeURIComponent(handle)}${action === "" ? "" : `/${action}`}`;
  const state = (op: Op, handle: string) => read(op, path(handle), Sandbox).pipe(Effect.map(phase));
  const settle = (op: Op, handle: string, wanted: Phase) =>
    state(op, handle).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (now) => now === wanted || now === "gone" || now === "recoverable",
        times: 180,
      }),
    );
  const start = (op: Op, handle: string) =>
    Effect.gen(function* () {
      forget(handle);
      const first = yield* state(op, handle);
      const before = first === "falling" ? yield* settle(op, handle, "resting") : first;
      if (before === "gone") return "gone" as const;
      if (before === "recoverable") yield* act(op, path(handle, "recover"), "POST");
      else if (before === "resting" || before === "falling")
        if (!(yield* act(op, path(handle, "start"), "POST"))) return "gone" as const;
      const after = yield* settle(op, handle, "up");
      if (after === "up") return "running" as const;
      if (after === "gone" || after === "recoverable") return "gone" as const;
      return yield* new PlaceFailed({ op });
    });
  const preview = (handle: string, port: number) =>
    Effect.gen(function* () {
      const cached = previews.get(`${handle}:${port}`);
      if (cached !== undefined) return cached;
      const answer = yield* read("port", path(handle, `ports/${port}/preview-url`), Preview);
      if (answer === undefined) return yield* new PlaceFailed({ op: "port" });
      previews.set(`${handle}:${port}`, answer);
      return answer;
    }).pipe(Effect.mapError(() => new PortFailed()));
  const proxied = (handle: string, port: number) => {
    const at = (target: typeof Preview.Type, url: string) => {
      const { pathname, search } = new URL(url);
      return `${target.url.replace(/\/$/, "")}${pathname}${search}`;
    };
    const headers = (target: typeof Preview.Type, given?: Headers | Record<string, string>) => {
      const merged = new Headers(given);
      merged.delete("host");
      merged.set("x-daytona-preview-token", target.token);
      merged.set("x-daytona-skip-preview-warning", "true");
      return merged;
    };
    const fresh = <A>(
      attempt: (target: typeof Preview.Type) => Effect.Effect<A, PortFailed>,
      stale: (answer: A) => Effect.Effect<boolean>,
    ) =>
      Effect.gen(function* () {
        const answer = yield* attempt(yield* preview(handle, port));
        if (!(yield* stale(answer))) return answer;
        previews.delete(`${handle}:${port}`);
        yield* Effect.logInfo("Daytona preview token refreshed", { handle, port });
        return yield* attempt(yield* preview(handle, port));
      });
    return {
      fetch: (url, init) => {
        const once = (target: typeof Preview.Type) =>
          Effect.tryPromise({
            try: () =>
              fetch(at(target, url), {
                ...(init?.method === undefined ? {} : { method: init.method }),
                headers: headers(target, init?.headers),
                ...(init?.body === undefined ? {} : { body: init.body }),
                redirect: "manual",
              }),
            catch: () => new PortFailed(),
          });
        return init?.body instanceof ReadableStream
          ? preview(handle, port).pipe(
              Effect.flatMap(once),
              Effect.tap((response) =>
                Effect.sync(() => {
                  if (response.status === 401) previews.delete(`${handle}:${port}`);
                }),
              ),
            )
          : fresh(once, (response) =>
              response.status === 401
                ? drain(response).pipe(Effect.as(true))
                : Effect.succeed(false),
            );
      },
      socket: (url, given) =>
        fresh(
          (target) => {
            const upgrading = headers(target, given);
            upgrading.set("upgrade", "websocket");
            return upgrade(() => fetch(at(target, url), { headers: upgrading }));
          },
          (answer) => Effect.succeed(answer.status === 401),
        ).pipe(Effect.map((answer) => answer.socket)),
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
        const existing = listed?.items.find((item) => phase(item) !== "gone");
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
        if ((yield* settle("create", made.id, "up")) !== "up")
          return yield* new PlaceFailed({ op: "create" });
        return made.id;
      }),
    pause: (handle) =>
      Effect.gen(function* () {
        forget(handle);
        if (!(yield* act("pause", path(handle, "stop"), "POST"))) return "gone" as const;
        const after = yield* settle("pause", handle, "resting");
        if (after === "gone") return "gone" as const;
        if (after === "resting" || after === "recoverable") return "paused" as const;
        return yield* new PlaceFailed({ op: "pause" });
      }),
    resume: (handle) => start("resume", handle),
    remove: (handle) =>
      Effect.gen(function* () {
        forget(handle);
        yield* act("remove", path(handle), "DELETE");
      }),
    status: (handle) =>
      state("status", handle).pipe(
        Effect.map((now) =>
          now === "up" || now === "rising"
            ? ("running" as const)
            : now === "gone"
              ? ("gone" as const)
              : ("paused" as const),
        ),
      ),
    port: (handle, port) => Effect.succeed(proxied(handle, port)),
  };
};
