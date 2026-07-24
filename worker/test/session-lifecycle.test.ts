import { assert, describe, it } from "@effect/vitest";
import type { SessionRecord } from "../src/contracts";
import {
  hardCapObservationIsCurrent,
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsTerminalAttachment,
  sessionAllowsRuntimeAccess,
  VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS,
} from "../src/session-lifecycle";

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  id: "a0b1c2d3e4f5",
  status: "warm",
  operation: null,
  repo: "anomalyco/rift",
  repoExistsAtCreate: true,
  defaultBranch: "dev",
  branch: "scotty/a0b1c2d3e4f5",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: [],
  ...overrides,
});

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

  it("allows new terminal attachments only while no lifecycle operation owns a warm session", () => {
    assert.isTrue(sessionAllowsTerminalAttachment(record()));
    assert.isFalse(
      sessionAllowsTerminalAttachment(
        record({
          operation: {
            kind: "snapshot",
            nonce: "snapshot-acquired",
            startedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      ),
    );
    assert.isFalse(
      sessionAllowsTerminalAttachment(
        record({
          operation: {
            kind: "snapshot",
            nonce: "snapshot-stopping",
            startedAt: "2026-01-01T00:00:02.000Z",
            checkpointedBackupId: "backup-1",
            stopRequestedAt: "2026-01-01T00:00:03.000Z",
          },
        }),
      ),
    );
    assert.isFalse(
      sessionAllowsTerminalAttachment(
        record({
          operation: {
            kind: "pr",
            nonce: "pr-nonce",
            startedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      ),
    );
    assert.isFalse(
      sessionAllowsTerminalAttachment(
        record({
          operation: {
            kind: "vaporize",
            nonce: "vaporize-nonce",
            startedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      ),
    );
    assert.isFalse(sessionAllowsTerminalAttachment(record({ status: "sleeping" })));
    assert.isFalse(sessionAllowsTerminalAttachment(undefined));
  });

  it("tracks every callback and preserves only vaporize retry during cleanup", () => {
    assert.deepStrictEqual(SESSION_SCHEDULE_CALLBACKS, [
      "captureThreadId",
      "enforceHardCap",
      "expireTerminalAttachment",
      "finalizeManagedStop",
      "finalizeTerminalAttachment",
      "retryHardCapDestroy",
      "retryVaporizeSession",
    ]);
    assert.deepStrictEqual(VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS, [
      "captureThreadId",
      "enforceHardCap",
      "expireTerminalAttachment",
      "finalizeManagedStop",
      "finalizeTerminalAttachment",
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
