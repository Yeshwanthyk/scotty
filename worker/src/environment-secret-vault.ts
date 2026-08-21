import { Context, Data, Effect, Layer, Result, Schema } from "effect";
import {
  ENVIRONMENT_SECRET_SENTINEL_PREFIX,
  EnvironmentMaterializationSchema,
  EnvironmentNameSchema,
  EnvironmentOriginSchema,
  EnvironmentSecretSentinelSchema,
  SessionEnvironmentSnapshotSchema,
  EnvironmentSourceScopeSchema,
  EnvironmentValueSchema,
  type EnvironmentMaterialization,
  type EnvironmentSecretSentinel,
  type SessionEnvironmentSnapshot,
} from "./environment-contracts";
import { environmentNameIsMaterializable } from "./environment-policy";

export { ENVIRONMENT_SECRET_SENTINEL_PREFIX } from "./environment-contracts";

export const ENVIRONMENT_SECRET_VAULT_KEY = "scotty:environment-secrets:v1";

const EnvironmentSecretVaultEntrySchema = Schema.Struct({
  sentinel: EnvironmentSecretSentinelSchema,
  sourceScope: EnvironmentSourceScopeSchema,
  name: EnvironmentNameSchema,
  value: EnvironmentValueSchema,
});
type EnvironmentSecretVaultEntry = typeof EnvironmentSecretVaultEntrySchema.Type;

const EnvironmentSecretVaultStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(EnvironmentSecretSentinelSchema, EnvironmentSecretVaultEntrySchema),
});
type EnvironmentSecretVaultState = typeof EnvironmentSecretVaultStateSchema.Type;

export const EnvironmentProxyRequestSchema = Schema.Struct({
  origin: EnvironmentOriginSchema,
  sentinels: Schema.Array(EnvironmentSecretSentinelSchema).check(Schema.isNonEmpty()),
});
export type EnvironmentProxyRequest = typeof EnvironmentProxyRequestSchema.Type;

export const EnvironmentSecretResolveRequestSchema = Schema.Struct({
  sentinel: EnvironmentSecretSentinelSchema,
});
export type EnvironmentSecretResolveRequest = typeof EnvironmentSecretResolveRequestSchema.Type;

export const EnvironmentSecretResolutionSchema = Schema.Struct({
  sentinel: EnvironmentSecretSentinelSchema,
  value: EnvironmentValueSchema,
});
export type EnvironmentSecretResolutionResponse = typeof EnvironmentSecretResolutionSchema.Type;

export const EnvironmentProxyResponseSchema = Schema.Struct({
  authorized: Schema.Boolean,
  reason: Schema.Literals([
    "approved",
    "pending",
    "rejected",
    "revoked",
    "unknown_sentinel",
    "session_unavailable",
  ]),
  values: Schema.optionalKey(
    Schema.Record(EnvironmentSecretSentinelSchema, EnvironmentValueSchema),
  ),
});
export type EnvironmentProxyResponse = typeof EnvironmentProxyResponseSchema.Type;

export type EnvironmentSecretResolution = typeof EnvironmentSecretVaultEntrySchema.Type;

export type EnvironmentSecretVaultFailureReason =
  | "invalid_input"
  | "invalid_state"
  | "sentinel_mismatch"
  | "storage";

export class EnvironmentSecretVaultFailure extends Data.TaggedError(
  "EnvironmentSecretVaultFailure",
)<{
  readonly reason: EnvironmentSecretVaultFailureReason;
  readonly message: string;
}> {}

export interface EnvironmentSecretVaultTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (state: EnvironmentSecretVaultState) => Promise<void>;
}

export interface EnvironmentSecretVaultStorage {
  readonly transaction: <A>(
    operation: (transaction: EnvironmentSecretVaultTransaction) => Promise<A>,
  ) => Promise<A>;
  readonly delete: () => Promise<void>;
}

export interface EnvironmentSecretVaultShape {
  readonly reconcile: (
    materialization: unknown,
    sessionId: unknown,
    committedSnapshot?: unknown,
  ) => Effect.Effect<SessionEnvironmentSnapshot, EnvironmentSecretVaultFailure>;
  readonly commit: (snapshot: unknown) => Effect.Effect<void, EnvironmentSecretVaultFailure>;
  readonly replay: (
    snapshot: unknown,
  ) => Effect.Effect<SessionEnvironmentSnapshot, EnvironmentSecretVaultFailure>;
  readonly resolve: (
    sentinel: unknown,
  ) => Effect.Effect<EnvironmentSecretResolution | null, EnvironmentSecretVaultFailure>;
  readonly readForProxy: (
    sentinels: unknown,
  ) => Effect.Effect<
    ReadonlyArray<EnvironmentSecretResolution> | null,
    EnvironmentSecretVaultFailure
  >;
  readonly delete: Effect.Effect<void, EnvironmentSecretVaultFailure>;
}

export class EnvironmentSecretVault extends Context.Service<
  EnvironmentSecretVault,
  EnvironmentSecretVaultShape
>()("scotty/EnvironmentSecretVault") {}

export const durableObjectEnvironmentSecretVaultStorage = (
  storage: DurableObjectStorage,
): EnvironmentSecretVaultStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(ENVIRONMENT_SECRET_VAULT_KEY),
        put: (state) => transaction.put(ENVIRONMENT_SECRET_VAULT_KEY, state),
      }),
    ),
  delete: () => storage.delete(ENVIRONMENT_SECRET_VAULT_KEY).then(() => undefined),
});

export const environmentSecretVaultLayer = (
  storage: EnvironmentSecretVaultStorage,
): Layer.Layer<EnvironmentSecretVault> =>
  Layer.succeed(EnvironmentSecretVault)(makeEnvironmentSecretVault(storage));

const decodeState = Schema.decodeUnknownResult(EnvironmentSecretVaultStateSchema, {
  onExcessProperty: "error",
});
const decodeMaterialization = Schema.decodeUnknownResult(EnvironmentMaterializationSchema, {
  onExcessProperty: "error",
});
const decodeSnapshot = Schema.decodeUnknownResult(SessionEnvironmentSnapshotSchema, {
  onExcessProperty: "error",
});
const decodeSentinel = Schema.decodeUnknownResult(EnvironmentSecretSentinelSchema);
const decodeSentinels = Schema.decodeUnknownResult(
  Schema.Array(EnvironmentSecretSentinelSchema).check(Schema.isNonEmpty()),
  { onExcessProperty: "error" },
);

const decodeSessionId = Schema.decodeUnknownResult(
  Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{5,31}$/u)),
);
const randomHex = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const emptyState = (): EnvironmentSecretVaultState => ({ version: 1, entries: {} });

const identityKey = (sourceScope: string, name: string): string => `${sourceScope}\u0000${name}`;

const makeEnvironmentSecretVault = (
  storage: EnvironmentSecretVaultStorage,
): EnvironmentSecretVaultShape => {
  const randomSentinel = (sessionId: string): EnvironmentSecretSentinel =>
    `${ENVIRONMENT_SECRET_SENTINEL_PREFIX}${sessionId}-${randomHex()}` as EnvironmentSecretSentinel;
  const failure = (
    reason: EnvironmentSecretVaultFailureReason,
    message: string,
  ): EnvironmentSecretVaultFailure => new EnvironmentSecretVaultFailure({ reason, message });
  const invalidState = (): EnvironmentSecretVaultFailure =>
    failure("invalid_state", "Stored environment secret vault is invalid");
  const storageFailure = (): EnvironmentSecretVaultFailure =>
    failure("storage", "Environment secret vault operation failed");

  const parseState = (
    value: unknown | undefined,
  ): Result.Result<EnvironmentSecretVaultState, EnvironmentSecretVaultFailure> => {
    if (value === undefined) return Result.succeed(emptyState());
    const decoded = Result.mapError(decodeState(value), invalidState);
    if (Result.isFailure(decoded)) return decoded;
    for (const [key, entry] of Object.entries(decoded.success.entries)) {
      if (key !== entry.sentinel || !environmentNameIsMaterializable(entry.name)) {
        return Result.fail(invalidState());
      }
    }
    return decoded;
  };

  const transact = <A>(
    operation: (
      state: EnvironmentSecretVaultState,
      transaction: EnvironmentSecretVaultTransaction,
    ) => Promise<Result.Result<A, EnvironmentSecretVaultFailure>>,
  ): Effect.Effect<A, EnvironmentSecretVaultFailure> =>
    Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const state = parseState(await transaction.get());
          if (Result.isFailure(state)) return Result.fail(state.failure);
          return operation(state.success, transaction);
        }),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  const parseMaterialization = (
    value: unknown,
  ): Result.Result<EnvironmentMaterialization, EnvironmentSecretVaultFailure> => {
    const decoded = Result.mapError(decodeMaterialization(value), () =>
      failure("invalid_input", "Environment materialization is invalid"),
    );
    if (Result.isFailure(decoded)) return decoded;
    for (const [name, variable] of Object.entries(decoded.success.variables)) {
      if (
        !environmentNameIsMaterializable(name) ||
        (name === "GH_TOKEN" &&
          (variable.sourceScope !== "global" ||
            variable.secret !== true ||
            variable.value.trim().length === 0)) ||
        (!variable.secret && variable.value.startsWith(ENVIRONMENT_SECRET_SENTINEL_PREFIX))
      )
        return Result.fail(failure("invalid_input", "Environment materialization is invalid"));
    }
    return decoded;
  };

  const parseSnapshot = (
    value: unknown,
  ): Result.Result<SessionEnvironmentSnapshot, EnvironmentSecretVaultFailure> =>
    Result.mapError(decodeSnapshot(value), () =>
      failure("invalid_input", "Environment snapshot is invalid"),
    );

  return EnvironmentSecretVault.of({
    reconcile: Effect.fnUntraced(
      function* (materializationValue, sessionIdValue, committedSnapshotValue) {
        const materialization = yield* Effect.fromResult(
          parseMaterialization(materializationValue),
        );
        const sessionId = yield* Effect.fromResult(
          Result.mapError(decodeSessionId(sessionIdValue), () =>
            failure("invalid_input", "Environment session identity is invalid"),
          ),
        );
        const committedSnapshot =
          committedSnapshotValue === undefined
            ? undefined
            : yield* Effect.fromResult(parseSnapshot(committedSnapshotValue));
        return yield* transact(async (state, transaction) => {
          for (const value of Object.values(committedSnapshot?.variables ?? {})) {
            if (
              value.startsWith(ENVIRONMENT_SECRET_SENTINEL_PREFIX) &&
              !Object.hasOwn(state.entries, value)
            )
              return Result.fail(
                failure("sentinel_mismatch", "Committed environment sentinel is unavailable"),
              );
          }
          const previousByIdentity = new Map<string, EnvironmentSecretVaultEntry>();
          for (const entry of Object.values(state.entries))
            previousByIdentity.set(identityKey(entry.sourceScope, entry.name), entry);

          const nextEntries: Record<string, EnvironmentSecretVaultEntry> = {
            ...state.entries,
          };
          const variables: Record<string, string> = {};
          for (const [name, variable] of Object.entries(materialization.variables)) {
            if (!variable.secret) {
              variables[name] = variable.value;
              continue;
            }
            const key = identityKey(variable.sourceScope, name);
            const previous = previousByIdentity.get(key);
            let sentinel: EnvironmentSecretSentinel;
            if (previous !== undefined && previous.value === variable.value) {
              // The entry is already in nextEntries; checking it for a collision would rotate
              // an unchanged secret on every reconciliation.
              sentinel = previous.sentinel;
            } else {
              sentinel = randomSentinel(sessionId);
              while (Object.hasOwn(nextEntries, sentinel)) sentinel = randomSentinel(sessionId);
            }
            const entry: EnvironmentSecretVaultEntry = {
              sentinel,
              sourceScope: variable.sourceScope,
              name,
              value: variable.value,
            };
            nextEntries[sentinel] = entry;
            variables[name] = sentinel;
          }
          const nextState: EnvironmentSecretVaultState = { version: 1, entries: nextEntries };
          const snapshot = decodeSnapshot({
            version: 1,
            revision: materialization.revision,
            variables,
          });
          if (Result.isFailure(snapshot)) return Result.fail(invalidState());
          await transaction.put(nextState);
          return Result.succeed(snapshot.success);
        });
      },
    ),
    commit: Effect.fnUntraced(function* (snapshotValue) {
      const snapshot = yield* Effect.fromResult(parseSnapshot(snapshotValue));
      return yield* transact(async (state, transaction) => {
        const committedEntries: Record<string, EnvironmentSecretVaultEntry> = {};
        for (const value of Object.values(snapshot.variables)) {
          if (!value.startsWith(ENVIRONMENT_SECRET_SENTINEL_PREFIX)) continue;
          const decoded = decodeSentinel(value);
          if (Result.isFailure(decoded) || !Object.hasOwn(state.entries, decoded.success))
            return Result.fail(
              failure("sentinel_mismatch", "Environment snapshot sentinel is unavailable"),
            );
          committedEntries[decoded.success] = state.entries[decoded.success]!;
        }
        await transaction.put({ version: 1, entries: committedEntries });
        return Result.succeed(undefined);
      });
    }),
    replay: Effect.fnUntraced(function* (snapshotValue) {
      const snapshot = yield* Effect.fromResult(parseSnapshot(snapshotValue));
      return yield* transact(async (state) => {
        for (const value of Object.values(snapshot.variables)) {
          if (!value.startsWith(ENVIRONMENT_SECRET_SENTINEL_PREFIX)) continue;
          const decoded = decodeSentinel(value);
          if (Result.isFailure(decoded))
            return Result.fail(
              failure("sentinel_mismatch", "Environment snapshot sentinel is unavailable"),
            );
          if (!Object.hasOwn(state.entries, decoded.success))
            return Result.fail(
              failure("sentinel_mismatch", "Environment snapshot sentinel is unavailable"),
            );
        }
        return Result.succeed(snapshot);
      });
    }),
    resolve: Effect.fnUntraced(function* (sentinelValue) {
      const decoded = yield* Effect.fromResult(
        Result.mapError(decodeSentinel(sentinelValue), () =>
          failure("invalid_input", "Environment sentinel is invalid"),
        ),
      );
      return yield* transact(async (state) => {
        const entry = state.entries[decoded];
        if (entry === undefined) return Result.succeed(null);
        return Result.succeed({
          sentinel: entry.sentinel,
          sourceScope: entry.sourceScope,
          name: entry.name,
          value: entry.value,
        });
      });
    }),
    readForProxy: Effect.fnUntraced(function* (sentinelsValue) {
      const sentinels = yield* Effect.fromResult(
        Result.mapError(decodeSentinels(sentinelsValue), () =>
          failure("invalid_input", "Environment sentinel list is invalid"),
        ),
      );
      return yield* transact(async (state) => {
        const resolutions: EnvironmentSecretResolution[] = [];
        for (const sentinel of new Set(sentinels)) {
          const entry = state.entries[sentinel];
          if (entry === undefined) return Result.succeed(null);
          resolutions.push({
            sentinel,
            sourceScope: entry.sourceScope,
            name: entry.name,
            value: entry.value,
          });
        }
        return Result.succeed(resolutions);
      });
    }),
    delete: Effect.tryPromise({
      try: () => storage.delete(),
      catch: storageFailure,
    }),
  });
};

export { makeEnvironmentSecretVault };
