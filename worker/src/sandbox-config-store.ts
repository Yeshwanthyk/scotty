import { Context, Data, Effect, Layer, Result, Schema } from "effect";
import {
  SandboxActivateInputSchema,
  SandboxConfigAuthoritySchema,
  type SandboxActivateInput,
  type SandboxConfigAuthority,
  type SandboxConfigStatus,
} from "./sandbox-config-contracts";

const AUTHORITY_KEY = "scotty:sandbox-config:1";
export const INSTALLATION_PI_AUTH_KEY = "scotty:installation-pi-auth:1";

export type SandboxConfigFailureReason =
  | "conflict"
  | "invalid_authority"
  | "invalid_input"
  | "storage";

export class SandboxConfigFailure extends Data.TaggedError("SandboxConfigFailure")<{
  readonly reason: SandboxConfigFailureReason;
  readonly message: string;
}> {}

export interface SandboxConfigAuthorityTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (authority: SandboxConfigAuthority) => Promise<void>;
}

export interface SandboxConfigAuthorityStorage {
  readonly transaction: <A>(
    operation: (transaction: SandboxConfigAuthorityTransaction) => Promise<A>,
  ) => Promise<A>;
}

interface SandboxConfigStoreShape {
  readonly status: () => Effect.Effect<SandboxConfigStatus, SandboxConfigFailure>;
  readonly activate: (
    input: SandboxActivateInput,
  ) => Effect.Effect<SandboxConfigStatus, SandboxConfigFailure>;
}

export class SandboxConfigStore extends Context.Service<
  SandboxConfigStore,
  SandboxConfigStoreShape
>()("scotty/SandboxConfigStore") {}

export const durableObjectSandboxConfigAuthorityStorage = (
  storage: DurableObjectStorage,
): SandboxConfigAuthorityStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(AUTHORITY_KEY),
        put: (authority) => transaction.put(AUTHORITY_KEY, authority),
      }),
    ),
});

export const sandboxConfigStoreLayer = (
  storage: SandboxConfigAuthorityStorage,
): Layer.Layer<SandboxConfigStore> =>
  Layer.succeed(SandboxConfigStore)(makeSandboxConfigStore(storage));

const decodeAuthority = Schema.decodeUnknownResult(SandboxConfigAuthoritySchema, {
  onExcessProperty: "error",
});
const decodeActivateInput = Schema.decodeUnknownResult(SandboxActivateInputSchema, {
  onExcessProperty: "error",
});

const emptyAuthority = (): SandboxConfigAuthority => ({
  version: 1,
  revision: 0,
  activeDigest: null,
  lastSync: null,
});

const makeSandboxConfigStore = (
  storage: SandboxConfigAuthorityStorage,
): SandboxConfigStoreShape => {
  const failure = (reason: SandboxConfigFailureReason, message: string): SandboxConfigFailure =>
    new SandboxConfigFailure({ reason, message });
  const invalidAuthority = (): SandboxConfigFailure =>
    failure("invalid_authority", "Stored sandbox configuration authority is invalid");
  const invalidInput = (): SandboxConfigFailure =>
    failure("invalid_input", "Sandbox bundle activation input is invalid");
  const storageFailure = (): SandboxConfigFailure =>
    failure("storage", "Sandbox configuration storage operation failed");
  const revisionConflict = (): SandboxConfigFailure =>
    failure("conflict", "Sandbox configuration revision conflict");
  const idempotencyConflict = (): SandboxConfigFailure =>
    failure("conflict", "Idempotency key was reused with different sandbox bundle input");

  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<SandboxConfigAuthority, SandboxConfigFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    const decoded = decodeAuthority(value);
    return Result.isSuccess(decoded)
      ? Result.succeed(decoded.success)
      : Result.fail(invalidAuthority());
  };

  const toStatus = (authority: SandboxConfigAuthority): SandboxConfigStatus => ({
    schemaVersion: authority.version,
    revision: authority.revision,
    activeDigest: authority.activeDigest,
  });

  const transact = <A>(
    operation: (
      authority: SandboxConfigAuthority,
    ) => Promise<
      Result.Result<
        { readonly value: A; readonly authority: SandboxConfigAuthority },
        SandboxConfigFailure
      >
    >,
  ): Effect.Effect<A, SandboxConfigFailure> =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const authority = parseAuthority(await transaction.get());
          if (Result.isFailure(authority)) return Result.fail(authority.failure);
          const result = await operation(authority.success);
          if (Result.isFailure(result)) return Result.fail(result.failure);
          const encoded = decodeAuthority(result.success.authority);
          if (Result.isFailure(encoded)) return Result.fail(invalidAuthority());
          await transaction.put(result.success.authority);
          return Result.succeed(result.success.value);
        }),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  return SandboxConfigStore.of({
    status: () =>
      transact(async (authority) => Result.succeed({ value: toStatus(authority), authority })),

    activate: (inputValue) =>
      Effect.gen(function* () {
        const decoded = Result.mapError(decodeActivateInput(inputValue), invalidInput);
        if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
        const input = decoded.success;
        return yield* transact(async (authority) => {
          const replay = authority.lastSync;
          if (replay !== null && replay.idempotencyKey === input.idempotencyKey) {
            if (
              replay.digest === input.digest &&
              replay.expectedRevision === input.expectedRevision
            )
              return Result.succeed({ value: replay.status, authority });
            return Result.fail(idempotencyConflict());
          }
          if (authority.activeDigest === input.digest)
            return Result.succeed({ value: toStatus(authority), authority });
          if (input.expectedRevision !== null && input.expectedRevision !== authority.revision)
            return Result.fail(revisionConflict());
          const status: SandboxConfigStatus = {
            schemaVersion: 1,
            revision: authority.revision + 1,
            activeDigest: input.digest,
          };
          const next: SandboxConfigAuthority = {
            version: 1,
            revision: status.revision,
            activeDigest: status.activeDigest,
            lastSync: {
              idempotencyKey: input.idempotencyKey,
              digest: input.digest,
              expectedRevision: input.expectedRevision,
              status,
            },
          };
          return Result.succeed({ value: status, authority: next });
        });
      }),
  });
};
