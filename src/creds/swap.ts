import { Effect, Exit, Schema } from "effect";

const ChatGptPath = Schema.String.check(Schema.isPattern(/^\/p\/chatgpt\/responses$/));
const decodePath = Schema.decodeUnknownExit(ChatGptPath);

export class SwapFailure extends Schema.TaggedError<SwapFailure>()("SwapFailure", {
  message: Schema.String,
}) {}

const blockedHeaders = [
  "host",
  "authorization",
  "x-api-key",
  "x-github-token",
  "cookie",
  "proxy-authorization",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "cf-access-client-id",
  "cf-access-client-secret",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

/** Compare encoded bytes without early termination, even for unequal lengths. */
export function matchesSentinel(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

export function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connection = source.get("connection");
  if (connection) {
    for (const name of connection.split(",")) headers.delete(name.trim());
  }
  for (const name of blockedHeaders) headers.delete(name);
  return headers;
}

/** Invoked only by the internal outbound interception binding, not by a public API route. */
export function swapChatGpt(request: Request, sentinel: string, token: string, accountId: string) {
  return Effect.gen(function* () {
    const incoming = new URL(request.url);
    if (Exit.isFailure(decodePath(incoming.pathname))) {
      return yield* new SwapFailure({ message: "Unsupported ChatGPT path" });
    }
    const bearer = request.headers.get("authorization");
    if (!bearer?.startsWith("Bearer ") || !matchesSentinel(bearer.slice(7), sentinel)) {
      return yield* new SwapFailure({ message: "Invalid session credential" });
    }
    const destination = new URL(
      `https://chatgpt.com/backend-api/codex/responses${incoming.search}`,
    );
    const headers = cleanHeaders(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("chatgpt-account-id", accountId);
    return yield* Effect.tryPromise({
      try: () =>
        fetch(destination, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      catch: () => new SwapFailure({ message: "ChatGPT upstream unavailable" }),
    });
  });
}
