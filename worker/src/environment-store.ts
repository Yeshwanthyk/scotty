import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import { RepositoryIdentitySchema, repositoryIdentityKey } from "../../protocol/repository";
import {
  EnvironmentApprovalListSchema,
  EnvironmentApprovalMutationResponseSchema,
  EnvironmentAuthorizationRequestSchema,
  EnvironmentAuthorizationResultSchema,
  EnvironmentAuthoritySchema,
  EnvironmentAuthorityV2Schema,
  EnvironmentMaterializationSchema,
  ENVIRONMENT_MAX_ORIGIN_POLICIES,
  ENVIRONMENT_MAX_PENDING_OBSERVATIONS,
  EnvironmentNameSchema,
  EnvironmentPolicyKeyInputSchema,
  EnvironmentPutInputSchema,
  EnvironmentSnapshotSchema,
  EnvironmentVariablesViewSchema,
  LegacyEnvironmentAuthoritySchema,
  RepositoryEnvironmentSchema,
  canonicalEnvironmentOrigin,
  environmentPolicyKey,
  type EnvironmentApprovalList,
  type EnvironmentApprovalMutationResponse,
  type EnvironmentAuthorizationDecision,
  type EnvironmentAuthorizationRequest,
  type EnvironmentAuthorizationResult,
  type EnvironmentAuthority,
  type EnvironmentAuthorityV2,
  type EnvironmentEffectiveVariable,
  type EnvironmentMaterialization,
  type EnvironmentMutationResponse,
  type EnvironmentOriginPolicy,
  type EnvironmentPendingObservation,
  type EnvironmentPutInput,
  type EnvironmentSnapshot,
  type EnvironmentVariable,
  type EnvironmentVariablesView,
} from "./environment-contracts";
import { environmentNameIsReserved } from "./environment-policy";

const AUTHORITY_KEY = "scotty:environment:1";

export type EnvironmentFailureReason =
  | "invalid_authority"
  | "invalid_input"
  | "invalid_scope"
  | "storage";

export class EnvironmentFailure extends Data.TaggedError("EnvironmentFailure")<{
  readonly reason: EnvironmentFailureReason;
  readonly message: string;
}> {}

export interface EnvironmentAuthorityTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (authority: EnvironmentAuthority) => Promise<void>;
}

export interface EnvironmentAuthorityStorage {
  readonly transaction: <A>(
    operation: (transaction: EnvironmentAuthorityTransaction) => Promise<A>,
  ) => Promise<A>;
}

interface EnvironmentStoreShape {
  readonly list: (repo?: unknown) => Effect.Effect<EnvironmentVariablesView, EnvironmentFailure>;
  /** Compatibility-only complete snapshot; it includes real secret values and is not a session input. */
  readonly snapshot: (repo?: unknown) => Effect.Effect<EnvironmentSnapshot, EnvironmentFailure>;
  /** The only installation-to-session boundary that returns real secret values. */
  readonly materialize: (
    repo?: unknown,
  ) => Effect.Effect<EnvironmentMaterialization, EnvironmentFailure>;
  readonly put: (
    name: unknown,
    input: unknown,
    repo?: unknown,
  ) => Effect.Effect<EnvironmentMutationResponse, EnvironmentFailure>;
  readonly remove: (
    name: unknown,
    repo?: unknown,
  ) => Effect.Effect<EnvironmentMutationResponse, EnvironmentFailure>;
  /** Called by the future egress boundary, never by materialization. */
  readonly authorizeOrRecordPending: (
    input: unknown,
  ) => Effect.Effect<EnvironmentAuthorizationResult, EnvironmentFailure>;
  readonly listApprovals: (
    repo?: unknown,
  ) => Effect.Effect<EnvironmentApprovalList, EnvironmentFailure>;
  readonly approve: (
    input: unknown,
  ) => Effect.Effect<EnvironmentApprovalMutationResponse, EnvironmentFailure>;
  readonly reject: (
    input: unknown,
  ) => Effect.Effect<EnvironmentApprovalMutationResponse, EnvironmentFailure>;
  readonly revoke: (
    input: unknown,
  ) => Effect.Effect<EnvironmentApprovalMutationResponse, EnvironmentFailure>;
}

export class EnvironmentStore extends Context.Service<EnvironmentStore, EnvironmentStoreShape>()(
  "scotty/EnvironmentStore",
) {}

export const durableObjectEnvironmentStorage = (
  storage: DurableObjectStorage,
): EnvironmentAuthorityStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(AUTHORITY_KEY),
        put: (authority) => transaction.put(AUTHORITY_KEY, authority),
      }),
    ),
});

export const environmentStoreLayer = (
  storage: EnvironmentAuthorityStorage,
): Layer.Layer<EnvironmentStore> => Layer.succeed(EnvironmentStore)(makeEnvironmentStore(storage));

const StoredEnvironmentAuthoritySchema = Schema.Union([
  LegacyEnvironmentAuthoritySchema,
  EnvironmentAuthorityV2Schema,
  EnvironmentAuthoritySchema,
]);
const decodeStoredAuthority = Schema.decodeUnknownResult(StoredEnvironmentAuthoritySchema, {
  onExcessProperty: "error",
});
const decodeName = Schema.decodeUnknownResult(EnvironmentNameSchema);
const decodeRepo = Schema.decodeUnknownResult(RepositoryIdentitySchema);
const decodeInput = Schema.decodeUnknownResult(EnvironmentPutInputSchema, {
  onExcessProperty: "error",
});
const decodeSnapshot = Schema.decodeUnknownResult(EnvironmentSnapshotSchema, {
  onExcessProperty: "error",
});
const decodeMaterialization = Schema.decodeUnknownResult(EnvironmentMaterializationSchema, {
  onExcessProperty: "error",
});
const decodeVariablesView = Schema.decodeUnknownResult(EnvironmentVariablesViewSchema, {
  onExcessProperty: "error",
});
const decodeAuthorizationRequest = Schema.decodeUnknownResult(
  EnvironmentAuthorizationRequestSchema,
  { onExcessProperty: "error" },
);
const decodePolicyKeyInput = Schema.decodeUnknownResult(EnvironmentPolicyKeyInputSchema, {
  onExcessProperty: "error",
});
const decodeApprovalList = Schema.decodeUnknownResult(EnvironmentApprovalListSchema, {
  onExcessProperty: "error",
});
const decodeApprovalMutation = Schema.decodeUnknownResult(
  EnvironmentApprovalMutationResponseSchema,
  { onExcessProperty: "error" },
);
const decodeAuthorizationResult = Schema.decodeUnknownResult(EnvironmentAuthorizationResultSchema, {
  onExcessProperty: "error",
});

type LegacyAuthority = typeof LegacyEnvironmentAuthoritySchema.Type;
type StoredV2Authority = typeof EnvironmentAuthorityV2Schema.Type;
type RepositoryEnvironments = Readonly<Record<string, typeof RepositoryEnvironmentSchema.Type>>;
type NormalizedPolicyKey = Pick<EnvironmentOriginPolicy, "sourceScope" | "name" | "origin">;

const emptyAuthority = (): EnvironmentAuthority => ({
  version: 3,
  revision: 0,
  policyRevision: 0,
  global: { variables: {} },
  repositories: {},
  originPolicies: [],
  pendingObservations: [],
});

const sameEnvironment = (
  left: typeof RepositoryEnvironmentSchema.Type,
  right: typeof RepositoryEnvironmentSchema.Type,
): boolean => {
  const leftNames = Object.keys(left.variables);
  const rightNames = Object.keys(right.variables);
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name) => {
      const leftVariable = left.variables[name];
      const rightVariable = right.variables[name];
      return (
        leftVariable !== undefined &&
        rightVariable !== undefined &&
        leftVariable.value === rightVariable.value &&
        leftVariable.secret === rightVariable.secret &&
        leftVariable.updatedAt === rightVariable.updatedAt
      );
    })
  );
};

/** Canonicalize v2 repository keys without silently losing a conflicting value. */
const migrateRepositories = (
  repositories: StoredV2Authority["repositories"],
): Result.Result<RepositoryEnvironments, "collision"> => {
  const normalized: Record<string, typeof RepositoryEnvironmentSchema.Type> = {};
  for (const [repository, environment] of Object.entries(repositories)) {
    const canonical = repositoryIdentityKey(repository);
    const existing = normalized[canonical];
    if (existing !== undefined && !sameEnvironment(existing, environment))
      return Result.fail("collision");
    normalized[canonical] = { variables: { ...environment.variables } };
  }
  return Result.succeed(normalized);
};

/** Migrate only validated legacy authorities; policy observations did not exist before v3. */
const migrateAuthority = (
  value: LegacyAuthority | EnvironmentAuthorityV2,
): Result.Result<EnvironmentAuthority, "collision"> => {
  const repositories: Result.Result<RepositoryEnvironments, "collision"> =
    value.version === 1 ? Result.succeed({}) : migrateRepositories(value.repositories);
  if (Result.isFailure(repositories)) return Result.fail(repositories.failure);
  return Result.succeed({
    version: 3,
    revision: value.revision,
    policyRevision: 0,
    global:
      value.version === 1
        ? { variables: { ...value.variables } }
        : { variables: { ...value.global.variables } },
    repositories: repositories.success,
    originPolicies: [],
    pendingObservations: [],
  });
};

interface ParsedAuthority {
  readonly authority: EnvironmentAuthority;
  readonly migrated: boolean;
}

const makeEnvironmentStore = (storage: EnvironmentAuthorityStorage): EnvironmentStoreShape => {
  const failure = (reason: EnvironmentFailureReason, message: string): EnvironmentFailure =>
    new EnvironmentFailure({ reason, message });
  const invalidAuthority = (): EnvironmentFailure =>
    failure("invalid_authority", "Stored environment authority is invalid");
  const invalidInput = (): EnvironmentFailure =>
    failure("invalid_input", "Environment variable input is invalid");
  const invalidInputMessage = (message: string): EnvironmentFailure =>
    failure("invalid_input", message);
  const invalidScope = (): EnvironmentFailure =>
    failure("invalid_scope", "Repository environment scope must be OWNER/NAME");
  const storageFailure = (): EnvironmentFailure =>
    failure("storage", "Environment storage operation failed");

  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<ParsedAuthority, EnvironmentFailure> => {
    if (value === undefined)
      return Result.succeed({ authority: emptyAuthority(), migrated: false });
    const decoded = Result.mapError(decodeStoredAuthority(value), invalidAuthority);
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    if (decoded.success.version === 3)
      return Result.succeed({ authority: decoded.success, migrated: false });
    const migrated = migrateAuthority(decoded.success);
    return Result.isFailure(migrated)
      ? Result.fail(invalidAuthority())
      : Result.succeed({ authority: migrated.success, migrated: true });
  };

  const transact = <A>(
    operation: (
      authority: EnvironmentAuthority,
      transaction: EnvironmentAuthorityTransaction,
    ) => Promise<Result.Result<A, EnvironmentFailure>>,
  ): Effect.Effect<A, EnvironmentFailure> =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const parsed = parseAuthority(await transaction.get());
          if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
          if (parsed.success.migrated) await transaction.put(parsed.success.authority);
          return operation(parsed.success.authority, transaction);
        }),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  const parseName = (name: unknown): Result.Result<string, EnvironmentFailure> => {
    const decoded = Result.mapError(decodeName(name), invalidInput);
    if (Result.isFailure(decoded)) return decoded;
    return environmentNameIsReserved(decoded.success)
      ? Result.fail(invalidInput())
      : Result.succeed(decoded.success);
  };

  const parseScope = (
    repo: unknown | undefined,
  ): Result.Result<string | undefined, EnvironmentFailure> => {
    if (repo === undefined) return Result.succeed(undefined);
    const decoded = Result.mapError(decodeRepo(repo), invalidScope);
    return Result.isFailure(decoded)
      ? Result.fail(decoded.failure)
      : Result.succeed(repositoryIdentityKey(decoded.success));
  };

  const parseScopeDisplay = (
    repo: unknown | undefined,
  ): Result.Result<string | undefined, EnvironmentFailure> => {
    if (repo === undefined) return Result.succeed(undefined);
    const decoded = Result.mapError(decodeRepo(repo), invalidScope);
    return Result.isFailure(decoded)
      ? Result.fail(decoded.failure)
      : Result.succeed(decoded.success);
  };

  const effectiveVariables = (
    authority: EnvironmentAuthority,
    repo: string | undefined,
  ): Readonly<
    Record<string, { readonly variable: EnvironmentVariable; readonly sourceScope: string }>
  > => {
    const variables: Record<
      string,
      { readonly variable: EnvironmentVariable; readonly sourceScope: string }
    > = {};
    for (const [name, variable] of Object.entries(authority.global.variables))
      variables[name] = { variable, sourceScope: "global" };
    if (repo !== undefined) {
      for (const [name, variable] of Object.entries(authority.repositories[repo]?.variables ?? {}))
        variables[name] = { variable, sourceScope: repo };
    }
    return variables;
  };

  const parsePolicyKey = (
    value: unknown,
  ): Result.Result<NormalizedPolicyKey, EnvironmentFailure> => {
    const decoded = Result.mapError(decodePolicyKeyInput(value), invalidInput);
    if (Result.isFailure(decoded)) return decoded;
    return Result.succeed({
      sourceScope:
        decoded.success.sourceScope === "global"
          ? "global"
          : repositoryIdentityKey(decoded.success.sourceScope),
      name: decoded.success.name,
      origin: canonicalEnvironmentOrigin(decoded.success.origin),
    });
  };

  const policyMatches = (left: NormalizedPolicyKey, right: NormalizedPolicyKey): boolean =>
    environmentPolicyKey(left) === environmentPolicyKey(right);

  const effectivePolicy = (
    authority: EnvironmentAuthority,
    key: NormalizedPolicyKey,
  ): EnvironmentOriginPolicy | undefined =>
    authority.originPolicies.find((policy) => policyMatches(policy, key));

  const sortedPolicies = (
    policies: ReadonlyArray<EnvironmentOriginPolicy>,
  ): ReadonlyArray<EnvironmentOriginPolicy> =>
    [...policies].sort(
      (left, right) =>
        left.sourceScope.localeCompare(right.sourceScope) ||
        left.name.localeCompare(right.name) ||
        left.origin.localeCompare(right.origin),
    );

  const sortedPending = (
    pending: ReadonlyArray<EnvironmentPendingObservation>,
  ): ReadonlyArray<EnvironmentPendingObservation> =>
    [...pending].sort(
      (left, right) =>
        left.sourceScope.localeCompare(right.sourceScope) ||
        left.name.localeCompare(right.name) ||
        left.origin.localeCompare(right.origin),
    );

  const approvalList = (
    authority: EnvironmentAuthority,
    repo: string | undefined,
  ): EnvironmentApprovalList => {
    const matchesScope = (value: { readonly sourceScope: string }): boolean =>
      repo === undefined || value.sourceScope === repo;
    return {
      revision: authority.revision,
      policyRevision: authority.policyRevision,
      approvals: sortedPolicies(authority.originPolicies)
        .filter(matchesScope)
        .map((policy) => ({ ...policy })),
      pending: sortedPending(authority.pendingObservations)
        .filter(matchesScope)
        .map((observation) => ({ ...observation })),
    };
  };

  const mutation = Effect.fnUntraced(function* (
    input: unknown,
    decision: EnvironmentOriginPolicy["decision"],
  ) {
    const key = yield* Effect.fromResult(parsePolicyKey(input));
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* transact(async (authority, transaction) => {
      const existing = effectivePolicy(authority, key);
      const hasPending = authority.pendingObservations.some((observation) =>
        policyMatches(observation, key),
      );
      if (existing?.decision === decision && !hasPending)
        return Result.succeed({
          sourceScope: key.sourceScope,
          name: key.name,
          origin: key.origin,
          decision,
          revision: authority.revision,
          policyRevision: authority.policyRevision,
        });
      if (decision === "approved") {
        const variables =
          key.sourceScope === "global"
            ? authority.global.variables
            : authority.repositories[key.sourceScope]?.variables;
        if (variables?.[key.name]?.secret !== true)
          return Result.fail(
            invalidInputMessage(
              "Environment approval requires a currently configured secret variable",
            ),
          );
        if (!hasPending)
          return Result.fail(
            invalidInputMessage("Environment approval requires a matching pending observation"),
          );
      }
      const originPolicies = [
        ...authority.originPolicies.filter((policy) => !policyMatches(policy, key)),
        {
          sourceScope: key.sourceScope,
          name: key.name,
          origin: key.origin,
          decision,
          updatedAt: now,
        },
      ];
      if (originPolicies.length > ENVIRONMENT_MAX_ORIGIN_POLICIES)
        return Result.fail(invalidInputMessage("Environment origin policy capacity reached"));
      const next: EnvironmentAuthority = {
        ...authority,
        policyRevision: authority.policyRevision + 1,
        originPolicies,
        pendingObservations: authority.pendingObservations.filter(
          (observation) => !policyMatches(observation, key),
        ),
      };
      await transaction.put(next);
      const encoded = decodeApprovalMutation({
        sourceScope: key.sourceScope,
        name: key.name,
        origin: key.origin,
        decision,
        revision: next.revision,
        policyRevision: next.policyRevision,
      });
      return Result.isFailure(encoded)
        ? Result.fail(invalidAuthority())
        : Result.succeed(encoded.success);
    });
  });

  const snapshot = (repoValue: unknown) =>
    Effect.gen(function* () {
      const repo = yield* Effect.fromResult(parseScope(repoValue));
      return yield* transact(async (authority) => {
        const decoded = decodeSnapshot({
          revision: authority.revision,
          variables: Object.fromEntries(
            Object.entries(effectiveVariables(authority, repo)).map(([name, { variable }]) => [
              name,
              variable.value,
            ]),
          ),
        });
        return Result.isFailure(decoded)
          ? Result.fail(invalidAuthority())
          : Result.succeed(decoded.success);
      });
    });

  return EnvironmentStore.of({
    snapshot,
    list: (repoValue) =>
      Effect.gen(function* () {
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        const displayRepo = yield* Effect.fromResult(parseScopeDisplay(repoValue));
        return yield* transact(async (authority) => {
          const decoded = decodeVariablesView({
            revision: authority.revision,
            ...(displayRepo === undefined ? {} : { repo: displayRepo }),
            variables: Object.entries(effectiveVariables(authority, repo))
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, { sourceScope, variable }]) => ({
                name,
                secret: variable.secret,
                configured: true as const,
                updatedAt: variable.updatedAt,
                ...(repo === undefined
                  ? {}
                  : { source: sourceScope === "global" ? ("global" as const) : ("repo" as const) }),
                ...(variable.secret ? undefined : { value: variable.value }),
              })),
          });
          return Result.isFailure(decoded)
            ? Result.fail(invalidAuthority())
            : Result.succeed(decoded.success);
        });
      }),
    materialize: (repoValue) =>
      Effect.gen(function* () {
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        return yield* transact(async (authority) => {
          const variables: Record<string, EnvironmentEffectiveVariable> = {};
          for (const [name, { sourceScope, variable }] of Object.entries(
            effectiveVariables(authority, repo),
          ))
            variables[name] = {
              value: variable.value,
              secret: variable.secret,
              updatedAt: variable.updatedAt,
              sourceScope,
            };
          const decoded = decodeMaterialization({
            revision: authority.revision,
            ...(repo === undefined ? {} : { repo }),
            variables,
          });
          return Result.isFailure(decoded)
            ? Result.fail(invalidAuthority())
            : Result.succeed(decoded.success);
        });
      }),
    put: (nameValue, inputValue, repoValue) =>
      Effect.gen(function* () {
        const name = yield* Effect.fromResult(parseName(nameValue));
        const input: EnvironmentPutInput = yield* Effect.fromResult(
          Result.mapError(decodeInput(inputValue), invalidInput),
        );
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* transact(async (authority, transaction) => {
          if (repo === undefined) {
            const next: EnvironmentAuthority = {
              ...authority,
              revision: authority.revision + 1,
              global: {
                variables: {
                  ...authority.global.variables,
                  [name]: { value: input.value, secret: input.secret, updatedAt: now },
                },
              },
            };
            await transaction.put(next);
            return Result.succeed({
              name,
              secret: input.secret,
              configured: true as const,
              revision: next.revision,
            });
          }
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            repositories: {
              ...authority.repositories,
              [repo]: {
                variables: {
                  ...authority.repositories[repo]?.variables,
                  [name]: { value: input.value, secret: input.secret, updatedAt: now },
                },
              },
            },
          };
          await transaction.put(next);
          return Result.succeed({
            name,
            repo,
            secret: input.secret,
            configured: true as const,
            revision: next.revision,
          });
        });
      }),
    remove: (nameValue, repoValue) =>
      Effect.gen(function* () {
        const name = yield* Effect.fromResult(parseName(nameValue));
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        return yield* transact(async (authority, transaction) => {
          const variables =
            repo === undefined
              ? authority.global.variables
              : (authority.repositories[repo]?.variables ?? {});
          if (!Object.hasOwn(variables, name))
            return Result.succeed({
              name,
              ...(repo === undefined ? {} : { repo }),
              removed: false,
              revision: authority.revision,
            });
          const remaining = { ...variables };
          delete remaining[name];
          if (repo === undefined) {
            const next: EnvironmentAuthority = {
              ...authority,
              revision: authority.revision + 1,
              global: { variables: remaining },
            };
            await transaction.put(next);
            return Result.succeed({
              name,
              removed: true,
              revision: next.revision,
            });
          }
          const repositories = { ...authority.repositories };
          if (Object.keys(remaining).length === 0) delete repositories[repo];
          else repositories[repo] = { variables: remaining };
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            repositories,
          };
          await transaction.put(next);
          return Result.succeed({
            name,
            repo,
            removed: true,
            revision: next.revision,
          });
        });
      }),
    authorizeOrRecordPending: (inputValue) =>
      Effect.gen(function* () {
        const decoded = Result.mapError(decodeAuthorizationRequest(inputValue), invalidInput);
        if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
        const input: EnvironmentAuthorizationRequest = decoded.success;
        const origin = canonicalEnvironmentOrigin(input.origin);
        const normalized = new Map<string, NormalizedPolicyKey>();
        for (const key of input.keys) {
          const normalizedKey: NormalizedPolicyKey = {
            sourceScope:
              key.sourceScope === "global" ? "global" : repositoryIdentityKey(key.sourceScope),
            name: key.name,
            origin,
          };
          normalized.set(environmentPolicyKey(normalizedKey), normalizedKey);
        }
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* transact(async (authority, transaction) => {
          let pendingChanged = false;
          const newPendingCount = [...normalized.values()].filter((key) => {
            const variables =
              key.sourceScope === "global"
                ? authority.global.variables
                : authority.repositories[key.sourceScope]?.variables;
            return (
              variables?.[key.name]?.secret === true &&
              effectivePolicy(authority, key) === undefined &&
              !authority.pendingObservations.some((observation) => policyMatches(observation, key))
            );
          }).length;
          if (
            authority.pendingObservations.length + newPendingCount >
            ENVIRONMENT_MAX_PENDING_OBSERVATIONS
          )
            return Result.fail(
              invalidInputMessage("Environment pending observation capacity reached"),
            );
          const pendingObservations = [...authority.pendingObservations];
          const decisions: EnvironmentAuthorizationDecision[] = [...normalized.values()].map(
            (key) => {
              const variables =
                key.sourceScope === "global"
                  ? authority.global.variables
                  : authority.repositories[key.sourceScope]?.variables;
              if (variables?.[key.name]?.secret !== true)
                return {
                  sourceScope: key.sourceScope,
                  name: key.name,
                  origin: key.origin,
                  status: "revoked" as const,
                };
              const policy = effectivePolicy(authority, key);
              if (policy !== undefined)
                return {
                  sourceScope: key.sourceScope,
                  name: key.name,
                  origin: key.origin,
                  status: policy.decision,
                };
              const index = pendingObservations.findIndex((observation) =>
                policyMatches(observation, key),
              );
              if (index < 0) {
                pendingObservations.push({
                  sourceScope: key.sourceScope,
                  name: key.name,
                  origin: key.origin,
                  firstObservedAt: now,
                  lastObservedAt: now,
                });
                pendingChanged = true;
              } else {
                const existing = pendingObservations[index];
                if (existing !== undefined && existing.lastObservedAt !== now) {
                  pendingObservations[index] = { ...existing, lastObservedAt: now };
                  pendingChanged = true;
                }
              }
              return {
                sourceScope: key.sourceScope,
                name: key.name,
                origin: key.origin,
                status: "pending" as const,
              };
            },
          );
          const next: EnvironmentAuthority = pendingChanged
            ? {
                ...authority,
                policyRevision: authority.policyRevision + 1,
                pendingObservations,
              }
            : authority;
          if (pendingChanged) await transaction.put(next);
          const result = decodeAuthorizationResult({
            policyRevision: next.policyRevision,
            authorized: decisions.every((decision) => decision.status === "approved"),
            decisions,
          });
          return Result.isFailure(result)
            ? Result.fail(invalidAuthority())
            : Result.succeed(result.success);
        });
      }),
    listApprovals: (repoValue) =>
      Effect.gen(function* () {
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        return yield* transact(async (authority) => {
          const decoded = decodeApprovalList(approvalList(authority, repo));
          return Result.isFailure(decoded)
            ? Result.fail(invalidAuthority())
            : Result.succeed(decoded.success);
        });
      }),
    approve: (input) => mutation(input, "approved"),
    reject: (input) => mutation(input, "rejected"),
    revoke: (input) => mutation(input, "revoked"),
  });
};
