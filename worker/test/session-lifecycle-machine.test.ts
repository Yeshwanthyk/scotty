import { assert, describe, it } from "@effect/vitest";
import { Cause, Clock, Effect, Fiber, Predicate } from "effect";
import { TestClock } from "effect/testing";
import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerOperation,
  type RunnerResult,
} from "../../protocol/runner";
import { ScottyError, type SessionRecord } from "../src/contracts";
import type { RunnerDispatchResult } from "../src/runner-transport";
import { CheckpointRuntimeUnavailable, withCheckpointRuntimeRestore } from "../src/session";
import {
  createSessionHarness,
  type HarnessOptions,
  makeResumeBackup,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const TEST_TIME = Date.parse("2026-07-24T12:00:00.000Z");

const createTestHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(TEST_TIME);
    const clock = yield* Clock.Clock;
    return yield* Effect.promise(() => createSessionHarness({ ...options, clock }));
  });

const currentTestTime = Effect.succeed(TEST_TIME);

const isoAt = (milliseconds: number): string => new Date(milliseconds).toISOString();

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const managedStopRecord = (
  now: number,
  operationOverrides: Partial<NonNullable<ReturnType<typeof makeSessionRecord>["operation"]>> = {},
) =>
  makeSessionRecord({
    id: SESSION_ID,
    branch: `scotty/${SESSION_ID}`,
    backup: { current: makeResumeBackup() },
    ownedBackupIds: ["backup-1"],
    operation: {
      kind: "snapshot",
      nonce: "managed-stop",
      startedAt: isoAt(now - 60_000),
      checkpointedBackupId: "backup-1",
      ...operationOverrides,
    },
  });

const runnerRecord = (overrides: Partial<SessionRecord> = {}) =>
  makeSessionRecord({
    provider: "runner",
    runner: "slumbers",
    execution: {
      provider: "runner",
      runner: "slumbers",
      runtimeId: `runner-v1:${SESSION_ID}`,
    },
    codexThreadId: "thread-1",
    ...overrides,
  });

const runnerSuccess = (operation: RunnerOperation, result: RunnerResult): RunnerDispatchResult => ({
  ok: true,
  response: {
    _tag: "RunnerSuccess",
    version: RUNNER_PROTOCOL_VERSION,
    operationId: operation.operationId,
    sessionId: operation.sessionId,
    result,
  },
});

const runnerDispatchFailure = (): RunnerDispatchResult => ({
  ok: false,
  error: {
    code: "runner_timeout",
    message: "Runner operation timed out",
  },
});

describe("Sandbox lifecycle machine", () => {
  it.effect("stops and resumes a retained runner runtime without a Cloudflare checkpoint", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: runnerRecord(),
        },
      });

      const sleeping = yield* Effect.promise(() => harness.sandbox.sleepScottySession());

      assert.strictEqual(sleeping.status, "sleeping");
      assert.strictEqual(harness.readRecord()?.status, "sleeping");
      assert.strictEqual(harness.runnerOperations.length, 1);
      assert.ok(Predicate.isTagged("StopRuntime")(harness.runnerOperations[0]));
      assert.ok(!harness.events.includes("host:stop"));
      assert.ok(!harness.events.some((event) => event.startsWith("backup:")));

      const resumed = yield* Effect.promise(() => harness.sandbox.resumeScottySession());

      assert.strictEqual(resumed.status, "warm");
      assert.strictEqual(resumed.codexThreadId, "thread-1");
      assert.strictEqual(harness.readRecord()?.operation, null);
      assert.strictEqual(harness.runnerOperations.length, 3);
      assert.ok(Predicate.isTagged("StopRuntime")(harness.runnerOperations[0]));
      assert.ok(Predicate.isTagged("EnsureRuntime")(harness.runnerOperations[1]));
      const picanLaunch = harness.runnerOperations[2];
      assert.ok(Predicate.isTagged("ExecRuntime")(picanLaunch));
      assert.strictEqual(picanLaunch.detach, true);
      assert.ok(
        harness.runnerRequests.some((request) =>
          new URL(request.url).pathname.endsWith("/api/settings"),
        ),
      );
    }),
  );

  it.effect("stops an idle runner into sleeping without a Cloudflare checkpoint", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: runnerRecord(),
        },
      });

      yield* Effect.promise(() => harness.sandbox.onActivityExpired());

      assert.strictEqual(harness.readRecord()?.status, "sleeping");
      assert.strictEqual(harness.runnerOperations.length, 1);
      assert.ok(Predicate.isTagged("StopRuntime")(harness.runnerOperations[0]));
      assert.ok(!harness.events.includes("host:stop"));
      assert.ok(!harness.events.some((event) => event.startsWith("backup:")));
    }),
  );

  it.effect("stops a hard-capped runner into sleeping without removing its runtime", () =>
    Effect.gen(function* () {
      const record = runnerRecord();
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: record,
        },
      });

      yield* Effect.promise(() => harness.sandbox.enforceHardCap({ hardCapAt: record.hardCapAt }));

      assert.strictEqual(harness.readRecord()?.status, "sleeping");
      assert.strictEqual(harness.runnerOperations.length, 1);
      assert.ok(Predicate.isTagged("StopRuntime")(harness.runnerOperations[0]));
      assert.ok(!harness.runnerOperations.some(Predicate.isTagged("RemoveRuntime")));
      assert.ok(!harness.events.includes("host:destroy"));
    }),
  );

  it.effect("releases a sleep lease when runner inspection proves the runtime is running", () =>
    Effect.gen(function* () {
      const record = runnerRecord();
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: record,
        },
        runnerDispatch: async (operation) =>
          Predicate.isTagged("InspectRuntime")(operation)
            ? runnerSuccess(operation, {
                _tag: "InspectRuntimeResult",
                phase: "running",
                resourceId:
                  record.execution.provider === "runner" ? record.execution.runtimeId : "",
                workspace: `/runner/${operation.sessionId}`,
              })
            : runnerDispatchFailure(),
      });

      const error = yield* Effect.promise(() => rejection(harness.sandbox.sleepScottySession()));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(harness.readRecord()?.status, "warm");
      assert.strictEqual(harness.readRecord()?.operation, null);
      assert.ok(!harness.schedules.some(({ callback }) => callback === "enforceHardCap"));
    }),
  );

  it.effect("reconciles an ambiguous runner sleep on its scheduled retry", () =>
    Effect.gen(function* () {
      const record = runnerRecord();
      let stopAttempts = 0;
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: record,
        },
        runnerDispatch: async (operation) => {
          if (Predicate.isTagged("StopRuntime")(operation)) {
            stopAttempts += 1;
            if (stopAttempts > 1)
              return runnerSuccess(operation, {
                _tag: "StopRuntimeResult",
                phase: "stopped",
                resourceId:
                  record.execution.provider === "runner" ? record.execution.runtimeId : "",
                workspace: `/runner/${operation.sessionId}`,
              });
          }
          return runnerDispatchFailure();
        },
      });

      const error = yield* Effect.promise(() => rejection(harness.sandbox.sleepScottySession()));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(harness.readRecord()?.operation?.kind, "snapshot");
      assert.ok(harness.schedules.some(({ callback }) => callback === "enforceHardCap"));

      yield* Effect.promise(() => harness.sandbox.enforceHardCap({ hardCapAt: record.hardCapAt }));

      assert.strictEqual(stopAttempts, 2);
      assert.strictEqual(harness.readRecord()?.status, "sleeping");
      assert.strictEqual(harness.readRecord()?.operation, null);
    }),
  );

  it.effect("retains resume ownership when failed cleanup cannot prove the runtime stopped", () =>
    Effect.gen(function* () {
      const record = runnerRecord({ status: "sleeping" });
      let stopAttempts = 0;
      const harness = yield* createTestHarness({
        failureStage: "hardCapSchedule",
        initialEntries: {
          [sessionHarnessKeys.record]: record,
        },
        runnerDispatch: async (operation) => {
          if (Predicate.isTagged("EnsureRuntime")(operation))
            return runnerSuccess(operation, {
              _tag: "EnsureRuntimeResult",
              phase: "running",
              resourceId: record.execution.provider === "runner" ? record.execution.runtimeId : "",
              workspace: `/runner/${operation.sessionId}`,
            });
          if (Predicate.isTagged("ExecRuntime")(operation))
            return runnerSuccess(operation, {
              _tag: "ExecRuntimeResult",
              exitCode: 0,
              stdout: "",
              stderr: "",
            });
          if (Predicate.isTagged("StopRuntime")(operation)) {
            stopAttempts += 1;
            if (stopAttempts > 1)
              return runnerSuccess(operation, {
                _tag: "StopRuntimeResult",
                phase: "stopped",
                resourceId:
                  record.execution.provider === "runner" ? record.execution.runtimeId : "",
                workspace: `/runner/${operation.sessionId}`,
              });
          }
          if (Predicate.isTagged("InspectRuntime")(operation))
            return runnerSuccess(operation, {
              _tag: "InspectRuntimeResult",
              phase: "running",
              resourceId: record.execution.provider === "runner" ? record.execution.runtimeId : "",
              workspace: `/runner/${operation.sessionId}`,
            });
          return runnerDispatchFailure();
        },
      });

      const error = yield* Effect.promise(() => rejection(harness.sandbox.resumeScottySession()));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(harness.readRecord()?.status, "booting");
      assert.strictEqual(harness.readRecord()?.operation?.kind, "resume");
      assert.strictEqual(harness.readRecord()?.failure, undefined);

      harness.clearFailure();
      const resumed = yield* Effect.promise(() => harness.sandbox.resumeScottySession());

      assert.strictEqual(stopAttempts, 2);
      assert.strictEqual(resumed.status, "warm");
      assert.strictEqual(harness.readRecord()?.operation, null);
    }),
  );

  it.effect("restores the runtime when an in-flight checkpoint is interrupted", () =>
    Effect.gen(function* () {
      let restores = 0;
      const checkpoint = withCheckpointRuntimeRestore(Effect.never, {
        restore: Effect.sync(() => {
          restores += 1;
        }),
        resumeRuntime: false,
        stopAttempted: () => true,
      });
      const fiber = yield* checkpoint.pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      assert.strictEqual(restores, 1);
    }),
  );

  it.effect("preserves the checkpoint exit classification when runtime restore also fails", () =>
    Effect.gen(function* () {
      const original = new Error("checkpoint failed");
      const relaunch = new Error("relaunch failed");
      const failure = yield* Effect.flip(
        withCheckpointRuntimeRestore(Effect.fail(original), {
          restore: Effect.fail(relaunch),
          resumeRuntime: false,
          stopAttempted: () => true,
        }),
      );

      assert.ok(failure instanceof CheckpointRuntimeUnavailable);
      assert.strictEqual(failure.relaunchCause, relaunch);
      assert.ok(failure.checkpointCause);
      const reason = failure.checkpointCause.reasons[0];
      assert.ok(Cause.isFailReason(reason));
      assert.strictEqual(reason.error, original);
      assert.deepStrictEqual(failure.checkpoint, {
        failed: true,
        hasDefect: false,
        hasTypedFailure: true,
        wasInterrupted: false,
      });
    }),
  );

  it.effect("shares the deterministic TestClock across the Durable Object Promise boundary", () =>
    Effect.gen(function* () {
      const record = makeSessionRecord({
        createdAt: isoAt(TEST_TIME - 1_000),
        hardCapAt: isoAt(TEST_TIME + 60_000),
      });
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
      });

      const initial = yield* Effect.promise(() => harness.sandbox.getScottySession());
      assert.strictEqual(initial.ageSeconds, 1);
      assert.strictEqual(initial.capRemainingSeconds, 60);

      yield* TestClock.adjust("10 seconds");
      const advanced = yield* Effect.promise(() => harness.sandbox.getScottySession());
      assert.strictEqual(advanced.ageSeconds, 11);
      assert.strictEqual(advanced.capRemainingSeconds, 50);
    }),
  );

  it.effect("enforceHardCap re-schedules a live operation inside the 30-second grace window", () =>
    Effect.gen(function* () {
      const now = yield* currentTestTime;
      const record = makeSessionRecord({
        operation: {
          kind: "snapshot",
          nonce: "recent-operation",
          startedAt: isoAt(now),
        },
      });
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
      });

      yield* Effect.promise(() => harness.sandbox.enforceHardCap({ hardCapAt: record.hardCapAt }));

      assert.deepStrictEqual(harness.readRecord(), record);
      assert.deepStrictEqual(
        harness.schedules.map(({ callback, when, payload }) => ({
          callback,
          when,
          payload,
        })),
        [{ callback: "enforceHardCap", when: 5, payload: { hardCapAt: record.hardCapAt } }],
      );
      assert.ok(!harness.events.includes("host:destroy"));
    }),
  );

  it.effect("enforceHardCap ignores a stale hardCapAt payload without mutating authority", () =>
    Effect.gen(function* () {
      const record = makeSessionRecord();
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
      });

      yield* Effect.promise(() =>
        harness.sandbox.enforceHardCap({
          hardCapAt: "2026-01-01T05:00:00.000Z",
        }),
      );

      assert.deepStrictEqual(harness.readRecord(), record);
      assert.deepStrictEqual(harness.schedules, []);
      assert.ok(!harness.events.includes("host:destroy"));
    }),
  );

  it.effect(
    "enforceHardCap marks an operation beyond grace failed through the current-observation guard",
    () =>
      Effect.gen(function* () {
        const now = yield* currentTestTime;
        const record = makeSessionRecord({
          operation: {
            kind: "snapshot",
            nonce: "over-grace",
            startedAt: isoAt(now - 30_001),
          },
        });
        const harness = yield* createTestHarness({
          initialEntries: { [sessionHarnessKeys.record]: record },
        });

        yield* Effect.promise(() =>
          harness.sandbox.enforceHardCap({ hardCapAt: record.hardCapAt }),
        );

        const failed = harness.readRecord();
        assert.strictEqual(failed?.status, "failed");
        assert.strictEqual(failed?.operation, null);
        assert.deepStrictEqual(failed?.failure, {
          code: "hard_cap_checkpoint_failed",
          message: "A session operation exceeded the hard-cap grace period",
          recoverable: false,
        });
        assert.ok(harness.events.includes("projection:failed"));
        assert.ok(harness.events.includes("host:destroy"));
      }),
  );

  it.effect("onActivityExpired checkpoints an idle warm session and stops into sleeping", () =>
    Effect.gen(function* () {
      const record = makeSessionRecord();
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
        initialPicanRunning: true,
        stopCallsOnStop: true,
      });

      yield* Effect.promise(() => harness.sandbox.onActivityExpired());

      const sleeping = harness.readRecord();
      assert.strictEqual(sleeping?.status, "sleeping");
      assert.strictEqual(sleeping?.operation, null);
      assert.strictEqual(sleeping?.backup?.current.id, "backup-1");
      assert.ok(
        harness.events.indexOf("host:pican:kill:SIGTERM") <
          harness.events.indexOf("host:createBackup"),
      );
      assert.ok(harness.events.includes("host:createBackup"));
      assert.ok(harness.events.includes("host:stop"));
      assert.ok(harness.events.includes("projection:sleeping"));
    }),
  );

  it.effect("onStop turns a committed managed stop into sleeping", () =>
    Effect.gen(function* () {
      const now = yield* currentTestTime;
      const committed = managedStopRecord(now, {
        stopRequestedAt: isoAt(now),
      });
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: committed },
      });

      yield* Effect.promise(() => harness.sandbox.onStop());

      const sleeping = harness.readRecord();
      assert.strictEqual(sleeping?.status, "sleeping");
      assert.strictEqual(sleeping?.operation, null);
      assert.strictEqual(sleeping?.failure, undefined);
      assert.ok(harness.events.includes("projection:sleeping"));
    }),
  );

  it.effect("onStop turns an uncommitted runtime stop into runtime_stopped failed", () =>
    Effect.gen(function* () {
      const uncommitted = makeSessionRecord({
        backup: { current: makeResumeBackup() },
        ownedBackupIds: ["backup-1"],
      });
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: uncommitted },
      });

      yield* Effect.promise(() => harness.sandbox.onStop());

      const failed = harness.readRecord();
      assert.strictEqual(failed?.status, "failed");
      assert.strictEqual(failed?.operation, null);
      assert.deepStrictEqual(failed?.failure, {
        code: "runtime_stopped",
        message: "Sandbox runtime stopped before a managed checkpoint",
        recoverable: true,
      });
      assert.ok(harness.events.includes("projection:failed"));
    }),
  );

  it.effect(
    "finalizeManagedStop claims an expired rollback, relaunches Pican, and releases the lease",
    () =>
      Effect.gen(function* () {
        const now = yield* currentTestTime;
        const record = managedStopRecord(now);
        const harness = yield* createTestHarness({
          initialEntries: {
            [sessionHarnessKeys.record]: record,
            [sessionHarnessKeys.credential]: makeStoredCredential(),
          },
        });
        const payload = {
          nonce: "managed-stop",
          armedAt: isoAt(now - 30_001),
        };

        yield* Effect.promise(() => harness.sandbox.finalizeManagedStop(payload));

        const released = harness.readRecord();
        assert.strictEqual(released?.status, "warm");
        assert.strictEqual(released?.operation, null);
        assert.ok(harness.events.includes("host:pican:start"));
        assert.deepStrictEqual(
          harness.schedules.map((schedule) => schedule.callback),
          ["finalizeManagedStop"],
        );
        assert.ok(harness.events.includes("projection:warm"));
      }),
  );

  it.effect(
    "finalizeManagedStop clears a failed rollback claim and leaves a durable retry armed",
    () =>
      Effect.gen(function* () {
        const now = yield* currentTestTime;
        const record = managedStopRecord(now);
        const harness = yield* createTestHarness({
          failureStage: "rollbackResume",
          initialEntries: {
            [sessionHarnessKeys.record]: record,
            [sessionHarnessKeys.credential]: makeStoredCredential(),
          },
        });
        const payload = {
          nonce: "managed-stop",
          armedAt: isoAt(now - 30_001),
        };

        yield* Effect.promise(() => harness.sandbox.finalizeManagedStop(payload));

        const retryable = harness.readRecord();
        assert.strictEqual(retryable?.status, "warm");
        assert.deepStrictEqual(retryable?.operation, record.operation);
        assert.deepStrictEqual(
          harness.schedules.map((schedule) => schedule.callback),
          ["finalizeManagedStop"],
        );
        assert.ok(!harness.events.includes("host:destroy"));
      }),
  );

  it.effect("a manual snapshot stops Pican, writes the backup, and relaunches it", () =>
    Effect.gen(function* () {
      const record = makeSessionRecord();
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: record,
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
        initialPicanRunning: true,
      });

      yield* Effect.promise(() => harness.sandbox.snapshotScottySession());

      const stopIndex = harness.events.indexOf("host:pican:kill:SIGTERM");
      const backupIndex = harness.events.indexOf("host:createBackup");
      const restartIndex = harness.events.lastIndexOf("host:pican:start");
      assert.ok(stopIndex >= 0);
      assert.ok(stopIndex < backupIndex);
      assert.ok(backupIndex < restartIndex);
      assert.strictEqual(harness.readRecord()?.status, "warm");
      assert.strictEqual(harness.readRecord()?.operation, null);
      assert.strictEqual(harness.readRecord()?.backup?.current.id, "backup-1");
    }),
  );

  it.effect("a manual snapshot fails recoverably when Pican cannot relaunch", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        failureStage: "picanLaunch",
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord(),
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
        initialPicanRunning: true,
      });

      const error = yield* Effect.promise(() => rejection(harness.sandbox.snapshotScottySession()));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.message, "Snapshot failed");
      const failed = harness.readRecord();
      assert.strictEqual(failed?.status, "failed");
      assert.strictEqual(failed?.operation, null);
      assert.strictEqual(failed?.backup?.current.id, "backup-1");
      assert.deepStrictEqual(failed?.failure, {
        code: "checkpoint_runtime_unavailable",
        message: "Pican failed to relaunch after checkpoint",
        recoverable: true,
      });
      assert.ok(
        harness.events.indexOf("host:createBackup") <
          harness.events.lastIndexOf("host:pican:start"),
      );
    }),
  );

  it.effect("a snapshot keeps its lease when Pican relaunch and failed-state read both fail", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord(),
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
        initialPicanRunning: true,
      });
      harness.injectFailure("picanLaunch");
      harness.injectFailure("checkpointFailureStateRead");

      const error = yield* Effect.promise(() => rejection(harness.sandbox.snapshotScottySession()));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.message, "Snapshot failed");
      const held = harness.readRecord();
      assert.strictEqual(held?.status, "warm");
      assert.strictEqual(held?.operation?.kind, "snapshot");
      assert.strictEqual(held?.operation?.checkpointedBackupId, "backup-1");
      assert.ok(!harness.events.includes("host:stop"));
    }),
  );

  it.effect(
    "sleep keeps its lease when Pican relaunch and failed-state persistence both fail",
    () =>
      Effect.gen(function* () {
        const harness = yield* createTestHarness({
          initialEntries: {
            [sessionHarnessKeys.record]: makeSessionRecord(),
            [sessionHarnessKeys.credential]: makeStoredCredential(),
          },
          initialPicanRunning: true,
        });
        harness.injectFailure("checkpointSync");
        harness.injectFailure("picanLaunch");
        harness.injectFailure("checkpointFailureStatePersist");

        const error = yield* Effect.promise(() => rejection(harness.sandbox.sleepScottySession()));

        assert.ok(error instanceof ScottyError);
        assert.strictEqual(error.message, "Session stop failed");
        const held = harness.readRecord();
        assert.strictEqual(held?.status, "warm");
        assert.strictEqual(held?.operation?.kind, "snapshot");
        assert.strictEqual(held?.operation?.checkpointedBackupId, undefined);
        assert.strictEqual(held?.backup, undefined);
        assert.ok(!harness.events.includes("host:stop"));
        assert.ok(!harness.schedules.some(({ callback }) => callback === "finalizeManagedStop"));
      }),
  );

  it.effect("idle expiry keeps its lease when Pican relaunch recovery storage fails", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord(),
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
        initialPicanRunning: true,
      });
      harness.injectFailure("checkpointSync");
      harness.injectFailure("picanLaunch");
      harness.injectFailure("checkpointFailureStateRead");

      yield* Effect.promise(() => harness.sandbox.onActivityExpired());

      const held = harness.readRecord();
      assert.strictEqual(held?.status, "warm");
      assert.strictEqual(held?.operation?.kind, "snapshot");
      assert.strictEqual(held?.operation?.checkpointedBackupId, undefined);
      assert.strictEqual(held?.backup, undefined);
      assert.ok(!harness.events.includes("host:stop"));
    }),
  );

  it.effect("a partial Pican stop failure is relaunched before snapshot failure returns", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        failureStage: "picanStop",
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord(),
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
        initialPicanRunning: true,
      });

      const error = yield* Effect.promise(() => rejection(harness.sandbox.snapshotScottySession()));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.message, "Snapshot failed");
      const record = harness.readRecord();
      assert.strictEqual(record?.status, "warm");
      assert.strictEqual(record?.operation, null);
      assert.strictEqual(record?.backup, undefined);
      assert.ok(
        harness.events.indexOf("host:pican:kill:SIGTERM") <
          harness.events.lastIndexOf("host:pican:start"),
      );
      assert.ok(harness.events.includes("host:pican:ready"));
    }),
  );

  it.effect("a checkpoint defect still relaunches Pican before the defect escapes", () =>
    Effect.gen(function* () {
      const harness = yield* createTestHarness({
        failureStage: "checkpointDefect",
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord(),
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
        initialPicanRunning: true,
      });

      const defect = yield* Effect.promise(() =>
        rejection(harness.sandbox.snapshotScottySession()),
      );

      assert.notStrictEqual(defect, undefined);
      assert.ok(
        harness.events.indexOf("host:pican:kill:SIGTERM") <
          harness.events.lastIndexOf("host:pican:start"),
      );
      assert.ok(harness.events.includes("host:pican:ready"));
      assert.strictEqual(harness.readRecord()?.status, "warm");
      assert.strictEqual(harness.readRecord()?.operation?.kind, "snapshot");
    }),
  );

  it.effect("enforceHardCap recovers an abandoned operation by marking the session failed", () =>
    Effect.gen(function* () {
      const now = yield* currentTestTime;
      const abandoned = makeSessionRecord({
        operation: {
          kind: "down",
          nonce: "abandoned-down",
          startedAt: isoAt(now - (5 * 60_000 + 1)),
        },
      });
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: abandoned },
      });

      yield* Effect.promise(() =>
        harness.sandbox.enforceHardCap({ hardCapAt: abandoned.hardCapAt }),
      );

      const failed = harness.readRecord();
      assert.strictEqual(failed?.status, "failed");
      assert.strictEqual(failed?.operation, null);
      assert.strictEqual(
        failed?.failure?.message,
        "A session operation exceeded the hard-cap grace period",
      );
      assert.ok(harness.events.includes("host:destroy"));
    }),
  );
});
