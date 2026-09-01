import { Match, Predicate, Result, Schema } from "effect";
import { CredentialGrantSchema, type CredentialGrant } from "../../../protocol/credentials";
import {
  RepositoryDefaultBranchSchema,
  RepositoryIdentitySchema,
  RepositoryTimestampSchema,
} from "../../../protocol/repository";
import { SandboxDigestSchema } from "../sandbox/config-contracts";
import { AuthorityStateSchema, type SessionAuthority } from "./authority";
import type { CreatePrivatePayloadReference } from "./transitions/create";

const SafeReferenceSchema = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const SessionBranchSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes("\0"),
    { expected: "a bounded session branch" },
  ),
);
const InitialPromptSchema = Schema.NonEmptyString.check(Schema.isMaxLength(1_048_576));
const Sha256DigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const HardCapDurationSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(60),
  Schema.isLessThanOrEqualTo(24 * 60 * 60),
);

// Keep this exact structural match local until the create transition exports its private schema.
export const CreatePayloadReferenceSchema = Schema.Struct({ reference: SafeReferenceSchema });
type MetadataCreatePayloadReference = typeof CreatePayloadReferenceSchema.Type;

const HardCapMetadataSchema = Schema.Struct({
  durationSeconds: HardCapDurationSchema,
  deadlineAt: RepositoryTimestampSchema,
  generation: SafeReferenceSchema,
});

export const CreateIdempotencyDigestMetadataSchema = Schema.Struct({
  keyDigest: Sha256DigestSchema,
  inputDigest: Sha256DigestSchema,
});
export type CreateIdempotencyDigestMetadata = typeof CreateIdempotencyDigestMetadataSchema.Type;

const CreatePrivateInputSchema = Schema.Struct({
  attempt: SafeReferenceSchema,
  payload: CreatePayloadReferenceSchema,
  initialPrompt: InitialPromptSchema,
});

const CreateObservationFence = {
  attempt: SafeReferenceSchema,
  payloadReference: SafeReferenceSchema,
  observedAt: RepositoryTimestampSchema,
} as const;

export const WorkspaceCreateObservationSchema = Schema.Struct({
  ...CreateObservationFence,
  workspaceId: SafeReferenceSchema,
  repository: RepositoryIdentitySchema,
  defaultBranch: RepositoryDefaultBranchSchema,
  repositoryExists: Schema.Boolean,
});
export type WorkspaceCreateObservation = typeof WorkspaceCreateObservationSchema.Type;

export const BundleCreateObservationSchema = Schema.Struct({
  ...CreateObservationFence,
  digest: SandboxDigestSchema,
});
export type BundleCreateObservation = typeof BundleCreateObservationSchema.Type;

export const CredentialGrantCreateObservationSchema = Schema.Struct({
  ...CreateObservationFence,
  grants: Schema.Array(CredentialGrantSchema),
});
export type CredentialGrantCreateObservation = typeof CredentialGrantCreateObservationSchema.Type;

const CreateResourceObservationsSchema = Schema.Struct({
  workspace: Schema.NullOr(WorkspaceCreateObservationSchema),
  bundle: Schema.NullOr(BundleCreateObservationSchema),
  credentialGrants: Schema.NullOr(CredentialGrantCreateObservationSchema),
});

export const SessionActorMetadataSchema = Schema.Struct({
  sessionId: SafeReferenceSchema,
  repository: RepositoryIdentitySchema,
  branch: SessionBranchSchema,
  createRepositoryIfMissing: Schema.Boolean,
  hardCap: HardCapMetadataSchema,
  createIdempotency: Schema.NullOr(CreateIdempotencyDigestMetadataSchema),
  createAttempt: SafeReferenceSchema,
  privateCreateInput: Schema.NullOr(CreatePrivateInputSchema),
  createObservations: CreateResourceObservationsSchema,
});
export type SessionActorMetadata = typeof SessionActorMetadataSchema.Type;

export const decodeSessionActorMetadata = Schema.decodeUnknownResult(SessionActorMetadataSchema, {
  onExcessProperty: "error",
});

export const SessionActorMetadataInputSchema = Schema.Struct({
  branch: SessionBranchSchema,
  createRepositoryIfMissing: Schema.Boolean,
  hardCap: HardCapMetadataSchema,
  createIdempotency: Schema.NullOr(CreateIdempotencyDigestMetadataSchema),
  payload: CreatePayloadReferenceSchema,
  initialPrompt: InitialPromptSchema,
});
export type SessionActorMetadataInput = typeof SessionActorMetadataInputSchema.Type;

export class SessionActorMetadataViolation extends Schema.TaggedError<SessionActorMetadataViolation>()(
  "SessionActorMetadataViolation",
  {
    code: Schema.Literals([
      "authority_identity_mismatch",
      "create_transition_required",
      "create_attempt_mismatch",
      "private_create_input_not_scrubbed",
      "immutable_metadata_changed",
      "create_observation_conflict",
      "create_observation_fence_mismatch",
    ]),
  },
) {}

const invalid = (
  code: SessionActorMetadataViolation["code"],
): Result.Result<never, SessionActorMetadataViolation> =>
  Result.fail(new SessionActorMetadataViolation({ code }));

const createTransition = (authority: SessionAuthority) => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return undefined;
  const transition = authority.state.transition;
  return Predicate.isTagged(transition, "Create") ? transition : undefined;
};

const referencesMatch = (
  metadata: SessionActorMetadata,
  attempt: string,
  payloadReference: string,
): boolean =>
  metadata.createAttempt === attempt &&
  metadata.privateCreateInput?.attempt === attempt &&
  metadata.privateCreateInput.payload.reference === payloadReference;

const sameSlot = (
  left: CredentialGrant["handleSlots"][number],
  right: CredentialGrant["handleSlots"][number],
): boolean => left.provider === right.provider && left.slot === right.slot;

const sameGrant = (left: CredentialGrant, right: CredentialGrant): boolean =>
  left.name === right.name &&
  left.kind === right.kind &&
  left.versionRef === right.versionRef &&
  left.expires === right.expires &&
  left.handleSlots.length === right.handleSlots.length &&
  left.handleSlots.every((slot, index) => {
    const rightSlot = right.handleSlots[index];
    return rightSlot !== undefined && sameSlot(slot, rightSlot);
  });

const sameGrants = (
  left: ReadonlyArray<CredentialGrant>,
  right: ReadonlyArray<CredentialGrant>,
): boolean =>
  left.length === right.length &&
  left.every((grant, index) => {
    const rightGrant = right[index];
    return rightGrant !== undefined && sameGrant(grant, rightGrant);
  });

const sameWorkspaceObservation = (
  left: WorkspaceCreateObservation,
  right: WorkspaceCreateObservation,
): boolean =>
  left.attempt === right.attempt &&
  left.payloadReference === right.payloadReference &&
  left.observedAt === right.observedAt &&
  left.workspaceId === right.workspaceId &&
  left.repository === right.repository &&
  left.defaultBranch === right.defaultBranch &&
  left.repositoryExists === right.repositoryExists;

const sameBundleObservation = (
  left: BundleCreateObservation,
  right: BundleCreateObservation,
): boolean =>
  left.attempt === right.attempt &&
  left.payloadReference === right.payloadReference &&
  left.observedAt === right.observedAt &&
  left.digest === right.digest;

const sameGrantObservation = (
  left: CredentialGrantCreateObservation,
  right: CredentialGrantCreateObservation,
): boolean =>
  left.attempt === right.attempt &&
  left.payloadReference === right.payloadReference &&
  left.observedAt === right.observedAt &&
  sameGrants(left.grants, right.grants);

const validateObservationFences = (metadata: SessionActorMetadata): boolean => {
  const observations = metadata.createObservations;
  return [observations.workspace, observations.bundle, observations.credentialGrants].every(
    (observation) =>
      observation === null ||
      (observation.attempt === metadata.createAttempt &&
        (metadata.privateCreateInput === null ||
          observation.payloadReference === metadata.privateCreateInput.payload.reference)),
  );
};

export const validateSessionActorMetadata = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
): Result.Result<SessionActorMetadata, SessionActorMetadataViolation> => {
  if (
    metadata.sessionId !== authority.session.id ||
    metadata.repository !== authority.session.repository
  )
    return invalid("authority_identity_mismatch");

  const create = createTransition(authority);
  if (metadata.privateCreateInput !== null) {
    if (create === undefined) return invalid("private_create_input_not_scrubbed");
    if (
      create.attempt !== metadata.createAttempt ||
      metadata.privateCreateInput.attempt !== create.attempt
    )
      return invalid("create_attempt_mismatch");
  }
  if (create !== undefined && create.attempt !== metadata.createAttempt)
    return invalid("create_attempt_mismatch");
  if (!validateObservationFences(metadata)) return invalid("create_observation_fence_mismatch");
  return Result.succeed(metadata);
};

export const makeSessionActorMetadata = (
  authority: SessionAuthority,
  input: SessionActorMetadataInput,
): Result.Result<SessionActorMetadata, SessionActorMetadataViolation> => {
  const create = createTransition(authority);
  if (create === undefined) return invalid("create_transition_required");
  const payload: MetadataCreatePayloadReference = input.payload;
  const metadata: SessionActorMetadata = {
    sessionId: authority.session.id,
    repository: authority.session.repository,
    branch: input.branch,
    createRepositoryIfMissing: input.createRepositoryIfMissing,
    hardCap: input.hardCap,
    createIdempotency: input.createIdempotency,
    createAttempt: create.attempt,
    privateCreateInput: {
      attempt: create.attempt,
      payload,
      initialPrompt: input.initialPrompt,
    },
    createObservations: { workspace: null, bundle: null, credentialGrants: null },
  };
  return validateSessionActorMetadata(authority, metadata);
};

export const scrubSettledCreatePrivateInput = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
): Result.Result<SessionActorMetadata, SessionActorMetadataViolation> => {
  if (!AuthorityStateSchema.guards.Stable(authority.state))
    return invalid("create_transition_required");
  return validateSessionActorMetadata(authority, { ...metadata, privateCreateInput: null });
};

type CreateObservation =
  | { readonly _tag: "Workspace"; readonly value: WorkspaceCreateObservation }
  | { readonly _tag: "Bundle"; readonly value: BundleCreateObservation }
  | { readonly _tag: "CredentialGrants"; readonly value: CredentialGrantCreateObservation };

export const recordCreateObservation = (
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
  observation: CreateObservation,
): Result.Result<SessionActorMetadata, SessionActorMetadataViolation> => {
  const create = createTransition(authority);
  if (create === undefined) return invalid("create_transition_required");
  if (
    create.attempt !== observation.value.attempt ||
    !referencesMatch(metadata, observation.value.attempt, observation.value.payloadReference)
  )
    return invalid("create_observation_fence_mismatch");
  if (
    Predicate.isTagged(observation, "Workspace") &&
    (observation.value.repository !== metadata.repository ||
      (!observation.value.repositoryExists && !metadata.createRepositoryIfMissing))
  )
    return invalid("create_observation_fence_mismatch");
  const current = metadata.createObservations;
  const updated = Match.valueTags(observation, {
    Workspace: ({ value }) =>
      current.workspace !== null && !sameWorkspaceObservation(current.workspace, value)
        ? invalid("create_observation_conflict")
        : Result.succeed({
            ...metadata,
            createObservations: { ...current, workspace: value },
          }),
    Bundle: ({ value }) =>
      current.bundle !== null && !sameBundleObservation(current.bundle, value)
        ? invalid("create_observation_conflict")
        : Result.succeed({
            ...metadata,
            createObservations: { ...current, bundle: value },
          }),
    CredentialGrants: ({ value }) =>
      current.credentialGrants !== null && !sameGrantObservation(current.credentialGrants, value)
        ? invalid("create_observation_conflict")
        : Result.succeed({
            ...metadata,
            createObservations: { ...current, credentialGrants: value },
          }),
  });
  return Result.isFailure(updated)
    ? updated
    : validateSessionActorMetadata(authority, updated.success);
};

const sameImmutableConfiguration = (
  current: SessionActorMetadata,
  next: SessionActorMetadata,
): boolean =>
  current.sessionId === next.sessionId &&
  current.repository === next.repository &&
  current.branch === next.branch &&
  current.createRepositoryIfMissing === next.createRepositoryIfMissing &&
  current.hardCap.durationSeconds === next.hardCap.durationSeconds &&
  current.hardCap.deadlineAt === next.hardCap.deadlineAt &&
  current.hardCap.generation === next.hardCap.generation &&
  current.createIdempotency?.keyDigest === next.createIdempotency?.keyDigest &&
  current.createIdempotency?.inputDigest === next.createIdempotency?.inputDigest &&
  current.createAttempt === next.createAttempt;

const privateInputChangeIsAllowed = (
  current: SessionActorMetadata,
  next: SessionActorMetadata,
): boolean => {
  if (current.privateCreateInput === null) return next.privateCreateInput === null;
  if (next.privateCreateInput === null) return true;
  return (
    current.privateCreateInput.attempt === next.privateCreateInput.attempt &&
    current.privateCreateInput.payload.reference === next.privateCreateInput.payload.reference &&
    current.privateCreateInput.initialPrompt === next.privateCreateInput.initialPrompt
  );
};

const observationsOnlyAdvance = (
  current: SessionActorMetadata,
  next: SessionActorMetadata,
): boolean => {
  const before = current.createObservations;
  const after = next.createObservations;
  return (
    (before.workspace === null ||
      (after.workspace !== null && sameWorkspaceObservation(before.workspace, after.workspace))) &&
    (before.bundle === null ||
      (after.bundle !== null && sameBundleObservation(before.bundle, after.bundle))) &&
    (before.credentialGrants === null ||
      (after.credentialGrants !== null &&
        sameGrantObservation(before.credentialGrants, after.credentialGrants)))
  );
};

export const validateSessionActorMetadataUpdate = (
  authority: SessionAuthority,
  current: SessionActorMetadata,
  next: SessionActorMetadata,
): Result.Result<SessionActorMetadata, SessionActorMetadataViolation> => {
  const validated = validateSessionActorMetadata(authority, next);
  if (Result.isFailure(validated)) return validated;
  if (!sameImmutableConfiguration(current, next) || !privateInputChangeIsAllowed(current, next))
    return invalid("immutable_metadata_changed");
  if (!observationsOnlyAdvance(current, next)) return invalid("create_observation_conflict");
  return Result.succeed(next);
};

export const SafeSessionActorMetadataSchema = Schema.Struct({
  sessionId: SafeReferenceSchema,
  repository: RepositoryIdentitySchema,
  branch: SessionBranchSchema,
  defaultBranch: Schema.NullOr(RepositoryDefaultBranchSchema),
  repositoryExistsAtCreate: Schema.NullOr(Schema.Boolean),
  hardCapDeadlineAt: RepositoryTimestampSchema,
  hardCapGeneration: SafeReferenceSchema,
  sandboxBundleDigest: Schema.NullOr(SandboxDigestSchema),
  credentialGrantCount: Schema.Int,
  workspaceObserved: Schema.Boolean,
  bundleObserved: Schema.Boolean,
  credentialGrantsObserved: Schema.Boolean,
});
export type SafeSessionActorMetadata = typeof SafeSessionActorMetadataSchema.Type;

export const safeSessionActorMetadata = (
  metadata: SessionActorMetadata,
): SafeSessionActorMetadata => ({
  sessionId: metadata.sessionId,
  repository: metadata.repository,
  branch: metadata.branch,
  defaultBranch: metadata.createObservations.workspace?.defaultBranch ?? null,
  repositoryExistsAtCreate: metadata.createObservations.workspace?.repositoryExists ?? null,
  hardCapDeadlineAt: metadata.hardCap.deadlineAt,
  hardCapGeneration: metadata.hardCap.generation,
  sandboxBundleDigest: metadata.createObservations.bundle?.digest ?? null,
  credentialGrantCount: metadata.createObservations.credentialGrants?.grants.length ?? 0,
  workspaceObserved: metadata.createObservations.workspace !== null,
  bundleObserved: metadata.createObservations.bundle !== null,
  credentialGrantsObserved: metadata.createObservations.credentialGrants !== null,
});

// Compile-time proof that the duplicated schema remains compatible with the create provider contract.
const _createPayloadReferenceCompatibility = (
  reference: MetadataCreatePayloadReference,
): CreatePrivatePayloadReference => reference;
void _createPayloadReferenceCompatibility;
