import { assert, describe, it } from "@effect/vitest";
import {
  hardCapObservationIsCurrent,
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsRuntimeAccess,
  VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS,
} from "../src/session-lifecycle";
import { makeSessionRecord as record } from "./support";

describe("session lifecycle invariants", () => {
  it("forbids every container-touching callback after vaporize starts", () => {
    assert.isTrue(sessionAllowsRuntimeAccess(record()));
    assert.isFalse(
      sessionAllowsRuntimeAccess(
        record({
          operation: {
            kind: "vaporize",
            nonce: "vaporize-nonce",
            startedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      ),
    );
    assert.isFalse(sessionAllowsRuntimeAccess(record({ status: "gone" })));
    assert.isFalse(sessionAllowsRuntimeAccess(undefined));
  });

  it("tracks every callback and preserves only vaporize retry during cleanup", () => {
    assert.deepStrictEqual(SESSION_SCHEDULE_CALLBACKS, [
      "enforceHardCap",
      "expireEvidenceJob",
      "expireRetainedEvidence",
      "finalizeManagedStop",
      "retryHardCapDestroy",
      "retryVaporizeSession",
    ]);
    assert.deepStrictEqual(VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS, [
      "enforceHardCap",
      "expireEvidenceJob",
      "expireRetainedEvidence",
      "finalizeManagedStop",
      "retryHardCapDestroy",
    ]);
  });

  it("rejects stale hard-cap writes after any concurrent transition", () => {
    const observed = record();
    assert.isTrue(hardCapObservationIsCurrent(observed, observed));
    assert.isFalse(
      hardCapObservationIsCurrent(observed, {
        ...observed,
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    assert.isFalse(
      hardCapObservationIsCurrent(observed, {
        ...observed,
        operation: {
          kind: "vaporize",
          nonce: "vaporize-nonce",
          startedAt: "2026-01-01T00:00:02.000Z",
        },
      }),
    );
  });
});
