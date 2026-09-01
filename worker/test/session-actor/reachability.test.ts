import { assert, describe, it } from "@effect/vitest";
import { Match, Predicate, Result } from "effect";
import type {
  BackupIdentity,
  ReadinessProof,
  SessionAuthority,
  Transition,
} from "../../src/session-actor/authority";
import { decodeSessionAuthority } from "../../src/session-actor/authority";
import { AuthorityStateSchema } from "../../src/session-actor/authority";
import type { AcceptedDecision, Decision } from "../../src/session-actor/decision";
import type {
  SessionActorInput,
  SessionCommand,
  TransitionProof,
} from "../../src/session-actor/input";
import { decide, validateAuthority } from "../../src/session-actor/reducer";
import {
  phaseIndex,
  phases,
  transitionKind,
  transitionPhases,
} from "../../src/session-actor/transition";

const T0 = "2026-02-01T00:00:00.000Z";
const T1 = "2026-02-01T00:01:00.000Z";
const DEADLINE = "2026-02-01T01:00:00.000Z";
const hardCap = { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" };
const session = {
  id: "session-reachable",
  title: "Reachable session",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-name" },
  createdAt: T0,
};
const ready: ReadinessProof = {
  runtime: {
    providerRuntimeId: "provider-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  supervisor: {
    processId: "pi-1",
    supervisorEpoch: "epoch-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch: "epoch-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
};
const currentBackup: BackupIdentity = {
  backupId: "backup-1",
  preparedAt: T0,
  confirmedAt: T1,
  sourceRuntimeGeneration: "runtime-1",
};

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  assert.strictEqual(validateAuthority(decision.nextAuthority), true);
  return decision;
};

const transitioning = (authority: SessionAuthority) => {
  assert.ok(AuthorityStateSchema.guards.Transitioning(authority.state));
  return authority.state;
};

const stable = (authority: SessionAuthority) => {
  assert.ok(AuthorityStateSchema.guards.Stable(authority.state));
  return authority.state.stable;
};

const stableKind = (authority: SessionAuthority): string =>
  Match.valueTags(stable(authority), {
    Warm: () => "Warm",
    Sleeping: () => "Sleeping",
    Failed: () => "Failed",
    Gone: () => "Gone",
  });

const createProofAt = (nextIndex: number): TransitionProof => ({
  workspaceId: nextIndex >= 1 ? "workspace-1" : null,
  readiness: {
    runtime: nextIndex >= 3 ? ready.runtime : null,
    supervisor: nextIndex >= 5 ? ready.supervisor : null,
    transport: nextIndex >= 6 ? ready.transport : null,
  },
});

const checkpointProofAt = (nextIndex: number): TransitionProof => ({
  readiness: ready,
  piStoppedAt: nextIndex >= 1 ? T1 : null,
  backup: {
    ownedBackupIds: nextIndex >= 3 ? ["backup-1"] : [],
    prepared: nextIndex >= 3 ? currentBackup : null,
    currentBackupId: nextIndex >= 4 ? "backup-1" : null,
  },
});

const sleepProofAt = (nextIndex: number): TransitionProof => ({
  readiness: ready,
  piStoppedAt: nextIndex >= 1 ? T1 : null,
  backup: {
    ownedBackupIds: nextIndex >= 3 ? ["backup-1"] : [],
    prepared: nextIndex >= 3 ? currentBackup : null,
    currentBackupId: nextIndex >= 3 ? "backup-1" : null,
  },
  stop: nextIndex >= 4 ? { requestedAt: T0, observedAt: T1, runtimeGeneration: "runtime-1" } : null,
});

const proofAt = (transition: Transition, nextIndex: number): TransitionProof => {
  return Match.valueTags(transition, {
    Create: () => createProofAt(nextIndex),
    Checkpoint: () => checkpointProofAt(nextIndex),
    Sleep: () => sleepProofAt(nextIndex),
    Resume: (value) => ({
      ...value.proof,
      readiness: {
        runtime: nextIndex >= 2 ? ready.runtime : null,
        supervisor: nextIndex >= 4 ? ready.supervisor : null,
        transport: nextIndex >= 5 ? ready.transport : null,
      },
    }),
    WarmWork: (value) => ({ ...value.proof, resultCode: nextIndex >= 2 ? "settled" : null }),
    Vaporize: (): TransitionProof => ({
      revokedAt: nextIndex >= 1 ? T1 : null,
      cleanup: {
        absent:
          nextIndex >= 8
            ? ["runtime", "backups", "evidence", "grants", "hatch", "idempotency", "schedules"]
            : [],
        lastObservedAt: T1,
      },
    }),
  });
};

const advanceToTerminal = (initial: SessionAuthority, reached: Set<string>): SessionAuthority => {
  let authority = initial;
  while (AuthorityStateSchema.guards.Transitioning(authority.state)) {
    const transition = authority.state.transition;
    reached.add(`${transitionKind(transition)}:${transition.phase}`);
    const nextIndex = phaseIndex(transition) + 1;
    const nextPhase = transitionPhases(transition)[nextIndex];
    if (nextPhase === undefined) return authority;
    const input: SessionActorInput = {
      _tag: "ActorFact",
      revision: authority.revision,
      transitionNonce: transition.nonce,
      attempt: transition.attempt,
      expectedPhase: transition.phase,
      timestamp: T1,
      correlationId: `correlation-${transitionKind(transition)}-${nextPhase}`,
      nextPhase,
      proof: proofAt(transition, nextIndex),
      resultCode: "ok",
    };
    authority = accepted(decide(authority, input)).nextAuthority;
  }
  return authority;
};

const complete = (authority: SessionAuthority): SessionAuthority => {
  const transition = transitioning(authority).transition;
  const input: SessionActorInput = {
    _tag: "TransitionCompleted",
    revision: authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    timestamp: T1,
    correlationId: `complete-${transitionKind(transition)}`,
    proof: proofAt(transition, phaseIndex(transition)),
    resultCode: "completed",
  };
  return accepted(decide(authority, input)).nextAuthority;
};

const makeCommand = (tag: SessionCommand["_tag"], revision: number): SessionCommand => {
  const common = {
    expectedRevision: revision,
    correlationId: `correlation-${tag}`,
    nonce: `nonce-${tag}-${revision}`,
    attempt: `attempt-${tag}-${revision}`,
    timestamp: T0,
    deadlineAt: DEADLINE,
  };
  if (tag === "CreateCommand") return { _tag: tag, ...common, session, hardCap };
  if (tag === "WarmWorkCommand") return { _tag: tag, ...common, workKind: "Evidence" };
  if (tag === "CheckpointCommand") return { _tag: tag, ...common };
  if (tag === "SleepCommand") return { _tag: tag, ...common };
  if (tag === "ResumeCommand") return { _tag: tag, ...common, nextHardCap: hardCap };
  return { _tag: tag, ...common };
};

describe("session actor reachability", () => {
  it("reaches every stable and transitioning variant through reducer inputs", () => {
    const reached = new Set<string>();
    let authority = advanceToTerminal(
      accepted(decide(undefined, makeCommand("CreateCommand", 0))).nextAuthority,
      reached,
    );
    authority = complete(authority);
    reached.add(`Stable:${stableKind(authority)}`);

    for (const tag of ["CheckpointCommand", "WarmWorkCommand"] as const) {
      authority = advanceToTerminal(
        accepted(decide(authority, makeCommand(tag, authority.revision))).nextAuthority,
        reached,
      );
      authority = complete(authority);
      reached.add(`Stable:${stableKind(authority)}`);
    }

    authority = advanceToTerminal(
      accepted(decide(authority, makeCommand("SleepCommand", authority.revision))).nextAuthority,
      reached,
    );
    authority = complete(authority);
    reached.add(`Stable:${stableKind(authority)}`);

    authority = advanceToTerminal(
      accepted(decide(authority, makeCommand("ResumeCommand", authority.revision))).nextAuthority,
      reached,
    );
    authority = complete(authority);

    const failing = accepted(
      decide(authority, makeCommand("SleepCommand", authority.revision)),
    ).nextAuthority;
    const failingTransition = transitioning(failing).transition;
    const failed = accepted(
      decide(failing, {
        _tag: "TransitionFailed",
        revision: failing.revision,
        transitionNonce: failingTransition.nonce,
        attempt: failingTransition.attempt,
        expectedPhase: failingTransition.phase,
        timestamp: T1,
        correlationId: "correlation-failed",
        failureCode: "provider_unavailable",
        actionable: true,
        backup: currentBackup,
        ownedBackupIds: ["backup-1"],
        wakeSource: { backupId: "backup-1", confirmedAt: T1 },
        resultCode: "failed",
      }),
    ).nextAuthority;
    reached.add(`Stable:${stableKind(failed)}`);

    authority = advanceToTerminal(
      accepted(decide(failed, makeCommand("VaporizeCommand", failed.revision))).nextAuthority,
      reached,
    );
    authority = complete(authority);
    reached.add(`Stable:${stableKind(authority)}`);

    for (const [kind, kindPhases] of Object.entries(phases))
      for (const phase of kindPhases)
        assert.strictEqual(reached.has(`${kind}:${phase}`), true, `${kind}:${phase}`);
    for (const stable of ["Warm", "Sleeping", "Failed", "Gone"])
      assert.strictEqual(reached.has(`Stable:${stable}`), true, stable);
  });

  it("rejects schema-shaped but semantically unreachable authorities", () => {
    const incoherent: SessionAuthority = {
      session,
      hardCap,
      revision: 1,
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Create",
          nonce: "nonce",
          origin: "Warm",
          attempt: "attempt",
          startedAt: T0,
          lastProgressAt: T1,
          deadlineAt: DEADLINE,
          mode: "executing",
          phase: "TransportVerifying",
          proof: {
            workspaceId: "workspace-1",
            readiness: {
              runtime: ready.runtime,
              supervisor: ready.supervisor,
              transport: ready.transport,
            },
          },
        },
      },
    };
    assert.strictEqual(Result.isSuccess(decodeSessionAuthority(incoherent)), true);
    assert.strictEqual(validateAuthority(incoherent), false);

    const unownedSleeping: SessionAuthority = {
      session,
      hardCap,
      revision: 1,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Sleeping",
          backup: currentBackup,
          ownedBackupIds: [],
          stop: { requestedAt: T0, observedAt: T1, runtimeGeneration: "runtime-1" },
          wakeSource: { backupId: "backup-1", confirmedAt: T1 },
        },
      },
    };
    assert.strictEqual(Result.isSuccess(decodeSessionAuthority(unownedSleeping)), true);
    assert.strictEqual(validateAuthority(unownedSleeping), false);
  });
});
