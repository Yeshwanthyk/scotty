import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { actorResultRejectedBeforeCommit, SessionActor, type ActorHandleError } from "./actor";
import {
  AuthorityStateSchema,
  failedCreateOf,
  type FailedRecovery,
  type SessionAuthority,
  StableStateSchema,
} from "./reducer/authority";
import {
  CreateHardCapController,
  CreateMetadataController,
  type CreateControllerBoundaryFailure,
  type CreateControllerRejected,
} from "./create-controller";
import type { MetadataStoreReadError, MetadataStoreMutationError } from "./metadata-store";
import type { SessionActorInput } from "./reducer/input";
import { decide } from "./reducer/decide";
import { ActorStore, type ActorStoreReadError } from "./store";

export type LifecycleCommandKind = "Create" | "Checkpoint" | "Sleep" | "Resume";

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
      readonly kind: "Create";
      readonly nextHardCap: SessionAuthority["hardCap"];
    })
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
      readonly recovery: FailedRecovery;
    };

export class LifecycleControllerRejected extends Schema.TaggedError<LifecycleControllerRejected>()(
  "LifecycleControllerRejected",
  {
    kind: Schema.Literals(["Create", "Checkpoint", "Sleep", "Resume"]),
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
  | CreateControllerRejected
  | MetadataStoreReadError
  | MetadataStoreMutationError
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
  session: SessionAuthority["session"] | undefined,
): Extract<SessionActorInput, { readonly _tag: `${LifecycleCommandKind}Command` }> | undefined => {
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
  if (request.kind === "Create")
    return session === undefined
      ? undefined
      : { _tag: "CreateCommand", ...base, session, hardCap: request.nextHardCap };
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
        recovery: stable.recovery,
      }
    : { _tag: "Settled", authority };
};

export const lifecycleControllerLayer: Layer.Layer<
  LifecycleController,
  never,
  ActorStore | SessionActor | CreateHardCapController | CreateMetadataController
> = Layer.effect(
  LifecycleController,
  Effect.gen(function* () {
    const store = yield* ActorStore;
    const actor = yield* SessionActor;
    const hardCap = yield* CreateHardCapController;
    const metadata = yield* CreateMetadataController;
    return LifecycleController.of({
      run: Effect.fnUntraced(function* (request) {
        const before = yield* store.read;
        const current = before.authority;
        if (current === undefined)
          return yield* new LifecycleControllerRejected({
            kind: request.kind,
            code: "not_admissible",
          });
        const input = command(request, before.revision, current.session);
        if (input === undefined)
          return yield* new LifecycleControllerRejected({
            kind: request.kind,
            code: "not_admissible",
          });
        const proposed = decide(current, input);
        if (Predicate.isTagged(proposed, "Rejected"))
          return yield* new LifecycleControllerRejected({
            kind: request.kind,
            code: proposed.code,
          });
        if (request.kind === "Resume" || request.kind === "Create") {
          yield* hardCap.arm({
            sessionId: proposed.nextAuthority.session.id,
            generation: request.nextHardCap.generation,
            deadlineAt: request.nextHardCap.deadlineAt,
            durationSeconds: request.nextHardCap.durationSeconds,
          });
        }
        if (request.kind === "Create") {
          yield* metadata.prepareRetry(current, proposed.nextAuthority);
        }
        const handled = yield* actor.handle(input);
        if (actorResultRejectedBeforeCommit(handled))
          return yield* new LifecycleControllerRejected({
            kind: request.kind,
            code: handled.decision.code,
          });
        const after = yield* store.read;
        if (after.authority === undefined)
          return yield* new LifecycleControllerInvariantFailure({
            code: "actor_committed_no_authority",
          });
        if (
          request.kind === "Create" &&
          AuthorityStateSchema.guards.Stable(after.authority.state) &&
          failedCreateOf(after.authority) === undefined
        )
          yield* metadata.scrubSettled(after.authority, request.attempt);
        return classify(after.authority);
      }),
    });
  }),
);
