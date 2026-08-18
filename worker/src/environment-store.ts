import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import { RepositoryIdentitySchema, repositoryIdentityKey } from "../../protocol/repository";
import {
  EnvironmentAuthoritySchema,
  EnvironmentNameSchema,
  EnvironmentPutInputSchema,
  LegacyEnvironmentAuthoritySchema,
  type EnvironmentAuthority,
  type EnvironmentMutationResponse,
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
  readonly snapshot: (repo?: unknown) => Effect.Effect<EnvironmentSnapshot, EnvironmentFailure>;
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
const emptyAuthority = (): EnvironmentAuthority => ({
  version: 2,
  revision: 0,
  global: { variables: {} },
  repositories: {},
});

const makeEnvironmentStore = (storage: EnvironmentAuthorityStorage): EnvironmentStoreShape => {
  const failure = (reason: EnvironmentFailureReason, message: string): EnvironmentFailure =>
    new EnvironmentFailure({ reason, message });
  const invalidAuthority = (): EnvironmentFailure =>
    failure("invalid_authority", "Stored environment authority is invalid");
  const invalidInput = (): EnvironmentFailure =>
    failure("invalid_input", "Environment variable input is invalid");
  const invalidScope = (): EnvironmentFailure =>
    failure("invalid_scope", "Repository environment scope must be OWNER/NAME");
  const storageFailure = (): EnvironmentFailure =>
    failure("storage", "Environment storage operation failed");

  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<EnvironmentAuthority, EnvironmentFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    const decoded = Result.mapError(decodeStoredAuthority(value), invalidAuthority);
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    if (decoded.success.version === 2) return Result.succeed(decoded.success);
    return Result.succeed({
      version: 2,
      revision: decoded.success.revision,
      global: { variables: decoded.success.variables },
      repositories: {},
    });
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
          const authority = parseAuthority(await transaction.get());
          if (Result.isFailure(authority)) return Result.fail(authority.failure);
          return operation(authority.success, transaction);
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
  ): Result.Result<string | undefined, EnvironmentFailure> =>
    repo === undefined
      ? Result.succeed(undefined)
      : Result.mapError(decodeRepo(repo), invalidScope);

  const effectiveVariables = (
    authority: EnvironmentAuthority,
    repo: string | undefined,
  ): Readonly<
    Record<string, { readonly variable: EnvironmentVariable; readonly source: "global" | "repo" }>
  > => {
    const global = Object.fromEntries(
      Object.entries(authority.global.variables).map(([name, variable]) => [
        name,
        { variable, source: "global" as const },
      ]),
    );
    if (repo === undefined) return global;
    const overrides = authority.repositories[repositoryIdentityKey(repo)]?.variables ?? {};
    return {
      ...global,
      ...Object.fromEntries(
        Object.entries(overrides).map(([name, variable]) => [
          name,
          { variable, source: "repo" as const },
        ]),
      ),
    };
  };

  return EnvironmentStore.of({
    list: (repoValue) =>
      Effect.gen(function* () {
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        return yield* transact(async (authority) =>
          Result.succeed({
            revision: authority.revision,
            ...(repo === undefined ? {} : { repo }),
            variables: Object.entries(effectiveVariables(authority, repo))
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, { source, variable }]) => ({
                name,
                secret: variable.secret,
                configured: true as const,
                updatedAt: variable.updatedAt,
                ...(repo === undefined ? {} : { source }),
                ...(variable.secret ? {} : { value: variable.value }),
              })),
          }),
        );
      }),
    snapshot: (repoValue) =>
      Effect.gen(function* () {
        const repo = yield* Effect.fromResult(parseScope(repoValue));
        return yield* transact(async (authority) =>
          Result.succeed({
            revision: authority.revision,
            variables: Object.fromEntries(
              Object.entries(effectiveVariables(authority, repo)).map(([name, { variable }]) => [
                name,
                variable.value,
              ]),
            ),
          }),
        );
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
          const variables =
            repo === undefined
              ? authority.global.variables
              : (authority.repositories[repositoryIdentityKey(repo)]?.variables ?? {});
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            ...(repo === undefined
              ? {
                  global: {
                    variables: {
                      ...variables,
                      [name]: { value: input.value, secret: input.secret, updatedAt: now },
                    },
                  },
                }
              : {
                  repositories: {
                    ...authority.repositories,
                    [repositoryIdentityKey(repo)]: {
                      variables: {
                        ...variables,
                        [name]: { value: input.value, secret: input.secret, updatedAt: now },
                      },
                    },
                  },
                }),
          };
          await transaction.put(next);
          return Result.succeed({
            name,
            ...(repo === undefined ? {} : { repo }),
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
              : (authority.repositories[repositoryIdentityKey(repo)]?.variables ?? {});
          if (!(name in variables))
            return Result.succeed({
              name,
              ...(repo === undefined ? {} : { repo }),
              removed: false,
              revision: authority.revision,
            });
          const remaining = { ...variables };
          delete remaining[name];
          const repositories = { ...authority.repositories };
          if (repo !== undefined) {
            if (Object.keys(remaining).length === 0)
              delete repositories[repositoryIdentityKey(repo)];
            else repositories[repositoryIdentityKey(repo)] = { variables: remaining };
          }
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            ...(repo === undefined ? { global: { variables: remaining } } : { repositories }),
          };
          await transaction.put(next);
          return Result.succeed({
            name,
            ...(repo === undefined ? {} : { repo }),
            removed: true,
            revision: next.revision,
          });
        });
      }),
  });
};
