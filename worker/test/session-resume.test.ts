import { assert, describe, it } from "@effect/vitest";
import { createDeterministicTarGz } from "../../cli/src/sandbox-archive";
import { ScottyError } from "../src/contracts";
import {
  createSessionHarness,
  type InitialStorageEntries,
  makeResumeBackup,
  makeStoredCredential,
  type HarnessFailureStage,
  type HarnessOptions,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const EMPTY_ADDITIONS_DIGEST = createDeterministicTarGz([
  {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: new TextEncoder().encode('{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
  },
]).digest;

const sleepingRecord = (overrides: Parameters<typeof makeSessionRecord>[0] = {}) =>
  makeSessionRecord({
    id: SESSION_ID,
    status: "sleeping",
    branch: `scotty/${SESSION_ID}`,
    backup: { current: makeResumeBackup() },
    ownedBackupIds: ["backup-1"],
    codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    ...overrides,
  });

const resumeEntries = (): InitialStorageEntries => ({
  [sessionHarnessKeys.record]: sleepingRecord(),
  [sessionHarnessKeys.credential]: makeStoredCredential(),
});

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const assertUpstreamFailure = async (operation: Promise<unknown>): Promise<void> => {
  const error = await rejection(operation);
  assert.ok(error instanceof ScottyError);
  assert.strictEqual(error.code, "upstream");
};

describe("Sandbox resume orchestration", () => {
  it("restores the current backup, reseeds runtime state, and reaches warm", async () => {
    const harness = await createSessionHarness({ initialEntries: resumeEntries() });

    const resumed = await harness.sandbox.resumeScottySession();

    assert.strictEqual(resumed.status, "warm");
    const record = harness.readRecord();
    assert.strictEqual(record?.status, "warm");
    assert.strictEqual(record?.operation, null);
    assert.strictEqual(record?.failure, undefined);
    assert.strictEqual(record?.backup?.current.id, "backup-1");
    const hardCapIndex = harness.events.indexOf("schedule:enforceHardCap");
    const restoreIndex = harness.events.indexOf("host:restoreBackup");
    const authIndex = harness.events.indexOf("host:mkdir");
    const warmIndex = harness.events.lastIndexOf("record:warm");
    assert.ok(hardCapIndex >= 0);
    assert.ok(hardCapIndex < restoreIndex);
    assert.ok(restoreIndex < authIndex);
    assert.ok(authIndex < warmIndex);
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["enforceHardCap"],
    );
    assert.deepStrictEqual(harness.aborts, []);
  });

  it("rematerializes the pinned sandbox bundle after backup restore", async () => {
    const digest = EMPTY_ADDITIONS_DIGEST;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: sleepingRecord({
          sandboxBundle: { digest, manifestVersion: 1 },
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });

    const resumed = await harness.sandbox.resumeScottySession();

    assert.strictEqual(resumed.status, "warm");
    const restoreIndex = harness.events.indexOf("host:restoreBackup");
    const mkdirIndex = harness.events.indexOf("host:mkdir");
    assert.ok(restoreIndex >= 0);
    assert.ok(mkdirIndex > restoreIndex);
    assert.ok(
      harness.writtenFiles.some(
        (file) => file.path.includes("/.scotty/sandbox/") && file.path.endsWith("/manifest.json"),
      ),
    );
    assert.ok(
      harness.writtenFiles.some(
        (file) => file.path.includes("/.scotty/sandbox/") && file.path.endsWith("/.verified"),
      ),
    );
    assert.ok(harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.deepStrictEqual(harness.readRecord()?.sandboxBundle, {
      digest,
      manifestVersion: 1,
    });
    assert.deepStrictEqual(resumed.sandboxBundle, { digest, manifestVersion: 1 });
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
  });

  it("does not reach warm when the pinned sandbox bundle is missing", async () => {
    const digest = "a".repeat(64);
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: sleepingRecord({
          sandboxBundle: { digest, manifestVersion: 1 },
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      seedPinnedSandboxBundle: false,
    });

    await assertUpstreamFailure(harness.sandbox.resumeScottySession());

    const failed = harness.readRecord();
    assert.notStrictEqual(failed?.status, "warm");
    assert.deepStrictEqual(failed?.failure, {
      code: "resume_failed",
      message: "Session restore failed",
      recoverable: true,
    });
    assert.deepStrictEqual(failed?.sandboxBundle, { digest, manifestVersion: 1 });
    assert.ok(!harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
  });

  it("rejects resume without a current backup and releases the lease", async () => {
    const withoutBackup = makeSessionRecord({
      id: SESSION_ID,
      status: "sleeping",
      branch: `scotty/${SESSION_ID}`,
    });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: withoutBackup,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });

    const error = await rejection(harness.sandbox.resumeScottySession());
    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "wrong_state");
    assert.strictEqual(error.hint, "No successful backup is available");
    const persisted = harness.readRecord();
    assert.strictEqual(persisted?.status, "sleeping");
    assert.strictEqual(persisted?.operation, null);
    assert.strictEqual(persisted?.failure, undefined);
    assert.deepStrictEqual(harness.schedules, []);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  const failureCases = [
    {
      name: "hard-cap schedule",
      options: {
        initialEntries: resumeEntries(),
        failureStage: "hardCapSchedule" satisfies HarnessFailureStage,
      },
    },
    {
      name: "backup restore",
      options: {
        initialEntries: resumeEntries(),
        failureStage: "restoreBackup" satisfies HarnessFailureStage,
      },
    },
    {
      name: "credential require",
      options: {
        initialEntries: resumeEntries(),
        transactionFailureCountdown: 3,
      },
    },
    {
      name: "container auth seed",
      options: {
        initialEntries: resumeEntries(),
        failureStage: "containerAuthSeed" satisfies HarnessFailureStage,
      },
    },
  ] satisfies ReadonlyArray<{ readonly name: string; readonly options: HarnessOptions }>;

  for (const testCase of failureCases) {
    it(`persists backup-recoverable failed state and destroys after ${testCase.name} failure`, async () => {
      const harness = await createSessionHarness(testCase.options);

      await assertUpstreamFailure(harness.sandbox.resumeScottySession());

      const failed = harness.readRecord();
      assert.strictEqual(failed?.status, "failed");
      assert.strictEqual(failed?.operation, null);
      assert.deepStrictEqual(failed?.failure, {
        code: "resume_failed",
        message: "Session restore failed",
        recoverable: true,
      });
      assert.strictEqual(failed?.backup?.current.id, "backup-1");
      assert.ok(harness.events.includes("projection:failed"));
      assert.ok(harness.events.includes("host:destroy"));
      assert.ok(harness.events.indexOf("record:failed") < harness.events.indexOf("host:destroy"));
    });
  }
});
