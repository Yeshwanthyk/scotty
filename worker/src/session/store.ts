import { Clock, Context, Data, Effect, Layer, Option, Predicate, Result } from "effect";
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
import {
  decideIdempotentCreate,
  decodeCreateIdempotencyMetadata,
  type CreateIdempotencyDecision,
  type CreateIdempotencyMetadata,
} from "./create-idempotency";
import type {
  ActorStoragePort,
  ActorStorageTransactionPlan,
  RawActorStorageSnapshot,
} from "../session-actor/store";
import type { MetadataStoragePort } from "../session-actor/metadata-store";

export const SESSION_RECORD_KEY = "scotty:session";
export const EVIDENCE_RECORD_KEY = "scotty:evidence";
export const HATCH_STATE_KEY = "scotty:hatch";
export const RUNTIME_EPOCH_KEY = "scotty:runtime-epoch";
export const SESSION_CONTROL_REVISION_KEY = "scotty:session-control-revision";
export const SESSION_ACTOR_AUTHORITY_KEY = "scotty:session-actor:authority";
export const SESSION_ACTOR_REVISION_KEY = "scotty:session-actor:revision";
export const SESSION_ACTOR_JOURNAL_SEQUENCE_KEY = "scotty:session-actor:journal-sequence";
export const SESSION_ACTOR_JOURNAL_TAIL_KEY = "scotty:session-actor:journal-tail";
export const SESSION_ACTOR_EVIDENCE_KEY = "scotty:session-actor:evidence";
export const SESSION_ACTOR_METADATA_KEY = "scotty:session-actor:metadata";
const SESSION_ACTOR_JOURNAL_PREFIX = "scotty:session-actor:journal:";
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
  readonly delete?: () => Promise<void>;
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
  readonly rename: (title: string) => Effect.Effect<SessionRecord, ScottyError>;
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
  delete: () => storage.delete(SESSION_RECORD_KEY).then(() => undefined),
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

const sessionActorJournalKey = (sequence: number): string =>
  `${SESSION_ACTOR_JOURNAL_PREFIX}${String(sequence).padStart(16, "0")}`;

const readActorStorageSnapshot = async (
  storage: DurableObjectStorage | DurableObjectTransaction,
): Promise<RawActorStorageSnapshot> => {
  const [authority, revision, journalSequence, journalTail, evidence] = await Promise.all([
    storage.get<unknown>(SESSION_ACTOR_AUTHORITY_KEY),
    storage.get<unknown>(SESSION_ACTOR_REVISION_KEY),
    storage.get<unknown>(SESSION_ACTOR_JOURNAL_SEQUENCE_KEY),
    storage.get<unknown>(SESSION_ACTOR_JOURNAL_TAIL_KEY),
    storage.get<unknown>(SESSION_ACTOR_EVIDENCE_KEY),
  ]);
  return { authority, revision, journalSequence, journalTail, evidence };
};

const applyActorStorageCommit = async (
  transaction: DurableObjectTransaction,
  plan: Extract<ActorStorageTransactionPlan, { readonly _tag: "Commit" }>,
): Promise<void> => {
  const journalKey = sessionActorJournalKey(plan.write.journalSequence);
  const existingJournal = await transaction.get<unknown>(journalKey);
  if (existingJournal !== undefined) {
    // oxlint-disable-next-line scotty/no-promise-reject -- boundary: rejecting the native transaction prevents overwriting an immutable journal event
    return Promise.reject(new SessionControlRevisionFailure({ reason: "invalid" }));
  }
  const writes: Array<Promise<void>> = [
    transaction.put(SESSION_ACTOR_AUTHORITY_KEY, plan.write.authority),
    transaction.put(SESSION_ACTOR_REVISION_KEY, plan.write.revision),
    transaction.put(SESSION_ACTOR_JOURNAL_SEQUENCE_KEY, plan.write.journalSequence),
    transaction.put(SESSION_ACTOR_JOURNAL_TAIL_KEY, plan.write.appendJournal),
    transaction.put(journalKey, plan.write.appendJournal),
  ];
  if (Predicate.isTagged(plan.write.evidence, "Put"))
    writes.push(transaction.put(SESSION_ACTOR_EVIDENCE_KEY, plan.write.evidence.value));
  if (Predicate.isTagged(plan.write.evidence, "Delete"))
    writes.push(transaction.delete(SESSION_ACTOR_EVIDENCE_KEY).then(() => undefined));
  await Promise.all(writes);
};

export const durableObjectSessionActorStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): ActorStoragePort => ({
  read: () => storage.transaction((transaction) => readActorStorageSnapshot(transaction)),
  transaction: (operation) =>
    controlGate.run(() =>
      storage.transaction(async (transaction) => {
        const plan = operation(await readActorStorageSnapshot(transaction));
        if (Predicate.isTagged(plan, "NoCommit")) return plan.outcome;
        await applyActorStorageCommit(transaction, plan);
        return plan.outcome;
      }),
    ),
});

export const durableObjectSessionActorMetadataStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate = makeSessionControlGate(),
): MetadataStoragePort => ({
  read: () => storage.get<unknown>(SESSION_ACTOR_METADATA_KEY),
  transaction: (decide) =>
    controlGate.run(() =>
      storage.transaction(async (transaction) => {
        const mutation = decide(await transaction.get<unknown>(SESSION_ACTOR_METADATA_KEY));
        if (Predicate.isTagged(mutation, "Put"))
          await transaction.put(SESSION_ACTOR_METADATA_KEY, mutation.value);
        if (Predicate.isTagged(mutation, "Delete"))
          await transaction.delete(SESSION_ACTOR_METADATA_KEY);
        return mutation.outcome;
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
