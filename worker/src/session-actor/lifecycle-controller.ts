import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { SessionActor, type ActorHandleError } from "./actor";
import { AuthorityStateSchema, type SessionAuthority, StableStateSchema } from "./authority";
import { CreateHardCapController, type CreateControllerBoundaryFailure } from "./create-controller";
import type { SessionActorInput } from "./input";
import { decide } from "./reducer";
import { ActorStore, type ActorStoreReadError } from "./store";

export type LifecycleCommandKind = "Checkpoint" | "Sleep" | "Resume";

interface LifecycleControllerRequestBase {
  readonly kind: LifecycleCommandKind;
  readonly correlationId: string;
  readonly nonce: string;
  readonly attempt: string;
  readonly timestamp: string;
  readonly deadlineAt: string;
}

export type LifecycleControllerRequest =
  | (LifecycleControllerRequestBase & { readonly kind: "Checkpoint" })
  | (LifecycleControllerRequestBase & { readonly kind: "Sleep" })
  | (LifecycleControllerRequestBase & {
      readonly kind: "Resume";
      readonly nextHardCap: SessionAuthority["hardCap"];
    });

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
  | CreateControllerBoundaryFailure
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
): Extract<SessionActorInput, { readonly _tag: `${LifecycleCommandKind}Command` }> => {
  const base = {
    expectedRevision,
    correlationId: request.correlationId,
    nonce: request.nonce,
    attempt: request.attempt,
    timestamp: request.timestamp,
    deadlineAt: request.deadlineAt,
  };
  if (request.kind === "Checkpoint") return { _tag: "CheckpointCommand", ...base };
  if (request.kind === "Sleep") return { _tag: "SleepCommand", ...base };
  return { _tag: "ResumeCommand", ...base, nextHardCap: request.nextHardCap };
};

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
  ActorStore | SessionActor | CreateHardCapController
> = Layer.effect(
  LifecycleController,
  Effect.gen(function* () {
    const store = yield* ActorStore;
    const actor = yield* SessionActor;
    const hardCap = yield* CreateHardCapController;
    return LifecycleController.of({
      run: Effect.fnUntraced(function* (request) {
        const before = yield* store.read;
        const input = command(request, before.revision);
        const proposed = decide(before.authority, input);
        if (Predicate.isTagged(proposed, "Rejected"))
          return yield* new LifecycleControllerRejected({
            kind: request.kind,
            code: proposed.code,
          });
        if (request.kind === "Resume") {
          yield* hardCap.arm({
            sessionId: proposed.nextAuthority.session.id,
            generation: request.nextHardCap.generation,
            deadlineAt: request.nextHardCap.deadlineAt,
          });
        }
        const handled = yield* actor.handle(input);
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
