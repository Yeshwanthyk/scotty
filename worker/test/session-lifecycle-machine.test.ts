import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  createSessionHarness,
  type HarnessOptions,
  makeResumeBackup,
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

describe("Sandbox lifecycle machine", () => {
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
        stopCallsOnStop: true,
      });

      yield* Effect.promise(() => harness.sandbox.onActivityExpired());

      const sleeping = harness.readRecord();
      assert.strictEqual(sleeping?.status, "sleeping");
      assert.strictEqual(sleeping?.operation, null);
      assert.strictEqual(sleeping?.backup?.current.id, "backup-1");
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
    "finalizeManagedStop claims an expired rollback, resumes the agent, and releases the lease",
    () =>
      Effect.gen(function* () {
        const now = yield* currentTestTime;
        const record = managedStopRecord(now);
        const harness = yield* createTestHarness({
          initialEntries: { [sessionHarnessKeys.record]: record },
        });
        const payload = {
          nonce: "managed-stop",
          armedAt: isoAt(now - 30_001),
        };

        yield* Effect.promise(() => harness.sandbox.finalizeManagedStop(payload));

        const released = harness.readRecord();
        assert.strictEqual(released?.status, "warm");
        assert.strictEqual(released?.operation, null);
        assert.ok(harness.events.includes("host:exec:exec"));
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
          initialEntries: { [sessionHarnessKeys.record]: record },
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

  it.effect("captureThreadId stops after the twelfth bounded discovery attempt", () =>
    Effect.gen(function* () {
      const record = makeSessionRecord();
      const harness = yield* createTestHarness({
        initialEntries: { [sessionHarnessKeys.record]: record },
      });

      for (let attempt = 0; attempt < 12; attempt += 1) {
        yield* Effect.promise(() => harness.sandbox.captureThreadId({ attempt }));
      }

      assert.strictEqual(harness.readRecord()?.codexThreadId, undefined);
      assert.strictEqual(harness.events.filter((event) => event === "host:exec:exec").length, 12);
      assert.deepStrictEqual(
        harness.schedules.map((schedule) => schedule.payload),
        Array.from({ length: 11 }, (_, index) => ({ attempt: index + 1 })),
      );
    }),
  );

  it.effect("enforceHardCap recovers an abandoned pr lease by marking the session failed", () =>
    Effect.gen(function* () {
      const now = yield* currentTestTime;
      const abandoned = makeSessionRecord({
        operation: {
          kind: "pr",
          nonce: "abandoned-pr",
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
