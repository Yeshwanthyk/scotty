import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { isAuthorizedRequest } from "../src/auth";
import {
  badRequest,
  conflict,
  decodePublicError,
  decodeSessionProjection,
  decodeSessionRecord,
  notFound,
  parseCreateInput,
  parsePrInput,
  parseSessionId,
  ScottyError,
  toProjection,
  toSessionView,
  wrongState,
  type SessionRecord,
} from "../src/contracts";
import { parseCodexCredential, sentinelAuthJson, type StoredCredential } from "../src/egress";

describe("request contracts", () => {
  it("parses and bounds create input", () => {
    assert.deepStrictEqual(parseCreateInput({ prompt: "ship it" }), {
      prompt: "ship it",
      repo: "anomalyco/rift",
      hardCapSeconds: 14_400,
    });
    assert.deepStrictEqual(parseCreateInput({ prompt: "ship it", cap: "90m" }), {
      prompt: "ship it",
      repo: "anomalyco/rift",
      hardCapSeconds: 14_400,
    });
    assert.throws(() => parseCreateInput({}), /prompt must be a non-empty string/u);
    assert.throws(() => parseCreateInput({ prompt: "", repo: "bad" }), /prompt/u);
    assert.throws(() => parseCreateInput({ prompt: "x", hardCapSeconds: 30 }), /hardCapSeconds/u);
  });

  it("preserves PR title omission, trimming, and errors", () => {
    assert.deepStrictEqual(parsePrInput(undefined), {});
    assert.deepStrictEqual(parsePrInput(null), {});
    assert.deepStrictEqual(parsePrInput({ ignored: true }), {});
    assert.deepStrictEqual(parsePrInput({ title: " ship it " }), { title: "ship it" });
    assert.throws(() => parsePrInput([]), /Request body must be a JSON object/u);
    assert.throws(() => parsePrInput({ title: "" }), /title must be a non-empty string/u);
  });

  it("accepts only normalized session ids", () => {
    assert.strictEqual(parseSessionId("a0b1c2d3e4f5"), "a0b1c2d3e4f5");
    assert.throws(() => parseSessionId("../escape"), /session id/u);
    assert.throws(() => parseSessionId("ABCDEF"), /session id/u);
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
    assert.ok(!("operation" in projection));
    assert.deepInclude(toSessionView(projection, Date.parse("2026-01-01T01:00:00.000Z")), {
      ageSeconds: 3_600,
      capRemainingSeconds: 10_800,
    });
  });

  it("floors partial seconds in session views", () => {
    const projection = {
      version: 1 as const,
      id: "a0b1c2d3e4f5",
      status: "warm" as const,
      repo: "anomalyco/rift",
      defaultBranch: "dev",
      branch: "scotty/a0b1c2d3e4f5",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      hardCapAt: "2026-01-01T00:00:03.998Z",
      projectedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.deepInclude(toSessionView(projection, Date.parse("2026-01-01T00:00:01.999Z")), {
      ageSeconds: 1,
      capRemainingSeconds: 1,
    });
  });
});

const persistedRecord = {
  version: 1,
  id: "a0b1c2d3e4f5",
  status: "sleeping",
  operation: null,
  repo: "anomalyco/rift",
  repoExistsAtCreate: true,
  defaultBranch: "dev",
  branch: "scotty/a0b1c2d3e4f5",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: ["backup-1"],
  backup: {
    current: { id: "backup-1", dir: "/workspace/a0b1c2d3e4f5", localBucket: true },
  },
} as const;

describe("persisted session schemas", () => {
  it.effect("decodes an exact authoritative version 1 record", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeSessionRecord(persistedRecord);
      assert.deepStrictEqual(decoded, persistedRecord);
      const withPersistedUndefined = {
        ...persistedRecord,
        backup: { ...persistedRecord.backup, previous: undefined },
        backupExpiresAt: undefined,
        codexThreadId: undefined,
        failure: undefined,
      };
      assert.deepStrictEqual(
        yield* decodeSessionRecord(withPersistedUndefined),
        withPersistedUndefined,
      );
    }),
  );

  it.effect("fails closed for missing, malformed, and excess authoritative state", () =>
    Effect.gen(function* () {
      for (const malformed of [
        { ...persistedRecord, status: "unknown" },
        { ...persistedRecord, operation: undefined },
        { ...persistedRecord, secret: "excess" },
        {
          ...persistedRecord,
          backup: { current: { ...persistedRecord.backup.current, secret: "nested excess" } },
        },
      ]) {
        const decoded = yield* Effect.result(decodeSessionRecord(malformed));
        assert.ok(Result.isFailure(decoded));
      }
    }),
  );

  it("strips projection extras and skips malformed projections", () => {
    const projection = {
      version: 1,
      id: persistedRecord.id,
      status: persistedRecord.status,
      repo: persistedRecord.repo,
      defaultBranch: persistedRecord.defaultBranch,
      branch: persistedRecord.branch,
      createdAt: persistedRecord.createdAt,
      updatedAt: persistedRecord.updatedAt,
      hardCapAt: persistedRecord.hardCapAt,
      projectedAt: persistedRecord.updatedAt,
      secret: "strip me",
    };
    const decoded = decodeSessionProjection(projection);
    assert.ok(Option.isSome(decoded));
    assert.ok(!("secret" in decoded.value));
    assert.ok(Option.isNone(decodeSessionProjection({ ...projection, status: "unknown" })));
  });
});

describe("public errors", () => {
  it.effect("keeps code, status, exit, message, and hint correlations", () =>
    Effect.gen(function* () {
      const publicErrors = [
        badRequest("Bad input", "Fix it"),
        new ScottyError("auth", "Authentication required", { httpStatus: 401, exitCode: 4 }),
        notFound("abc123"),
        wrongState("warm", "resume", "Wait"),
        conflict("Busy"),
        new ScottyError("upstream", "Upstream failed", { httpStatus: 502, exitCode: 1 }),
        new ScottyError("internal", "Internal error", { httpStatus: 500, exitCode: 1 }),
      ];
      for (const error of publicErrors) {
        const decoded = yield* decodePublicError(error);
        assert.strictEqual(decoded.code, error.code);
        assert.strictEqual(decoded.httpStatus, error.httpStatus);
        assert.strictEqual(decoded.exitCode, error.exitCode);
        assert.strictEqual(decoded.message, error.message);
        assert.strictEqual(decoded.hint, error.hint);
      }
    }),
  );
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
    assert.ok(containerAuth.includes(stored.codexSentinel));
    assert.ok(!containerAuth.includes(realAccess));
    assert.ok(!containerAuth.includes(realRefresh));
    assert.ok(!containerAuth.includes("account-real"));
  });

  it("rejects incomplete auth bundles", () => {
    assert.throws(() => parseCodexCredential("{}"), /must contain/u);
    assert.throws(() => parseCodexCredential("{"), /valid JSON/u);
  });
});

describe("Worker authentication", () => {
  it("accepts bearer and cookie credentials without accepting query credentials by default", async () => {
    const token = "test-token-1234567890";
    assert.strictEqual(
      await isAuthorizedRequest(
        new Request("https://scotty.test/api", { headers: { authorization: `Bearer ${token}` } }),
        token,
      ),
      true,
    );
    assert.strictEqual(
      await isAuthorizedRequest(
        new Request("https://scotty.test/api", { headers: { cookie: `__Host-scotty=${token}` } }),
        token,
      ),
      true,
    );
    assert.strictEqual(
      await isAuthorizedRequest(new Request(`https://scotty.test/api?t=${token}`), token),
      false,
    );
    assert.strictEqual(
      await isAuthorizedRequest(new Request(`https://scotty.test/api?t=${token}`), token, true),
      true,
    );
  });
});
