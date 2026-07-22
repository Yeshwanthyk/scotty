import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  createScottySession: vi.fn(),
  getScottySession: vi.fn(),
  snapshotScottySession: vi.fn(),
  resumeScottySession: vi.fn(),
  publishScottySession: vi.fn(),
  prepareDownArchive: vi.fn(),
  readFileStream: vi.fn(),
  vaporizeScottySession: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/sandbox")>()),
  getSandbox: vi.fn(() => sandbox),
}));

import app from "../src/index";
import type { Bindings } from "../src/bindings";

const TOKEN = "worker-test-token-1234567890";

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
    SANDBOX: {} as DurableObjectNamespace<import("../src/session").Sandbox>,
    SESSIONS: {} as KVNamespace,
    BACKUP_BUCKET: {} as R2Bucket,
  };
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
  });

  it("rejects unauthenticated API requests before touching bindings", async () => {
    const response = await app.request("/api/sessions", undefined, env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth",
        message: "Authentication required",
        hint: "Run scotty init or provide --token/SCOTTY_TOKEN",
      },
    });
  });

  it("preserves the create status, output shape, and ignored legacy cap", async () => {
    sandbox.createScottySession.mockResolvedValue({
      branch: "scotty/a0b1c2d3e4f5",
      status: "warm",
    });
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
    if (!body || typeof body !== "object" || !("id" in body))
      throw new TypeError("Expected create response object");
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}$/u),
      url: expect.stringMatching(new RegExp(`^http://localhost/s/[0-9a-f]{12}\\?t=${TOKEN}$`, "u")),
      branch: "scotty/a0b1c2d3e4f5",
      status: "warm",
    });
    expect(sandbox.createScottySession).toHaveBeenCalledWith(
      { prompt: "ship it", repo: "anomalyco/rift", hardCapSeconds: 14_400 },
      body.id,
    );
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

  it("treats malformed PR JSON as an omitted title and preserves the result shape", async () => {
    sandbox.publishScottySession.mockResolvedValue({
      prUrl: "https://github.com/owner/repo/pull/1",
      branchUrl: "https://github.com/owner/repo/tree/scotty/a0b1c2d3e4f5",
      created: true,
    });
    const response = await app.request(
      "/api/sessions/a0b1c2d3e4f5/pr",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      },
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      prUrl: "https://github.com/owner/repo/pull/1",
      branchUrl: "https://github.com/owner/repo/tree/scotty/a0b1c2d3e4f5",
      created: true,
    });
    expect(sandbox.publishScottySession).toHaveBeenCalledWith({});
  });

  it("preserves beam-down streaming status, headers, and filename", async () => {
    sandbox.prepareDownArchive.mockResolvedValue({
      path: "/tmp/scotty-a0b1c2d3e4f5.tar",
      filename: "scotty-a0b1c2d3e4f5.tar",
      manifest: {},
    });
    sandbox.readFileStream.mockResolvedValue(new Blob(["archive"]).stream());
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
        path: "/api/sessions/a0b1c2d3e4f5/resume",
        mock: sandbox.resumeScottySession,
        output: { id: "a0b1c2d3e4f5", status: "warm", branch: "scotty/a0b1c2d3e4f5" },
      },
      {
        method: "DELETE",
        path: "/api/sessions/a0b1c2d3e4f5",
        mock: sandbox.vaporizeScottySession,
        output: { id: "a0b1c2d3e4f5", status: "gone" },
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

  it("lists only fully decoded KV projections and preserves valid optional fields", async () => {
    const values = new Map<string, unknown>([
      ["session:valid", projection],
      ["session:malformed", { ...projection, id: "malformed", backupId: 123 }],
    ]);
    const sessions = {
      list: async () => ({
        keys: [{ name: "session:valid" }, { name: "session:malformed" }],
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

  it("serves the terminal with no-store and confinement headers after cookie auth", async () => {
    const response = await app.request(
      "/s/a0b1c2d3e4f5",
      { headers: { cookie: `__Host-scotty=${TOKEN}` } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
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
