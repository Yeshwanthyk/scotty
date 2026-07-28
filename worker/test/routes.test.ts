import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  createScottySession: vi.fn(),
  getScottySession: vi.fn(),
  snapshotScottySession: vi.fn(),
  sleepScottySession: vi.fn(),
  resumeScottySession: vi.fn(),
  prepareDownArchive: vi.fn(),
  readScottyArchiveStream: vi.fn(),
  getSession: vi.fn(),
  vaporizeScottySession: vi.fn(),
  fetch: vi.fn(),
  fetchPican: vi.fn(),
}));

const sandboxTarget = vi.hoisted((): { current: unknown } => ({
  current: sandbox,
}));

const auth = vi.hoisted(() => ({
  acceptOwnerTransfer: vi.fn(),
  authenticate: vi.fn(),
  cancelOwnerTransfer: vi.fn(),
  consumePairing: vi.fn(),
  consumeRecoveryGrant: vi.fn(),
  currentOwnerTransfer: vi.fn(),
  issuePairing: vi.fn(),
  issueRecoveryGrant: vi.fn(),
  listClients: vi.fn(),
  logoutClient: vi.fn(),
  revokeClient: vi.fn(),
  startOwnerTransfer: vi.fn(),
}));

const runner = vi.hoisted(() => ({
  control: vi.fn(),
  controlStatus: vi.fn(),
  fetch: vi.fn(),
  getByName: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => sandboxTarget.current),
}));

import app from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  createSessionHarness,
  makeResumeBackup,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
  type SessionHarness,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const TOKEN = "worker-test-token-1234567890";
const DISCORD_TOKEN = "discord-test-token-1234567890";
const CLIENT_CREDENTIAL = "scotty_client.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REGISTERED_CLIENT = {
  id: "111111111111",
  label: "Trusted browser",
  scopes: ["sessions:read", "sessions:write", "access:read", "access:write"],
  role: "owner",
  createdAt: "2026-07-22T12:00:00.000Z",
  expiresAt: "2026-08-21T12:00:00.000Z",
  lastSeenAt: "2026-07-22T12:00:00.000Z",
  current: true,
};

function authNamespace(): import("../src/auth-object").ScottyAuthRegistryNamespace {
  return { getByName: () => auth };
}

function emptySessionsNamespace(): KVNamespace {
  return {
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    get: async (name: string | string[]) =>
      Array.isArray(name) ? new Map(name.map((key) => [key, null])) : null,
    getWithMetadata: async (name: string | string[]) => {
      const missing = { value: null, metadata: null, cacheStatus: null };
      return Array.isArray(name) ? new Map(name.map((key) => [key, missing])) : missing;
    },
    put: async (_name: string, _value: string | ArrayBuffer | ArrayBufferView | ReadableStream) =>
      undefined,
    delete: async (_name: string) => undefined,
  } as KVNamespace;
}

function env(): Bindings {
  const assets: Fetcher = {
    fetch: async () =>
      new Response("<!doctype html><title>Scotty</title>", {
        headers: { "content-type": "text/html" },
      }),
    connect: () => {
      throw new Error("ASSETS.connect isn't used by route tests");
    },
  };
  return {
    SCOTTY_DISCORD_TOKEN: DISCORD_TOKEN,
    SCOTTY_TOKEN: TOKEN,
    SCOTTY_RUNNER_NAME: "slumbers",
    SCOTTY_RUNNER_TOKEN: "runner-test-token",
    CODEX_AUTH_JSON: "{}",
    GH_TOKEN: "github-test-sentinel",
    ASSETS: assets,
    AUTH: authNamespace(),
    RUNNERS: { getByName: runner.getByName },
    SANDBOX: {} as DurableObjectNamespace<import("../src/session").Sandbox>,
    SESSIONS: emptySessionsNamespace(),
    BACKUP_BUCKET: {} as R2Bucket,
  };
}

function useRealSandbox(harness: SessionHarness): void {
  sandboxTarget.current = harness.sandbox;
}

const projection = {
  version: 1,
  id: "a0b1c2d3e4f5",
  status: "failed",
  provider: "cloudflare",
  repo: "owner/repo",
  defaultBranch: "main",
  branch: "scotty/a0b1c2d3e4f5",
  backupId: "backup-1",
  codexThreadId: "thread-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  projectedAt: "2026-01-01T00:01:00.000Z",
  failure: { code: "backup_failed", message: "Backup failed", recoverable: true },
  secret: "must-not-survive",
};

describe("real Hono boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxTarget.current = sandbox;
    sandbox.fetch.mockResolvedValue(new Response("<!doctype html><title>Pican</title>"));
    auth.authenticate.mockResolvedValue({
      ok: true,
      value: {
        client: REGISTERED_CLIENT,
        renewed: false,
      },
    });
    runner.getByName.mockReturnValue({
      control: runner.control,
      controlStatus: runner.controlStatus,
      fetch: runner.fetch,
    });
    runner.control.mockResolvedValue(undefined);
    runner.controlStatus.mockResolvedValue({
      desired: "accepting",
      connection: "connected",
      lastSeenAt: "2026-07-27T12:00:00.000Z",
    });
    runner.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("accepts only the configured authenticated runner and strips its credential", async () => {
    runner.fetch.mockImplementation(async (request: Request) => {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("user-agent")).toBeNull();
      expect(request.headers.get("upgrade")).toBe("websocket");
      return new Response(null, { status: 204 });
    });

    const response = await app.request(
      "/api/runners/slumbers/connect",
      {
        headers: {
          authorization: "Bearer runner-test-token",
          cookie: "scotty_client=must-not-forward",
          "user-agent": "browser-metadata",
          upgrade: "websocket",
        },
      },
      env(),
    );

    expect(response.status).toBe(204);
    expect(runner.getByName).toHaveBeenCalledWith("slumbers");
    expect(runner.fetch).toHaveBeenCalledTimes(1);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("rejects unconfigured, unauthenticated, and non-upgrade runner requests before the DO", async () => {
    const requests = [
      app.request(
        "/api/runners/other/connect",
        {
          headers: {
            authorization: "Bearer runner-test-token",
            upgrade: "websocket",
          },
        },
        env(),
      ),
      app.request("/api/runners/slumbers/connect", { headers: { upgrade: "websocket" } }, env()),
      app.request(
        "/api/runners/slumbers/connect",
        {
          headers: {
            authorization: "Bearer wrong-runner-token",
            upgrade: "websocket",
          },
        },
        env(),
      ),
      app.request(
        "/api/runners/slumbers/connect",
        { headers: { authorization: "Bearer runner-test-token" } },
        env(),
      ),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map(({ status }) => status)).toEqual([404, 401, 401, 426]);
    expect(runner.fetch).not.toHaveBeenCalled();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated API requests before touching bindings", async () => {
    const response = await app.request("/api/sessions", undefined, env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth",
        message: "Authentication required",
        hint: "Open a fresh pairing or recovery link, or configure the CLI root token.",
      },
    });
  });

  it("keeps the Discord bridge behind its separate credential", async () => {
    const missing = await app.request("/api/discord/sessions", undefined, env());
    const root = await app.request(
      "/api/discord/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );

    expect([missing.status, root.status]).toEqual([401, 401]);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("lists only warm sessions through the Discord bridge", async () => {
    const warm = {
      ...projection,
      id: "b0b1c2d3e4f5",
      status: "warm",
    };
    const sessions = {
      list: async () => ({
        keys: [{ name: `session:${warm.id}` }, { name: `session:${projection.id}` }],
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (name: string) =>
        name === `session:${warm.id}`
          ? warm
          : name === `session:${projection.id}`
            ? projection
            : null,
    } as KVNamespace;

    const response = await app.request(
      "/api/discord/sessions",
      { headers: { authorization: `Bearer ${DISCORD_TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          id: warm.id,
          repo: warm.repo,
          branch: warm.branch,
          updatedAt: warm.updatedAt,
        },
      ],
    });
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("returns a normalized Pican transcript through the Discord bridge", async () => {
    sandbox.getScottySession.mockResolvedValue({
      ...projection,
      status: "warm",
      failure: undefined,
      ageSeconds: 60,
      capRemainingSeconds: 13_000,
    });
    sandbox.fetch.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/sessions"))
        return Response.json({
          sessions: [{ ID: "codex-session.jsonl", nativeId: projection.codexThreadId }],
        });
      if (url.pathname.endsWith("/api/session"))
        return Response.json({
          entries: [
            {
              id: "message-1",
              type: "message",
              message: { role: "user", content: "Ship it" },
            },
            {
              id: "message-2",
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Done." }],
              },
            },
            {
              id: "tool-1",
              type: "message",
              message: { role: "toolResult", content: "hidden" },
            },
          ],
        });
      if (url.pathname.endsWith("/api/worker-status")) return Response.json({ state: "idle" });
      return new Response(null, { status: 404 });
    });

    const response = await app.request(
      `/api/discord/sessions/${projection.id}`,
      { headers: { authorization: `Bearer ${DISCORD_TOKEN}` } },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: projection.id,
        repo: projection.repo,
        branch: projection.branch,
        url: `http://localhost/s/${projection.id}`,
      },
      running: false,
      messages: [
        { id: "message-1", role: "user", text: "Ship it" },
        { id: "message-2", role: "assistant", text: "Done." },
      ],
    });

    const status = await app.request(
      `/api/discord/sessions/${projection.id}/status`,
      { headers: { authorization: `Bearer ${DISCORD_TOKEN}` } },
      env(),
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ running: false });
  });

  it("sends a Discord message to the matching Pican session", async () => {
    const chatRequests: Request[] = [];
    sandbox.getScottySession.mockResolvedValue({
      ...projection,
      status: "warm",
      failure: undefined,
      ageSeconds: 60,
      capRemainingSeconds: 13_000,
    });
    sandbox.fetch.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/sessions"))
        return Response.json({
          sessions: [{ ID: "codex-session.jsonl", nativeId: projection.codexThreadId }],
        });
      if (url.pathname.endsWith("/api/worker-status")) return Response.json({ state: "idle" });
      if (url.pathname.endsWith("/api/chat")) {
        chatRequests.push(request);
        return Response.json({ accepted: true });
      }
      return new Response(null, { status: 404 });
    });

    const response = await app.request(
      `/api/discord/sessions/${projection.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${DISCORD_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: " continue from Discord " }),
      },
      env(),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0]?.method).toBe("POST");
    const body = await chatRequests[0]?.formData();
    expect(body?.get("message")).toBe("continue from Discord");
  });

  it("reports providers separately from dynamically named runners", async () => {
    const providers = await app.request(
      "/api/providers",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(providers.status).toBe(200);
    await expect(providers.json()).resolves.toEqual([
      { name: "cloudflare", status: "configured" },
      { name: "runner", status: "available" },
    ]);

    const runners = await app.request(
      "/api/runners",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(runners.status).toBe(200);
    await expect(runners.json()).resolves.toEqual([
      {
        name: "slumbers",
        desired: "accepting",
        connection: "connected",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
        assignedSessions: 0,
      },
    ]);

    const assignedProjection = {
      version: 1,
      id: "b0b1c2d3e4f5",
      status: "failed",
      provider: "runner",
      runner: "slumbers",
      repo: "owner/repo",
      defaultBranch: "main",
      branch: "scotty/b0b1c2d3e4f5",
      codexThreadId: "thread-2",
      createdAt: "2026-07-27T11:00:00.000Z",
      updatedAt: "2026-07-27T12:00:00.000Z",
      hardCapAt: "2026-07-27T16:00:00.000Z",
      projectedAt: "2026-07-27T12:00:00.000Z",
      failure: {
        code: "resume_failed",
        message: "Session restore failed",
        recoverable: true,
      },
    };
    const sessions = {
      list: async () => ({
        keys: [{ name: `session:${assignedProjection.id}` }],
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (_name: string) => assignedProjection,
    } as KVNamespace;
    const assigned = await app.request(
      "/api/runners",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    await expect(assigned.json()).resolves.toEqual([
      expect.objectContaining({ name: "slumbers", assignedSessions: 1 }),
    ]);

    runner.controlStatus.mockResolvedValueOnce({
      desired: "draining",
      connection: "connected",
      lastSeenAt: "2026-07-27T12:00:00.000Z",
    });
    const unavailable = await app.request(
      "/api/providers",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    await expect(unavailable.json()).resolves.toEqual([
      { name: "cloudflare", status: "configured" },
      { name: "runner", status: "unavailable" },
    ]);
  });

  it("allows only the owner browser to control the configured runner", async () => {
    for (const action of ["enable", "drain", "disable", "disconnect"]) {
      const response = await app.request(
        `/api/runners/slumbers/${action}`,
        {
          method: "POST",
          headers: {
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            origin: "http://localhost",
            "sec-fetch-site": "same-origin",
          },
        },
        env(),
      );
      expect(response.status).toBe(200);
    }
    expect(runner.control.mock.calls.map(([action]) => action)).toEqual([
      "enable",
      "drain",
      "disable",
      "disconnect",
    ]);

    auth.authenticate.mockResolvedValueOnce({
      ok: true,
      value: {
        client: { ...REGISTERED_CLIENT, role: "standard" },
        renewed: false,
      },
    });
    const standard = await app.request(
      "/api/runners/slumbers/drain",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(standard.status).toBe(401);

    const unknownRunner = await app.request(
      "/api/runners/helium/drain",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(unknownRunner.status).toBe(404);

    const unknownAction = await app.request(
      "/api/runners/slumbers/restart",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
      },
      env(),
    );
    expect(unknownAction.status).toBe(404);
    expect(runner.control).toHaveBeenCalledTimes(4);
  });

  it("preserves the create status, output shape, and ignored legacy cap", async () => {
    const harness = await createSessionHarness();
    useRealSandbox(harness);
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          prompt: " ship it ",
          provider: "cloudflare",
          repo: "owner/project",
          cap: "90m",
        }),
      },
      env(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
      throw new TypeError("Expected create response object");
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}$/u),
      url: expect.stringMatching(/^http:\/\/localhost\/s\/[0-9a-f]{12}$/u),
      branch: `scotty/${body.id}`,
      provider: "cloudflare",
      status: "warm",
    });
    expect(harness.readRecord()).toMatchObject({
      id: body.id,
      branch: `scotty/${body.id}`,
      provider: "cloudflare",
      repo: "owner/project",
      defaultBranch: "main",
      status: "warm",
      operation: null,
      hardCapDurationSeconds: 14_400,
    });
    expect(harness.events).toEqual(
      expect.arrayContaining([
        "record:booting",
        "projection:booting",
        "schedule:enforceHardCap",
        "host:exec:workspace",
        "host:pican:start",
        "host:pican:ready",
        "host:pican:fetch:31415",
        "record:warm",
        "projection:warm",
      ]),
    );
  });

  it("maps repeated create keys to one Sandbox identity", async () => {
    const harness = await createSessionHarness();
    useRealSandbox(harness);
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "01234567-89ab-4cde-8fab-0123456789ab",
      },
      body: JSON.stringify({
        prompt: "ship it",
        provider: "cloudflare",
        repo: "owner/project",
      }),
    };
    const first = await app.request("/api/sessions", request, env());
    const second = await app.request("/api/sessions", request, env());
    const firstBody = await first.json();
    const secondBody = await second.json();
    if (
      !firstBody ||
      typeof firstBody !== "object" ||
      !("id" in firstBody) ||
      typeof firstBody.id !== "string"
    )
      throw new TypeError("Expected idempotent create response object");
    expect(firstBody).toEqual(secondBody);
    expect(firstBody).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{12}$/u),
      provider: "cloudflare",
      status: "warm",
    });
    expect(harness.read(sessionHarnessKeys.createIdempotency)).toEqual({
      keyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(harness.events.filter((event) => event === "host:pican:start")).toHaveLength(1);
    expect(harness.picanRequests).toHaveLength(1);
  });

  it("tracks the returned repository without making KV authoritative for create", async () => {
    const trackedHarness = await createSessionHarness();
    useRealSandbox(trackedHarness);
    const put = vi.fn(async () => undefined);
    const tracked = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/repo",
        }),
      },
      { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
    );
    expect(tracked.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      "repo:owner/repo",
      expect.stringContaining('"repo":"owner/repo","defaultBranch":"main","lastUsedAt":'),
    );

    put.mockRejectedValueOnce("KV unavailable");
    const unavailableHarness = await createSessionHarness();
    useRealSandbox(unavailableHarness);
    const unavailable = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/repo",
        }),
      },
      { ...env(), SESSIONS: Object.assign(env().SESSIONS, { put }) },
    );
    expect(unavailable.status).toBe(200);
  });

  it("rejects malformed create idempotency keys before touching a Sandbox", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "short",
        },
        body: JSON.stringify({ prompt: "ship it", repo: "owner/project" }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    expect(sandbox.createScottySession).not.toHaveBeenCalled();
  });

  it("preserves exact malformed create error envelopes", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      },
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "Request body must be valid JSON" },
    });
  });

  it("rejects unsupported providers at the HTTP boundary", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "ship it", provider: "box", repo: "owner/project" }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "provider must be cloudflare or runner" },
    });
    expect(sandbox.createScottySession).not.toHaveBeenCalled();
  });

  it("does not expose a source-control publishing route", async () => {
    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pr",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      },
      env(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  it("preserves beam-down streaming status, headers, and filename", async () => {
    sandbox.prepareDownArchive.mockResolvedValue({
      path: "/tmp/scotty-a0b1c2d3e4f5.tar",
      filename: "scotty-a0b1c2d3e4f5.tar",
      manifest: {},
    });
    sandbox.readScottyArchiveStream.mockResolvedValue(new Blob(["archive"]).stream());
    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/down",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="scotty-a0b1c2d3e4f5.tar"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("archive");
  });

  it("preserves 200 pass-through output for ordinary session command routes", async () => {
    const cases = [
      {
        method: "GET",
        path: "/api/sessions/a0b1c2d3e4f5",
        mock: sandbox.getScottySession,
        output: { id: "a0b1c2d3e4f5", status: "warm", ageSeconds: 1 },
      },
      {
        method: "POST",
        path: "/api/sessions/a0b1c2d3e4f5/snapshot",
        mock: sandbox.snapshotScottySession,
        output: { id: "a0b1c2d3e4f5", status: "warm", backupId: "backup-1" },
      },
      {
        method: "POST",
        path: "/api/sessions/a0b1c2d3e4f5/sleep",
        mock: sandbox.sleepScottySession,
        output: { id: "a0b1c2d3e4f5", status: "sleeping", backupId: "backup-1" },
      },
    ] as const;
    for (const entry of cases) {
      entry.mock.mockResolvedValueOnce(entry.output);
      const response = await app.request(
        entry.path,
        { method: entry.method, headers: { authorization: `Bearer ${TOKEN}` } },
        env(),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(entry.output);
    }
  });

  it("resumes through real restore, credential, runtime, and state orchestration", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "sleeping",
          branch: `scotty/${SESSION_ID}`,
          backup: { current: makeResumeBackup() },
          ownedBackupIds: ["backup-1"],
          codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });
    useRealSandbox(harness);

    const response = await app.request(
      `/api/sessions/${SESSION_ID}/resume`,
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: SESSION_ID,
      status: "warm",
      branch: `scotty/${SESSION_ID}`,
      backupId: "backup-1",
    });
    expect(harness.readRecord()).toMatchObject({ status: "warm", operation: null });
    expect(harness.events).toEqual(
      expect.arrayContaining([
        "schedule:enforceHardCap",
        "host:restoreBackup",
        "host:mkdir",
        "host:pican:start",
        "host:pican:ready",
        "record:warm",
        "projection:warm",
      ]),
    );
  });

  it("vaporizes through real destruction, credential deletion, and authority transition", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          branch: `scotty/${SESSION_ID}`,
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });
    useRealSandbox(harness);

    const response = await app.request(
      `/api/sessions/${SESSION_ID}`,
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: SESSION_ID, status: "gone" });
    expect(harness.readRecord()).toMatchObject({
      id: SESSION_ID,
      status: "gone",
      operation: null,
      ownedBackupIds: [],
    });
    expect(harness.read(sessionHarnessKeys.credential)).toBeUndefined();
    expect(harness.events).toEqual(
      expect.arrayContaining([
        "schedule:retryVaporizeSession",
        "host:destroy",
        `storage:delete:${sessionHarnessKeys.credential}`,
        "record:gone",
        `projection:delete:session:${SESSION_ID}`,
      ]),
    );
  });

  it("lists only fully decoded KV projections and preserves valid optional fields", async () => {
    const values = new Map<string, unknown>([
      [`session:${projection.id}`, projection],
      ["session:malformed", { ...projection, id: "malformed", backupId: 123 }],
    ]);
    const sessions = {
      list: async () => ({
        keys: [{ name: `session:${projection.id}` }, { name: "session:malformed" }],
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (name: string) => values.get(name) ?? null,
    } as KVNamespace;
    const response = await app.request(
      "/api/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    if (!Array.isArray(body)) throw new TypeError("Expected session list array");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: projection.id,
      backupId: projection.backupId,
      codexThreadId: projection.codexThreadId,
      failure: projection.failure,
    });
    expect(body[0]).not.toHaveProperty("secret");
  });

  it("lists tracked repositories most-recent first without storage-only fields", async () => {
    const values = new Map<string, unknown>([
      [
        "repo:owner/older",
        {
          version: 1,
          repo: "owner/older",
          defaultBranch: "main",
          lastUsedAt: "2026-07-22T12:00:00.000Z",
          secret: "must-not-survive",
        },
      ],
      [
        "repo:owner/newer",
        {
          version: 1,
          repo: "owner/newer",
          defaultBranch: "dev",
          lastUsedAt: "2026-07-23T12:00:00.000Z",
        },
      ],
      [
        "repo:owner/malformed",
        {
          version: 1,
          repo: "owner/malformed",
          defaultBranch: 123,
          lastUsedAt: "2026-07-23T13:00:00.000Z",
        },
      ],
    ]);
    const sessions = {
      list: async () => ({
        keys: [...values.keys()].map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }),
      get: async (name: string) => values.get(name) ?? null,
    } as KVNamespace;

    const response = await app.request(
      "/api/repos",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        repo: "owner/newer",
        defaultBranch: "dev",
        lastUsedAt: "2026-07-23T12:00:00.000Z",
      },
      {
        repo: "owner/older",
        defaultBranch: "main",
        lastUsedAt: "2026-07-22T12:00:00.000Z",
      },
    ]);
  });

  it("preserves the generic internal response for provider-level KV list failure", async () => {
    const sessions = {
      list: async () => Promise.reject("list failed"),
    } as KVNamespace;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app.request(
      "/api/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { ...env(), SESSIONS: sessions },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal", message: "Internal error" },
    });
    expect(logged).toHaveBeenCalledWith("Projection failure", {
      tag: "SessionProjectionFailure",
      reason: "list",
    });
    logged.mockRestore();
  });

  it("consumes a same-origin one-time pairing link into a browser-specific cookie", async () => {
    const credential = "scotty_client.222222222222.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const client = {
      ...REGISTERED_CLIENT,
      id: "222222222222",
      label: "My phone",
      scopes: ["sessions:read", "sessions:write"],
    };
    auth.consumePairing.mockResolvedValue({
      ok: true,
      value: { credential, client },
    });
    const missingOrigin = await app.request(
      "/api/auth/pairings/consume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "one-time-ticket", label: "My phone" }),
      },
      env(),
    );
    expect(missingOrigin.status).toBe(400);
    expect(auth.consumePairing).not.toHaveBeenCalled();

    const response = await app.request(
      "/api/auth/pairings/consume",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "user-agent": "Phone browser",
        },
        body: JSON.stringify({ token: "one-time-ticket", label: "My phone" }),
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ client });
    expect(auth.consumePairing).toHaveBeenCalledWith(
      "one-time-ticket",
      "My phone",
      "Phone browser",
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__Host-scotty=${credential}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain(TOKEN);
  });

  it("issues recovery only from the root bearer and consumes it only from this origin", async () => {
    const recoveryCredential =
      "scotty_recovery.222222222222.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    auth.issueRecoveryGrant.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "222222222222",
        credential: recoveryCredential,
        expiresAt: "2026-07-22T12:05:00.000Z",
      },
    });
    const issued = await app.request(
      "/api/auth/recovery-grants",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "idempotency-key": "recovery-test-key-0001",
        },
      },
      env(),
    );
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const issuedBody = await issued.json();
    expect(issuedBody).toEqual({
      url: `http://localhost/recover#token=${recoveryCredential}`,
      expiresAt: "2026-07-22T12:05:00.000Z",
    });
    expect(auth.issueRecoveryGrant).toHaveBeenCalledWith(TOKEN, "recovery-test-key-0001");
    expect(JSON.stringify(issuedBody)).not.toContain(TOKEN);

    const deniedCookie = await app.request(
      "/api/auth/recovery-grants",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(deniedCookie.status).toBe(401);
    expect(auth.issueRecoveryGrant).toHaveBeenCalledTimes(1);

    const recoveredCredential =
      "scotty_client.333333333333.ccccccccccccccccccccccccccccccccccccccccccc";
    const recoveredClient = {
      ...REGISTERED_CLIENT,
      id: "333333333333",
      label: "Recovered browser",
    };
    auth.consumeRecoveryGrant.mockResolvedValueOnce({
      ok: true,
      value: { credential: recoveredCredential, client: recoveredClient },
    });
    const missingOrigin = await app.request(
      "/api/auth/recovery-grants/consume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: recoveryCredential }),
      },
      env(),
    );
    expect(missingOrigin.status).toBe(400);
    expect(missingOrigin.headers.get("cache-control")).toBe("no-store");
    expect(auth.consumeRecoveryGrant).not.toHaveBeenCalled();

    const consumed = await app.request(
      "/api/auth/recovery-grants/consume",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "user-agent": "Replacement browser",
        },
        body: JSON.stringify({ token: recoveryCredential }),
      },
      env(),
    );
    expect(consumed.status).toBe(200);
    expect(auth.consumeRecoveryGrant).toHaveBeenCalledWith(
      recoveryCredential,
      "Trusted browser",
      "Replacement browser",
    );
    expect(consumed.headers.get("set-cookie")).toContain(`__Host-scotty=${recoveredCredential}`);
    expect(consumed.headers.get("set-cookie")).not.toContain(TOKEN);
  });

  it("issues scannable pairing links and manages registered clients only for the owner", async () => {
    const pairingCredential =
      "scotty_pair.333333333333.ccccccccccccccccccccccccccccccccccccccccccc";
    auth.issuePairing.mockResolvedValue({
      ok: true,
      value: {
        id: "333333333333",
        credential: pairingCredential,
        expiresAt: "2026-07-22T12:05:00.000Z",
      },
    });
    const issued = await app.request(
      "/api/auth/pairings",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "Phone" }),
      },
      env(),
    );
    expect(issued.status).toBe(200);
    expect(auth.issuePairing).toHaveBeenCalledWith(CLIENT_CREDENTIAL, "Phone");
    const body = await issued.json();
    expect(body).toMatchObject({
      id: "333333333333",
      url: `http://localhost/pair#token=${pairingCredential}`,
      expiresAt: "2026-07-22T12:05:00.000Z",
      qr: { size: expect.any(Number), rows: expect.any(Array) },
    });
    if (!body || typeof body !== "object" || !("qr" in body))
      throw new TypeError("Expected pairing QR response");
    const qr = body.qr;
    if (
      !qr ||
      typeof qr !== "object" ||
      !("rows" in qr) ||
      !Array.isArray(qr.rows) ||
      !("size" in qr) ||
      typeof qr.size !== "number"
    )
      throw new TypeError("Expected pairing QR matrix");
    expect(qr.rows).toHaveLength(qr.size);

    auth.listClients.mockResolvedValue({ ok: true, value: [REGISTERED_CLIENT] });
    const listed = await app.request(
      "/api/auth/clients",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(listed.status).toBe(200);
    expect(auth.listClients).toHaveBeenCalledWith(CLIENT_CREDENTIAL);

    auth.revokeClient.mockResolvedValue({ ok: true, value: undefined });
    const revoked = await app.request(
      "/api/auth/clients/222222222222",
      {
        method: "DELETE",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
        },
      },
      env(),
    );
    expect(revoked.status).toBe(200);
    expect(auth.revokeClient).toHaveBeenCalledWith(CLIENT_CREDENTIAL, "222222222222");
  });

  it("does not let a standard paired browser manage owner control pages", async () => {
    const standard = {
      ...REGISTERED_CLIENT,
      scopes: ["sessions:read", "sessions:write"],
      role: "standard",
    };
    auth.authenticate.mockResolvedValue({
      ok: true,
      value: { client: standard, renewed: false },
    });
    const denied = await app.request(
      "/api/auth/clients",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(denied.status).toBe(401);
    expect(auth.listClients).not.toHaveBeenCalled();
    for (const path of ["/devices", "/providers"]) {
      const page = await app.request(
        path,
        { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
        env(),
      );
      expect(page.status, path).toBe(401);
    }
  });

  it("binds owner transfer issuance to the owner and acceptance to the target cookie", async () => {
    const transferCredential =
      "scotty_transfer.333333333333.ccccccccccccccccccccccccccccccccccccccccccc";
    auth.startOwnerTransfer.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "333333333333",
        credential: transferCredential,
        transfer: {
          id: "333333333333",
          sourceOwnerClientId: REGISTERED_CLIENT.id,
          targetClientId: "222222222222",
          ownerEpoch: 7,
          createdAt: "2026-07-22T12:00:00.000Z",
          expiresAt: "2026-07-22T12:05:00.000Z",
        },
      },
    });
    const started = await app.request(
      "/api/auth/owner-transfers",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
          "idempotency-key": "transfer-test-key-0001",
        },
        body: JSON.stringify({ targetClientId: "222222222222" }),
      },
      env(),
    );
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const startBody = await started.json();
    expect(startBody).toMatchObject({
      targetClientId: "222222222222",
      url: `http://localhost/owner-transfer#token=${transferCredential}`,
      qr: { size: expect.any(Number), rows: expect.any(Array) },
    });
    expect(auth.startOwnerTransfer).toHaveBeenCalledWith(
      CLIENT_CREDENTIAL,
      "222222222222",
      "transfer-test-key-0001",
    );

    const missingTargetCookie = await app.request(
      "/api/auth/owner-transfers/accept",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: transferCredential }),
      },
      env(),
    );
    expect(missingTargetCookie.status).toBe(401);
    await expect(missingTargetCookie.json()).resolves.toEqual({
      error: {
        code: "auth",
        message: "Owner transfer is invalid or expired",
      },
    });

    const rotatedCredential =
      "scotty_client.222222222222.ddddddddddddddddddddddddddddddddddddddddddd";
    const newOwner = {
      ...REGISTERED_CLIENT,
      id: "222222222222",
      label: "New laptop",
    };
    auth.acceptOwnerTransfer.mockResolvedValueOnce({
      ok: true,
      value: { credential: rotatedCredential, client: newOwner },
    });
    const accepted = await app.request(
      "/api/auth/owner-transfers/accept",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: transferCredential }),
      },
      env(),
    );
    expect(accepted.status).toBe(200);
    expect(auth.acceptOwnerTransfer).toHaveBeenCalledWith(CLIENT_CREDENTIAL, transferCredential);
    expect(accepted.headers.get("set-cookie")).toContain(`__Host-scotty=${rotatedCredential}`);
    expect(await accepted.clone().text()).not.toContain(transferCredential);
  });

  it("rejects every owner route for a standard client", async () => {
    auth.authenticate.mockResolvedValue({
      ok: true,
      value: {
        client: {
          ...REGISTERED_CLIENT,
          role: "standard",
          scopes: ["sessions:read", "sessions:write"],
        },
        renewed: false,
      },
    });
    const requests: ReadonlyArray<readonly [string, RequestInit]> = [
      ["/api/auth/clients", {}],
      ["/api/auth/owner-transfers/current", {}],
      [
        "/api/auth/pairings",
        {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: "{}",
        },
      ],
      [
        "/api/auth/owner-transfers",
        {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ targetClientId: "222222222222" }),
        },
      ],
      [
        "/api/auth/clients/222222222222",
        {
          method: "DELETE",
          headers: { origin: "http://localhost" },
        },
      ],
      [
        "/api/auth/owner-transfers/333333333333",
        {
          method: "DELETE",
          headers: { origin: "http://localhost" },
        },
      ],
    ];
    for (const [path, init] of requests) {
      const response = await app.request(
        path,
        {
          ...init,
          headers: {
            cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
            ...init.headers,
          },
        },
        env(),
      );
      expect(response.status, path).toBe(401);
    }
    expect(auth.issuePairing).not.toHaveBeenCalled();
    expect(auth.startOwnerTransfer).not.toHaveBeenCalled();
    expect(auth.revokeClient).not.toHaveBeenCalled();
    expect(auth.cancelOwnerTransfer).not.toHaveBeenCalled();
  });

  it("rejects unsafe cookie mutations before owner commands without exact origin metadata", async () => {
    auth.logoutClient.mockResolvedValue({ ok: true, value: undefined });
    const missingOrigin = await app.request(
      "/api/auth/logout",
      {
        method: "POST",
        headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` },
      },
      env(),
    );
    expect(missingOrigin.status).toBe(400);
    expect(auth.logoutClient).not.toHaveBeenCalled();

    const crossSite = await app.request(
      "/api/auth/logout",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          origin: "http://localhost",
          "sec-fetch-site": "cross-site",
        },
      },
      env(),
    );
    expect(crossSite.status).toBe(400);
    expect(auth.logoutClient).not.toHaveBeenCalled();
  });

  it("rejects the root token in query parameters and cookies", async () => {
    const response = await app.request(`/s/a0b1c2d3e4f5?t=${TOKEN}`, undefined, env());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();

    const rootCookie = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${TOKEN}` } },
      env(),
    );
    expect(rootCookie.status).toBe(401);
    expect(rootCookie.headers.get("set-cookie")).toBeNull();

    const apiQuery = await app.request(
      `/api/sessions?t=${TOKEN}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(apiQuery.status).toBe(401);
    expect(apiQuery.headers.get("cache-control")).toBe("no-store");
    const apiRootCookie = await app.request(
      "/api/sessions",
      { headers: { cookie: `__Host-scotty=${TOKEN}` } },
      env(),
    );
    expect(apiRootCookie.status).toBe(401);
  });

  it("proxies the Pican root only for registered-client cookies", async () => {
    sandbox.fetch.mockResolvedValueOnce(
      new Response("<!doctype html><html><head><title>Pican</title></head><body></body></html>", {
        headers: {
          "content-encoding": "gzip",
          "content-length": "72",
          "content-type": "text/html; charset=utf-8",
          etag: '"pican-shell"',
        },
      }),
    );
    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Pican</title>");
    expect(html).toContain('id="scotty-sessions-link" href="/sessions"');
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(sandbox.fetch).toHaveBeenCalledOnce();
    const upstream = sandbox.fetch.mock.calls[0]?.[0];
    expect(upstream).toBeInstanceOf(Request);
    expect(new URL(upstream.url).pathname).toBe("/s/a0b1c2d3e4f5");
    expect(upstream.headers.has("cookie")).toBe(false);

    const sessions = await app.request(
      "/sessions",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(sessions.status).toBe(200);
    expect(sessions.headers.get("cache-control")).toBe("no-store");
    expect(sessions.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const rootBearer = await app.request(
      "/sessions",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(rootBearer.status).toBe(401);

    const sessionRootBearer = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(sessionRootBearer.status).toBe(401);
    expect(sandbox.fetch).toHaveBeenCalledOnce();
  });

  it("preserves mounted Pican paths and query while stripping boundary credentials", async () => {
    sandbox.fetch.mockImplementationOnce(
      async () =>
        new Response("missing", {
          status: 418,
          headers: { "content-type": "text/plain", "x-pican-result": "preserved" },
        }),
    );
    const response = await app.request(
      "/s/a0b1c2d3e4f5/assets/app.js?v=7",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          authorization: "Bearer browser-secret",
          "proxy-authorization": "Basic browser-secret",
          "x-pican-proxy-token": "spoofed",
          forwarded: "for=198.51.100.1",
          "x-forwarded-for": "198.51.100.1",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
          "x-browser-header": "preserved",
          connection: "x-remove-me",
          "x-remove-me": "hop-by-hop",
        },
      },
      env(),
    );

    expect(response.status).toBe(418);
    expect(response.headers.get("x-pican-result")).toBe("preserved");
    await expect(response.text()).resolves.toBe("missing");
    const upstream = sandbox.fetch.mock.calls[0]?.[0];
    const url = new URL(upstream.url);
    expect(url.pathname).toBe("/s/a0b1c2d3e4f5/assets/app.js");
    expect(url.search).toBe("?v=7");
    expect(upstream.headers.get("x-browser-header")).toBe("preserved");
    for (const header of [
      "cookie",
      "authorization",
      "proxy-authorization",
      "x-pican-proxy-token",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "connection",
      "x-remove-me",
    ])
      expect(upstream.headers.has(header), header).toBe(false);
  });

  it("streams Pican request and SSE response bodies without buffering", async () => {
    const encoder = new TextEncoder();
    const sentinel = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    let closeStream: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ready\n\n"));
        closeStream = () => controller.close();
      },
    });
    sandbox.fetch.mockImplementationOnce(async (request: Request) => {
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(sentinel);
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "x-stream": "live" },
      });
    });

    const response = await app.request(
      "/s/a0b1c2d3e4f5/api/sessions?stream=1",
      {
        method: "POST",
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          "content-type": "application/octet-stream",
        },
        body: sentinel,
      },
      env(),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-stream")).toBe("live");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("event: ready\n\n");
    closeStream?.();
    await reader?.cancel();
  });

  it("rejects Pican WebSocket upgrades before crossing the Sandbox boundary", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5/api/events",
      {
        headers: {
          cookie: `__Host-scotty=${CLIENT_CREDENTIAL}`,
          connection: "Upgrade",
          upgrade: "websocket",
        },
      },
      env(),
    );
    expect(response.status).toBe(501);
    await expect(response.text()).resolves.toBe("Pican WebSocket proxying is not supported");
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("serves every critical auth page with the external-script CSP and no-store", async () => {
    for (const path of ["/pair", "/owner-transfer", "/recover"]) {
      const response = await app.request(path, undefined, env());
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(csp, path).toContain("connect-src 'self'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(csp, path).toContain("form-action 'none'");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
    }

    const devices = await app.request(
      "/devices",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(devices.status).toBe(200);
    expect(devices.headers.get("content-security-policy")).toContain("script-src 'self'");

    const providers = await app.request(
      "/providers",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(providers.status).toBe(200);
    expect(providers.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("refreshes an owner cookie only when the Auth Durable Object reports renewal", async () => {
    auth.authenticate.mockResolvedValueOnce({
      ok: true,
      value: {
        client: {
          ...REGISTERED_CLIENT,
        },
        renewed: true,
      },
    });
    const response = await app.request(
      "/api/auth/me",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`__Host-scotty=${CLIENT_CREDENTIAL}`);
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  it("redirects the public root to the canonical session manager", async () => {
    const response = await app.request("/", undefined, env());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sessions");
  });

  it("does not expose the legacy PTY API", async () => {
    for (const request of [
      new Request("http://localhost/api/sessions/a0b1c2d3e4f5/pty-ticket", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      new Request("http://localhost/api/sessions/a0b1c2d3e4f5/pty?client=123456abcdef", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      new Request("http://localhost/api/sessions/a0b1c2d3e4f5/pty/123456abcdef", {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    ]) {
      const response = await app.request(request, undefined, env());
      expect(response.status).toBe(404);
    }
  });

  it("rejects invalid ids before creating a Durable Object stub", async () => {
    const response = await app.request(
      "/api/sessions/INVALID",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(response.status).toBe(400);
  });
});
