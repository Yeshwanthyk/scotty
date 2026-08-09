// Native Worker host adapter for the isolated Hatch policy. Evidence preview admission remains in
// evidence-preview.ts and never shares Hatch cookies, permits, accounting, or handoff behavior.
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import type { Bindings } from "./bindings";
import { authRegistry } from "./auth";
import { readBoundedUtf8Body } from "./bounded-http";
import { sha256Hex } from "./digest";
import {
  HATCH_COOKIE,
  HATCH_HANDOFF_PATH,
  HATCH_MAX_INGRESS_BYTES,
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER,
  HATCH_PRIVATE_WEBSOCKET_HEADER,
  HATCH_RESERVED_PORTS,
  type HatchHostRouteV1,
  type HatchRequestAdmissionV1,
  type HatchWebSocketAdmissionV1,
} from "./hatch-contracts";

export type HatchGatewayBindings = Pick<Bindings, "AUTH" | "SANDBOX" | "SCOTTY_PREVIEW_BASE">;

export const HATCH_MAX_URL_BYTES = 8 * 1_024;
export const HATCH_MAX_HEADER_BYTES = 32 * 1_024;
export const HATCH_MAX_HEADER_COUNT = 128;
const HATCH_HANDOFF_MAX_BYTES = 8 * 1_024;
const CONTROL_COOKIE = "__Host-scotty";
const EVIDENCE_COOKIE = "__Host-scotty-preview";
const BASE_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export const hatchPreviewFormAction = (previewBase: string | undefined): string =>
  previewBase !== undefined && BASE_PATTERN.test(previewBase)
    ? `https://*.${previewBase}`
    : "'none'";
const HATCH_LABEL_PATTERN =
  /^([1-9][0-9]{3,4})-([0-9a-f]{12})-((?:h[a-z0-9]{14})|(?:h_[a-z0-9_]{14}))$/u;
const COOKIE_SECRET_PATTERN = /^[0-9a-f]{64}$/u;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const WEBSOCKET_KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/u;
const WEBSOCKET_PROTOCOL_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u;
const HATCH_MAX_WEBSOCKET_PROTOCOLS = 16;
const RESERVED_COOKIE_NAMES = new Set([
  CONTROL_COOKIE.toLowerCase(),
  EVIDENCE_COOKIE.toLowerCase(),
  HATCH_COOKIE.toLowerCase(),
]);
const RESPONSE_STRIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-original-url",
]);
const encoder = new TextEncoder();

export type HatchHostRoute = HatchHostRouteV1;

export type HatchHostParse =
  | { readonly kind: "not_hatch" }
  | { readonly kind: "invalid_hatch" }
  | { readonly kind: "hatch"; readonly route: HatchHostRoute };

export const parseHatchHost = (host: string, previewBase: string): HatchHostParse => {
  if (!BASE_PATTERN.test(previewBase)) return { kind: "invalid_hatch" };
  if (host !== host.toLowerCase() || host.endsWith(".") || host.includes(":")) {
    return host.toLowerCase() === previewBase || host.toLowerCase().endsWith(`.${previewBase}`)
      ? { kind: "invalid_hatch" }
      : { kind: "not_hatch" };
  }
  if (host !== previewBase && !host.endsWith(`.${previewBase}`)) return { kind: "not_hatch" };
  if (host === previewBase) return { kind: "invalid_hatch" };
  const label = host.slice(0, -(previewBase.length + 1));
  if (label.includes(".")) return { kind: "invalid_hatch" };
  const match = HATCH_LABEL_PATTERN.exec(label);
  if (match === null) {
    return label.includes("-h_") || label.includes("-h-") || label.includes("-h")
      ? { kind: "invalid_hatch" }
      : { kind: "not_hatch" };
  }
  const port = Number(match[1]);
  const sessionId = match[2];
  const routeNonce = match[3];
  if (
    !Number.isInteger(port) ||
    port < 1_024 ||
    port > 65_535 ||
    HATCH_RESERVED_PORTS.has(port) ||
    sessionId === undefined ||
    routeNonce === undefined
  )
    return { kind: "invalid_hatch" };
  return { kind: "hatch", route: { port, sessionId, routeNonce } };
};

interface ParsedHatchCookie {
  readonly secret: string;
  readonly forwardedCookie: string | undefined;
}

const parseHatchCookie = (header: string | null): ParsedHatchCookie | undefined => {
  if (header === null) return undefined;
  const forwarded: string[] = [];
  const secrets: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) return undefined;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    const normalized = name.toLowerCase();
    if (normalized === HATCH_COOKIE.toLowerCase()) secrets.push(value);
    else if (!RESERVED_COOKIE_NAMES.has(normalized)) forwarded.push(`${name}=${value}`);
  }
  if (secrets.length !== 1 || !COOKIE_SECRET_PATTERN.test(secrets[0] ?? "")) return undefined;
  return {
    secret: secrets[0] ?? "",
    forwardedCookie: forwarded.length === 0 ? undefined : forwarded.join("; "),
  };
};

const isUntrustedControlHeader = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cdn-loop" ||
    normalized === "forwarded" ||
    normalized === "true-client-ip" ||
    normalized === "via" ||
    normalized === "x-real-ip" ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("x-forwarded-") ||
    normalized.startsWith("cf-") ||
    normalized.startsWith("x-sandbox-") ||
    normalized.startsWith("x-scotty-")
  );
};

const hasUpgradeFraming = (headers: Headers): boolean => {
  if (headers.has("upgrade")) return true;
  if (
    headers
      .get("connection")
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade") === true
  )
    return true;
  return [...headers].some(([name]) => name.toLowerCase().startsWith("sec-websocket-"));
};

const headersWithinBounds = (headers: Headers): boolean => {
  let count = 0;
  let bytes = 0;
  for (const [name, value] of headers) {
    count += 1;
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
    if (count > HATCH_MAX_HEADER_COUNT || bytes > HATCH_MAX_HEADER_BYTES) return false;
  }
  return true;
};

const declaredBodyLength = (headers: Headers): number | undefined => {
  const value = headers.get("content-length");
  if (value === null || !CONTENT_LENGTH_PATTERN.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

interface PreparedHatchWebSocket {
  readonly cookieSecret: string;
  readonly headers: Headers;
  readonly protocols: readonly string[];
}

const websocketProtocols = (value: string | null): readonly string[] | undefined => {
  if (value === null || value.trim() === "") return [];
  const protocols = value.split(",").map((protocol) => protocol.trim());
  if (
    protocols.length > HATCH_MAX_WEBSOCKET_PROTOCOLS ||
    new Set(protocols).size !== protocols.length ||
    protocols.some((protocol) => !WEBSOCKET_PROTOCOL_PATTERN.test(protocol))
  )
    return undefined;
  return protocols;
};

const prepareHatchWebSocket = (
  request: Request,
  host: string,
): PreparedHatchWebSocket | undefined => {
  const protocols = websocketProtocols(request.headers.get("sec-websocket-protocol"));
  const origin = request.headers.get("origin");
  if (
    request.method !== "GET" ||
    request.body !== null ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers
      .get("connection")
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade") !== true ||
    request.headers.get("sec-websocket-version") !== "13" ||
    !WEBSOCKET_KEY_PATTERN.test(request.headers.get("sec-websocket-key") ?? "") ||
    protocols === undefined ||
    origin !== `https://${host}` ||
    encoder.encode(request.url).byteLength > HATCH_MAX_URL_BYTES ||
    !headersWithinBounds(request.headers)
  )
    return undefined;
  const cookie = parseHatchCookie(request.headers.get("cookie"));
  if (cookie === undefined) return undefined;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "cookie" ||
      normalized === "sec-websocket-extensions" ||
      normalized === "sec-websocket-protocol" ||
      isUntrustedControlHeader(name)
    )
      continue;
    headers.append(name, value);
  }
  if (cookie.forwardedCookie !== undefined) headers.set("cookie", cookie.forwardedCookie);
  if (protocols.length > 0) headers.set("sec-websocket-protocol", protocols.join(", "));
  return { cookieSecret: cookie.secret, headers, protocols };
};

interface PreparedHatchRequest {
  readonly cookieSecret: string;
  readonly declaredIngressBytes: number | undefined;
  readonly reservedIngressBytes: number;
  readonly headers: Headers;
}

const prepareHatchRequest = (request: Request): PreparedHatchRequest | undefined => {
  const method = request.method.toUpperCase();
  if (
    method === "CONNECT" ||
    method === "TRACE" ||
    hasUpgradeFraming(request.headers) ||
    encoder.encode(request.url).byteLength > HATCH_MAX_URL_BYTES ||
    !headersWithinBounds(request.headers)
  )
    return undefined;
  const declaredIngressBytes = declaredBodyLength(request.headers);
  if (
    request.headers.has("transfer-encoding") ||
    (request.headers.has("content-length") && declaredIngressBytes === undefined) ||
    (declaredIngressBytes ?? 0) > HATCH_MAX_INGRESS_BYTES
  )
    return undefined;
  const cookie = parseHatchCookie(request.headers.get("cookie"));
  if (cookie === undefined) return undefined;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "cookie" ||
      normalized === "connection" ||
      normalized === "keep-alive" ||
      normalized === "te" ||
      normalized === "trailer" ||
      isUntrustedControlHeader(name)
    )
      continue;
    headers.append(name, value);
  }
  if (cookie.forwardedCookie !== undefined) headers.set("cookie", cookie.forwardedCookie);
  return {
    cookieSecret: cookie.secret,
    declaredIngressBytes,
    reservedIngressBytes: declaredIngressBytes ?? HATCH_MAX_INGRESS_BYTES,
    headers,
  };
};

type BodyRead =
  | { readonly kind: "complete"; readonly body: ArrayBuffer | null; readonly bytes: number }
  | { readonly kind: "invalid" | "canceled"; readonly bytes: number }
  | { readonly kind: "expired" };

const readBoundedBody = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  expiresAt: string,
): Promise<BodyRead> => {
  const expiry = Date.parse(expiresAt);
  // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native request ingress is fenced by the persisted Hatch request expiry
  if (!Number.isFinite(expiry) || Date.now() >= expiry) return { kind: "expired" };
  if (signal.aborted) return { kind: "canceled", bytes: 0 };
  if (body === null) return { kind: "complete", body: null, bytes: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<{ readonly kind: "canceled" } | { readonly kind: "expired" }>(
    (resolve) => {
      onAbort = () => resolve({ kind: "canceled" });
      signal.addEventListener("abort", onAbort, { once: true });
      // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native request ingress needs a real-time deadline outside an Effect runtime
      timeout = setTimeout(() => resolve({ kind: "expired" }), Math.max(0, expiry - Date.now()));
    },
  );
  const clearDeadline = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  };
  for (;;) {
    const next = await Promise.race([
      reader.read().then(
        (value) => ({ kind: "read" as const, value }),
        () => ({ kind: "error" as const }),
      ),
      interrupted,
    ]);
    if (next.kind === "canceled" || next.kind === "expired") {
      clearDeadline();
      void reader.cancel();
      return next.kind === "expired" ? { kind: "expired" } : { kind: "canceled", bytes };
    }
    if (next.kind === "error") {
      clearDeadline();
      return { kind: "canceled", bytes };
    }
    if (next.value.done) break;
    bytes += next.value.value.byteLength;
    if (bytes > HATCH_MAX_INGRESS_BYTES) {
      clearDeadline();
      void reader.cancel();
      return { kind: "invalid", bytes: HATCH_MAX_INGRESS_BYTES };
    }
    chunks.push(next.value.value);
  }
  clearDeadline();
  const buffered = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "complete", body: buffered.buffer, bytes };
};

const sanitizedRequest = (
  request: Request,
  prepared: PreparedHatchRequest,
  body: ArrayBuffer | null,
): Request =>
  new Request(request.url, {
    method: request.method,
    headers: prepared.headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(body === null ? {} : { body }),
  });

const denied = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });

const reservedSetCookie = (value: string): boolean => {
  const segments = value.split(";");
  const cookie = segments[0] ?? "";
  const separator = cookie.indexOf("=");
  return (
    separator <= 0 ||
    RESERVED_COOKIE_NAMES.has(cookie.slice(0, separator).trim().toLowerCase()) ||
    segments.slice(1).some((attribute) => {
      const attributeSeparator = attribute.indexOf("=");
      const name = (attributeSeparator < 0 ? attribute : attribute.slice(0, attributeSeparator))
        .trim()
        .toLowerCase();
      return name === "domain";
    })
  );
};

const rewriteLoopbackLocation = (
  value: string,
  requestUrl: string,
  route: HatchHostRoute,
): string => {
  const location = URL.canParse(value, requestUrl) ? new URL(value, requestUrl) : undefined;
  if (
    location === undefined ||
    (location.protocol !== "http:" && location.protocol !== "https:") ||
    !new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]).has(location.hostname) ||
    location.port !== String(route.port)
  )
    return value;
  const external = new URL(requestUrl);
  external.pathname = location.pathname;
  external.search = location.search;
  external.hash = location.hash;
  return external.toString();
};

const sanitizeHatchWebSocketResponse = (
  response: Response,
  protocols: readonly string[],
): Response | undefined => {
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null || socket === undefined) return undefined;
  const selected = response.headers.get("sec-websocket-protocol");
  if (
    selected !== null &&
    (!WEBSOCKET_PROTOCOL_PATTERN.test(selected) || !protocols.includes(selected))
  ) {
    socket.close(1002, "Invalid Hatch subprotocol");
    return undefined;
  }
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  });
  if (selected !== null) headers.set("sec-websocket-protocol", selected);
  return new Response(null, { status: 101, webSocket: socket, headers });
};

export const sanitizeHatchResponse = (
  response: Response,
  requestUrl: string,
  route: HatchHostRoute,
): Response => {
  if (response.webSocket !== null && response.webSocket !== undefined) return denied();
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "set-cookie" ||
      RESPONSE_STRIP_HEADERS.has(normalized) ||
      isUntrustedControlHeader(name)
    )
      continue;
    headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) {
    if (!reservedSetCookie(cookie)) headers.append("set-cookie", cookie);
  }
  const location = headers.get("location");
  if (location !== null)
    headers.set("location", rewriteLoopbackLocation(location, requestUrl, route));
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.delete(HATCH_PRIVATE_CLAIMED_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const sandboxFor = (env: HatchGatewayBindings, sessionId: string) =>
  getSandbox(env.SANDBOX, sessionId, {
    sleepAfter: "60m",
    transport: "rpc",
    enableDefaultSession: false,
    normalizeId: true,
  });

const handleHandoff = async (
  request: Request,
  env: HatchGatewayBindings,
  route: HatchHostRoute,
): Promise<Response> => {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== HATCH_HANDOFF_PATH ||
    url.search !== "" ||
    encoder.encode(request.url).byteLength > HATCH_MAX_URL_BYTES ||
    !headersWithinBounds(request.headers) ||
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded" ||
    request.headers.has("transfer-encoding") ||
    hasUpgradeFraming(request.headers)
  )
    return denied();
  const body = await readBoundedUtf8Body(request, HATCH_HANDOFF_MAX_BYTES);
  if (body === undefined) return denied();
  const form = new URLSearchParams(body);
  if ([...form.keys()].length !== 1 || form.getAll("handoff").length !== 1) return denied();
  const handoff = form.get("handoff");
  if (handoff === null) return denied();
  const sandbox = sandboxFor(env, route.sessionId);
  const authoritative = await sandbox.getScottyHatchRoute(route).then(
    (value) => value,
    () => undefined,
  );
  if (authoritative === undefined) return denied();
  const consumed = await authRegistry(env).consumeHatchHandoff(
    handoff,
    route.sessionId,
    authoritative.hatchId,
  );
  if (!consumed.ok) return denied();
  const cookieSecret = crypto.getRandomValues(new Uint8Array(32));
  const rawCookie = Array.from(cookieSecret, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const cookieDigest = await sha256Hex(rawCookie).then(
    (value) => value,
    () => undefined,
  );
  if (cookieDigest === undefined) return denied();
  const permit = await sandbox
    .issueScottyHatchPermit(route, consumed.value.browserClientId, cookieDigest)
    .then(
      (value) => value,
      () => undefined,
    );
  if (permit === undefined) return denied();
  // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: exact-host Set-Cookie Max-Age is derived at the native Worker response boundary
  const remainingMillis = Date.parse(permit.expiresAt) - Date.now();
  if (!Number.isFinite(remainingMillis) || remainingMillis <= 0) return denied();
  const maxAge = Math.max(1, Math.floor(remainingMillis / 1_000));
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      // The handoff is a cross-site POST followed by this top-level GET redirect.
      // Lax permits the redirect request to carry the exact-host Hatch cookie;
      // Strict withholds it until a later, separate navigation.
      "set-cookie": `${HATCH_COOKIE}=${rawCookie}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
};

export const handleHatchRequest = async (
  request: Request,
  env: HatchGatewayBindings,
): Promise<Response | null> => {
  const previewBase = env.SCOTTY_PREVIEW_BASE;
  if (previewBase === undefined) return null;
  const authority = new URL(request.url).hostname;
  const hostHeader = request.headers.get("host");
  if (hostHeader !== null && hostHeader !== authority) return denied();
  const parsed = parseHatchHost(authority, previewBase);
  if (parsed.kind === "not_hatch") return null;
  if (parsed.kind === "invalid_hatch") return denied();
  if (new URL(request.url).pathname === HATCH_HANDOFF_PATH)
    return handleHandoff(request, env, parsed.route);
  const websocket = hasUpgradeFraming(request.headers)
    ? prepareHatchWebSocket(request, authority)
    : undefined;
  if (websocket !== undefined) {
    const sandbox = sandboxFor(env, parsed.route.sessionId);
    const admission = {
      ...parsed.route,
      host: authority,
      origin: request.headers.get("origin") ?? "",
      cookieSecret: websocket.cookieSecret,
    } satisfies HatchWebSocketAdmissionV1;
    const permit = await sandbox.admitScottyHatchWebSocket(admission).then(
      (value) => value,
      () => undefined,
    );
    if (permit === undefined) return denied();
    const headers = new Headers(websocket.headers);
    headers.set(HATCH_PRIVATE_WEBSOCKET_HEADER, permit.socketId);
    const proxied = await proxyToSandbox(new Request(request, { headers }), {
      Sandbox: env.SANDBOX,
    }).then(
      (response) => response,
      () => null,
    );
    if (
      proxied === null ||
      proxied.headers.get(HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER) !== permit.socketId
    ) {
      await sandbox.cancelScottyHatchWebSocket(permit.socketId).then(
        () => undefined,
        () => undefined,
      );
      proxied?.webSocket?.close(1008, "Hatch upgrade denied");
      return denied();
    }
    const sanitized = sanitizeHatchWebSocketResponse(proxied, websocket.protocols);
    if (sanitized !== undefined) return sanitized;
    await sandbox.cancelScottyHatchWebSocket(permit.socketId).then(
      () => undefined,
      () => undefined,
    );
    return denied();
  }
  if (hasUpgradeFraming(request.headers)) return denied();
  const prepared = prepareHatchRequest(request);
  if (prepared === undefined) return denied();
  const sandbox = sandboxFor(env, parsed.route.sessionId);
  const admission = {
    ...parsed.route,
    cookieSecret: prepared.cookieSecret,
    ingressBytes: prepared.reservedIngressBytes,
  } satisfies HatchRequestAdmissionV1;
  const permit = await sandbox.admitScottyHatchRequest(admission).then(
    (value) => value,
    () => undefined,
  );
  if (permit === undefined) return denied();
  const read = await readBoundedBody(request.body, request.signal, permit.expiresAt);
  if (read.kind === "expired") {
    await sandbox.cancelScottyHatchRequest(permit.requestId).then(
      () => undefined,
      () => undefined,
    );
    return denied();
  }
  const adjusted = await sandbox.adjustScottyHatchRequest(permit.requestId, read.bytes).then(
    (value) => value,
    () => false,
  );
  if (
    !adjusted ||
    read.kind !== "complete" ||
    (prepared.declaredIngressBytes !== undefined && read.bytes !== prepared.declaredIngressBytes)
  ) {
    await sandbox.cancelScottyHatchRequest(permit.requestId).then(
      () => undefined,
      () => undefined,
    );
    return denied();
  }
  const sanitized = sanitizedRequest(request, prepared, read.body);
  const headers = new Headers(sanitized.headers);
  headers.set(HATCH_PRIVATE_REQUEST_HEADER, permit.requestId);
  const proxied = await proxyToSandbox(new Request(sanitized, { headers }), {
    Sandbox: env.SANDBOX,
  }).then(
    (response) => response,
    () => null,
  );
  if (proxied === null || proxied.headers.get(HATCH_PRIVATE_CLAIMED_HEADER) !== permit.requestId) {
    await sandbox.cancelScottyHatchRequest(permit.requestId).then(
      () => undefined,
      () => undefined,
    );
    return denied();
  }
  return sanitizeHatchResponse(proxied, request.url, parsed.route);
};
