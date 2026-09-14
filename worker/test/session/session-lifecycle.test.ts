import { assert, describe, it } from "@effect/vitest";
import {
  hardCapDrainAt,
  hardCapMidpointAt,
  legacyHardCapDrainAt,
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
      "drainCodexFollowUps",
      "expireEvidenceJob",
      "expireRetainedEvidence",
      "retryHatchCleanup",
      "sessionActorDeadline",
      "sessionActorHardCapDrain",
      "sessionActorCheckpointMidpoint",
      "sessionActorHardCap",
    ]);
  });

  it("schedules midpoint and a ten-minute final sleep, coalescing caps at twenty minutes", () => {
    assert.strictEqual(
      hardCapDrainAt("2026-01-01T01:00:00.000Z", 3_600),
      "2026-01-01T00:50:00.000Z",
    );
    assert.strictEqual(
      hardCapMidpointAt("2026-01-01T01:00:00.000Z", 3_600),
      "2026-01-01T00:30:00.000Z",
    );
    assert.strictEqual(
      hardCapDrainAt("2026-01-01T00:20:00.000Z", 1_200),
      hardCapMidpointAt("2026-01-01T00:20:00.000Z", 1_200),
    );
    assert.strictEqual(hardCapDrainAt("2026-01-01T00:01:00.000Z", 60), "2026-01-01T00:00:30.000Z");
    assert.strictEqual(
      legacyHardCapDrainAt("2026-01-01T01:00:00.000Z", 3_600),
      "2026-01-01T00:55:00.000Z",
    );
  });
});
