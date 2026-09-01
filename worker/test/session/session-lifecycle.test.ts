import { assert, describe, it } from "@effect/vitest";
import {
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsRuntimeAccess,
} from "../../src/session/lifecycle";
import { makeSessionRecord as record } from "../support";

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

  it("tracks every actor-owned session callback", () => {
    assert.deepStrictEqual(SESSION_SCHEDULE_CALLBACKS, [
      "expireEvidenceJob",
      "expireRetainedEvidence",
      "retryHatchCleanup",
      "sessionActorDeadline",
      "sessionActorHardCap",
    ]);
  });
});
