import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Context, Data, Effect, Layer, Option, Redacted, Result } from "effect";
import {
  formatManagedHandle,
  parseManagedHandle,
  type ManagedHandle,
} from "../../protocol/credentials";
import type { Bindings } from "./bindings";
import { handleContainerSessionEgress, SCOTTY_INTERNAL_HOST } from "./container-session-egress";
import { githubRepositoryFromUrl, parseManagedPiAccessToken } from "./managed-credentials";
import { parsePiAuthJsonOption } from "../../protocol/pi-auth";

export const ALLOWED_HOSTS = [
  "api.openai.com",
  "chatgpt.com",
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
  readonly reason: "transport" | "credential";
  readonly message: string;
}> {}

export interface EgressCredentialShape {
  readonly resolve: (
    handle: string,
    repository?: string,
  ) => Effect.Effect<Redacted.Redacted<string> | null, EgressFailure>;
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
  const run = <R extends EgressCredential | EgressTransport>(
    program: Effect.Effect<Response, EgressFailure, R>,
    env: Bindings,
    context: EgressContext,
  ) => runEgress(program, env, context, nativeFetch);
  const openAI = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyOpenAIProgram(request), env, context);
  const chatGpt = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyChatGptProgram(request), env, context);
  const gitHub = (request: Request, env: Bindings, context: EgressContext) =>
    run(proxyGitHubProgram(request), env, context);
  const passThrough = (request: Request, env: Bindings, context: EgressContext) =>
    run(passThroughProgram(request), env, context);
  const containerSession = (request: Request, env: Bindings, context: EgressContext) =>
    handleContainerSessionEgress(request, env, context);
  return {
    "api.openai.com": openAI,
    "chatgpt.com": chatGpt,
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
  program: Effect.Effect<Response, EgressFailure, EgressCredential | EgressTransport>,
  env: Bindings,
  context: EgressContext,
  nativeFetch: typeof globalThis.fetch,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: official native Cloudflare outbound callback must return a Promise
  return Effect.runPromise(
    program.pipe(
      Effect.provide(egressCredentialLayer(env, context)),
      Effect.provide(egressTransportLayer(nativeFetch)),
    ),
  );
}

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}

export type { SessionCredentialAccess } from "./managed-credentials";
