import { Context, Effect, Exit, Layer, Match, Schema } from "effect";
import { AuthorityStateSchema, type Transition } from "./authority";
import { actorAlarmId, ActorAlarmScheduler, type ActorAlarmOutcomeUnknown } from "./alarm";
import {
  type CommittedEffectIntent,
  type CommittedProviderEffectIntent,
  type EffectObservation,
  ProviderEffectExecutor,
} from "./effects";

export class ActorEffectRunnerInvariantFailure extends Schema.TaggedError<ActorEffectRunnerInvariantFailure>()(
  "ActorEffectRunnerInvariantFailure",
  { code: Schema.Literal("committed_authority_not_transitioning") },
) {}

export type EffectRunnerError = ActorAlarmOutcomeUnknown | ActorEffectRunnerInvariantFailure;

const boundaryFailureObservation = (
  committed: CommittedEffectIntent,
  expectedRevision: number,
  transitionNonce: string,
  attempt: string,
  expectedPhase: string,
  providerRuntimeId: string | null,
  safeResultCode: string,
  outcome: "rejected_before_admission" | "unknown_after_admission",
  observedAt: string,
): EffectObservation => {
  return {
    _tag: "Observation",
    input:
      outcome === "unknown_after_admission"
        ? {
            _tag: "UnknownProviderOutcome",
            revision: expectedRevision,
            transitionNonce,
            attempt,
            expectedPhase,
            timestamp: observedAt,
            correlationId: committed.journalEvent.correlationId,
            expectedProviderRuntimeId: providerRuntimeId,
            resultCode: safeResultCode,
          }
        : {
            _tag: "TransitionFailed",
            revision: expectedRevision,
            transitionNonce,
            attempt,
            expectedPhase,
            timestamp: observedAt,
            correlationId: committed.journalEvent.correlationId,
            failureCode: safeResultCode,
            actionable: false,
            backup: null,
            ownedBackupIds: [],
            wakeSource: null,
            resultCode: safeResultCode,
          },
  };
};

interface ActorEffectRunnerShape {
  readonly run: (
    committed: CommittedEffectIntent,
  ) => Effect.Effect<EffectObservation, EffectRunnerError>;
}

export class ActorEffectRunner extends Context.Service<ActorEffectRunner, ActorEffectRunnerShape>()(
  "scotty/SessionActor/EffectRunner",
) {}

export const actorEffectRunnerLayer: Layer.Layer<
  ActorEffectRunner,
  never,
  ActorAlarmScheduler | ProviderEffectExecutor
> = Layer.effect(
  ActorEffectRunner,
  Effect.gen(function* () {
    const alarms = yield* ActorAlarmScheduler;
    const provider = yield* ProviderEffectExecutor;
    const executeProvider = Effect.fnUntraced(function* (
      committed: CommittedProviderEffectIntent,
      transition: Transition,
    ) {
      const result = yield* provider.execute(committed).pipe(
        Effect.map((input) => ({ _tag: "Observation", input }) as const),
        Effect.catchTag("ProviderEffectBoundaryFailure", (failure) =>
          Effect.succeed(
            boundaryFailureObservation(
              committed,
              failure.expectedRevision,
              failure.transitionNonce,
              failure.attempt,
              failure.expectedPhase,
              failure.expectedProviderRuntimeId,
              failure.safeResultCode,
              failure.outcome,
              failure.observedAt,
            ),
          ),
        ),
        Effect.exit,
      );
      if (Exit.isSuccess(result)) return result.value;
      const proof = transition.proof;
      const runtime = "readiness" in proof ? proof.readiness.runtime : null;
      return boundaryFailureObservation(
        committed,
        committed.authority.revision,
        transition.nonce,
        transition.attempt,
        transition.phase,
        runtime?.providerRuntimeId ?? null,
        Exit.hasInterrupts(result) ? "provider_effect_interrupted" : "provider_effect_defect",
        "unknown_after_admission",
        committed.journalEvent.timestamp,
      );
    });
    return ActorEffectRunner.of({
      run: Effect.fnUntraced(function* (committed) {
        if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
          return yield* new ActorEffectRunnerInvariantFailure({
            code: "committed_authority_not_transitioning",
          });
        const transition = committed.authority.state.transition;
        return yield* Match.valueTags(committed.intent, {
          ArmDeadline: (intent) =>
            alarms
              .arm({
                kind: "deadline",
                alarmId: actorAlarmId(
                  "deadline",
                  intent.transitionNonce,
                  intent.attempt,
                  intent.deadlineAt,
                ),
                revision: committed.authority.revision,
                transitionNonce: intent.transitionNonce,
                attempt: intent.attempt,
                expectedPhase: transition.phase,
                expectedDeadlineAt: intent.deadlineAt,
                correlationId: committed.journalEvent.correlationId,
              })
              .pipe(Effect.as({ _tag: "NoObservation" } as const)),
          ArmReconciliation: (intent) =>
            alarms
              .arm({
                kind: "reconcile",
                alarmId: actorAlarmId(
                  "reconcile",
                  intent.transitionNonce,
                  intent.attempt,
                  intent.deadlineAt,
                  transition.phase,
                ),
                revision: committed.authority.revision,
                transitionNonce: intent.transitionNonce,
                attempt: intent.attempt,
                expectedPhase: transition.phase,
                expectedDeadlineAt: intent.deadlineAt,
                correlationId: committed.journalEvent.correlationId,
              })
              .pipe(Effect.as({ _tag: "NoObservation" } as const)),
          ExecutePhase: (intent) => executeProvider({ ...committed, intent }, transition),
          ReconcileTransition: (intent) => executeProvider({ ...committed, intent }, transition),
        });
      }),
    });
  }),
);
