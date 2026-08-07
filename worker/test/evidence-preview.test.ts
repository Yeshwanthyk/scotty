import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.hoisted(() => vi.fn());
const proxy = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => ({ authorizeScottyEvidencePreview: authorize })),
  proxyToSandbox: proxy,
}));

import type { Bindings } from "../src/bindings";
import {
  EVIDENCE_PREVIEW_COOKIE,
  EVIDENCE_PREVIEW_MAX_BODY_BYTES,
  EVIDENCE_PREVIEW_MAX_HEADER_BYTES,
  EVIDENCE_PREVIEW_MAX_URL_BYTES,
  handleEvidencePreviewRequest,
  parseEvidencePreviewHost,
  sanitizeEvidencePreviewRequest,
  sanitizeEvidencePreviewResponse,
} from "../src/evidence-preview";
import { workerFetch } from "../src/index";

const BASE = "preview.example.test";
const SESSION_ID = "a0b1c2d3e4f5";
const ROUTE_NONCE = "0123456789abcdef";
const COOKIE_SECRET = "a".repeat(64);
const HOST = `4173-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`;
const env = {
  SANDBOX: {} as DurableObjectNamespace<import("../src/session").Sandbox>,
  SCOTTY_PREVIEW_BASE: BASE,
  SCOTTY_EVIDENCE_ENABLED: "true",
} as Bindings;

describe("evidence preview host parser", () => {
  it("accepts only the canonical SDK host", () => {
    expect(parseEvidencePreviewHost(HOST, BASE)).toEqual({
      kind: "preview",
      route: { port: 4_173, sessionId: SESSION_ID, routeNonce: ROUTE_NONCE },
    });
    for (const host of [
      HOST.toUpperCase(),
      `04173-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`,
      `3000-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`,
      `43117-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`,
      `4173-${SESSION_ID}-${ROUTE_NONCE}.extra.${BASE}`,
      `4173-${SESSION_ID}-${ROUTE_NONCE.slice(1)}.${BASE}`,
      BASE,
    ]) {
      expect(parseEvidencePreviewHost(host, BASE).kind, host).toBe("invalid_preview");
    }
    expect(parseEvidencePreviewHost("control.example.test", BASE)).toEqual({
      kind: "not_preview",
    });
  });
});

describe("evidence preview sanitation", () => {
  it("requires exactly one preview cookie and strips all Scotty/provider authority", async () => {
    const sanitized = await sanitizeEvidencePreviewRequest(
      new Request(`https://${HOST}/app?q=1`, {
        headers: {
          authorization: "Bearer must-not-forward",
          cookie: `app=kept; __Host-scotty=browser-secret; ${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
          "cf-access-jwt-assertion": "provider-secret",
          "cdn-loop": "cloudflare",
          forwarded: "for=attacker",
          "proxy-authorization": "Basic attacker",
          "true-client-ip": "192.0.2.1",
          via: "attacker-proxy",
          "x-forwarded-host": "attacker.example",
          "x-real-ip": "192.0.2.2",
          "x-sandbox-token": "sandbox-secret",
          "x-scotty-token": "scotty-secret",
          "x-app-header": "kept",
        },
      }),
    );
    expect(sanitized?.cookieSecret).toBe(COOKIE_SECRET);
    expect(sanitized?.request.headers.get("cookie")).toBe("app=kept");
    expect(sanitized?.request.headers.get("x-app-header")).toBe("kept");
    for (const name of [
      "authorization",
      "cdn-loop",
      "cf-access-jwt-assertion",
      "forwarded",
      "proxy-authorization",
      "true-client-ip",
      "via",
      "x-forwarded-host",
      "x-real-ip",
      "x-sandbox-token",
      "x-scotty-token",
    ]) {
      expect(sanitized?.request.headers.get(name), name).toBeNull();
    }

    for (const cookie of [
      null,
      `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}; ${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
      `${EVIDENCE_PREVIEW_COOKIE}=uppercase${COOKIE_SECRET}`,
    ]) {
      const headers = cookie === null ? undefined : { cookie };
      expect(
        await sanitizeEvidencePreviewRequest(new Request(`https://${HOST}/`, { headers })),
      ).toBe(undefined);
    }
  });

  it("rejects upgrade, forbidden methods, ambiguous framing, and bounded HTTP violations", async () => {
    const cookie = `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`;
    const requests: Request[] = [];
    for (const method of ["CONNECT", "TRACE"]) {
      const request = new Request(`https://${HOST}/`, { headers: { cookie } });
      Object.defineProperty(request, "method", { value: method });
      requests.push(request);
    }
    requests.push(
      new Request(`https://${HOST}/`, {
        headers: { connection: "keep-alive, Upgrade", cookie, upgrade: "websocket" },
      }),
      new Request(`https://${HOST}/`, {
        headers: { cookie, "sec-websocket-key": "attacker" },
      }),
      new Request(`https://${HOST}/`, {
        headers: { cookie, "content-length": "1", "transfer-encoding": "chunked" },
      }),
      new Request(`https://${HOST}/`, {
        headers: { cookie, "content-length": "1, 1" },
      }),
      new Request(`https://${HOST}/`, {
        headers: { cookie, "content-length": "1, 2" },
      }),
      new Request(`https://${HOST}/${"u".repeat(EVIDENCE_PREVIEW_MAX_URL_BYTES)}`, {
        headers: { cookie },
      }),
      new Request(`https://${HOST}/`, {
        headers: { cookie, "x-large": "h".repeat(EVIDENCE_PREVIEW_MAX_HEADER_BYTES) },
      }),
      new Request(`https://${HOST}/`, {
        method: "POST",
        headers: { cookie },
        body: new Uint8Array(EVIDENCE_PREVIEW_MAX_BODY_BYTES + 1),
      }),
      new Request(`https://${HOST}/`, {
        method: "POST",
        headers: { cookie, "content-length": "2" },
        body: Uint8Array.of(1),
      }),
    );

    for (const request of requests) {
      const response = await handleEvidencePreviewRequest(request, env);
      expect(response?.status, request.method).toBe(404);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });

  it("strips reserved response cookies and adds private preview defenses", () => {
    const headers = new Headers({
      "cache-control": "public, max-age=3600",
      "cf-ray": "provider-identity",
      "x-sandbox-name": "internal",
    });
    headers.append("set-cookie", "app=kept; Secure; Path=/");
    headers.append("set-cookie", `${EVIDENCE_PREVIEW_COOKIE}=must-not-leak; Secure; Path=/`);
    headers.append("set-cookie", "__Host-scotty=must-not-leak; Secure; Path=/");
    const response = sanitizeEvidencePreviewResponse(new Response("app", { headers }));
    expect(response.headers.getSetCookie()).toEqual(["app=kept; Secure; Path=/"]);
    expect(response.headers.get("cf-ray")).toBeNull();
    expect(response.headers.get("x-sandbox-name")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });
});

describe("evidence preview host adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(true);
    proxy.mockImplementation(async (request: Request) => {
      expect(request.headers.get("cookie")).toBe("app=kept");
      expect(request.headers.get("authorization")).toBeNull();
      return new Response("proxied app", {
        headers: { "set-cookie": "app-session=value; Secure; Path=/" },
      });
    });
  });

  it("authorizes in the owning DO before delegating transport to proxyToSandbox", async () => {
    const response = await handleEvidencePreviewRequest(
      new Request(`https://${HOST}/dashboard`, {
        headers: {
          host: HOST,
          cookie: `app=kept; ${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
          authorization: "Bearer strip-me",
        },
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("proxied app");
    expect(authorize).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      port: 4_173,
      routeNonce: ROUTE_NONCE,
      cookieSecret: COOKIE_SECRET,
    });
    expect(proxy).toHaveBeenCalledTimes(1);
  });

  it("denies failed authorization and ambiguous proxy transport without leaking authority", async () => {
    authorize.mockResolvedValueOnce(false);
    const denied = await handleEvidencePreviewRequest(
      new Request(`https://${HOST}/`, {
        headers: {
          host: HOST,
          cookie: `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
        },
      }),
      env,
    );
    expect(denied?.status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();

    authorize.mockResolvedValueOnce(true);
    proxy.mockRejectedValueOnce(new Error("ambiguous transport"));
    const ambiguous = await handleEvidencePreviewRequest(
      new Request(`https://${HOST}/`, {
        headers: {
          host: HOST,
          cookie: `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
        },
      }),
      env,
    );
    expect(ambiguous?.status).toBe(404);
    expect(ambiguous?.headers.get("cache-control")).toBe("no-store");
  });

  it("uses URL authority, rejects Host disagreement, and never authorizes the mismatch", async () => {
    const response = await handleEvidencePreviewRequest(
      new Request(`https://${HOST}/`, {
        headers: {
          host: "control.example.test",
          cookie: `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
        },
      }),
      env,
    );
    expect(response?.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });

  it("never falls through for malformed preview suffixes or URL-only requests", async () => {
    const malformed = await handleEvidencePreviewRequest(
      new Request(`https://${BASE}/api/sessions`, { headers: { host: BASE } }),
      env,
    );
    const urlOnly = await handleEvidencePreviewRequest(
      new Request(`https://${HOST}/`, { headers: { host: HOST } }),
      env,
    );
    expect(malformed?.status).toBe(404);
    expect(urlOnly?.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });

  it("denies the preview suffix through the exported Worker adapter when the gate is off", async () => {
    const response = await workerFetch(
      new Request(`https://${HOST}/`, {
        headers: { cookie: `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}` },
      }),
      { ...env, SCOTTY_EVIDENCE_ENABLED: undefined },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });

  it("returns null only when the host is outside the configured preview suffix", async () => {
    expect(
      await handleEvidencePreviewRequest(
        new Request("https://control.example.test/sessions", {
          headers: { host: "control.example.test" },
        }),
        env,
      ),
    ).toBeNull();
    expect(
      await handleEvidencePreviewRequest(new Request(`https://${HOST}/`), {
        ...env,
        SCOTTY_PREVIEW_BASE: undefined,
        SCOTTY_EVIDENCE_ENABLED: undefined,
      }),
    ).toBeNull();
  });
});
