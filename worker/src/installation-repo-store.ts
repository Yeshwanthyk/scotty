import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import {
  compareRepositoryRegistryEntries,
  repositoryIdentityKey,
  RepositoryRegistryAuthoritySchema,
  RepositoryRegistryRemoveInputSchema,
  RepositoryRegistryUpsertInputSchema,
  type RepositoryRegistryAuthority,
  type RepositoryRegistryEntry,
  type RepositoryRegistryUpsertInput,
} from "../../protocol/repository";

export const INSTALLATION_REPOSITORY_REGISTRY_KEY = "scotty:installation-repositories:1";

export type InstallationRepoFailureReason = "invalid_authority" | "invalid_input" | "storage";

export class InstallationRepoFailure extends Data.TaggedError("InstallationRepoFailure")<{
  readonly reason: InstallationRepoFailureReason;
  readonly message: string;
}> {}

export interface InstallationRepoAuthorityTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (authority: RepositoryRegistryAuthority) => Promise<void>;
}

export interface InstallationRepoAuthorityStorage {
  readonly transaction: <A>(
    operation: (transaction: InstallationRepoAuthorityTransaction) => Promise<A>,
  ) => Promise<A>;
}

interface InstallationRepoStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<RepositoryRegistryEntry>, InstallationRepoFailure>;
  readonly upsert: (
    input: unknown,
  ) => Effect.Effect<RepositoryRegistryEntry, InstallationRepoFailure>;
  readonly remove: (repo: unknown) => Effect.Effect<boolean, InstallationRepoFailure>;
}

interface InstallationRepoTransactionResult<A> {
  readonly value: A;
  readonly authority: RepositoryRegistryAuthority;
  readonly write?: boolean;
}

export class InstallationRepoStore extends Context.Service<
  InstallationRepoStore,
  InstallationRepoStoreShape
>()("scotty/InstallationRepoStore") {}

export const durableObjectInstallationRepoStorage = (
  storage: DurableObjectStorage,
): InstallationRepoAuthorityStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(INSTALLATION_REPOSITORY_REGISTRY_KEY),
        put: (authority) => transaction.put(INSTALLATION_REPOSITORY_REGISTRY_KEY, authority),
      }),
    ),
});

export const installationRepoStoreLayer = (
  storage: InstallationRepoAuthorityStorage,
): Layer.Layer<InstallationRepoStore> =>
  Layer.succeed(InstallationRepoStore)(makeInstallationRepoStore(storage));

const decodeAuthority = Schema.decodeUnknownResult(RepositoryRegistryAuthoritySchema, {
  onExcessProperty: "error",
});

const decodeUpsertInput = Schema.decodeUnknownResult(RepositoryRegistryUpsertInputSchema, {
  onExcessProperty: "error",
});
const decodeRemoveInput = Schema.decodeUnknownResult(RepositoryRegistryRemoveInputSchema, {
  onExcessProperty: "error",
});

const emptyAuthority = (): RepositoryRegistryAuthority => ({ version: 1, entries: [] });

const makeInstallationRepoStore = (
  storage: InstallationRepoAuthorityStorage,
): InstallationRepoStoreShape => {
  const failure = (
    reason: InstallationRepoFailureReason,
    message: string,
  ): InstallationRepoFailure => new InstallationRepoFailure({ reason, message });
  const invalidAuthority = (): InstallationRepoFailure =>
    failure("invalid_authority", "Stored repository registry authority is invalid");
  const invalidInput = (): InstallationRepoFailure =>
    failure("invalid_input", "Repository registry input is invalid");
  const storageFailure = (): InstallationRepoFailure =>
    failure("storage", "Repository registry storage operation failed");
  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<RepositoryRegistryAuthority, InstallationRepoFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    const decoded = decodeAuthority(value);
    if (Result.isFailure(decoded)) return Result.fail(invalidAuthority());
    const identities = new Set<string>();
    for (const entry of decoded.success.entries) {
      const identity = repositoryIdentityKey(entry.repo);
      if (identities.has(identity)) return Result.fail(invalidAuthority());
      identities.add(identity);
    }
    return Result.succeed(decoded.success);
  };

  const transact = <A>(
    operation: (
      authority: RepositoryRegistryAuthority,
      nowMillis: number,
    ) => Promise<Result.Result<InstallationRepoTransactionResult<A>, InstallationRepoFailure>>,
  ): Effect.Effect<A, InstallationRepoFailure> =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const authority = parseAuthority(await transaction.get());
            if (Result.isFailure(authority)) return Result.fail(authority.failure);
            const result = await operation(authority.success, nowMillis);
            if (Result.isFailure(result)) return Result.fail(result.failure);
            if (result.success.write === false) return Result.succeed(result.success.value);
            const encoded = decodeAuthority(result.success.authority);
            if (Result.isFailure(encoded)) return Result.fail(invalidAuthority());
            await transaction.put(encoded.success);
            return Result.succeed(result.success.value);
          }),
        catch: storageFailure,
      }).pipe(Effect.flatMap(Effect.fromResult));
    });

  const readAuthority = (): Effect.Effect<RepositoryRegistryAuthority, InstallationRepoFailure> =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => parseAuthority(await transaction.get())),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  const decodeUpsert = (
    value: unknown,
  ): Result.Result<RepositoryRegistryUpsertInput, InstallationRepoFailure> => {
    const decoded = decodeUpsertInput(value);
    if (Result.isFailure(decoded)) return Result.fail(invalidInput());
    return Result.succeed(decoded.success);
  };

  const sortedEntries = (
    entries: ReadonlyArray<RepositoryRegistryEntry>,
  ): ReadonlyArray<RepositoryRegistryEntry> => entries.toSorted(compareRepositoryRegistryEntries);

  return InstallationRepoStore.of({
    list: readAuthority().pipe(Effect.map((authority) => sortedEntries(authority.entries))),

    upsert: (inputValue) => {
      const input = decodeUpsert(inputValue);
      if (Result.isFailure(input)) return Effect.fail(input.failure);
      return transact(async (authority, nowMillis) => {
        const now = new Date(nowMillis).toISOString();
        const existing = authority.entries.find(
          (entry) =>
            repositoryIdentityKey(entry.repo) === repositoryIdentityKey(input.success.repo),
        );
        const entry: RepositoryRegistryEntry = {
          repo: input.success.repo,
          defaultBranch: input.success.defaultBranch,
          addedAt: existing?.addedAt ?? now,
          lastUsedAt:
            existing === undefined
              ? now
              : new Date(Math.max(Date.parse(existing.lastUsedAt), nowMillis)).toISOString(),
        };
        const entries = existing
          ? authority.entries.map((candidate) =>
              repositoryIdentityKey(candidate.repo) === repositoryIdentityKey(input.success.repo)
                ? entry
                : candidate,
            )
          : [...authority.entries, entry];
        return Result.succeed({
          value: entry,
          authority: { version: 1, entries: sortedEntries(entries) },
        });
      });
    },

    remove: (repoValue) => {
      const decoded = decodeRemoveInput(repoValue);
      if (Result.isFailure(decoded)) return Effect.fail(invalidInput());
      return transact(async (authority) => {
        const identity = repositoryIdentityKey(decoded.success);
        const found = authority.entries.some(
          (entry) => repositoryIdentityKey(entry.repo) === identity,
        );
        return Result.succeed({
          value: found,
          authority: {
            version: 1,
            entries: authority.entries.filter(
              (entry) => repositoryIdentityKey(entry.repo) !== identity,
            ),
          },
          ...(found ? {} : { write: false as const }),
        });
      });
    },
  });
};
