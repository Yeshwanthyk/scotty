import { Duration, Effect, Schema } from "effect";
import {
  type placeCatalog,
  PlaceFailed,
  PortFailed,
  type Place,
  type Port,
  upgrade,
} from "./place.js";

export const boatApi = "https://boat.dev/api/v1";

/** Boat's machine type for each size it offers: small is 2 vCPU and 4 GB, default 4 vCPU and 8 GB. */
export const boatTypes = {
  "standard-2": "small",
  "standard-4": "default",
} as const satisfies Record<(typeof placeCatalog.boat.sizes)[number], "small" | "default">;
export const boatSnapshotBinding = "SCOTTY_BOAT_SNAPSHOT";
/** The local tag the stage's saved snapshot holds the session image under. */
export const boatImage = "scotty-session:release";

const volumes = {
  "scotty-workspace": "/workspace",
  "scotty-state": "/var/lib/scotty",
  "scotty-home": "/home/scotty",
};
/**
 * Starts the session's container, or starts it again if it is there and stopped. Its state lives on
 * named volumes because a stop keeps only volumes and tagged images of Docker's state. The key and
 * session reach it from the sandbox's environment, so neither is in the command's text.
 */
export const boatContainer = [
  "docker start scotty >/dev/null 2>&1 ||",
  "docker run -d --name scotty --restart unless-stopped --network host",
  ...Object.entries(volumes).map(([name, at]) => `-v ${name}:${at}`),
  "-e SCOTTY_SUPERVISOR_KEY -e SCOTTY_SESSION",
  boatImage,
].join(" ");

const drain = (response: Response) =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/** The HTTP status Boat answers a sandbox listing made with `key`, or 0 when it can't be reached. */
export const checkBoatKey = (key: string) =>
  Effect.tryPromise(() =>
    fetch(`${boatApi}/sandboxes?limit=1`, { headers: { authorization: `Bearer ${key}` } }),
  ).pipe(
    Effect.tap(drain),
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0),
  );

const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  dataExpiredAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const OneSandbox = Schema.Struct({ sandbox: Sandbox });
const Sandboxes = Schema.Struct({ sandboxes: Schema.Array(Sandbox) });
const Hosted = Schema.Struct({ url: Schema.String });
const Finished = Schema.Struct({ exitCode: Schema.NullOr(Schema.Number) });
const Refusal = Schema.Struct({ code: Schema.optional(Schema.String) });
type Op = typeof PlaceFailed.fields.op.Type;

type Phase = "up" | "rising" | "falling" | "resting" | "broken" | "gone";
const phases = new Map<string, Phase>([
  ["ready", "up"],
  ["idle", "up"],
  ["running", "up"],
  ["init", "rising"],
  ["provisioning", "rising"],
  ["provisioned", "rising"],
  ["cloning", "rising"],
  ["archiving", "falling"],
  ["archived", "resting"],
  ["error", "broken"],
  ["cancelled", "gone"],
]);
const phase = (sandbox: typeof Sandbox.Type | undefined) => {
  const known: Phase =
    sandbox === undefined || (sandbox.dataExpiredAt ?? null) !== null
      ? "gone"
      : (phases.get(sandbox.state) ?? "rising");
  return known;
};

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get("retry-after") ?? "");
  return Duration.seconds(Number.isFinite(seconds) && seconds > 0 ? seconds : 2);
};
const longestWait = Duration.seconds(20);

type Sent =
  | { readonly kind: "ok"; readonly response: Response }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict"; readonly code: string; readonly wait: Duration.Duration };

/**
 * A Boat sandbox from the stage's saved snapshot, which holds the session image under a local tag.
 * The session runs in a Docker container on the sandbox's network, with its state on named
 * volumes. Pause stops the sandbox, which saves its disk; resume brings it back, warm within ten
 * minutes of the stop and from the disk after that. Ports go through Boat's hosted URLs with
 * their access token as the `_port_auth` cookie; both stay the same across stop and resume.
 */
export const boatPlace: (input: {
  readonly key: (op: Op) => Effect.Effect<string, PlaceFailed>;
  readonly env: Readonly<Record<string, unknown>>;
}) => Place = ({ key, env }) => {
  const rawSnapshot = env[boatSnapshotBinding];
  const snapshot = typeof rawSnapshot === "string" && rawSnapshot !== "" ? rawSnapshot : undefined;
  const rawStage = env["ALCHEMY_STAGE"];
  const stage = typeof rawStage === "string" ? rawStage : "";
  const hosts = new Map<string, { readonly origin: string; readonly token: string }>();
  const forget = (handle: string) => {
    for (const cached of hosts.keys()) if (cached.startsWith(`${handle}:`)) hosts.delete(cached);
  };

  const send = (
    op: Op,
    path: string,
    init?: {
      readonly method: string;
      readonly body?: object;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ) =>
    Effect.gen(function* () {
      const bearer = yield* key(op);
      for (let tries = 3; ; tries--) {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${boatApi}${path}`, {
              method: init?.method ?? "GET",
              headers: {
                authorization: `Bearer ${bearer}`,
                ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
                ...init?.headers,
              },
              ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            }),
          catch: () => new PlaceFailed({ op }),
        });
        if (response.ok) return { kind: "ok", response } satisfies Sent;
        if (response.status === 404) {
          yield* drain(response);
          return { kind: "missing" } satisfies Sent;
        }
        if (response.status === 409) {
          const body = yield* Effect.tryPromise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
            Effect.orElseSucceed(() => ({ code: undefined })),
          );
          return {
            kind: "conflict",
            code: body.code ?? "",
            wait: retryAfter(response),
          } satisfies Sent;
        }
        yield* drain(response);
        if (response.status !== 429 && response.status !== 503) {
          yield* Effect.logWarning("Boat refused", { op, status: response.status });
          return yield* new PlaceFailed({ op });
        }
        const wait = retryAfter(response);
        yield* Effect.logWarning("Boat is at a limit", { op, status: response.status });
        if (tries <= 1 || Duration.isGreaterThan(wait, longestWait))
          return yield* new PlaceFailed({ op, limited: true });
        yield* Effect.sleep(wait);
      }
    });
  const decode = <A, I>(op: Op, response: Response, schema: Schema.Codec<A, I>) =>
    Effect.tryPromise({ try: () => response.json(), catch: () => new PlaceFailed({ op }) }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new PlaceFailed({ op })),
    );
  const unexpected = (op: Op, sent: Sent) =>
    Effect.gen(function* () {
      if (sent.kind === "conflict")
        yield* Effect.logWarning("Boat refused", { op, status: 409, code: sent.code });
      return yield* new PlaceFailed({ op });
    });
  const path = (handle: string, action = "") =>
    `/sandboxes/${encodeURIComponent(handle)}${action === "" ? "" : `/${action}`}`;
  const state = (op: Op, handle: string) =>
    Effect.gen(function* () {
      const sent = yield* send(op, path(handle));
      if (sent.kind === "missing") return "gone" as const;
      if (sent.kind !== "ok") return yield* unexpected(op, sent);
      return phase((yield* decode(op, sent.response, OneSandbox)).sandbox);
    });
  const settle = (op: Op, handle: string, wanted: Phase, seconds: number) =>
    Effect.gen(function* () {
      for (let left = seconds; ; left--) {
        const now = yield* state(op, handle);
        if (now === wanted || now === "gone" || left <= 0) return now;
        if (wanted === "up" && now === "broken") return now;
        yield* Effect.sleep("1 second");
      }
    });
  const container = (op: Op, handle: string) =>
    Effect.gen(function* () {
      const sent = yield* send(op, path(handle, "commands"), {
        method: "POST",
        body: { command: boatContainer, timeoutSeconds: 120 },
      });
      if (sent.kind !== "ok") return yield* unexpected(op, sent);
      const done = yield* decode(op, sent.response, Finished);
      if (done.exitCode !== 0) {
        yield* Effect.logWarning("Boat could not start the session container", {
          handle,
          exitCode: done.exitCode,
        });
        return yield* new PlaceFailed({ op });
      }
    });
  const start = (op: Op, handle: string) =>
    Effect.gen(function* () {
      forget(handle);
      for (let tries = 5; ; tries--) {
        const before = yield* state(op, handle);
        if (before === "gone") return "gone" as const;
        if (before === "up" || before === "rising") break;
        const sent = yield* send(op, path(handle, "resume"), { method: "POST", body: {} });
        if (sent.kind === "missing") return "gone" as const;
        if (sent.kind === "ok") {
          yield* drain(sent.response);
          break;
        }
        if (sent.code === "snapshot_data_expired") return "gone" as const;
        if (
          tries <= 1 ||
          (sent.code !== "sandbox_stopping" && sent.code !== "sandbox_resuming") ||
          Duration.isGreaterThan(sent.wait, longestWait)
        )
          return yield* unexpected(op, sent);
        yield* Effect.sleep(sent.wait);
      }
      const after = yield* settle(op, handle, "up", 180);
      if (after === "gone") return "gone" as const;
      if (after !== "up") return yield* new PlaceFailed({ op });
      return "running" as const;
    });
  const host = (handle: string, port: number) =>
    Effect.gen(function* () {
      const cached = hosts.get(`${handle}:${port}`);
      if (cached !== undefined) return cached;
      const sent = yield* send("port", path(handle, "host"), {
        method: "POST",
        body: { port, localhost: true },
      });
      if (sent.kind !== "ok") return yield* unexpected("port", sent);
      const { url } = yield* decode("port", sent.response, Hosted);
      const parsed = yield* Effect.try({
        try: () => new URL(url),
        catch: () => new PlaceFailed({ op: "port" }),
      });
      const token = parsed.searchParams.get("_token");
      if (token === null) return yield* new PlaceFailed({ op: "port" });
      const target = { origin: parsed.origin, token };
      hosts.set(`${handle}:${port}`, target);
      return target;
    }).pipe(Effect.mapError(() => new PortFailed()));
  const proxied = (handle: string, port: number) => {
    const at = (target: { readonly origin: string }, url: string) => {
      const { pathname, search } = new URL(url);
      return `${target.origin}${pathname}${search}`;
    };
    const headers = (
      target: { readonly token: string },
      given?: Headers | Record<string, string>,
    ) => {
      const merged = new Headers(given);
      merged.delete("host");
      const cookie = merged.get("cookie");
      merged.set("cookie", `_port_auth=${target.token}${cookie === null ? "" : `; ${cookie}`}`);
      return merged;
    };
    const restoring = (status: number) => status === 502;
    return {
      fetch: (url, init) => {
        const once = Effect.gen(function* () {
          const target = yield* host(handle, port);
          return yield* Effect.tryPromise({
            try: () =>
              fetch(at(target, url), {
                ...(init?.method === undefined ? {} : { method: init.method }),
                headers: headers(target, init?.headers),
                ...(init?.body === undefined ? {} : { body: init.body }),
                redirect: "manual",
              }),
            catch: () => new PortFailed(),
          });
        });
        if (init?.body instanceof ReadableStream) return once;
        return Effect.gen(function* () {
          for (let tries = 3; ; tries--) {
            const response = yield* once;
            if (!restoring(response.status) || tries <= 1) return response;
            yield* drain(response);
            yield* Effect.sleep("1500 millis");
          }
        });
      },
      socket: (url, given) =>
        Effect.gen(function* () {
          for (let tries = 3; ; tries--) {
            const target = yield* host(handle, port);
            const upgrading = headers(target, given);
            upgrading.set("upgrade", "websocket");
            const answer = yield* upgrade(() => fetch(at(target, url), { headers: upgrading }));
            if (answer.socket !== undefined || !restoring(answer.status) || tries <= 1)
              return answer.socket;
            yield* Effect.sleep("1500 millis");
          }
        }),
    } satisfies Port;
  };

  return {
    create: (input) =>
      Effect.gen(function* () {
        const session = `${input.session}/${input.gen}`;
        const listed = yield* send(
          "create",
          `/sandboxes?label=${encodeURIComponent(`scotty-session=${session}`)}`,
        );
        if (listed.kind !== "ok") return yield* unexpected("create", listed);
        const existing = (yield* decode("create", listed.response, Sandboxes)).sandboxes.find(
          (item) => phase(item) !== "gone",
        );
        if (existing !== undefined) {
          if ((yield* start("create", existing.id)) !== "running")
            return yield* new PlaceFailed({ op: "create" });
          yield* container("create", existing.id);
          return existing.id;
        }
        if (snapshot === undefined) {
          yield* Effect.logError("No Boat snapshot: deploy with BOAT_API_KEY set");
          return yield* new PlaceFailed({ op: "create" });
        }
        const body = {
          from: snapshot,
          type: boatTypes[input.size === "standard-4" ? "standard-4" : "standard-2"],
          ttlSeconds: null,
          noEnv: true,
          name: `scotty-${input.session}-${input.gen}`,
          labels: { "scotty-session": session, "scotty-stage": stage },
          env: { SCOTTY_SUPERVISOR_KEY: input.key, SCOTTY_SESSION: input.session },
        };
        const made = yield* Effect.gen(function* () {
          for (let tries = 10; ; tries--) {
            const sent = yield* send("create", "/sandboxes", {
              method: "POST",
              body,
              headers: { "idempotency-key": `scotty-${stage}-${session}` },
            });
            if (sent.kind === "ok") return yield* decode("create", sent.response, OneSandbox);
            if (sent.kind !== "conflict" || sent.code !== "idempotency_in_progress" || tries <= 1)
              return yield* unexpected("create", sent);
            yield* Effect.sleep("2 seconds");
          }
        });
        const handle = made.sandbox.id;
        if ((yield* settle("create", handle, "up", 180)) !== "up")
          return yield* new PlaceFailed({ op: "create" });
        yield* container("create", handle);
        return handle;
      }),
    pause: (handle) =>
      Effect.gen(function* () {
        forget(handle);
        const sent = yield* send("pause", path(handle, "stop"), { method: "POST", body: {} });
        if (sent.kind === "missing") return "gone" as const;
        if (sent.kind !== "ok") return yield* unexpected("pause", sent);
        yield* drain(sent.response);
        const after = yield* settle("pause", handle, "resting", 300);
        if (after === "gone") return "gone" as const;
        if (after === "resting") return "paused" as const;
        return yield* new PlaceFailed({ op: "pause" });
      }),
    resume: (handle) => start("resume", handle),
    remove: (handle) =>
      Effect.gen(function* () {
        forget(handle);
        const sent = yield* send("remove", path(handle), {
          method: "DELETE",
          headers: { "x-ascii-confirm-delete": handle },
        });
        if (sent.kind === "ok") yield* drain(sent.response);
        else if (sent.kind !== "missing") return yield* unexpected("remove", sent);
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
