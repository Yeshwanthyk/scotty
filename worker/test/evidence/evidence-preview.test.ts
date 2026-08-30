import { beforeEach, describe, expect, it, vi } from "vitest";

const adjust = vi.hoisted(() => vi.fn());
const admit = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const expire = vi.hoisted(() => vi.fn());
const proxy = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => ({
    adjustScottyEvidencePreviewRequest: adjust,
    admitScottyEvidencePreview: admit,
    cancelScottyEvidencePreviewRequest: cancel,
    expireScottyEvidencePreviewRequest: expire,
  })),
  proxyToSandbox: proxy,
}));

import type { Bindings } from "../../src/shared/bindings";
import {
  EVIDENCE_PREVIEW_MAX_INGRESS_BYTES,
  EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER,
  EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER,
} from "../../src/evidence/contracts";
import {
  EVIDENCE_PREVIEW_COOKIE,
  EVIDENCE_PREVIEW_MAX_BODY_BYTES,
  EVIDENCE_PREVIEW_MAX_HEADER_BYTES,
  EVIDENCE_PREVIEW_MAX_URL_BYTES,
  handleEvidencePreviewRequest,
  parseEvidencePreviewHost,
  sanitizeEvidencePreviewRequest,
  sanitizeEvidencePreviewResponse,
} from "../../src/evidence/preview";
import { workerFetch } from "../../src/index";

const BASE = "preview.example.test";
const SESSION_ID = "a0b1c2d3e4f5";
const ROUTE_NONCE = "0123456789abcdef";
const COOKIE_SECRET = "a".repeat(64);
const HOST = `4173-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`;
const futurePermitExpiry = (): string => {
  // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: this ordinary Vitest suite drives the native Worker wall-clock ingress adapter
  const expiresAt = Date.now() + 30_000;
  return new Date(expiresAt).toISOString();
};
const env = {
  SANDBOX: {} as DurableObjectNamespace<import("../../src/session/object").Sandbox>,
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
    );

    for (const request of requests) {
      const response = await handleEvidencePreviewRequest(request, env);
      expect(response?.status, request.method).toBe(404);
    }
    for (const request of [
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
    ]) {
      expect(await sanitizeEvidencePreviewRequest(request)).toBeUndefined();
    }
    expect(admit).not.toHaveBeenCalled();
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
    admit.mockResolvedValue({
      requestId: "1".repeat(32),
      expiresAt: futurePermitExpiry(),
    });
    adjust.mockResolvedValue(true);
    cancel.mockResolvedValue(undefined);
    expire.mockResolvedValue(undefined);
    proxy.mockImplementation(async (request: Request) => {
      expect(request.headers.get("cookie")).toBe("app=kept");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER)).toBe("1".repeat(32));
      return new Response("proxied app", {
        headers: {
          "set-cookie": "app-session=value; Secure; Path=/",
          [EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER]: "1".repeat(32),
        },
      });
    });
  });

  it("admits in the owning DO before delegating transport to proxyToSandbox", async () => {
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
    expect(admit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      port: 4_173,
      routeNonce: ROUTE_NONCE,
      cookieSecret: COOKIE_SECRET,
      ingressBytes: EVIDENCE_PREVIEW_MAX_INGRESS_BYTES,
    });
    expect(adjust).toHaveBeenCalledWith("1".repeat(32), 0);
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(response?.headers.get(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER)).toBeNull();
  });

  it("persists conservative admission before reading ingress, then adjusts at EOF", async () => {
    const events: string[] = [];
    admit.mockImplementationOnce(async (input: { readonly ingressBytes: number }) => {
      events.push("admit");
      expect(input.ingressBytes).toBe(EVIDENCE_PREVIEW_MAX_INGRESS_BYTES);
      return {
        requestId: "1".repeat(32),
        expiresAt: futurePermitExpiry(),
      };
    });
    adjust.mockImplementationOnce(async () => {
      events.push("adjust");
      return true;
    });
    proxy.mockImplementationOnce(async () => {
      events.push("proxy");
      return new Response("ok", {
        headers: { [EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER]: "1".repeat(32) },
      });
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          events.push("body:pull");
          controller.enqueue(Uint8Array.of(1, 2, 3));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const ingressRequest = new Request(`https://${HOST}/`, {
      method: "POST",
      headers: {
        cookie: `app=kept; ${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}`,
      },
    });
    Object.defineProperty(ingressRequest, "body", { value: body });
    const response = await handleEvidencePreviewRequest(ingressRequest, env);
    expect(response?.status).toBe(200);
    expect(events).toEqual(["admit", "body:pull", "adjust", "proxy"]);
    expect(adjust).toHaveBeenCalledWith("1".repeat(32), 3);
  });

  it("expires stalled ingress under its persisted permit instead of reading outside authority", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-08-07T12:00:00.000Z");
      vi.setSystemTime(now);
      admit.mockResolvedValueOnce({
        requestId: "3".repeat(32),
        expiresAt: new Date(now + 30_000).toISOString(),
      });
      const body = new ReadableStream<Uint8Array>(
        { pull: () => new Promise<void>(() => undefined) },
        { highWaterMark: 0 },
      );
      const ingressRequest = new Request(`https://${HOST}/`, {
        method: "POST",
        headers: { cookie: `${EVIDENCE_PREVIEW_COOKIE}=${COOKIE_SECRET}` },
      });
      Object.defineProperty(ingressRequest, "body", { value: body });
      const pending = handleEvidencePreviewRequest(ingressRequest, env);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending)?.status).toBe(404);
      expect(expire).toHaveBeenCalledWith("3".repeat(32));
      expect(adjust).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(proxy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies failed admission and synthetic unclaimed proxy failures", async () => {
    admit.mockResolvedValueOnce(undefined);
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

    admit.mockResolvedValueOnce({
      requestId: "2".repeat(32),
      expiresAt: futurePermitExpiry(),
    });
    proxy.mockResolvedValueOnce(new Response("Proxy routing error", { status: 500 }));
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
    expect(cancel).toHaveBeenCalledWith("2".repeat(32));
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
    expect(admit).not.toHaveBeenCalled();
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
    expect(admit).not.toHaveBeenCalled();
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
    expect(admit).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });

  it("preserves ordinary static assets when every request runs the Worker first", async () => {
    const assets = vi.fn(async () => new Response("asset", { headers: { "x-source": "assets" } }));
    const assetFetcher: Fetcher = {
      fetch: assets,
      connect() {
        throw new Error("ASSETS.connect is not used by this test");
      },
    };
    const response = await workerFetch(
      new Request("https://control.example.test/app.js"),
      { ...env, ASSETS: assetFetcher },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-source")).toBe("assets");
    expect(await response.text()).toBe("asset");
    expect(assets).toHaveBeenCalledOnce();
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
