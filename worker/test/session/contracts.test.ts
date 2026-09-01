import { assert, describe, it } from "@effect/vitest";
import {
  formatManagedHandle,
  parseManagedHandle,
  type CredentialGrant,
} from "../../../protocol/credentials";
import { Effect, Option, Result } from "effect";
import { isAuthorizedRequest } from "../../src/auth/request";
import {
  badRequest,
  conflict,
  decodePublicError,
  decodeSessionProjection,
  decodeSessionRecordResult,
  decodeStatsResponse,
  decodeWorkspaceCreationMarker,
  notFound,
  parseCreateInput,
  parseRenameSessionInput,
  parseSessionId,
  ScottyError,
  toProjection,
  toSessionView,
  wrongState,
  type SessionRecord,
} from "../../src/session/contracts";
import {
  githubManagedHandle,
  piAccessHandle,
  piApiKeyHandle,
  sessionRuntimeCredentials,
} from "../../src/credentials/managed";

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
        newRepo: false,
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
    for (const repo of ["./project", "../project", "owner/.", "owner/.."]) {
      assert.throws(
        () =>
          parseCreateInput({
            title: "Ship dashboard",
            prompt: "ship it",
            provider: "cloudflare",
            repo,
          }),
        /repo must be in owner\/name form/u,
      );
    }
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
      sandboxBundle: { digest: null },
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
      sandboxBundle: { digest: null },
    };
    assert.deepInclude(toSessionView(projection, Date.parse("2026-01-01T00:00:01.999Z")), {
      ageSeconds: 1,
      capRemainingSeconds: 1,
    });
  });
});

const derivedRecord = {
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
  sandboxBundle: { digest: null },
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

describe("derived session context schemas", () => {
  it("decodes the exact actor-derived context", () => {
    const decoded = decodeSessionRecordResult(derivedRecord);
    assert.ok(Result.isSuccess(decoded));
    assert.deepStrictEqual(decoded.success, derivedRecord);
    const withOptionalUndefined = {
      ...derivedRecord,
      backup: { ...derivedRecord.backup, previous: undefined },
      backupExpiresAt: undefined,
      codexThreadId: undefined,
      failure: undefined,
    };
    const optional = decodeSessionRecordResult(withOptionalUndefined);
    assert.ok(Result.isSuccess(optional));
    assert.deepStrictEqual(optional.success, withOptionalUndefined);
  });

  it("fails closed for missing, malformed, and excess derived context", () => {
    for (const malformed of [
      { ...derivedRecord, title: undefined },
      { ...derivedRecord, status: "unknown" },
      { ...derivedRecord, operation: undefined },
      {
        ...derivedRecord,
        operation: {
          kind: "create",
          nonce: "private",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      },
      {
        ...derivedRecord,
        operation: {
          kind: "create",
          nonce: "private",
          startedAt: "2026-01-01T00:00:01.000Z",
          createPhase: "unknown",
        },
      },
      {
        ...derivedRecord,
        operation: {
          kind: "resume",
          nonce: "private",
          startedAt: "2026-01-01T00:00:01.000Z",
          createPhase: "setup",
        },
      },
      { ...derivedRecord, secret: "excess" },
      {
        ...derivedRecord,
        backup: { current: { ...derivedRecord.backup.current, secret: "nested excess" } },
      },
    ]) {
      const decoded = decodeSessionRecordResult(malformed);
      assert.ok(Result.isFailure(decoded));
    }
  });

  it("rejects malformed sandbox bundle digests", () => {
    const decoded = decodeSessionRecordResult({
      ...derivedRecord,
      sandboxBundle: { digest: "not-a-digest" },
    });
    assert.ok(Result.isFailure(decoded));
  });

  it("derives sandbox bundle pins in projections without exposing bundle contents", () => {
    const digest = "c".repeat(64);
    const record: SessionRecord = {
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
      sandboxBundle: { digest },
    };
    const projection = toProjection(record, new Date("2026-01-01T00:00:02.000Z"));
    assert.deepStrictEqual(projection.sandboxBundle, { digest });
    assert.ok(!("skills" in projection));
    assert.ok(!("piPackages" in projection));
  });

  it("strips projection extras and skips malformed projections", () => {
    const projection = {
      id: derivedRecord.id,
      title: derivedRecord.title,
      status: derivedRecord.status,
      provider: derivedRecord.provider,
      repo: derivedRecord.repo,
      defaultBranch: derivedRecord.defaultBranch,
      branch: derivedRecord.branch,
      createdAt: derivedRecord.createdAt,
      updatedAt: derivedRecord.updatedAt,
      hardCapAt: derivedRecord.hardCapAt,
      projectedAt: derivedRecord.updatedAt,
      sandboxBundle: derivedRecord.sandboxBundle,
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
describe("managed credential handles", () => {
  const grants: ReadonlyArray<CredentialGrant> = [
    {
      name: "openai",
      kind: "pi-auth",
      versionRef: "version-a",
      handleSlots: [
        { provider: "openai", slot: "api-key" },
        { provider: "openai-codex", slot: "access" },
      ],
      expires: 1_795_000_123_456,
    },
    {
      name: "github",
      kind: "github-cli",
      versionRef: "version-b",
      handleSlots: [{ provider: "github", slot: "git-https" }],
    },
  ];

  it("derives fixed handles only from granted slots", () => {
    assert.strictEqual(piApiKeyHandle(grants), "scotty-managed://openai/openai/api-key");
    assert.strictEqual(piAccessHandle(grants), "scotty-managed://openai/openai-codex/access");
    assert.strictEqual(githubManagedHandle(grants), "scotty-managed://github/github/git-https");
    assert.deepStrictEqual(sessionRuntimeCredentials(grants).piProviders, [
      "openai",
      "openai-codex",
    ]);

    const ungranted = grants.filter(({ name }) => name !== "github");
    assert.isUndefined(githubManagedHandle(ungranted));
  });

  it("accepts only canonical managed handles", () => {
    const handle = { name: "openai", provider: "openai-codex", slot: "access" } as const;
    assert.strictEqual(formatManagedHandle(handle), "scotty-managed://openai/openai-codex/access");
    assert.deepStrictEqual(parseManagedHandle(formatManagedHandle(handle)), Option.some(handle));
    for (const malformed of [
      "not-a-managed-handle",
      "scotty-managed://openai/openai-codex/access/extra",
      "scotty-managed://OpenAI/openai-codex/access",
      "scotty-managed://openai/openai-codex/api_key",
      "scotty-managed://openai/openai-codex/access%2Fextra",
    ])
      assert.ok(Option.isNone(parseManagedHandle(malformed)));
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
