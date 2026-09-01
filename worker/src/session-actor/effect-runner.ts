import { Context, Effect, Layer, Match } from "effect";
import { AuthorityStateSchema } from "./authority";
import { ActorAlarmScheduler, type ActorAlarmOutcomeUnknown } from "./alarm";
import {
  type CommittedEffectIntent,
  type EffectObservation,
  ProviderEffectExecutor,
} from "./effects";

export type EffectRunnerError = ActorAlarmOutcomeUnknown;

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
  if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
    return { _tag: "NoObservation" };
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
    return ActorEffectRunner.of({
      run: Effect.fnUntraced(function* (committed) {
        return yield* Match.valueTags(committed.intent, {
          ArmDeadline: (intent) =>
            alarms
              .arm({
                alarmId: `${intent.transitionNonce}:${intent.attempt}:${intent.deadlineAt}`,
                revision: committed.authority.revision,
                transitionNonce: intent.transitionNonce,
                attempt: intent.attempt,
                expectedPhase: AuthorityStateSchema.guards.Transitioning(committed.authority.state)
                  ? committed.authority.state.transition.phase
                  : "",
                expectedDeadlineAt: intent.deadlineAt,
                correlationId: committed.journalEvent.correlationId,
              })
              .pipe(Effect.as({ _tag: "NoObservation" } as const)),
          ExecutePhase: (intent) =>
            provider.execute({ ...committed, intent }).pipe(
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
            ),
          ReconcileTransition: (intent) =>
            provider.execute({ ...committed, intent }).pipe(
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
            ),
        });
      }),
    });
  }),
);
