import {
  HATCH_COOKIE,
  HATCH_HANDOFF_PATH,
  HATCH_MAX_INGRESS_BYTES,
  HATCH_RESERVED_PORTS,
  type HatchHostRouteV1,
} from "./contracts";

export const HATCH_MAX_URL_BYTES = 8 * 1_024;
export const HATCH_MAX_HEADER_BYTES = 32 * 1_024;
export const HATCH_MAX_HEADER_COUNT = 128;
const CONTROL_COOKIE = "__Host-scotty";
const EVIDENCE_COOKIE = "__Host-scotty-preview";
const BASE_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
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
const encoder = new TextEncoder();
const HTTP_BLOCKED_METHODS = new Set(["CONNECT", "TRACE"]);

export const isValidHatchPreviewBase = (value: string): boolean => BASE_PATTERN.test(value);

export type HatchHostRoute = HatchHostRouteV1;

export type HatchHostParse =
  | { readonly kind: "not_hatch" }
  | { readonly kind: "invalid_hatch" }
  | { readonly kind: "hatch"; readonly route: HatchHostRoute };

type HostSyntax =
  | { readonly kind: "not_hatch" }
  | { readonly kind: "invalid_hatch" }
  | { readonly kind: "candidate"; readonly label: string };

const classifyHostSyntax = (host: string, previewBase: string): HostSyntax => {
  const lowerHost = host.toLowerCase();
  const previewHost = lowerHost === previewBase || lowerHost.endsWith(`.${previewBase}`);
  if (host !== lowerHost || host.endsWith(".") || host.includes(":"))
    return previewHost ? { kind: "invalid_hatch" } : { kind: "not_hatch" };
  if (host === previewBase) return { kind: "invalid_hatch" };
  if (!host.endsWith(`.${previewBase}`)) return { kind: "not_hatch" };
  const label = host.slice(0, -(previewBase.length + 1));
  return label.includes(".") ? { kind: "invalid_hatch" } : { kind: "candidate", label };
};

const parseHostCandidate = (label: string): HatchHostParse => {
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

export const parseHatchHost = (host: string, previewBase: string): HatchHostParse => {
  if (!BASE_PATTERN.test(previewBase)) return { kind: "invalid_hatch" };
  const syntax = classifyHostSyntax(host, previewBase);
  return syntax.kind === "candidate" ? parseHostCandidate(syntax.label) : syntax;
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

export const hasUpgradeFraming = (headers: Headers): boolean => {
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

export const headersWithinBounds = (headers: Headers): boolean => {
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

export interface HatchRequestMetadata {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

export interface PreparedHatchWebSocket {
  readonly cookieSecret: string;
  readonly headers: Headers;
  readonly protocols: readonly string[];
}

const validWebSocketIngress = (request: HatchRequestMetadata, host: string): boolean => {
  const { headers } = request;
  const connection = headers.get("connection");
  return (
    request.method === "GET" &&
    headers.get("upgrade")?.toLowerCase() === "websocket" &&
    connection?.split(",").some((token) => token.trim().toLowerCase() === "upgrade") === true &&
    headers.get("sec-websocket-version") === "13" &&
    WEBSOCKET_KEY_PATTERN.test(headers.get("sec-websocket-key") ?? "") &&
    headers.get("origin") === `https://${host}` &&
    encoder.encode(request.url).byteLength <= HATCH_MAX_URL_BYTES &&
    headersWithinBounds(headers)
  );
};

const projectHeaders = (
  headers: Headers,
  excluded: ReadonlySet<string>,
  forwardedCookie: string | undefined,
): Headers => {
  const projected = new Headers();
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (excluded.has(normalized) || isUntrustedControlHeader(name)) continue;
    projected.append(name, value);
  }
  if (forwardedCookie !== undefined) projected.set("cookie", forwardedCookie);
  return projected;
};

const HTTP_PROJECTED_HEADERS = new Set(["cookie", "connection", "keep-alive", "te", "trailer"]);
const WEBSOCKET_PROJECTED_HEADERS = new Set([
  "cookie",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

export const prepareHatchWebSocket = (
  request: HatchRequestMetadata & { readonly bodyPresent: boolean },
  host: string,
): PreparedHatchWebSocket | undefined => {
  const protocols = websocketProtocols(request.headers.get("sec-websocket-protocol"));
  if (request.bodyPresent || protocols === undefined || !validWebSocketIngress(request, host))
    return undefined;
  const cookie = parseHatchCookie(request.headers.get("cookie"));
  if (cookie === undefined) return undefined;
  const headers = projectHeaders(
    request.headers,
    WEBSOCKET_PROJECTED_HEADERS,
    cookie.forwardedCookie,
  );
  if (protocols.length > 0) headers.set("sec-websocket-protocol", protocols.join(", "));
  return { cookieSecret: cookie.secret, headers, protocols };
};

export interface PreparedHatchRequest {
  readonly cookieSecret: string;
  readonly declaredIngressBytes: number | undefined;
  readonly reservedIngressBytes: number;
  readonly headers: Headers;
}

const validHttpIngress = (request: HatchRequestMetadata): boolean => {
  const { headers } = request;
  const declaredIngressBytes = declaredBodyLength(headers);
  if (HTTP_BLOCKED_METHODS.has(request.method.toUpperCase())) return false;
  if (hasUpgradeFraming(headers)) return false;
  if (encoder.encode(request.url).byteLength > HATCH_MAX_URL_BYTES) return false;
  if (!headersWithinBounds(headers)) return false;
  if (headers.has("transfer-encoding")) return false;
  if (headers.has("content-length") && declaredIngressBytes === undefined) return false;
  return (declaredIngressBytes ?? 0) <= HATCH_MAX_INGRESS_BYTES;
};

export const prepareHatchRequest = (
  request: HatchRequestMetadata,
): PreparedHatchRequest | undefined => {
  const declaredIngressBytes = declaredBodyLength(request.headers);
  if (!validHttpIngress(request)) return undefined;
  const cookie = parseHatchCookie(request.headers.get("cookie"));
  if (cookie === undefined) return undefined;
  return {
    cookieSecret: cookie.secret,
    declaredIngressBytes,
    reservedIngressBytes: declaredIngressBytes ?? HATCH_MAX_INGRESS_BYTES,
    headers: projectHeaders(request.headers, HTTP_PROJECTED_HEADERS, cookie.forwardedCookie),
  };
};

export const validHatchHandoffIngress = (request: HatchRequestMetadata): boolean => {
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    request.method === "POST" &&
    url.pathname === HATCH_HANDOFF_PATH &&
    url.search === "" &&
    encoder.encode(request.url).byteLength <= HATCH_MAX_URL_BYTES &&
    headersWithinBounds(request.headers) &&
    contentType === "application/x-www-form-urlencoded" &&
    !request.headers.has("transfer-encoding") &&
    !hasUpgradeFraming(request.headers)
  );
};
