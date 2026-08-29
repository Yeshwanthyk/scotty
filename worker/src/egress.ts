import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Context, Data, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  formatManagedHandle,
  parseManagedHandle,
  type ManagedHandle,
} from "../../protocol/credentials";
import type { Bindings } from "./bindings";
import { handleContainerSessionEgress, SCOTTY_INTERNAL_HOST } from "./container-session-egress";
import {
  decodeJsonValue,
  decodeOAuthContainerResultOption,
  decodeOAuthRefreshRequestOption,
  decodeOAuthUpstreamSuccessOption,
  decodeRawOAuthUpstreamSuccess,
  type OAuthContainerResult,
  type OAuthRefreshRequest,
} from "./contracts";
import {
  CredentialRegistryRotationPatchSchema,
  type CredentialRegistryRotationPatch,
} from "./credential-contracts";
import {
  decodeCredentialRefreshLeaseOption,
  githubRepositoryFromUrl,
  managedPiAccessToken,
  managedPiIdToken,
  parseManagedPiAccessToken,
  type ManagedCredentialRefreshLease,
} from "./managed-credentials";
import { parsePiAuthJsonOption } from "../../protocol/pi-auth";

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

type EgressContext = OutboundHandlerContext<unknown>;

export class EgressFailure extends Data.TaggedError("EgressFailure")<{
  readonly reason: "transport" | "credential" | "persistence";
  readonly message: string;
}> {}

class EgressBoundaryFailure extends Data.TaggedError("EgressBoundaryFailure")<{
  readonly message: string;
}> {}
const decodeCredentialRegistryRotationPatchOption = Schema.decodeUnknownOption(
  CredentialRegistryRotationPatchSchema,
);

export interface EgressCredentialShape {
  readonly resolve: (
    handle: string,
    repository?: string,
  ) => Effect.Effect<Redacted.Redacted<string> | null, EgressFailure>;
  readonly begin: (
    handle: string,
  ) => Effect.Effect<ManagedCredentialRefreshLease | null, EgressFailure>;
  readonly persist: (
    handle: string,
    patch: CredentialRegistryRotationPatch,
    nonce: string,
  ) => Effect.Effect<void, EgressFailure>;
  readonly cancel: (handle: string, nonce: string) => Effect.Effect<void, EgressFailure>;
}

export class EgressCredential extends Context.Service<EgressCredential, EgressCredentialShape>()(
  "scotty/EgressCredential",
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

export function oauthContainerResult(
  accessHandle: string,
  refreshHandle: string,
  expiresIn?: number,
): OAuthContainerResult {
  const access = parseManagedHandle(accessHandle);
  const refresh = parseManagedHandle(refreshHandle);
  if (
    Option.isNone(access) ||
    Option.isNone(refresh) ||
    access.value.provider !== "openai-codex" ||
    access.value.slot !== "access" ||
    refresh.value.provider !== "openai-codex" ||
    refresh.value.slot !== "refresh"
  )
    return Option.getOrThrowWith(Option.none(), () => boundaryFailure("OAuth handles are invalid"));
  const value = {
    id_token: managedPiIdToken(accessHandle),
    access_token: managedPiAccessToken(accessHandle),
    refresh_token: refreshHandle,
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
  };
  return Option.getOrThrowWith(decodeOAuthContainerResultOption(value), () =>
    boundaryFailure("OAuth container result is invalid"),
  );
}

export function parseOAuthRefreshRequest(value: unknown): OAuthRefreshRequest | null {
  return Option.getOrNull(decodeOAuthRefreshRequestOption(value, { onExcessProperty: "preserve" }));
}

export function parseOAuthUpstreamSuccess(value: unknown): CredentialRegistryRotationPatch | null {
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
  const patch = {
    accessToken: decoded.value.access_token,
    ...(decoded.value.id_token === undefined ? {} : { idToken: decoded.value.id_token }),
    ...(decoded.value.refresh_token === undefined
      ? {}
      : { refreshToken: decoded.value.refresh_token }),
    ...(decoded.value.expires_in === undefined
      ? {}
      : { expiresInSeconds: decoded.value.expires_in }),
  };
  return Option.getOrNull(patchFromUpstream(patch));
}

export const proxyOpenAIProgram = Effect.fnUntraced(function* (request: Request) {
  const url = exactDestination(request, "api.openai.com");
  if (url === undefined) return forbidden();
  const handle = openAiHandle(request.headers);
  if (handle === undefined) return forbidden();
  const credential = yield* EgressCredential;
  const resolved = yield* credential.resolve(formatManagedHandle(handle));
  if (resolved === null) return forbidden();
  const selected = selectPiCredential(resolved, handle);
  if (selected === null) return forbidden();
  const headers = sanitizedHeaders(request.headers);
  headers.set("authorization", `Bearer ${selected.token}`);
  return yield* forward(request, url, headers);
});

export const proxyChatGptProgram = Effect.fnUntraced(function* (request: Request) {
  const url = exactDestination(request, "chatgpt.com");
  if (url === undefined) return forbidden();
  const authorization = request.headers.get("authorization");
  const handle = parseManagedPiAccessToken(
    authorization === null ? undefined : bearerValue(authorization),
  );
  if (Option.isNone(handle)) return forbidden();
  const credential = yield* EgressCredential;
  const resolved = yield* credential.resolve(formatManagedHandle(handle.value));
  if (resolved === null) return forbidden();
  const selected = selectPiCredential(resolved, handle.value);
  if (selected === null || selected.accountId === undefined) return forbidden();
  const headers = sanitizedHeaders(request.headers);
  headers.set("authorization", `Bearer ${selected.token}`);
  headers.set("chatgpt-account-id", selected.accountId);
  return yield* forward(request, url, headers);
});

const decodeOAuthRefreshIntent = Effect.fnUntraced(function* (request: Request) {
  const url = exactDestination(request, "auth.openai.com");
  if (url === undefined || request.method !== "POST" || url.pathname !== "/oauth/token")
    return null;
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
  return body === null ? null : { body, formEncoded, url };
});

export const proxyOAuthRefreshProgram = Effect.fnUntraced(function* (request: Request) {
  const intent = yield* decodeOAuthRefreshIntent(request);
  if (intent === null) return forbidden();
  const { body, formEncoded, url } = intent;
  const refreshHandle = parseManagedHandle(body.refresh_token);
  if (
    Option.isNone(refreshHandle) ||
    refreshHandle.value.provider !== "openai-codex" ||
    refreshHandle.value.slot !== "refresh"
  )
    return forbidden();

  const credential = yield* EgressCredential;
  const handle = formatManagedHandle(refreshHandle.value);
  const lease = yield* credential.begin(handle);
  if (lease === null)
    return Response.json(
      { error: { code: "oauth_refresh_busy", message: "OAuth refresh is already in progress" } },
      { status: 409, headers: { "cache-control": "no-store" } },
    );

  const cancel = (): Effect.Effect<void, never> =>
    credential.cancel(handle, lease.nonce).pipe(Effect.catchCause(() => Effect.void));
  const resolved = yield* credential.resolve(handle).pipe(Effect.tapError(cancel));
  if (resolved === null) {
    yield* cancel();
    return Response.json(
      { error: { code: "oauth_refresh_failed", message: "OAuth refresh failed" } },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
  const selected = selectPiRefreshCredential(resolved);
  if (selected === null) {
    yield* cancel();
    return Response.json(
      { error: { code: "oauth_refresh_failed", message: "OAuth refresh failed" } },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  const upstreamBody = formEncoded
    ? formBody({ ...body, refresh_token: selected.refresh })
    : JSON.stringify({ ...body, refresh_token: selected.refresh });
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
      Effect.tapError(cancel),
    );
  if (upstream.status < 200 || upstream.status >= 300) {
    yield* cancel();
    return Response.json(
      { error: { code: "oauth_refresh_failed", message: "OAuth refresh failed" } },
      { status: upstream.status, headers: { "cache-control": "no-store" } },
    );
  }

  // A 2xx response may have rotated upstream even if its body cannot be read or decoded.
  const responseText = yield* upstream.text.pipe(
    Effect.mapError(
      () => new EgressFailure({ reason: "transport", message: "OAuth refresh failed" }),
    ),
  );
  const responseJson = decodeJsonValue(responseText);
  const rawResponse = Option.isSome(responseJson)
    ? decodeRawOAuthUpstreamSuccess(responseJson.value)
    : Option.none();
  const patch = Option.isSome(responseJson) ? parseOAuthUpstreamSuccess(responseJson.value) : null;
  if (patch === null) {
    return new Response("Invalid OAuth response", { status: 502 });
  }

  // A successful provider response makes the old refresh token unsafe to reuse. Keep the
  // lease on persistence failure so the durable completion can be retried without cancellation.
  yield* credential.persist(handle, patch, lease.nonce).pipe(
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
  const access = piAccessHandleFromRefresh(refreshHandle.value);
  const safeBody = JSON.stringify(
    oauthContainerResult(access, handle, formEncoded ? (expiresIn ?? 3600) : undefined),
  );
  const responseHeaders = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  return new Response(safeBody, { status: upstream.status, headers: responseHeaders });
});

export const proxyGitHubProgram = Effect.fnUntraced(function* (request: Request) {
  const url = githubDestination(request);
  if (url === undefined) return forbidden();
  const handle = githubHandle(request.headers);
  if (handle === undefined) return yield* passThroughProgram(request);
  const repository = githubRepositoryFromUrl(url);
  if (repository === undefined) return forbidden();
  const credential = yield* EgressCredential;
  const resolved = yield* credential.resolve(handle, repository);
  if (resolved === null) return forbidden();
  const token = Redacted.value(resolved);
  Redacted.wipeUnsafe(resolved);
  if (token.length === 0) return forbidden();
  const headers = sanitizedHeaders(request.headers);
  const original = request.headers.get("authorization") ?? "";
  headers.set(
    "authorization",
    original.startsWith("Basic ") ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`,
  );
  return yield* forward(request, url, headers);
});

export const passThroughProgram = Effect.fnUntraced(function* (request: Request) {
  if (
    ["authorization", "x-api-key", "x-github-token", "proxy-authorization", "cookie"].some((name) =>
      request.headers.has(name),
    )
  )
    return forbidden();
  const headers = sanitizedHeaders(request.headers);
  return yield* forward(request, new URL(request.url), headers);
});

export function denyOutbound(): Response {
  return forbidden();
}

export function makeOutboundByHost(nativeFetch: typeof globalThis.fetch) {
  const run = <R extends EgressCredential | EgressTransport | HttpClient.HttpClient>(
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

function egressCredentialLayer(
  env: Bindings,
  context: EgressContext,
): Layer.Layer<EgressCredential> {
  const stub = credentialStub(env, context);
  const rpc = <A>(operation: () => Promise<A>): Effect.Effect<A, EgressFailure> =>
    stub === undefined
      ? Effect.fail(
          new EgressFailure({ reason: "credential", message: "Credential registry unavailable" }),
        )
      : Effect.tryPromise({
          try: operation,
          catch: () =>
            new EgressFailure({
              reason: "credential",
              message: "Session credential access failed",
            }),
        });
  const denied = (): Effect.Effect<never, EgressFailure> =>
    Effect.fail(
      new EgressFailure({ reason: "credential", message: "Session credential access failed" }),
    );
  return Layer.succeed(EgressCredential)(
    EgressCredential.of({
      resolve: (handle, repository) =>
        rpc(() =>
          stub!.resolveCredentialForProxy({
            version: 1,
            handle,
            ...(repository === undefined ? {} : { repository }),
          }),
        ).pipe(
          Effect.flatMap((value) => {
            if (value === null) return Effect.succeed(null);
            return typeof value === "string" ? Effect.succeed(Redacted.make(value)) : denied();
          }),
        ),
      begin: (handle) =>
        rpc(() =>
          stub!.beginCredentialRefreshForProxy({ version: 1, handle, nonce: crypto.randomUUID() }),
        ).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeCredentialRefreshLeaseOption(value);
            return Option.isSome(decoded)
              ? Effect.succeed(decoded.value)
              : value === null
                ? Effect.succeed(null)
                : denied();
          }),
        ),
      persist: (handle, patch, nonce) =>
        rpc(() => stub!.persistCredentialRotationForProxy({ version: 1, handle, nonce, patch })),
      cancel: (handle, nonce) =>
        rpc(() => stub!.cancelCredentialRefreshForProxy({ version: 1, handle, nonce })),
    }),
  );
}

function credentialStub(
  env: Bindings,
  context: EgressContext,
): DurableObjectStub<import("./session").Sandbox> | undefined {
  const containerId = context.containerId;
  if (
    context.className !== "Sandbox" ||
    typeof containerId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(containerId)
  )
    return undefined;
  const id = Result.try(() => env.SANDBOX.idFromString(containerId));
  return Result.isFailure(id) ? undefined : env.SANDBOX.get(id.success);
}

function exactDestination(request: Request, host: string): URL | undefined {
  const url = new URL(request.url);
  return url.protocol === "https:" && url.hostname === host && url.port === "" ? url : undefined;
}

function githubDestination(request: Request): URL | undefined {
  const url = new URL(request.url);
  return url.protocol === "https:" &&
    (url.hostname === "github.com" || url.hostname === "api.github.com") &&
    url.port === ""
    ? url
    : undefined;
}

function openAiHandle(headers: Headers): ManagedHandle | undefined {
  const apiKey = headers.get("x-api-key");
  const bearer = bearerValue(headers.get("authorization"));
  const candidates = [apiKey, bearer];
  for (const candidate of candidates) {
    const handle = parseManagedHandle(candidate);
    if (
      Option.isSome(handle) &&
      handle.value.provider === "openai" &&
      handle.value.slot === "api-key"
    )
      return handle.value;
  }
  return undefined;
}

function githubHandle(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  if (authorization === null) return undefined;
  if (authorization.startsWith("Basic ")) {
    const decoded = Result.try(() => atob(authorization.slice(6)));
    if (Result.isFailure(decoded)) return undefined;
    const separator = decoded.success.indexOf(":");
    const password = separator < 0 ? undefined : decoded.success.slice(separator + 1);
    return managedGitHubHandle(password);
  }
  return managedGitHubHandle(bearerValue(authorization));
}

function managedGitHubHandle(value: string | undefined): string | undefined {
  const handle = parseManagedHandle(value);
  return Option.isSome(handle) &&
    handle.value.provider === "github" &&
    handle.value.slot === "git-https"
    ? value
    : undefined;
}

function bearerValue(authorization: string | null): string | undefined {
  if (authorization === null) return undefined;
  const match = /^(?:Bearer|token)\s+(.+)$/iu.exec(authorization);
  return match?.[1];
}

function selectPiCredential(
  resolved: Redacted.Redacted<string>,
  handle: ManagedHandle,
): { readonly token: string; readonly accountId?: string } | null {
  const parsed = parsePiAuthJsonOption(Redacted.value(resolved));
  const provider = Option.isSome(parsed) ? parsed.value[handle.provider] : undefined;
  if (provider === undefined) {
    Redacted.wipeUnsafe(resolved);
    return null;
  }
  const selected =
    handle.provider === "openai" && handle.slot === "api-key" && provider.type === "api_key"
      ? provider.key === undefined
        ? null
        : { token: provider.key }
      : handle.provider === "openai-codex" && handle.slot === "access" && provider.type === "oauth"
        ? {
            token: provider.access,
            ...(provider.accountId === undefined ? {} : { accountId: provider.accountId }),
          }
        : null;
  Redacted.wipeUnsafe(resolved);
  return selected?.token === undefined ? null : selected;
}

function selectPiRefreshCredential(
  resolved: Redacted.Redacted<string>,
): { readonly refresh: string } | null {
  const parsed = parsePiAuthJsonOption(Redacted.value(resolved));
  const provider = Option.isSome(parsed) ? parsed.value["openai-codex"] : undefined;
  const selected = provider?.type === "oauth" ? { refresh: provider.refresh } : null;
  Redacted.wipeUnsafe(resolved);
  return selected;
}

function piAccessHandleFromRefresh(refresh: {
  readonly name: string;
  readonly provider: string;
  readonly slot: string;
}): string {
  return formatManagedHandle({ name: refresh.name, provider: "openai-codex", slot: "access" });
}

function patchFromUpstream(value: unknown): Option.Option<CredentialRegistryRotationPatch> {
  const decoded = decodeCredentialRegistryRotationPatchOption(value);
  return decoded;
}

function sanitizedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of [
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
  ])
    headers.delete(name);
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
    EgressCredential | EgressTransport | HttpClient.HttpClient
  >,
  env: Bindings,
  context: EgressContext,
  nativeFetch: typeof globalThis.fetch,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: official native Cloudflare outbound callback must return a Promise
  return Effect.runPromise(
    program.pipe(
      Effect.provide(egressCredentialLayer(env, context)),
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

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}

export type { CredentialRegistryRotationPatch } from "./credential-contracts";
export type {
  SessionCredentialAccess,
  SessionCredentialRefresh,
  SessionCredentialRotation,
} from "./managed-credentials";
