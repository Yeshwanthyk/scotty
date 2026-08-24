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
  type PiSessionTransportToken,
  type SessionControlAuthority,
  type SessionOperationFailureCode,
  type SessionOperationResult,
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

export const SESSION_RECORD_KEY = "scotty:session";
export const EVIDENCE_RECORD_KEY = "scotty:evidence:v1";
export const HATCH_STATE_KEY = "scotty:hatch:v1";
export const RUNTIME_EPOCH_KEY = "scotty:runtime-epoch:v1";
export const SESSION_CONTROL_REVISION_KEY = "scotty:session-control-revision";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const INVALID_RECORD = new ScottyError("internal", "Authoritative session record is invalid", {
  httpStatus: 500,
  exitCode: 1,
});
export const createPiSessionTransportToken = (): PiSessionTransportToken => {
  const data = new Uint8Array(32);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
};

class SessionControlRevisionFailure extends Data.TaggedError("SessionControlRevisionFailure")<{
  readonly reason: "invalid" | "exhausted";
}> {}

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
  readonly getRuntimeEpoch: () => Promise<unknown | undefined>;
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
  readonly getRuntimeEpoch?: () => Promise<unknown | undefined>;
  readonly putRuntimeEpoch?: (runtimeEpoch: string) => Promise<void>;
  readonly deleteRuntimeEpoch?: () => Promise<void>;
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

const operationStages = {
  create: "setup",
  snapshot: "checkpoint",
  resume: "restore",
  refresh: "refresh",
  evidence: "evidence",
  hatch: "hatch",
  down: "publish",
  vaporize: "cleanup",
} as const satisfies Record<OperationKind, SessionOperationResult["stage"]>;

const operationStage = (kind: OperationKind): SessionOperationResult["stage"] =>
  operationStages[kind];

export const startOperationResult = (
  record: SessionRecord,
  operation: SessionOperation,
  updatedAt: string,
): SessionOperationResult => ({
  kind: operation.kind,
  stage: operationStage(operation.kind),
  progress: "running",
  lastProvenEffect:
    record.status === "warm"
      ? "runtime_ready"
      : record.status === "stopped"
        ? "runtime_stopped"
        : "session_created",
  retainedState: record.status === "stopped" ? "checkpoint" : "operation_lease",
  ambiguity: "none",
  safeRetry: "none",
  humanAction: "none",
  outcome: { status: "pending" },
  ...(record.status === "stopped"
    ? { stoppedReason: record.operationResult?.stoppedReason ?? ("runtime_exit" as const) }
    : {}),
  recoveryAction: "none",
  startedAt: operation.startedAt,
  updatedAt,
});

export const completeOperationResult = (
  record: SessionRecord,
  operation: SessionOperation,
  updatedAt: string,
): SessionOperationResult => {
  const stopped = record.status === "stopped";
  return {
    kind: operation.kind,
    stage: "commit",
    progress: "completed",
    lastProvenEffect:
      record.status === "gone"
        ? "resources_absent"
        : stopped
          ? "runtime_stopped"
          : record.status === "warm"
            ? "runtime_ready"
            : "session_created",
    retainedState:
      record.status === "gone" ? "cleanup_authority" : stopped ? "checkpoint" : "session",
    ambiguity: "none",
    safeRetry: "none",
    humanAction: stopped ? "resume" : "none",
    outcome: { status: "succeeded" },
    ...(stopped ? { stoppedReason: operation.stoppedReason ?? "runtime_exit" } : {}),
    recoveryAction: stopped ? "resume" : "none",
    startedAt: operation.startedAt,
    updatedAt,
  };
};

const failedOperationResult = (
  record: SessionRecord,
  operation: SessionOperation,
  updatedAt: string,
  code: SessionOperationFailureCode,
  message: string,
  safeToRetry: boolean,
): SessionOperationResult => ({
  kind: operation.kind,
  stage: operationStage(operation.kind),
  progress: "completed",
  lastProvenEffect:
    record.status === "warm"
      ? "runtime_ready"
      : record.status === "stopped"
        ? "runtime_stopped"
        : record.status === "gone"
          ? "resources_absent"
          : "session_created",
  retainedState: record.backup?.current ? "checkpoint" : "session",
  ambiguity: "none",
  safeRetry: safeToRetry && !record.backup?.current ? "retry_operation" : "none",
  humanAction: record.backup?.current ? "resume" : safeToRetry ? "retry" : "inspect",
  outcome: { status: "failed", failure: { code, message } },
  recoveryAction: record.backup?.current ? "resume" : safeToRetry ? "retry" : "vaporize",
  startedAt: operation.startedAt,
  updatedAt,
});

const failedRuntimeStoppedRecord = (record: SessionRecord, updatedAt: string): SessionRecord => {
  const result = record.operationResult;
  if (result?.outcome.status !== "failed") return record;
  const checkpointRetained = record.backup?.current !== undefined;
  return {
    ...record,
    status: checkpointRetained ? "stopped" : "provisioning",
    operation: null,
    operationResult: {
      ...result,
      lastProvenEffect: "runtime_stopped",
      retainedState: checkpointRetained ? "checkpoint" : "session",
      safeRetry: checkpointRetained ? "none" : result.safeRetry,
      humanAction: checkpointRetained ? "resume" : result.humanAction,
      stoppedReason: "runtime_exit",
      recoveryAction: checkpointRetained ? "resume" : result.recoveryAction,
      updatedAt,
    },
    updatedAt,
  };
};
type InitialSessionDecision = Exclude<CreateIdempotencyDecision, { readonly kind: "conflict" }>;

export class InitialSessionStorageFailure extends Data.TaggedError("InitialSessionStorageFailure")<{
  readonly cause: unknown;
}> {}

interface SessionStoreShape {
  readonly read: Effect.Effect<Option.Option<SessionRecord>, ScottyError>;
  readonly requireRecord: Effect.Effect<SessionRecord, ScottyError>;
  readonly ensurePiSessionTransportToken: Effect.Effect<PiSessionTransportToken, ScottyError>;
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
    stoppedReason?: SessionOperation["stoppedReason"],
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
  readonly recordFailedRuntimeDestroyed: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<SessionRecord>, ScottyError>;
  readonly claimManagedStopRollback: (nonce: string) => Effect.Effect<boolean, ScottyError>;
  readonly failOperation: (
    nonce: string,
    code: SessionOperationFailureCode,
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
      transaction.get<unknown>(SESSION_RECORD_KEY),
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
    transaction.put(SESSION_RECORD_KEY, record),
    transaction.put(SESSION_CONTROL_REVISION_KEY, revision + 1),
  ]);
};

export const durableObjectSessionRecordStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): SessionRecordStorage => ({
  get: () => storage.get(SESSION_RECORD_KEY),
  put: (record) =>
    controlGate.run(() =>
      storage.transaction((transaction) => writeRecordWithNextControlRevision(transaction, record)),
    ),
  deleteCreateIdempotency: () => storage.delete(CREATE_IDEMPOTENCY_KEY).then(() => undefined),
  transaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          get: () => transaction.get(SESSION_RECORD_KEY),
          put: (record) => writeRecordWithNextControlRevision(transaction, record),
        }),
      ),
    ),
  readControlAuthority: () => readDurableObjectSessionControlAuthority(storage),
  getInitialRecord: () => storage.get(SESSION_RECORD_KEY),
  getCreateIdempotency: () => storage.get(CREATE_IDEMPOTENCY_KEY),
  getEvidence: () => storage.get(EVIDENCE_RECORD_KEY),
  getRuntimeEpoch: () => storage.get(RUNTIME_EPOCH_KEY),
  putRuntimeEpoch: (runtimeEpoch) =>
    controlGate.run(() => storage.put(RUNTIME_EPOCH_KEY, runtimeEpoch)),
  deleteRuntimeEpoch: () =>
    controlGate.run(() => storage.delete(RUNTIME_EPOCH_KEY).then(() => undefined)),
  evidenceTransaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          getRecord: () => transaction.get(SESSION_RECORD_KEY),
          getEvidence: () => transaction.get(EVIDENCE_RECORD_KEY),
          getRuntimeEpoch: () => transaction.get(RUNTIME_EPOCH_KEY),
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
          getRecord: () => transaction.get(SESSION_RECORD_KEY),
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
  const ensurePiSessionTransportToken = Effect.map(
    requireRecord(),
    (record) => record.piSessionTransportToken,
  );

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
      const proposed = update(current);
      const next =
        current.operation !== null &&
        proposed.operation === null &&
        proposed.operationResult?.outcome.status !== "failed"
          ? {
              ...proposed,
              operationResult: completeOperationResult(
                proposed,
                current.operation,
                proposed.updatedAt,
              ),
            }
          : proposed;
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
    ensurePiSessionTransportToken,
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
      function* (kind, allowed, nonce, replaceOperationOlderThanMs, stoppedReason) {
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
          const operation = {
            kind,
            nonce,
            startedAt: now,
            ...(stoppedReason ? { stoppedReason } : {}),
          };
          await transaction.put({
            ...record,
            operation,
            operationResult: startOperationResult(record, operation, now),
            updatedAt: now,
          });
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
        const next = {
          ...record,
          operation: null,
          operationResult: completeOperationResult(record, record.operation, now),
          updatedAt: now,
        };
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
        const operation =
          current.operation ??
          ({ kind: "snapshot", nonce: "hard-cap", startedAt: current.updatedAt } as const);
        const failed: SessionRecord = {
          ...current,
          operation: null,
          operationResult: failedOperationResult(
            current,
            operation,
            updatedAt,
            "hard_cap_checkpoint_failed",
            message,
            Boolean(current.backup?.current),
          ),
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
          record.status === "stopped" ||
          record.status === "gone" ||
          record.operation?.kind === "vaporize"
        )
          return Result.succeed(Option.none());
        const operation = record.operation;
        const next: SessionRecord =
          operation !== null && hasCommittedManagedStop(record)
            ? {
                ...record,
                status: "stopped",
                operation: null,
                operationResult: completeOperationResult(
                  { ...record, status: "stopped" },
                  operation,
                  updatedAt,
                ),
                updatedAt,
              }
            : failedRuntimeStoppedRecord(
                {
                  ...record,
                  operation: record.operation?.kind === "evidence" ? record.operation : null,
                  operationResult: failedOperationResult(
                    record,
                    record.operation ?? {
                      kind: "snapshot",
                      nonce: "runtime-stop",
                      startedAt: record.updatedAt,
                    },
                    updatedAt,
                    "runtime_stopped",
                    "Sandbox runtime stopped before a managed checkpoint",
                    Boolean(record.backup?.current),
                  ),
                  updatedAt,
                },
                updatedAt,
              );
        await transaction.put(next);
        return Result.succeed(Option.some(next));
      });
    }),
    recordFailedRuntimeDestroyed: Effect.fnUntraced(function* (sessionId) {
      const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const stored = await transaction.get();
        if (stored === undefined) return Result.succeed(Option.none());
        const decoded = decode(stored);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const record = decoded.success;
        if (
          record.id !== sessionId ||
          record.status === "gone" ||
          record.operation?.kind === "vaporize" ||
          record.operationResult?.outcome.status !== "failed"
        )
          return Result.succeed(Option.none());
        const next = failedRuntimeStoppedRecord(record, updatedAt);
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
      return yield* updateForOperation(nonce, (record) => {
        const operation = record.operation;
        if (operation === null) return record;
        return {
          ...record,
          operation: null,
          operationResult: failedOperationResult(
            record,
            operation,
            now,
            code,
            message,
            recoverable,
          ),
          updatedAt: now,
        };
      });
    }),
  });
};
