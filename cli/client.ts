import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
const Url = Schema.String.check(Schema.isPattern(/^https:\/\/[^/]+/));

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
  }),
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
});
export const Reply = Schema.Struct({ status: Schema.String });
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
      failure(
        "setup",
        "SCOTTY_URL must be an https URL",
        "export SCOTTY_URL=https://<your-access-host>",
        3,
      ),
    ),
  );

export const access = (url: string) =>
  Effect.gen(function* () {
    const hint = `cloudflared access login ${url}`;
    const token = yield* Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("cloudflared", ["access", "token", `-app=${url}`], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const value = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (all, part) => all + part,
        ),
      );
      if ((yield* child.exitCode) !== 0)
        return yield* failure("access_login", "Access token unavailable", hint, 3);
      return value.trim();
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      Effect.timeout("15 seconds"),
      Effect.mapError(() => failure("access_login", "Access token unavailable", hint, 3)),
    );
    if (!token) return yield* failure("access_login", "Access token unavailable", hint, 3);
    return token;
  });

export function client(settings: { readonly url: string; readonly token: string }) {
  const origin = new URL(settings.url);
  return <S extends Schema.Top>(
    path: string,
    schema: S,
    options?: { method?: "GET" | "POST"; body?: unknown; key?: string },
  ) =>
    Effect.gen(function* () {
      const url = new URL(path, origin);
      if (url.origin !== origin.origin || !url.pathname.startsWith("/api/"))
        return yield* failure("bad_path", "Invalid API path", "Use a scotty command", 2);
      const headers = new Headers({
        "cf-access-token": settings.token,
        accept: "application/json",
      });
      if (options?.body !== undefined) headers.set("content-type", "application/json");
      if (options?.key) headers.set("idempotency-key", options.key);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: options?.method ?? "GET",
            headers,
            signal: AbortSignal.timeout(15000),
            ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          }),
        catch: () =>
          failure(
            "network",
            "Worker did not reply within 15 seconds",
            `Check ${settings.url} and try again`,
          ),
      });
      const body: unknown = yield* Effect.tryPromise({
        try: () => response.json().catch(() => null),
        catch: () =>
          failure("invalid_reply", `HTTP ${response.status} was not JSON`, `Check ${settings.url}`),
      });
      if (!response.ok) {
        const parsed = Schema.decodeUnknownOption(ApiError)(body);
        const error = Option.isSome(parsed) ? parsed.value.error : undefined;
        return yield* failure(
          error?.code ?? "http_error",
          error?.message ?? `HTTP ${response.status}`,
          error?.hint ??
            (response.status === 401 || response.status === 403
              ? `cloudflared access login ${settings.url}`
              : `Check the request and retry: scotty doctor`),
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
