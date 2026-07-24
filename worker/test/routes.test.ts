import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  createScottySession: vi.fn(),
  getScottySession: vi.fn(),
  prepareTerminalAttachment: vi.fn(),
  releaseTerminalAttachment: vi.fn(),
  touchTerminalAttachment: vi.fn(),
  snapshotScottySession: vi.fn(),
  sleepScottySession: vi.fn(),
  resumeScottySession: vi.fn(),
  prepareDownArchive: vi.fn(),
  readScottyArchiveStream: vi.fn(),
  getSession: vi.fn(),
  vaporizeScottySession: vi.fn(),
}));

const sandboxTarget = vi.hoisted((): { current: unknown } => ({
  current: sandbox,
}));

const auth = vi.hoisted(() => ({
  authenticate: vi.fn(),
  registerBootstrapClient: vi.fn(),
  consumePairing: vi.fn(),
  issuePairing: vi.fn(),
  listClients: vi.fn(),
  revokeClient: vi.fn(),
  issueTerminalTicket: vi.fn(),
  consumeTerminalTicket: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => sandboxTarget.current),
}));

import app, { terminalBridgeCleanup } from "../src/index";
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
const CLIENT_CREDENTIAL = "scotty_client.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REGISTERED_CLIENT = {
  id: "111111111111",
  label: "Trusted browser",
  scopes: ["sessions:read", "sessions:write", "terminal:connect", "access:read", "access:write"],
  createdAt: "2026-07-22T12:00:00.000Z",
  expiresAt: "2026-08-21T12:00:00.000Z",
  lastSeenAt: "2026-07-22T12:00:00.000Z",
};

function authNamespace(): import("../src/auth-object").ScottyAuthRegistryNamespace {
  return { getByName: () => auth };
}

function env(): Bindings {
  const assets: Fetcher = {
    fetch: async () =>
      new Response("<!doctype html><title>terminal</title>", {
        headers: { "content-type": "text/html" },
      }),
    connect: () => {
      throw new Error("ASSETS.connect isn't used by route tests");
    },
  };
  return {
    SCOTTY_TOKEN: TOKEN,
    CODEX_AUTH_JSON: "{}",
    GH_TOKEN: "github-test-sentinel",
    SCOTTY_FAKE_AGENT: "1",
    ASSETS: assets,
    AUTH: authNamespace(),
    SANDBOX: {} as DurableObjectNamespace<import("../src/session").Sandbox>,
    SESSIONS: {} as KVNamespace,
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
    auth.registerBootstrapClient.mockResolvedValue({
      ok: true,
      value: {
        credential: CLIENT_CREDENTIAL,
        client: REGISTERED_CLIENT,
      },
    });
  });

  it("releases a terminal bridge once across socket and request disconnect signals", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const tasks: Promise<void>[] = [];
    const settle = terminalBridgeCleanup(cleanup, (task) => tasks.push(task), controller.signal);

    settle();
    settle();
    controller.abort();
    await Promise.all(tasks);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses request abort as a cleanup backstop and logs cleanup failure", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn().mockRejectedValue(new Error("release failed"));
    const tasks: Promise<void>[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    terminalBridgeCleanup(cleanup, (task) => tasks.push(task), controller.signal);

    controller.abort();
    await Promise.all(tasks);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("Terminal attachment cleanup failed", {
      name: "Error",
    });
    logged.mockRestore();
  });

  it("rejects unauthenticated API requests before touching bindings", async () => {
    const response = await app.request("/api/sessions", undefined, env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth",
        message: "Authentication required",
        hint: "Open a fresh pairing link or run scotty init with a bootstrap token.",
      },
    });
  });

  it("preserves the create status, output shape, and ignored legacy cap", async () => {
    const harness = await createSessionHarness();
    useRealSandbox(harness);
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: " ship it ", cap: "90m" }),
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
      status: "warm",
    });
    expect(harness.readRecord()).toMatchObject({
      id: body.id,
      branch: `scotty/${body.id}`,
      repo: "anomalyco/rift",
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
        "host:exec:agent",
        "record:warm",
        "projection:warm",
        "schedule:captureThreadId",
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
      body: JSON.stringify({ prompt: "ship it" }),
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
      status: "warm",
    });
    expect(harness.read(sessionHarnessKeys.createIdempotency)).toEqual({
      keyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(harness.events.filter((event) => event === "host:exec:agent")).toHaveLength(1);
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
        body: JSON.stringify({ prompt: "ship it", repo: "owner/repo" }),
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
        body: JSON.stringify({ prompt: "ship it", repo: "owner/repo" }),
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
        body: JSON.stringify({ prompt: "ship it" }),
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
        [sessionHarnessKeys.terminalAttachments]: [],
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
        `storage:delete:${sessionHarnessKeys.terminalAttachments}`,
        "host:mkdir",
        "host:exec:agent",
        "record:warm",
        "projection:warm",
        "schedule:captureThreadId",
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
      scopes: ["sessions:read", "sessions:write", "terminal:connect"],
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

  it("issues scannable pairing links and manages registered clients only for admins", async () => {
    auth.authenticate.mockResolvedValue({ ok: true, value: REGISTERED_CLIENT });
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
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "Phone" }),
      },
      env(),
    );
    expect(issued.status).toBe(200);
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
    expect(auth.listClients).toHaveBeenCalledWith(REGISTERED_CLIENT.id);

    auth.revokeClient.mockResolvedValue({ ok: true, value: undefined });
    const revoked = await app.request(
      "/api/auth/clients/222222222222",
      { method: "DELETE", headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(revoked.status).toBe(200);
    expect(auth.revokeClient).toHaveBeenCalledWith("222222222222", REGISTERED_CLIENT.id);
  });

  it("lets a standard paired browser issue terminal tickets but not manage devices", async () => {
    const standard = {
      ...REGISTERED_CLIENT,
      scopes: ["sessions:read", "sessions:write", "terminal:connect"],
    };
    auth.authenticate.mockResolvedValue({ ok: true, value: standard });
    const denied = await app.request(
      "/api/auth/clients",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(denied.status).toBe(401);
    expect(auth.listClients).not.toHaveBeenCalled();

    auth.issueTerminalTicket.mockResolvedValue({
      ok: true,
      value: {
        credential: "scotty_pty.444444444444.ddddddddddddddddddddddddddddddddddddddddddd",
        expiresAt: "2026-07-22T12:05:00.000Z",
      },
    });
    const ticket = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pty-ticket",
      { method: "POST", headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(ticket.status).toBe(200);
    expect(auth.issueTerminalTicket).toHaveBeenCalledWith(CLIENT_CREDENTIAL, "a0b1c2d3e4f5");
  });

  it("exchanges a query token for a hardened cookie and clean redirect", async () => {
    const response = await app.request(`/s/a0b1c2d3e4f5?t=${TOKEN}`, undefined, env());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/s/a0b1c2d3e4f5");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-scotty=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("upgrades a root cookie once and serves the terminal with registered-client auth", async () => {
    const upgraded = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${TOKEN}` } },
      env(),
    );
    expect(upgraded.status).toBe(302);
    expect(upgraded.headers.get("location")).toBe("/s/a0b1c2d3e4f5");
    expect(upgraded.headers.get("set-cookie")).toContain(CLIENT_CREDENTIAL);
    expect(upgraded.headers.get("set-cookie")).not.toContain(TOKEN);

    auth.authenticate.mockResolvedValue({ ok: true, value: REGISTERED_CLIENT });
    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves the authenticated session manager and exchanges query auth cleanly", async () => {
    const exchanged = await app.request(`/sessions?t=${TOKEN}`, undefined, env());
    expect(exchanged.status).toBe(302);
    expect(exchanged.headers.get("location")).toBe("/sessions");
    expect(exchanged.headers.get("set-cookie")).toContain(CLIENT_CREDENTIAL);
    expect(exchanged.headers.get("set-cookie")).not.toContain(TOKEN);

    auth.authenticate.mockResolvedValue({ ok: true, value: REGISTERED_CLIENT });
    auth.registerBootstrapClient.mockClear();
    const repeatedCliLink = await app.request(
      `/sessions?t=${TOKEN}`,
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(repeatedCliLink.status).toBe(302);
    expect(repeatedCliLink.headers.get("location")).toBe("/sessions");
    expect(auth.registerBootstrapClient).not.toHaveBeenCalled();

    const response = await app.request(
      "/sessions",
      { headers: { cookie: `__Host-scotty=${CLIENT_CREDENTIAL}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("redirects the public root to the canonical session manager", async () => {
    const response = await app.request("/", undefined, env());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sessions");
  });

  it("requires bounded terminal client ids and releases per-client execution sessions", async () => {
    const invalid = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pty?client=INVALID",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(invalid.status).toBe(400);

    sandbox.releaseTerminalAttachment.mockResolvedValueOnce(undefined);
    const released = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pty/123456abcdef",
      { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(released.status).toBe(200);
    expect(sandbox.releaseTerminalAttachment).toHaveBeenCalledWith("123456abcdef");

    sandbox.touchTerminalAttachment.mockResolvedValueOnce(undefined);
    const heartbeat = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pty/123456abcdef/heartbeat",
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(heartbeat.status).toBe(200);
    expect(sandbox.touchTerminalAttachment).toHaveBeenCalledWith("123456abcdef");
  });

  it("opens PTYs through the Worker-side enhanced Sandbox session", async () => {
    const terminal = vi.fn().mockResolvedValue(new Response());
    sandbox.getScottySession.mockResolvedValueOnce({ status: "warm" });
    sandbox.prepareTerminalAttachment.mockResolvedValueOnce("scotty-web-123456abcdef");
    sandbox.getSession.mockReturnValueOnce({ terminal });
    sandbox.releaseTerminalAttachment.mockResolvedValueOnce(undefined);

    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pty?client=123456abcdef&cols=120&rows=40",
      {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          upgrade: "websocket",
        },
      },
      env(),
    );

    expect(response.status).toBe(502);
    expect(sandbox.getScottySession).not.toHaveBeenCalled();
    expect(sandbox.prepareTerminalAttachment).toHaveBeenCalledWith("123456abcdef");
    expect(sandbox.getSession).toHaveBeenCalledWith("scotty-web-123456abcdef");
    expect(terminal).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        cols: 120,
        rows: 40,
        shell: "/usr/local/bin/scotty-attach",
      }),
    );
    expect(sandbox.releaseTerminalAttachment).toHaveBeenCalledWith("123456abcdef");
  });

  it("does not serve the terminal client without a canonical session URL", async () => {
    const response = await app.request("/terminal", undefined, env());
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe(
      "Open a session with scotty attach ID or use its /s/ID URL.",
    );
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
