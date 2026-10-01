import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Definition, RunStatus } from "../src/automations/automation.js";
import {
  Connection,
  ConnectionCreated,
  DeliveryOutcome,
  DeliveryReason,
} from "../src/creds/connections.js";

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  code: Schema.String,
  message: Schema.String,
  hint: Schema.String,
  exit: Schema.Number,
}) {}

export const failure = (code: string, message: string, hint: string, exit = 1) =>
  new CliFailure({ code, message, hint, exit });

const ApiError = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    code: Schema.optional(Schema.String),
    hint: Schema.optional(Schema.String),
  }),
});
export const Url = Schema.String.check(Schema.isPattern(/^https:\/\/[^/]+\/?$/));

export const Session = Schema.Struct({
  identity: Schema.Struct({ id: Schema.String }),
  authority: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("stable"), lifecycle: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("transitioning"), action: Schema.String }),
  ]),
  display: Schema.Struct({
    title: Schema.String,
    repository: Schema.String,
    branch: Schema.String,
    agentKind: Schema.String,
    activeAt: Schema.String,
  }),
  progress: Schema.Struct({ working: Schema.Boolean }),
});
export const View = Schema.Struct({ version: Schema.Number, session: Session });
export const List = Schema.Struct({ version: Schema.Number, sessions: Schema.Array(Session) });
export const Created = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  branch: Schema.String,
  provider: Schema.String,
  status: Schema.String,
  url: Schema.String,
  // A create with a key already used steers that session instead of making one.
  steered: Schema.optional(Schema.Boolean),
});
export { Connection, ConnectionCreated };
export const WebhookCreated = ConnectionCreated.members[0];
export const Connections = Schema.Struct({ connections: Schema.Array(Connection) });
export const ConnectionRemoved = Schema.Struct({ name: Schema.String, removed: Schema.Boolean });
export const Deliveries = Schema.Struct({
  deliveries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      connection: Schema.String,
      at: Schema.Number,
      outcome: DeliveryOutcome,
      reason: Schema.NullOr(DeliveryReason),
      session: Schema.NullOr(Schema.String),
    }),
  ),
});
export const Run = Schema.Struct({
  id: Schema.String,
  automation: Schema.String,
  trigger: Schema.Literals(["schedule", "event", "manual"]),
  at: Schema.Number,
  status: RunStatus,
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  key: Schema.NullOr(Schema.String),
});
// How the turn a run sent went, read from its session; null when it reached none.
export const Runs = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      ...Run.fields,
      outcome: Schema.NullOr(
        Schema.Literals(["working", "completed", "aborted", "failed", "stopped"]),
      ),
    }),
  ),
});
export const RunFired = Schema.Struct({
  id: Schema.String,
  automation: Schema.String,
  status: Run.fields.status,
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
});
export const Automations = Schema.Struct({
  automations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ...Definition.fields,
      enabled: Schema.Boolean,
      nextDue: Schema.NullOr(Schema.Number),
      created: Schema.Number,
      lastRun: Schema.NullOr(Run),
    }),
  ),
});
export const AutomationSwitched = Schema.Struct({ name: Schema.String, enabled: Schema.Boolean });
export const AutomationRemoved = Schema.Struct({ name: Schema.String, removed: Schema.Boolean });
export const Reply = Schema.Struct({ status: Schema.String });
export const Removed = Schema.Struct({ id: Schema.String, removed: Schema.Boolean });
export const Settings = Schema.Struct({
  instructions: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      enabled: Schema.Boolean,
      size: Schema.Number,
    }),
  ),
});
export const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
});
export const Saved = Schema.Struct({ saved: Schema.Boolean });
export const SkillRemoved = Schema.Struct({ name: Schema.String, removed: Schema.Boolean });
export const Conversation = Schema.Struct({
  version: Schema.Number,
  turns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      user: Schema.String,
      assistant: Schema.String,
      files: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          type: Schema.String,
          size: Schema.Number,
          caption: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
// Events keep every field so agents can read answers and errors from the raw log.
export const Log = Schema.Array(
  Schema.StructWithRest(
    Schema.Struct({ seq: Schema.Number, at: Schema.Number, kind: Schema.String }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);
export const Started = Schema.Union([
  Schema.Struct({
    verificationUrl: Schema.String,
    userCode: Schema.String,
    interval: Schema.Number,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    stage: Schema.String,
    httpStatus: Schema.NullOr(Schema.Number),
    code: Schema.NullOr(Schema.String),
  }),
]);
export const ChatGptStatus = Schema.Struct({
  status: Schema.Literals(["signed-in", "signed-out", "expiring"]),
  expiresAt: Schema.NullOr(Schema.Number),
});
export const ClaudeStatus = ChatGptStatus;
export const GitHubStatus = Schema.Struct({
  status: Schema.Literals(["set", "missing"]),
  login: Schema.NullOr(Schema.String),
});
export const Polled = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signed-in"), expiresAt: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("pending"), interval: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    stage: Schema.String,
    httpStatus: Schema.NullOr(Schema.Number),
    code: Schema.NullOr(Schema.String),
  }),
]);

export const target = (input: unknown) =>
  Schema.decodeUnknownEffect(Url)(input).pipe(
    Effect.mapError(() =>
      failure("setup", "Scotty is not set up on this machine", "scotty init", 3),
    ),
  );

export const access = (url: string) =>
  Effect.gen(function* () {
    const hint = `cloudflared access login ${url}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make("cloudflared", ["access", "token", `-app=${url}`], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.mapError(() =>
          failure(
            "cloudflared_missing",
            "cloudflared is not installed",
            "brew install cloudflared",
            3,
          ),
        ),
      );
    const token = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.map((text) => text.trim()),
      Effect.mapError(() => failure("access_login", "Access token unavailable", hint, 3)),
    );
    const code = yield* child.exitCode.pipe(
      Effect.mapError(() => failure("access_login", "Access token unavailable", hint, 3)),
    );
    if (code !== 0 || !token)
      return yield* failure("access_login", "Not signed in to Cloudflare Access", hint, 3);
    return token;
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(
          failure(
            "access_login",
            "cloudflared did not answer",
            `cloudflared access login ${url}`,
            3,
          ),
        ),
    }),
  );

export function client(settings: { readonly url: string; readonly token: string }) {
  const origin = new URL(settings.url);
  return <S extends Schema.Top>(
    path: string,
    schema: S,
    options?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      key?: string;
    },
  ) =>
    Effect.gen(function* () {
      const url = new URL(path, origin);
      if (url.origin !== origin.origin || !url.pathname.startsWith("/api/"))
        return yield* failure("bad_path", "Invalid API path", "Use a scotty command", 2);
      const headers = new Headers({
        "cf-access-token": settings.token,
        accept: "application/json",
      });
      // Bytes go as they are (a skill zip); anything else is JSON.
      const raw =
        options?.body instanceof Uint8Array ? new Blob([new Uint8Array(options.body)]) : undefined;
      if (options?.body !== undefined)
        headers.set("content-type", raw ? "application/zip" : "application/json");
      if (options?.key) headers.set("idempotency-key", options.key);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: options?.method ?? "GET",
            headers,
            signal: AbortSignal.timeout(15000),
            ...(options?.body === undefined ? {} : { body: raw ?? JSON.stringify(options.body) }),
          }),
        catch: () =>
          failure(
            "network",
            "Worker did not reply within 15 seconds",
            `Check ${settings.url} and try again`,
          ),
      });
      const body: unknown = yield* Effect.promise(() => response.json().catch(() => null));
      if (!response.ok) {
        const parsed = Schema.decodeUnknownOption(ApiError)(body);
        const error = Option.isSome(parsed) ? parsed.value.error : undefined;
        return yield* failure(
          error?.code ?? "http_error",
          error?.message ?? `HTTP ${response.status}`,
          error?.hint ??
            (response.status === 401 || response.status === 403
              ? `cloudflared access login ${settings.url}`
              : response.status === 404
                ? "scotty ls"
                : "scotty doctor"),
          response.status === 401 || response.status === 403 ? 3 : 1,
        );
      }
      if (body === null)
        return yield* failure(
          "invalid_reply",
          `HTTP ${response.status} was not JSON`,
          `Check ${settings.url}`,
        );
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() =>
          failure(
            "invalid_reply",
            `Unexpected reply from ${path}`,
            `Check that ${settings.url} runs a compatible Scotty Worker`,
          ),
        ),
      );
    });
}
