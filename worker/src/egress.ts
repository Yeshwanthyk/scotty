import type { OutboundHandlerContext } from "@cloudflare/containers";
import { supportedPiProvider, type PiCredential } from "../../protocol/pi-auth";
import { GITHUB_SENTINEL_PREFIX, PI_SENTINEL_PREFIX } from "../../protocol/pi-console-shared.mjs";
import { Context, Data, Effect, Layer, Option, Result } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Bindings } from "./bindings";
import { handleContainerSessionEgress, SCOTTY_INTERNAL_HOST } from "./container-session-egress";
import {
  decodeCredentialPatchOption,
  decodeCredentialRefreshLeaseOption,
  decodeJsonValue,
  decodeOAuthContainerResultOption,
  decodeOAuthRefreshRequestOption,
  decodeOAuthUpstreamSuccessOption,
  decodeRawOAuthUpstreamSuccess,
  decodeStoredCredentialOption,
  type CredentialPatch,
  type CredentialRefreshLease,
  type OAuthContainerResult,
  type OAuthRefreshRequest,
  type StoredCredential,
  type StoredProviderCredential,
} from "./contracts";

export { GITHUB_SENTINEL_PREFIX, PI_SENTINEL_PREFIX };

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
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  SCOTTY_INTERNAL_HOST,
] as const;

export type { CredentialPatch, CredentialRefreshLease, StoredCredential } from "./contracts";

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
    ...(optionalNumber(raw.value.expires_in) === null
      ? {}
      : { expires_in: optionalNumber(raw.value.expires_in) }),
  });
  if (Option.isNone(decoded)) return null;
  return Option.getOrNull(
    decodeCredentialPatchOption({
      accessToken: decoded.value.access_token,
      ...(decoded.value.id_token === undefined ? {} : { idToken: decoded.value.id_token }),
      ...(decoded.value.refresh_token === undefined
        ? {}
        : { refreshToken: decoded.value.refresh_token }),
      ...(decoded.value.expires_in === undefined
        ? {}
        : { expiresInSeconds: decoded.value.expires_in }),
    }),
  );
}

export function oauthContainerResult(
  provider: StoredProviderCredential,
  expiresIn?: number,
): OAuthContainerResult {
  if (provider.credential.type !== "oauth")
    return Option.getOrThrowWith(Option.none(), () =>
      boundaryFailure("OAuth container result is invalid"),
    );
  const value = {
    id_token: syntheticIdToken(optionalString(provider.credential.accountId)),
    access_token: piAccessSentinel(provider.sentinel),
    refresh_token: provider.sentinel,
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
  };
  return Option.getOrThrowWith(decodeOAuthContainerResultOption(value), () =>
    boundaryFailure("OAuth container result is invalid"),
  );
}

export function piAccessSentinel(sentinel: string): string {
  return `${sentinel}.${syntheticTokenPayload()}.scotty-pi`;
}

export function piAuthJson(credential: StoredCredential): string {
  const projected: Record<string, PiCredential> = {};
  for (const [providerId, provider] of Object.entries(credential.providers)) {
    if (!supportedPiProvider(providerId)) continue;
    projected[providerId] =
      provider.credential.type === "api_key"
        ? {
            type: "api_key",
            key: provider.sentinel,
          }
        : {
            type: "oauth",
            access: piAccessSentinel(provider.sentinel),
            refresh: provider.sentinel,
            expires: provider.credential.expires,
            ...(providerId === "openai-codex" ? { accountId: "scotty-sentinel" } : {}),
          };
  }
  return JSON.stringify(projected);
}

export function proxyOpenAIProgram(
  request: Request,
): Effect.Effect<Response, EgressFailure, EgressVault | EgressTransport> {
  return Effect.gen(function* () {
    const vault = yield* EgressVault;
    const sentinel = presentedCredential(request.headers);
    const credential = sentinel ? yield* vault.read(sentinel) : null;
    const provider = credential ? openAiProvider(credential, sentinel) : null;
    if (!provider) return forbidden();
    const token =
      provider.credential.type === "api_key" ? provider.credential.key : provider.credential.access;
    if (!token) return forbidden();
    const headers = sanitizedHeaders(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.delete("x-api-key");
    return yield* forward(request, new URL(request.url), headers);
  });
}

export const proxyChatGptProgram = Effect.fnUntraced(function* (request: Request) {
  const vault = yield* EgressVault;
  const sentinel = presentedCredential(request.headers);
  const credential = sentinel ? yield* vault.read(sentinel) : null;
  const provider = credential?.providers["openai-codex"];
  if (provider?.credential.type !== "oauth" || !matchesPiSentinel(sentinel, provider.sentinel))
    return forbidden();
  const headers = sanitizedHeaders(request.headers);
  headers.set("authorization", `Bearer ${provider.credential.access}`);
  const accountId = optionalString(provider.credential.accountId);
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
  const formEncoded =
    mediaType(request.headers.get("content-type")) === "application/x-www-form-urlencoded";
  const requestValue = formEncoded
    ? Object.fromEntries(new URLSearchParams(requestText))
    : Option.getOrUndefined(decodeJsonValue(requestText));
  const body = requestValue === undefined ? null : parseOAuthRefreshRequest(requestValue);
  if (!body) return forbidden();
  const vault = yield* EgressVault;
  const refresh = yield* vault.begin(body.refresh_token);
  const credential = refresh?.credential;
  const provider = credential?.providers["openai-codex"];
  const realRefreshToken =
    provider?.credential.type === "oauth" ? provider.credential.refresh : undefined;
  if (!refresh || !credential || !provider || !realRefreshToken) {
    return Response.json(
      { error: { code: "oauth_refresh_busy", message: "OAuth refresh is already in progress" } },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const upstreamBody = formEncoded
    ? formBody({ ...body, refresh_token: realRefreshToken })
    : JSON.stringify({ ...body, refresh_token: realRefreshToken });
  const headers = sanitizedHeaders(request.headers);
  const contentType = formEncoded ? "application/x-www-form-urlencoded" : "application/json";
  headers.set("content-type", contentType);
  headers.delete("content-length");
  const client = yield* HttpClient.HttpClient;
  const upstream = yield* client
    .execute(
      HttpClientRequest.post(`https://auth.openai.com${url.pathname}${url.search}`, {
        headers,
      }).pipe(HttpClientRequest.bodyText(upstreamBody, contentType)),
    )
    .pipe(
      Effect.mapError(
        () => new EgressFailure({ reason: "transport", message: "OAuth refresh failed" }),
      ),
      Effect.onError(() =>
        vault.cancel(provider.sentinel, refresh.nonce).pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
  if (upstream.status < 200 || upstream.status >= 300) {
    yield* vault.cancel(provider.sentinel, refresh.nonce);
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
      vault.cancel(provider.sentinel, refresh.nonce).pipe(Effect.catchCause(() => Effect.void)),
    ),
  );
  const responseJson = decodeJsonValue(responseText);
  const rawResponse = Option.isSome(responseJson)
    ? decodeRawOAuthUpstreamSuccess(responseJson.value)
    : Option.none();
  const patch = Option.isSome(responseJson) ? parseOAuthUpstreamSuccess(responseJson.value) : null;
  if (!patch) {
    yield* vault.cancel(provider.sentinel, refresh.nonce);
    return new Response("Invalid OAuth response", { status: 502 });
  }

  yield* vault.persist(provider.sentinel, patch, refresh.nonce).pipe(
    Effect.retry({ times: 2 }),
    Effect.mapError(
      () =>
        new EgressFailure({
          reason: "persistence",
          message: "Failed to persist rotated OAuth credential",
        }),
    ),
  );

  const expiresIn = Option.isSome(rawResponse)
    ? optionalNumber(rawResponse.value.expires_in)
    : null;
  const safeBody = JSON.stringify(
    oauthContainerResult(provider, formEncoded ? (expiresIn ?? 3600) : undefined),
  );
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
  const containerSession = (request: Request, env: Bindings, context: EgressContext) =>
    handleContainerSessionEgress(request, env, context);
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
    "proxy.golang.org": passThrough,
    "sum.golang.org": passThrough,
    "crates.io": passThrough,
    "static.crates.io": passThrough,
    "index.crates.io": passThrough,
    [SCOTTY_INTERNAL_HOST]: containerSession,
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
          !sentinel.startsWith(PI_SENTINEL_PREFIX) &&
          !sentinel.startsWith(GITHUB_SENTINEL_PREFIX)
        )
          return Effect.succeed(null);
        return rpc(() => stub.readCredentialForProxy(storedSentinel(sentinel))).pipe(
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
        rpc(() => stub.beginCredentialRefresh(storedSentinel(sentinel))).pipe(
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

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function formBody(value: OAuthRefreshRequest): string {
  const body = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") body.set(key, item);
  }
  return body.toString();
}

function storedSentinel(presented: string): string {
  const parts = presented.split(".");
  return parts.length === 3 && parts[2] === "scotty-pi" ? (parts[0] ?? presented) : presented;
}

function matchesPiSentinel(presented: string | null, stored: string): boolean {
  return presented === stored || presented === piAccessSentinel(stored);
}

function openAiProvider(
  credential: StoredCredential,
  presented: string | null,
): StoredProviderCredential | null {
  for (const providerId of ["openai", "openai-codex"] as const) {
    const provider = credential.providers[providerId];
    if (provider && matchesPiSentinel(presented, provider.sentinel)) return provider;
  }
  return null;
}

function syntheticIdToken(accountId?: string | null): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = syntheticTokenPayload(accountId);
  return `${header}.${payload}.scotty`;
}

function syntheticTokenPayload(accountId: string | null = "scotty-sentinel"): string {
  return base64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId ? "scotty-sentinel" : undefined,
        chatgpt_plan_type: "unknown",
      },
    }),
  );
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}
