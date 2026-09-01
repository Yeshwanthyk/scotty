import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { SessionActor, type ActorHandleError } from "../actor";
import {
  AuthorityStateSchema,
  TransitionSchema,
  type SessionAuthority,
  type Transition,
  type WarmWorkKind,
} from "../authority";
import { ActorStore, type ActorStoreReadError, type EvidenceMutation } from "../store";

export interface WarmWorkRequest {
  readonly kind: WarmWorkKind;
  readonly correlationId: string;
  readonly nonce: string;
  readonly attempt: string;
  readonly timestamp: string;
  readonly deadlineAt: string;
  readonly evidence?: EvidenceMutation;
}

export interface WarmWorkLease {
  readonly authority: SessionAuthority;
  readonly kind: WarmWorkKind;
  readonly nonce: string;
  readonly attempt: string;
  readonly correlationId: string;
}

type WarmWorkAuthority = SessionAuthority & {
  readonly state: {
    readonly _tag: "Transitioning";
    readonly transition: Extract<Transition, { readonly _tag: "WarmWork" }>;
  };
};

export class WarmWorkRejected extends Schema.TaggedError<WarmWorkRejected>()("WarmWorkRejected", {
  kind: Schema.String,
  code: Schema.String,
}) {}

export class WarmWorkInvariantFailure extends Schema.TaggedError<WarmWorkInvariantFailure>()(
  "WarmWorkInvariantFailure",
  { code: Schema.Literal("actor_committed_without_warm_work") },
) {}

export type WarmWorkControllerError =
  | ActorHandleError
  | ActorStoreReadError
  | WarmWorkRejected
  | WarmWorkInvariantFailure;

interface WarmWorkControllerShape {
  readonly current: (
    kind: WarmWorkKind,
    nonce: string,
  ) => Effect.Effect<WarmWorkLease, WarmWorkControllerError>;
  readonly admit: (
    request: WarmWorkRequest,
  ) => Effect.Effect<WarmWorkLease, WarmWorkControllerError>;
  readonly settle: (
    lease: WarmWorkLease,
    timestamp: string,
    resultCode: string,
  ) => Effect.Effect<SessionAuthority, WarmWorkControllerError>;
  readonly reconcile: (
    lease: WarmWorkLease,
    timestamp: string,
    resultCode: string,
  ) => Effect.Effect<SessionAuthority, WarmWorkControllerError>;
}

export class WarmWorkController extends Context.Service<
  WarmWorkController,
  WarmWorkControllerShape
>()("scotty/SessionActor/WarmWorkController") {}

const requireLease = Effect.fnUntraced(function* (
  store: ActorStore["Service"],
  kind: WarmWorkKind,
  nonce: string,
): Effect.fn.Return<WarmWorkAuthority, ActorStoreReadError | WarmWorkInvariantFailure> {
  const snapshot = yield* store.read;
  const authority = snapshot.authority;
  if (
    authority === undefined ||
    !AuthorityStateSchema.guards.Transitioning(authority.state) ||
    !TransitionSchema.guards.WarmWork(authority.state.transition) ||
    authority.state.transition.workKind !== kind ||
    authority.state.transition.nonce !== nonce
  )
    return yield* new WarmWorkInvariantFailure({
      code: "actor_committed_without_warm_work",
    });
  return {
    ...authority,
    state: { _tag: "Transitioning", transition: authority.state.transition },
  };
});

const rejected = (kind: WarmWorkKind, code: string) => new WarmWorkRejected({ kind, code });

export const warmWorkControllerLayer: Layer.Layer<
  WarmWorkController,
  never,
  ActorStore | SessionActor
> = Layer.effect(
  WarmWorkController,
  Effect.gen(function* () {
    const store = yield* ActorStore;
    const actor = yield* SessionActor;

    const progress = Effect.fnUntraced(function* (
      lease: WarmWorkLease,
      timestamp: string,
      nextPhase: "Running" | "Settling",
      resultCode: string,
    ) {
      const current = yield* requireLease(store, lease.kind, lease.nonce);
      const transition = current.state.transition;
      if (!TransitionSchema.guards.WarmWork(transition))
        return yield* new WarmWorkInvariantFailure({
          code: "actor_committed_without_warm_work",
        });
      const handled = yield* actor.handle({
        _tag: "ActorFact",
        revision: current.revision,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
        expectedPhase: transition.phase,
        timestamp,
        correlationId: lease.correlationId,
        nextPhase,
        proof: {
          ...transition.proof,
          resultCode: nextPhase === "Settling" ? resultCode : null,
        },
        resultCode,
      });
      if (Predicate.isTagged(handled.decision, "Rejected"))
        return yield* rejected(lease.kind, handled.decision.code);
      return yield* requireLease(store, lease.kind, lease.nonce);
    });

    return WarmWorkController.of({
      current: Effect.fnUntraced(function* (kind, nonce) {
        const authority = yield* requireLease(store, kind, nonce);
        const snapshot = yield* store.read;
        return {
          authority,
          kind,
          nonce,
          attempt: authority.state.transition.attempt,
          correlationId: snapshot.journalTail?.correlationId ?? `warm-work-${nonce}`,
        };
      }),
      admit: Effect.fnUntraced(function* (request) {
        const before = yield* store.read;
        const handled = yield* actor.handle(
          {
            _tag: "WarmWorkCommand",
            expectedRevision: before.revision,
            correlationId: request.correlationId,
            nonce: request.nonce,
            attempt: request.attempt,
            timestamp: request.timestamp,
            deadlineAt: request.deadlineAt,
            workKind: request.kind,
          },
          request.evidence,
        );
        if (Predicate.isTagged(handled.decision, "Rejected"))
          return yield* rejected(request.kind, handled.decision.code);
        const authority = yield* requireLease(store, request.kind, request.nonce);
        const lease = {
          authority,
          kind: request.kind,
          nonce: request.nonce,
          attempt: request.attempt,
          correlationId: request.correlationId,
        } satisfies WarmWorkLease;
        yield* progress(lease, request.timestamp, "Running", "warm_work_started");
        return { ...lease, authority: yield* requireLease(store, request.kind, request.nonce) };
      }),
      settle: Effect.fnUntraced(function* (lease, timestamp, resultCode) {
        const settling = yield* progress(lease, timestamp, "Settling", resultCode);
        const transition = settling.state.transition;
        if (!TransitionSchema.guards.WarmWork(transition))
          return yield* new WarmWorkInvariantFailure({
            code: "actor_committed_without_warm_work",
          });
        const handled = yield* actor.handle({
          _tag: "TransitionCompleted",
          revision: settling.revision,
          transitionNonce: transition.nonce,
          attempt: transition.attempt,
          expectedPhase: transition.phase,
          timestamp,
          correlationId: lease.correlationId,
          proof: transition.proof,
          resultCode,
        });
        if (Predicate.isTagged(handled.decision, "Rejected"))
          return yield* rejected(lease.kind, handled.decision.code);
        const after = yield* store.read;
        if (after.authority === undefined)
          return yield* new WarmWorkInvariantFailure({
            code: "actor_committed_without_warm_work",
          });
        return after.authority;
      }),
      reconcile: Effect.fnUntraced(function* (lease, timestamp, resultCode) {
        const current = yield* requireLease(store, lease.kind, lease.nonce);
        const transition = current.state.transition;
        if (!TransitionSchema.guards.WarmWork(transition))
          return yield* new WarmWorkInvariantFailure({
            code: "actor_committed_without_warm_work",
          });
        const handled = yield* actor.handle({
          _tag: "UnknownProviderOutcome",
          revision: current.revision,
          transitionNonce: transition.nonce,
          attempt: transition.attempt,
          expectedPhase: transition.phase,
          timestamp,
          correlationId: lease.correlationId,
          expectedProviderRuntimeId: transition.proof.readiness.runtime.providerRuntimeId,
          resultCode,
        });
        if (Predicate.isTagged(handled.decision, "Rejected"))
          return yield* rejected(lease.kind, handled.decision.code);
        const after = yield* store.read;
        if (after.authority === undefined)
          return yield* new WarmWorkInvariantFailure({
            code: "actor_committed_without_warm_work",
          });
        return after.authority;
      }),
    });
  }),
);
