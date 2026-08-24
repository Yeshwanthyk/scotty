import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adjust = vi.hoisted(() => vi.fn());
const admit = vi.hoisted(() => vi.fn());
const admitWebSocket = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const cancelWebSocket = vi.hoisted(() => vi.fn());
const getRoute = vi.hoisted(() => vi.fn());
const issuePermit = vi.hoisted(() => vi.fn());
const proxy = vi.hoisted(() => vi.fn());
const consumeHandoff = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => ({
    adjustScottyHatchRequest: adjust,
    admitScottyHatchRequest: admit,
    admitScottyHatchWebSocket: admitWebSocket,
    cancelScottyHatchRequest: cancel,
    cancelScottyHatchWebSocket: cancelWebSocket,
    getScottyHatchRoute: getRoute,
    issueScottyHatchPermit: issuePermit,
  })),
  proxyToSandbox: proxy,
}));

import type { ScottyAuthRegistryStub } from "../src/auth-object";
import {
  HATCH_COOKIE,
  HATCH_HANDOFF_PATH,
  HATCH_MAX_INGRESS_BYTES,
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER,
  HATCH_PRIVATE_WEBSOCKET_HEADER,
} from "../src/hatch-contracts";
import { handleHatchRequest, hatchPreviewFormAction, parseHatchHost } from "../src/hatch-gateway";

const BASE = "preview.example.test";
const SESSION_ID = "a0b1c2d3e4f5";
const ROUTE_NONCE = "h0123456789abcd";
const HOST = `4173-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`;
const COOKIE_SECRET = "a".repeat(64);
const future = (): string => {
  // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: ordinary Vitest drives the native gateway wall clock
  return new Date(Date.now() + 30_000).toISOString();
};
const authStub = {
  acceptOwnerTransfer: vi.fn(),
  authenticate: vi.fn(),
  authenticateRoot: vi.fn(),
  initializeRoot: vi.fn(),
  cancelOwnerTransfer: vi.fn(),
  consumeHatchHandoff: consumeHandoff,
  consumePairing: vi.fn(),
  consumeRecoveryGrant: vi.fn(),
  currentOwnerTransfer: vi.fn(),
  issueHatchHandoff: vi.fn(),
  issuePairing: vi.fn(),
  issueRecoveryGrant: vi.fn(),
  listClients: vi.fn(),
  logoutClient: vi.fn(),
  revokeClient: vi.fn(),
  rotateRoot: vi.fn(),
  startOwnerTransfer: vi.fn(),
} as ScottyAuthRegistryStub;
const env = {
  SANDBOX: {} as DurableObjectNamespace<import("../src/session").Sandbox>,
  SCOTTY_PREVIEW_BASE: BASE,
  AUTH: { getByName: () => authStub },
};

const installUpgradeResponse = (): (() => void) => {
  const NativeResponse = globalThis.Response;
  class UpgradeResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const status = init?.status;
      super(body, status === 101 ? { ...init, status: 200 } : init);
      if (status === 101) Object.defineProperty(this, "status", { value: 101 });
      Object.defineProperty(this, "webSocket", {
        configurable: true,
        value: init === undefined ? null : (Reflect.get(init, "webSocket") ?? null),
      });
    }
  }
  vi.stubGlobal("Response", UpgradeResponse);
  return () => vi.stubGlobal("Response", NativeResponse);
};

const upgradeResponse = (
  socket: { readonly close: (code: number, reason: string) => void },
  headers: HeadersInit,
): Response => {
  const response = new Response(null, { headers });
  Object.defineProperty(response, "status", { value: 101 });
  Object.defineProperty(response, "webSocket", { value: socket });
  return response;
};

describe("Hatch exact-host gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    getRoute.mockResolvedValue({
      sessionId: SESSION_ID,
      hatchId: "hatch-primary",
      generation: 1,
      port: 4_173,
      routeNonce: ROUTE_NONCE,
      runtimeEpoch: "epoch-current",
    });
    consumeHandoff.mockResolvedValue({
      ok: true,
      value: {
        browserClientId: "111111111111",
        sessionId: SESSION_ID,
        hatchId: "hatch-primary",
      },
    });
    issuePermit.mockResolvedValue({ expiresAt: future() });
    admit.mockResolvedValue({ requestId: "1".repeat(32), expiresAt: future() });
    admitWebSocket.mockResolvedValue({
      socketId: "2".repeat(32),
      generation: 1,
      runtimeEpoch: "epoch-current",
      expiresAt: future(),
    });
    adjust.mockResolvedValue(true);
    cancel.mockResolvedValue(undefined);
    cancelWebSocket.mockResolvedValue(undefined);
    proxy.mockImplementation(async (request: Request) => {
      expect(request.headers.get(HATCH_PRIVATE_REQUEST_HEADER)).toBe("1".repeat(32));
      expect(request.headers.get("cookie")).toBe("app=kept");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-real-ip")).toBeNull();
      return new Response("app", {
        headers: {
          [HATCH_PRIVATE_CLAIMED_HEADER]: "1".repeat(32),
          "set-cookie": "app-session=ok; Secure; Path=/",
        },
      });
    });
  });

  it("bounds the session-shell form action to a validated Hatch preview base", () => {
    expect(hatchPreviewFormAction(BASE)).toBe("https://*.preview.example.test");
    expect(hatchPreviewFormAction(undefined)).toBe("'none'");
    expect(hatchPreviewFormAction("preview.example.test; form-action *")).toBe("'none'");
  });

  it("parses only the Hatch-prefixed canonical SDK host and leaves evidence isolated", () => {
    expect(parseHatchHost(HOST, BASE)).toEqual({
      kind: "hatch",
      route: { port: 4_173, sessionId: SESSION_ID, routeNonce: ROUTE_NONCE },
    });
    expect(parseHatchHost(`4173-${SESSION_ID}-0123456789abcdef.${BASE}`, BASE)).toEqual({
      kind: "not_hatch",
    });
    expect(parseHatchHost(`4173-${SESSION_ID}-h_0123456789abcd.${BASE}`, BASE)).toEqual({
      kind: "hatch",
      route: { port: 4_173, sessionId: SESSION_ID, routeNonce: "h_0123456789abcd" },
    });
    for (const host of [HOST.toUpperCase(), `3000-${SESSION_ID}-${ROUTE_NONCE}.${BASE}`, BASE]) {
      expect(parseHatchHost(host, BASE).kind).toBe("invalid_hatch");
    }
  });

  it("consumes a one-use form handoff and installs an exact-host cookie usable by its redirect", async () => {
    const response = await handleHatchRequest(
      new Request(`https://${HOST}${HATCH_HANDOFF_PATH}`, {
        method: "POST",
        headers: {
          host: HOST,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "handoff=scotty_hatch.bbbbbbbbbbbb.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
      }),
      env,
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/");
    const cookie = response?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${HATCH_COOKIE}=`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("scotty_hatch.");
    expect(consumeHandoff).toHaveBeenCalledWith(
      "scotty_hatch.bbbbbbbbbbbb.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
      SESSION_ID,
      "hatch-primary",
    );
    expect(issuePermit).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, port: 4_173, routeNonce: ROUTE_NONCE },
      "111111111111",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  it("admits bounded HTTP, strips control authority, and rejects WebSocket framing", async () => {
    const response = await handleHatchRequest(
      new Request(`https://${HOST}/dashboard`, {
        headers: {
          host: HOST,
          authorization: "Bearer never-forward",
          "x-real-ip": "203.0.113.7",
          cookie: `app=kept; __Host-scotty=control; ${HATCH_COOKIE}=${COOKIE_SECRET}`,
        },
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("app");
    expect(admit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      port: 4_173,
      routeNonce: ROUTE_NONCE,
      cookieSecret: COOKIE_SECRET,
      ingressBytes: HATCH_MAX_INGRESS_BYTES,
    });
    expect(adjust).toHaveBeenCalledWith("1".repeat(32), 0);
    expect(response?.headers.get(HATCH_PRIVATE_CLAIMED_HEADER)).toBeNull();
    expect(response?.headers.getSetCookie()).toEqual(["app-session=ok; Secure; Path=/"]);

    const websocket = await handleHatchRequest(
      new Request(`https://${HOST}/`, {
        headers: {
          cookie: `${HATCH_COOKIE}=${COOKIE_SECRET}`,
          connection: "Upgrade",
          upgrade: "websocket",
        },
      }),
      env,
    );
    expect(websocket?.status).toBe(404);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("admits only same-origin authenticated WebSockets and preserves only the selected protocol", async () => {
    const restoreResponse = installUpgradeResponse();
    const socket = { close: vi.fn() };
    proxy.mockImplementationOnce(async (request: Request) => {
      expect(request.headers.get(HATCH_PRIVATE_WEBSOCKET_HEADER)).toBe("2".repeat(32));
      expect(request.headers.get("origin")).toBe(`https://${HOST}`);
      expect(request.headers.get("cookie")).toBe("app=kept");
      expect(request.headers.get("sec-websocket-protocol")).toBe("vite-hmr, app-v1");
      return upgradeResponse(socket, {
        [HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER]: "2".repeat(32),
        "sec-websocket-protocol": "vite-hmr",
        "x-upstream-secret": "drop",
      });
    });
    const response = await handleHatchRequest(
      new Request(`https://${HOST}/hmr`, {
        headers: {
          host: HOST,
          origin: `https://${HOST}`,
          cookie: `app=kept; ${HATCH_COOKIE}=${COOKIE_SECRET}`,
          connection: "keep-alive, Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": "vite-hmr, app-v1",
        },
      }),
      env,
    );
    expect(response?.status).toBe(101);
    expect(response?.webSocket).toBe(socket);
    expect(response?.headers.get("sec-websocket-protocol")).toBe("vite-hmr");
    expect(response?.headers.get("x-upstream-secret")).toBeNull();
    expect(admitWebSocket).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      port: 4_173,
      routeNonce: ROUTE_NONCE,
      host: HOST,
      origin: `https://${HOST}`,
      cookieSecret: COOKIE_SECRET,
    });

    const denied = await handleHatchRequest(
      new Request(`https://${HOST}/hmr`, {
        headers: {
          host: HOST,
          origin: "https://attacker.example",
          cookie: `${HATCH_COOKIE}=${COOKIE_SECRET}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      }),
      env,
    );
    expect(denied?.status).toBe(404);
    expect(admitWebSocket).toHaveBeenCalledTimes(1);
    restoreResponse();
  });

  it("fails closed when a WebSocket response selects an unoffered protocol", async () => {
    const restoreResponse = installUpgradeResponse();
    const socket = { close: vi.fn() };
    proxy.mockResolvedValueOnce(
      upgradeResponse(socket, {
        [HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER]: "2".repeat(32),
        "sec-websocket-protocol": "admin",
      }),
    );
    const response = await handleHatchRequest(
      new Request(`https://${HOST}/hmr`, {
        headers: {
          host: HOST,
          origin: `https://${HOST}`,
          cookie: `${HATCH_COOKIE}=${COOKIE_SECRET}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": "vite-hmr",
        },
      }),
      env,
    );
    expect(response?.status).toBe(404);
    expect(cancelWebSocket).toHaveBeenCalledWith("2".repeat(32));
    restoreResponse();
  });

  it("rewrites loopback redirects and rejects application Domain cookies", async () => {
    proxy.mockImplementationOnce(async () => {
      const headers = new Headers({
        [HATCH_PRIVATE_CLAIMED_HEADER]: "1".repeat(32),
        location: "http://127.0.0.1:4173/login?next=%2F",
      });
      headers.append("set-cookie", "host-only=kept; Secure; Path=/");
      headers.append("set-cookie", `cross-host=dropped; Domain=${BASE}; Secure; Path=/`);
      return new Response(null, { status: 302, headers });
    });
    const response = await handleHatchRequest(
      new Request(`https://${HOST}/private`, {
        headers: { cookie: `${HATCH_COOKIE}=${COOKIE_SECRET}` },
      }),
      env,
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(`https://${HOST}/login?next=%2F`);
    expect(response?.headers.getSetCookie()).toEqual(["host-only=kept; Secure; Path=/"]);
  });

  it("fails closed when proxy transport does not prove the owning DO claimed the request", async () => {
    proxy.mockResolvedValueOnce(new Response("synthetic failure", { status: 500 }));
    const response = await handleHatchRequest(
      new Request(`https://${HOST}/`, {
        headers: { cookie: `${HATCH_COOKIE}=${COOKIE_SECRET}` },
      }),
      env,
    );
    expect(response?.status).toBe(404);
    expect(cancel).toHaveBeenCalledWith("1".repeat(32));
  });
});
