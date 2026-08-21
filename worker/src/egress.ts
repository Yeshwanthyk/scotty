import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Context, Data, Effect, Layer, Option, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import type { Bindings } from "./bindings";
import { handleContainerSessionEgress, SCOTTY_INTERNAL_HOST } from "./container-session-egress";
import {
  ENVIRONMENT_SECRET_SENTINEL_PREFIX,
  EnvironmentProxyResponseSchema,
} from "./environment-secret-vault";
import { decodeJsonValue } from "./contracts";

export const ALLOWED_HOSTS = [
  "api.openai.com",
  "opencode.ai",
  "pi.dev",
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

export class EgressFailure extends Data.TaggedError("EgressFailure")<{
  readonly reason: "transport" | "vault" | "persistence";
  readonly message: string;
}> {}

type EgressContext = OutboundHandlerContext<unknown>;

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

type EgressRequirements = EnvironmentEgressVault | EgressTransport | HttpClient.HttpClient;

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
    const deny = (reason: string): Response => {
      // Diagnostic: silent egress denials are unobservable from the CLI; surface the branch.
      console.error(
        JSON.stringify({
          event: "egress.proxy.denied",
          reason,
          url: request.url.slice(0, 120),
          sentinels: scan.sentinels.length,
          potential: scan.potential,
          bounded: scan.bounded,
          malformed: scan.malformed,
          unreplaceable: scan.unreplaceable,
        }),
      );
      return forbidden();
    };
    if (
      !scan.potential ||
      !scan.bounded ||
      scan.malformed ||
      scan.unreplaceable ||
      scan.sentinels.length === 0 ||
      (scan.body?.potential === true && !scan.body.bounded)
    )
      return deny("scan_gate");
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
      return deny("non_https");
    const vault = yield* EnvironmentEgressVault;
    const values = yield* vault
      .resolve(url.origin, scan.sentinels)
      .pipe(Effect.catchTag("EgressFailure", () => Effect.succeed(null)));
    if (values === null) return deny("vault_unauthorized");

    const headers = sanitizedHeaders(request.headers);
    const headerReplacements = new Map<string, string>();
    for (const [name, value] of headers) {
      const basic = replaceBasicEnvironmentAuthorization(name, value, scan.sentinels, values);
      if (basic === null) return deny("basic_replace_failed");
      const replaced = basic ?? replaceEnvironmentSentinels(value, scan.sentinels, values, false);
      if (replaced === null) return deny("header_replace_failed");
      if (replaced !== value) headerReplacements.set(name, replaced);
    }
    for (const [name, value] of headerReplacements) headers.set(name, value);

    const pathname = replaceEnvironmentSentinels(url.pathname, scan.sentinels, values, true);
    const search = replaceEnvironmentSentinels(url.search, scan.sentinels, values, true);
    if (pathname === null || search === null) return deny("url_replace_failed");
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
  const passThroughGeneric = withGeneric(passThroughProgram);
  const containerSession = (request: Request, env: Bindings, context: EgressContext) =>
    handleContainerSessionEgress(request, env, context);
  return {
    "api.openai.com": passThroughGeneric,
    "opencode.ai": passThroughGeneric,
    "pi.dev": passThroughGeneric,
    "github.com": passThroughGeneric,
    "api.github.com": passThroughGeneric,
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

function credentialStub(
  env: Bindings,
  context: EgressContext,
): DurableObjectStub<import("./session").Sandbox> {
  const containerId = Option.getOrThrowWith(Option.fromNullishOr(context.containerId), () =>
    boundaryFailure("Missing sandbox container id"),
  );
  return env.SANDBOX.get(env.SANDBOX.idFromString(containerId));
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
      const basic = decodeBasicAuthorization(name, value);
      if (basic !== null)
        add(inspectEnvironmentText(basic, true, ENVIRONMENT_MAX_SCANNED_COMPONENT_LENGTH));
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

function decodeBasicAuthorization(name: string, value: string): string | null {
  if (name !== "authorization") return null;
  const match = /^Basic\s+(.+)$/iu.exec(value);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  const decoded = Result.try(() => atob(encoded));
  return Result.isSuccess(decoded) ? decoded.success : null;
}

function replaceBasicEnvironmentAuthorization(
  name: string,
  value: string,
  sentinels: ReadonlyArray<string>,
  replacements: Readonly<Record<string, string>>,
): string | null | undefined {
  if (name !== "authorization" || !/^Basic\s+/iu.test(value)) return undefined;
  const decoded = decodeBasicAuthorization(name, value);
  if (decoded === null) return null;
  const replaced = replaceEnvironmentSentinels(decoded, sentinels, replacements, false);
  if (replaced === null) return null;
  const encoded = Result.try(() => btoa(replaced));
  return Result.isSuccess(encoded) ? `Basic ${encoded.success}` : null;
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
    EnvironmentEgressVault | EgressTransport | HttpClient.HttpClient
  >,
  env: Bindings,
  context: EgressContext,
  nativeFetch: typeof globalThis.fetch,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: official native Cloudflare outbound callback must return a Promise
  return Effect.runPromise(
    program.pipe(
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

function mediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function forbidden(): Response {
  return new Response("Forbidden by Scotty egress policy", { status: 403 });
}
