import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Url = Schema.String.check(Schema.isPattern(/^https:\/\//));
export class E2eError extends Schema.TaggedError<E2eError>()("E2eError", {
  message: Schema.String,
}) {}

export const config = () =>
  Effect.gen(function* () {
    const url = yield* Schema.decodeUnknownEffect(Url)(process.env.SCOTTY_URL).pipe(
      Effect.mapError(
        () =>
          new E2eError({ message: "SCOTTY_URL must be set to the Access-protected deployment" }),
      ),
    );
    const login = `cloudflared access login ${url}`;
    const token = yield* Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        ChildProcess.make("cloudflared", ["access", "token", `-app=${url}`], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const value = yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (all, part) => all + part,
        ),
      );
      const exit = yield* process.exitCode;
      if (exit !== 0)
        return yield* new E2eError({ message: `Access token unavailable; run ${login}` });
      return value.trim();
    }).pipe(
      Effect.scoped,
      Effect.provide(BunServices.layer),
      Effect.timeout("15 seconds"),
      Effect.mapError(() => new E2eError({ message: `Access token unavailable; run ${login}` })),
    );
    const jwt = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)))(
      token,
    ).pipe(
      Effect.mapError(() => new E2eError({ message: `Access token unavailable; run ${login}` })),
    );
    return { url, token: jwt };
  });

export function client(settings: { readonly url: string; readonly token: string }) {
  const origin = new URL(settings.url);
  return <S extends Schema.Top>(
    path: string,
    schema: S,
    options?: { method?: "GET" | "POST"; body?: unknown; req?: string },
  ) =>
    Effect.gen(function* () {
      const url = new URL(path, origin);
      if (url.origin !== origin.origin) return yield* new E2eError({ message: "Invalid e2e path" });
      const headers = new Headers({
        "cf-access-token": settings.token,
        accept: "application/json",
      });
      if (options?.body !== undefined) headers.set("content-type", "application/json");
      if (options?.req) headers.set("idempotency-key", options.req);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: options?.method ?? "GET",
            headers,
            ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          }),
        catch: () => new E2eError({ message: "E2e network failure" }),
      });
      if (!response.ok)
        return yield* new E2eError({
          message: `E2e request ${path} returned HTTP ${response.status}`,
        });
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new E2eError({ message: "Invalid e2e JSON" }),
      });
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => new E2eError({ message: "Unexpected e2e response" })),
      );
    });
}
