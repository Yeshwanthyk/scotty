import { assert, describe, it } from "@effect/vitest";
import { Predicate } from "effect";
import type { SessionAuthority } from "../../src/session-actor/authority";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
} from "../support/session-harness";

describe("Sandbox actor checkpoint, sleep, and resume", () => {
  it("runs the complete backup lifecycle without a legacy session record", async () => {
    const harness = await createSessionHarness();
    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    assert.strictEqual(created.status, "warm");

    const checkpointed = await harness.sandbox.snapshotScottySession();
    assert.strictEqual(checkpointed.status, "warm");
    const afterCheckpoint = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(afterCheckpoint);
    assert.ok(
      Predicate.isTagged(afterCheckpoint.state, "Stable") &&
        Predicate.isTagged(afterCheckpoint.state.stable, "Warm"),
    );
    assert.strictEqual(afterCheckpoint.state.stable.backups.currentBackupId, "backup-1");

    const sleeping = await harness.sandbox.sleepScottySession();
    assert.strictEqual(sleeping.status, "sleeping");
    const afterSleep = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(afterSleep);
    assert.ok(
      Predicate.isTagged(afterSleep.state, "Stable") &&
        Predicate.isTagged(afterSleep.state.stable, "Sleeping"),
    );
    assert.strictEqual(afterSleep.state.stable.wakeSource.backupId, "backup-1");

    const resumed = await harness.sandbox.resumeScottySession();
    assert.strictEqual(resumed.status, "warm");
    const afterResume = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(afterResume);
    assert.ok(
      Predicate.isTagged(afterResume.state, "Stable") &&
        Predicate.isTagged(afterResume.state.stable, "Warm"),
    );
    assert.match(afterResume.state.stable.readiness.runtime.runtimeGeneration, /^resume-/u);
    assert.strictEqual(
      await harness.sandbox.getScottySession().then((view) => view.status),
      "warm",
    );
    assert.strictEqual(harness.readRecord(), undefined);
    assert.ok(harness.events.includes("host:createBackup"));
    assert.ok(harness.events.includes("host:stop"));
    assert.ok(harness.events.includes("host:restoreBackup"));
  });
});
