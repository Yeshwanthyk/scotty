import { assert, describe, it } from "@effect/vitest";
import {
  isSessionEnvironmentSnapshot,
  type EnvironmentMaterialization,
} from "../src/environment-contracts";
import { ScottyError } from "../src/contracts";
import {
  createSessionHarness,
  makeResumeBackup,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const previous = {
  version: 1 as const,
  revision: 3,
  variables: { KEEP: "old", REMOVE_ME: "secret-to-remove" },
};
const OLD_API_TOKEN_SENTINEL = "scotty-env-a0b1c2d3e4f5-00000000000000000000000000000000";
const OLD_REMOVE_ME_SENTINEL = "scotty-env-a0b1c2d3e4f5-00000000000000000000000000000001";
const OLD_GITHUB_SENTINEL = "scotty-env-a0b1c2d3e4f5-00000000000000000000000000000002";
const OLD_OPENAI_SENTINEL = "scotty-env-a0b1c2d3e4f5-00000000000000000000000000000003";
const OLD_OPENCODE_SENTINEL = "scotty-env-a0b1c2d3e4f5-00000000000000000000000000000004";
const current = {
  version: 1 as const,
  revision: 4,
  variables: { KEEP: "new", ADDED: "added" },
};
const secretPrevious = {
  version: 1 as const,
  revision: 3,
  variables: {
    KEEP: "old",
    GH_TOKEN: OLD_GITHUB_SENTINEL,
    OPENAI_API_KEY: OLD_OPENAI_SENTINEL,
    OPENCODE_API_KEY: OLD_OPENCODE_SENTINEL,
    API_TOKEN: OLD_API_TOKEN_SENTINEL,
    REMOVE_ME: OLD_REMOVE_ME_SENTINEL,
  },
};
const secretMaterialization = {
  revision: 4,
  variables: {
    KEEP: {
      value: "new",
      secret: false,
      updatedAt: "four",
      sourceScope: "global",
    },
    API_TOKEN: {
      value: "new-rotation-secret",
      secret: true,
      updatedAt: "four",
      sourceScope: "global",
    },
    ADDED: {
      value: "added-secret",
      secret: true,
      updatedAt: "four",
      sourceScope: "global",
    },
  },
} satisfies EnvironmentMaterialization;
const secretVaultState = {
  version: 1 as const,
  entries: {
    [OLD_GITHUB_SENTINEL]: {
      sentinel: OLD_GITHUB_SENTINEL,
      sourceScope: "global" as const,
      name: "GH_TOKEN",
      value: "authority-github-token",
    },
    [OLD_OPENAI_SENTINEL]: {
      sentinel: OLD_OPENAI_SENTINEL,
      sourceScope: "global" as const,
      name: "OPENAI_API_KEY",
      value: "authority-openai-key",
    },
    [OLD_OPENCODE_SENTINEL]: {
      sentinel: OLD_OPENCODE_SENTINEL,
      sourceScope: "global" as const,
      name: "OPENCODE_API_KEY",
      value: "authority-opencode-key",
    },
    [OLD_API_TOKEN_SENTINEL]: {
      sentinel: OLD_API_TOKEN_SENTINEL,
      sourceScope: "global" as const,
      name: "API_TOKEN",
      value: "old-rotation-secret",
    },
    [OLD_REMOVE_ME_SENTINEL]: {
      sentinel: OLD_REMOVE_ME_SENTINEL,
      sourceScope: "global" as const,
      name: "REMOVE_ME",
      value: "removed-secret",
    },
  },
};

const entries = (operation: ReturnType<typeof makeSessionRecord>["operation"] = null) => ({
  [sessionHarnessKeys.record]: makeSessionRecord({
    id: SESSION_ID,
    status: "warm",
    operation,
    environment: previous,
  }),
});

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );
const assertEnvironmentWithGithub = (
  actual: unknown,
  expected: { readonly version: 1; readonly revision: number; readonly variables: object },
): void => {
  assert.ok(isSessionEnvironmentSnapshot(actual));
  const {
    GH_TOKEN: github,
    OPENAI_API_KEY: openai,
    OPENCODE_API_KEY: opencode,
    ...variables
  } = actual.variables;
  assert.ok(github?.startsWith(`scotty-env-${SESSION_ID}-`));
  assert.ok(openai?.startsWith(`scotty-env-${SESSION_ID}-`));
  assert.ok(opencode?.startsWith(`scotty-env-${SESSION_ID}-`));
  assert.deepStrictEqual({ ...actual, variables }, expected);
};

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
    assertEnvironmentWithGithub(harness.readRecord()?.environment, current);
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

  it("keeps the old generation and refresh lease through a failed prune", async () => {
    const oldSecret = "old-rotation-secret";
    const newSecret = "new-rotation-secret";
    const committed = {
      version: 1 as const,
      revision: 3,
      variables: {
        API_TOKEN: OLD_API_TOKEN_SENTINEL,
        REMOVE_ME: OLD_REMOVE_ME_SENTINEL,
      },
    };
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
          environment: committed,
        }),
        [sessionHarnessKeys.environmentVault]: {
          version: 1,
          entries: {
            [OLD_API_TOKEN_SENTINEL]: {
              sentinel: OLD_API_TOKEN_SENTINEL,
              sourceScope: "global",
              name: "API_TOKEN",
              value: oldSecret,
            },
            [OLD_REMOVE_ME_SENTINEL]: {
              sentinel: OLD_REMOVE_ME_SENTINEL,
              sourceScope: "global",
              name: "REMOVE_ME",
              value: "removed-secret",
            },
          },
        },
      },
      environmentMaterialization: {
        revision: 4,
        variables: {
          API_TOKEN: {
            value: newSecret,
            secret: true,
            updatedAt: "four",
            sourceScope: "global",
          },
        },
      },
      piSessionRunning: true,
      failureStage: "environmentVaultCommit",
    });

    const error = await rejection(harness.sandbox.refreshScottyEnvironment());
    assert.ok(error instanceof ScottyError);
    const pending = harness.readRecord();
    assert.strictEqual(pending?.operation?.kind, "refresh");
    assert.strictEqual(pending?.operation?.environmentRefreshPhase, "applying");
    const pendingEnvironment = pending?.environment;
    assert.ok(isSessionEnvironmentSnapshot(pendingEnvironment));
    assert.strictEqual(pendingEnvironment.version, 1);
    assert.strictEqual(harness.schedules.at(-1)?.callback, "retryEnvironmentRefresh");
    assert.deepStrictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_API_TOKEN_SENTINEL }),
      { sentinel: OLD_API_TOKEN_SENTINEL, value: oldSecret },
    );
    assert.notInclude(JSON.stringify(pending), oldSecret);
    assert.deepStrictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_REMOVE_ME_SENTINEL }),
      { sentinel: OLD_REMOVE_ME_SENTINEL, value: "removed-secret" },
    );
    assert.notInclude(JSON.stringify(pending), newSecret);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments), oldSecret);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments), newSecret);
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), newSecret);
    assert.notInclude(JSON.stringify(harness.writtenFiles), newSecret);

    harness.clearFailure("environmentVaultCommit");
    await harness.sandbox.retryEnvironmentRefresh({
      sessionId: SESSION_ID,
      nonce: pending?.operation?.nonce ?? "missing",
    });
    const committedRecord = harness.readRecord();
    const committedEnvironment = committedRecord?.environment;
    assert.ok(isSessionEnvironmentSnapshot(committedEnvironment));
    const newSentinel = committedEnvironment.variables.API_TOKEN;
    assert.strictEqual(committedRecord?.operation, null);
    assert.notStrictEqual(newSentinel, OLD_API_TOKEN_SENTINEL);
    assert.strictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_API_TOKEN_SENTINEL }),
      null,
    );
    assert.strictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_REMOVE_ME_SENTINEL }),
      null,
    );
    assert.deepStrictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: newSentinel }),
      { sentinel: newSentinel, value: newSecret },
    );
    assert.isUndefined(harness.appliedEnvironments.at(-1)?.REMOVE_ME);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments), newSecret);
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), newSecret);
    assert.notInclude(JSON.stringify(harness.writtenFiles), newSecret);
    const githubSentinel = committedEnvironment.variables.GH_TOKEN;
    assert.deepStrictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: githubSentinel }),
      { sentinel: githubSentinel, value: "authority-github-token" },
    );
  });

  it("retains secret rotation and removal across an ambiguous apply retry", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
          environment: secretPrevious,
        }),
        [sessionHarnessKeys.environmentVault]: secretVaultState,
      },
      environmentMaterialization: secretMaterialization,
      piSessionRunning: true,
      failureStage: "environmentApply",
    });

    const error = await rejection(harness.sandbox.refreshScottyEnvironment());
    assert.ok(error instanceof ScottyError);
    const pending = harness.readRecord();
    const target = pending?.operation?.environmentRefreshTarget;
    assert.ok(isSessionEnvironmentSnapshot(target));
    const stagedToken = target.variables.API_TOKEN;
    const stagedAdded = target.variables.ADDED;
    assert.notStrictEqual(stagedToken, OLD_API_TOKEN_SENTINEL);
    assert.notStrictEqual(stagedAdded, undefined);
    assert.strictEqual(
      (await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_API_TOKEN_SENTINEL }))
        ?.value,
      "old-rotation-secret",
    );
    assert.strictEqual(
      (await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_REMOVE_ME_SENTINEL }))
        ?.value,
      "removed-secret",
    );
    assert.deepStrictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: stagedToken }),
      { sentinel: stagedToken, value: "new-rotation-secret" },
    );
    assert.notInclude(JSON.stringify(pending), "old-rotation-secret");
    assert.notInclude(JSON.stringify(pending), "new-rotation-secret");

    harness.clearFailure("environmentApply");
    await harness.sandbox.retryEnvironmentRefresh({
      sessionId: SESSION_ID,
      nonce: pending?.operation?.nonce ?? "missing",
    });

    const committed = harness.readRecord();
    const environment = committed?.environment;
    assert.ok(isSessionEnvironmentSnapshot(environment));
    assert.strictEqual(committed?.operation, null);
    assert.strictEqual(environment.variables.API_TOKEN, stagedToken);
    assert.strictEqual(environment.variables.ADDED, stagedAdded);
    assert.strictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_API_TOKEN_SENTINEL }),
      null,
    );
    assert.strictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({ sentinel: OLD_REMOVE_ME_SENTINEL }),
      null,
    );
    assert.isUndefined(harness.appliedEnvironments.at(-1)?.REMOVE_ME);
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.API_TOKEN, stagedToken);
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.ADDED, stagedAdded);
    assert.notInclude(JSON.stringify(committed), "new-rotation-secret");
    assert.notInclude(JSON.stringify(harness.appliedEnvironments), "new-rotation-secret");
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), "new-rotation-secret");
    assert.notInclude(JSON.stringify(harness.writtenFiles), "new-rotation-secret");
  });

  it("returns an idempotent no-op when the committed revision is current", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "warm",
          environment: current,
        }),
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
      },
    ]) {
      const harness = await createSessionHarness({ initialEntries, environmentSnapshot: current });
      assert.isFalse((await harness.sandbox.getScottyEnvironmentStatus()).refreshable);
      const error = await rejection(harness.sandbox.refreshScottyEnvironment());
      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.httpStatus, 409);
    }
  });

  it("reconciles a prior ambiguous target to the newest authority revision", async () => {
    const attempted = {
      version: 1 as const,
      revision: 4,
      variables: { KEEP: "intermediate", TRANSIENT: "must-be-unset" },
    };
    const newest = { version: 1 as const, revision: 5, variables: { KEEP: "newest" } };
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

    assertEnvironmentWithGithub(harness.readRecord()?.environment, newest);
    assert.property(harness.appliedEnvironments.at(-1) ?? {}, "TRANSIENT");
    assert.isUndefined(harness.appliedEnvironments.at(-1)?.TRANSIENT);
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

    assertEnvironmentWithGithub(harness.readRecord()?.environment, current);
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
          environment: secretPrevious,
          backup: { current: backup },
          ownedBackupIds: [backup.id],
        }),
        [sessionHarnessKeys.environmentVault]: secretVaultState,
      },
      environmentMaterialization: secretMaterialization,
      failureStage: "environmentVaultCommit",
    });
    harness.injectFailure("environmentRefreshRetrySchedule");

    await rejection(harness.sandbox.refreshScottyEnvironment());

    const failed = harness.readRecord();
    assert.strictEqual(failed?.status, "failed");
    assert.isTrue(failed?.failure?.recoverable);
    assert.strictEqual(failed?.backup?.current.id, backup.id);
    assert.include(harness.events, "host:destroy");

    harness.clearFailure("environmentVaultCommit");
    harness.clearFailure("environmentRefreshRetrySchedule");
    const resumed = await harness.sandbox.resumeScottySession();

    assert.strictEqual(resumed.status, "warm");
    const resumedRecord = harness.readRecord();
    const resumedEnvironment = resumedRecord?.environment;
    assert.ok(isSessionEnvironmentSnapshot(resumedEnvironment));
    assert.strictEqual(resumedEnvironment.revision, secretPrevious.revision);
    assert.strictEqual(resumedEnvironment.variables.KEEP, "old");
    assert.strictEqual(resumedEnvironment.variables.API_TOKEN, OLD_API_TOKEN_SENTINEL);
    assert.notProperty(resumedEnvironment.variables, "ADDED");
    assert.property(resumedEnvironment.variables, "REMOVE_ME");
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.KEEP, "old");
    assert.strictEqual(
      harness.appliedEnvironments.at(-1)?.API_TOKEN,
      resumedEnvironment.variables.API_TOKEN,
    );
    assert.deepStrictEqual(
      await harness.sandbox.resolveEnvironmentSecretForProxy({
        sentinel: resumedEnvironment.variables.API_TOKEN,
      }),
      {
        sentinel: resumedEnvironment.variables.API_TOKEN,
        value: "old-rotation-secret",
      },
    );
    assert.strictEqual(harness.appliedEnvironments.at(-1)?.REMOVE_ME, OLD_REMOVE_ME_SENTINEL);
    assert.notInclude(JSON.stringify(resumedRecord), "new-rotation-secret");
    assert.notInclude(JSON.stringify(harness.appliedEnvironments), "new-rotation-secret");
    assert.notInclude(JSON.stringify(harness.piProcessEnvironments), "new-rotation-secret");
    assert.notInclude(JSON.stringify(harness.writtenFiles), "new-rotation-secret");
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
