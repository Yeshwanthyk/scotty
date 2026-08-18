import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import {
  EnvironmentAuthoritySchema,
  EnvironmentNameSchema,
  EnvironmentPutInputSchema,
  type EnvironmentAuthority,
  type EnvironmentMutationResponse,
  type EnvironmentPutInput,
  type EnvironmentSnapshot,
  type EnvironmentVariablesView,
} from "./environment-contracts";
import { environmentNameIsReserved } from "./environment-policy";

const AUTHORITY_KEY = "scotty:environment:1";

export type EnvironmentFailureReason = "invalid_authority" | "invalid_input" | "storage";

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
  readonly list: () => Effect.Effect<EnvironmentVariablesView, EnvironmentFailure>;
  readonly snapshot: () => Effect.Effect<EnvironmentSnapshot, EnvironmentFailure>;
  readonly put: (
    name: unknown,
    input: unknown,
  ) => Effect.Effect<EnvironmentMutationResponse, EnvironmentFailure>;
  readonly remove: (
    name: unknown,
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

const decodeAuthority = Schema.decodeUnknownResult(EnvironmentAuthoritySchema, {
  onExcessProperty: "error",
});
const decodeName = Schema.decodeUnknownResult(EnvironmentNameSchema);
const decodeInput = Schema.decodeUnknownResult(EnvironmentPutInputSchema, {
  onExcessProperty: "error",
});
const emptyAuthority = (): EnvironmentAuthority => ({ version: 1, revision: 0, variables: {} });

const makeEnvironmentStore = (storage: EnvironmentAuthorityStorage): EnvironmentStoreShape => {
  const failure = (reason: EnvironmentFailureReason, message: string): EnvironmentFailure =>
    new EnvironmentFailure({ reason, message });
  const invalidAuthority = (): EnvironmentFailure =>
    failure("invalid_authority", "Stored environment authority is invalid");
  const invalidInput = (): EnvironmentFailure =>
    failure("invalid_input", "Environment variable input is invalid");
  const storageFailure = (): EnvironmentFailure =>
    failure("storage", "Environment storage operation failed");

  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<EnvironmentAuthority, EnvironmentFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    return Result.mapError(decodeAuthority(value), invalidAuthority);
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

  return EnvironmentStore.of({
    list: () =>
      transact(async (authority) =>
        Result.succeed({
          revision: authority.revision,
          variables: Object.entries(authority.variables)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, variable]) => ({
              name,
              secret: variable.secret,
              configured: true as const,
              updatedAt: variable.updatedAt,
              ...(variable.secret ? {} : { value: variable.value }),
            })),
        }),
      ),
    snapshot: () =>
      transact(async (authority) =>
        Result.succeed({
          revision: authority.revision,
          variables: Object.fromEntries(
            Object.entries(authority.variables).map(([name, variable]) => [name, variable.value]),
          ),
        }),
      ),
    put: (nameValue, inputValue) =>
      Effect.gen(function* () {
        const name = yield* Effect.fromResult(parseName(nameValue));
        const input: EnvironmentPutInput = yield* Effect.fromResult(
          Result.mapError(decodeInput(inputValue), invalidInput),
        );
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* transact(async (authority, transaction) => {
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            variables: {
              ...authority.variables,
              [name]: { value: input.value, secret: input.secret, updatedAt: now },
            },
          };
          await transaction.put(next);
          return Result.succeed({
            name,
            secret: input.secret,
            configured: true as const,
            revision: next.revision,
          });
        });
      }),
    remove: (nameValue) =>
      Effect.gen(function* () {
        const name = yield* Effect.fromResult(parseName(nameValue));
        return yield* transact(async (authority, transaction) => {
          if (!(name in authority.variables))
            return Result.succeed({ name, removed: false, revision: authority.revision });
          const variables = { ...authority.variables };
          delete variables[name];
          const next: EnvironmentAuthority = {
            ...authority,
            revision: authority.revision + 1,
            variables,
          };
          await transaction.put(next);
          return Result.succeed({ name, removed: true, revision: next.revision });
        });
      }),
  });
};
