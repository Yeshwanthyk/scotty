import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Bindings } from "../src/bindings";

const TOKEN = "worker-test-token-1234567890";

function env(): Bindings {
  return {
    SCOTTY_TOKEN: TOKEN,
    CODEX_AUTH_JSON: "{}",
    GH_TOKEN: "github-test-sentinel",
    SCOTTY_FAKE_AGENT: "1",
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>terminal</title>", {
          headers: { "content-type": "text/html" },
        }),
    } as unknown as Fetcher,
    SANDBOX: {} as DurableObjectNamespace<import("../src/session").Sandbox>,
    SESSIONS: {} as KVNamespace,
    BACKUP_BUCKET: {} as R2Bucket,
  };
}

describe("real Hono boundary", () => {
  it("rejects unauthenticated API requests before touching bindings", async () => {
    const response = await app.request("/api/sessions", undefined, env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "auth" } });
  });

  it("rejects malformed create input at the HTTP boundary", async () => {
    const response = await app.request(
      "/api/sessions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "", repo: "../escape" }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "bad_request" } });
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
