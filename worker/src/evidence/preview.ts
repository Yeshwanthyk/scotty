// Native Worker host adapter: this module validates raw HTTP framing and delegates only after
// authoritative Sandbox RPC authorization. It is intentionally not an Effect domain module.
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import type { Bindings } from "../shared/bindings";
import {
  EVIDENCE_PREVIEW_MAX_INGRESS_BYTES,
  EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER,
  EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER,
  EVIDENCE_RESERVED_PORTS,
  type EvidencePreviewAdmission,
} from "./contracts";

export const EVIDENCE_PREVIEW_COOKIE = "__Host-scotty-preview";
export const EVIDENCE_PREVIEW_MAX_URL_BYTES = 8 * 1_024;
export const EVIDENCE_PREVIEW_MAX_HEADER_BYTES = 32 * 1_024;
export const EVIDENCE_PREVIEW_MAX_HEADER_COUNT = 128;
export const EVIDENCE_PREVIEW_MAX_BODY_BYTES = EVIDENCE_PREVIEW_MAX_INGRESS_BYTES;
const CONTROL_COOKIE = "__Host-scotty";
const PREVIEW_BASE_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PREVIEW_LABEL_PATTERN = /^([1-9][0-9]{3,4})-([0-9a-f]{12})-([a-z0-9_]{16})$/u;
const COOKIE_SECRET_PATTERN = /^[0-9a-f]{64}$/u;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const RESERVED_COOKIE_NAMES = new Set([
  CONTROL_COOKIE.toLowerCase(),
  EVIDENCE_PREVIEW_COOKIE.toLowerCase(),
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
const textEncoder = new TextEncoder();

export interface EvidencePreviewRoute {
  readonly port: number;
  readonly sessionId: string;
  readonly routeNonce: string;
}

export type EvidencePreviewHostParse =
  | { readonly kind: "not_preview" }
  | { readonly kind: "invalid_preview" }
  | { readonly kind: "preview"; readonly route: EvidencePreviewRoute };

export const parseEvidencePreviewHost = (
  host: string,
  previewBase: string,
): EvidencePreviewHostParse => {
  if (!PREVIEW_BASE_PATTERN.test(previewBase)) return { kind: "invalid_preview" };
  if (host !== host.toLowerCase() || host.endsWith(".") || host.includes(":")) {
    return host.toLowerCase() === previewBase || host.toLowerCase().endsWith(`.${previewBase}`)
      ? { kind: "invalid_preview" }
      : { kind: "not_preview" };
  }
  if (host !== previewBase && !host.endsWith(`.${previewBase}`)) return { kind: "not_preview" };
  if (host === previewBase) return { kind: "invalid_preview" };
  const label = host.slice(0, -(previewBase.length + 1));
  if (label.includes(".")) return { kind: "invalid_preview" };
  const match = PREVIEW_LABEL_PATTERN.exec(label);
  if (match === null) return { kind: "invalid_preview" };
  const port = Number(match[1]);
  const sessionId = match[2];
  const routeNonce = match[3];
  if (
    !Number.isInteger(port) ||
    port < 1_024 ||
    port > 65_535 ||
    EVIDENCE_RESERVED_PORTS.has(port) ||
    sessionId === undefined ||
    routeNonce === undefined
  )
    return { kind: "invalid_preview" };
  return { kind: "preview", route: { port, sessionId, routeNonce } };
};

interface ParsedPreviewCookie {
  readonly secret: string;
  readonly forwardedCookie: string | undefined;
}

const parsePreviewCookie = (header: string | null): ParsedPreviewCookie | undefined => {
  if (header === null) return undefined;
  const forwarded: string[] = [];
  const previewSecrets: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) return undefined;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    const normalizedName = name.toLowerCase();
    if (normalizedName === EVIDENCE_PREVIEW_COOKIE.toLowerCase()) previewSecrets.push(value);
    else if (!RESERVED_COOKIE_NAMES.has(normalizedName)) forwarded.push(`${name}=${value}`);
  }
  if (previewSecrets.length !== 1 || !COOKIE_SECRET_PATTERN.test(previewSecrets[0] ?? ""))
    return undefined;
  return {
    secret: previewSecrets[0] ?? "",
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

const hasWebSocketOrUpgradeFraming = (headers: Headers): boolean => {
  if (headers.has("upgrade")) return true;
  const connection = headers.get("connection");
  if (connection?.split(",").some((token) => token.trim().toLowerCase() === "upgrade") === true)
    return true;
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith("sec-websocket-")) return true;
  }
  return false;
};

const declaredBodyLength = (headers: Headers): number | undefined => {
  const contentLength = headers.get("content-length");
  if (contentLength === null || !CONTENT_LENGTH_PATTERN.test(contentLength)) return undefined;
  const parsed = Number(contentLength);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const headersWithinBounds = (headers: Headers): boolean => {
  let count = 0;
  let bytes = 0;
  for (const [name, value] of headers) {
    count += 1;
    bytes += textEncoder.encode(name).byteLength + textEncoder.encode(value).byteLength + 4;
    if (count > EVIDENCE_PREVIEW_MAX_HEADER_COUNT || bytes > EVIDENCE_PREVIEW_MAX_HEADER_BYTES)
      return false;
  }
  return true;
};

interface PreparedEvidencePreviewRequest {
  readonly cookieSecret: string;
  readonly declaredIngressBytes: number | undefined;
  readonly reservedIngressBytes: number;
  readonly headers: Headers;
}

type EvidencePreviewBodyRead =
  | { readonly kind: "complete"; readonly body: ArrayBuffer | null; readonly ingressBytes: number }
  | { readonly kind: "canceled" | "invalid"; readonly ingressBytes: number }
  | { readonly kind: "expired" };

const validEvidencePreviewIngress = (
  request: Request,
  declaredIngressBytes: number | undefined,
): boolean => {
  const method = request.method.toUpperCase();
  return (
    method !== "CONNECT" &&
    method !== "TRACE" &&
    !hasWebSocketOrUpgradeFraming(request.headers) &&
    textEncoder.encode(request.url).byteLength <= EVIDENCE_PREVIEW_MAX_URL_BYTES &&
    headersWithinBounds(request.headers) &&
    !request.headers.has("transfer-encoding") &&
    (!request.headers.has("content-length") || declaredIngressBytes !== undefined) &&
    (declaredIngressBytes ?? 0) <= EVIDENCE_PREVIEW_MAX_BODY_BYTES
  );
};

const evidencePreviewHeaders = (source: Headers, forwardedCookie: string | undefined): Headers => {
  const headers = new Headers();
  for (const [name, value] of source) {
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
  if (forwardedCookie !== undefined) headers.set("cookie", forwardedCookie);
  return headers;
};

const prepareEvidencePreviewRequest = (
  request: Request,
): PreparedEvidencePreviewRequest | undefined => {
  const declaredIngressBytes = declaredBodyLength(request.headers);
  if (!validEvidencePreviewIngress(request, declaredIngressBytes)) return undefined;
  const parsedCookie = parsePreviewCookie(request.headers.get("cookie"));
  if (parsedCookie === undefined) return undefined;
  return {
    cookieSecret: parsedCookie.secret,
    declaredIngressBytes,
    reservedIngressBytes: declaredIngressBytes ?? EVIDENCE_PREVIEW_MAX_BODY_BYTES,
    headers: evidencePreviewHeaders(request.headers, parsedCookie.forwardedCookie),
  };
};

const readBoundedBody = async (
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
  expiresAt?: string,
): Promise<EvidencePreviewBodyRead> => {
  const expiryMillis = expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(expiresAt);
  if (!Number.isFinite(expiryMillis) && expiresAt !== undefined) return { kind: "expired" };
  // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Worker request-body ingress must stop at the persisted absolute permit expiry
  const nowMillis = Date.now();
  if (nowMillis >= expiryMillis) return { kind: "expired" };
  if (signal?.aborted === true) return { kind: "canceled", ingressBytes: 0 };
  if (body === null) return { kind: "complete", body: null, ingressBytes: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<{ readonly kind: "canceled" } | { readonly kind: "expired" }>(
    (resolve) => {
      onAbort = () => resolve({ kind: "canceled" });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (Number.isFinite(expiryMillis)) {
        // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Worker request-body ingress needs a real-time delay from the persisted permit expiry
        const remainingMillis = Math.max(0, expiryMillis - Date.now());
        // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Worker request-body ingress must abort without an Effect runtime owning the host callback
        timeout = setTimeout(() => resolve({ kind: "expired" }), remainingMillis);
      }
    },
  );
  const finish = <A extends EvidencePreviewBodyRead>(result: A): A => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    return result;
  };

  for (;;) {
    const next = await Promise.race([
      reader.read().then(
        (value) => ({ kind: "read" as const, value }),
        () => ({ kind: "read_error" as const }),
      ),
      interrupted,
    ]);
    if (next.kind === "canceled" || next.kind === "expired") {
      void reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      return finish(next.kind === "expired" ? next : { kind: "canceled", ingressBytes: bytes });
    }
    if (next.kind === "read_error") return finish({ kind: "canceled", ingressBytes: bytes });
    if (next.value.done) break;
    const nextBytes = bytes + next.value.value.byteLength;
    if (nextBytes > EVIDENCE_PREVIEW_MAX_BODY_BYTES) {
      void reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      return finish({ kind: "invalid", ingressBytes: EVIDENCE_PREVIEW_MAX_BODY_BYTES });
    }
    bytes = nextBytes;
    chunks.push(next.value.value);
  }
  const buffered = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return finish({ kind: "complete", body: buffered.buffer, ingressBytes: bytes });
};

const sanitizedEvidencePreviewRequest = (
  request: Request,
  prepared: PreparedEvidencePreviewRequest,
  body: ArrayBuffer | null,
): Request =>
  new Request(request.url, {
    method: request.method,
    headers: prepared.headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(body === null ? {} : { body }),
  });

export const sanitizeEvidencePreviewRequest = async (
  request: Request,
): Promise<
  | { readonly request: Request; readonly cookieSecret: string; readonly ingressBytes: number }
  | undefined
> => {
  const prepared = prepareEvidencePreviewRequest(request);
  if (prepared === undefined) return undefined;
  const read = await readBoundedBody(request.body, request.signal);
  if (
    read.kind !== "complete" ||
    (prepared.declaredIngressBytes !== undefined &&
      read.ingressBytes !== prepared.declaredIngressBytes)
  )
    return undefined;
  return {
    request: sanitizedEvidencePreviewRequest(request, prepared, read.body),
    cookieSecret: prepared.cookieSecret,
    ingressBytes: read.ingressBytes,
  };
};

const reservedSetCookie = (value: string): boolean => {
  const separator = value.indexOf("=");
  if (separator <= 0) return true;
  return RESERVED_COOKIE_NAMES.has(value.slice(0, separator).trim().toLowerCase());
};

function deniedPreviewResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}

export const sanitizeEvidencePreviewResponse = (response: Response): Response => {
  if (response.webSocket !== null && response.webSocket !== undefined)
    return deniedPreviewResponse();
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "set-cookie" ||
      RESPONSE_STRIP_HEADERS.has(normalized) ||
      isUntrustedControlHeader(normalized)
    )
      continue;
    headers.append(name, value);
  }
  for (const setCookie of response.headers.getSetCookie()) {
    if (!reservedSetCookie(setCookie)) headers.append("set-cookie", setCookie);
  }
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const handleEvidencePreviewRequest = async (
  request: Request,
  env: Bindings,
): Promise<Response | null> => {
  const previewBase = env.SCOTTY_PREVIEW_BASE;
  if (previewBase === undefined) return null;
  const authority = new URL(request.url).hostname;
  const hostHeader = request.headers.get("host");
  if (hostHeader !== null && hostHeader !== authority) return deniedPreviewResponse();
  const parsed = parseEvidencePreviewHost(authority, previewBase);
  if (parsed.kind === "not_preview") return null;
  if (parsed.kind === "invalid_preview" || env.SCOTTY_EVIDENCE_ENABLED !== "true")
    return deniedPreviewResponse();
  const prepared = prepareEvidencePreviewRequest(request);
  if (prepared === undefined) return deniedPreviewResponse();
  const admission = {
    ...parsed.route,
    cookieSecret: prepared.cookieSecret,
    ingressBytes: prepared.reservedIngressBytes,
  } satisfies EvidencePreviewAdmission;
  const sandbox = getSandbox(env.SANDBOX, parsed.route.sessionId, {
    sleepAfter: "60m",
    transport: "rpc",
    enableDefaultSession: false,
    normalizeId: true,
  });
  const permit = await sandbox.admitScottyEvidencePreview(admission).then(
    (value) => value,
    () => undefined,
  );
  if (permit === undefined) return deniedPreviewResponse();
  const cancelPermit = (): Promise<void> =>
    sandbox.cancelScottyEvidencePreviewRequest(permit.requestId).then(
      () => undefined,
      () => undefined,
    );
  const read = await readBoundedBody(request.body, request.signal, permit.expiresAt);
  if (read.kind === "expired") {
    await sandbox.expireScottyEvidencePreviewRequest(permit.requestId).then(
      () => undefined,
      () => undefined,
    );
    return deniedPreviewResponse();
  }
  const adjusted = await sandbox
    .adjustScottyEvidencePreviewRequest(permit.requestId, read.ingressBytes)
    .then(
      (value) => value,
      () => false,
    );
  if (
    !adjusted ||
    read.kind !== "complete" ||
    (prepared.declaredIngressBytes !== undefined &&
      read.ingressBytes !== prepared.declaredIngressBytes)
  ) {
    await cancelPermit();
    return deniedPreviewResponse();
  }
  const sanitized = sanitizedEvidencePreviewRequest(request, prepared, read.body);
  const headers = new Headers(sanitized.headers);
  headers.set(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER, permit.requestId);
  const permittedRequest = new Request(sanitized, { headers });
  const proxied = await proxyToSandbox(permittedRequest, { Sandbox: env.SANDBOX }).then(
    (response) => ({ ok: response !== null, response }),
    () => ({ ok: false as const, response: null }),
  );
  if (
    !proxied.ok ||
    proxied.response === null ||
    proxied.response.headers.get(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER) !== permit.requestId
  ) {
    await cancelPermit();
    return deniedPreviewResponse();
  }
  return sanitizeEvidencePreviewResponse(proxied.response);
};
