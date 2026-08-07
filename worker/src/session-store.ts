import { Clock, Context, Data, Effect, Layer, Option, Result } from "effect";
import {
  conflict,
  decodeSessionRecordResult,
  hasCommittedManagedStop,
  notFound,
  ScottyError,
  wrongState,
  type OperationKind,
  type AgentActivityState,
  type SessionRecord,
  type SessionStatus,
} from "./contracts";
import {
  decideIdempotentCreate,
  decodeCreateIdempotencyMetadata,
  type CreateIdempotencyDecision,
  type CreateIdempotencyMetadata,
} from "./create-idempotency";
import { hardCapObservationIsCurrent } from "./session-lifecycle";

const RECORD_KEY = "scotty:session";
export const EVIDENCE_RECORD_KEY = "scotty:evidence:v1";
export const SESSION_CONTROL_REVISION_KEY = "scotty:session-control-revision";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const INVALID_RECORD = new ScottyError("internal", "Authoritative session record is invalid", {
  httpStatus: 500,
  exitCode: 1,
});

class SessionControlRevisionFailure extends Data.TaggedError("SessionControlRevisionFailure")<{
  readonly reason: "invalid" | "exhausted";
}> {}

export interface SessionControlAuthority {
  readonly record: SessionRecord;
  readonly revision: number;
}

export interface SessionControlGate {
  readonly run: <A>(operation: () => Promise<A>) => Promise<A>;
}

export const makeSessionControlGate = (): SessionControlGate => {
  let tail: Promise<void> = Promise.resolve();
  return {
    run: async <A>(operation: () => Promise<A>): Promise<A> => {
      const preceding = tail;
      let release = (): void => undefined;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await preceding;
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: the Promise mutex must release on both fulfillment and rejection
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
};

export interface SessionRecordTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (record: SessionRecord) => Promise<void>;
}

export interface SessionEvidenceTransaction {
  readonly getRecord: () => Promise<unknown | undefined>;
  readonly getEvidence: () => Promise<unknown | undefined>;
  readonly putRecord: (record: SessionRecord) => Promise<void>;
  readonly putEvidence: (evidence: unknown) => Promise<void>;
  readonly deleteEvidence: () => Promise<void>;
}

export interface InitialSessionTransaction {
  readonly getRecord: () => Promise<unknown | undefined>;
  readonly getCreateIdempotency: () => Promise<unknown | undefined>;
  readonly putRecord: (record: SessionRecord) => Promise<void>;
  readonly putCreateIdempotency: (metadata: CreateIdempotencyMetadata) => Promise<void>;
  readonly deleteCreateIdempotency: () => Promise<void>;
}

export interface SessionRecordStorage {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (record: SessionRecord) => Promise<void>;
  readonly deleteCreateIdempotency?: () => Promise<void>;
  readonly transaction: <A>(
    operation: (transaction: SessionRecordTransaction) => Promise<A>,
  ) => Promise<A>;
  readonly initialSessionTransaction?: <A>(
    operation: (transaction: InitialSessionTransaction) => Promise<A>,
  ) => Promise<A>;
  readonly getEvidence?: () => Promise<unknown | undefined>;
  readonly evidenceTransaction?: <A>(
    operation: (transaction: SessionEvidenceTransaction) => Promise<A>,
  ) => Promise<A>;
  readonly readControlAuthority?: () => Promise<
    Result.Result<SessionControlAuthority | undefined, ScottyError>
  >;
  readonly getInitialRecord?: () => Promise<unknown | undefined>;
  readonly getCreateIdempotency?: () => Promise<unknown | undefined>;
}

type SessionOperation = NonNullable<SessionRecord["operation"]>;
type InitialSessionDecision = Exclude<CreateIdempotencyDecision, { readonly kind: "conflict" }>;

export class InitialSessionStorageFailure extends Data.TaggedError("InitialSessionStorageFailure")<{
  readonly cause: unknown;
}> {}

interface SessionStoreShape {
  readonly read: Effect.Effect<Option.Option<SessionRecord>, ScottyError>;
  readonly requireRecord: Effect.Effect<SessionRecord, ScottyError>;
  readonly readControlAuthority: Effect.Effect<SessionControlAuthority, ScottyError>;
  readonly put: (record: SessionRecord) => Effect.Effect<void, ScottyError>;
  readonly clearCreateIdempotency: Effect.Effect<void, ScottyError>;
  readonly inspectInitial: (
    record: SessionRecord,
    idempotency: CreateIdempotencyMetadata | undefined,
  ) => Effect.Effect<InitialSessionDecision, ScottyError | InitialSessionStorageFailure>;
  readonly createInitial: (
    record: SessionRecord,
    idempotency: CreateIdempotencyMetadata | undefined,
  ) => Effect.Effect<InitialSessionDecision, ScottyError | InitialSessionStorageFailure>;
  readonly acquireOperation: (
    kind: OperationKind,
    allowed: ReadonlyArray<SessionStatus>,
    nonce: string,
    replaceOperationOlderThanMs?: number,
  ) => Effect.Effect<SessionOperation, ScottyError>;
  readonly updateForOperation: (
    nonce: string,
    update: (record: SessionRecord) => SessionRecord,
  ) => Effect.Effect<SessionRecord, ScottyError>;
  readonly updateAgentActivity: (
    expectedLastEventAt: string | undefined,
    state: AgentActivityState,
  ) => Effect.Effect<Option.Option<SessionRecord>, ScottyError>;
  readonly rename: (title: string) => Effect.Effect<SessionRecord, ScottyError>;
  readonly releaseOperation: (nonce: string) => Effect.Effect<SessionRecord, ScottyError>;
  readonly releaseOperationIfHeld: (
    nonce: string,
  ) => Effect.Effect<SessionRecord | undefined, ScottyError>;
  readonly markHardCapFailure: (
    observed: SessionRecord,
    message: string,
  ) => Effect.Effect<Option.Option<SessionRecord>, ScottyError>;
  readonly recordRuntimeStop: Effect.Effect<Option.Option<SessionRecord>, ScottyError>;
  readonly claimManagedStopRollback: (nonce: string) => Effect.Effect<boolean, ScottyError>;
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

const decodeControlRevision = (
  revision: unknown,
): Result.Result<number, SessionControlRevisionFailure> => {
  if (revision === undefined) return Result.succeed(0);
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    return Result.fail(new SessionControlRevisionFailure({ reason: "invalid" }));
  return Result.succeed(revision);
};

const readControlRevision = async (transaction: DurableObjectTransaction): Promise<number> => {
  const decoded = decodeControlRevision(
    await transaction.get<unknown>(SESSION_CONTROL_REVISION_KEY),
  );
  if (Result.isFailure(decoded)) {
    // oxlint-disable-next-line scotty/no-promise-reject -- boundary: the native Durable Object transaction must abort without committing a malformed authority revision
    return Promise.reject(decoded.failure);
  }
  return decoded.success;
};

const readDurableObjectSessionControlAuthority = (
  storage: DurableObjectStorage,
): Promise<Result.Result<SessionControlAuthority | undefined, ScottyError>> =>
  storage.transaction(async (transaction) => {
    const [stored, storedRevision] = await Promise.all([
      transaction.get<unknown>(RECORD_KEY),
      transaction.get<unknown>(SESSION_CONTROL_REVISION_KEY),
    ]);
    if (stored === undefined) return Result.succeed(undefined);
    const decoded = decodeSessionRecordResult(stored);
    const revision = decodeControlRevision(storedRevision);
    if (Result.isFailure(decoded) || Result.isFailure(revision)) return Result.fail(INVALID_RECORD);
    return Result.succeed({ record: decoded.success, revision: revision.success });
  });

const writeRecordWithNextControlRevision = async (
  transaction: DurableObjectTransaction,
  record: SessionRecord,
): Promise<void> => {
  const revision = await readControlRevision(transaction);
  if (revision === Number.MAX_SAFE_INTEGER) {
    // oxlint-disable-next-line scotty/no-promise-reject -- boundary: the native Durable Object transaction must abort rather than wrap an exhausted revision
    return Promise.reject(new SessionControlRevisionFailure({ reason: "exhausted" }));
  }
  await Promise.all([
    transaction.put(RECORD_KEY, record),
    transaction.put(SESSION_CONTROL_REVISION_KEY, revision + 1),
  ]);
};

export const durableObjectSessionRecordStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): SessionRecordStorage => ({
  get: () => storage.get(RECORD_KEY),
  put: (record) =>
    controlGate.run(() =>
      storage.transaction((transaction) => writeRecordWithNextControlRevision(transaction, record)),
    ),
  deleteCreateIdempotency: () => storage.delete(CREATE_IDEMPOTENCY_KEY).then(() => undefined),
  transaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          get: () => transaction.get(RECORD_KEY),
          put: (record) => writeRecordWithNextControlRevision(transaction, record),
        }),
      ),
    ),
  readControlAuthority: () => readDurableObjectSessionControlAuthority(storage),
  getInitialRecord: () => storage.get(RECORD_KEY),
  getCreateIdempotency: () => storage.get(CREATE_IDEMPOTENCY_KEY),
  getEvidence: () => storage.get(EVIDENCE_RECORD_KEY),
  evidenceTransaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          getRecord: () => transaction.get(RECORD_KEY),
          getEvidence: () => transaction.get(EVIDENCE_RECORD_KEY),
          putRecord: (record) => writeRecordWithNextControlRevision(transaction, record),
          putEvidence: (evidence) => transaction.put(EVIDENCE_RECORD_KEY, evidence),
          deleteEvidence: () => transaction.delete(EVIDENCE_RECORD_KEY).then(() => undefined),
        }),
      ),
    ),
  initialSessionTransaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          getRecord: () => transaction.get(RECORD_KEY),
          getCreateIdempotency: () => transaction.get(CREATE_IDEMPOTENCY_KEY),
          putRecord: (record) => writeRecordWithNextControlRevision(transaction, record),
          putCreateIdempotency: (metadata) => transaction.put(CREATE_IDEMPOTENCY_KEY, metadata),
          deleteCreateIdempotency: () =>
            transaction.delete(CREATE_IDEMPOTENCY_KEY).then(() => undefined),
        }),
      ),
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
    if (value === undefined) return Option.none<SessionRecord>();
    return Option.some(yield* Effect.fromResult(decode(value)));
  });

  const requireRecord = Effect.fnUntraced(function* () {
    const stored = yield* read();
    if (Option.isNone(stored)) return yield* notFound("unknown");
    const record = stored.value;
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

  const decideInitial = (
    storedRecord: unknown | undefined,
    storedIdempotency: unknown,
    record: SessionRecord,
    idempotency: CreateIdempotencyMetadata | undefined,
  ): Result.Result<InitialSessionDecision, ScottyError> => {
    let existing: SessionRecord | undefined;
    if (storedRecord !== undefined) {
      const decoded = decode(storedRecord);
      if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
      existing = decoded.success;
    }
    const decodedIdempotency = decodeCreateIdempotencyMetadata(storedIdempotency);
    const decision = decideIdempotentCreate(existing, decodedIdempotency, idempotency);
    return decision.kind === "conflict"
      ? Result.fail(conflict(`Session ${record.id} already exists`))
      : Result.succeed(decision);
  };

  const initialTransaction = <A>(
    operation: (transaction: InitialSessionTransaction) => Promise<Result.Result<A, ScottyError>>,
  ): Effect.Effect<A, ScottyError | InitialSessionStorageFailure> => {
    const transaction = storage.initialSessionTransaction;
    if (transaction === undefined)
      return Effect.fail(new InitialSessionStorageFailure({ cause: storageFailure() }));
    return Effect.tryPromise({
      try: () => transaction(operation),
      catch: (cause) => new InitialSessionStorageFailure({ cause }),
    }).pipe(Effect.flatMap(Effect.fromResult));
  };

  return SessionStore.of({
    read: read(),
    requireRecord: requireRecord(),
    readControlAuthority:
      storage.readControlAuthority === undefined
        ? Effect.fail(storageFailure())
        : Effect.tryPromise({
            try: storage.readControlAuthority,
            catch: storageFailure,
          }).pipe(
            Effect.flatMap(Effect.fromResult),
            Effect.flatMap((authority) =>
              authority === undefined
                ? Effect.fail(notFound("unknown"))
                : Effect.succeed(authority),
            ),
          ),
    put,
    clearCreateIdempotency:
      storage.deleteCreateIdempotency === undefined
        ? Effect.fail(storageFailure())
        : Effect.tryPromise({
            try: storage.deleteCreateIdempotency,
            catch: storageFailure,
          }),
    inspectInitial: (record, idempotency) => {
      const getRecord = storage.getInitialRecord;
      const getIdempotency = storage.getCreateIdempotency;
      if (getRecord === undefined || getIdempotency === undefined)
        return Effect.fail(new InitialSessionStorageFailure({ cause: storageFailure() }));
      return Effect.tryPromise({
        try: () => Promise.all([getRecord(), getIdempotency()]),
        catch: (cause) => new InitialSessionStorageFailure({ cause }),
      }).pipe(
        Effect.flatMap(([storedRecord, storedIdempotency]) =>
          Effect.fromResult(decideInitial(storedRecord, storedIdempotency, record, idempotency)),
        ),
      );
    },
    createInitial: Effect.fnUntraced(function* (record, idempotency) {
      return yield* initialTransaction(async (transaction) => {
        const decision = decideInitial(
          await transaction.getRecord(),
          await transaction.getCreateIdempotency(),
          record,
          idempotency,
        );
        if (Result.isFailure(decision) || decision.success.kind === "replay") return decision;
        if (idempotency === undefined) await transaction.deleteCreateIdempotency();
        else await transaction.putCreateIdempotency(idempotency);
        await transaction.putRecord(record);
        return decision;
      });
    }),
    acquireOperation: Effect.fnUntraced(
      function* (kind, allowed, nonce, replaceOperationOlderThanMs) {
        const nowMillis = yield* Clock.currentTimeMillis;
        const now = new Date(nowMillis).toISOString();
        return yield* transact(async (transaction) => {
          const stored = await transaction.get();
          if (stored === undefined) return Result.fail(notFound("unknown"));
          const decoded = decode(stored);
          if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
          const record = decoded.success;
          if (!allowed.includes(record.status)) return Result.fail(wrongState(record.status, kind));
          const operationStartedAt = record.operation
            ? Date.parse(record.operation.startedAt)
            : Number.NaN;
          const canReplaceOperation =
            kind === "vaporize" &&
            replaceOperationOlderThanMs !== undefined &&
            Number.isFinite(operationStartedAt) &&
            nowMillis - operationStartedAt >= replaceOperationOlderThanMs;
          if (record.operation && !canReplaceOperation)
            return Result.fail(conflict(`Session is already running ${record.operation.kind}`));
          const operation = { kind, nonce, startedAt: now };
          await transaction.put({ ...record, operation, updatedAt: now });
          return Result.succeed(operation);
        });
      },
    ),
    updateForOperation,
    updateAgentActivity: Effect.fnUntraced(function* (expectedLastEventAt, state) {
      const lastAgentEventAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(Option.none());
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const record = decoded.success;
        if (
          record.status !== "warm" ||
          record.operation !== null ||
          record.lastAgentEventAt !== expectedLastEventAt
        )
          return Result.succeed(Option.none());
        if (record.agentState === state) return Result.succeed(Option.some(record));
        const next: SessionRecord = {
          ...record,
          agentState: state,
          lastAgentEventAt,
          updatedAt: lastAgentEventAt,
        };
        await transaction.put(next);
        return Result.succeed(Option.some(next));
      });
    }),
    rename: Effect.fnUntraced(function* (title) {
      const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.fail(notFound("unknown"));
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const record = decoded.success;
        if (record.status === "gone") return Result.fail(notFound(record.id));
        if (record.title === title) return Result.succeed(record);
        const next: SessionRecord = {
          ...record,
          title,
          updatedAt,
        };
        await transaction.put(next);
        return Result.succeed(next);
      });
    }),
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
    markHardCapFailure: Effect.fnUntraced(function* (observed, message) {
      const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(Option.none());
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const current = decoded.success;
        if (!hardCapObservationIsCurrent(observed, current)) return Result.succeed(Option.none());
        const failed: SessionRecord = {
          ...current,
          status: "failed",
          operation: null,
          failure: {
            code: "hard_cap_checkpoint_failed",
            message,
            recoverable: Boolean(current.backup?.current),
          },
          updatedAt,
        };
        await transaction.put(failed);
        return Result.succeed(Option.some(failed));
      });
    }),
    recordRuntimeStop: Effect.gen(function* () {
      const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(Option.none());
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const record = decoded.success;
        if (
          record.status === "sleeping" ||
          record.status === "failed" ||
          record.status === "gone" ||
          record.operation?.kind === "vaporize"
        )
          return Result.succeed(Option.none());
        const next: SessionRecord = hasCommittedManagedStop(record)
          ? {
              ...record,
              status: "sleeping",
              operation: null,
              failure: undefined,
              updatedAt,
            }
          : {
              ...record,
              status: "failed",
              operation: null,
              failure: {
                code: "runtime_stopped",
                message: "Sandbox runtime stopped before a managed checkpoint",
                recoverable: Boolean(record.backup?.current),
              },
              updatedAt,
            };
        await transaction.put(next);
        return Result.succeed(Option.some(next));
      });
    }),
    claimManagedStopRollback: Effect.fnUntraced(function* (nonce) {
      const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(false);
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const current = decoded.success;
        if (
          current.operation?.nonce !== nonce ||
          current.operation.stopRequestedAt ||
          current.operation.checkpointedBackupId !== current.backup?.current.id
        )
          return Result.succeed(false);
        if (current.operation.stopRollbackAt) return Result.succeed(true);
        await transaction.put({
          ...current,
          operation: { ...current.operation, stopRollbackAt: updatedAt },
          updatedAt,
        });
        return Result.succeed(true);
      });
    }),
    failOperation: Effect.fnUntraced(function* (nonce, code, message, recoverable) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* updateForOperation(nonce, (record) => ({
        ...record,
        status: "failed",
        operation: null,
        failure: { code, message, recoverable },
        updatedAt: now,
      }));
    }),
  });
};
