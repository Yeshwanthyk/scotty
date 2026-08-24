import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import {
  isSessionEnvironmentSnapshot,
  ENVIRONMENT_INJECTED_PLACEHOLDER,
} from "../src/environment-contracts";
import {
  createSessionHarness,
  type InitialStorageEntries,
  makeResumeBackup,
  type HarnessFailureStage,
  type HarnessOptions,
  SESSION_ID,
  sessionHarnessKeys,
  TEST_SANDBOX_SNAPSHOT,
} from "./session-harness";
import { makeSessionRecord, sessionOperationFailure } from "./support";

const stoppedRecord = (overrides: Parameters<typeof makeSessionRecord>[0] = {}) =>
  makeSessionRecord({
    id: SESSION_ID,
    status: "stopped",
    branch: `scotty/${SESSION_ID}`,
    backup: { current: makeResumeBackup() },
    ownedBackupIds: ["backup-1"],
    codexThreadId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    ...overrides,
  });

const resumeEntries = (): InitialStorageEntries => ({
  [sessionHarnessKeys.record]: stoppedRecord(),
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
    const transportToken = "e".repeat(64);
    const harness = await createSessionHarness({
      initialEntries: {
        ...resumeEntries(),
        [sessionHarnessKeys.record]: stoppedRecord({
          piSessionTransportToken: transportToken,
        }),
      },
    });

    const resumed = await harness.sandbox.resumeScottySession();

    assert.strictEqual(resumed.status, "warm");
    const record = harness.readRecord();
    assert.strictEqual(record?.status, "warm");
    assert.strictEqual(record?.operation, null);
    assert.strictEqual(sessionOperationFailure(record), undefined);
    assert.strictEqual(record?.backup?.current.id, "backup-1");
    assert.strictEqual(record?.piSessionTransportToken, transportToken);
    assert.strictEqual(
      harness.writtenFiles.find(
        (file) => file.path === `/tmp/scotty-pi-session-${SESSION_ID}.token`,
      )?.content,
      transportToken,
    );
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

  it("rematerializes a legacy snapshot without exposing its secret to runtime state", async () => {
    const legacySecret = "real-secret";
    const removedLegacySecret = "removed-real-secret";
    const legacy = {
      revision: 4,
      variables: {
        RELEASE_CHANNEL: "retained",
        API_TOKEN: legacySecret,
        REMOVED_TOKEN: removedLegacySecret,
      },
    };
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: stoppedRecord({ environment: legacy }),
      },
      environmentMaterialization: {
        revision: 5,
        variables: {
          RELEASE_CHANNEL: {
            value: "new-global",
            secret: false,
            updatedAt: "two",
            sourceScope: "global",
          },
          API_TOKEN: {
            value: "new-secret",
            secret: true,
            updatedAt: "two",
            sourceScope: "global",
          },
        },
      },
    });

    await harness.sandbox.resumeScottySession();

    const record = harness.readRecord();
    const environment = record?.environment;
    assert.ok(isSessionEnvironmentSnapshot(environment));
    assert.strictEqual(environment.version, 1);
    assert.strictEqual(environment.variables.API_TOKEN, ENVIRONMENT_INJECTED_PLACEHOLDER);
    assert.notInclude(JSON.stringify(record), legacySecret);
    assert.notInclude(JSON.stringify(record), removedLegacySecret);
    assert.notProperty(environment.variables, "REMOVED_TOKEN");
    assert.strictEqual(harness.appliedEnvironments[0]?.RELEASE_CHANNEL, "new-global");
    assert.strictEqual(harness.appliedEnvironments[0]?.API_TOKEN, ENVIRONMENT_INJECTED_PLACEHOLDER);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments[0]), legacySecret);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments[0]), removedLegacySecret);
    assert.notInclude(JSON.stringify(harness.writtenFiles), legacySecret);
    assert.notInclude(JSON.stringify(harness.writtenFiles), removedLegacySecret);
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), legacySecret);
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), removedLegacySecret);
  });
  it("replays a versioned snapshot without rematerializing installation environment", async () => {
    const retained = {
      version: 1 as const,
      revision: 4,
      variables: {
        RELEASE_CHANNEL: "retained",
        API_TOKEN: ENVIRONMENT_INJECTED_PLACEHOLDER,
        GH_TOKEN: ENVIRONMENT_INJECTED_PLACEHOLDER,
        OPENAI_API_KEY: ENVIRONMENT_INJECTED_PLACEHOLDER,
        OPENCODE_API_KEY: ENVIRONMENT_INJECTED_PLACEHOLDER,
      },
    };
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: stoppedRecord({ environment: retained }),
      },
      environmentMaterialization: {
        revision: 5,
        variables: {
          RELEASE_CHANNEL: {
            value: "new-global",
            secret: false,
            updatedAt: "newer",
            sourceScope: "global",
          },
          API_TOKEN: {
            value: "new-secret",
            secret: true,
            updatedAt: "newer",
            sourceScope: "global",
          },
        },
      },
    });

    await harness.sandbox.resumeScottySession();

    assert.deepStrictEqual(harness.readRecord()?.environment, retained);
    assert.deepStrictEqual(harness.environmentSnapshotRepos, []);
    assert.strictEqual(harness.appliedEnvironments[0]?.RELEASE_CHANNEL, "retained");
    assert.strictEqual(harness.appliedEnvironments[0]?.API_TOKEN, ENVIRONMENT_INJECTED_PLACEHOLDER);
    assert.strictEqual(harness.piProcessEnvironments[0]?.RELEASE_CHANNEL, "retained");
    assert.strictEqual(
      harness.piProcessEnvironments[0]?.API_TOKEN,
      ENVIRONMENT_INJECTED_PLACEHOLDER,
    );
  });

  it("rematerializes the pinned sandbox bundle after backup restore", async () => {
    const { digest, revision } = TEST_SANDBOX_SNAPSHOT;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: stoppedRecord({
          sandboxBundle: { revision, digest, manifestVersion: 1 },
        }),
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
      revision,
      digest,
      manifestVersion: 1,
    });
    assert.deepStrictEqual(resumed.sandboxBundle, { revision, digest, manifestVersion: 1 });
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
  });

  it("does not reach warm when the pinned sandbox bundle is missing", async () => {
    const { digest, revision } = TEST_SANDBOX_SNAPSHOT;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: stoppedRecord({
          sandboxBundle: { revision, digest, manifestVersion: 1 },
        }),
      },
      seedPinnedSandboxBundle: false,
    });

    await assertUpstreamFailure(harness.sandbox.resumeScottySession());

    const failed = harness.readRecord();
    assert.notStrictEqual(failed?.status, "warm");
    assert.deepStrictEqual(sessionOperationFailure(failed), {
      code: "resume_failed",
      message: "Session restore failed",
    });
    assert.deepStrictEqual(failed?.sandboxBundle, { revision, digest, manifestVersion: 1 });
    assert.ok(!harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
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
      name: "ready state persist",
      options: {
        initialEntries: resumeEntries(),
        transactionFailureCountdown: 5,
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
      assert.strictEqual(failed?.status, "stopped");
      assert.strictEqual(failed?.operation, null);
      assert.deepStrictEqual(sessionOperationFailure(failed), {
        code: "resume_failed",
        message: "Session restore failed",
      });
      assert.strictEqual(failed?.backup?.current.id, "backup-1");
      assert.ok(harness.events.includes("projection:stopped"));
      assert.ok(harness.events.includes("host:destroy"));
      assert.ok(
        harness.events.indexOf("host:destroy") < harness.events.lastIndexOf("record:stopped"),
      );
    });
  }
});
