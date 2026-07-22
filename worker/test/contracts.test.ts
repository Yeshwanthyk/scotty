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
import {
  decodeCredentialPatch,
  decodeStoredCredential,
  oauthContainerResult,
  parseCodexCredential,
  parseOAuthRefreshRequest,
  parseOAuthUpstreamSuccess,
  sentinelAuthJson,
  type StoredCredential,
} from "../src/egress";

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
  const storedCredential = (codex: StoredCredential["codex"]): StoredCredential => ({
    codex,
    githubToken: "real-github-token",
    codexSentinel: "scotty-codex-session-sentinel",
    githubSentinel: "scotty-github-session-sentinel",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const assertFixedError = (evaluate: () => unknown, message: string): void => {
    const result = Result.try(evaluate);
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof Error);
    assert.strictEqual(result.failure.message, message);
  };

  it("accepts API-key-only and token bundles without trimming", () => {
    assert.deepStrictEqual(parseCodexCredential('{"OPENAI_API_KEY":" api-key "}'), {
      OPENAI_API_KEY: " api-key ",
      tokens: undefined,
      account_id: null,
      last_refresh: null,
    });
    assert.deepStrictEqual(
      parseCodexCredential(
        JSON.stringify({
          tokens: {
            id_token: "real.id.token",
            access_token: "real-access-token-value",
            refresh_token: "real-refresh-token-value",
            account_id: "account-real",
          },
        }),
      ),
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "real.id.token",
          access_token: "real-access-token-value",
          refresh_token: "real-refresh-token-value",
          account_id: "account-real",
        },
        account_id: null,
        last_refresh: null,
      },
    );
  });

  it("collapses wrong optional seed values and strips unknown fields", () => {
    const parsed = parseCodexCredential(
      JSON.stringify({
        OPENAI_API_KEY: 42,
        account_id: false,
        last_refresh: {},
        honeypot: "must-not-survive",
        tokens: {
          id_token: 1,
          access_token: "access",
          refresh_token: "",
          account_id: [],
          secret: "must-not-survive",
        },
      }),
    );
    assert.deepStrictEqual(parsed, {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: undefined,
        access_token: "access",
        refresh_token: undefined,
        account_id: null,
      },
      account_id: null,
      last_refresh: null,
    });
    assert.ok(!("honeypot" in parsed));
    assert.ok(!("secret" in (parsed.tokens ?? {})));
  });

  it("preserves exact fixed seed errors", () => {
    assertFixedError(() => parseCodexCredential("{"), "CODEX_AUTH_JSON is not valid JSON");
    assertFixedError(
      () => parseCodexCredential("[]"),
      "CODEX_AUTH_JSON must contain a JSON object",
    );
    assertFixedError(
      () => parseCodexCredential('{"tokens":[]}'),
      "CODEX_AUTH_JSON tokens must be an object",
    );
    assertFixedError(
      () => parseCodexCredential("{}"),
      "CODEX_AUTH_JSON must contain OPENAI_API_KEY or tokens.access_token",
    );
  });

  it("decodes stored authority, strips unknown fields, and fails closed with a fixed error", () => {
    const secret = "stored-honeypot-secret";
    const decoded = decodeStoredCredential({
      ...storedCredential(parseCodexCredential('{"OPENAI_API_KEY":"api-key"}')),
      unknown: secret,
    });
    assert.ok(!("unknown" in decoded));
    assertFixedError(
      () =>
        decodeStoredCredential({
          codex: { OPENAI_API_KEY: secret },
          codexSentinel: "sentinel",
        }),
      "Stored credential record is invalid",
    );
  });

  it("accepts only the current OAuth shape while preserving unknown request fields", () => {
    assert.deepStrictEqual(
      parseOAuthRefreshRequest({
        grant_type: "refresh_token",
        refresh_token: "",
        client_id: "forward-me",
      }),
      { grant_type: "refresh_token", refresh_token: "", client_id: "forward-me" },
    );
    assert.strictEqual(
      parseOAuthRefreshRequest({ grant_type: "authorization_code", refresh_token: "token" }),
      null,
    );
    assert.strictEqual(
      parseOAuthRefreshRequest({ grant_type: "refresh_token", refresh_token: 1 }),
      null,
    );
  });

  it("requires an upstream access token and omits invalid optional patch values", () => {
    assert.deepStrictEqual(
      parseOAuthUpstreamSuccess({
        access_token: "next-access",
        id_token: "",
        refresh_token: 1,
        ignored: "strip-me",
      }),
      { accessToken: "next-access" },
    );
    assert.strictEqual(parseOAuthUpstreamSuccess({ refresh_token: "next-refresh" }), null);
    assert.strictEqual(parseOAuthUpstreamSuccess({ access_token: "" }), null);
    assert.deepStrictEqual(decodeCredentialPatch({ accessToken: "next-access", ignored: true }), {
      accessToken: "next-access",
    });
  });

  it("emits sentinel-only auth and OAuth success without disclosing honeypot secrets", () => {
    const realAccess = "honeypot-real-access";
    const realRefresh = "honeypot-real-refresh";
    const realGithub = "honeypot-real-github";
    const stored = {
      ...storedCredential(
        parseCodexCredential(
          JSON.stringify({
            tokens: {
              access_token: realAccess,
              refresh_token: realRefresh,
              account_id: "honeypot-account",
            },
          }),
        ),
      ),
      githubToken: realGithub,
    };
    const containerAuth = sentinelAuthJson(stored);
    const refreshResult = JSON.stringify(oauthContainerResult(stored));
    assert.ok(containerAuth.includes(stored.codexSentinel));
    assert.ok(refreshResult.includes(stored.codexSentinel));
    for (const secret of [realAccess, realRefresh, realGithub, "honeypot-account"]) {
      assert.ok(!containerAuth.includes(secret));
      assert.ok(!refreshResult.includes(secret));
    }
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
