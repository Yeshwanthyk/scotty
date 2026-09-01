import { Context, Duration, Effect, Layer, Predicate, Result, Schema } from "effect";
import { AuthorityStateSchema, type SessionAuthority } from "./authority";
import {
  decodeSessionActorMetadata,
  makeSessionActorMetadata,
  recordCreateObservation,
  scrubSettledCreatePrivateInput,
  type SessionActorMetadata,
  type SessionActorMetadataInput,
  type SessionActorMetadataViolation,
  validateSessionActorMetadata,
  validateSessionActorMetadataUpdate,
} from "./metadata";

export type CreateMetadataObservation = Parameters<typeof recordCreateObservation>[2];

export type MetadataStorageMutation =
  | {
      readonly _tag: "Put";
      readonly value: SessionActorMetadata;
      readonly outcome: MetadataMutationOutcome;
    }
  | {
      readonly _tag: "NoWrite";
      readonly outcome: MetadataMutationOutcome | MetadataMutationFailure;
    }
  | {
      readonly _tag: "Delete";
      readonly outcome: MetadataMutationOutcome;
    };

export type MetadataMutationOutcome =
  | { readonly _tag: "Created"; readonly metadata: SessionActorMetadata }
  | { readonly _tag: "IdempotentReplay"; readonly metadata: SessionActorMetadata }
  | { readonly _tag: "ObservationRecorded"; readonly metadata: SessionActorMetadata }
  | { readonly _tag: "ObservationReplay"; readonly metadata: SessionActorMetadata }
  | { readonly _tag: "PrivateInputScrubbed"; readonly metadata: SessionActorMetadata }
  | { readonly _tag: "PrivateInputAlreadyScrubbed"; readonly metadata: SessionActorMetadata }
  | { readonly _tag: "DeletedForVaporize" }
  | { readonly _tag: "AlreadyDeletedForVaporize" };

export type MetadataCreateInspection =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Existing"; readonly metadata: SessionActorMetadata };

export interface MetadataStoragePort {
  readonly read: () => Promise<unknown | undefined>;
  readonly transaction: (
    decide: (current: unknown | undefined) => MetadataStorageMutation,
  ) => Promise<MetadataMutationOutcome | MetadataMutationFailure>;
}

export class MetadataStoreCorrupt extends Schema.TaggedError<MetadataStoreCorrupt>()(
  "MetadataStoreCorrupt",
  { operation: Schema.Literals(["read", "admit", "observe", "scrub"]) },
) {}

export class MetadataStoreReadFailure extends Schema.TaggedError<MetadataStoreReadFailure>()(
  "MetadataStoreReadFailure",
  { operation: Schema.Literal("read") },
) {}

export class MetadataStoreMutationOutcomeUnknown extends Schema.TaggedError<MetadataStoreMutationOutcomeUnknown>()(
  "MetadataStoreMutationOutcomeUnknown",
  {
    operation: Schema.Literals(["admit", "observe", "scrub", "vaporize"]),
    sessionId: Schema.String,
    attempt: Schema.String,
  },
) {}

export class MetadataStoreConflict extends Schema.TaggedError<MetadataStoreConflict>()(
  "MetadataStoreConflict",
  {
    code: Schema.Literals([
      "metadata_already_exists",
      "idempotency_key_conflict",
      "idempotency_input_conflict",
      "metadata_missing",
    ]),
  },
) {}

export type MetadataMutationFailure =
  | MetadataStoreCorrupt
  | MetadataStoreConflict
  | SessionActorMetadataViolation;

export type MetadataStoreReadError =
  | MetadataStoreCorrupt
  | MetadataStoreReadFailure
  | SessionActorMetadataViolation;

export type MetadataStoreMutationError =
  | MetadataMutationFailure
  | MetadataStoreMutationOutcomeUnknown;

export interface SessionActorMetadataStoreShape {
  readonly inspectCreate: (
    authority: SessionAuthority,
    input: SessionActorMetadataInput,
  ) => Effect.Effect<MetadataCreateInspection, MetadataStoreReadError | MetadataStoreConflict>;
  readonly read: (
    authority: SessionAuthority,
  ) => Effect.Effect<SessionActorMetadata | undefined, MetadataStoreReadError>;
  readonly admitCreate: (
    authority: SessionAuthority,
    input: SessionActorMetadataInput,
  ) => Effect.Effect<MetadataMutationOutcome, MetadataStoreMutationError>;
  readonly recordObservation: (
    authority: SessionAuthority,
    observation: CreateMetadataObservation,
  ) => Effect.Effect<MetadataMutationOutcome, MetadataStoreMutationError>;
  readonly scrubSettledCreate: (
    authority: SessionAuthority,
  ) => Effect.Effect<MetadataMutationOutcome, MetadataStoreMutationError>;
  readonly deleteForVaporize: (
    authority: SessionAuthority,
  ) => Effect.Effect<MetadataMutationOutcome, MetadataStoreMutationError>;
}

export class SessionActorMetadataStore extends Context.Service<
  SessionActorMetadataStore,
  SessionActorMetadataStoreShape
>()("scotty/SessionActor/MetadataStore") {}

const decodeCurrent = (
  raw: unknown | undefined,
  operation: MetadataStoreCorrupt["operation"],
): Result.Result<SessionActorMetadata | undefined, MetadataStoreCorrupt> => {
  if (raw === undefined) return Result.succeed(undefined);
  const decoded = decodeSessionActorMetadata(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(new MetadataStoreCorrupt({ operation }));
};

const validatedCurrent = (
  raw: unknown | undefined,
  authority: SessionAuthority,
  operation: MetadataStoreCorrupt["operation"],
): Result.Result<
  SessionActorMetadata | undefined,
  MetadataStoreCorrupt | SessionActorMetadataViolation
> => {
  const decoded = decodeCurrent(raw, operation);
  if (Result.isFailure(decoded) || decoded.success === undefined) return decoded;
  return validateSessionActorMetadata(authority, decoded.success);
};

const idempotencyOutcome = (
  current: SessionActorMetadata,
  input: SessionActorMetadataInput,
): MetadataMutationOutcome | MetadataStoreConflict => {
  const stored = current.createIdempotency;
  const requested = input.createIdempotency;
  if (stored === null || requested === null)
    return new MetadataStoreConflict({ code: "metadata_already_exists" });
  if (stored.keyDigest !== requested.keyDigest)
    return new MetadataStoreConflict({ code: "idempotency_key_conflict" });
  if (stored.inputDigest !== requested.inputDigest)
    return new MetadataStoreConflict({ code: "idempotency_input_conflict" });
  return { _tag: "IdempotentReplay", metadata: current };
};

const isFailureOutcome = (
  outcome: MetadataMutationOutcome | MetadataMutationFailure,
): outcome is MetadataMutationFailure =>
  Predicate.isTagged(outcome, "MetadataStoreCorrupt") ||
  Predicate.isTagged(outcome, "MetadataStoreConflict") ||
  Predicate.isTagged(outcome, "SessionActorMetadataViolation");

export const makeSessionActorMetadataStore = (
  port: MetadataStoragePort,
  mutationTimeout: Duration.Input = "5 seconds",
): SessionActorMetadataStoreShape => {
  const read: SessionActorMetadataStoreShape["read"] = (authority) =>
    Effect.tryPromise({
      try: () => port.read(),
      catch: () => new MetadataStoreReadFailure({ operation: "read" }),
    }).pipe(
      Effect.flatMap((raw) => {
        const decoded = validatedCurrent(raw, authority, "read");
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(decoded.failure);
      }),
    );

  const inspectCreate: SessionActorMetadataStoreShape["inspectCreate"] = Effect.fnUntraced(
    function* (authority, input) {
      const raw = yield* Effect.tryPromise({
        try: () => port.read(),
        catch: () => new MetadataStoreReadFailure({ operation: "read" }),
      });
      const decoded = decodeCurrent(raw, "read");
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      if (decoded.success === undefined) return { _tag: "Missing" } as const;
      if (
        decoded.success.sessionId !== authority.session.id ||
        decoded.success.repository !== authority.session.repository
      )
        return yield* new MetadataStoreConflict({ code: "metadata_already_exists" });
      const idempotency = idempotencyOutcome(decoded.success, input);
      if (Predicate.isTagged(idempotency, "MetadataStoreConflict")) return yield* idempotency;
      return { _tag: "Existing", metadata: decoded.success } as const;
    },
  );

  const mutate = Effect.fnUntraced(function* (
    operation: "admit" | "observe" | "scrub" | "vaporize",
    authority: SessionAuthority,
    decide: (current: unknown | undefined) => MetadataStorageMutation,
  ) {
    const unknown = () =>
      new MetadataStoreMutationOutcomeUnknown({
        operation,
        sessionId: authority.session.id,
        attempt: AuthorityStateSchema.guards.Transitioning(authority.state)
          ? authority.state.transition.attempt
          : "settled",
      });
    const attempted = Effect.tryPromise({
      try: () => port.transaction(decide),
      catch: unknown,
    });
    const outcome = yield* attempted.pipe(
      Effect.timeoutOrElse({ duration: mutationTimeout, orElse: () => Effect.fail(unknown()) }),
    );
    return isFailureOutcome(outcome) ? yield* outcome : outcome;
  });

  const admitCreate = Effect.fnUntraced(function* (
    authority: SessionAuthority,
    input: SessionActorMetadataInput,
  ) {
    return yield* mutate("admit", authority, (raw) => {
      const current = decodeCurrent(raw, "admit");
      if (Result.isFailure(current)) return { _tag: "NoWrite", outcome: current.failure };
      if (current.success !== undefined) {
        if (
          current.success.sessionId !== authority.session.id ||
          current.success.repository !== authority.session.repository
        )
          return {
            _tag: "NoWrite",
            outcome: new MetadataStoreConflict({ code: "metadata_already_exists" }),
          };
        return { _tag: "NoWrite", outcome: idempotencyOutcome(current.success, input) };
      }
      const created = makeSessionActorMetadata(authority, input);
      if (Result.isFailure(created)) return { _tag: "NoWrite", outcome: created.failure };
      const outcome = { _tag: "Created" as const, metadata: created.success };
      return { _tag: "Put", value: created.success, outcome };
    });
  });

  const recordObservation = Effect.fnUntraced(function* (
    authority: SessionAuthority,
    observation: CreateMetadataObservation,
  ) {
    return yield* mutate("observe", authority, (raw) => {
      const current = validatedCurrent(raw, authority, "observe");
      if (Result.isFailure(current)) return { _tag: "NoWrite", outcome: current.failure };
      if (current.success === undefined)
        return {
          _tag: "NoWrite",
          outcome: new MetadataStoreConflict({ code: "metadata_missing" }),
        };
      const observations = current.success.createObservations;
      const occupied = Predicate.isTagged(observation, "Workspace")
        ? observations.workspace !== null
        : Predicate.isTagged(observation, "Bundle")
          ? observations.bundle !== null
          : observations.credentialGrants !== null;
      const next = recordCreateObservation(authority, current.success, observation);
      if (Result.isFailure(next)) return { _tag: "NoWrite", outcome: next.failure };
      const validUpdate = validateSessionActorMetadataUpdate(
        authority,
        current.success,
        next.success,
      );
      if (Result.isFailure(validUpdate)) return { _tag: "NoWrite", outcome: validUpdate.failure };
      const outcome = {
        _tag: occupied ? ("ObservationReplay" as const) : ("ObservationRecorded" as const),
        metadata: validUpdate.success,
      };
      return occupied
        ? { _tag: "NoWrite", outcome }
        : { _tag: "Put", value: validUpdate.success, outcome };
    });
  });

  const scrubSettledCreate = Effect.fnUntraced(function* (authority: SessionAuthority) {
    return yield* mutate("scrub", authority, (raw) => {
      const current = validatedCurrent(raw, authority, "scrub");
      if (Result.isFailure(current)) {
        // A settled authority is expected to find an otherwise valid record whose private input
        // has not yet been scrubbed, so decode it before applying the settling update.
        const decoded = decodeCurrent(raw, "scrub");
        if (Result.isFailure(decoded)) return { _tag: "NoWrite", outcome: decoded.failure };
        if (decoded.success === undefined)
          return {
            _tag: "NoWrite",
            outcome: new MetadataStoreConflict({ code: "metadata_missing" }),
          };
        const scrubbed = scrubSettledCreatePrivateInput(authority, decoded.success);
        if (Result.isFailure(scrubbed)) return { _tag: "NoWrite", outcome: scrubbed.failure };
        const update = validateSessionActorMetadataUpdate(
          authority,
          decoded.success,
          scrubbed.success,
        );
        if (Result.isFailure(update)) return { _tag: "NoWrite", outcome: update.failure };
        const outcome = { _tag: "PrivateInputScrubbed" as const, metadata: update.success };
        return { _tag: "Put", value: update.success, outcome };
      }
      if (current.success === undefined)
        return {
          _tag: "NoWrite",
          outcome: new MetadataStoreConflict({ code: "metadata_missing" }),
        };
      const outcome = {
        _tag: "PrivateInputAlreadyScrubbed" as const,
        metadata: current.success,
      };
      return { _tag: "NoWrite", outcome };
    });
  });

  const deleteForVaporize = Effect.fnUntraced(function* (authority: SessionAuthority) {
    return yield* mutate("vaporize", authority, (raw) => {
      if (raw === undefined)
        return { _tag: "NoWrite", outcome: { _tag: "AlreadyDeletedForVaporize" } };
      const current = validatedCurrent(raw, authority, "read");
      if (Result.isFailure(current)) return { _tag: "NoWrite", outcome: current.failure };
      return { _tag: "Delete", outcome: { _tag: "DeletedForVaporize" } };
    });
  });

  return SessionActorMetadataStore.of({
    inspectCreate,
    read,
    admitCreate,
    recordObservation,
    scrubSettledCreate,
    deleteForVaporize,
  });
};

export const sessionActorMetadataStoreLayer = (
  port: MetadataStoragePort,
  mutationTimeout?: Duration.Input,
): Layer.Layer<SessionActorMetadataStore> =>
  Layer.succeed(SessionActorMetadataStore)(makeSessionActorMetadataStore(port, mutationTimeout));
