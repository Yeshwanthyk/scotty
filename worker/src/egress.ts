import type { OutboundHandlerContext } from "@cloudflare/containers";
import { supportedPiProvider, type PiCredential } from "../../protocol/pi-auth";
import { GITHUB_SENTINEL_PREFIX, PI_SENTINEL_PREFIX } from "../../protocol/pi-console-shared.mjs";
import { Context, Data, Effect, Layer, Option, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Bindings } from "./bindings";
import { handleContainerSessionEgress, SCOTTY_INTERNAL_HOST } from "./container-session-egress";
import {
  ENVIRONMENT_SECRET_SENTINEL_PREFIX,
  EnvironmentProxyResponseSchema,
} from "./environment-secret-vault";
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

const ENVIRONMENT_MAX_SCANNED_COMPONENT_LENGTH = 16_384;
const ENVIRONMENT_MAX_SCANNED_HEADERS = 128;
export const ENVIRONMENT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_SENTINEL_PATTERN =
  /scotty-env-[a-z0-9][a-z0-9-]{5,31}-[a-f0-9]{32}(?![A-Za-z0-9_-])/gu;
const decodeEnvironmentProxyResponse = Schema.decodeUnknownOption(EnvironmentProxyResponseSchema, {
  onExcessProperty: "error",
});
type EnvironmentBodyKind = "text" | "json" | "form" | "opaque";
interface EnvironmentBodyScan {
  readonly kind: EnvironmentBodyKind;
  readonly text: string;
  readonly utf8: boolean;
  readonly bounded: boolean;
  readonly inspectable: boolean;
  readonly potential: boolean;
  readonly malformed: boolean;
  readonly unreplaceable: boolean;
  readonly sentinels: ReadonlyArray<string>;
}
interface EnvironmentSentinelTextScan {
  readonly bounded: boolean;
  readonly potential: boolean;
  readonly malformed: boolean;
  readonly unreplaceable: boolean;
  readonly sentinels: ReadonlyArray<string>;
}
type EnvironmentBodyRead = Pick<
  EnvironmentBodyScan,
  "kind" | "text" | "utf8" | "bounded" | "inspectable"
>;
interface EnvironmentSentinelScan {
  readonly bounded: boolean;
  readonly potential: boolean;
  readonly malformed: boolean;
  readonly unreplaceable: boolean;
  readonly sentinels: ReadonlyArray<string>;
  readonly body: EnvironmentBodyScan | null;
}

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
export interface EnvironmentEgressVaultShape {
  readonly resolve: (
    origin: string,
    sentinels: ReadonlyArray<string>,
  ) => Effect.Effect<Readonly<Record<string, string>> | null, EgressFailure>;
}

export class EnvironmentEgressVault extends Context.Service<
  EnvironmentEgressVault,
  EnvironmentEgressVaultShape
>()("scotty/EnvironmentEgressVault") {}

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

type EgressRequirements =
  | EgressVault
  | EnvironmentEgressVault
  | EgressTransport
  | HttpClient.HttpClient;

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
            const outgoing = new Request(url.toString(), init);
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

export function proxyEnvironmentProgram(
  request: Request,
): Effect.Effect<Response, EgressFailure, EnvironmentEgressVault | EgressTransport> {
  return proxyEnvironmentProgramWithScan(request);
}

function proxyEnvironmentProgramWithScan(
  request: Request,
  providedScan?: EnvironmentSentinelScan,
): Effect.Effect<Response, EgressFailure, EnvironmentEgressVault | EgressTransport> {
  return Effect.gen(function* () {
    const scan = providedScan ?? (yield* scanEnvironmentSentinels(request));
    if (
      !scan.potential ||
      !scan.bounded ||
      scan.malformed ||
      scan.unreplaceable ||
      scan.sentinels.length === 0 ||
      (scan.body?.potential === true && !scan.body.bounded)
    )
      return forbidden();
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return forbidden();
    const vault = yield* EnvironmentEgressVault;
    const values = yield* vault
      .resolve(url.origin, scan.sentinels)
      .pipe(Effect.catchTag("EgressFailure", () => Effect.succeed(null)));
    if (values === null) return forbidden();

    const headers = sanitizedHeaders(request.headers);
    const headerReplacements = new Map<string, string>();
    for (const [name, value] of headers) {
      const replaced = replaceEnvironmentSentinels(value, scan.sentinels, values, false);
      if (replaced === null) return forbidden();
      if (replaced !== value) headerReplacements.set(name, replaced);
    }
    for (const [name, value] of headerReplacements) headers.set(name, value);

    const pathname = replaceEnvironmentSentinels(url.pathname, scan.sentinels, values, true);
    const search = replaceEnvironmentSentinels(url.search, scan.sentinels, values, true);
    if (pathname === null || search === null) return forbidden();
    url.pathname = pathname;
    url.search = search;

    let forwardedRequest = request;
    if (scan.body?.potential === true) {
      const body = replaceEnvironmentBody(scan.body, scan.sentinels, values);
      if (body === null) return forbidden();
      const replacedRequest = withEnvironmentBody(request, body);
      if (replacedRequest === null) return forbidden();
      forwardedRequest = replacedRequest;
      headers.delete("content-length");
    }
    return yield* forward(forwardedRequest, url, headers);
  });
}

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
  const run = <R extends EgressRequirements>(
    program: Effect.Effect<Response, EgressFailure, R>,
    env: Bindings,
    context: EgressContext,
  ) => runEgress(program, env, context, nativeFetch);
  const withGeneric =
    <R extends EgressRequirements>(
      legacy: (request: Request) => Effect.Effect<Response, EgressFailure, R>,
    ) =>
    (request: Request, env: Bindings, context: EgressContext): Promise<Response> =>
      run(
        Effect.gen(function* () {
          const scan = yield* scanEnvironmentSentinels(request);
          if (scan.potential || !scan.bounded)
            return yield* proxyEnvironmentProgramWithScan(request, scan);
          return yield* legacy(request);
        }),
        env,
        context,
      );
  const openAIGeneric = withGeneric(proxyOpenAIProgram);
  const chatGptGeneric = withGeneric(proxyChatGptProgram);
  const oauthGeneric = withGeneric(proxyOAuthRefreshProgram);
  const gitHubGeneric = withGeneric(proxyGitHubProgram);
  const passThroughGeneric = withGeneric(passThroughProgram);
  const containerSession = (request: Request, env: Bindings, context: EgressContext) =>
    handleContainerSessionEgress(request, env, context);
  return {
    "api.openai.com": openAIGeneric,
    "chatgpt.com": chatGptGeneric,
    "auth.openai.com": oauthGeneric,
    "github.com": gitHubGeneric,
    "api.github.com": gitHubGeneric,
    "codeload.github.com": passThroughGeneric,
    "objects.githubusercontent.com": passThroughGeneric,
    "raw.githubusercontent.com": passThroughGeneric,
    "*.oaiusercontent.com": passThroughGeneric,
    "registry.npmjs.org": passThroughGeneric,
    "pypi.org": passThroughGeneric,
    "files.pythonhosted.org": passThroughGeneric,
    "proxy.golang.org": passThroughGeneric,
    "sum.golang.org": passThroughGeneric,
    "crates.io": passThroughGeneric,
    "static.crates.io": passThroughGeneric,
    "index.crates.io": passThroughGeneric,
    [SCOTTY_INTERNAL_HOST]: containerSession,
  };
}

export function makeEnvironmentOutbound(nativeFetch: typeof globalThis.fetch) {
  return (request: Request, env: Bindings, context: EgressContext): Promise<Response> =>
    runEgress(proxyEnvironmentProgram(request), env, context, nativeFetch);
}

function environmentEgressVaultLayer(
  env: Bindings,
  context: EgressContext,
): Layer.Layer<EnvironmentEgressVault> {
  const stub = credentialStub(env, context);
  return Layer.succeed(EnvironmentEgressVault)(
    EnvironmentEgressVault.of({
      resolve: (origin, sentinels) =>
        Effect.tryPromise({
          try: () => stub.authorizeEnvironmentRequest({ origin, sentinels }),
          catch: () => new EgressFailure({ reason: "vault", message: "Environment vault failed" }),
        }).pipe(
          Effect.flatMap((response) => {
            const decoded = decodeEnvironmentProxyResponse(response);
            if (Option.isNone(decoded))
              return Effect.fail(
                new EgressFailure({ reason: "vault", message: "Environment vault failed" }),
              );
            if (
              !decoded.value.authorized ||
              decoded.value.reason !== "approved" ||
              decoded.value.values === undefined
            )
              return Effect.succeed(null);
            return Effect.succeed(decoded.value.values);
          }),
          Effect.catchTag("EgressFailure", () => Effect.succeed(null)),
        ),
    }),
  );
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

function scanEnvironmentSentinels(request: Request): Effect.Effect<EnvironmentSentinelScan> {
  return Effect.gen(function* () {
    const sentinels = new Set<string>();
    let bounded = true;
    let potential = false;
    let malformed = false;
    let unreplaceable = false;
    const add = (part: EnvironmentSentinelTextScan): void => {
      bounded = bounded && part.bounded;
      potential = potential || part.potential;
      malformed = malformed || part.malformed;
      unreplaceable = unreplaceable || part.unreplaceable;
      for (const sentinel of part.sentinels) sentinels.add(sentinel);
    };
    const url = new URL(request.url);
    for (const [value, replaceable] of [
      [url.pathname, true],
      [url.search, true],
      [url.hostname, false],
      [url.username, false],
      [url.password, false],
    ] as const)
      add(inspectEnvironmentText(value, replaceable, ENVIRONMENT_MAX_SCANNED_COMPONENT_LENGTH));
    let headerCount = 0;
    for (const [name, value] of request.headers) {
      headerCount += 1;
      if (headerCount > ENVIRONMENT_MAX_SCANNED_HEADERS) {
        bounded = false;
        potential = true;
        break;
      }
      add(inspectEnvironmentText(name, false, ENVIRONMENT_MAX_SCANNED_COMPONENT_LENGTH));
      add(inspectEnvironmentText(value, true, ENVIRONMENT_MAX_SCANNED_COMPONENT_LENGTH));
    }
    let body: EnvironmentBodyScan | null = null;
    if (request.body !== null || contentLengthExceedsBodyLimit(request)) {
      const sample = yield* readEnvironmentBody(request, environmentBodyKind(request));
      const textScan = inspectEnvironmentText(sample.text, sample.kind !== "opaque");
      const bodyPotential = textScan.potential || !sample.inspectable || !sample.bounded;
      const malformedJson =
        bodyPotential && sample.kind === "json" && Option.isNone(decodeJsonValue(sample.text));
      body = {
        ...sample,
        potential: bodyPotential,
        malformed: textScan.malformed || malformedJson,
        unreplaceable:
          textScan.unreplaceable || (textScan.potential && !sample.utf8) || !sample.inspectable,
        sentinels: textScan.sentinels,
      };
      bounded = bounded && sample.bounded;
      potential = potential || bodyPotential;
      malformed = malformed || body.malformed;
      unreplaceable = unreplaceable || body.unreplaceable;
      for (const sentinel of body.sentinels) sentinels.add(sentinel);
    }
    return {
      bounded,
      potential,
      malformed,
      unreplaceable,
      sentinels: [...sentinels],
      body,
    };
  });
}

function inspectEnvironmentText(
  value: string,
  replaceable: boolean,
  maxLength = Number.POSITIVE_INFINITY,
): EnvironmentSentinelTextScan {
  if (value.length > maxLength)
    return {
      bounded: false,
      potential: true,
      malformed: false,
      unreplaceable: false,
      sentinels: [],
    };
  const sentinels = new Set<string>();
  const recognizedStarts = new Set<number>();
  let potential = false;
  let malformed = false;
  let unreplaceable = false;
  ENVIRONMENT_SENTINEL_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ENVIRONMENT_SENTINEL_PATTERN)) {
    const start = match.index;
    if (start === undefined) {
      malformed = true;
      continue;
    }
    potential = true;
    recognizedStarts.add(start);
    sentinels.add(match[0]);
  }
  let prefixStart = value.indexOf(ENVIRONMENT_SECRET_SENTINEL_PREFIX);
  while (prefixStart >= 0) {
    potential = true;
    if (!recognizedStarts.has(prefixStart)) malformed = true;
    if (!replaceable) unreplaceable = true;
    prefixStart = value.indexOf(
      ENVIRONMENT_SECRET_SENTINEL_PREFIX,
      prefixStart + ENVIRONMENT_SECRET_SENTINEL_PREFIX.length,
    );
  }
  return {
    bounded: true,
    potential,
    malformed,
    unreplaceable,
    sentinels: [...sentinels],
  };
}

function environmentBodyKind(request: Request): EnvironmentBodyKind {
  const type = mediaType(request.headers.get("content-type"));
  if (type === "application/x-www-form-urlencoded") return "form";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "" || type.startsWith("text/")) return "text";
  return "opaque";
}

function cancelEnvironmentReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().then(
    () => undefined,
    () => undefined,
  );
}

function contentLengthExceedsBodyLimit(request: Request): boolean {
  const value = request.headers.get("content-length");
  if (value === null) return false;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return true;
  const length = Number(normalized);
  return !Number.isSafeInteger(length) || length > ENVIRONMENT_MAX_BODY_BYTES;
}

function readEnvironmentBody(
  request: Request,
  kind: EnvironmentBodyKind,
): Effect.Effect<EnvironmentBodyRead> {
  return Effect.gen(function* () {
    if (contentLengthExceedsBodyLimit(request))
      return { kind, text: "", utf8: true, bounded: false, inspectable: false };
    const cloned = yield* Effect.result(
      Effect.try({
        try: () => request.clone(),
        catch: () =>
          new EgressFailure({ reason: "transport", message: "Request body unavailable" }),
      }),
    );
    if (Result.isFailure(cloned))
      return { kind, text: "", utf8: true, bounded: false, inspectable: false };
    if (cloned.success.body === null)
      return { kind, text: "", utf8: true, bounded: false, inspectable: false };
    const reader = cloned.success.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let length = 0;
    let bounded = true;
    let inspectable = true;
    while (bounded) {
      const next = yield* Effect.result(
        Effect.tryPromise({
          try: () => reader.read(),
          catch: () =>
            new EgressFailure({ reason: "transport", message: "Request body unavailable" }),
        }),
      );
      if (Result.isFailure(next)) {
        bounded = false;
        inspectable = false;
        cancelEnvironmentReader(reader);
        break;
      }
      if (next.success.done) break;
      const chunk = next.success.value;
      const remaining = ENVIRONMENT_MAX_BODY_BYTES - length;
      if (remaining > 0)
        chunks.push(chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining));
      length += chunk.byteLength;
      if (length > ENVIRONMENT_MAX_BODY_BYTES) {
        bounded = false;
        cancelEnvironmentReader(reader);
      }
    }
    const byteLength = Math.min(length, ENVIRONMENT_MAX_BODY_BYTES);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      const copyLength = Math.min(chunk.byteLength, byteLength - offset);
      if (copyLength <= 0) break;
      bytes.set(chunk.subarray(0, copyLength), offset);
      offset += copyLength;
    }
    const strict = Result.try(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return {
      kind,
      text: Result.isSuccess(strict)
        ? strict.success
        : new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes),
      utf8: Result.isSuccess(strict),
      bounded,
      inspectable,
    };
  });
}

function replaceEnvironmentSentinels(
  value: string,
  sentinels: ReadonlyArray<string>,
  replacements: Readonly<Record<string, string>>,
  urlComponent: boolean,
  allowLineBreaks = false,
): string | null {
  if (sentinels.some((sentinel) => replacements[sentinel] === undefined)) return null;
  let invalid = false;
  ENVIRONMENT_SENTINEL_PATTERN.lastIndex = 0;
  const replaced = value.replace(ENVIRONMENT_SENTINEL_PATTERN, (sentinel) => {
    const secret = replacements[sentinel];
    if (secret === undefined || (!urlComponent && !allowLineBreaks && /[\r\n]/u.test(secret))) {
      invalid = true;
      return sentinel;
    }
    if (!urlComponent) return secret;
    const encoded = Result.try(() => encodeURIComponent(secret));
    if (Result.isFailure(encoded)) {
      invalid = true;
      return sentinel;
    }
    return encoded.success;
  });
  return invalid ? null : replaced;
}

function replaceEnvironmentBody(
  body: EnvironmentBodyScan,
  sentinels: ReadonlyArray<string>,
  replacements: Readonly<Record<string, string>>,
): string | null {
  if (!body.utf8 || body.kind === "opaque") return null;
  if (body.kind === "json")
    return replaceJsonEnvironmentSentinels(body.text, sentinels, replacements);
  return replaceEnvironmentSentinels(
    body.text,
    sentinels,
    replacements,
    body.kind === "form",
    body.kind === "text",
  );
}

function replaceJsonEnvironmentSentinels(
  value: string,
  sentinels: ReadonlyArray<string>,
  replacements: Readonly<Record<string, string>>,
): string | null {
  if (Option.isNone(decodeJsonValue(value))) return null;
  const matches = new Map<number, string>();
  ENVIRONMENT_SENTINEL_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ENVIRONMENT_SENTINEL_PATTERN)) {
    if (match.index !== undefined) matches.set(match.index, match[0]);
  }
  let inString = false;
  let escaped = false;
  let output = "";
  let index = 0;
  while (index < value.length) {
    const sentinel = matches.get(index);
    if (sentinel !== undefined) {
      if (!inString || escaped) return null;
      const secret = replacements[sentinel];
      if (secret === undefined) return null;
      const encoded = Result.try(() => JSON.stringify(secret));
      if (Result.isFailure(encoded) || encoded.success === undefined) return null;
      output += encoded.success.slice(1, -1);
      index += sentinel.length;
      continue;
    }
    const character = value[index];
    if (character === undefined) return null;
    output += character;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    }
    index += 1;
  }
  return sentinels.some((sentinel) => replacements[sentinel] === undefined) ? null : output;
}

function withEnvironmentBody(request: Request, body: string): Request | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const replaced = Result.try(() => new Request(request, { method: request.method, body }));
  return Result.isFailure(replaced) ? null : replaced.success;
}

function sanitizedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of Array.from(headers.keys())) {
    if (
      name === "host" ||
      name === "cookie" ||
      name === "proxy-authorization" ||
      name === "forwarded" ||
      name === "via" ||
      name === "true-client-ip" ||
      name === "x-real-ip" ||
      name.startsWith("cf-") ||
      name.startsWith("scotty-") ||
      name.startsWith("x-container-") ||
      name.startsWith("x-scotty-") ||
      name.startsWith("x-sandbox-") ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-envoy-")
    )
      headers.delete(name);
  }
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
    EgressVault | EnvironmentEgressVault | EgressTransport | HttpClient.HttpClient
  >,
  env: Bindings,
  context: EgressContext,
  nativeFetch: typeof globalThis.fetch,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: official native Cloudflare outbound callback must return a Promise
  return Effect.runPromise(
    program.pipe(
      Effect.provide(egressVaultLayer(env, context)),
      Effect.provide(environmentEgressVaultLayer(env, context)),
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
