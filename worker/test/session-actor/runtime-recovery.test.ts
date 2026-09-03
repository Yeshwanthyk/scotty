import { assert, describe, it } from "@effect/vitest";
import { Predicate } from "effect";
import type {
  HardCapProof,
  ReadinessProof,
  SessionAuthority,
} from "../../src/session-actor/authority";
import { AuthorityStateSchema, StableStateSchema } from "../../src/session-actor/authority";
import type { AcceptedDecision, Decision } from "../../src/session-actor/decision";
import type { SessionActorInput } from "../../src/session-actor/input";
import { decide } from "../../src/session-actor/reducer";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:01:00.000Z";
const CAP = "2026-09-01T01:00:00.000Z";
const AFTER_CAP = "2026-09-01T01:00:01.000Z";
const hardCap = (generation = "hard-cap-1", deadlineAt = CAP): HardCapProof => ({
  durationSeconds: 3_600,
  deadlineAt,
  generation,
});
const session = {
  id: "session-recovery",
  title: "Recovery session",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-recovery" },
  createdAt: T0,
};
const readiness: ReadinessProof = {
  runtime: {
    providerRuntimeId: "provider-runtime-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  supervisor: {
    processId: "pi-1",
    supervisorEpoch: "supervisor-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch: "supervisor-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
};
const backup = {
  backupId: "backup-1",
  preparedAt: T0,
  confirmedAt: T1,
  sourceRuntimeGeneration: "runtime-1",
};

const warm = (withActivity = false): SessionAuthority => ({
  session,
  hardCap: hardCap(),
  revision: 7,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: {
        ownedBackupIds: [backup.backupId],
        prepared: backup,
        currentBackupId: backup.backupId,
      },
      activity: withActivity
        ? {
            supervisorEpoch: "supervisor-1",
            piSequence: 4,
            state: "working",
            observedAt: T0,
            expiresAt: CAP,
          }
        : null,
    },
  },
});

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const runtimeInput = (
  overrides: Partial<
    Extract<SessionActorInput, { readonly _tag: "RuntimeLifecycleObserved" }>
  > = {},
): Extract<SessionActorInput, { readonly _tag: "RuntimeLifecycleObserved" }> => ({
  _tag: "RuntimeLifecycleObserved",
  expectedProviderRuntimeId: "provider-runtime-1",
  expectedRuntimeGeneration: "runtime-1",
  lifecycle: "stopped",
  runtime: null,
  correlationId: "runtime-callback",
  timestamp: T1,
  resultCode: "runtime_stopped_callback",
  ...overrides,
});

const hardCapInput = (
  overrides: Partial<Extract<SessionActorInput, { readonly _tag: "HardCapDeadlineAlarm" }>> = {},
): Extract<SessionActorInput, { readonly _tag: "HardCapDeadlineAlarm" }> => ({
  _tag: "HardCapDeadlineAlarm",
  alarmId: "hard-cap-1",
  expectedGeneration: "hard-cap-1",
  expectedDeadlineAt: CAP,
  correlationId: "hard-cap-alarm",
  timestamp: AFTER_CAP,
  ...overrides,
});

describe("session actor runtime recovery", () => {
  it("commits a matching runtime stop as an actionable failure before cleanup", () => {
    const result = accepted(decide(warm(), runtimeInput()));
    assert.strictEqual(result.journalEvent.eventType, "availability_lost");
    assert.deepStrictEqual(result.effectIntents, []);
    assert.ok(AuthorityStateSchema.guards.Stable(result.nextAuthority.state));
    const stable = result.nextAuthority.state.stable;
    assert.ok(StableStateSchema.guards.Failed(stable));
    assert.strictEqual(stable.code, "runtime_stopped");
    assert.strictEqual(stable.actionable, true);
    assert.strictEqual(stable.backup?.backupId, "backup-1");
  });

  it("rejects stale runtime callback generations and journals matching starts", () => {
    assert.deepStrictEqual(
      decide(warm(), runtimeInput({ expectedRuntimeGeneration: "runtime-old" })),
      { _tag: "Rejected", code: "stale_generation" },
    );
    const observed = accepted(
      decide(
        warm(),
        runtimeInput({
          lifecycle: "started",
          runtime: readiness.runtime,
          resultCode: "runtime_started_callback",
        }),
      ),
    );
    assert.strictEqual(observed.journalEvent.eventType, "runtime_observed");
    assert.deepStrictEqual(observed.nextAuthority.state, warm().state);
  });

  it("ignores a current-runtime confirmation without advancing the Sleep revision", () => {
    const current = warm();
    const sleeping = accepted(
      decide(current, {
        _tag: "SleepCommand",
        expectedRevision: current.revision,
        correlationId: "sleep",
        nonce: "sleep-nonce",
        attempt: "sleep-attempt",
        timestamp: T0,
        deadlineAt: CAP,
      }),
    ).nextAuthority;
    assert.deepStrictEqual(
      decide(
        sleeping,
        runtimeInput({
          lifecycle: "started",
          runtime: readiness.runtime,
          resultCode: "runtime_started_confirmed",
        }),
      ),
      { _tag: "Rejected", code: "duplicate" },
    );
    assert.strictEqual(sleeping.revision, current.revision + 1);
    assert.ok(AuthorityStateSchema.guards.Transitioning(sleeping.state));
    assert.strictEqual(sleeping.state.transition.mode, "executing");
    assert.strictEqual(sleeping.state.transition.phase, "Quiescing");
  });

  it("enters exact reconciliation when availability is lost during an owned transition", () => {
    const current = warm();
    const checkpoint = accepted(
      decide(current, {
        _tag: "CheckpointCommand",
        expectedRevision: current.revision,
        correlationId: "checkpoint",
        nonce: "checkpoint-nonce",
        attempt: "checkpoint-attempt",
        timestamp: T0,
        deadlineAt: CAP,
      }),
    ).nextAuthority;
    const reconciled = accepted(decide(checkpoint, runtimeInput()));
    assert.ok(AuthorityStateSchema.guards.Transitioning(reconciled.nextAuthority.state));
    assert.strictEqual(reconciled.nextAuthority.state.transition.phase, "Quiescing");
    assert.strictEqual(reconciled.nextAuthority.state.transition.mode, "reconciling");
    assert.strictEqual(reconciled.effectIntents.length, 1);
    assert.ok(Predicate.isTagged(reconciled.effectIntents[0], "ArmReconciliation"));
    assert.deepStrictEqual(decide(reconciled.nextAuthority, runtimeInput()), {
      _tag: "Rejected",
      code: "duplicate",
    });
  });

  it("settles a matching runtime-stop callback from Sleep.StopRequested", () => {
    const sleepingTransition: SessionAuthority = {
      session,
      hardCap: hardCap(),
      revision: 14,
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Sleep",
          nonce: "sleep-nonce",
          origin: "Warm",
          attempt: "sleep-attempt",
          startedAt: T0,
          lastProgressAt: T1,
          deadlineAt: CAP,
          mode: "executing",
          phase: "StopRequested",
          proof: {
            readiness,
            piStoppedAt: T1,
            backup: {
              ownedBackupIds: [backup.backupId],
              prepared: backup,
              currentBackupId: backup.backupId,
            },
            stopRequestedAt: T1,
            stop: null,
          },
        },
      },
    };
    const stillStarted = accepted(
      decide(
        sleepingTransition,
        runtimeInput({
          lifecycle: "started",
          runtime: readiness.runtime,
          resultCode: "runtime_started_confirmed",
        }),
      ),
    );
    assert.strictEqual(stillStarted.journalEvent.eventType, "availability_lost");
    assert.strictEqual(stillStarted.effectIntents.length, 1);
    assert.ok(AuthorityStateSchema.guards.Transitioning(stillStarted.nextAuthority.state));
    assert.strictEqual(stillStarted.nextAuthority.state.transition.mode, "reconciling");
    assert.deepStrictEqual(decide(sleepingTransition, runtimeInput()), {
      _tag: "Rejected",
      code: "duplicate",
    });
    assert.ok(AuthorityStateSchema.guards.Transitioning(sleepingTransition.state));
    const settled = accepted(
      decide(
        {
          ...sleepingTransition,
          state: {
            _tag: "Transitioning",
            transition: { ...sleepingTransition.state.transition, mode: "reconciling" },
          },
        },
        runtimeInput(),
      ),
    );
    assert.deepStrictEqual(settled.effectIntents, []);
    assert.ok(AuthorityStateSchema.guards.Stable(settled.nextAuthority.state));
    const stable = settled.nextAuthority.state.stable;
    assert.ok(StableStateSchema.guards.Sleeping(stable));
    assert.deepStrictEqual(stable.stop, {
      requestedAt: T1,
      observedAt: T1,
      runtimeGeneration: "runtime-1",
    });
    assert.strictEqual(stable.wakeSource.backupId, backup.backupId);
  });

  it("fences supervisor and transport loss by their exact generations", () => {
    const supervisorLost: SessionActorInput = {
      _tag: "SupervisorUnavailableObserved",
      expectedRuntimeGeneration: "runtime-1",
      expectedSupervisorEpoch: "supervisor-1",
      correlationId: "supervisor-loss",
      timestamp: T1,
      resultCode: "supervisor_missing",
    };
    const supervisorFailure = accepted(decide(warm(), supervisorLost));
    assert.ok(AuthorityStateSchema.guards.Stable(supervisorFailure.nextAuthority.state));
    assert.ok(StableStateSchema.guards.Failed(supervisorFailure.nextAuthority.state.stable));
    assert.strictEqual(supervisorFailure.nextAuthority.state.stable.code, "supervisor_unavailable");
    assert.deepStrictEqual(
      decide(warm(), { ...supervisorLost, expectedSupervisorEpoch: "supervisor-old" }),
      { _tag: "Rejected", code: "stale_generation" },
    );

    const transportLost: SessionActorInput = {
      _tag: "TransportUnavailableObserved",
      expectedRuntimeGeneration: "runtime-1",
      expectedSupervisorEpoch: "supervisor-1",
      expectedTransportId: "transport-1",
      correlationId: "transport-loss",
      timestamp: T1,
      resultCode: "transport_missing",
    };
    const transportFailure = accepted(decide(warm(), transportLost));
    assert.ok(AuthorityStateSchema.guards.Stable(transportFailure.nextAuthority.state));
    assert.ok(StableStateSchema.guards.Failed(transportFailure.nextAuthority.state.stable));
    assert.strictEqual(transportFailure.nextAuthority.state.stable.code, "transport_unavailable");
    assert.deepStrictEqual(
      decide(warm(), { ...transportLost, expectedTransportId: "transport-old" }),
      { _tag: "Rejected", code: "stale_generation" },
    );
  });

  it("accepts only increasing Pi activity sequence in the current supervisor epoch", () => {
    const current = warm(true);
    const input: Extract<SessionActorInput, { readonly _tag: "ActivityObserved" }> = {
      _tag: "ActivityObserved",
      revision: current.revision,
      expectedRuntimeGeneration: "runtime-1",
      expectedSupervisorEpoch: "supervisor-1",
      correlationId: "activity",
      timestamp: T1,
      activity: {
        supervisorEpoch: "supervisor-1",
        piSequence: 5,
        state: "waiting",
        observedAt: T1,
        expiresAt: CAP,
      },
    };
    const observed = accepted(decide(current, input));
    assert.strictEqual(observed.nextAuthority.hardCap.generation, "hard-cap-1");
    assert.deepStrictEqual(
      decide(current, { ...input, activity: { ...input.activity, piSequence: 4 } }),
      {
        _tag: "Rejected",
        code: "duplicate",
      },
    );
    assert.deepStrictEqual(
      decide(current, {
        ...input,
        expectedSupervisorEpoch: "supervisor-old",
        activity: { ...input.activity, supervisorEpoch: "supervisor-old", piSequence: 6 },
      }),
      { _tag: "Rejected", code: "stale_generation" },
    );
  });

  it("ignores stale and early hard-cap alarms and commits the current cap as failure", () => {
    assert.deepStrictEqual(decide(warm(), hardCapInput({ expectedGeneration: "hard-cap-old" })), {
      _tag: "Rejected",
      code: "stale_generation",
    });
    assert.deepStrictEqual(decide(warm(), hardCapInput({ timestamp: T1 })), {
      _tag: "Rejected",
      code: "stale_phase",
    });
    const elapsed = accepted(decide(warm(), hardCapInput()));
    assert.strictEqual(elapsed.journalEvent.eventType, "hard_cap_elapsed");
    assert.deepStrictEqual(elapsed.effectIntents, []);
    assert.ok(AuthorityStateSchema.guards.Stable(elapsed.nextAuthority.state));
    assert.ok(StableStateSchema.guards.Failed(elapsed.nextAuthority.state.stable));
    assert.strictEqual(elapsed.nextAuthority.state.stable.code, "hard_cap_elapsed");
  });

  it("keeps the last confirmed backup when availability is lost while a replacement is prepared", () => {
    const candidate = {
      backupId: "backup-2",
      preparedAt: T1,
      confirmedAt: null,
      sourceRuntimeGeneration: "runtime-1",
    };
    const checkpoint: SessionAuthority = {
      ...warm(),
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Checkpoint",
          nonce: "checkpoint-nonce",
          origin: "Warm",
          attempt: "checkpoint-attempt",
          startedAt: T0,
          lastProgressAt: T1,
          deadlineAt: CAP,
          mode: "executing",
          phase: "BackupPrepared",
          proof: {
            readiness,
            piStoppedAt: T1,
            backup: {
              ownedBackupIds: [backup.backupId, candidate.backupId],
              prepared: candidate,
              currentBackupId: backup.backupId,
              confirmed: backup,
            },
          },
        },
      },
    };
    const reconciling = accepted(decide(checkpoint, runtimeInput())).nextAuthority;
    const elapsed = accepted(decide(reconciling, hardCapInput())).nextAuthority;
    assert.ok(AuthorityStateSchema.guards.Stable(elapsed.state));
    assert.ok(StableStateSchema.guards.Failed(elapsed.state.stable));
    assert.strictEqual(elapsed.state.stable.backup?.backupId, backup.backupId);
    assert.deepStrictEqual(elapsed.state.stable.ownedBackupIds, [
      backup.backupId,
      candidate.backupId,
    ]);
  });

  it("retains cleanup ownership when a first backup is unconfirmed at the hard cap", () => {
    const candidate = {
      backupId: "backup-first",
      preparedAt: T1,
      confirmedAt: null,
      sourceRuntimeGeneration: "runtime-1",
    };
    const checkpoint: SessionAuthority = {
      ...warm(),
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Checkpoint",
          nonce: "checkpoint-nonce",
          origin: "Warm",
          attempt: "checkpoint-attempt",
          startedAt: T0,
          lastProgressAt: T1,
          deadlineAt: CAP,
          mode: "reconciling",
          phase: "BackupPrepared",
          proof: {
            readiness,
            piStoppedAt: T1,
            backup: {
              ownedBackupIds: [candidate.backupId],
              prepared: candidate,
              currentBackupId: null,
              confirmed: null,
            },
          },
        },
      },
    };
    const elapsed = accepted(decide(checkpoint, hardCapInput())).nextAuthority;
    assert.ok(AuthorityStateSchema.guards.Stable(elapsed.state));
    assert.ok(StableStateSchema.guards.Failed(elapsed.state.stable));
    assert.strictEqual(elapsed.state.stable.actionable, false);
    assert.strictEqual(elapsed.state.stable.backup, null);
    assert.deepStrictEqual(elapsed.state.stable.ownedBackupIds, [candidate.backupId]);
  });

  it("atomically activates a pre-armed next hard cap only on resume admission", () => {
    const sleeping: SessionAuthority = {
      session,
      hardCap: hardCap("hard-cap-old", T1),
      revision: 12,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Sleeping",
          backup,
          ownedBackupIds: [backup.backupId],
          stop: { requestedAt: T0, observedAt: T1, runtimeGeneration: "runtime-1" },
          wakeSource: { backupId: backup.backupId, confirmedAt: T1 },
        },
      },
    };
    const nextHardCap = hardCap("hard-cap-next", CAP);
    const resumed = accepted(
      decide(sleeping, {
        _tag: "ResumeCommand",
        expectedRevision: sleeping.revision,
        correlationId: "resume",
        nonce: "resume-nonce",
        attempt: "resume-attempt",
        timestamp: T1,
        deadlineAt: CAP,
        nextHardCap,
      }),
    );
    assert.deepStrictEqual(resumed.nextAuthority.hardCap, nextHardCap);
    assert.deepStrictEqual(
      decide(sleeping, {
        _tag: "ResumeCommand",
        expectedRevision: sleeping.revision + 1,
        correlationId: "resume-stale",
        nonce: "resume-stale",
        attempt: "resume-stale",
        timestamp: T1,
        deadlineAt: CAP,
        nextHardCap,
      }),
      { _tag: "Rejected", code: "revision_mismatch" },
    );
    assert.deepStrictEqual(sleeping.hardCap, hardCap("hard-cap-old", T1));
  });
});
