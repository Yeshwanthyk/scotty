import { Clock, Context, Data, Effect, Layer, Option, Result, Schema } from "effect";
import {
  decodeCredentialPatchResult,
  decodeCredentialReseedResult,
  decodeCredentialSeedResult,
  decodeNonEmptyStringResult,
  decodeStoredCredentialResult,
  type CredentialRefreshLease,
  type StoredCredential,
} from "./contracts";
import {
  InstallationPiAuthRecordSchema,
  digestPiAuthProviders,
  parsePiAuthJsonOption,
  serializePiAuthProviders,
  supportedPiProvider,
  type InstallationPiAuthRecord,
  type PiAuthStore,
} from "../../protocol/pi-auth";

const CREDENTIAL_KEY = "scotty:credential";
const REFRESH_LEASE_MILLIS = 60_000;
const decodeInstallationPiAuthRecordResult = Schema.decodeUnknownResult(
  InstallationPiAuthRecordSchema,
  { onExcessProperty: "error" },
);

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
  readonly reseed: (seed: unknown) => Effect.Effect<StoredCredential, CredentialVaultFailure>;
  readonly reconcile: (
    record: unknown,
    providerSentinelSeed: string,
  ) => Effect.Effect<StoredCredential, CredentialVaultFailure>;
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
): Layer.Layer<CredentialVault> => Layer.succeed(CredentialVault)(makeCredentialVault(storage));

const makeCredentialVault = (storage: CredentialVaultStorage): CredentialVaultShape => {
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
    return decodeCurrent(stored);
  };

  const decodeProviderStore = (raw: string): Result.Result<PiAuthStore, CredentialVaultFailure> => {
    const decoded = parsePiAuthJsonOption(raw);
    if (Option.isNone(decoded) || Object.keys(decoded.value).length === 0)
      return Result.fail(failure("invalid_seed", "PI_AUTH_JSON is invalid"));
    if (!Object.keys(decoded.value).some(supportedPiProvider))
      return Result.fail(
        failure("invalid_seed", "PI_AUTH_JSON has no provider supported by Scotty egress"),
      );
    return Result.succeed(decoded.value);
  };

  const decodeInstallationRecord = (
    value: unknown,
  ): Result.Result<InstallationPiAuthRecord, CredentialVaultFailure> =>
    Result.mapError(decodeInstallationPiAuthRecordResult(value), () =>
      failure("invalid_seed", "Installation Pi credential record is invalid"),
    );

  const storedProviders = (
    providers: PiAuthStore,
    sentinelSeed: string,
    current?: StoredCredential,
  ): StoredCredential["providers"] =>
    Object.fromEntries(
      Object.entries(providers).map(([providerId, credential], index) => [
        providerId,
        {
          credential,
          sentinel: current?.providers[providerId]?.sentinel ?? `${sentinelSeed}-${index}`,
        },
      ]),
    );

  return CredentialVault.of({
    seed: Effect.fnUntraced(function* (seed) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored !== undefined) return decodeCurrent(stored);
        const decodedSeed = Result.mapError(decodeCredentialSeedResult(seed), () =>
          failure("invalid_seed", "Credential seed is missing or invalid"),
        );
        if (Result.isFailure(decodedSeed)) return Result.fail(decodedSeed.failure);
        const providers =
          "installationRecord" in decodedSeed.success
            ? Result.succeed(decodedSeed.success.installationRecord.providers)
            : decodeProviderStore(decodedSeed.success.piAuthJson);
        if (Result.isFailure(providers)) return Result.fail(providers.failure);
        const credential: StoredCredential = {
          providers: storedProviders(providers.success, decodedSeed.success.providerSentinelSeed),
          updatedAt:
            "installationRecord" in decodedSeed.success
              ? decodedSeed.success.installationRecord.updatedAt
              : now,
        };
        await transaction.put(credential);
        return Result.succeed(credential);
      });
    }),
    reseed: Effect.fnUntraced(function* (seed) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const current = await requireFrom(transaction);
        if (Result.isFailure(current)) return Result.fail(current.failure);
        const decodedSeed = Result.mapError(decodeCredentialReseedResult(seed), () =>
          failure("invalid_seed", "Credential reseed is missing or invalid"),
        );
        if (Result.isFailure(decodedSeed)) return Result.fail(decodedSeed.failure);
        const providers = decodeProviderStore(decodedSeed.success.piAuthJson);
        if (Result.isFailure(providers)) return Result.fail(providers.failure);
        const { refreshLease: _refreshLease, ...withoutLease } = current.success;
        const credential: StoredCredential = {
          ...withoutLease,
          providers: storedProviders(
            providers.success,
            decodedSeed.success.providerSentinelSeed,
            current.success,
          ),
          updatedAt: now,
        };
        await transaction.put(credential);
        return Result.succeed(credential);
      });
    }),
    reconcile: Effect.fnUntraced(function* (recordValue, providerSentinelSeed) {
      const decoded = decodeInstallationRecord(recordValue);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      const expectedDigest = yield* Effect.tryPromise({
        try: () => digestPiAuthProviders(decoded.success.providers),
        catch: () => failure("invalid_seed", "Installation Pi credential record is invalid"),
      });
      if (expectedDigest !== decoded.success.digest)
        return yield* failure("invalid_seed", "Installation Pi credential record is invalid");
      return yield* transact(async (transaction) => {
        const current = await requireFrom(transaction);
        if (Result.isFailure(current)) return Result.fail(current.failure);
        const comparison = decoded.success.updatedAt.localeCompare(current.success.updatedAt);
        if (comparison < 0) return Result.succeed(current.success);
        if (comparison === 0) {
          const currentProviders = Object.fromEntries(
            Object.entries(current.success.providers).map(([id, provider]) => [
              id,
              provider.credential,
            ]),
          );
          if (
            serializePiAuthProviders(currentProviders) !==
            serializePiAuthProviders(decoded.success.providers)
          )
            return Result.fail(failure("invalid_authority", "Credential freshness conflict"));
          return Result.succeed(current.success);
        }
        const { refreshLease: _refreshLease, ...withoutLease } = current.success;
        const next: StoredCredential = {
          ...withoutLease,
          providers: storedProviders(
            decoded.success.providers,
            providerSentinelSeed,
            current.success,
          ),
          updatedAt: decoded.success.updatedAt,
        };
        await transaction.put(next);
        return Result.succeed(next);
      });
    }),
    require: transact(requireFrom),
    readForProxy: Effect.fnUntraced(function* (sentinel) {
      const decodedSentinel = decodeSentinel(sentinel, failure);
      if (Result.isFailure(decodedSentinel)) return null;
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(null);
        const decoded = decodeCurrent(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const credential = decoded.success;
        return Result.succeed(
          Object.values(credential.providers).some(
            (provider) => provider.sentinel === decodedSentinel.success,
          )
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
        const decoded = decodeCurrent(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const credential = decoded.success;
        const provider = credential.providers["openai-codex"];
        if (provider?.sentinel !== decodedSentinel.success || provider.credential.type !== "oauth")
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
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
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
        const provider = credential.providers["openai-codex"];
        if (provider?.sentinel !== decodedSentinel.success)
          return Result.fail(failure("sentinel_mismatch", "Credential sentinel mismatch"));
        if (credential.refreshLease?.nonce !== decodedNonce.success)
          return Result.fail(failure("lease_mismatch", "Credential refresh lease mismatch"));
        if (provider.credential.type !== "oauth")
          return Result.fail(failure("not_refreshable", "Credential is not refreshable"));
        const { refreshLease: _refreshLease, ...withoutLease } = credential;
        const next: StoredCredential = {
          ...withoutLease,
          providers: {
            ...credential.providers,
            "openai-codex": {
              ...provider,
              credential: {
                ...provider.credential,
                access: decodedPatch.success.accessToken ?? provider.credential.access,
                refresh: decodedPatch.success.refreshToken ?? provider.credential.refresh,
                expires:
                  decodedPatch.success.expiresInSeconds === undefined
                    ? provider.credential.expires
                    : nowMillis + decodedPatch.success.expiresInSeconds * 1_000,
                ...(decodedPatch.success.idToken === undefined
                  ? {}
                  : { idToken: decodedPatch.success.idToken }),
              },
            },
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
        const decoded = decodeCurrent(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const credential = decoded.success;
        if (
          credential.providers["openai-codex"]?.sentinel !== decodedSentinel.success ||
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

const validTimestamps = (credential: StoredCredential): boolean =>
  Number.isFinite(Date.parse(credential.updatedAt)) &&
  (credential.refreshLease === undefined ||
    Number.isFinite(Date.parse(credential.refreshLease.startedAt)));
