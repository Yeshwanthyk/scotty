import { assert, describe, it } from "@effect/vitest";
import { parsePiAuthJsonOption } from "../../protocol/pi-auth";
import { Effect, Option, Result } from "effect";
import { isAuthorizedRequest } from "../src/auth";
import {
  badRequest,
  conflict,
  decodePublicError,
  decodeSessionProjection,
  decodeSessionRecord,
  decodeStatsResponse,
  decodeWorkspaceCreationMarker,
  hasCommittedManagedStop,
  notFound,
  parseCreateInput,
  parseRenameSessionInput,
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
  piAuthJson,
  parseOAuthRefreshRequest,
  parseOAuthUpstreamSuccess,
  type StoredCredential,
} from "../src/egress";

describe("request contracts", () => {
  it("parses and bounds create input", () => {
    assert.deepStrictEqual(
      parseCreateInput({
        title: "  Ship dashboard  ",
        prompt: "ship it",
        provider: "cloudflare",
        repo: "owner/project",
      }),
      {
        title: "Ship dashboard",
        prompt: "ship it",
        provider: "cloudflare",
        repo: "owner/project",
        hardCapSeconds: 14_400,
      },
    );
    assert.throws(
      () =>
        parseCreateInput({
          prompt: "ship it",
          provider: "cloudflare",
          repo: "owner/project",
        }),
      /title must be a non-empty string/u,
    );
    assert.throws(() => parseCreateInput({}), /title must be a non-empty string/u);
    assert.throws(
      () => parseCreateInput({ title: "Ship dashboard", prompt: "ship it" }),
      /provider must be cloudflare/u,
    );
    assert.throws(
      () =>
        parseCreateInput({
          title: "Ship dashboard",
          prompt: "ship it",
          provider: "box",
          repo: "owner/project",
        }),
      /provider must be cloudflare/u,
    );
    assert.throws(
      () =>
        parseCreateInput({
          title: "Ship dashboard",
          prompt: "ship it",
          provider: "cloudflare",
        }),
      /repo must be a non-empty string/u,
    );
    assert.throws(
      () =>
        parseCreateInput({
          title: "Ship dashboard",
          prompt: "",
          provider: "cloudflare",
          repo: "bad",
        }),
      /prompt/u,
    );
    assert.throws(
      () =>
        parseCreateInput({
          title: "Ship dashboard",
          prompt: "x",
          provider: "cloudflare",
          repo: "owner/project",
          hardCapSeconds: 30,
        }),
      /hardCapSeconds/u,
    );
    assert.strictEqual(
      parseRenameSessionInput({ title: "  Rename this workspace  " }),
      "Rename this workspace",
    );
    assert.throws(() => parseRenameSessionInput({ title: " " }), /title/u);
    assert.throws(() => parseRenameSessionInput({ title: "x".repeat(121) }), /120/u);
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
      title: "Package Pi extensions",
      status: "warm",
      operation: { kind: "snapshot", nonce: "private", startedAt: "2026-01-01T00:00:01.000Z" },
      execution: { provider: "cloudflare" },
      provider: "cloudflare",
      repo: "owner/project",
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
    assert.isUndefined(projection.deleting);
    assert.deepInclude(toSessionView(projection, Date.parse("2026-01-01T01:00:00.000Z")), {
      title: "Package Pi extensions",
      ageSeconds: 3_600,
      capRemainingSeconds: 10_800,
    });

    const deleting = toProjection(
      {
        ...record,
        operation: {
          kind: "vaporize",
          nonce: "private-delete",
          startedAt: "2026-01-01T00:00:03.000Z",
        },
      },
      new Date("2026-01-01T00:00:04.000Z"),
    );
    assert.strictEqual(deleting.deleting, true);
    assert.ok(!("operation" in deleting));
  });

  it("floors partial seconds in session views", () => {
    const projection = {
      version: 1 as const,
      id: "a0b1c2d3e4f5",
      title: "Package Pi extensions",
      status: "warm" as const,
      provider: "cloudflare" as const,
      repo: "owner/project",
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
  title: "Package Pi extensions",
  status: "sleeping",
  operation: null,
  execution: { provider: "cloudflare" },
  provider: "cloudflare",
  repo: "owner/project",
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

describe("stats schemas", () => {
  it("accepts only non-secret creation markers and bounded stats counts", () => {
    const marker = decodeWorkspaceCreationMarker({
      sessionId: "a0b1c2d3e4f5",
      repository: "owner/project",
      provider: "cloudflare",
      createdAt: "2026-07-29T10:00:00.000Z",
      prompt: "must not survive",
    });
    assert.ok(Option.isSome(marker));
    assert.deepStrictEqual(marker.value, {
      sessionId: "a0b1c2d3e4f5",
      repository: "owner/project",
      provider: "cloudflare",
      createdAt: "2026-07-29T10:00:00.000Z",
    });
    assert.ok(
      Option.isNone(
        decodeWorkspaceCreationMarker({
          ...marker.value,
          repository: "not-a-repository",
        }),
      ),
    );
    assert.ok(
      Option.isNone(
        decodeWorkspaceCreationMarker({
          ...marker.value,
          provider: "unknown",
        }),
      ),
    );

    const stats = decodeStatsResponse({
      trackingSince: marker.value.createdAt,
      overall: { workspacesCreated: 1, projects: 1, warmNow: 1, sleepingNow: 0 },
      projects: [
        {
          repository: marker.value.repository,
          workspacesCreated: 1,
          warmNow: 1,
          sleepingNow: 0,
          lastCreated: marker.value.createdAt,
        },
      ],
    });
    assert.ok(Option.isSome(stats));
    assert.ok(
      Option.isNone(
        decodeStatsResponse({
          ...stats.value,
          overall: { ...stats.value.overall, workspacesCreated: -1 },
        }),
      ),
    );
  });
});

describe("persisted session schemas", () => {
  it.effect("upgrades legacy Cloudflare records before current decoding", () =>
    Effect.gen(function* () {
      const legacyRecord = Object.fromEntries(
        Object.entries(persistedRecord).filter(([key]) => key !== "execution"),
      );
      assert.notProperty(legacyRecord, "execution");

      const decoded = yield* decodeSessionRecord(legacyRecord);

      assert.deepStrictEqual(decoded, persistedRecord);
    }),
  );

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
        { ...persistedRecord, title: undefined },
        { ...persistedRecord, status: "unknown" },
        { ...persistedRecord, operation: undefined },
        {
          ...persistedRecord,
          operation: {
            kind: "create",
            nonce: "private",
            startedAt: "2026-01-01T00:00:01.000Z",
          },
        },
        {
          ...persistedRecord,
          operation: {
            kind: "create",
            nonce: "private",
            startedAt: "2026-01-01T00:00:01.000Z",
            createPhase: "unknown",
          },
        },
        {
          ...persistedRecord,
          operation: {
            kind: "resume",
            nonce: "private",
            startedAt: "2026-01-01T00:00:01.000Z",
            createPhase: "setup",
          },
        },
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

  it.effect("decodes legacy records without sandbox bundle pins", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeSessionRecord(persistedRecord);
      assert.notProperty(decoded, "sandboxBundle");
    }),
  );

  it.effect("rejects malformed sandbox bundle digests", () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.result(
        decodeSessionRecord({
          ...persistedRecord,
          sandboxBundle: { digest: "not-a-digest", manifestVersion: 1 },
        }),
      );
      assert.ok(Result.isFailure(decoded));
    }),
  );

  it("derives sandbox bundle pins in projections without exposing bundle contents", () => {
    const digest = "c".repeat(64);
    const record: SessionRecord = {
      version: 1,
      id: "a0b1c2d3e4f5",
      title: "Package Pi extensions",
      status: "warm",
      operation: null,
      execution: { provider: "cloudflare" },
      provider: "cloudflare",
      repo: "owner/project",
      repoExistsAtCreate: true,
      defaultBranch: "dev",
      branch: "scotty/a0b1c2d3e4f5",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      hardCapAt: "2026-01-01T04:00:00.000Z",
      hardCapDurationSeconds: 14_400,
      ownedBackupIds: [],
      sandboxBundle: { digest, manifestVersion: 1 },
    };
    const projection = toProjection(record, new Date("2026-01-01T00:00:02.000Z"));
    assert.deepStrictEqual(projection.sandboxBundle, { digest, manifestVersion: 1 });
    assert.ok(!("skills" in projection));
    assert.ok(!("piPackages" in projection));
  });

  it("strips projection extras and skips malformed projections", () => {
    const projection = {
      version: 1,
      id: persistedRecord.id,
      title: persistedRecord.title,
      status: persistedRecord.status,
      provider: persistedRecord.provider,
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

  it("requires an explicit stop request and matching committed backup before sleeping", () => {
    const warm = { ...persistedRecord, status: "warm" as const };
    assert.isFalse(hasCommittedManagedStop({ ...warm, operation: null }));
    assert.isFalse(
      hasCommittedManagedStop({
        ...warm,
        backup: undefined,
        operation: {
          kind: "snapshot",
          nonce: "snapshot-1",
          startedAt: warm.updatedAt,
          checkpointedBackupId: undefined,
          stopRequestedAt: warm.updatedAt,
        },
      }),
    );
    assert.isFalse(
      hasCommittedManagedStop({
        ...warm,
        operation: {
          kind: "snapshot",
          nonce: "snapshot-1",
          startedAt: warm.updatedAt,
          checkpointedBackupId: "backup-1",
        },
      }),
    );
    assert.isTrue(
      hasCommittedManagedStop({
        ...warm,
        operation: {
          kind: "snapshot",
          nonce: "snapshot-1",
          startedAt: warm.updatedAt,
          checkpointedBackupId: "backup-1",
          stopRequestedAt: warm.updatedAt,
        },
      }),
    );
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
  const storedCredential = (): StoredCredential => ({
    providers: {
      "openai-codex": {
        credential: {
          type: "oauth",
          access: "real-access-token",
          refresh: "real-refresh-token",
          expires: 0,
          accountId: "real-account",
        },
        sentinel: "scotty-pi-session-sentinel",
      },
    },
    githubToken: "real-github-token",
    githubSentinel: "scotty-github-session-sentinel",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const assertFixedError = (evaluate: () => unknown, message: string): void => {
    const result = Result.try(evaluate);
    assert.ok(Result.isFailure(result));
    assert.ok(result.failure instanceof Error);
    assert.strictEqual(result.failure.message, message);
  };

  it("decodes Pi API-key and OAuth credentials while preserving provider fields", () => {
    const decoded = Option.getOrThrow(
      parsePiAuthJsonOption(
        JSON.stringify({
          openai: { type: "api_key", key: "api-key" },
          "openai-codex": {
            type: "oauth",
            access: "access",
            refresh: "refresh",
            expires: 0,
            accountId: "account",
          },
          "github-copilot": {
            type: "oauth",
            access: "copilot-access",
            refresh: "copilot-refresh",
            expires: 1,
            enterpriseUrl: "https://github.example",
            availableModelIds: ["model-a"],
          },
        }),
      ),
    );
    assert.deepInclude(decoded["openai-codex"], { accountId: "account" });
    assert.deepInclude(decoded["github-copilot"], {
      enterpriseUrl: "https://github.example",
      availableModelIds: ["model-a"],
    });
  });

  it("rejects malformed Pi core fields and timestamps but accepts expired OAuth", () => {
    for (const value of [
      "{",
      "[]",
      '{"openai-codex":{"type":"oauth","access":"a","expires":0}}',
      '{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":"soon"}}',
      '{"openai":{"type":"api_key","key":42}}',
    ])
      assert.ok(Option.isNone(parsePiAuthJsonOption(value)));
    assert.ok(
      Option.isSome(
        parsePiAuthJsonOption(
          '{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":0}}',
        ),
      ),
    );
  });

  it("decodes stored authority, strips unknown fields, and fails closed with a fixed error", () => {
    const secret = "stored-honeypot-secret";
    const decoded = decodeStoredCredential({
      ...storedCredential(),
      unknown: secret,
    });
    assert.ok(!("unknown" in decoded));
    assertFixedError(
      () =>
        decodeStoredCredential({
          providers: {
            openai: { credential: { type: "api_key", key: secret }, sentinel: "sentinel" },
          },
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
        expires_in: 3600,
        ignored: "strip-me",
      }),
      { accessToken: "next-access", expiresInSeconds: 3600 },
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
    const realExpires = 1_800_000_000_000;
    const stored = {
      ...storedCredential(),
      providers: {
        ...storedCredential().providers,
        "openai-codex": {
          credential: {
            type: "oauth" as const,
            access: realAccess,
            refresh: realRefresh,
            expires: realExpires,
            accountId: "honeypot-account",
          },
          sentinel: "scotty-pi-session-sentinel",
        },
        anthropic: {
          credential: {
            type: "oauth" as const,
            access: "honeypot-anthropic-access",
            refresh: "honeypot-anthropic-refresh",
            expires: 0,
          },
          sentinel: "scotty-pi-anthropic-sentinel",
        },
      },
      githubToken: realGithub,
    };
    const containerAuth = piAuthJson(stored);
    const provider = stored.providers["openai-codex"];
    assert.ok(provider);
    const refreshResult = JSON.stringify(oauthContainerResult(provider));
    const projected = Option.getOrThrow(parsePiAuthJsonOption(containerAuth));
    assert.strictEqual(
      projected["openai-codex"]?.type === "oauth" ? projected["openai-codex"].expires : undefined,
      realExpires,
    );
    assert.ok(containerAuth.includes(provider.sentinel));
    assert.ok(refreshResult.includes(provider.sentinel));
    assert.ok(!containerAuth.includes("anthropic"));
    for (const secret of [realAccess, realRefresh, realGithub, "honeypot-account"]) {
      assert.ok(!containerAuth.includes(secret));
      assert.ok(!refreshResult.includes(secret));
    }
  });
});

describe("Worker authentication", () => {
  it("accepts only a root bearer credential", async () => {
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
      false,
    );
    assert.strictEqual(
      await isAuthorizedRequest(new Request(`https://scotty.test/api?t=${token}`), token),
      false,
    );
  });
});
