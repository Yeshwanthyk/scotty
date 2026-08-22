import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import { RepositoryIdentitySchema, repositoryIdentityKey } from "../../protocol/repository";
import {
  EnvironmentAuthoritySchema,
  EnvironmentAuthorityV2Schema,
  EnvironmentAuthorityV3Schema,
  EnvironmentCredentialBindingSchema,
  EnvironmentMaterializationSchema,
  EnvironmentNameSchema,
  EnvironmentOriginResolveRequestSchema,
  EnvironmentPutInputSchema,
  EnvironmentSnapshotSchema,
  EnvironmentVariablesViewSchema,
  LegacyEnvironmentAuthoritySchema,
  RepositoryEnvironmentSchema,
  canonicalEnvironmentOrigin,
  type EnvironmentAuthority,
  type EnvironmentCredentialBinding,
  type EnvironmentCredentialScheme,
  type EnvironmentEffectiveVariable,
  type EnvironmentMaterialization,
  type EnvironmentMutationResponse,
  type EnvironmentPutInput,
  type EnvironmentSnapshot,
  type EnvironmentVariable,
  type EnvironmentVariablesView,
} from "./environment-contracts";
import {
  environmentNameIsMaterializable,
  environmentNameIsReserved,
  requiredGlobalSecretNameIs,
} from "./environment-policy";

const AUTHORITY_KEY = "scotty:environment:1";

export type EnvironmentFailureReason =
  | "invalid_authority"
  | "invalid_input"
  | "invalid_scope"
  | "invalid_global_secret"
  | "unmapped_origin"
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
  /** Internal Worker/DO-only lookup for a required global secret value. */
  readonly resolveGlobalSecret: (name: unknown) => Effect.Effect<string, EnvironmentFailure>;
  /** The only installation-to-session boundary that returns real secret values. */
  readonly materialize: (
    repo?: unknown,
  ) => Effect.Effect<EnvironmentMaterialization, EnvironmentFailure>;
  /**
   * Egress-boundary credential resolution: given a destination origin, return the single
   * declared credential whose `origins` include it, or null when unmapped (deny-by-default).
   */
  readonly resolveCredentialForOrigin: (
    input: unknown,
  ) => Effect.Effect<EnvironmentCredentialBinding | null, EnvironmentFailure>;
  readonly put: (
    name: unknown,
    input: unknown,
    repo?: unknown,
  ) => Effect.Effect<EnvironmentMutationResponse, EnvironmentFailure>;
  readonly remove: (
    name: unknown,
    repo?: unknown,
  ) => Effect.Effect<EnvironmentMutationResponse, EnvironmentFailure>;
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
  EnvironmentAuthorityV3Schema,
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
const decodeOriginResolveRequest = Schema.decodeUnknownResult(
  EnvironmentOriginResolveRequestSchema,
  { onExcessProperty: "error" },
);
const decodeCredentialBinding = Schema.decodeUnknownResult(EnvironmentCredentialBindingSchema, {
  onExcessProperty: "error",
});
type LegacyAuthority = typeof LegacyEnvironmentAuthoritySchema.Type;
type StoredV2Authority = typeof EnvironmentAuthorityV2Schema.Type;
type StoredV3Authority = typeof EnvironmentAuthorityV3Schema.Type;
type RepositoryEnvironments = Readonly<Record<string, typeof RepositoryEnvironmentSchema.Type>>;

/** Deterministic preference order when several credentials declare the same origin. */
const CREDENTIAL_RESOLUTION_PREFERENCE = ["GH_TOKEN", "OPENAI_API_KEY", "OPENCODE_API_KEY"];

const defaultCredentialSchemeFor = (name: string): EnvironmentCredentialScheme =>
  name === "GH_TOKEN" ? "basic-x-access-token" : "bearer";

const emptyAuthority = (): EnvironmentAuthority => ({
  version: 4,
  revision: 0,
  global: { variables: {} },
  repositories: {},
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

/** Canonicalize v2+ repository keys without silently losing a conflicting value. */
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

/**
 * Fold v3 approved origin policies into per-variable `origins` lists and drop the separate
 * policy/pending state; rejected/revoked entries and pending observations are discarded.
 */
const migrateAuthority = (
  value: LegacyAuthority | StoredV2Authority | StoredV3Authority,
): Result.Result<EnvironmentAuthority, "collision"> => {
  const repositories: Result.Result<RepositoryEnvironments, "collision"> =
    value.version === 1
      ? Result.succeed({})
      : migrateRepositories(value.repositories as StoredV2Authority["repositories"]);
  if (Result.isFailure(repositories)) return Result.fail(repositories.failure);

  const approvedByScopeName = new Map<string, string[]>();
  if (value.version === 3) {
    for (const policy of value.originPolicies) {
      if (policy.decision !== "approved") continue;
      const key = `${policy.sourceScope}\u0000${policy.name}`;
      const origins = approvedByScopeName.get(key) ?? [];
      origins.push(policy.origin);
      approvedByScopeName.set(key, origins);
    }
  }
  const globalVariables =
    value.version === 1 ? { ...value.variables } : { ...value.global.variables };
  const applyOrigins = (
    variables: Record<string, EnvironmentVariable>,
    scope: string,
  ): Record<string, EnvironmentVariable> => {
    const next: Record<string, EnvironmentVariable> = {};
    for (const [name, variable] of Object.entries(variables)) {
      const origins = approvedByScopeName.get(`${scope}\u0000${name}`);
      next[name] =
        origins === undefined && variable.secret !== true
          ? variable
          : {
              ...variable,
              ...(origins === undefined ? {} : { origins }),
              ...(name === "GH_TOKEN" && variable.secret === true
                ? { scheme: "basic-x-access-token" as const }
                : {}),
            };
    }
    return next;
  };

  const repoEnvironments: Record<string, typeof RepositoryEnvironmentSchema.Type> = {};
  for (const [repo, environment] of Object.entries(repositories.success))
    repoEnvironments[repo] = { variables: applyOrigins(environment.variables, repo) };

  return Result.succeed({
    version: 4,
    revision: value.revision,
    global: { variables: applyOrigins(globalVariables, "global") },
    repositories: repoEnvironments,
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
  const invalidGlobalSecret = (name: string): EnvironmentFailure =>
    failure("invalid_global_secret", `Global ${name} secret is missing or invalid`);
  const storageFailure = (): EnvironmentFailure =>
    failure("storage", "Environment storage operation failed");

  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<ParsedAuthority, EnvironmentFailure> => {
    if (value === undefined)
      return Result.succeed({ authority: emptyAuthority(), migrated: false });
    const decoded = Result.mapError(decodeStoredAuthority(value), invalidAuthority);
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    if (decoded.success.version === 4)
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

  const parseManagedSecretName = (
    name: unknown,
    input: EnvironmentPutInput | undefined,
    repo: string | undefined,
  ): Result.Result<string, EnvironmentFailure> => {
    const decoded = Result.mapError(decodeName(name), invalidInput);
    if (Result.isFailure(decoded)) return decoded;
    if (!requiredGlobalSecretNameIs(decoded.success)) return parseName(decoded.success);
    if (repo !== undefined || (input !== undefined && input.secret === false))
      return Result.fail(invalidInput());
    return Result.succeed(decoded.success);
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

  const resolveGlobalSecret = (name: unknown) =>
    Effect.fromResult(parseManagedSecretName(name, undefined, undefined)).pipe(
      Effect.flatMap((resolved) =>
        transact(async (authority) => {
          const variable = authority.global.variables[resolved];
          if (
            variable === undefined ||
            variable.secret !== true ||
            variable.value.trim().length === 0
          )
            return Result.fail(invalidGlobalSecret(resolved));
          return Result.succeed(variable.value);
        }),
      ),
    );

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

  const resolveCredentialForOrigin = (inputValue: unknown) =>
    Effect.gen(function* () {
      const decoded = Result.mapError(decodeOriginResolveRequest(inputValue), invalidInput);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const origin = canonicalEnvironmentOrigin(decoded.success.origin);
      return yield* transact(async (authority) => {
        const candidates: Array<{ name: string; variable: EnvironmentVariable }> = [];
        for (const [name, { variable }] of Object.entries(
          effectiveVariables(authority, undefined),
        )) {
          if (variable.secret !== true) continue;
          if (!(variable.origins ?? []).includes(origin)) continue;
          candidates.push({ name, variable });
        }
        candidates.sort((left, right) => {
          const leftIndex = CREDENTIAL_RESOLUTION_PREFERENCE.indexOf(left.name);
          const rightIndex = CREDENTIAL_RESOLUTION_PREFERENCE.indexOf(right.name);
          if (leftIndex >= 0 || rightIndex >= 0)
            return (
              (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
              (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
            );
          return left.name.localeCompare(right.name);
        });
        const chosen = candidates[0];
        if (chosen === undefined) return Result.succeed(null);
        const encoded = decodeCredentialBinding({
          name: chosen.name,
          scheme: chosen.variable.scheme ?? defaultCredentialSchemeFor(chosen.name),
          value: chosen.variable.value,
        });
        return Result.isFailure(encoded)
          ? Result.fail(invalidAuthority())
          : Result.succeed(encoded.success);
      });
    });

  return EnvironmentStore.of({
    snapshot,
    resolveGlobalSecret,
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
                secret: variable.secret || environmentNameIsReserved(name),
                configured: true as const,
                updatedAt: variable.updatedAt,
                ...(repo === undefined
                  ? {}
                  : { source: sourceScope === "global" ? ("global" as const) : ("repo" as const) }),
                ...(variable.secret || environmentNameIsReserved(name)
                  ? undefined
                  : { value: variable.value }),
                ...((variable.origins ?? []).length === 0
                  ? {}
                  : { origins: [...(variable.origins ?? [])] }),
                ...(variable.scheme === undefined ? {} : { scheme: variable.scheme }),
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
          ).filter(([name]) => environmentNameIsMaterializable(name)))
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
        const input: EnvironmentPutInput = yield* Effect.fromResult(
          Result.mapError(decodeInput(inputValue), invalidInput),
        );
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        const name = yield* Effect.fromResult(parseManagedSecretName(nameValue, input, repo));
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* transact(async (authority, transaction) => {
          const mergeVariable = (
            existing: EnvironmentVariable | undefined,
          ): Result.Result<EnvironmentVariable, EnvironmentFailure> => {
            const created = existing === undefined;
            const value = input.value ?? (created ? undefined : existing!.value);
            const secret = input.secret ?? (created ? true : existing!.secret);
            if (value === undefined || secret === undefined)
              return Result.fail(
                created
                  ? invalidInputMessage("New environment variables require a value")
                  : invalidInput(),
              );
            return Result.succeed({
              value,
              secret,
              updatedAt: now,
              ...(input.origins === undefined
                ? existing?.origins === undefined
                  ? {}
                  : { origins: existing.origins }
                : { origins: input.origins }),
              ...(input.scheme === undefined
                ? existing?.scheme === undefined
                  ? {}
                  : { scheme: existing.scheme }
                : { scheme: input.scheme }),
            });
          };
          const writeVariable = (
            variables: Record<string, EnvironmentVariable>,
          ): Result.Result<Record<string, EnvironmentVariable>, EnvironmentFailure> => {
            const merged = mergeVariable(variables[name]);
            return Result.map(merged, (variable) => ({ ...variables, [name]: variable }));
          };
          if (repo === undefined) {
            const merged = writeVariable(authority.global.variables);
            if (Result.isFailure(merged)) return Result.fail(merged.failure);
            const next: EnvironmentAuthority = {
              ...authority,
              revision: authority.revision + 1,
              global: { variables: merged.success },
            };
            await transaction.put(next);
            return Result.succeed({
              name,
              secret: merged.success[name]!.secret,
              configured: true as const,
              revision: next.revision,
            });
          }
          const existingVariables = authority.repositories[repo]?.variables ?? {};
          const merged = writeVariable(existingVariables);
          if (Result.isFailure(merged)) return Result.fail(merged.failure);
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            repositories: {
              ...authority.repositories,
              [repo]: { variables: merged.success },
            },
          };
          await transaction.put(next);
          return Result.succeed({
            name,
            repo,
            secret: merged.success[name]!.secret,
            configured: true as const,
            revision: next.revision,
          });
        });
      }),
    remove: (nameValue, repoValue) =>
      Effect.gen(function* () {
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        const name = yield* Effect.fromResult(parseManagedSecretName(nameValue, undefined, repo));
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
    resolveCredentialForOrigin,
  });
};
