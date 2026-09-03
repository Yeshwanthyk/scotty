import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Predicate, Result } from "effect";
import type {
  CleanupProof,
  ReadinessProof,
  SessionAuthority,
  SessionIdentity,
  Transition,
} from "../../src/session-actor/authority";
import type { AcceptedDecision, Decision, EffectIntent } from "../../src/session-actor/decision";
import type { CommittedProviderEffectIntent } from "../../src/session-actor/effects";
import type { SessionActorInput } from "../../src/session-actor/input";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import { decide } from "../../src/session-actor/reducer";
import { transitionKind } from "../../src/session-actor/transition";
import {
  executeVaporizeTransition,
  VaporizeProviderFailure,
  type VaporizeProviderResult,
  type VaporizeTransitionProviderShape,
} from "../../src/session-actor/transitions/vaporize";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:01:00.000Z";
const DEADLINE = "2026-09-01T01:00:00.000Z";

const session: SessionIdentity = {
  id: "vaporize-session",
  title: "Vaporize session",
  repository: "owner/disposable",
  execution: { provider: "cloudflare", runtimeName: "runtime-vaporize-session" },
  createdAt: T0,
};
const readiness: ReadinessProof = {
  runtime: {
    providerRuntimeId: "provider-runtime-1",
    runtimeGeneration: "runtime-generation-1",
    containerIncarnation: "container-incarnation-1",
  },
  supervisor: {
    processId: "supervisor-1",
    supervisorEpoch: "supervisor-epoch-1",
    runtimeGeneration: "runtime-generation-1",
    containerIncarnation: "container-incarnation-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch: "supervisor-epoch-1",
    runtimeGeneration: "runtime-generation-1",
    containerIncarnation: "container-incarnation-1",
  },
};
const warm = (): SessionAuthority => ({
  session,
  hardCap: { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" },
  revision: 4,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: {
        ownedBackupIds: ["backup-1", "backup-2"],
        prepared: {
          backupId: "backup-2",
          preparedAt: T0,
          confirmedAt: T1,
          sourceRuntimeGeneration: "runtime-generation-1",
        },
        currentBackupId: "backup-2",
      },
      activity: null,
    },
  },
});

const command = (): SessionActorInput => ({
  _tag: "VaporizeCommand",
  expectedRevision: 4,
  correlationId: "vaporize-correlation",
  nonce: "vaporize-nonce",
  attempt: "vaporize-attempt",
  timestamp: T0,
  deadlineAt: DEADLINE,
});

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const goneCleanup = (authority: SessionAuthority): CleanupProof | undefined =>
  Match.valueTags(authority.state, {
    Transitioning: () => undefined,
    Stable: ({ stable }) =>
      Match.valueTags(stable, {
        Warm: () => undefined,
        Sleeping: () => undefined,
        Failed: () => undefined,
        Gone: ({ cleanup }) => cleanup,
      }),
  });

const vaporizeTransition = (
  authority: SessionAuthority,
): Extract<Transition, { readonly _tag: "Vaporize" }> | undefined =>
  Match.valueTags(authority.state, {
    Stable: () => undefined,
    Transitioning: ({ transition }) =>
      Match.valueTags(transition, {
        Create: () => undefined,
        Checkpoint: () => undefined,
        Sleep: () => undefined,
        Resume: () => undefined,
        WarmWork: () => undefined,
        Vaporize: (value) => value,
      }),
  });

const providerIntent = (
  decision: AcceptedDecision,
): Exclude<EffectIntent, { readonly _tag: "ArmDeadline" | "ArmReconciliation" }> => {
  const intent = decision.effectIntents.find(
    (candidate) =>
      !Predicate.isTagged(candidate, "ArmDeadline") &&
      !Predicate.isTagged(candidate, "ArmReconciliation"),
  );
  assert.ok(intent !== undefined);
  return intent;
};

const committed = (decision: AcceptedDecision): CommittedProviderEffectIntent => {
  const authority = decision.nextAuthority;
  assert.ok(Predicate.isTagged(authority.state, "Transitioning"));
  const transition = authority.state.transition;
  const journalEvent: LifecycleJournalEvent = {
    sequence: authority.revision,
    revision: authority.revision,
    timestamp: decision.journalEvent.timestamp,
    correlationId: decision.journalEvent.correlationId,
    transitionNonce: transition.nonce,
    eventType: decision.journalEvent.eventType,
    transitionKind: transitionKind(transition),
    transitionPhase: transition.phase,
    resultCode: decision.journalEvent.resultCode,
    causeSequence: null,
    causeAttempt: transition.attempt,
  };
  return { authority, journalEvent, intent: providerIntent(decision) };
};

const result = (
  tag: VaporizeProviderResult["_tag"],
  resultCode: string,
): VaporizeProviderResult => ({ _tag: tag, observedAt: T1, resultCode });

const provider = (
  calls: Array<string>,
  overrides: Partial<VaporizeTransitionProviderShape> = {},
): VaporizeTransitionProviderShape => ({
  revokeRuntimeAccess: () => {
    calls.push("revoke-runtime-access");
    return Effect.succeed(result("RuntimeAccessRevoked", "runtime_access_revoked"));
  },
  closeHatch: () => {
    calls.push("close-hatch");
    return Effect.succeed(result("HatchAbsent", "hatch_absent"));
  },
  interruptEvidence: () => {
    calls.push("interrupt-evidence");
    return Effect.succeed(result("EvidenceInterrupted", "evidence_interrupted"));
  },
  destroyRuntime: () => {
    calls.push("destroy-runtime");
    return Effect.succeed(result("RuntimeAbsent", "runtime_absent"));
  },
  deleteBackups: () => {
    calls.push("delete-backups");
    return Effect.succeed(result("BackupsAbsent", "backups_absent"));
  },
  deleteEvidence: () => {
    calls.push("delete-evidence");
    return Effect.succeed(result("EvidenceAbsent", "evidence_absent"));
  },
  releaseGrants: () => {
    calls.push("release-grants");
    return Effect.succeed(result("GrantsReleased", "grants_released"));
  },
  confirmAbsence: () => {
    calls.push("confirm-absence");
    return Effect.succeed(result("AbsenceConfirmed", "absence_confirmed"));
  },
  ...overrides,
});

describe("session actor vaporize", () => {
  it.effect(
    "retains authority through ordered cleanup and reaches Gone only after absence proof",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const implementation = provider(calls);
        let decision = accepted(decide(warm(), command()));
        assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Transitioning"));
        assert.ok(
          Predicate.isTagged(decision.nextAuthority.state, "Transitioning") &&
            Predicate.isTagged(decision.nextAuthority.state.transition, "Vaporize"),
        );
        assert.deepStrictEqual(
          Predicate.isTagged(decision.nextAuthority.state, "Transitioning") &&
            Predicate.isTagged(decision.nextAuthority.state.transition, "Vaporize")
            ? decision.nextAuthority.state.transition.proof.ownedBackupIds
            : [],
          ["backup-1", "backup-2"],
        );

        while (Predicate.isTagged(decision.nextAuthority.state, "Transitioning")) {
          const observation = yield* executeVaporizeTransition(implementation, committed(decision));
          decision = accepted(decide(decision.nextAuthority, observation));
        }

        assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
        assert.ok(
          Predicate.isTagged(decision.nextAuthority.state, "Stable") &&
            Predicate.isTagged(decision.nextAuthority.state.stable, "Gone"),
        );
        assert.deepStrictEqual(calls, [
          "revoke-runtime-access",
          "close-hatch",
          "interrupt-evidence",
          "destroy-runtime",
          "delete-backups",
          "delete-evidence",
          "release-grants",
          "confirm-absence",
          "confirm-absence",
        ]);
        const cleanup = goneCleanup(decision.nextAuthority);
        assert.ok(cleanup !== undefined);
        assert.deepStrictEqual(cleanup.absent, [
          "hatch",
          "runtime",
          "backups",
          "evidence",
          "grants",
          "idempotency",
          "schedules",
        ]);
      }),
  );

  it.effect("reports destroy ambiguity without releasing the Vaporize fence", () =>
    Effect.gen(function* () {
      const admitted = accepted(decide(warm(), command()));
      const revoked = yield* executeVaporizeTransition(provider([]), committed(admitted));
      const afterRevoke = accepted(decide(admitted.nextAuthority, revoked));
      const hatch = yield* executeVaporizeTransition(provider([]), committed(afterRevoke));
      const afterHatch = accepted(decide(afterRevoke.nextAuthority, hatch));
      const interrupted = yield* executeVaporizeTransition(provider([]), committed(afterHatch));
      const afterInterrupt = accepted(decide(afterHatch.nextAuthority, interrupted));
      const unknown = new VaporizeProviderFailure({
        outcome: "unknown_after_admission",
        safeResultCode: "runtime_destroy_outcome_unknown",
        observedAt: T1,
      });
      const attempted = yield* Effect.result(
        executeVaporizeTransition(
          provider([], { destroyRuntime: () => Effect.fail(unknown) }),
          committed(afterInterrupt),
        ),
      );
      assert.ok(Result.isFailure(attempted));
      assert.strictEqual(attempted.failure.outcome, "unknown_after_admission");
      const retained = vaporizeTransition(afterInterrupt.nextAuthority);
      assert.ok(retained !== undefined);
      assert.strictEqual(retained.phase, "EvidenceInterrupting");
    }),
  );
});
