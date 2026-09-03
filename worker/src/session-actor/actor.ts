import { Context, Effect, Layer, Predicate } from "effect";
import { actorAlarmId, type ActorAlarmFence } from "./alarm";
import { AuthorityStateSchema, type SessionAuthority } from "./authority";
import { transitionOf } from "./control";
import type { Decision } from "./decision";
import { ActorEffectRunner, type EffectRunnerError } from "./effect-runner";
import type { SessionActorInput } from "./input";
import { decide } from "./reducer";
import {
  ActorStore,
  type ActorCommitRequest,
  type ActorStoreCommitError,
  type ActorStoreReadError,
  type ActorStoreReconcileError,
  type CommittedActorDecision,
  type EvidenceMutation,
} from "./store";
import { transitionKind } from "./transition";

export type ActorHandleError =
  | ActorStoreReadError
  | ActorStoreCommitError
  | ActorStoreReconcileError
  | EffectRunnerError;

export interface ActorHandleResult {
  readonly decision: Decision;
  readonly committed: ReadonlyArray<CommittedActorDecision>;
}

export const actorResultAuthority = (result: ActorHandleResult): SessionAuthority | undefined =>
  result.committed[result.committed.length - 1]?.authority;

export const actorResultRejectedBeforeCommit = (
  result: ActorHandleResult,
): result is ActorHandleResult & {
  readonly decision: Extract<Decision, { readonly _tag: "Rejected" }>;
} => result.committed.length === 0 && Predicate.isTagged(result.decision, "Rejected");

interface SessionActorShape {
  readonly handle: (
    input: SessionActorInput,
    evidence?: EvidenceMutation,
  ) => Effect.Effect<ActorHandleResult, ActorHandleError>;
  readonly resume: (input: {
    readonly timestamp: string;
    readonly correlationId: string;
    readonly fence?: ActorAlarmFence;
  }) => Effect.Effect<ActorHandleResult | undefined, ActorHandleError>;
}

export class SessionActor extends Context.Service<SessionActor, SessionActorShape>()(
  "scotty/SessionActor",
) {}

const commitRequest = (
  decision: Extract<Decision, { readonly _tag: "Accepted" }>,
  currentRevision: number,
  currentAuthority: Parameters<typeof transitionOf>[0] | undefined,
  evidence: EvidenceMutation,
  causeSequence: number | null,
): ActorCommitRequest => {
  const transition = currentAuthority === undefined ? undefined : transitionOf(currentAuthority);
  return {
    expectedRevision: currentRevision,
    expectedTransitionNonce: transition?.nonce ?? null,
    expectedPhase: transition?.phase ?? null,
    decision,
    evidence,
    causeSequence,
  };
};

const providerRuntimeId = (authority: SessionAuthority): string | null => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return null;
  const proof = authority.state.transition.proof;
  return "readiness" in proof && proof.readiness.runtime !== null
    ? proof.readiness.runtime.providerRuntimeId
    : null;
};

const matchesAlarmFence = (
  fence: ActorAlarmFence,
  authority: SessionAuthority,
  transition: Extract<SessionAuthority["state"], { readonly _tag: "Transitioning" }>["transition"],
): boolean =>
  fence.transitionNonce === transition.nonce &&
  fence.attempt === transition.attempt &&
  fence.expectedDeadlineAt === transition.deadlineAt &&
  fence.alarmId ===
    actorAlarmId(
      fence.kind,
      transition.nonce,
      transition.attempt,
      transition.deadlineAt,
      fence.expectedPhase,
    ) &&
  (fence.kind === "deadline" ||
    (transition.mode === "reconciling" &&
      fence.revision === authority.revision &&
      fence.expectedPhase === transition.phase));

const unknownObservationCommit = (
  authority: SessionAuthority,
  input: SessionActorInput,
): SessionActorInput | undefined => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return undefined;
  const transition = authority.state.transition;
  return {
    _tag: "UnknownProviderOutcome",
    revision: authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    timestamp: input.timestamp,
    correlationId: input.correlationId,
    expectedProviderRuntimeId: providerRuntimeId(authority),
    resultCode: "observation_commit_unknown",
  };
};

export const sessionActorLayer: Layer.Layer<SessionActor, never, ActorStore | ActorEffectRunner> =
  Layer.effect(
    SessionActor,
    Effect.gen(function* () {
      const store = yield* ActorStore;
      const runner = yield* ActorEffectRunner;

      const handle = Effect.fnUntraced(function* (
        initialInput: SessionActorInput,
        initialEvidence: EvidenceMutation = { _tag: "Keep" },
      ) {
        const committed: CommittedActorDecision[] = [];
        let input = initialInput;
        let evidence = initialEvidence;
        let recoverObservationCommit = false;
        let lastDecision: Decision;

        while (true) {
          const snapshot = yield* store.read;
          lastDecision = decide(snapshot.authority, input);
          if (Predicate.isTagged(lastDecision, "Rejected"))
            return { decision: lastDecision, committed };

          const request = commitRequest(
            lastDecision,
            snapshot.revision,
            snapshot.authority,
            evidence,
            snapshot.journalTail?.sequence ?? null,
          );
          const commitAndConfirm = (candidate: ActorCommitRequest) =>
            store
              .commit(candidate)
              .pipe(
                Effect.catchTag("ActorStoreTransactionOutcomeUnknown", () =>
                  store.reconcileUnknownCommit(candidate),
                ),
              );
          const persisted = yield* commitAndConfirm(request).pipe(
            Effect.catchTag("ActorStoreUnconfirmedCommit", (failure) => {
              if (!recoverObservationCommit || snapshot.authority === undefined)
                return Effect.fail(failure);
              const unknown = unknownObservationCommit(snapshot.authority, input);
              if (unknown === undefined) return Effect.fail(failure);
              const reconciliation = decide(snapshot.authority, unknown);
              if (Predicate.isTagged(reconciliation, "Rejected")) return Effect.fail(failure);
              lastDecision = reconciliation;
              return commitAndConfirm(
                commitRequest(
                  reconciliation,
                  snapshot.revision,
                  snapshot.authority,
                  { _tag: "Keep" },
                  snapshot.journalTail?.sequence ?? null,
                ),
              );
            }),
          );
          committed.push(persisted);
          evidence = { _tag: "Keep" };
          recoverObservationCommit = false;

          let observation: SessionActorInput | undefined;
          for (const intent of persisted.effectIntents) {
            const result = yield* runner.run({
              authority: persisted.authority,
              journalEvent: persisted.journalEvent,
              intent,
            });
            if (Predicate.isTagged(result, "Observation")) {
              observation = result.input;
              recoverObservationCommit = Predicate.isTagged(intent, "ExecutePhase");
            }
          }
          if (observation === undefined) return { decision: lastDecision, committed };
          input = observation;
        }
      });

      const resume = Effect.fnUntraced(function* (input: {
        readonly timestamp: string;
        readonly correlationId: string;
        readonly fence?: ActorAlarmFence;
      }) {
        const snapshot = yield* store.read;
        const authority = snapshot.authority;
        if (authority === undefined || !AuthorityStateSchema.guards.Transitioning(authority.state))
          return undefined;
        const transition = authority.state.transition;
        const fence = input.fence;
        if (fence !== undefined && !matchesAlarmFence(fence, authority, transition))
          return undefined;
        if (
          fence?.kind === "deadline" ||
          (fence?.kind === "reconcile" &&
            Date.parse(input.timestamp) >= Date.parse(transition.deadlineAt))
        )
          return yield* handle({
            _tag: "DeadlineAlarm",
            revision: authority.revision,
            transitionNonce: transition.nonce,
            attempt: transition.attempt,
            expectedPhase: transition.phase,
            timestamp: input.timestamp,
            correlationId: input.correlationId,
            alarmId: fence.alarmId,
            expectedDeadlineAt: transition.deadlineAt,
          });
        if (transition.mode === "reconciling") {
          const journalEvent = snapshot.journalTail;
          if (journalEvent === undefined) return undefined;
          yield* runner.run({
            authority,
            journalEvent,
            intent: {
              _tag: "ArmReconciliation",
              deadlineAt: transition.deadlineAt,
              transitionNonce: transition.nonce,
              attempt: transition.attempt,
            },
          });
          const observation = yield* runner.run({
            authority,
            journalEvent,
            intent: {
              _tag: "ReconcileTransition",
              transitionKind: transitionKind(transition),
              phase: transition.phase,
              transitionNonce: transition.nonce,
              attempt: transition.attempt,
            },
          });
          return Predicate.isTagged(observation, "Observation")
            ? yield* handle(observation.input)
            : undefined;
        }
        return yield* handle({
          _tag: "UnknownProviderOutcome",
          revision: authority.revision,
          transitionNonce: transition.nonce,
          attempt: transition.attempt,
          expectedPhase: transition.phase,
          timestamp: input.timestamp,
          correlationId: input.correlationId,
          expectedProviderRuntimeId: providerRuntimeId(authority),
          resultCode: "actor_restart_reconcile",
        });
      });

      return SessionActor.of({ handle, resume });
    }),
  );
