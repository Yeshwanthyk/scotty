import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import type { EvidenceStateV1 } from "../src/evidence-contracts";
import { createSessionHarness, SESSION_ID, sessionHarnessKeys } from "./session-harness";
import { makeSessionRecord } from "./support";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);

const createHarness = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const clock = yield* Clock.Clock;
  return yield* Effect.promise(() =>
    createSessionHarness({
      clock,
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          hardCapAt: "2026-08-06T13:00:00.000Z",
        }),
      },
    }),
  );
});

const job = {
  version: 1,
  port: 4_173,
  capture: { screenshots: "after-each-step", replay: true },
  steps: [
    {
      name: "Open the app",
      action: { kind: "goto", path: "/" },
      expect: [{ kind: "urlPath", expected: "/" }],
    },
  ],
} as const;

describe("evidence session lifecycle", () => {
  it.effect("decodes, acquires, schedules, and expires one evidence job", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness;
      const accepted = yield* Effect.promise(() =>
        harness.sandbox.acceptScottyEvidenceJob(job, "runtime-1"),
      );
      assert.strictEqual(accepted.status, "accepted");
      assert.strictEqual(harness.readRecord()?.operation?.kind, "evidence");
      assert.deepInclude(harness.schedules[0], {
        callback: "expireEvidenceJob",
        payload: { nonce: accepted.operationNonce, deadlineAt: accepted.deadlineAt },
      });

      yield* Effect.promise(() =>
        harness.sandbox.expireEvidenceJob({
          nonce: accepted.operationNonce,
          deadlineAt: accepted.deadlineAt,
        }),
      );
      const state = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
      assert.strictEqual(state?.activeJob, undefined);
      assert.deepInclude(state?.jobs[0], {
        jobId: accepted.jobId,
        status: "interrupted",
        failure: { code: "deadline" },
      });
      assert.strictEqual(harness.readRecord()?.operation, null);
    }),
  );

  it.effect("retains vaporize retry authority until artifact absence is proved", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness;
      const accepted = yield* Effect.promise(() =>
        harness.sandbox.acceptScottyEvidenceJob(job, "runtime-1"),
      );
      yield* Effect.promise(() =>
        harness.sandbox.completeScottyEvidenceStep(accepted.operationNonce, {
          index: 0,
          startedAt: "2026-08-06T12:00:00.100Z",
          completedAt: "2026-08-06T12:00:01.000Z",
          offsetMillis: 1_000,
          assertions: [{ kind: "urlPath", passed: true, expected: "/", actual: "/" }],
          frame: {
            frameId: "frame-1",
            bytes: PNG,
            capturedAt: "2026-08-06T12:00:01.000Z",
            offsetMillis: 1_000,
          },
        }),
      );
      yield* Effect.promise(() =>
        harness.sandbox.finalizeScottyEvidenceJob(accepted.operationNonce, "succeeded"),
      );
      harness.injectFailure("artifactDelete");

      const failed = yield* Effect.result(
        Effect.tryPromise({
          try: () => harness.sandbox.vaporizeScottySession(),
          catch: (cause) => cause,
        }),
      );
      assert.ok(Result.isFailure(failed));
      const nonce = harness.readRecord()?.operation?.nonce;
      assert.strictEqual(harness.readRecord()?.operation?.kind, "vaporize");
      assert.ok(nonce !== undefined);
      const pending = harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence);
      assert.deepInclude(pending?.artifacts[0], { status: "delete_pending" });
      assert.deepInclude(pending?.pendingDeletes[0], { reason: "vaporize" });
      assert.strictEqual(harness.artifactKeys().length, 1);

      harness.clearFailure("artifactDelete");
      yield* Effect.promise(() => harness.sandbox.retryVaporizeSession({ id: SESSION_ID, nonce }));
      assert.strictEqual(harness.readRecord()?.status, "gone");
      assert.strictEqual(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence), undefined);
      assert.deepStrictEqual(harness.artifactKeys(), []);
    }),
  );

  it.effect("lets vaporize preempt evidence and remove its authority before gone", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness;
      yield* Effect.promise(() => harness.sandbox.acceptScottyEvidenceJob(job, "runtime-1"));
      const gone = yield* Effect.promise(() => harness.sandbox.vaporizeScottySession());
      assert.deepStrictEqual(gone, { id: SESSION_ID, status: "gone" });
      assert.strictEqual(harness.read<EvidenceStateV1>(sessionHarnessKeys.evidence), undefined);
      assert.include(harness.deletedSchedules, "expireEvidenceJob");
    }),
  );
});
