import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Context, Data, Effect, Layer, Result, Schema } from "effect";
import type { Bindings } from "./bindings";
import { handleContainerSessionEgress, SCOTTY_INTERNAL_HOST } from "./container-session-egress";
import {
  EnvironmentCredentialBindingSchema,
  type EnvironmentCredentialBinding,
  type EnvironmentOriginResolveRequest,
} from "./environment-contracts";

/**
 * Hosts served as pure pass-through: no credential is ever injected and credential-bearing
 * requests are denied. Everything else resolves through the session's origin→credential map
 * (deny-by-default when unmapped).
 */
export const ALLOWED_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "*.oaiusercontent.com",
  "pi.dev",
  SCOTTY_INTERNAL_HOST,
] as const;

export class EgressFailure extends Data.TaggedError("EgressFailure")<{
  readonly reason: "transport" | "vault" | "persistence";
  readonly message: string;
}> {}

type EgressContext = OutboundHandlerContext<unknown>;

class CredentialResolver extends Context.Service<
  CredentialResolver,
  {
    readonly resolve: (
      origin: string,
    ) => Effect.Effect<EnvironmentCredential | null, EgressFailure>;
  }
>()("scotty/CredentialResolver") {}

interface EnvironmentCredential {
  readonly name: string;
  readonly scheme: "bearer" | "basic-x-access-token";
  readonly value: string;
}

const decodeCredential = Schema.decodeUnknownResult(EnvironmentCredentialBindingSchema, {
  onExcessProperty: "error",
});

function renderAuthorization(credential: EnvironmentCredential): string {
  if (credential.scheme === "basic-x-access-token")
    return `Basic ${btoa(`x-access-token:${credential.value}`)}`;
  return `Bearer ${credential.value}`;
}

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}

export function denyOutbound(): Response {
  return forbidden();
}

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
              ...(body === undefined ? {} : { body, duplex: "half" }),
              signal,
            };
            return nativeFetch(new URL(url.toString()), init);
          },
          catch: () => new EgressFailure({ reason: "transport", message: "Egress forward failed" }),
        }),
    }),
  );
}

type EgressRequirements = CredentialResolver | EgressTransport;

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

/** Deny helper that names its reason in structured logs. */
const deny = (reason: string, request: Request): Response => {
  console.error(JSON.stringify({ event: "egress.denied", reason, url: request.url.slice(0, 160) }));
  return forbidden();
};

const injectForOriginProgram = Effect.fnUntraced(function* (request: Request) {
  const parsed = Result.try(() => new URL(request.url));
  if (Result.isFailure(parsed)) return deny("invalid_url", request);
  const origin = parsed.success.origin;
  if (origin === "null") return deny("invalid_origin", request);
  const resolver = yield* CredentialResolver;
  const resolved = yield* resolver.resolve(origin).pipe(
    Effect.catchTag("EgressFailure", (failure) => {
      // Diagnostic: resolution failures were historically invisible; surface the cause.
      console.error(
        JSON.stringify({
          event: "egress.resolve.failed",
          reason: failure.reason,
          message: failure.message,
          origin,
        }),
      );
      return Effect.succeed(null);
    }),
  );
  if (resolved === null) return deny("unmapped_origin", request);
  const headers = sanitizedHeaders(request.headers);
  headers.set("authorization", renderAuthorization(resolved));
  return yield* forward(request, new URL(request.url), headers);
});

export const passThroughProgram = Effect.fnUntraced(function* (request: Request) {
  const headers = sanitizedHeaders(request.headers);
  if (headers.has("authorization") || headers.has("proxy-authorization") || headers.has("cookie"))
    return deny("passthrough_credential_header", request);
  return yield* forward(request, new URL(request.url), headers);
});

export function makeOutboundByHost(nativeFetch: typeof globalThis.fetch) {
  const run = (
    program: Effect.Effect<Response, EgressFailure, EgressRequirements>,
    env: Bindings,
    context: EgressContext,
  ): Promise<Response> => runEgress(program, env, context, nativeFetch);
  const passThroughGeneric = (request: Request, env: Bindings, context: EgressContext) =>
    run(passThroughProgram(request), env, context);
  const containerSession = (request: Request, env: Bindings, context: EgressContext) =>
    handleContainerSessionEgress(request, env, context);
  return {
    "registry.npmjs.org": passThroughGeneric,
    "pypi.org": passThroughGeneric,
    "files.pythonhosted.org": passThroughGeneric,
    "proxy.golang.org": passThroughGeneric,
    "sum.golang.org": passThroughGeneric,
    "crates.io": passThroughGeneric,
    "static.crates.io": passThroughGeneric,
    "index.crates.io": passThroughGeneric,
    "*.oaiusercontent.com": passThroughGeneric,
    "pi.dev": passThroughGeneric,
    [SCOTTY_INTERNAL_HOST]: containerSession,
  };
}

function credentialResolverLayer(
  env: Bindings,
  context: EgressContext,
): Layer.Layer<CredentialResolver> {
  return Layer.succeed(CredentialResolver)(
    CredentialResolver.of({
      resolve: (origin) =>
        Effect.suspend(() => {
          // Built lazily: only credential-bearing flows touch the session DO.
          const containerId = context.containerId;
          if (containerId === undefined || containerId === null || containerId === "")
            return Effect.fail(
              new EgressFailure({ reason: "vault", message: "Missing sandbox container id" }),
            );
          const stub = env.SANDBOX.get(env.SANDBOX.idFromString(String(containerId)));
          // lint-allow-double-cast: boundary: session DO RPC stubs are loosely typed across the worker seam and responses are schema-checked before use
          // lint-allow-double-cast: boundary: session DO RPC stubs are loosely typed across the worker seam and responses are schema-checked before use
          const resolve = stub.resolveCredentialForOrigin as unknown as (
            input: EnvironmentOriginResolveRequest,
          ) => Promise<EnvironmentCredentialBinding | null>;
          // Contract: resolves to the binding itself (null = unmapped); failures reject.
          return Effect.tryPromise({
            try: () => resolve({ origin }),
            catch: () =>
              new EgressFailure({ reason: "vault", message: "Credential resolution failed" }),
          });
        }).pipe(
          Effect.flatMap((resolved) => {
            if (resolved === null) {
              console.error(
                JSON.stringify({ event: "egress.denied", reason: "unmapped_origin", origin }),
              );
              return Effect.succeed(null);
            }
            const decoded = decodeCredential(resolved);
            if (!Result.isSuccess(decoded)) {
              console.error(
                JSON.stringify({
                  event: "egress.resolve.denied",
                  reason: "decode_failure",
                  origin,
                }),
              );
              return Effect.succeed(null);
            }
            return Effect.succeed(decoded.success);
          }),
        ),
    }),
  );
}

function runEgress(
  program: Effect.Effect<Response, EgressFailure, EgressRequirements>,
  env: Bindings,
  context: EgressContext,
  nativeFetch: typeof globalThis.fetch,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: official native Cloudflare outbound callback must return a Promise
  return Effect.runPromise(
    program.pipe(
      Effect.provide(credentialResolverLayer(env, context)),
      Effect.provide(egressTransportLayer(nativeFetch)),
    ),
  );
}

/** Default outbound for non-passthrough hosts: inject the mapped credential or deny. */
export function makeEnvironmentOutbound(nativeFetch: typeof globalThis.fetch) {
  return (request: Request, env: Bindings, context: EgressContext): Promise<Response> =>
    runEgress(injectForOriginProgram(request), env, context, nativeFetch);
}
