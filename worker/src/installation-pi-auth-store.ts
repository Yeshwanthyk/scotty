import { Context, Data, Effect, Layer, Result, Schema } from "effect";
import {
  InstallationPiAuthRecordSchema,
  canonicalPiAuthProviders,
  digestPiAuthProviders,
  type InstallationPiAuthRecord,
} from "../../protocol/pi-auth";

import { INSTALLATION_PI_AUTH_KEY } from "./sandbox-config-store";

export type InstallationPiAuthFailureReason =
  | "conflict"
  | "invalid_authority"
  | "invalid_input"
  | "stale"
  | "storage";

export class InstallationPiAuthFailure extends Data.TaggedError("InstallationPiAuthFailure")<{
  readonly reason: InstallationPiAuthFailureReason;
  readonly message: string;
}> {}

export interface InstallationPiAuthTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (record: InstallationPiAuthRecord) => Promise<void>;
}

export interface InstallationPiAuthStorage {
  readonly transaction: <A>(
    operation: (transaction: InstallationPiAuthTransaction) => Promise<A>,
  ) => Promise<A>;
}

export interface InstallationPiAuthStoreShape {
  readonly read: Effect.Effect<InstallationPiAuthRecord | null, InstallationPiAuthFailure>;
  readonly write: (
    input: unknown,
  ) => Effect.Effect<InstallationPiAuthRecord, InstallationPiAuthFailure>;
}

export class InstallationPiAuthStore extends Context.Service<
  InstallationPiAuthStore,
  InstallationPiAuthStoreShape
>()("scotty/InstallationPiAuthStore") {}

export const durableObjectInstallationPiAuthStorage = (
  storage: DurableObjectStorage,
): InstallationPiAuthStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(INSTALLATION_PI_AUTH_KEY),
        put: (record) => transaction.put(INSTALLATION_PI_AUTH_KEY, record),
      }),
    ),
});

const decodeRecord = Schema.decodeUnknownResult(InstallationPiAuthRecordSchema, {
  onExcessProperty: "error",
});

export const installationPiAuthStoreLayer = (
  storage: InstallationPiAuthStorage,
): Layer.Layer<InstallationPiAuthStore> =>
  Layer.succeed(InstallationPiAuthStore)(makeInstallationPiAuthStore(storage));

export const makeInstallationPiAuthStore = (
  storage: InstallationPiAuthStorage,
): InstallationPiAuthStoreShape => {
  const failure = (
    reason: InstallationPiAuthFailureReason,
    message: string,
  ): InstallationPiAuthFailure => new InstallationPiAuthFailure({ reason, message });
  const storageFailure = (): InstallationPiAuthFailure =>
    failure("storage", "Installation Pi credential storage operation failed");
  const parseStored = async (
    value: unknown | undefined,
  ): Promise<Result.Result<InstallationPiAuthRecord | null, InstallationPiAuthFailure>> => {
    if (value === undefined) return Result.succeed(null);
    const decoded = decodeRecord(value);
    if (Result.isFailure(decoded))
      return Result.fail(
        failure("invalid_authority", "Stored installation Pi credential is invalid"),
      );
    const canonical: InstallationPiAuthRecord = {
      ...decoded.success,
      providers: canonicalPiAuthProviders(decoded.success.providers),
    };
    const digest = await digestPiAuthProviders(canonical.providers);
    return digest === canonical.digest
      ? Result.succeed(canonical)
      : Result.fail(failure("invalid_authority", "Stored installation Pi credential is invalid"));
  };
  const transact = <A>(
    operation: (
      transaction: InstallationPiAuthTransaction,
    ) => Promise<Result.Result<A, InstallationPiAuthFailure>>,
  ): Effect.Effect<A, InstallationPiAuthFailure> =>
    Effect.tryPromise({
      try: () => storage.transaction(operation),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  return InstallationPiAuthStore.of({
    read: transact(async (transaction) => await parseStored(await transaction.get())),
    write: (input) => {
      const decoded = decodeRecord(input);
      if (Result.isFailure(decoded))
        return Effect.fail(failure("invalid_input", "Installation Pi credential input is invalid"));
      const incoming: InstallationPiAuthRecord = {
        ...decoded.success,
        providers: canonicalPiAuthProviders(decoded.success.providers),
      };
      return Effect.tryPromise({
        try: () => digestPiAuthProviders(incoming.providers),
        catch: () => failure("invalid_input", "Installation Pi credential input is invalid"),
      }).pipe(
        Effect.flatMap((digest) => {
          if (digest !== incoming.digest)
            return Effect.fail(
              failure("invalid_input", "Installation Pi credential input is invalid"),
            );
          return transact(async (transaction) => {
            const current = await parseStored(await transaction.get());
            if (Result.isFailure(current)) return Result.fail(current.failure);
            if (current.success !== null) {
              const comparison = incoming.updatedAt.localeCompare(current.success.updatedAt);
              if (comparison < 0)
                return Result.fail(
                  failure("stale", "Installation Pi credential input is older than authority"),
                );
              if (comparison === 0) {
                if (incoming.digest !== current.success.digest)
                  return Result.fail(
                    failure("conflict", "Installation Pi credential timestamp conflicts"),
                  );
                return Result.succeed(current.success);
              }
            }
            await transaction.put(incoming);
            return Result.succeed(incoming);
          });
        }),
      );
    },
  });
};
