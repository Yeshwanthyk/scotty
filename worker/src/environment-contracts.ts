import { RepositoryIdentitySchema, isRepositoryIdentity } from "../../protocol/repository";
import { Result, Schema } from "effect";

export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export const ENVIRONMENT_MAX_VALUE_BYTES = 65_536;
export const ENVIRONMENT_MAX_ORIGIN_POLICIES = 256;
export const ENVIRONMENT_MAX_PENDING_OBSERVATIONS = 256;
export const ENVIRONMENT_MAX_AUTHORIZATION_KEYS = 32;
export const ENVIRONMENT_SECRET_SENTINEL_PREFIX = "scotty-env-";

export const EnvironmentNameSchema = Schema.String.check(
  Schema.isPattern(ENVIRONMENT_NAME_PATTERN),
);
export const EnvironmentValueSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(value).byteLength <= ENVIRONMENT_MAX_VALUE_BYTES,
    { expected: `an environment value at most ${ENVIRONMENT_MAX_VALUE_BYTES} UTF-8 bytes` },
  ),
);
export const EnvironmentVariableSchema = Schema.Struct({
  value: EnvironmentValueSchema,
  secret: Schema.Boolean,
  updatedAt: Schema.NonEmptyString,
});
export type EnvironmentVariable = typeof EnvironmentVariableSchema.Type;

export const LegacyEnvironmentAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentVariableSchema),
});
export type LegacyEnvironmentAuthority = typeof LegacyEnvironmentAuthoritySchema.Type;

export const RepositoryEnvironmentSchema = Schema.Struct({
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentVariableSchema),
});

export const EnvironmentAuthorityV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  global: RepositoryEnvironmentSchema,
  repositories: Schema.Record(RepositoryIdentitySchema, RepositoryEnvironmentSchema),
});
export type EnvironmentAuthorityV2 = typeof EnvironmentAuthorityV2Schema.Type;

export const CanonicalRepositoryIdentitySchema = Schema.String.check(
  Schema.makeFilter(
    (value) => isRepositoryIdentity(value) && value === value.toLocaleLowerCase("en-US"),
    { expected: "a canonical OWNER/REPO repository identity" },
  ),
);

export const EnvironmentSourceScopeSchema = Schema.Union([
  Schema.Literal("global"),
  CanonicalRepositoryIdentitySchema,
]);
export type EnvironmentSourceScope = typeof EnvironmentSourceScopeSchema.Type;

const isExactHttpsOrigin = (value: string): boolean => {
  const parsed = Result.try(() => new URL(value));
  if (Result.isFailure(parsed)) return false;
  const url = parsed.success;
  if (
    value.length > 512 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin === "null"
  )
    return false;
  return value === url.origin || value === `${url.origin}/`;
};

const ExactHttpsOriginSchema = Schema.String.check(
  Schema.makeFilter(isExactHttpsOrigin, {
    expected: "an exact HTTPS origin without a path, query, fragment, or credentials",
  }),
);
export const EnvironmentOriginSchema = ExactHttpsOriginSchema;
export type EnvironmentOrigin = typeof EnvironmentOriginSchema.Type;

export const EnvironmentSecretSentinelSchema = Schema.String.check(
  Schema.isPattern(/^scotty-env-[a-z0-9][a-z0-9-]{5,31}-[a-f0-9]{32}$/u),
);
const decodeEnvironmentSecretSentinel = Schema.decodeUnknownResult(EnvironmentSecretSentinelSchema);
export type EnvironmentSecretSentinel = typeof EnvironmentSecretSentinelSchema.Type;

export const EnvironmentOriginPolicyDecisionSchema = Schema.Literals([
  "approved",
  "rejected",
  "revoked",
]);
export type EnvironmentOriginPolicyDecision = typeof EnvironmentOriginPolicyDecisionSchema.Type;

export const EnvironmentOriginPolicySchema = Schema.Struct({
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
  decision: EnvironmentOriginPolicyDecisionSchema,
  updatedAt: Schema.NonEmptyString,
});
export type EnvironmentOriginPolicy = typeof EnvironmentOriginPolicySchema.Type;

export const EnvironmentPendingObservationSchema = Schema.Struct({
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
  firstObservedAt: Schema.NonEmptyString,
  lastObservedAt: Schema.NonEmptyString,
});
export type EnvironmentPendingObservation = typeof EnvironmentPendingObservationSchema.Type;

export function environmentPolicyKey(
  value: Pick<EnvironmentOriginPolicy, "sourceScope" | "name" | "origin">,
): string {
  return `${value.sourceScope}\u0000${value.name}\u0000${value.origin}`;
}

export const EnvironmentAuthoritySchema = Schema.Struct({
  version: Schema.Literal(3),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  policyRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  global: RepositoryEnvironmentSchema,
  repositories: Schema.Record(CanonicalRepositoryIdentitySchema, RepositoryEnvironmentSchema),
  originPolicies: Schema.Array(EnvironmentOriginPolicySchema).check(
    Schema.isMaxLength(ENVIRONMENT_MAX_ORIGIN_POLICIES),
  ),
  pendingObservations: Schema.Array(EnvironmentPendingObservationSchema).check(
    Schema.isMaxLength(ENVIRONMENT_MAX_PENDING_OBSERVATIONS),
  ),
}).check(
  Schema.makeFilter(
    (authority) => {
      const policyKeys = authority.originPolicies.map(environmentPolicyKey);
      const pendingKeys = authority.pendingObservations.map(environmentPolicyKey);
      const policyKeySet = new Set(policyKeys);
      const pendingKeySet = new Set(pendingKeys);
      return (
        policyKeySet.size === policyKeys.length &&
        pendingKeySet.size === pendingKeys.length &&
        pendingKeys.every((key) => !policyKeySet.has(key))
      );
    },
    {
      expected:
        "environment origin policies and pending observations must be uniquely keyed and disjoint",
    },
  ),
);
export type EnvironmentAuthority = typeof EnvironmentAuthoritySchema.Type;

export const EnvironmentEffectiveVariableSchema = Schema.Struct({
  value: EnvironmentValueSchema,
  secret: Schema.Boolean,
  updatedAt: Schema.NonEmptyString,
  sourceScope: EnvironmentSourceScopeSchema,
});
export type EnvironmentEffectiveVariable = typeof EnvironmentEffectiveVariableSchema.Type;

export const EnvironmentMaterializationSchema = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  repo: Schema.optionalKey(CanonicalRepositoryIdentitySchema),
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentEffectiveVariableSchema),
});
export type EnvironmentMaterialization = typeof EnvironmentMaterializationSchema.Type;

export const EnvironmentSnapshotSchema = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentValueSchema),
});
export type EnvironmentSnapshot = typeof EnvironmentSnapshotSchema.Type;
const isSessionEnvironmentSnapshotValue = (value: string): boolean =>
  !value.startsWith(ENVIRONMENT_SECRET_SENTINEL_PREFIX) ||
  Result.isSuccess(decodeEnvironmentSecretSentinel(value));
export const SessionEnvironmentSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentValueSchema),
}).check(
  Schema.makeFilter(
    (snapshot) => Object.values(snapshot.variables).every(isSessionEnvironmentSnapshotValue),
    { expected: "a versioned session environment snapshot with valid sentinels" },
  ),
);
export type SessionEnvironmentSnapshot = typeof SessionEnvironmentSnapshotSchema.Type;

/** Stored-session compatibility shape; legacy values are never a container input. */
export const PersistedSessionEnvironmentSnapshotSchema = Schema.Union([
  SessionEnvironmentSnapshotSchema,
  EnvironmentSnapshotSchema,
]);
export type PersistedSessionEnvironmentSnapshot =
  typeof PersistedSessionEnvironmentSnapshotSchema.Type;

const decodeSessionEnvironmentSnapshot = Schema.decodeUnknownResult(
  SessionEnvironmentSnapshotSchema,
  { onExcessProperty: "error" },
);

export const isSessionEnvironmentSnapshot = (value: unknown): value is SessionEnvironmentSnapshot =>
  Result.isSuccess(decodeSessionEnvironmentSnapshot(value));

export const EnvironmentPolicyKeySchema = Schema.Struct({
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
});
export type EnvironmentPolicyKey = typeof EnvironmentPolicyKeySchema.Type;

export const EnvironmentPolicyKeyInputSchema = Schema.Struct({
  sourceScope: Schema.Union([Schema.Literal("global"), RepositoryIdentitySchema]),
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
});
export type EnvironmentPolicyKeyInput = typeof EnvironmentPolicyKeyInputSchema.Type;

export const EnvironmentAuthorizationRequestSchema = Schema.Struct({
  origin: EnvironmentOriginSchema,
  keys: Schema.Array(
    Schema.Struct({
      sourceScope: Schema.Union([Schema.Literal("global"), RepositoryIdentitySchema]),
      name: EnvironmentNameSchema,
    }),
  ).check(Schema.isNonEmpty(), Schema.isMaxLength(ENVIRONMENT_MAX_AUTHORIZATION_KEYS)),
});
export type EnvironmentAuthorizationRequest = typeof EnvironmentAuthorizationRequestSchema.Type;

export const EnvironmentAuthorizationDecisionSchema = Schema.Struct({
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
  status: Schema.Literals(["approved", "rejected", "revoked", "pending"]),
});
export type EnvironmentAuthorizationDecision = typeof EnvironmentAuthorizationDecisionSchema.Type;

export const EnvironmentAuthorizationResultSchema = Schema.Struct({
  policyRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  authorized: Schema.Boolean,
  decisions: Schema.Array(EnvironmentAuthorizationDecisionSchema).check(
    Schema.isMaxLength(ENVIRONMENT_MAX_AUTHORIZATION_KEYS),
  ),
});
export type EnvironmentAuthorizationResult = typeof EnvironmentAuthorizationResultSchema.Type;

export const EnvironmentApprovalViewSchema = Schema.Struct({
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
  decision: EnvironmentOriginPolicyDecisionSchema,
  updatedAt: Schema.NonEmptyString,
});
export type EnvironmentApprovalView = typeof EnvironmentApprovalViewSchema.Type;

export const EnvironmentApprovalListSchema = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  policyRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  approvals: Schema.Array(EnvironmentApprovalViewSchema).check(
    Schema.isMaxLength(ENVIRONMENT_MAX_ORIGIN_POLICIES),
  ),
  pending: Schema.Array(EnvironmentPendingObservationSchema).check(
    Schema.isMaxLength(ENVIRONMENT_MAX_PENDING_OBSERVATIONS),
  ),
});
export type EnvironmentApprovalList = typeof EnvironmentApprovalListSchema.Type;

export const EnvironmentApprovalMutationResponseSchema = Schema.Struct({
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  origin: EnvironmentOriginSchema,
  decision: EnvironmentOriginPolicyDecisionSchema,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  policyRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type EnvironmentApprovalMutationResponse =
  typeof EnvironmentApprovalMutationResponseSchema.Type;

export const EnvironmentPutInputSchema = Schema.Struct({
  value: EnvironmentValueSchema,
  secret: Schema.Boolean,
});
export type EnvironmentPutInput = typeof EnvironmentPutInputSchema.Type;

export const EnvironmentVariableViewSchema = Schema.Struct({
  name: EnvironmentNameSchema,
  secret: Schema.Boolean,
  configured: Schema.Literal(true),
  updatedAt: Schema.NonEmptyString,
  source: Schema.optionalKey(Schema.Literals(["global", "repo"])),
  value: Schema.optionalKey(EnvironmentValueSchema),
}).check(
  Schema.makeFilter(
    (variable) => variable.secret === (variable.value === undefined ? true : false),
    { expected: "secret environment values are write-only" },
  ),
);
export type EnvironmentVariableView = typeof EnvironmentVariableViewSchema.Type;

export const ProtectedEnvironmentBindingSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  secret: Schema.Literal(true),
  source: Schema.NonEmptyString,
  destination: Schema.Literals(["process_environment", "file"]),
  path: Schema.optionalKey(Schema.NonEmptyString),
  managedBy: Schema.Literal("scotty"),
});
export type ProtectedEnvironmentBinding = typeof ProtectedEnvironmentBindingSchema.Type;

export const EnvironmentVariablesViewSchema = Schema.Struct({
  revision: Schema.Number,
  repo: Schema.optionalKey(Schema.NonEmptyString),
  variables: Schema.Array(EnvironmentVariableViewSchema),
});
export type EnvironmentVariablesView = typeof EnvironmentVariablesViewSchema.Type;

export const EnvironmentViewSchema = Schema.Struct({
  ...EnvironmentVariablesViewSchema.fields,
  protectedBindings: Schema.Array(ProtectedEnvironmentBindingSchema),
});
export type EnvironmentView = typeof EnvironmentViewSchema.Type;

export const EnvironmentMutationResponseSchema = Schema.Struct({
  name: EnvironmentNameSchema,
  repo: Schema.optionalKey(Schema.NonEmptyString),
  removed: Schema.optionalKey(Schema.Boolean),
  secret: Schema.optionalKey(Schema.Boolean),
  configured: Schema.optionalKey(Schema.Literal(true)),
  revision: Schema.Number,
});
export type EnvironmentMutationResponse = typeof EnvironmentMutationResponseSchema.Type;

export function canonicalEnvironmentOrigin(value: string): string {
  const parsed = Result.try(() => new URL(value));
  return Result.isFailure(parsed) ? value : parsed.success.origin;
}
