import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Context, Data, Effect, Layer, Option, Result } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Bindings } from "./bindings";
import {
  decodeCredentialPatchOption,
  decodeCredentialRefreshLeaseOption,
  decodeJsonValue,
  decodeOAuthContainerResultOption,
  decodeOAuthRefreshRequestOption,
  decodeOAuthUpstreamSuccessOption,
  decodeRawCodexCredential,
  decodeRawCodexTokenSet,
  decodeRawOAuthUpstreamSuccess,
  decodeStoredCredentialOption,
  type CodexCredentialBundle,
  type CredentialPatch,
  type CredentialRefreshLease,
  type OAuthContainerResult,
  type OAuthRefreshRequest,
  type StoredCredential,
} from "./contracts";

export const CODEX_SENTINEL_PREFIX = "scotty-codex-";
export const GITHUB_SENTINEL_PREFIX = "scotty-github-";

export const ALLOWED_HOSTS = [
  "api.openai.com",
  "chatgpt.com",
  "auth.openai.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "*.oaiusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
] as const;

export type {
  CodexCredentialBundle,
  CredentialPatch,
  CredentialRefreshLease,
  StoredCredential,
} from "./contracts";

type EgressContext = OutboundHandlerContext<unknown>;

export class EgressFailure extends Data.TaggedError("EgressFailure")<{
  readonly reason: "transport" | "vault" | "persistence";
  readonly message: string;
}> {}

class EgressBoundaryFailure extends Data.TaggedError("EgressBoundaryFailure")<{
  readonly message: string;
}> {}

export interface EgressVaultShape {
  readonly read: (sentinel: string) => Effect.Effect<StoredCredential | null, EgressFailure>;
  readonly begin: (sentinel: string) => Effect.Effect<CredentialRefreshLease | null, EgressFailure>;
  readonly persist: (
    sentinel: string,
    patch: CredentialPatch,
    nonce: string,
  ) => Effect.Effect<void, EgressFailure>;
  readonly cancel: (sentinel: string, nonce: string) => Effect.Effect<void, EgressFailure>;
}

export class EgressVault extends Context.Service<EgressVault, EgressVaultShape>()(
  "scotty/EgressVault",
) {}

export interface EgressTransportShape {
  readonly forward: (
    request: Request,
    url: URL,
    headers: Headers,
  ) => Effect.Effect<Response, EgressFailure>;
}

export class EgressTransport extends Context.Service<EgressTransport, EgressTransportShape>()(
  "scotty/EgressTransport",
) {}

export function egressTransportLayer(
  nativeFetch: typeof globalThis.fetch,
): Layer.Layer<EgressTransport> {
  return Layer.succeed(EgressTransport)(
    EgressTransport.of({
      forward: (request, url, headers) =>
        Effect.tryPromise({
          try: (signal) => {
            const body =
              request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
            const init: RequestInit = {
              method: request.method,
              headers,
              body,
              redirect: "manual",
              signal,
            };
            if (body) Reflect.set(init, "duplex", "half");
            const outgoing = new Request(
              `https://${url.hostname}${url.pathname}${url.search}`,
              init,
            );
            return nativeFetch(outgoing);
          },
          catch: () => new EgressFailure({ reason: "transport", message: "Egress request failed" }),
        }),
    }),
  );
}

export function parseCodexCredential(raw: string): CodexCredentialBundle {
  const json = Option.getOrThrowWith(decodeJsonValue(raw), () =>
    boundaryFailure("CODEX_AUTH_JSON is not valid JSON"),
  );
  const decoded = Option.getOrThrowWith(decodeRawCodexCredential(json), () =>
    boundaryFailure("CODEX_AUTH_JSON must contain a JSON object"),
  );

  const apiKey = optionalString(decoded.OPENAI_API_KEY);
  const legacyAccountId = optionalString(decoded.account_id);
  let tokens: CodexCredentialBundle["tokens"];
  if (decoded.tokens !== undefined && decoded.tokens !== null) {
    const decodedTokens = Option.getOrThrowWith(decodeRawCodexTokenSet(decoded.tokens), () =>
      boundaryFailure("CODEX_AUTH_JSON tokens must be an object"),
    );
    tokens = {
      id_token: optionalString(decodedTokens.id_token) ?? undefined,
      access_token: optionalString(decodedTokens.access_token) ?? undefined,
      refresh_token: optionalString(decodedTokens.refresh_token) ?? undefined,
      account_id: optionalString(decodedTokens.account_id),
    };
  }

  Option.getOrThrowWith(Option.fromNullishOr(apiKey ?? tokens?.access_token), () =>
    boundaryFailure("CODEX_AUTH_JSON must contain OPENAI_API_KEY or tokens.access_token"),
  );

  return {
    OPENAI_API_KEY: apiKey,
    tokens,
    account_id: legacyAccountId,
    last_refresh: optionalString(decoded.last_refresh),
  };
}

export function decodeStoredCredential(value: unknown): StoredCredential {
  return Option.getOrThrowWith(decodeStoredCredentialOption(value), () =>
    boundaryFailure("Stored credential record is invalid"),
  );
}

export function decodeCredentialPatch(value: unknown): CredentialPatch {
  return Option.getOrThrowWith(decodeCredentialPatchOption(value), () =>
    boundaryFailure("Credential patch is invalid"),
  );
}

export function decodeCredentialRefreshLease(value: unknown): CredentialRefreshLease | null {
  return Option.getOrThrowWith(decodeCredentialRefreshLeaseOption(value), () =>
    boundaryFailure("Credential refresh lease is invalid"),
  );
}

export function parseOAuthRefreshRequest(value: unknown): OAuthRefreshRequest | null {
  return Option.getOrNull(decodeOAuthRefreshRequestOption(value, { onExcessProperty: "preserve" }));
}

export function parseOAuthUpstreamSuccess(value: unknown): CredentialPatch | null {
  const raw = decodeRawOAuthUpstreamSuccess(value);
  if (Option.isNone(raw)) return null;
  const decoded = decodeOAuthUpstreamSuccessOption({
    id_token: optionalString(raw.value.id_token) ?? undefined,
    access_token: optionalString(raw.value.access_token) ?? undefined,
    refresh_token: optionalString(raw.value.refresh_token) ?? undefined,
  });
  if (Option.isNone(decoded)) return null;
  return Option.getOrNull(
    decodeCredentialPatchOption({
      accessToken: decoded.value.access_token,
      ...(decoded.value.id_token === undefined ? {} : { idToken: decoded.value.id_token }),
      ...(decoded.value.refresh_token === undefined
        ? {}
        : { refreshToken: decoded.value.refresh_token }),
    }),
  );
}

export function oauthContainerResult(credential: StoredCredential): OAuthContainerResult {
  const value = {
    id_token: syntheticIdToken(credential.codex.tokens?.account_id ?? credential.codex.account_id),
    access_token: credential.codexSentinel,
    refresh_token: credential.codexSentinel,
  };
  return Option.getOrThrowWith(decodeOAuthContainerResultOption(value), () =>
    boundaryFailure("OAuth container result is invalid"),
  );
}

export function sentinelAuthJson(credential: StoredCredential): string {
  const accountId = credential.codex.tokens?.account_id ?? credential.codex.account_id;
  return JSON.stringify({
    auth_mode: credential.codex.OPENAI_API_KEY ? "apikey" : "chatgpt",
    OPENAI_API_KEY: credential.codex.OPENAI_API_KEY ? credential.codexSentinel : null,
    tokens: credential.codex.tokens
      ? {
          id_token: syntheticIdToken(accountId),
          access_token: credential.codexSentinel,
          refresh_token: credential.codexSentinel,
          account_id: credential.codexSentinel,
        }
      : null,
    last_refresh: credential.codex.last_refresh ?? null,
  });
}

export function proxyOpenAIProgram(
  request: Request,
): Effect.Effect<Response, EgressFailure, EgressVault | EgressTransport> {
  return Effect.gen(function* () {
    const vault = yield* EgressVault;
    const sentinel = presentedCredential(request.headers);
    const credential = sentinel ? yield* vault.read(sentinel) : null;
    if (!credential || sentinel !== credential.codexSentinel) return forbidden();
    const headers = sanitizedHeaders(request.headers);
    const token = credential.codex.OPENAI_API_KEY ?? credential.codex.tokens?.access_token;
    if (!token) return forbidden();
    headers.set("authorization", `Bearer ${token}`);
    headers.delete("x-api-key");
    return yield* forward(request, new URL(request.url), headers);
  });
}

export const proxyChatGptProgram = Effect.fnUntraced(function* (request: Request) {
  const vault = yield* EgressVault;
  const sentinel = presentedCredential(request.headers);
  const credential = sentinel ? yield* vault.read(sentinel) : null;
  if (!credential?.codex.tokens?.access_token || sentinel !== credential.codexSentinel)
    return forbidden();
  const headers = sanitizedHeaders(request.headers);
  headers.set("authorization", `Bearer ${credential.codex.tokens.access_token}`);
  const accountId = credential.codex.tokens.account_id ?? credential.codex.account_id;
  if (accountId) headers.set("chatgpt-account-id", accountId);
  return yield* forward(request, new URL(request.url), headers);
});

export const proxyOAuthRefreshProgram = Effect.fnUntraced(function* (request: Request) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/oauth/token") return forbidden();
  const requestText = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => new EgressFailure({ reason: "transport", message: "OAuth request failed" }),
  });
  const requestJson = decodeJsonValue(requestText);
  const body = Option.isSome(requestJson) ? parseOAuthRefreshRequest(requestJson.value) : null;
  if (!body) return forbidden();
  const vault = yield* EgressVault;
  const refresh = yield* vault.begin(body.refresh_token);
  const credential = refresh?.credential;
  const realRefreshToken = credential?.codex.tokens?.refresh_token;
  if (!refresh || !credential || !realRefreshToken) {
    return Response.json(
      { error: { code: "oauth_refresh_busy", message: "OAuth refresh is already in progress" } },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const upstreamBody = JSON.stringify({ ...body, refresh_token: realRefreshToken });
  const headers = sanitizedHeaders(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const client = yield* HttpClient.HttpClient;
  const upstream = yield* client
    .execute(
      HttpClientRequest.post(`https://auth.openai.com${url.pathname}${url.search}`, {
        headers,
      }).pipe(HttpClientRequest.bodyText(upstreamBody, "application/json")),
    )
    .pipe(
      Effect.mapError(
        () => new EgressFailure({ reason: "transport", message: "OAuth refresh failed" }),
      ),
      Effect.onError(() =>
        vault
          .cancel(credential.codexSentinel, refresh.nonce)
          .pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
  if (upstream.status < 200 || upstream.status >= 300) {
    yield* vault.cancel(credential.codexSentinel, refresh.nonce);
    return Response.json(
      { error: { code: "oauth_refresh_failed", message: "OAuth refresh failed" } },
      { status: upstream.status, headers: { "cache-control": "no-store" } },
    );
  }

  const responseText = yield* upstream.text.pipe(
    Effect.mapError(
      () => new EgressFailure({ reason: "transport", message: "OAuth refresh failed" }),
    ),
    Effect.onError(() =>
      vault
        .cancel(credential.codexSentinel, refresh.nonce)
        .pipe(Effect.catchCause(() => Effect.void)),
    ),
  );
  const responseJson = decodeJsonValue(responseText);
  const patch = Option.isSome(responseJson) ? parseOAuthUpstreamSuccess(responseJson.value) : null;
  if (!patch) {
    yield* vault.cancel(credential.codexSentinel, refresh.nonce);
    return new Response("Invalid OAuth response", { status: 502 });
  }

  yield* vault.persist(credential.codexSentinel, patch, refresh.nonce).pipe(
    Effect.retry({ times: 2 }),
    Effect.mapError(
      () =>
        new EgressFailure({
          reason: "persistence",
          message: "Failed to persist rotated OAuth credential",
        }),
    ),
  );

  const safeBody = JSON.stringify(oauthContainerResult(credential));
  const responseHeaders = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  return new Response(safeBody, { status: upstream.status, headers: responseHeaders });
});

export const proxyGitHubProgram = Effect.fnUntraced(function* (request: Request) {
  const presented = presentedCredential(request.headers);
  if (!presented) return yield* passThroughProgram(request);
  const vault = yield* EgressVault;
  const credential = yield* vault.read(presented);
  if (!credential || presented !== credential.githubSentinel) return forbidden();

  const headers = sanitizedHeaders(request.headers);
  const original = request.headers.get("authorization") ?? "";
  if (original.startsWith("Basic ")) {
    headers.set("authorization", `Basic ${btoa(`x-access-token:${credential.githubToken}`)}`);
  } else {
    headers.set("authorization", `Bearer ${credential.githubToken}`);
  }
  return yield* forward(request, new URL(request.url), headers);
});

export const passThroughProgram = Effect.fnUntraced(function* (request: Request) {
  const headers = sanitizedHeaders(request.headers);
  if (headers.has("authorization") || headers.has("proxy-authorization") || headers.has("cookie"))
    return forbidden();
  return yield* forward(request, new URL(request.url), headers);
});

export function denyOutbound(): Response {
  return forbidden();
}

export function makeOutboundByHost(nativeFetch: typeof globalThis.fetch) {
  const run = <R extends EgressVault | EgressTransport | HttpClient.HttpClient>(
    program: Effect.Effect<Response, EgressFailure, R>,
    env: Bindings,
    context: EgressContext,
  ) => runEgress(program, env, context, nativeFetch);
  const openAI = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyOpenAIProgram(request), env, context);
  const chatGpt = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyChatGptProgram(request), env, context);
  const oauth = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyOAuthRefreshProgram(request), env, context);
  const gitHub = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyGitHubProgram(request), env, context);
  const passThrough = (request: Request, env: Bindings, context: EgressContext) =>
    run(passThroughProgram(request), env, context);
  return {
    "api.openai.com": openAI,
    "chatgpt.com": chatGpt,
    "auth.openai.com": oauth,
    "github.com": gitHub,
    "api.github.com": gitHub,
    "codeload.github.com": passThrough,
    "objects.githubusercontent.com": passThrough,
    "raw.githubusercontent.com": passThrough,
    "*.oaiusercontent.com": passThrough,
    "registry.npmjs.org": passThrough,
    "pypi.org": passThrough,
    "files.pythonhosted.org": passThrough,
    "crates.io": passThrough,
    "static.crates.io": passThrough,
    "index.crates.io": passThrough,
  };
}

function egressVaultLayer(env: Bindings, context: EgressContext): Layer.Layer<EgressVault> {
  const stub = credentialStub(env, context);
  const rpc = <A>(operation: () => Promise<A>): Effect.Effect<A, EgressFailure> =>
    Effect.tryPromise({
      try: operation,
      catch: () => new EgressFailure({ reason: "vault", message: "Credential vault failed" }),
    });
  return Layer.succeed(EgressVault)(
    EgressVault.of({
      read: (sentinel) => {
        if (
          !sentinel.startsWith(CODEX_SENTINEL_PREFIX) &&
          !sentinel.startsWith(GITHUB_SENTINEL_PREFIX)
        )
          return Effect.succeed(null);
        return rpc(() => stub.readCredentialForProxy(sentinel)).pipe(
          Effect.flatMap((value) => {
            if (value === null) return Effect.succeed(null);
            const decoded = decodeStoredCredentialOption(value);
            return Option.isSome(decoded)
              ? Effect.succeed(decoded.value)
              : Effect.fail(
                  new EgressFailure({ reason: "vault", message: "Credential vault failed" }),
                );
          }),
        );
      },
      begin: (sentinel) =>
        rpc(() => stub.beginCredentialRefresh(sentinel)).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeCredentialRefreshLeaseOption(value);
            return Option.isSome(decoded)
              ? Effect.succeed(decoded.value)
              : Effect.fail(
                  new EgressFailure({ reason: "vault", message: "Credential vault failed" }),
                );
          }),
        ),
      persist: (sentinel, patch, nonce) =>
        rpc(() => stub.persistRotatedCredential(sentinel, patch, nonce)),
      cancel: (sentinel, nonce) => rpc(() => stub.cancelCredentialRefresh(sentinel, nonce)),
    }),
  );
}

function credentialStub(
  env: Bindings,
  context: EgressContext,
): DurableObjectStub<import("./session").Sandbox> {
  const containerId = Option.getOrThrowWith(Option.fromNullishOr(context.containerId), () =>
    boundaryFailure("Missing sandbox container id"),
  );
  return env.SANDBOX.get(env.SANDBOX.idFromString(containerId));
}

function presentedCredential(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) return headers.get("x-api-key");
  if (authorization.startsWith("Basic ")) {
    return Result.match(
      Result.try(() => atob(authorization.slice(6))),
      {
        onFailure: () => null,
        onSuccess: (decoded) => {
          const separator = decoded.indexOf(":");
          return separator >= 0 ? decoded.slice(separator + 1) : null;
        },
      },
    );
  }
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function sanitizedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  return headers;
}

function forward(
  request: Request,
  url: URL,
  headers: Headers,
): Effect.Effect<Response, EgressFailure, EgressTransport> {
  return Effect.flatMap(EgressTransport, (transport) => transport.forward(request, url, headers));
}

function runEgress(
  program: Effect.Effect<
    Response,
    EgressFailure,
    EgressVault | EgressTransport | HttpClient.HttpClient
  >,
  env: Bindings,
  context: EgressContext,
  nativeFetch: typeof globalThis.fetch,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: official native Cloudflare outbound callback must return a Promise
  return Effect.runPromise(
    program.pipe(
      Effect.provide(egressVaultLayer(env, context)),
      Effect.provide(egressTransportLayer(nativeFetch)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, nativeFetch),
      Effect.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })),
    ),
  );
}

function boundaryFailure(message: string): EgressBoundaryFailure {
  return new EgressBoundaryFailure({ message });
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function syntheticIdToken(accountId?: string | null): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId ? "scotty-sentinel" : undefined,
        chatgpt_plan_type: "unknown",
      },
    }),
  );
  return `${header}.${payload}.scotty`;
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}
