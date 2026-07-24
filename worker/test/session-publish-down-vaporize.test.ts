import { assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import { ScottyError, type SessionRecord } from "../src/contracts";
import {
  createSessionHarness,
  type HarnessFailureStage,
  type HarnessOptions,
  lifecycleWallClock,
  makeResumeBackup,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const warmRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord =>
  makeSessionRecord({
    id: SESSION_ID,
    branch: `scotty/${SESSION_ID}`,
    codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    ...overrides,
  });

const authorityEntries = (
  record: SessionRecord = warmRecord(),
): Readonly<Record<string, unknown>> => ({
  [sessionHarnessKeys.record]: record,
  [sessionHarnessKeys.credential]: makeStoredCredential(),
});

const assertUpstream = (error: unknown): void => {
  assert.ok(error instanceof ScottyError);
  assert.strictEqual(error.code, "upstream");
};

const assertLeaseReleased = (record: SessionRecord | undefined): void => {
  assert.strictEqual(record?.status, "warm");
  assert.strictEqual(record?.operation, null);
};

describe("Sandbox publish orchestration", () => {
  it("publishes a clean existing repository without creating a commit", async () => {
    const harness = await createSessionHarness({
      initialEntries: authorityEntries(),
    });

    const result = await harness.sandbox.publishScottySession({
      title: "A focused change",
    });

    assert.deepStrictEqual(result, {
      prUrl: "https://github.com/anomalyco/rift/pull/123",
      branchUrl: `https://github.com/anomalyco/rift/tree/scotty/${SESSION_ID}`,
      created: true,
    });
    assert.ok(harness.commands.some((command) => command.includes("status --porcelain")));
    assert.ok(!harness.commands.some((command) => command.includes(" commit -m ")));
    assert.ok(harness.commands.some((command) => command.startsWith("gh pr create")));
    assertLeaseReleased(harness.readRecord());
  });

  it("commits a dirty worktree before push and PR creation", async () => {
    const harness = await createSessionHarness({
      commandStdout: (command) =>
        command.includes("status --porcelain") ? " M worker/src/index.ts\n" : undefined,
      initialEntries: authorityEntries(),
    });

    await harness.sandbox.publishScottySession({ title: "Commit dirty work" });

    const statusIndex = harness.commands.findIndex((command) =>
      command.includes("status --porcelain"),
    );
    const commitIndex = harness.commands.findIndex((command) => command.includes(" commit -m "));
    const pushIndex = harness.commands.findIndex((command) => command.includes(" push -u origin "));
    const prIndex = harness.commands.findIndex((command) => command.startsWith("gh pr create"));
    assert.ok(statusIndex < commitIndex);
    assert.ok(commitIndex < pushIndex);
    assert.ok(pushIndex < prIndex);
    assertLeaseReleased(harness.readRecord());
  });

  it("creates a missing repository privately and returns only the branch result", async () => {
    const missing = warmRecord({
      repo: "owner/new-private-repo",
      repoExistsAtCreate: false,
      defaultBranch: "main",
    });
    const harness = await createSessionHarness({
      initialEntries: authorityEntries(missing),
    });

    const result = await harness.sandbox.publishScottySession({});

    assert.deepStrictEqual(result, {
      branchUrl: `https://github.com/owner/new-private-repo/tree/scotty/${SESSION_ID}`,
      created: false,
    });
    assert.ok(
      harness.commands.some(
        (command) => command === "gh repo create 'owner/new-private-repo' --private",
      ),
    );
    assert.ok(harness.commands.some((command) => command.includes(" remote set-url origin ")));
    assert.ok(!harness.commands.some((command) => command.startsWith("gh pr create")));
    assertLeaseReleased(harness.readRecord());
  });

  it("maps a missing PR URL to upstream and still releases the lease", async () => {
    const harness = await createSessionHarness({
      commandStdout: (command) => (command.startsWith("gh pr create") ? "" : undefined),
      initialEntries: authorityEntries(),
    });

    const error = await rejection(harness.sandbox.publishScottySession({}));

    assertUpstream(error);
    assertLeaseReleased(harness.readRecord());
  });

  const failureCases = [
    {
      name: "status",
      options: {
        failureStage: "publishStatus",
        initialEntries: authorityEntries(),
      },
    },
    {
      name: "dirty commit",
      options: {
        commandStdout: (command: string) =>
          command.includes("status --porcelain") ? " M file\n" : undefined,
        failureStage: "publishCommit",
        initialEntries: authorityEntries(),
      },
    },
    {
      name: "private repository creation",
      options: {
        failureStage: "publishPrivateCreate",
        initialEntries: authorityEntries(warmRecord({ repoExistsAtCreate: false })),
      },
    },
    {
      name: "push",
      options: {
        failureStage: "publishPush",
        initialEntries: authorityEntries(),
      },
    },
    {
      name: "PR creation",
      options: {
        failureStage: "publishPrCreate",
        initialEntries: authorityEntries(),
      },
    },
  ] satisfies ReadonlyArray<{ readonly name: string; readonly options: HarnessOptions }>;

  for (const testCase of failureCases) {
    it(`releases the publish lease after injected ${testCase.name} failure`, async () => {
      const harness = await createSessionHarness(testCase.options);

      const error = await rejection(harness.sandbox.publishScottySession({}));

      assertUpstream(error);
      assertLeaseReleased(harness.readRecord());
      assert.ok(harness.events.includes("projection:warm"));
    });
  }
});

describe("Sandbox beam-down orchestration", () => {
  const rolloutPath =
    `/workspace/${SESSION_ID}/.codex/sessions/2026/07/24/` +
    "rollout-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl";

  const downStdout = (command: string): string | undefined => {
    if (command.includes("rev-parse HEAD")) return "abc123def456\n";
    if (command.startsWith("find ")) return `${rolloutPath}\n`;
    return undefined;
  };

  it("builds the exact manifest and tar members, then releases the lease", async () => {
    const harness = await createSessionHarness({
      commandStdout: downStdout,
      initialEntries: authorityEntries(),
    });

    const archive = await harness.sandbox.prepareDownArchive();

    assert.deepStrictEqual(archive, {
      path: `/tmp/scotty-${SESSION_ID}.tar`,
      filename: `scotty-${SESSION_ID}.tar`,
      manifest: {
        version: 1,
        id: SESSION_ID,
        repo: "anomalyco/rift",
        branch: `scotty/${SESSION_ID}`,
        sha: "abc123def456",
        codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        rolloutFile: "rollout-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl",
      },
    });
    const manifestWrite = harness.writtenFiles.find(({ path }) => path === "/tmp/metadata.json");
    assert.ok(manifestWrite !== undefined);
    assert.deepStrictEqual(JSON.parse(manifestWrite.content), archive.manifest);
    const tar = harness.commands.find((command) => command.startsWith("tar -cf "));
    assert.strictEqual(
      tar,
      `tar -cf '/tmp/scotty-${SESSION_ID}.tar' -C /tmp 'metadata.json' ` +
        `-C '/workspace/${SESSION_ID}/.codex/sessions/2026/07/24' ` +
        "'rollout-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl'",
    );
    assertLeaseReleased(harness.readRecord());
  });

  const failureCases = [
    "downSha",
    "downRollout",
    "downWriteManifest",
    "downTar",
  ] satisfies ReadonlyArray<HarnessFailureStage>;

  for (const stage of failureCases) {
    it(`releases the down lease after injected ${stage} failure`, async () => {
      const harness = await createSessionHarness({
        commandStdout: downStdout,
        failureStage: stage,
        initialEntries: authorityEntries(),
      });

      const error = await rejection(harness.sandbox.prepareDownArchive());

      assertUpstream(error);
      assertLeaseReleased(harness.readRecord());
      assert.ok(harness.events.includes("projection:warm"));
    });
  }
});

describe("Sandbox vaporize orchestration", () => {
  const vaporizeRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord =>
    warmRecord({
      backup: { current: makeResumeBackup() },
      backupExpiresAt: "2026-08-24T00:00:00.000Z",
      ownedBackupIds: ["backup-1", "backup-1", "backup-2"],
      failure: {
        code: "prior",
        message: "prior failure",
        recoverable: true,
      },
      ...overrides,
    });

  const backupObjects = [
    "backups/backup-1/archive",
    "backups/backup-1/meta.json",
    "backups/backup-2/archive",
    "backups/unowned/archive",
  ];

  it("cancels schedules in order, deduplicates backups, deletes credentials, and writes gone", async () => {
    const harness = await createSessionHarness({
      initialEntries: authorityEntries(vaporizeRecord()),
      initialProjections: {
        [`session:${SESSION_ID}`]: { id: SESSION_ID, status: "warm" },
      },
      r2Objects: backupObjects,
    });

    const result = await harness.sandbox.vaporizeScottySession();

    assert.deepStrictEqual(result, { id: SESSION_ID, status: "gone" });
    assert.deepStrictEqual(harness.deletedSchedules, [
      "retryVaporizeSession",
      "captureThreadId",
      "enforceHardCap",
      "expireTerminalAttachment",
      "finalizeManagedStop",
      "finalizeTerminalAttachment",
      "retryHardCapDestroy",
      "captureThreadId",
      "enforceHardCap",
      "expireTerminalAttachment",
      "finalizeManagedStop",
      "finalizeTerminalAttachment",
      "retryHardCapDestroy",
      "retryVaporizeSession",
    ]);
    assert.deepStrictEqual(harness.r2DeletedKeys, [
      ["backups/backup-1/archive", "backups/backup-1/meta.json"],
      ["backups/backup-2/archive"],
    ]);
    assert.strictEqual(harness.read(sessionHarnessKeys.credential), undefined);
    const gone = harness.readRecord();
    assert.strictEqual(gone?.status, "gone");
    assert.strictEqual(gone?.operation, null);
    assert.strictEqual(gone?.backup, undefined);
    assert.deepStrictEqual(gone?.ownedBackupIds, []);
    assert.strictEqual(gone?.backupExpiresAt, undefined);
    assert.strictEqual(gone?.codexThreadId, undefined);
    assert.strictEqual(gone?.failure, undefined);

    const destroyIndex = harness.events.indexOf("host:destroy");
    const backupIndex = harness.events.indexOf("r2:list:backups/backup-1/");
    const credentialIndex = harness.events.indexOf(
      `storage:delete:${sessionHarnessKeys.credential}`,
    );
    const goneIndex = harness.events.indexOf("record:gone");
    const projectionIndex = harness.events.indexOf(`projection:delete:session:${SESSION_ID}`);
    assert.ok(destroyIndex < backupIndex);
    assert.ok(backupIndex < credentialIndex);
    assert.ok(credentialIndex < goneIndex);
    assert.ok(goneIndex < projectionIndex);
  });

  it("retryVaporizeSession is idempotent after the gone tombstone is durable", async () => {
    const gone = vaporizeRecord({
      status: "gone",
      operation: null,
      backup: undefined,
      backupExpiresAt: undefined,
      ownedBackupIds: [],
      failure: undefined,
    });
    const harness = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.record]: gone },
      initialProjections: {
        [`session:${SESSION_ID}`]: { id: SESSION_ID, status: "warm" },
      },
    });

    await harness.sandbox.retryVaporizeSession({
      id: SESSION_ID,
      nonce: "gone",
    });

    assert.deepStrictEqual(harness.readRecord(), gone);
    assert.ok(harness.events.includes(`projection:delete:session:${SESSION_ID}`));
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["retryVaporizeSession"],
    );
  });

  it("preserves a changed vaporize lease and surfaces conflict without destroying", async () => {
    const original = vaporizeRecord({
      operation: {
        kind: "vaporize",
        nonce: "original",
        startedAt: lifecycleWallClock.nowIso(),
      },
    });
    const changed = {
      ...original,
      operation: {
        kind: "vaporize" as const,
        nonce: "changed",
        startedAt: lifecycleWallClock.nowIso(),
      },
    };
    const harness = await createSessionHarness({
      initialEntries: authorityEntries(original),
      onStorageGet: (key, count, memory) => {
        if (key === sessionHarnessKeys.record && count === 1)
          memory.values.set(key, structuredClone(changed));
      },
    });

    const error = await rejection(harness.sandbox.vaporizeScottySession());

    assertUpstream(error);
    assert.deepStrictEqual(harness.readRecord(), changed);
    assert.ok(!harness.events.includes("host:destroy"));
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["retryVaporizeSession"],
    );
  });

  it("aborts and re-arms retry when destroy exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createSessionHarness({
        destroyBehavior: "pending",
        initialEntries: authorityEntries(vaporizeRecord()),
      });

      const operation = rejection(harness.sandbox.vaporizeScottySession());
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await operation;

      assertUpstream(error);
      assert.strictEqual(harness.readRecord()?.operation?.kind, "vaporize");
      assert.deepStrictEqual(harness.aborts, ["Sandbox destroy exceeded 30000ms"]);
      assert.deepStrictEqual(
        harness.schedules.map((schedule) => schedule.callback),
        ["retryVaporizeSession", "retryVaporizeSession"],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs projection removal from a gone tombstone after injected failure", async () => {
    const gone = vaporizeRecord({
      status: "gone",
      operation: null,
      backup: undefined,
      backupExpiresAt: undefined,
      ownedBackupIds: [],
      failure: undefined,
    });
    const harness = await createSessionHarness({
      failureStage: "projectionDelete",
      initialEntries: { [sessionHarnessKeys.record]: gone },
      initialProjections: {
        [`session:${SESSION_ID}`]: { id: SESSION_ID, status: "warm" },
      },
    });

    const error = await rejection(harness.sandbox.vaporizeScottySession());
    assertUpstream(error);
    assert.strictEqual(harness.readRecord()?.status, "gone");
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["retryVaporizeSession"],
    );

    harness.clearFailure("projectionDelete");
    await harness.sandbox.retryVaporizeSession({ id: SESSION_ID, nonce: "gone" });
    assert.ok(harness.events.includes(`projection:delete:session:${SESSION_ID}`));
  });

  for (const testCase of [
    {
      name: "terminal attachment cleanup",
      options: {
        failureStage: "terminalAttachmentCleanup",
        initialEntries: authorityEntries(vaporizeRecord()),
      },
    },
    {
      name: "runtime destroy",
      options: {
        failureStage: "vaporizeDestroy",
        initialEntries: authorityEntries(vaporizeRecord()),
      },
    },
    {
      name: "backup list",
      options: {
        failureStage: "backupList",
        initialEntries: authorityEntries(vaporizeRecord()),
        r2Objects: backupObjects,
      },
    },
    {
      name: "backup delete",
      options: {
        failureStage: "backupDelete",
        initialEntries: authorityEntries(vaporizeRecord()),
        r2Objects: backupObjects,
      },
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly options: HarnessOptions;
  }>) {
    it(`keeps a durable vaporize lease and retry after injected ${testCase.name} failure`, async () => {
      const harness = await createSessionHarness(testCase.options);

      const error = await rejection(harness.sandbox.vaporizeScottySession());

      assertUpstream(error);
      const partial = harness.readRecord();
      assert.strictEqual(partial?.operation?.kind, "vaporize");
      const nonce = partial?.operation?.nonce;
      assert.ok(nonce !== undefined);
      assert.deepStrictEqual(
        harness.schedules.map((schedule) => schedule.callback),
        ["retryVaporizeSession"],
      );

      harness.clearFailure();
      await harness.sandbox.retryVaporizeSession({ id: SESSION_ID, nonce });
      assert.strictEqual(harness.readRecord()?.status, "gone");
    });
  }

  it("retries safely after credential deletion fails", async () => {
    const harness = await createSessionHarness({
      initialEntries: authorityEntries(vaporizeRecord({ ownedBackupIds: [], backup: undefined })),
      transactionFailureCountdown: 1,
    });

    const error = await rejection(harness.sandbox.vaporizeScottySession());
    assertUpstream(error);
    const nonce = harness.readRecord()?.operation?.nonce;
    assert.ok(nonce !== undefined);
    assert.notStrictEqual(harness.read(sessionHarnessKeys.credential), undefined);

    await harness.sandbox.retryVaporizeSession({ id: SESSION_ID, nonce });
    assert.strictEqual(harness.readRecord()?.status, "gone");
    assert.strictEqual(harness.read(sessionHarnessKeys.credential), undefined);
  });

  it("retries safely after gone-tombstone persistence fails", async () => {
    const harness = await createSessionHarness({
      initialEntries: authorityEntries(vaporizeRecord({ ownedBackupIds: [], backup: undefined })),
      transactionFailureCountdown: 2,
    });

    const error = await rejection(harness.sandbox.vaporizeScottySession());
    assertUpstream(error);
    const partial = harness.readRecord();
    assert.strictEqual(partial?.operation?.kind, "vaporize");
    const nonce = partial?.operation?.nonce;
    assert.ok(nonce !== undefined);
    assert.strictEqual(harness.read(sessionHarnessKeys.credential), undefined);

    await harness.sandbox.retryVaporizeSession({ id: SESSION_ID, nonce });
    assert.strictEqual(harness.readRecord()?.status, "gone");
  });

  it("releases the vaporize lease when initial retry arming fails so a later call can resume", async () => {
    const harness = await createSessionHarness({
      failureStage: "vaporizeRetrySchedule",
      initialEntries: authorityEntries(vaporizeRecord()),
    });

    const error = await rejection(harness.sandbox.vaporizeScottySession());

    assertUpstream(error);
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.deepStrictEqual(harness.schedules, []);
    assert.ok(!harness.events.includes("host:destroy"));

    harness.clearFailure("vaporizeRetrySchedule");
    const result = await harness.sandbox.vaporizeScottySession();
    assert.deepStrictEqual(result, { id: SESSION_ID, status: "gone" });
    assert.strictEqual(harness.readRecord()?.status, "gone");
  });
});
