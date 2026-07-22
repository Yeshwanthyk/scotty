import { Clock, Context, Effect, Layer, Result } from "effect";
import {
  conflict,
  decodeSessionRecordResult,
  notFound,
  ScottyError,
  wrongState,
  type OperationKind,
  type SessionRecord,
  type SessionStatus,
} from "./contracts";

const RECORD_KEY = "scotty:session";
const INVALID_RECORD = new ScottyError("internal", "Authoritative session record is invalid", {
  httpStatus: 500,
  exitCode: 1,
});

export interface SessionRecordTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (record: SessionRecord) => Promise<void>;
}

export interface SessionRecordStorage {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (record: SessionRecord) => Promise<void>;
  readonly transaction: <A>(
    operation: (transaction: SessionRecordTransaction) => Promise<A>,
  ) => Promise<A>;
}

type SessionOperation = NonNullable<SessionRecord["operation"]>;

interface SessionStoreShape {
  readonly requireRecord: Effect.Effect<SessionRecord, ScottyError>;
  readonly put: (record: SessionRecord) => Effect.Effect<void, ScottyError>;
  readonly acquireOperation: (
    kind: OperationKind,
    allowed: ReadonlyArray<SessionStatus>,
    nonce: string,
  ) => Effect.Effect<SessionOperation, ScottyError>;
  readonly updateForOperation: (
    nonce: string,
    update: (record: SessionRecord) => SessionRecord,
  ) => Effect.Effect<SessionRecord, ScottyError>;
  readonly releaseOperation: (nonce: string) => Effect.Effect<SessionRecord, ScottyError>;
  readonly releaseOperationIfHeld: (
    nonce: string,
  ) => Effect.Effect<SessionRecord | undefined, ScottyError>;
  readonly failOperation: (
    nonce: string,
    code: string,
    message: string,
    recoverable: boolean,
  ) => Effect.Effect<SessionRecord, ScottyError>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "scotty/SessionStore",
) {}

export const durableObjectSessionRecordStorage = (
  storage: DurableObjectStorage,
): SessionRecordStorage => ({
  get: () => storage.get(RECORD_KEY),
  put: (record) => storage.put(RECORD_KEY, record),
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(RECORD_KEY),
        put: (record) => transaction.put(RECORD_KEY, record),
      }),
    ),
});

export const sessionStoreLayer = (storage: SessionRecordStorage): Layer.Layer<SessionStore> =>
  Layer.succeed(SessionStore)(makeSessionStore(storage));

const makeSessionStore = (storage: SessionRecordStorage): SessionStoreShape => {
  const storageFailure = (): ScottyError =>
    new ScottyError("internal", "Authoritative session storage operation failed", {
      httpStatus: 500,
      exitCode: 1,
    });

  const decode = (value: unknown): Result.Result<SessionRecord, ScottyError> =>
    Result.mapError(decodeSessionRecordResult(value), () => INVALID_RECORD);

  const read = Effect.fnUntraced(function* () {
    const value = yield* Effect.tryPromise({
      try: () => storage.get(),
      catch: storageFailure,
    });
    if (value === undefined) return undefined;
    return yield* Effect.fromResult(decode(value));
  });

  const requireRecord = Effect.fnUntraced(function* () {
    const record = yield* read();
    if (record === undefined) return yield* notFound("unknown");
    if (record.status === "gone") return yield* notFound(record.id);
    return record;
  });

  const put = (record: SessionRecord): Effect.Effect<void, ScottyError> =>
    Effect.tryPromise({
      try: () => storage.put(record),
      catch: storageFailure,
    });

  const transact = <A>(
    operation: (transaction: SessionRecordTransaction) => Promise<Result.Result<A, ScottyError>>,
  ): Effect.Effect<A, ScottyError> =>
    Effect.tryPromise({
      try: () => storage.transaction(operation),
      catch: storageFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));

  const updateForOperation = Effect.fnUntraced(function* (
    nonce: string,
    update: (record: SessionRecord) => SessionRecord,
  ) {
    return yield* transact(async (transaction) => {
      const stored = await transaction.get();
      if (stored === undefined) return Result.fail(notFound("unknown"));
      const decoded = decode(stored);
      if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
      const current = decoded.success;
      if (current.operation?.nonce !== nonce)
        return Result.fail(conflict("Session operation lease changed"));
      const next = update(current);
      await transaction.put(next);
      return Result.succeed(next);
    });
  });

  const releaseOperation = Effect.fnUntraced(function* (nonce: string) {
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* updateForOperation(nonce, (record) => ({
      ...record,
      operation: null,
      updatedAt: now,
    }));
  });

  return SessionStore.of({
    requireRecord: requireRecord(),
    put,
    acquireOperation: Effect.fnUntraced(function* (kind, allowed, nonce) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.fail(notFound("unknown"));
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const record = decoded.success;
        if (!allowed.includes(record.status)) return Result.fail(wrongState(record.status, kind));
        if (record.operation)
          return Result.fail(conflict(`Session is already running ${record.operation.kind}`));
        const operation = { kind, nonce, startedAt: now };
        await transaction.put({ ...record, operation, updatedAt: now });
        return Result.succeed(operation);
      });
    }),
    updateForOperation,
    releaseOperation,
    releaseOperationIfHeld: Effect.fnUntraced(function* (nonce) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.fail(notFound("unknown"));
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const record = decoded.success;
        if (record.operation?.nonce !== nonce) return Result.succeed(undefined);
        const next = { ...record, operation: null, updatedAt: now };
        await transaction.put(next);
        return Result.succeed(next);
      });
    }),
    failOperation: Effect.fnUntraced(function* (nonce, code, message, recoverable) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* updateForOperation(nonce, (record) => ({
        ...record,
        status: "failed",
        operation: null,
        failure: { code, message, recoverable: recoverable && Boolean(record.backup?.current) },
        updatedAt: now,
      }));
    }),
  });
};
