import { assert, describe, it } from "@effect/vitest";
import { createDeterministicTarGz } from "../../cli/src/sandbox-archive";
import { ScottyError } from "../src/contracts";
import { isSessionEnvironmentSnapshot } from "../src/environment-contracts";
import {
  createSessionHarness,
  type InitialStorageEntries,
  makeResumeBackup,
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
        [sessionHarnessKeys.record]: sleepingRecord({
          piSessionTransportToken: transportToken,
        }),
      },
    });

    const resumed = await harness.sandbox.resumeScottySession();

    assert.strictEqual(resumed.status, "warm");
    const record = harness.readRecord();
    assert.strictEqual(record?.status, "warm");
    assert.strictEqual(record?.operation, null);
    assert.strictEqual(record?.failure, undefined);
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
        [sessionHarnessKeys.record]: sleepingRecord({ environment: legacy }),
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
    const sentinel = environment.variables.API_TOKEN;
    assert.strictEqual(environment.version, 1);
    assert.ok(sentinel?.startsWith(`scotty-env-${SESSION_ID}-`));
    assert.notInclude(JSON.stringify(record), legacySecret);
    assert.notInclude(JSON.stringify(record), removedLegacySecret);
    assert.notProperty(environment.variables, "REMOVED_TOKEN");
    assert.strictEqual(harness.appliedEnvironments[0]?.RELEASE_CHANNEL, "new-global");
    assert.strictEqual(harness.appliedEnvironments[0]?.API_TOKEN, sentinel);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments[0]), legacySecret);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments[0]), removedLegacySecret);
    assert.notInclude(JSON.stringify(harness.writtenFiles), legacySecret);
    assert.notInclude(JSON.stringify(harness.writtenFiles), removedLegacySecret);
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), legacySecret);
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), removedLegacySecret);
  });
  it("replays a versioned snapshot without rematerializing installation environment", async () => {
    const retainedSecret = "retained-secret";
    const retainedSentinel = `scotty-env-${SESSION_ID}-${"a".repeat(32)}`;
    const staleSentinel = `scotty-env-${SESSION_ID}-${"b".repeat(32)}`;
    const githubSentinel = `scotty-env-${SESSION_ID}-${"c".repeat(32)}`;
    const openaiSentinel = `scotty-env-${SESSION_ID}-${"d".repeat(32)}`;
    const retained = {
      version: 1 as const,
      revision: 4,
      variables: {
        RELEASE_CHANNEL: "retained",
        API_TOKEN: retainedSentinel,
        GH_TOKEN: githubSentinel,
        OPENAI_API_KEY: openaiSentinel,
      },
    };
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: sleepingRecord({ environment: retained }),
        [sessionHarnessKeys.environmentVault]: {
          version: 1,
          entries: {
            [retainedSentinel]: {
              sentinel: retainedSentinel,
              sourceScope: "global",
              name: "API_TOKEN",
              value: retainedSecret,
            },
            [staleSentinel]: {
              sentinel: staleSentinel,
              sourceScope: "global",
              name: "STALE_TOKEN",
              value: "stale-secret",
            },
            [githubSentinel]: {
              sentinel: githubSentinel,
              sourceScope: "global",
              name: "GH_TOKEN",
              value: "authority-github-token",
            },
            [openaiSentinel]: {
              sentinel: openaiSentinel,
              sourceScope: "global",
              name: "OPENAI_API_KEY",
              value: "authority-openai-key",
            },
          },
        },
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
    assert.strictEqual(harness.appliedEnvironments[0]?.API_TOKEN, retainedSentinel);
    assert.strictEqual(harness.piProcessEnvironments[0]?.RELEASE_CHANNEL, "retained");
    assert.strictEqual(harness.piProcessEnvironments[0]?.API_TOKEN, retainedSentinel);
    assert.deepStrictEqual(harness.read(sessionHarnessKeys.environmentVault), {
      version: 1,
      entries: {
        [retainedSentinel]: {
          sentinel: retainedSentinel,
          sourceScope: "global",
          name: "API_TOKEN",
          value: retainedSecret,
        },
        [githubSentinel]: {
          sentinel: githubSentinel,
          sourceScope: "global",
          name: "GH_TOKEN",
          value: "authority-github-token",
        },
        [openaiSentinel]: {
          sentinel: openaiSentinel,
          sourceScope: "global",
          name: "OPENAI_API_KEY",
          value: "authority-openai-key",
        },
      },
    });
  });

  it("rematerializes the pinned sandbox bundle after backup restore", async () => {
    const digest = EMPTY_ADDITIONS_DIGEST;
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: sleepingRecord({
          sandboxBundle: { digest, manifestVersion: 1 },
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
      name: "ready state persist",
      options: {
        initialEntries: resumeEntries(),
        transactionFailureCountdown: 2,
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
