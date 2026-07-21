import { describe, expect, it } from "vitest";
import { isAuthorizedRequest } from "../src/auth";
import {
  parseCreateInput,
  parseSessionId,
  toProjection,
  toSessionView,
  type SessionRecord,
} from "../src/contracts";
import { parseCodexCredential, sentinelAuthJson, type StoredCredential } from "../src/egress";

describe("request contracts", () => {
  it("parses and bounds create input", () => {
    expect(parseCreateInput({ prompt: "ship it" })).toMatchObject({
      prompt: "ship it",
      repo: "anomalyco/rift",
      hardCapSeconds: 14_400,
    });
    expect(() => parseCreateInput({ prompt: "", repo: "bad" })).toThrow(/prompt/u);
    expect(() => parseCreateInput({ prompt: "x", hardCapSeconds: 30 })).toThrow(/hardCapSeconds/u);
  });

  it("accepts only normalized session ids", () => {
    expect(parseSessionId("a0b1c2d3e4f5")).toBe("a0b1c2d3e4f5");
    expect(() => parseSessionId("../escape")).toThrow(/session id/u);
    expect(() => parseSessionId("ABCDEF")).toThrow(/session id/u);
  });

  it("derives projection freshness without exposing operations", () => {
    const record: SessionRecord = {
      version: 1,
      id: "a0b1c2d3e4f5",
      status: "warm",
      operation: { kind: "snapshot", nonce: "private", startedAt: "2026-01-01T00:00:01.000Z" },
      repo: "anomalyco/rift",
      repoExistsAtCreate: true,
      defaultBranch: "dev",
      branch: "scotty/a0b1c2d3e4f5",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      hardCapAt: "2026-01-01T04:00:00.000Z",
      hardCapDurationSeconds: 14_400,
      ownedBackupIds: [],
    };
    const projection = toProjection(record, new Date("2026-01-01T00:00:02.000Z"));
    expect(projection).not.toHaveProperty("operation");
    expect(toSessionView(projection, Date.parse("2026-01-01T01:00:00.000Z"))).toMatchObject({
      ageSeconds: 3_600,
      capRemainingSeconds: 10_800,
    });
  });
});

describe("credential boundary", () => {
  it("parses the pinned Codex auth shape and emits sentinel-only auth", () => {
    const realAccess = "real-access-token-value";
    const realRefresh = "real-refresh-token-value";
    const codex = parseCodexCredential(
      JSON.stringify({
        tokens: {
          id_token: "real.id.token",
          access_token: realAccess,
          refresh_token: realRefresh,
          account_id: "account-real",
        },
      }),
    );
    const stored: StoredCredential = {
      codex,
      codexSentinel: "scotty-codex-session-sentinel",
      githubSentinel: "scotty-github-session-sentinel",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const containerAuth = sentinelAuthJson(stored);
    expect(containerAuth).toContain(stored.codexSentinel);
    expect(containerAuth).not.toContain(realAccess);
    expect(containerAuth).not.toContain(realRefresh);
    expect(containerAuth).not.toContain("account-real");
  });

  it("rejects incomplete auth bundles", () => {
    expect(() => parseCodexCredential("{}")).toThrow(/must contain/u);
    expect(() => parseCodexCredential("{")).toThrow(/valid JSON/u);
  });
});

describe("Worker authentication", () => {
  it("accepts bearer and cookie credentials without accepting query credentials by default", async () => {
    const token = "test-token-1234567890";
    await expect(
      isAuthorizedRequest(
        new Request("https://scotty.test/api", { headers: { authorization: `Bearer ${token}` } }),
        token,
      ),
    ).resolves.toBe(true);
    await expect(
      isAuthorizedRequest(
        new Request("https://scotty.test/api", { headers: { cookie: `__Host-scotty=${token}` } }),
        token,
      ),
    ).resolves.toBe(true);
    await expect(
      isAuthorizedRequest(new Request(`https://scotty.test/api?t=${token}`), token),
    ).resolves.toBe(false);
    await expect(
      isAuthorizedRequest(new Request(`https://scotty.test/api?t=${token}`), token, true),
    ).resolves.toBe(true);
  });
});
