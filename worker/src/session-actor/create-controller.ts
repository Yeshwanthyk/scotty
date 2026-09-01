import { Context, Effect, Layer, Predicate, Result, Schema } from "effect";
import { SessionActor, type ActorHandleError, type ActorHandleResult } from "./actor";
import {
  AuthorityStateSchema,
  type SessionAuthority,
  type SessionIdentity,
  StableStateSchema,
} from "./authority";
import type { SessionActorInput } from "./input";
import {
  makeSessionActorMetadata,
  type CreateIdempotencyDigestMetadata,
  type SessionActorMetadata,
  type SessionActorMetadataInput,
  type SessionActorMetadataViolation,
} from "./metadata";
import {
  SessionActorMetadataStore,
  type MetadataStoreConflict,
  type MetadataStoreMutationError,
  type MetadataStoreReadError,
} from "./metadata-store";
import { decide, validateAuthority } from "./reducer";
import { ActorStore, type ActorStoreReadError } from "./store";

export interface CreateControllerRequest {
  readonly session: SessionIdentity;
  readonly branch: string;
  readonly createRepositoryIfMissing: boolean;
  readonly initialPrompt: string;
  readonly payloadReference: string;
  readonly idempotency?: CreateIdempotencyDigestMetadata;
  readonly correlationId: string;
  readonly nonce: string;
  readonly attempt: string;
  readonly timestamp: string;
  readonly transitionDeadlineAt: string;
  readonly hardCap: {
    readonly durationSeconds: number;
    readonly deadlineAt: string;
    readonly generation: string;
  };
}

export type CreateControllerResult =
  | {
      readonly _tag: "Warm";
      readonly replay: boolean;
      readonly authority: SessionAuthority;
    }
  | {
      readonly _tag: "Failed";
      readonly replay: boolean;
      readonly authority: SessionAuthority;
      readonly code: string;
      readonly actionable: boolean;
    }
  | {
      readonly _tag: "Reconciling";
      readonly replay: boolean;
      readonly authority: SessionAuthority;
      readonly phase: string;
    };

export class CreateControllerRejected extends Schema.TaggedError<CreateControllerRejected>()(
  "CreateControllerRejected",
  { code: Schema.String },
) {}

export class CreateControllerConflict extends Schema.TaggedError<CreateControllerConflict>()(
  "CreateControllerConflict",
  { sessionId: Schema.String },
) {}

export class CreateControllerInvariantFailure extends Schema.TaggedError<CreateControllerInvariantFailure>()(
  "CreateControllerInvariantFailure",
  {
    code: Schema.Literals([
      "actor_committed_no_authority",
      "authority_identity_mismatch",
      "authority_invalid",
      "create_finished_in_unexpected_state",
      "metadata_reservation_invalid",
    ]),
  },
) {}

export class CreateControllerBoundaryFailure extends Schema.TaggedError<CreateControllerBoundaryFailure>()(
  "CreateControllerBoundaryFailure",
  {
    boundary: Schema.Literals(["hard_cap", "metadata"]),
    code: Schema.String,
  },
) {}

export type CreateControllerError =
  | ActorHandleError
  | SessionActorMetadataViolation
  | CreateControllerRejected
  | CreateControllerConflict
  | CreateControllerInvariantFailure
  | CreateControllerBoundaryFailure
  | MetadataStoreReadError
  | MetadataStoreMutationError
  | ActorStoreReadError;

export interface CreateHardCapFence {
  readonly sessionId: string;
  readonly generation: string;
  readonly deadlineAt: string;
}

interface CreateHardCapControllerShape {
  readonly arm: (fence: CreateHardCapFence) => Effect.Effect<void, CreateControllerBoundaryFailure>;
}

export class CreateHardCapController extends Context.Service<
  CreateHardCapController,
  CreateHardCapControllerShape
>()("scotty/SessionActor/CreateHardCapController") {}

export const createHardCapControllerLayer = (
  arm: CreateHardCapControllerShape["arm"],
): Layer.Layer<CreateHardCapController> =>
  Layer.succeed(CreateHardCapController)(CreateHardCapController.of({ arm }));

export type CreateMetadataReservation =
  | { readonly _tag: "Reserved"; readonly metadata: SessionActorMetadata }
  | {
      readonly _tag: "Existing";
      readonly metadata: SessionActorMetadata;
      readonly authority: SessionAuthority | null;
    };

export type CreateMetadataInspection =
  | { readonly _tag: "Missing" }
  | Extract<CreateMetadataReservation, { readonly _tag: "Existing" }>;

interface CreateMetadataControllerShape {
  readonly inspect: (
    authority: SessionAuthority,
    input: SessionActorMetadataInput,
  ) => Effect.Effect<
    CreateMetadataInspection,
    MetadataStoreReadError | MetadataStoreConflict | ActorStoreReadError
  >;
  readonly reserve: (
    authority: SessionAuthority,
    input: SessionActorMetadataInput,
  ) => Effect.Effect<
    CreateMetadataReservation,
    MetadataStoreMutationError | CreateControllerInvariantFailure | ActorStoreReadError
  >;
  readonly scrubSettled: (
    authority: SessionAuthority,
    createAttempt: string,
  ) => Effect.Effect<void, MetadataStoreMutationError>;
}

export class CreateMetadataController extends Context.Service<
  CreateMetadataController,
  CreateMetadataControllerShape
>()("scotty/SessionActor/CreateMetadataController") {}

export const createMetadataControllerLayer = (
  service: CreateMetadataControllerShape,
): Layer.Layer<CreateMetadataController> =>
  Layer.succeed(CreateMetadataController)(CreateMetadataController.of(service));

export const createMetadataControllerFromStoresLayer: Layer.Layer<
  CreateMetadataController,
  never,
  SessionActorMetadataStore | ActorStore
> = Layer.effect(
  CreateMetadataController,
  Effect.gen(function* () {
    const metadata = yield* SessionActorMetadataStore;
    const actorStore = yield* ActorStore;
    return CreateMetadataController.of({
      inspect: Effect.fnUntraced(function* (proposed, input) {
        const inspection = yield* metadata.inspectCreate(proposed, input);
        if (!Predicate.isTagged(inspection, "Existing")) return inspection;
        const snapshot = yield* actorStore.read;
        return {
          _tag: "Existing" as const,
          metadata: inspection.metadata,
          authority: snapshot.authority ?? null,
        };
      }),
      reserve: Effect.fnUntraced(function* (proposed, input) {
        const reservation = yield* metadata.admitCreate(proposed, input);
        if (Predicate.isTagged(reservation, "Created"))
          return { _tag: "Reserved" as const, metadata: reservation.metadata };
        if (!Predicate.isTagged(reservation, "IdempotentReplay"))
          return yield* new CreateControllerInvariantFailure({
            code: "metadata_reservation_invalid",
          });
        const snapshot = yield* actorStore.read;
        return {
          _tag: "Existing" as const,
          metadata: reservation.metadata,
          authority: snapshot.authority ?? null,
        };
      }),
      scrubSettled: (settled) => metadata.scrubSettledCreate(settled).pipe(Effect.asVoid),
    });
  }),
);

interface CreateControllerShape {
  readonly create: (
    request: CreateControllerRequest,
  ) => Effect.Effect<CreateControllerResult, CreateControllerError>;
}

export class CreateController extends Context.Service<CreateController, CreateControllerShape>()(
  "scotty/SessionActor/CreateController",
) {}

const command = (
  request: CreateControllerRequest,
  attempt: string = request.attempt,
): Extract<SessionActorInput, { readonly _tag: "CreateCommand" }> => ({
  _tag: "CreateCommand",
  expectedRevision: 0,
  correlationId: request.correlationId,
  nonce: request.nonce,
  attempt,
  timestamp: request.timestamp,
  deadlineAt: request.transitionDeadlineAt,
  session: request.session,
  hardCap: request.hardCap,
});

const metadataInput = (request: CreateControllerRequest): SessionActorMetadataInput => ({
  branch: request.branch,
  createRepositoryIfMissing: request.createRepositoryIfMissing,
  hardCap: request.hardCap,
  createIdempotency: request.idempotency ?? null,
  payload: { reference: request.payloadReference },
  initialPrompt: request.initialPrompt,
});

const matchingIdempotency = (
  stored: SessionActorMetadata["createIdempotency"],
  incoming: CreateIdempotencyDigestMetadata | undefined,
): boolean =>
  stored !== null &&
  incoming !== undefined &&
  stored.keyDigest === incoming.keyDigest &&
  stored.inputDigest === incoming.inputDigest;

const validateExistingMetadata = (
  metadata: SessionActorMetadata,
  request: CreateControllerRequest,
): Effect.Effect<void, CreateControllerConflict | CreateControllerInvariantFailure> => {
  if (!matchingIdempotency(metadata.createIdempotency, request.idempotency))
    return Effect.fail(new CreateControllerConflict({ sessionId: request.session.id }));
  return metadata.sessionId === request.session.id &&
    metadata.repository === request.session.repository
    ? Effect.void
    : Effect.fail(new CreateControllerInvariantFailure({ code: "metadata_reservation_invalid" }));
};

const proposedCreate = (
  request: CreateControllerRequest,
): Result.Result<
  { readonly authority: SessionAuthority; readonly input: SessionActorMetadataInput },
  SessionActorMetadataViolation | CreateControllerRejected
> => {
  const admission = decide(undefined, command(request));
  if (Predicate.isTagged(admission, "Rejected"))
    return Result.fail(new CreateControllerRejected({ code: admission.code }));
  const input = metadataInput(request);
  const metadata = makeSessionActorMetadata(admission.nextAuthority, input);
  return Result.isFailure(metadata)
    ? Result.fail(metadata.failure)
    : Result.succeed({ authority: admission.nextAuthority, input });
};

const authorityFromActor = (
  result: ActorHandleResult,
): Effect.Effect<SessionAuthority, CreateControllerRejected | CreateControllerInvariantFailure> => {
  if (Predicate.isTagged(result.decision, "Rejected"))
    return Effect.fail(new CreateControllerRejected({ code: result.decision.code }));
  const last = result.committed[result.committed.length - 1];
  return last === undefined
    ? Effect.fail(new CreateControllerInvariantFailure({ code: "actor_committed_no_authority" }))
    : Effect.succeed(last.authority);
};

const validateResultAuthority = (
  authority: SessionAuthority,
  sessionId: string,
): Effect.Effect<SessionAuthority, CreateControllerInvariantFailure> => {
  if (authority.session.id !== sessionId)
    return Effect.fail(
      new CreateControllerInvariantFailure({ code: "authority_identity_mismatch" }),
    );
  return validateAuthority(authority)
    ? Effect.succeed(authority)
    : Effect.fail(new CreateControllerInvariantFailure({ code: "authority_invalid" }));
};

const classify = (
  authority: SessionAuthority,
  replay: boolean,
): Effect.Effect<CreateControllerResult, CreateControllerInvariantFailure> => {
  if (AuthorityStateSchema.guards.Transitioning(authority.state)) {
    const transition = authority.state.transition;
    return Predicate.isTagged(transition, "Create") && transition.mode === "reconciling"
      ? Effect.succeed({
          _tag: "Reconciling" as const,
          replay,
          authority,
          phase: transition.phase,
        })
      : Effect.fail(
          new CreateControllerInvariantFailure({ code: "create_finished_in_unexpected_state" }),
        );
  }
  if (StableStateSchema.guards.Warm(authority.state.stable))
    return Effect.succeed({ _tag: "Warm" as const, replay, authority });
  if (StableStateSchema.guards.Failed(authority.state.stable))
    return Effect.succeed({
      _tag: "Failed" as const,
      replay,
      authority,
      code: authority.state.stable.code,
      actionable: authority.state.stable.actionable,
    });
  return Effect.fail(
    new CreateControllerInvariantFailure({ code: "create_finished_in_unexpected_state" }),
  );
};

const scrubIfSettled = (
  metadata: CreateMetadataController["Service"],
  authority: SessionAuthority,
  createAttempt: string,
): Effect.Effect<void, MetadataStoreMutationError> =>
  AuthorityStateSchema.guards.Stable(authority.state)
    ? metadata.scrubSettled(authority, createAttempt)
    : Effect.void;

export const createControllerLayer: Layer.Layer<
  CreateController,
  never,
  SessionActor | CreateHardCapController | CreateMetadataController
> = Layer.effect(
  CreateController,
  Effect.gen(function* () {
    const actor = yield* SessionActor;
    const hardCap = yield* CreateHardCapController;
    const metadataStore = yield* CreateMetadataController;

    const create = Effect.fnUntraced(function* (request: CreateControllerRequest) {
      if (request.session.execution.provider === "runner")
        return yield* new CreateControllerRejected({ code: "runner_create_disabled" });

      const proposal = yield* Effect.fromResult(proposedCreate(request));
      const inspected = yield* metadataStore.inspect(proposal.authority, proposal.input);
      if (Predicate.isTagged(inspected, "Existing"))
        yield* validateExistingMetadata(inspected.metadata, request);
      if (Predicate.isTagged(inspected, "Existing") && inspected.authority !== null) {
        const existing = yield* validateResultAuthority(inspected.authority, request.session.id);
        const resumed = AuthorityStateSchema.guards.Transitioning(existing.state)
          ? yield* actor.resume({
              timestamp: request.timestamp,
              correlationId: request.correlationId,
            })
          : undefined;
        const authority = resumed === undefined ? existing : yield* authorityFromActor(resumed);
        yield* scrubIfSettled(metadataStore, authority, inspected.metadata.createAttempt);
        return yield* classify(authority, true);
      }

      const proposedMetadata = yield* Effect.fromResult(
        makeSessionActorMetadata(proposal.authority, proposal.input),
      );
      const cap = Predicate.isTagged(inspected, "Existing")
        ? inspected.metadata.hardCap
        : proposedMetadata.hardCap;
      yield* hardCap.arm({
        sessionId: request.session.id,
        generation: cap.generation,
        deadlineAt: cap.deadlineAt,
      });

      const reservation = Predicate.isTagged(inspected, "Existing")
        ? inspected
        : yield* metadataStore.reserve(proposal.authority, proposal.input);
      if (Predicate.isTagged(reservation, "Existing"))
        yield* validateExistingMetadata(reservation.metadata, request);
      if (Predicate.isTagged(reservation, "Existing") && reservation.authority !== null) {
        const existing = yield* validateResultAuthority(reservation.authority, request.session.id);
        const resumed = AuthorityStateSchema.guards.Transitioning(existing.state)
          ? yield* actor.resume({
              timestamp: request.timestamp,
              correlationId: request.correlationId,
            })
          : undefined;
        const authority = resumed === undefined ? existing : yield* authorityFromActor(resumed);
        yield* scrubIfSettled(metadataStore, authority, reservation.metadata.createAttempt);
        return yield* classify(authority, true);
      }
      const activeMetadata = reservation.metadata;
      if (
        activeMetadata.hardCap.generation !== cap.generation ||
        activeMetadata.hardCap.deadlineAt !== cap.deadlineAt
      )
        yield* hardCap.arm({
          sessionId: request.session.id,
          generation: activeMetadata.hardCap.generation,
          deadlineAt: activeMetadata.hardCap.deadlineAt,
        });

      const actorResult = yield* actor.handle(command(request, activeMetadata.createAttempt));
      const committedAuthority = yield* authorityFromActor(actorResult);
      const authority = yield* validateResultAuthority(committedAuthority, request.session.id);
      yield* scrubIfSettled(metadataStore, authority, activeMetadata.createAttempt);
      return yield* classify(authority, false);
    });

    return CreateController.of({ create });
  }),
);
