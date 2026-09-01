import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { SessionActor, type ActorHandleError } from "./actor";
import { AuthorityStateSchema, type SessionAuthority, StableStateSchema } from "./authority";
import type { SessionActorInput } from "./input";
import { ActorStore, type ActorStoreReadError } from "./store";

export type LifecycleCommandKind = "Checkpoint" | "Sleep" | "Resume";

export interface LifecycleControllerRequest {
  readonly kind: LifecycleCommandKind;
  readonly correlationId: string;
  readonly nonce: string;
  readonly attempt: string;
  readonly timestamp: string;
  readonly deadlineAt: string;
}

export type LifecycleControllerResult =
  | { readonly _tag: "Settled"; readonly authority: SessionAuthority }
  | {
      readonly _tag: "Reconciling";
      readonly authority: SessionAuthority;
      readonly phase: string;
    }
  | {
      readonly _tag: "Failed";
      readonly authority: SessionAuthority;
      readonly code: string;
      readonly actionable: boolean;
    };

export class LifecycleControllerRejected extends Schema.TaggedError<LifecycleControllerRejected>()(
  "LifecycleControllerRejected",
  {
    kind: Schema.Literals(["Checkpoint", "Sleep", "Resume"]),
    code: Schema.String,
  },
) {}

export class LifecycleControllerInvariantFailure extends Schema.TaggedError<LifecycleControllerInvariantFailure>()(
  "LifecycleControllerInvariantFailure",
  { code: Schema.Literal("actor_committed_no_authority") },
) {}

export type LifecycleControllerError =
  | ActorHandleError
  | ActorStoreReadError
  | LifecycleControllerRejected
  | LifecycleControllerInvariantFailure;

interface LifecycleControllerShape {
  readonly run: (
    request: LifecycleControllerRequest,
  ) => Effect.Effect<LifecycleControllerResult, LifecycleControllerError>;
}

export class LifecycleController extends Context.Service<
  LifecycleController,
  LifecycleControllerShape
>()("scotty/SessionActor/LifecycleController") {}

const command = (
  request: LifecycleControllerRequest,
  expectedRevision: number,
): Extract<
  SessionActorInput,
  { readonly _tag: "CheckpointCommand" | "SleepCommand" | "ResumeCommand" }
> => ({
  _tag: `${request.kind}Command`,
  expectedRevision,
  correlationId: request.correlationId,
  nonce: request.nonce,
  attempt: request.attempt,
  timestamp: request.timestamp,
  deadlineAt: request.deadlineAt,
});

const classify = (authority: SessionAuthority): LifecycleControllerResult => {
  if (AuthorityStateSchema.guards.Transitioning(authority.state))
    return {
      _tag: "Reconciling",
      authority,
      phase: authority.state.transition.phase,
    };
  const stable = authority.state.stable;
  return StableStateSchema.guards.Failed(stable)
    ? {
        _tag: "Failed",
        authority,
        code: stable.code,
        actionable: stable.actionable,
      }
    : { _tag: "Settled", authority };
};

export const lifecycleControllerLayer: Layer.Layer<
  LifecycleController,
  never,
  ActorStore | SessionActor
> = Layer.effect(
  LifecycleController,
  Effect.gen(function* () {
    const store = yield* ActorStore;
    const actor = yield* SessionActor;
    return LifecycleController.of({
      run: Effect.fnUntraced(function* (request) {
        const before = yield* store.read;
        const handled = yield* actor.handle(command(request, before.revision));
        if (Predicate.isTagged(handled.decision, "Rejected"))
          return yield* new LifecycleControllerRejected({
            kind: request.kind,
            code: handled.decision.code,
          });
        const after = yield* store.read;
        if (after.authority === undefined)
          return yield* new LifecycleControllerInvariantFailure({
            code: "actor_committed_no_authority",
          });
        return classify(after.authority);
      }),
    });
  }),
);
