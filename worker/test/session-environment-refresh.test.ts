import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import {
  createSessionHarness,
  makeResumeBackup,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const previous = {
  revision: 3,
  variables: { KEEP: "old", REMOVE_ME: "secret-to-remove" },
};
const current = {
  revision: 4,
  variables: { KEEP: "new", ADDED: "added" },
};

const entries = (operation: ReturnType<typeof makeSessionRecord>["operation"] = null) => ({
  [sessionHarnessKeys.record]: makeSessionRecord({
    id: SESSION_ID,
    status: "warm",
    operation,
    environment: previous,
  }),
  [sessionHarnessKeys.credential]: makeStoredCredential(),
});

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("Sandbox environment refresh", () => {
  it("reports safe stale metadata without changing the session view", async () => {
    const harness = await createSessionHarness({
      initialEntries: entries(),
      environmentSnapshot: current,
    });

    const before = await harness.sandbox.getScottySession();
    const status = await harness.sandbox.getScottyEnvironmentStatus();
    const after = await harness.sandbox.getScottySession();

    assert.deepStrictEqual(status, {
      id: SESSION_ID,
      title: before.title,
      repo: before.repo,
      status: "warm",
      appliedRevision: 3,
      currentEffectiveRevision: 4,
      stale: true,
      refreshable: true,
    });
    assert.deepStrictEqual({ ...after, projectedAt: before.projectedAt }, before);
    assert.notProperty(status, "variables");
  });

  it("refreshes one warm session, unsets removed variables, and preserves its hard cap", async () => {
    const harness = await createSessionHarness({
      initialEntries: entries(),
      environmentSnapshot: current,
      piSessionRunning: true,
    });
    const hardCapAt = harness.readRecord()?.hardCapAt;

    const refreshed = await harness.sandbox.refreshScottyEnvironment();

    assert.strictEqual(refreshed.stale, false);
    assert.strictEqual(refreshed.appliedRevision, 4);
    assert.deepStrictEqual(harness.readRecord()?.environment, current);
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.strictEqual(harness.readRecord()?.hardCapAt, hardCapAt);
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.KEEP, "new");
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.ADDED, "added");
    assert.property(harness.appliedEnvironments.at(-1) ?? {}, "REMOVE_ME");
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.REMOVE_ME, undefined);
    assert.ok(harness.events.indexOf("host:pi:kill") < harness.events.indexOf("host:setEnvVars"));
    assert.ok(
      harness.events.indexOf("host:setEnvVars") <
        harness.events.indexOf("host:pi:start:scotty-pi-session"),
    );
    assert.deepStrictEqual(harness.schedules, []);
  });

  it("returns an idempotent no-op when the committed revision is current", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
          environment: current,
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      environmentSnapshot: current,
      piSessionRunning: true,
    });

    const refreshed = await harness.sandbox.refreshScottyEnvironment();

    assert.strictEqual(refreshed.stale, false);
    assert.deepStrictEqual(harness.appliedEnvironments, []);
    assert.notInclude(harness.events, "host:pi:kill");
  });

  it("rejects a held lease and a non-warm session", async () => {
    const lease = {
      kind: "snapshot" as const,
      nonce: "held",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const initialEntries of [
      entries(lease),
      {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "sleeping",
          environment: previous,
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    ]) {
      const harness = await createSessionHarness({ initialEntries, environmentSnapshot: current });
      assert.isFalse((await harness.sandbox.getScottyEnvironmentStatus()).refreshable);
      const error = await rejection(harness.sandbox.refreshScottyEnvironment());
      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.httpStatus, 409);
    }
  });

  it("unsets variables from a prior ambiguous target when retry resolves a newer revision", async () => {
    const attempted = {
      revision: 4,
      variables: { KEEP: "intermediate", TRANSIENT: "must-be-unset" },
    };
    const newest = { revision: 5, variables: { KEEP: "newest" } };
    const nonce = "refresh-retry-nonce";
    const harness = await createSessionHarness({
      initialEntries: entries({
        kind: "refresh",
        nonce,
        startedAt: "2026-01-01T00:00:00.000Z",
        environmentRefreshPhase: "applying",
        environmentRefreshTarget: attempted,
      }),
      environmentSnapshot: newest,
    });

    await harness.sandbox.retryEnvironmentRefresh({ sessionId: SESSION_ID, nonce });

    assert.deepStrictEqual(harness.readRecord()?.environment, newest);
    assert.property(harness.appliedEnvironments.at(-1) ?? {}, "TRANSIENT");
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.TRANSIENT, undefined);
  });

  it("retains typed retry state after an uncertain apply and commits only after retry", async () => {
    const harness = await createSessionHarness({
      initialEntries: entries(),
      environmentSnapshot: current,
      piSessionRunning: true,
      failureStage: "environmentApply",
    });

    const error = await rejection(harness.sandbox.refreshScottyEnvironment());
    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    const pending = harness.readRecord();
    assert.deepStrictEqual(pending?.environment, previous);
    assert.strictEqual(pending?.operation?.kind, "refresh");
    assert.strictEqual(pending?.operation?.environmentRefreshPhase, "applying");
    assert.strictEqual(harness.schedules.at(-1)?.callback, "retryEnvironmentRefresh");

    harness.clearFailure("environmentApply");
    await harness.sandbox.retryEnvironmentRefresh({
      sessionId: SESSION_ID,
      nonce: pending?.operation?.nonce ?? "missing",
    });

    assert.deepStrictEqual(harness.readRecord()?.environment, current);
    assert.strictEqual(harness.readRecord()?.operation, null);
  });

  it("ignores retries whose session or nonce fence does not match authority", async () => {
    const nonce = "refresh-retry-nonce";
    const operation = {
      kind: "refresh" as const,
      nonce,
      startedAt: "2026-01-01T00:00:00.000Z",
      environmentRefreshPhase: "applying" as const,
      environmentRefreshTarget: current,
    };
    for (const payload of [
      { sessionId: "different-session", nonce },
      { sessionId: SESSION_ID, nonce: "different-nonce" },
    ]) {
      const harness = await createSessionHarness({
        initialEntries: entries(operation),
        environmentSnapshot: current,
      });

      await harness.sandbox.retryEnvironmentRefresh(payload);

      assert.deepStrictEqual(harness.readRecord()?.operation, operation);
      assert.deepStrictEqual(harness.appliedEnvironments, []);
    }
  });

  it("lets the hard cap revoke an expired refresh lease and fences its retry", async () => {
    const nonce = "expired-refresh";
    const record = makeSessionRecord({
      id: SESSION_ID,
      status: "warm",
      environment: previous,
      operation: {
        kind: "refresh",
        nonce,
        startedAt: "1970-01-01T00:00:00.000Z",
        environmentRefreshPhase: "applying",
        environmentRefreshTarget: current,
      },
    });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: record,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      environmentSnapshot: current,
    });

    await harness.sandbox.enforceHardCap({ hardCapAt: record.hardCapAt });

    const failed = harness.readRecord();
    assert.strictEqual(failed?.status, "failed");
    assert.strictEqual(failed?.operation, null);
    assert.strictEqual(failed?.failure?.code, "hard_cap_checkpoint_failed");
    assert.include(harness.events, "host:destroy");

    await harness.sandbox.retryEnvironmentRefresh({ sessionId: SESSION_ID, nonce });
    assert.deepStrictEqual(harness.readRecord(), failed);
    assert.deepStrictEqual(harness.appliedEnvironments, []);
  });

  it("marks an unscheduled failed refresh unrecoverable without a backup", async () => {
    const harness = await createSessionHarness({
      initialEntries: entries(),
      environmentSnapshot: current,
      failureStage: "environmentApply",
    });
    harness.injectFailure("environmentRefreshRetrySchedule");

    const error = await rejection(harness.sandbox.refreshScottyEnvironment());

    assert.ok(error instanceof ScottyError);
    const failed = harness.readRecord();
    assert.strictEqual(failed?.status, "failed");
    assert.strictEqual(failed?.operation, null);
    assert.strictEqual(failed?.failure?.code, "environment_refresh_failed");
    assert.isFalse(failed?.failure?.recoverable);
    assert.include(harness.events, "host:destroy");
  });

  it("destroys an unscheduled ambiguous runtime and resumes from the backup snapshot", async () => {
    const backup = makeResumeBackup();
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
          environment: previous,
          backup: { current: backup },
          ownedBackupIds: [backup.id],
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      environmentSnapshot: current,
      failureStage: "environmentApply",
    });
    harness.injectFailure("environmentRefreshRetrySchedule");

    await rejection(harness.sandbox.refreshScottyEnvironment());

    const failed = harness.readRecord();
    assert.strictEqual(failed?.status, "failed");
    assert.isTrue(failed?.failure?.recoverable);
    assert.strictEqual(failed?.backup?.current.id, backup.id);
    assert.include(harness.events, "host:destroy");

    harness.clearFailure("environmentApply");
    harness.clearFailure("environmentRefreshRetrySchedule");
    const resumed = await harness.sandbox.resumeScottySession();

    assert.strictEqual(resumed.status, "warm");
    assert.deepStrictEqual(harness.readRecord()?.environment, previous);
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.KEEP, "old");
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.REMOVE_ME, "secret-to-remove");
  });

  it("fails the held lease when an uncertain apply cannot arm another retry", async () => {
    const nonce = "refresh-retry-nonce";
    const harness = await createSessionHarness({
      initialEntries: entries({
        kind: "refresh",
        nonce,
        startedAt: "2026-01-01T00:00:00.000Z",
        environmentRefreshPhase: "applying",
        environmentRefreshTarget: current,
      }),
      environmentSnapshot: current,
      failureStage: "environmentApply",
    });
    harness.injectFailure("environmentRefreshRetrySchedule");

    await harness.sandbox.retryEnvironmentRefresh({ sessionId: SESSION_ID, nonce });

    const failed = harness.readRecord();
    assert.strictEqual(failed?.status, "failed");
    assert.strictEqual(failed?.operation, null);
    assert.strictEqual(failed?.failure?.code, "environment_refresh_failed");
    assert.isFalse(failed?.failure?.recoverable);
    assert.deepStrictEqual(harness.schedules, []);
    assert.include(harness.events, "host:destroy");
  });
});
