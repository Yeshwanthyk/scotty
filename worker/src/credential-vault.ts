import { Clock, Context, Data, Effect, Layer, Result } from "effect";
import {
  decodeCredentialPatchResult,
  decodeCredentialSeedResult,
  decodeLegacyStoredCredentialResult,
  decodeNonEmptyStringResult,
  decodeStoredCredentialResult,
  type CredentialRefreshLease,
  type LegacyStoredCredential,
  type StoredCredential,
} from "./contracts";
import { parseCodexCredential } from "./egress";

const CREDENTIAL_KEY = "scotty:credential";
const REFRESH_LEASE_MILLIS = 60_000;

type CredentialVaultFailureReason =
  | "invalid_authority"
  | "invalid_patch"
  | "invalid_seed"
  | "lease_mismatch"
  | "missing"
  | "not_refreshable"
  | "sentinel_mismatch"
  | "storage";

export class CredentialVaultFailure extends Data.TaggedError("CredentialVaultFailure")<{
  readonly reason: CredentialVaultFailureReason;
  readonly message: string;
}> {}

export interface CredentialVaultTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (credential: StoredCredential) => Promise<void>;
  readonly delete: () => Promise<void>;
}

export interface CredentialVaultStorage {
  readonly transaction: <A>(
    operation: (transaction: CredentialVaultTransaction) => Promise<A>,
  ) => Promise<A>;
}

export interface CredentialVaultShape {
  readonly seed: (seed: unknown) => Effect.Effect<StoredCredential, CredentialVaultFailure>;
  readonly require: Effect.Effect<StoredCredential, CredentialVaultFailure>;
  readonly readForProxy: (
    sentinel: unknown,
  ) => Effect.Effect<StoredCredential | null, CredentialVaultFailure>;
  readonly beginRefresh: (
    sentinel: unknown,
    nonce: unknown,
  ) => Effect.Effect<CredentialRefreshLease | null, CredentialVaultFailure>;
  readonly persistRotation: (
    sentinel: unknown,
    patch: unknown,
    nonce: unknown,
  ) => Effect.Effect<void, CredentialVaultFailure>;
  readonly cancelRefresh: (
    sentinel: unknown,
    nonce: unknown,
  ) => Effect.Effect<void, CredentialVaultFailure>;
  readonly delete: Effect.Effect<void, CredentialVaultFailure>;
}

export class CredentialVault extends Context.Service<CredentialVault, CredentialVaultShape>()(
  "scotty/CredentialVault",
) {}

export const durableObjectCredentialVaultStorage = (
  storage: DurableObjectStorage,
): CredentialVaultStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(CREDENTIAL_KEY),
        put: (credential) => transaction.put(CREDENTIAL_KEY, credential),
        delete: () => transaction.delete(CREDENTIAL_KEY).then(() => undefined),
      }),
    ),
});

export const credentialVaultLayer = (
  storage: CredentialVaultStorage,
  githubSeed: unknown,
): Layer.Layer<CredentialVault> =>
  Layer.succeed(CredentialVault)(makeCredentialVault(storage, githubSeed));

const makeCredentialVault = (
  storage: CredentialVaultStorage,
  githubSeed: unknown,
): CredentialVaultShape => {
  const failure = (reason: CredentialVaultFailureReason, message: string): CredentialVaultFailure =>
    new CredentialVaultFailure({ reason, message });
  const invalidAuthority = (): CredentialVaultFailure =>
    failure("invalid_authority", "Stored credential record is invalid");
  const storageFailure = (): CredentialVaultFailure =>
    failure("storage", "Credential storage operation failed");

  const decodeCurrent = (value: unknown): Result.Result<StoredCredential, CredentialVaultFailure> =>
    Result.mapError(decodeStoredCredentialResult(value), invalidAuthority).pipe(
      Result.flatMap((credential) =>
        validTimestamps(credential) ? Result.succeed(credential) : Result.fail(invalidAuthority()),
      ),
    );

  const decodeLegacy = (
    value: unknown,
  ): Result.Result<LegacyStoredCredential, CredentialVaultFailure> =>
    Result.mapError(decodeLegacyStoredCredentialResult(value), invalidAuthority).pipe(
      Result.flatMap((credential) =>
        validTimestamps(credential) ? Result.succeed(credential) : Result.fail(invalidAuthority()),
      ),
    );

  const migrate = async (
    transaction: CredentialVaultTransaction,
    value: unknown,
  ): Promise<Result.Result<StoredCredential, CredentialVaultFailure>> => {
    const current = decodeCurrent(value);
    if (Result.isSuccess(current)) return current;
    const legacy = decodeLegacy(value);
    if (Result.isFailure(legacy)) return Result.fail(legacy.failure);
    const github = Result.mapError(decodeNonEmptyStringResult(githubSeed), () =>
      failure("invalid_seed", "GH_TOKEN is missing or invalid"),
    );
    if (Result.isFailure(github)) return Result.fail(github.failure);
    const next = { ...legacy.success, githubToken: github.success };
    await transaction.put(next);
    return Result.succeed(next);
  };

  const transact = <A>(
    operation: (
      transaction: CredentialVaultTransaction,
    ) => Promise<Result.Result<A, CredentialVaultFailure>>,
  ): Effect.Effect<A, CredentialVaultFailure> =>
    Effect.tryPromise({
      try: () => storage.transaction(operation),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  const requireFrom = async (
    transaction: CredentialVaultTransaction,
  ): Promise<Result.Result<StoredCredential, CredentialVaultFailure>> => {
    const stored = await transaction.get();
    if (stored === undefined)
      return Result.fail(failure("missing", "Session credential bundle is missing"));
    return migrate(transaction, stored);
  };

  return CredentialVault.of({
    seed: Effect.fnUntraced(function* (seed) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored !== undefined) return migrate(transaction, stored);
        const decodedSeed = Result.mapError(decodeCredentialSeedResult(seed), () =>
          failure("invalid_seed", "Credential seed is missing or invalid"),
        );
        if (Result.isFailure(decodedSeed)) return Result.fail(decodedSeed.failure);
        const github = Result.mapError(decodeNonEmptyStringResult(githubSeed), () =>
          failure("invalid_seed", "GH_TOKEN is missing or invalid"),
        );
        if (Result.isFailure(github)) return Result.fail(github.failure);
        const codex = Result.try({
          try: () => parseCodexCredential(decodedSeed.success.codexAuthJson),
          catch: () => failure("invalid_seed", "CODEX_AUTH_JSON is invalid"),
        });
        if (Result.isFailure(codex)) return Result.fail(codex.failure);
        const credential: StoredCredential = {
          codex: codex.success,
          githubToken: github.success,
          codexSentinel: decodedSeed.success.codexSentinel,
          githubSentinel: decodedSeed.success.githubSentinel,
          updatedAt: now,
        };
        await transaction.put(credential);
        return Result.succeed(credential);
      });
    }),
    require: transact(requireFrom),
    readForProxy: Effect.fnUntraced(function* (sentinel) {
      const decodedSentinel = decodeSentinel(sentinel, failure);
      if (Result.isFailure(decodedSentinel)) return null;
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(null);
        const decoded = await migrate(transaction, stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const credential = decoded.success;
        return Result.succeed(
          decodedSentinel.success === credential.codexSentinel ||
            decodedSentinel.success === credential.githubSentinel
            ? credential
            : null,
        );
      });
    }),
    beginRefresh: Effect.fnUntraced(function* (sentinel, nonce) {
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      const decodedSentinel = decodeSentinel(sentinel, failure);
      const decodedNonce = decodeNonce(nonce, failure);
      if (Result.isFailure(decodedSentinel) || Result.isFailure(decodedNonce)) return null;
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(null);
        const decoded = await migrate(transaction, stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const credential = decoded.success;
        if (
          credential.codexSentinel !== decodedSentinel.success ||
          !credential.codex.tokens?.refresh_token
        )
          return Result.succeed(null);
        if (
          credential.refreshLease &&
          nowMillis - Date.parse(credential.refreshLease.startedAt) < REFRESH_LEASE_MILLIS
        )
          return Result.succeed(null);
        const next: StoredCredential = {
          ...credential,
          refreshLease: { nonce: decodedNonce.success, startedAt: now },
        };
        await transaction.put(next);
        return Result.succeed({ credential: next, nonce: decodedNonce.success });
      });
    }),
    persistRotation: Effect.fnUntraced(function* (sentinel, patch, nonce) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const decodedSentinel = decodeSentinel(sentinel, failure);
      if (Result.isFailure(decodedSentinel)) return yield* decodedSentinel.failure;
      const decodedNonce = decodeNonce(nonce, failure);
      if (Result.isFailure(decodedNonce)) return yield* decodedNonce.failure;
      const decodedPatch = Result.mapError(decodeCredentialPatchResult(patch), () =>
        failure("invalid_patch", "Credential patch is invalid"),
      );
      if (Result.isFailure(decodedPatch)) return yield* decodedPatch.failure;
      yield* transact(async (transaction) => {
        const required = await requireFrom(transaction);
        if (Result.isFailure(required)) return Result.fail(required.failure);
        const credential = required.success;
        if (credential.codexSentinel !== decodedSentinel.success)
          return Result.fail(failure("sentinel_mismatch", "Credential sentinel mismatch"));
        if (credential.refreshLease?.nonce !== decodedNonce.success)
          return Result.fail(failure("lease_mismatch", "Credential refresh lease mismatch"));
        const tokens = credential.codex.tokens;
        if (!tokens)
          return Result.fail(failure("not_refreshable", "Credential is not refreshable"));
        const { refreshLease: _refreshLease, ...withoutLease } = credential;
        const next: StoredCredential = {
          ...withoutLease,
          codex: {
            ...credential.codex,
            tokens: {
              ...tokens,
              id_token: decodedPatch.success.idToken ?? tokens.id_token,
              access_token: decodedPatch.success.accessToken ?? tokens.access_token,
              refresh_token: decodedPatch.success.refreshToken ?? tokens.refresh_token,
            },
            last_refresh: now,
          },
          updatedAt: now,
        };
        await transaction.put(next);
        return Result.succeed(undefined);
      });
    }),
    cancelRefresh: Effect.fnUntraced(function* (sentinel, nonce) {
      const decodedSentinel = decodeSentinel(sentinel, failure);
      const decodedNonce = decodeNonce(nonce, failure);
      if (Result.isFailure(decodedSentinel) || Result.isFailure(decodedNonce)) return;
      yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(undefined);
        const decoded = await migrate(transaction, stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const credential = decoded.success;
        if (
          credential.codexSentinel !== decodedSentinel.success ||
          credential.refreshLease?.nonce !== decodedNonce.success
        )
          return Result.succeed(undefined);
        const { refreshLease: _refreshLease, ...next } = credential;
        await transaction.put(next);
        return Result.succeed(undefined);
      });
    }),
    delete: transact(async (transaction) => {
      await transaction.delete();
      return Result.succeed(undefined);
    }),
  });
};

const decodeSentinel = (
  value: unknown,
  failure: (reason: CredentialVaultFailureReason, message: string) => CredentialVaultFailure,
): Result.Result<string, CredentialVaultFailure> =>
  Result.mapError(decodeNonEmptyStringResult(value), () =>
    failure("sentinel_mismatch", "Credential sentinel mismatch"),
  );

const decodeNonce = (
  value: unknown,
  failure: (reason: CredentialVaultFailureReason, message: string) => CredentialVaultFailure,
): Result.Result<string, CredentialVaultFailure> =>
  Result.mapError(decodeNonEmptyStringResult(value), () =>
    failure("lease_mismatch", "Credential refresh lease mismatch"),
  );

const validTimestamps = (credential: LegacyStoredCredential | StoredCredential): boolean =>
  Number.isFinite(Date.parse(credential.updatedAt)) &&
  (credential.refreshLease === undefined ||
    Number.isFinite(Date.parse(credential.refreshLease.startedAt)));
