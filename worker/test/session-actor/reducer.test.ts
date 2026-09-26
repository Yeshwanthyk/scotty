import { sessionIdentityPin } from "../runtime-cli/fixtures";
import { assert, describe, it } from "@effect/vitest";
import { Predicate } from "effect";
import type {
  BackupIdentity,
  ReadinessProof,
  SessionAuthority,
  Transition,
} from "../../src/session-actor/reducer/authority";
import {
  AuthorityStateSchema,
  StableStateSchema,
  TransitionSchema,
} from "../../src/session-actor/reducer/authority";
import type { AcceptedDecision, Decision } from "../../src/session-actor/reducer/decision";
import type {
  SessionActorInput,
  SessionCommand,
  TransitionProof,
} from "../../src/session-actor/reducer/input";
import { decide } from "../../src/session-actor/reducer/decide";
import { validateAuthority } from "../../src/session-actor/reducer/validity";
import { phaseIndex, transitionPhases } from "../../src/session-actor/reducer/transition";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const DEADLINE = "2026-01-01T01:00:00.000Z";
const hardCap = { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" };
const session = {
  id: "session-1",
  title: "Session one",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-name" },
  ...sessionIdentityPin,
  createdAt: T0,
};

const readiness = (
  runtimeGeneration = "runtime-1",
  supervisorEpoch = "supervisor-1",
): ReadinessProof => ({
  runtime: {
    providerRuntimeId: "provider-runtime-1",
    runtimeGeneration,
    containerIncarnation: "container-1",
  },
  supervisor: {
    processId: "pi-1",
    supervisorEpoch,
    runtimeGeneration,
    containerIncarnation: "container-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch,
    runtimeGeneration,
    containerIncarnation: "container-1",
  },
});

const backup = (runtimeGeneration = "runtime-1"): BackupIdentity => ({
  backupId: "backup-1",
  preparedAt: T0,
  confirmedAt: T1,
  sourceRuntimeGeneration: runtimeGeneration,
});

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const transitioning = (authority: SessionAuthority) => {
  assert.ok(AuthorityStateSchema.guards.Transitioning(authority.state));
  return authority.state;
};

const warmStable = (authority: SessionAuthority) => {
  const state = authority.state;
  assert.ok(AuthorityStateSchema.guards.Stable(state));
  assert.ok(StableStateSchema.guards.Warm(state.stable));
  return state.stable;
};

const failedStable = (authority: SessionAuthority) => {
  const state = authority.state;
  assert.ok(AuthorityStateSchema.guards.Stable(state));
  assert.ok(StableStateSchema.guards.Failed(state.stable));
  return state.stable;
};

const createCommand = (
  expectedRevision = 0,
): Extract<SessionCommand, { readonly _tag: "CreateCommand" }> => ({
  _tag: "CreateCommand",
  expectedRevision,
  correlationId: "correlation-create",
  nonce: "nonce-create",
  attempt: "attempt-create",
  timestamp: T0,
  deadlineAt: DEADLINE,
  session,
  hardCap,
});

const warmAuthority = (): SessionAuthority => ({
  session,
  hardCap,
  revision: 7,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness: readiness(),
      backups: { ownedBackupIds: ["backup-1"], prepared: backup(), currentBackupId: "backup-1" },
      activity: {
        supervisorEpoch: "supervisor-1",
        piSequence: 1,
        state: "working",
        observedAt: T0,
        expiresAt: DEADLINE,
      },
    },
  },
});

const warmWithReadiness = (proof: ReadinessProof): SessionAuthority => ({
  session,
  hardCap,
  revision: 1,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness: proof,
      backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      activity: null,
    },
  },
});

const command = (
  tag: "CheckpointCommand" | "SleepCommand" | "ResumeCommand" | "VaporizeCommand",
  revision: number,
): SessionCommand => {
  const fields = {
    expectedRevision: revision,
    correlationId: `correlation-${tag}`,
    nonce: `nonce-${tag}`,
    attempt: `attempt-${tag}`,
    timestamp: T0,
    deadlineAt: DEADLINE,
  };
  return tag === "ResumeCommand"
    ? { _tag: tag, ...fields, nextHardCap: hardCap }
    : { _tag: tag, ...fields };
};

const fact = (
  authority: SessionAuthority,
  nextPhase: string,
  proof: TransitionProof,
  overrides: Partial<Extract<SessionActorInput, { _tag: "ActorFact" }>> = {},
): SessionActorInput => {
  const transition = transitioning(authority).transition;
  return {
    _tag: "ActorFact",
    revision: authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    timestamp: T1,
    correlationId: "correlation-fact",
    nextPhase,
    proof,
    resultCode: "ok",
    ...overrides,
  };
};

const unknown = (authority: SessionAuthority, resultCode = "provider_outcome_unknown") => {
  const transition = transitioning(authority).transition;
  const proof = "readiness" in transition.proof ? transition.proof.readiness.runtime : null;
  return {
    _tag: "UnknownProviderOutcome" as const,
    revision: authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    timestamp: T1,
    correlationId: "correlation-provider-unknown",
    expectedProviderRuntimeId: proof?.providerRuntimeId ?? null,
    resultCode,
  };
};

const advanceToTerminal = (
  initial: SessionAuthority,
  proofFor: (transition: Transition, nextIndex: number) => TransitionProof,
): SessionAuthority => {
  let authority = initial;
  while (AuthorityStateSchema.guards.Transitioning(authority.state)) {
    const transition = authority.state.transition;
    const nextIndex = phaseIndex(transition) + 1;
    const nextPhase = transitionPhases(transition)[nextIndex];
    if (nextPhase === undefined) return authority;
    authority = accepted(
      decide(authority, fact(authority, nextPhase, proofFor(transition, nextIndex))),
    ).nextAuthority;
  }
  return authority;
};

const completeTerminal = (
  authority: SessionAuthority,
  proof: TransitionProof,
): SessionAuthority => {
  assert.strictEqual(AuthorityStateSchema.guards.Transitioning(authority.state), true);
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return authority;
  const transition = authority.state.transition;
  return accepted(
    decide(authority, {
      _tag: "TransitionCompleted",
      revision: authority.revision,
      transitionNonce: transition.nonce,
      attempt: transition.attempt,
      expectedPhase: transition.phase,
      timestamp: T1,
      correlationId: "correlation-complete",
      proof,
      resultCode: "completed",
    }),
  ).nextAuthority;
};

describe("session actor reducer", () => {
  it("admits same-session Create only from Failed Create recovery", () => {
    const failed: SessionAuthority = {
      session,
      hardCap,
      revision: 2,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Failed",
          code: "create_workspace_failed",
          origin: "Absent",
          lastStable: null,
          ownedBackupIds: [],
          recovery: { _tag: "Create" },
        },
      },
    };
    const retry = createCommand(2);
    const admitted = accepted(decide(failed, retry)).nextAuthority;
    const transition = transitioning(admitted).transition;
    assert.ok(TransitionSchema.guards.Create(transition));
    assert.strictEqual(transition.origin, "Failed");
    assert.strictEqual(admitted.session.id, failed.session.id);
    assert.strictEqual(
      validateAuthority({
        ...failed,
        state: {
          _tag: "Stable",
          stable: { ...failedStable(failed), ownedBackupIds: ["unexpected-backup"] },
        },
      }),
      false,
    );
    assert.deepStrictEqual(decide(failed, { ...retry, session: { ...session, id: "other" } }), {
      _tag: "Rejected",
      code: "not_admissible",
    });
    assert.deepStrictEqual(decide(failed, { ...retry, expectedRevision: 1 }), {
      _tag: "Rejected",
      code: "revision_mismatch",
    });
    assert.deepStrictEqual(decide(failed, command("ResumeCommand", 2)), {
      _tag: "Rejected",
      code: "not_admissible",
    });
  });

  it("admits Resume only with a confirmed owned Failed backup", () => {
    const failed: SessionAuthority = {
      session,
      hardCap,
      revision: 2,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Failed",
          code: "sleep_failed",
          origin: "Warm",
          lastStable: "Warm",
          ownedBackupIds: ["backup-1"],
          recovery: { _tag: "Resume", backup: backup() },
        },
      },
    };
    assert.strictEqual(validateAuthority(failed), true);
    const resumed = accepted(decide(failed, command("ResumeCommand", 2))).nextAuthority;
    const transition = transitioning(resumed).transition;
    assert.ok(TransitionSchema.guards.Resume(transition));
    assert.deepStrictEqual(transition.proof.backup, backup());
    assert.deepStrictEqual(decide(failed, createCommand(2)), {
      _tag: "Rejected",
      code: "not_admissible",
    });
    assert.strictEqual(
      validateAuthority({
        ...failed,
        state: { _tag: "Stable", stable: { ...failedStable(failed), ownedBackupIds: [] } },
      }),
      false,
    );
    assert.strictEqual(
      validateAuthority({
        ...failed,
        state: {
          _tag: "Stable",
          stable: {
            ...failedStable(failed),
            recovery: {
              _tag: "Resume",
              backup: { ...backup(), confirmedAt: null },
            },
          },
        },
      }),
      false,
    );
  });
  it("admits only commands valid for the current authority", () => {
    const created = accepted(decide(undefined, createCommand()));
    assert.strictEqual(created.nextAuthority.revision, 1);
    assert.strictEqual(created.effectIntents.length, 2);

    const duplicateCreate = decide(created.nextAuthority, createCommand(1));
    assert.deepStrictEqual(duplicateCreate, { _tag: "Rejected", code: "transition_owned" });
    assert.strictEqual("effectIntents" in duplicateCreate, false);

    const rejectedCheckpoint = decide(undefined, command("CheckpointCommand", 0));
    assert.deepStrictEqual(rejectedCheckpoint, { _tag: "Rejected", code: "not_admissible" });
  });

  it("renames only stable live authority through the reducer revision fence", () => {
    const current = warmAuthority();
    const rename = {
      _tag: "RenameCommand" as const,
      expectedRevision: current.revision,
      correlationId: "correlation-rename",
      timestamp: T1,
      title: "Renamed session",
    };
    const renamed = accepted(decide(current, rename));
    assert.strictEqual(renamed.nextAuthority.session.title, "Renamed session");
    assert.strictEqual(renamed.nextAuthority.revision, current.revision + 1);
    assert.strictEqual(renamed.journalEvent.eventType, "renamed");
    assert.deepStrictEqual(renamed.effectIntents, []);
    assert.deepStrictEqual(decide(renamed.nextAuthority, rename), {
      _tag: "Rejected",
      code: "revision_mismatch",
    });

    const checkpoint = accepted(decide(current, command("CheckpointCommand", current.revision)));
    assert.deepStrictEqual(
      decide(checkpoint.nextAuthority, {
        ...rename,
        expectedRevision: checkpoint.nextAuthority.revision,
      }),
      { _tag: "Rejected", code: "transition_owned" },
    );
  });

  it("lets vaporize preempt another operation but not itself", () => {
    const checkpoint = accepted(decide(warmAuthority(), command("CheckpointCommand", 7)));
    const vaporize = accepted(decide(checkpoint.nextAuthority, command("VaporizeCommand", 8)));
    const vaporizeTransition = transitioning(vaporize.nextAuthority).transition;
    assert.strictEqual(TransitionSchema.guards.Vaporize(vaporizeTransition), true);
    assert.strictEqual(vaporizeTransition.origin, "Warm");
    const repeated = decide(vaporize.nextAuthority, command("VaporizeCommand", 9));
    assert.deepStrictEqual(repeated, { _tag: "Rejected", code: "duplicate" });
  });

  it("keeps vaporize reconciling across repeated unknown provider outcomes", () => {
    const repeatedAdmission = accepted(
      decide(warmAuthority(), command("VaporizeCommand", warmAuthority().revision)),
    ).nextAuthority;
    const reconciling = accepted(
      decide(repeatedAdmission, unknown(repeatedAdmission)),
    ).nextAuthority;
    const repeated = accepted(decide(reconciling, unknown(reconciling))).nextAuthority;
    assert.ok(TransitionSchema.guards.Vaporize(transitioning(repeated).transition));
    assert.strictEqual(transitioning(repeated).transition.mode, "reconciling");
  });

  it("rejects forged fact fences without intents or mutation", () => {
    const created = accepted(decide(undefined, createCommand()));
    const authority = created.nextAuthority;
    const proof = transitioning(authority).transition.proof;
    const stale = decide(
      authority,
      fact(authority, "WorkspacePreparing", proof, { transitionNonce: "old" }),
    );
    assert.deepStrictEqual(stale, { _tag: "Rejected", code: "stale_nonce" });
    assert.strictEqual("effectIntents" in stale, false);
    assert.deepStrictEqual(
      decide(authority, fact(authority, "WorkspacePreparing", proof, { attempt: "old-attempt" })),
      { _tag: "Rejected", code: "stale_attempt" },
    );
    assert.deepStrictEqual(
      decide(
        authority,
        fact(authority, "WorkspacePreparing", proof, { expectedPhase: "old-phase" }),
      ),
      { _tag: "Rejected", code: "stale_phase" },
    );
    assert.deepStrictEqual(
      decide(authority, fact(authority, "WorkspacePreparing", proof, { revision: 99 })),
      { _tag: "Rejected", code: "revision_mismatch" },
    );
  });

  it("fails an ordinary transition at its deadline", () => {
    const created = accepted(decide(undefined, createCommand())).nextAuthority;
    const createdTransition = transitioning(created).transition;
    const alarm: SessionActorInput = {
      _tag: "DeadlineAlarm",
      revision: created.revision,
      transitionNonce: createdTransition.nonce,
      attempt: createdTransition.attempt,
      expectedPhase: createdTransition.phase,
      timestamp: DEADLINE,
      correlationId: "correlation-alarm",
      alarmId: "alarm-1",
      expectedDeadlineAt: DEADLINE,
    };
    const mismatched = decide(created, { ...alarm, expectedDeadlineAt: T1 });
    assert.deepStrictEqual(mismatched, { _tag: "Rejected", code: "stale_phase" });
    const failed = accepted(decide(created, alarm));
    assert.strictEqual(failedStable(failed.nextAuthority).code, "transition_deadline_elapsed");
    assert.deepStrictEqual(failed.effectIntents, []);
  });

  it("reconciles an unknown provider outcome without advancing phase", () => {
    const created = accepted(decide(undefined, createCommand())).nextAuthority;
    const transition = transitioning(created).transition;
    const reconciled = accepted(
      decide(created, {
        _tag: "UnknownProviderOutcome",
        revision: created.revision,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
        expectedPhase: transition.phase,
        timestamp: T1,
        correlationId: "correlation-provider-unknown",
        expectedProviderRuntimeId: null,
        resultCode: "provider_outcome_unknown",
      }),
    );
    const reconciling = transitioning(reconciled.nextAuthority).transition;
    assert.strictEqual(reconciling.phase, transition.phase);
    assert.strictEqual(reconciling.mode, "reconciling");
    const progressed = accepted(
      decide(
        reconciled.nextAuthority,
        fact(reconciled.nextAuthority, "CleanupObserved", {
          workspaceId: null,
          readiness: { runtime: null, supervisor: null, transport: null },
        }),
      ),
    );
    assert.strictEqual(transitioning(progressed.nextAuthority).transition.mode, "executing");
  });

  it("fails a repeated unknown while preserving the last confirmed backup", () => {
    const initial = accepted(
      decide(warmAuthority(), command("CheckpointCommand", warmAuthority().revision)),
    ).nextAuthority;
    const admittedTransition = transitioning(initial).transition;
    assert.ok(TransitionSchema.guards.Checkpoint(admittedTransition));
    const candidate: BackupIdentity = {
      backupId: "backup-2",
      preparedAt: T1,
      confirmedAt: null,
      sourceRuntimeGeneration: "runtime-1",
    };
    const admitted: SessionAuthority = {
      ...initial,
      state: {
        _tag: "Transitioning",
        transition: {
          ...admittedTransition,
          phase: "BackupPrepared",
          proof: {
            ...admittedTransition.proof,
            piStoppedAt: T1,
            backup: {
              ownedBackupIds: ["backup-1", "backup-2"],
              prepared: candidate,
              currentBackupId: "backup-1",
              confirmed: backup(),
            },
          },
        },
      },
    };
    assert.strictEqual(validateAuthority(admitted), true);
    const reconciling = accepted(decide(admitted, unknown(admitted))).nextAuthority;
    const failed = accepted(decide(reconciling, unknown(reconciling))).nextAuthority;
    assert.deepStrictEqual(failedStable(failed), {
      _tag: "Failed",
      code: "reconciliation_outcome_unknown",
      origin: "Warm",
      lastStable: "Warm",
      ownedBackupIds: ["backup-1", "backup-2"],
      recovery: { _tag: "Resume", backup: backup() },
    });
  });

  it("retains the reserved backup attempt when Syncing becomes ambiguous", () => {
    const initial = accepted(
      decide(warmAuthority(), command("CheckpointCommand", warmAuthority().revision)),
    ).nextAuthority;
    const transition = transitioning(initial).transition;
    assert.ok(TransitionSchema.guards.Checkpoint(transition));
    const syncing: SessionAuthority = {
      ...initial,
      state: {
        _tag: "Transitioning",
        transition: {
          ...transition,
          phase: "Syncing",
          proof: {
            ...transition.proof,
            piStoppedAt: T1,
            backup: {
              ...transition.proof.backup,
              ownedBackupIds: [...transition.proof.backup.ownedBackupIds, transition.attempt],
            },
          },
        },
      },
    };
    assert.isTrue(validateAuthority(syncing));

    const reconciling = accepted(decide(syncing, unknown(syncing))).nextAuthority;
    const failed = accepted(decide(reconciling, unknown(reconciling))).nextAuthority;
    assert.include(failedStable(failed).ownedBackupIds, transition.attempt);

    const vaporizing = accepted(
      decide(failed, command("VaporizeCommand", failed.revision)),
    ).nextAuthority;
    const vaporize = transitioning(vaporizing).transition;
    assert.ok(TransitionSchema.guards.Vaporize(vaporize));
    assert.include(vaporize.proof.ownedBackupIds, transition.attempt);
  });

  it("does not let a provider failure discard authoritative backup ownership", () => {
    const admitted = accepted(
      decide(warmAuthority(), command("CheckpointCommand", warmAuthority().revision)),
    ).nextAuthority;
    const transition = transitioning(admitted).transition;
    const failed = accepted(
      decide(admitted, {
        _tag: "TransitionFailed",
        revision: admitted.revision,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
        expectedPhase: transition.phase,
        timestamp: T1,
        correlationId: "correlation-failed",
        failureCode: "provider_rejected",
        ownedBackupIds: [],
        resultCode: "provider_rejected",
      }),
    ).nextAuthority;
    assert.deepInclude(failedStable(failed), {
      code: "provider_rejected",
      ownedBackupIds: ["backup-1"],
      recovery: { _tag: "Resume", backup: backup() },
    });
  });

  it("commits only current-generation activity observations", () => {
    const warm = warmAuthority();
    const observed = accepted(
      decide(warm, {
        _tag: "ActivityObserved",
        revision: warm.revision,
        expectedRuntimeGeneration: "runtime-1",
        expectedSupervisorEpoch: "supervisor-1",
        correlationId: "correlation-activity",
        timestamp: T1,
        activity: {
          supervisorEpoch: "supervisor-1",
          piSequence: 2,
          state: "waiting",
          observedAt: T1,
          expiresAt: DEADLINE,
        },
      }),
    );
    assert.strictEqual(observed.nextAuthority.revision, warm.revision + 1);
    assert.strictEqual(observed.effectIntents.length, 0);

    const stale = decide(observed.nextAuthority, {
      _tag: "ActivityObserved",
      revision: observed.nextAuthority.revision,
      expectedRuntimeGeneration: "runtime-old",
      expectedSupervisorEpoch: "supervisor-1",
      correlationId: "correlation-activity-stale",
      timestamp: T1,
      activity: {
        supervisorEpoch: "supervisor-1",
        piSequence: 3,
        state: "working",
        observedAt: T1,
        expiresAt: DEADLINE,
      },
    });
    assert.deepStrictEqual(stale, { _tag: "Rejected", code: "stale_generation" });

    const checkpoint = accepted(
      decide(observed.nextAuthority, command("CheckpointCommand", observed.nextAuthority.revision)),
    ).nextAuthority;
    const checkpointProof: TransitionProof = {
      readiness: readiness("runtime-2", "supervisor-2"),
      piStoppedAt: T1,
      backup: { ownedBackupIds: ["backup-1"], prepared: backup(), currentBackupId: "backup-1" },
    };
    const terminal = advanceToTerminal(checkpoint, () => checkpointProof);
    const completed = completeTerminal(terminal, checkpointProof);
    const completedWarm = warmStable(completed);
    assert.strictEqual(completedWarm.readiness.runtime.runtimeGeneration, "runtime-2");
    assert.strictEqual(completedWarm.activity, null);
  });

  it("preserves backup authority across WarmWork completion", () => {
    const warm = warmAuthority();
    const admitted = accepted(
      decide(warm, {
        _tag: "WarmWorkCommand",
        expectedRevision: warm.revision,
        correlationId: "correlation-work",
        nonce: "nonce-work",
        attempt: "attempt-work",
        timestamp: T0,
        deadlineAt: DEADLINE,
        workKind: "Evidence",
      }),
    ).nextAuthority;
    const terminal = advanceToTerminal(admitted, (transition, nextIndex) => {
      assert.ok(TransitionSchema.guards.WarmWork(transition));
      return { ...transition.proof, resultCode: nextIndex >= 2 ? "settled" : null };
    });
    const terminalTransition = transitioning(terminal).transition;
    assert.strictEqual(TransitionSchema.guards.WarmWork(terminalTransition), true);
    if (!TransitionSchema.guards.WarmWork(terminalTransition)) return;
    const completed = completeTerminal(terminal, terminalTransition.proof);
    assert.deepStrictEqual(warmStable(completed).backups, {
      ownedBackupIds: ["backup-1"],
      prepared: backup(),
      currentBackupId: "backup-1",
    });
  });

  it("fences observations by runtime generation", () => {
    const checkpoint = accepted(
      decide(warmAuthority(), command("CheckpointCommand", 7)),
    ).nextAuthority;
    const transition = transitioning(checkpoint).transition;
    const observation: SessionActorInput = {
      _tag: "RuntimeObservation",
      revision: checkpoint.revision,
      transitionNonce: transition.nonce,
      attempt: transition.attempt,
      expectedPhase: transition.phase,
      timestamp: T1,
      correlationId: "correlation-runtime",
      expectedRuntimeGeneration: "runtime-old",
      nextPhase: "PiStopped",
      proof: {
        readiness: readiness(),
        piStoppedAt: T1,
        backup: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      },
      resultCode: "stopped",
    };
    assert.deepStrictEqual(decide(checkpoint, observation), {
      _tag: "Rejected",
      code: "stale_generation",
    });
  });

  it("validates readiness coherence, backup ownership, wake proof, and gone cleanup", () => {
    const validWarm = warmAuthority();
    assert.strictEqual(validateAuthority(validWarm), true);
    const validWarmState = warmStable(validWarm);
    assert.strictEqual(
      validateAuthority({
        ...validWarm,
        state: {
          _tag: "Stable",
          stable: {
            ...validWarmState,
            backups: { ownedBackupIds: [], prepared: backup(), currentBackupId: null },
          },
        },
      }),
      false,
    );
    assert.strictEqual(
      validateAuthority({
        ...validWarm,
        state: {
          _tag: "Stable",
          stable: {
            ...validWarmState,
            backups: {
              ownedBackupIds: ["backup-1", "backup-2"],
              prepared: backup(),
              confirmed: { ...backup(), backupId: "backup-2" },
              currentBackupId: "backup-1",
            },
          },
        },
      }),
      false,
    );
    const incoherent: SessionAuthority = {
      session,
      hardCap,
      revision: 7,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Warm",
          readiness: {
            ...readiness(),
            transport: { ...readiness().transport, supervisorEpoch: "wrong" },
          },
          backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
          activity: null,
        },
      },
    };
    assert.strictEqual(validateAuthority(incoherent), false);
    assert.strictEqual(
      validateAuthority(
        warmWithReadiness({
          ...readiness(),
          supervisor: { ...readiness().supervisor, processId: "", supervisorEpoch: "" },
        }),
      ),
      false,
    );
    assert.strictEqual(
      validateAuthority(
        warmWithReadiness({
          ...readiness(),
          transport: { ...readiness().transport, transportId: "" },
        }),
      ),
      false,
    );

    const sleeping: SessionAuthority = {
      session,
      hardCap,
      revision: 1,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Sleeping",
          backup: backup(),
          ownedBackupIds: ["backup-1"],
          stop: { requestedAt: T0, observedAt: T1, runtimeGeneration: "runtime-1" },
          wakeSource: { backupId: "wrong", confirmedAt: T1 },
        },
      },
    };
    assert.strictEqual(validateAuthority(sleeping), false);
    const gone: SessionAuthority = {
      session,
      hardCap,
      revision: 1,
      state: {
        _tag: "Stable",
        stable: { _tag: "Gone", cleanup: { absent: ["runtime"], lastObservedAt: T1 } },
      },
    };
    assert.strictEqual(validateAuthority(gone), false);
  });

  it("commits transport verification intent before transport proof exists", () => {
    const verifying: SessionAuthority = {
      session,
      hardCap,
      revision: 6,
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Create",
          nonce: "nonce-create",
          origin: "Absent",
          attempt: "attempt-create",
          startedAt: T0,
          lastProgressAt: T1,
          deadlineAt: DEADLINE,
          mode: "executing",
          phase: "TransportVerifying",
          proof: {
            workspaceId: "workspace-1",
            readiness: {
              runtime: readiness().runtime,
              supervisor: readiness().supervisor,
              transport: null,
            },
          },
        },
      },
    };
    assert.strictEqual(validateAuthority(verifying), true);
    const transition = transitioning(verifying).transition;
    assert.deepStrictEqual(
      decide(verifying, {
        _tag: "TransitionCompleted",
        revision: verifying.revision,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
        expectedPhase: transition.phase,
        timestamp: T1,
        correlationId: "correlation-transport-incomplete",
        proof: transition.proof,
        resultCode: "transport_not_verified",
      }),
      { _tag: "Rejected", code: "invalid_progress" },
    );
  });
});
