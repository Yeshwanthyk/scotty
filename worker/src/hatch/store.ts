import { Clock, Context, Effect, Layer, Result } from "effect";
import { decodeSessionRecordResult, type SessionRecord } from "../session/contracts";
import {
  decodeHatchStateResult,
  emptyHatchState,
  HATCH_MAX_CONCURRENT_REQUESTS,
  HATCH_MAX_PERMIT_BYTES,
  HATCH_PERMIT_DURATION_MILLIS,
  HATCH_REQUEST_DURATION_MILLIS,
  HATCH_RESERVED_RESPONSE_BYTES,
  HatchStateError,
  publicHatchStatusProjection,
  sameHatchService,
  type HatchCleanupTarget,
  type HatchHttpRequest,
  type HatchRecord,
  type HatchRequestPermit,
  type HatchRestoreDescriptor,
  type HatchRouteAuthorization,
  type HatchService,
  type HatchState,
  type PublicHatchStatus,
} from "./contracts";
import {
  HATCH_STATE_KEY,
  RUNTIME_EPOCH_KEY,
  SESSION_RECORD_KEY,
  type SessionControlGate,
} from "../session/store";

export interface HatchStateTransaction {
  readonly getHatch: () => Promise<unknown | undefined>;
  readonly getRecord: () => Promise<unknown | undefined>;
  readonly getRuntimeEpoch: () => Promise<unknown | undefined>;
  readonly putHatch: (state: HatchState) => Promise<void>;
  readonly deleteHatch: () => Promise<void>;
}

export interface HatchStateStorage {
  readonly get: () => Promise<unknown | undefined>;
  readonly transaction: <A>(
    operation: (transaction: HatchStateTransaction) => Promise<A>,
  ) => Promise<A>;
}

export const durableObjectHatchStateStorage = (
  storage: DurableObjectStorage,
  controlGate: SessionControlGate,
): HatchStateStorage => ({
  get: () => storage.get(HATCH_STATE_KEY),
  transaction: (operation) =>
    controlGate.run(() =>
      storage.transaction((transaction) =>
        operation({
          getHatch: () => transaction.get(HATCH_STATE_KEY),
          getRecord: () => transaction.get(SESSION_RECORD_KEY),
          getRuntimeEpoch: () => transaction.get(RUNTIME_EPOCH_KEY),
          putHatch: (state) => transaction.put(HATCH_STATE_KEY, state),
          deleteHatch: () => transaction.delete(HATCH_STATE_KEY).then(() => undefined),
        }),
      ),
    ),
});

export interface BeginHatchEnsure {
  readonly sessionId: string;
  readonly operationNonce: string;
  readonly hatchId: string;
  readonly routeNonce: string;
  readonly runtimeEpoch: string;
  readonly service: HatchService;
}

export interface BeginHatchEnsureResult {
  readonly hatch: HatchRecord;
  readonly needsExposure: boolean;
}

export interface BeginHatchRestore {
  readonly operationNonce: string;
  readonly runtimeEpoch: string;
}

export interface HatchWebSocketAuthorization extends HatchRouteAuthorization {
  readonly expiresAt: string;
}

export interface HatchRequestAdmission {
  readonly requestId: string;
  readonly sessionId: string;
  readonly port: number;
  readonly routeNonce: string;
  readonly runtimeEpoch: string;
  readonly cookieDigest: string;
  readonly ingressBytes: number;
}

export interface HatchHealthCleanupAuthority {
  readonly kind: "health_check";
  readonly hatchId: string;
  readonly generation: number;
  readonly runtimeEpoch: string;
}

export type HatchCleanupAuthority =
  | "operation"
  | "hard_cap"
  | "runtime_start"
  | "runtime_stop"
  | "restore_operation"
  | HatchHealthCleanupAuthority
  | "failed_runtime"
  | "scheduled";

export interface HatchRequestClaim {
  readonly requestId: string;
  readonly sessionId: string;
  readonly port: number;
  readonly routeNonce: string;
  readonly runtimeEpoch: string;
}

interface HatchStoreShape {
  readonly read: Effect.Effect<HatchState, HatchStateError>;
  readonly publicStatus: Effect.Effect<PublicHatchStatus, HatchStateError>;
  readonly beginEnsure: (
    input: BeginHatchEnsure,
  ) => Effect.Effect<BeginHatchEnsureResult, HatchStateError>;
  readonly beginRestore: (
    input: BeginHatchRestore,
  ) => Effect.Effect<HatchRecord | undefined, HatchStateError>;
  readonly restoreDescriptor: Effect.Effect<HatchRestoreDescriptor | undefined, HatchStateError>;
  readonly publishRunning: (
    operationNonce: string,
    hatchId: string,
    generation: number,
    runtimeEpoch: string,
  ) => Effect.Effect<HatchRecord, HatchStateError>;
  readonly confirmPublicReady: (
    hatchId: string,
    generation: number,
    runtimeEpoch: string,
  ) => Effect.Effect<HatchRecord, HatchStateError>;
  readonly clearPublicReady: (
    hatchId: string,
    generation: number,
    runtimeEpoch: string,
  ) => Effect.Effect<HatchRecord, HatchStateError>;
  readonly exposedRoute: Effect.Effect<HatchRouteAuthorization, HatchStateError>;
  readonly activeRoute: Effect.Effect<HatchRouteAuthorization, HatchStateError>;
  readonly issuePermit: (
    route: Pick<HatchRouteAuthorization, "sessionId" | "port" | "routeNonce">,
    browserClientId: string,
    cookieDigest: string,
  ) => Effect.Effect<{ readonly expiresAt: string }, HatchStateError>;
  readonly authorizeWebSocket: (
    route: Pick<HatchRouteAuthorization, "sessionId" | "port" | "routeNonce">,
    cookieDigest: string,
  ) => Effect.Effect<HatchWebSocketAuthorization | undefined, HatchStateError>;
  readonly admitRequest: (
    input: HatchRequestAdmission,
  ) => Effect.Effect<HatchRequestPermit | undefined, HatchStateError>;
  readonly adjustRequest: (
    requestId: string,
    ingressBytes: number,
  ) => Effect.Effect<boolean, HatchStateError>;
  readonly claimRequest: (
    input: HatchRequestClaim,
  ) => Effect.Effect<HatchHttpRequest | undefined, HatchStateError>;
  readonly settleRequest: (
    requestId: string,
    responseBytes: number,
  ) => Effect.Effect<void, HatchStateError>;
  readonly cancelRequest: (requestId: string) => Effect.Effect<void, HatchStateError>;
  readonly beginCleanup: (
    operationNonce: string,
    target: HatchCleanupTarget,
    closeDesired: boolean,
    authority: HatchCleanupAuthority,
  ) => Effect.Effect<HatchRecord | undefined, HatchStateError>;
  readonly completeCleanup: (
    operationNonce: string,
    target: HatchCleanupTarget,
  ) => Effect.Effect<void, HatchStateError>;
  readonly clearUnreadableAfterVaporize: (
    operationNonce: string,
  ) => Effect.Effect<void, HatchStateError>;
  readonly clearAfterVaporize: (operationNonce: string) => Effect.Effect<void, HatchStateError>;
}

export class HatchStore extends Context.Service<HatchStore, HatchStoreShape>()(
  "scotty/HatchStore",
) {}

export const hatchStoreLayer = (storage: HatchStateStorage): Layer.Layer<HatchStore> =>
  Layer.succeed(HatchStore)(makeHatchStore(storage));

const invalidState = (message: string): HatchStateError =>
  new HatchStateError({ reason: "invalid_state", message });
const storageFailure = (): HatchStateError =>
  new HatchStateError({ reason: "storage", message: "Authoritative Hatch storage failed" });
const changed = (): HatchStateError =>
  new HatchStateError({ reason: "lease_changed", message: "Hatch transition changed" });

const withoutRuntimeEpoch = (hatch: HatchRecord): HatchRecord => {
  const { runtimeEpoch: _runtimeEpoch, ...current } = hatch;
  return current;
};

const withoutPublicReadiness = (hatch: HatchRecord): HatchRecord => {
  const { publicReadyAt: _publicReadyAt, ...current } = hatch;
  return current;
};

const withoutTransitionNonce = (hatch: HatchRecord): HatchRecord => {
  const { transitionNonce: _transitionNonce, ...current } = hatch;
  return current;
};

const withoutCleanup = (hatch: HatchRecord): HatchRecord => {
  const { cleanup: _cleanup, ...current } = hatch;
  return current;
};

const settleHatchRequest = (
  hatch: HatchRecord,
  request: HatchHttpRequest,
  ingressBytes: number,
  responseBytes: number,
): HatchRecord => ({
  ...hatch,
  permits: hatch.permits.map((permit) =>
    permit.permitId === request.permitId
      ? {
          ...permit,
          ingressBytes: Math.min(HATCH_MAX_PERMIT_BYTES, permit.ingressBytes + ingressBytes),
          responseBytes: Math.min(
            HATCH_MAX_PERMIT_BYTES,
            permit.responseBytes + Math.min(responseBytes, request.reservedResponseBytes),
          ),
        }
      : permit,
  ),
  requests: hatch.requests.filter((candidate) => candidate.requestId !== request.requestId),
});

const decodeState = (value: unknown | undefined): Result.Result<HatchState, HatchStateError> => {
  if (value === undefined) return Result.succeed(emptyHatchState());
  return Result.mapError(decodeHatchStateResult(value), () =>
    invalidState("Stored Hatch state is invalid"),
  );
};

const decodeRecord = (value: unknown | undefined): Result.Result<SessionRecord, HatchStateError> =>
  value === undefined
    ? Result.fail(new HatchStateError({ reason: "not_found", message: "Session was not found" }))
    : Result.mapError(decodeSessionRecordResult(value), () =>
        invalidState("Stored session state is invalid"),
      );

const validRuntimeEpoch = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);

const makeHatchStore = (storage: HatchStateStorage): HatchStoreShape => {
  const read = Effect.fnUntraced(function* () {
    const value = yield* Effect.tryPromise({ try: storage.get, catch: storageFailure });
    return yield* Effect.fromResult(decodeState(value));
  });

  const transact = <A>(
    operation: (
      transaction: HatchStateTransaction,
      state: HatchState,
      nowMillis: number,
    ) => Promise<Result.Result<A, HatchStateError>>,
  ): Effect.Effect<A, HatchStateError> =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const result = yield* Effect.tryPromise({
        try: () =>
          storage.transaction<Result.Result<A, HatchStateError>>(async (transaction) => {
            const state = decodeState(await transaction.getHatch());
            if (Result.isFailure(state)) return Result.fail(state.failure);
            return operation(transaction, state.success, nowMillis);
          }),
        catch: storageFailure,
      });
      return yield* Effect.fromResult(result);
    });

  const currentRuntime = async (
    transaction: HatchStateTransaction,
  ): Promise<Result.Result<string, HatchStateError>> => {
    const runtimeEpoch = await transaction.getRuntimeEpoch();
    return validRuntimeEpoch(runtimeEpoch)
      ? Result.succeed(runtimeEpoch)
      : Result.fail(
          new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
        );
  };

  const requireWarmSession = async (
    transaction: HatchStateTransaction,
    sessionId: string,
  ): Promise<Result.Result<SessionRecord, HatchStateError>> => {
    const record = decodeRecord(await transaction.getRecord());
    if (Result.isFailure(record)) return Result.fail(record.failure);
    if (
      record.success.id !== sessionId ||
      record.success.status !== "warm" ||
      record.success.execution.provider !== "cloudflare"
    )
      return Result.fail(invalidState("Hatch requires a warm Cloudflare session"));
    return record;
  };

  const requireWarmLease = async (
    transaction: HatchStateTransaction,
    sessionId: string,
    operationNonce: string,
  ): Promise<Result.Result<SessionRecord, HatchStateError>> => {
    const record = await requireWarmSession(transaction, sessionId);
    if (Result.isFailure(record)) return Result.fail(record.failure);
    if (
      record.success.operation?.kind !== "hatch" ||
      record.success.operation.nonce !== operationNonce
    )
      return Result.fail(changed());
    return record;
  };

  const requireRestoreLease = async (
    transaction: HatchStateTransaction,
    sessionId: string,
    operationNonce: string,
  ): Promise<Result.Result<SessionRecord, HatchStateError>> => {
    const record = decodeRecord(await transaction.getRecord());
    if (Result.isFailure(record)) return Result.fail(record.failure);
    if (
      record.success.id !== sessionId ||
      record.success.execution.provider !== "cloudflare" ||
      record.success.operation?.nonce !== operationNonce ||
      (record.success.operation.kind !== "snapshot" &&
        record.success.operation.kind !== "resume") ||
      (record.success.status !== "warm" && record.success.status !== "booting")
    )
      return Result.fail(changed());
    return record;
  };

  const cleanupObservedStatus = (
    target: HatchCleanupTarget,
  ): "failed" | "sleeping" | "unhealthy" | "stopped" =>
    target === "failed"
      ? "failed"
      : target === "sleeping"
        ? "sleeping"
        : target === "unhealthy"
          ? "unhealthy"
          : "stopped";

  const isCleanupAlreadyPending = (
    hatch: HatchRecord,
    operationNonce: string,
    target: HatchCleanupTarget,
    closeDesired: boolean,
  ): boolean =>
    hatch.cleanup?.operationNonce === operationNonce &&
    hatch.cleanup.target === target &&
    (!closeDesired || hatch.desiredStatus === "closed");

  const isCleanupAlreadySettled = (
    hatch: HatchRecord,
    target: HatchCleanupTarget,
    closeDesired: boolean,
  ): boolean =>
    target !== "gone" &&
    hatch.cleanup === undefined &&
    hatch.runtimeEpoch === undefined &&
    hatch.exposure === "closed" &&
    hatch.observedStatus === cleanupObservedStatus(target) &&
    (!closeDesired || hatch.desiredStatus === "closed");

  const expectedCleanupOperation = (
    target: HatchCleanupTarget,
  ): "vaporize" | "snapshot" | "hatch" =>
    target === "gone" ? "vaporize" : target === "sleeping" ? "snapshot" : "hatch";

  const isManagedRestore = (record: SessionRecord): boolean =>
    record.status === "sleeping" ||
    record.operation?.kind === "snapshot" ||
    record.operation?.kind === "resume";

  const cleanupDecision = (authorized: boolean): Result.Result<void, HatchStateError> =>
    authorized ? Result.succeed(undefined) : Result.fail(changed());

  const isOperationCleanupAuthorized = (
    session: SessionRecord,
    operationNonce: string,
    target: HatchCleanupTarget,
  ): boolean =>
    session.operation?.nonce === operationNonce &&
    session.operation.kind === expectedCleanupOperation(target);

  const isRuntimeStartCleanupAuthorized = (
    session: SessionRecord,
    target: HatchCleanupTarget,
  ): boolean =>
    session.status !== "gone" &&
    ((target === "sleeping" && isManagedRestore(session)) ||
      (target === "failed" && !isManagedRestore(session)));

  const isCurrentRuntimeCleanupAuthorized = (
    hatch: HatchRecord,
    session: SessionRecord,
    runtime: Result.Result<string, HatchStateError>,
  ): boolean =>
    hatch.runtimeEpoch !== undefined &&
    Result.isSuccess(runtime) &&
    runtime.success === hatch.runtimeEpoch &&
    session.status !== "gone";

  const isHealthCleanupAuthorized = (
    hatch: HatchRecord,
    authority: HatchCleanupAuthority,
  ): boolean =>
    typeof authority !== "string" &&
    authority.kind === "health_check" &&
    authority.hatchId === hatch.hatchId &&
    authority.generation === hatch.generation &&
    authority.runtimeEpoch === hatch.runtimeEpoch;

  const authorizeCleanup = async (
    transaction: HatchStateTransaction,
    hatch: HatchRecord,
    operationNonce: string,
    target: HatchCleanupTarget,
    authority: HatchCleanupAuthority,
  ): Promise<Result.Result<void, HatchStateError>> => {
    const record = decodeRecord(await transaction.getRecord());
    if (Result.isFailure(record)) return Result.fail(record.failure);
    const session = record.success;
    if (typeof authority !== "string" && authority.kind === "health_check")
      return cleanupDecision(isHealthCleanupAuthorized(hatch, authority));
    if (authority === "operation")
      return cleanupDecision(isOperationCleanupAuthorized(session, operationNonce, target));
    if (authority === "restore_operation") {
      const lease = await requireRestoreLease(transaction, hatch.sessionId, operationNonce);
      return Result.isFailure(lease) ? Result.fail(lease.failure) : Result.succeed(undefined);
    }
    if (authority === "failed_runtime") return cleanupDecision(session.status === "failed");
    if (authority === "hard_cap")
      return cleanupDecision(target === "stopped" && session.operation?.kind === "evidence");
    if (authority === "runtime_start")
      return cleanupDecision(isRuntimeStartCleanupAuthorized(session, target));
    if (authority === "scheduled") return Result.fail(changed());
    const runtime = await currentRuntime(transaction);
    return cleanupDecision(isCurrentRuntimeCleanupAuthorized(hatch, session, runtime));
  };

  const nextCleanupRecord = (
    hatch: HatchRecord,
    operationNonce: string,
    target: HatchCleanupTarget,
    closeDesired: boolean,
    generation: number,
    now: string,
  ): HatchRecord => ({
    ...withoutPublicReadiness(withoutRuntimeEpoch(hatch)),
    generation,
    desiredStatus: closeDesired ? "closed" : hatch.desiredStatus,
    observedStatus: cleanupObservedStatus(target),
    exposure:
      hatch.exposure === "active" || hatch.exposure === "unexpose_pending"
        ? "unexpose_pending"
        : "closed",
    permits: [],
    requests: [],
    transitionNonce: operationNonce,
    cleanup: { operationNonce, target, generation, requestedAt: now },
    updatedAt: now,
  });

  const hasMatchingRuntime = (
    runtime: Result.Result<string, HatchStateError>,
    expected: string,
  ): boolean => Result.isSuccess(runtime) && runtime.success === expected;

  const hasPendingEnsureTransition = (hatch: HatchRecord | undefined): boolean =>
    hatch?.cleanup !== undefined || hatch?.transitionNonce !== undefined;

  const alreadyRunningEnsure = (
    hatch: HatchRecord | undefined,
    runtimeEpoch: string,
  ): HatchRecord | undefined =>
    hatch?.desiredStatus === "open" &&
    hatch.observedStatus === "running" &&
    hatch.exposure === "active" &&
    hatch.runtimeEpoch === runtimeEpoch
      ? hatch
      : undefined;

  const route = (requirePublicReady: boolean) =>
    transact(async (transaction, state) => {
      const hatch = state.primary;
      if (
        hatch === undefined ||
        hatch.desiredStatus !== "open" ||
        hatch.observedStatus !== "running" ||
        hatch.exposure !== "active" ||
        hatch.runtimeEpoch === undefined ||
        (requirePublicReady && hatch.publicReadyAt === undefined)
      )
        return Result.fail(invalidState("Hatch is not available"));
      const record = await requireWarmSession(transaction, hatch.sessionId);
      if (Result.isFailure(record)) return Result.fail(invalidState("Hatch is not available"));
      const runtime = await currentRuntime(transaction);
      if (Result.isFailure(runtime) || runtime.success !== hatch.runtimeEpoch)
        return Result.fail(
          new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
        );
      return Result.succeed({
        sessionId: hatch.sessionId,
        hatchId: hatch.hatchId,
        generation: hatch.generation,
        port: hatch.service.port,
        routeNonce: hatch.routeNonce,
        runtimeEpoch: hatch.runtimeEpoch,
      });
    });

  return HatchStore.of({
    read: read(),
    publicStatus: read().pipe(Effect.map(publicHatchStatusProjection)),
    beginEnsure: (input) =>
      transact<BeginHatchEnsureResult>(async (transaction, state, nowMillis) => {
        const lease = await requireWarmLease(transaction, input.sessionId, input.operationNonce);
        if (Result.isFailure(lease)) return Result.fail(lease.failure);
        const existing = state.primary;
        if (hasPendingEnsureTransition(existing)) return Result.fail(changed());
        const runtime = await currentRuntime(transaction);
        if (!hasMatchingRuntime(runtime, input.runtimeEpoch))
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        if (existing !== undefined && !sameHatchService(existing.service, input.service))
          return Result.fail(
            new HatchStateError({
              reason: "conflict",
              message: "A different primary Hatch is already configured",
            }),
          );
        const running = alreadyRunningEnsure(existing, input.runtimeEpoch);
        if (running !== undefined) return Result.succeed({ hatch: running, needsExposure: false });
        const now = new Date(nowMillis).toISOString();
        const generation = (existing?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation))
          return Result.fail(invalidState("Hatch generation exhausted"));
        const hatch: HatchRecord = {
          hatchId: existing?.hatchId ?? input.hatchId,
          sessionId: input.sessionId,
          generation,
          service: input.service,
          desiredStatus: "open",
          observedStatus: "starting",
          runtimeEpoch: input.runtimeEpoch,
          exposure: "unexpose_pending",
          routeNonce: input.routeNonce,
          permits: [],
          requests: [],
          transitionNonce: input.operationNonce,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.lastHealthyAt === undefined
            ? {}
            : { lastHealthyAt: existing.lastHealthyAt }),
        };
        await transaction.putHatch({ primary: hatch });
        return Result.succeed({ hatch, needsExposure: true });
      }),
    beginRestore: (input) =>
      transact(async (transaction, state, nowMillis) => {
        const existing = state.primary;
        if (existing === undefined || existing.desiredStatus !== "open")
          return Result.succeed(undefined);
        const lease = await requireRestoreLease(
          transaction,
          existing.sessionId,
          input.operationNonce,
        );
        if (Result.isFailure(lease)) return Result.fail(lease.failure);
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== input.runtimeEpoch)
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        if (
          existing.cleanup !== undefined ||
          existing.transitionNonce !== undefined ||
          existing.runtimeEpoch !== undefined ||
          existing.exposure !== "closed" ||
          (existing.observedStatus !== "sleeping" &&
            existing.observedStatus !== "stopped" &&
            existing.observedStatus !== "unhealthy" &&
            existing.observedStatus !== "failed")
        )
          return Result.fail(changed());
        const generation = existing.generation + 1;
        if (!Number.isSafeInteger(generation))
          return Result.fail(invalidState("Hatch generation exhausted"));
        const now = new Date(nowMillis).toISOString();
        const hatch: HatchRecord = {
          ...withoutPublicReadiness(existing),
          generation,
          observedStatus: "starting",
          runtimeEpoch: input.runtimeEpoch,
          exposure: "unexpose_pending",
          permits: [],
          requests: [],
          transitionNonce: input.operationNonce,
          updatedAt: now,
        };
        await transaction.putHatch({ primary: hatch });
        return Result.succeed(hatch);
      }),
    restoreDescriptor: transact(async (transaction, state) => {
      const hatch = state.primary;
      if (hatch === undefined || hatch.desiredStatus !== "open") return Result.succeed(undefined);
      if (hatch.observedStatus !== "starting" || hatch.exposure !== "unexpose_pending")
        return Result.succeed(undefined);
      if (
        hatch.runtimeEpoch === undefined ||
        hatch.transitionNonce === undefined ||
        hatch.cleanup !== undefined
      )
        return Result.fail(changed());
      const lease = await requireRestoreLease(transaction, hatch.sessionId, hatch.transitionNonce);
      if (Result.isFailure(lease)) return Result.fail(lease.failure);
      const runtime = await currentRuntime(transaction);
      if (Result.isFailure(runtime) || runtime.success !== hatch.runtimeEpoch)
        return Result.fail(
          new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
        );
      return Result.succeed({
        hatchId: hatch.hatchId,
        generation: hatch.generation,
        operationNonce: hatch.transitionNonce,
        runtimeEpoch: hatch.runtimeEpoch,
        service: hatch.service,
      });
    }),
    publishRunning: (operationNonce, hatchId, generation, runtimeEpoch) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch?.hatchId !== hatchId ||
          hatch.generation !== generation ||
          hatch.transitionNonce !== operationNonce ||
          hatch.runtimeEpoch !== runtimeEpoch ||
          hatch.desiredStatus !== "open"
        )
          return Result.fail(changed());
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== runtimeEpoch)
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        const now = new Date(nowMillis).toISOString();
        const next: HatchRecord = {
          ...withoutTransitionNonce(hatch),
          observedStatus: "running",
          exposure: "active",
          updatedAt: now,
          lastHealthyAt: now,
          publicReadyAt: now,
        };
        await transaction.putHatch({ primary: next });
        return Result.succeed(next);
      }),
    confirmPublicReady: (hatchId, generation, runtimeEpoch) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          hatch.hatchId !== hatchId ||
          hatch.generation !== generation ||
          hatch.runtimeEpoch !== runtimeEpoch ||
          hatch.desiredStatus !== "open" ||
          hatch.observedStatus !== "running" ||
          hatch.exposure !== "active"
        )
          return Result.fail(changed());
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== runtimeEpoch)
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        if (hatch.publicReadyAt !== undefined) return Result.succeed(hatch);
        const now = new Date(nowMillis).toISOString();
        const next = { ...hatch, publicReadyAt: now, updatedAt: now };
        await transaction.putHatch({ primary: next });
        return Result.succeed(next);
      }),
    clearPublicReady: (hatchId, generation, runtimeEpoch) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          hatch.hatchId !== hatchId ||
          hatch.generation !== generation ||
          hatch.runtimeEpoch !== runtimeEpoch ||
          hatch.desiredStatus !== "open" ||
          hatch.observedStatus !== "running" ||
          hatch.exposure !== "active"
        )
          return Result.fail(changed());
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== runtimeEpoch)
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        if (hatch.publicReadyAt === undefined) return Result.succeed(hatch);
        const now = new Date(nowMillis).toISOString();
        const next = { ...withoutPublicReadiness(hatch), updatedAt: now };
        await transaction.putHatch({ primary: next });
        return Result.succeed(next);
      }),
    exposedRoute: route(false),
    activeRoute: route(true),
    issuePermit: (route, browserClientId, cookieDigest) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          hatch.desiredStatus !== "open" ||
          hatch.observedStatus !== "running" ||
          hatch.exposure !== "active" ||
          hatch.runtimeEpoch === undefined ||
          hatch.sessionId !== route.sessionId ||
          hatch.service.port !== route.port ||
          hatch.routeNonce !== route.routeNonce
        )
          return Result.fail(invalidState("Hatch is not available"));
        const record = await requireWarmSession(transaction, hatch.sessionId);
        if (Result.isFailure(record)) return Result.fail(invalidState("Hatch is not available"));
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== hatch.runtimeEpoch)
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        const now = new Date(nowMillis).toISOString();
        const existingPermit = hatch.permits.find(
          (candidate) =>
            candidate.browserClientId === browserClientId &&
            Date.parse(candidate.expiresAt) > nowMillis,
        );
        const permitId = `permit-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const expiresAt =
          existingPermit?.expiresAt ??
          new Date(nowMillis + HATCH_PERMIT_DURATION_MILLIS).toISOString();
        const permit = {
          permitId,
          browserClientId,
          cookieDigest,
          createdAt: existingPermit?.createdAt ?? now,
          expiresAt,
          ingressBytes: existingPermit?.ingressBytes ?? 0,
          responseBytes: existingPermit?.responseBytes ?? 0,
        };
        const retainedPermits = hatch.permits.filter(
          (candidate) =>
            candidate.browserClientId !== browserClientId &&
            Date.parse(candidate.expiresAt) > nowMillis,
        );
        const retainedPermitIds = new Set(retainedPermits.map((candidate) => candidate.permitId));
        await transaction.putHatch({
          primary: {
            ...hatch,
            permits: [...retainedPermits, permit],
            requests: hatch.requests.filter(
              (request) =>
                retainedPermitIds.has(request.permitId) &&
                Date.parse(request.expiresAt) > nowMillis,
            ),
            updatedAt: now,
          },
        });
        return Result.succeed({ expiresAt });
      }),
    authorizeWebSocket: (route, cookieDigest) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          hatch.desiredStatus !== "open" ||
          hatch.observedStatus !== "running" ||
          hatch.exposure !== "active" ||
          hatch.runtimeEpoch === undefined ||
          hatch.sessionId !== route.sessionId ||
          hatch.service.port !== route.port ||
          hatch.routeNonce !== route.routeNonce
        )
          return Result.succeed(undefined);
        const record = await requireWarmSession(transaction, hatch.sessionId);
        if (Result.isFailure(record)) return Result.succeed(undefined);
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== hatch.runtimeEpoch)
          return Result.succeed(undefined);
        const permit = hatch.permits.find(
          (candidate) =>
            candidate.cookieDigest === cookieDigest && Date.parse(candidate.expiresAt) > nowMillis,
        );
        if (permit === undefined) return Result.succeed(undefined);
        return Result.succeed({
          sessionId: hatch.sessionId,
          hatchId: hatch.hatchId,
          generation: hatch.generation,
          port: hatch.service.port,
          routeNonce: hatch.routeNonce,
          runtimeEpoch: hatch.runtimeEpoch,
          expiresAt: permit.expiresAt,
        });
      }),
    admitRequest: (input) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          hatch.sessionId !== input.sessionId ||
          hatch.service.port !== input.port ||
          hatch.routeNonce !== input.routeNonce ||
          hatch.runtimeEpoch !== input.runtimeEpoch ||
          hatch.desiredStatus !== "open" ||
          hatch.observedStatus !== "running" ||
          hatch.exposure !== "active"
        )
          return Result.succeed(undefined);
        const record = await requireWarmSession(transaction, hatch.sessionId);
        if (Result.isFailure(record)) return Result.succeed(undefined);
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== hatch.runtimeEpoch)
          return Result.succeed(undefined);
        const permits = hatch.permits.filter(
          (candidate) => Date.parse(candidate.expiresAt) > nowMillis,
        );
        const permitIds = new Set(permits.map((candidate) => candidate.permitId));
        const requests = hatch.requests.filter(
          (candidate) =>
            permitIds.has(candidate.permitId) && Date.parse(candidate.expiresAt) > nowMillis,
        );
        if (requests.length >= HATCH_MAX_CONCURRENT_REQUESTS) return Result.succeed(undefined);
        const permit = permits.find((candidate) => candidate.cookieDigest === input.cookieDigest);
        const reservedBytes = requests
          .filter((candidate) => candidate.permitId === permit?.permitId)
          .reduce(
            (total, candidate) =>
              total + candidate.reservedIngressBytes + candidate.reservedResponseBytes,
            0,
          );
        if (
          permit === undefined ||
          permit.ingressBytes +
            permit.responseBytes +
            reservedBytes +
            input.ingressBytes +
            HATCH_RESERVED_RESPONSE_BYTES >
            HATCH_MAX_PERMIT_BYTES
        )
          return Result.succeed(undefined);
        const admittedAt = new Date(nowMillis).toISOString();
        const expiresAt = new Date(
          Math.min(nowMillis + HATCH_REQUEST_DURATION_MILLIS, Date.parse(permit.expiresAt)),
        ).toISOString();
        const request: HatchHttpRequest = {
          requestId: input.requestId,
          permitId: permit.permitId,
          generation: hatch.generation,
          runtimeEpoch: hatch.runtimeEpoch,
          reservedIngressBytes: input.ingressBytes,
          reservedResponseBytes: HATCH_RESERVED_RESPONSE_BYTES,
          status: "admitted",
          admittedAt,
          expiresAt,
        };
        await transaction.putHatch({
          primary: { ...hatch, permits, requests: [...requests, request], updatedAt: admittedAt },
        });
        return Result.succeed({ requestId: request.requestId, expiresAt });
      }),
    adjustRequest: (requestId, ingressBytes) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        const request = hatch?.requests.find((candidate) => candidate.requestId === requestId);
        if (
          hatch === undefined ||
          request === undefined ||
          request.status !== "admitted" ||
          ingressBytes > request.reservedIngressBytes ||
          Date.parse(request.expiresAt) <= nowMillis
        )
          return Result.succeed(false);
        await transaction.putHatch({
          primary: {
            ...hatch,
            requests: hatch.requests.map((candidate) =>
              candidate.requestId === requestId ? { ...candidate, ingressBytes } : candidate,
            ),
          },
        });
        return Result.succeed(true);
      }),
    claimRequest: (input) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        const request = hatch?.requests.find(
          (candidate) => candidate.requestId === input.requestId,
        );
        if (
          hatch === undefined ||
          request === undefined ||
          request.status !== "admitted" ||
          request.ingressBytes === undefined ||
          request.generation !== hatch.generation ||
          request.runtimeEpoch !== input.runtimeEpoch ||
          hatch.sessionId !== input.sessionId ||
          hatch.service.port !== input.port ||
          hatch.routeNonce !== input.routeNonce ||
          hatch.runtimeEpoch !== input.runtimeEpoch ||
          hatch.desiredStatus !== "open" ||
          hatch.observedStatus !== "running" ||
          hatch.exposure !== "active" ||
          Date.parse(request.expiresAt) <= nowMillis
        )
          return Result.succeed(undefined);
        const record = await requireWarmSession(transaction, hatch.sessionId);
        if (Result.isFailure(record)) return Result.succeed(undefined);
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== input.runtimeEpoch)
          return Result.succeed(undefined);
        const claimed: HatchHttpRequest = { ...request, status: "claimed" };
        await transaction.putHatch({
          primary: {
            ...hatch,
            requests: hatch.requests.map((candidate) =>
              candidate.requestId === input.requestId ? claimed : candidate,
            ),
          },
        });
        return Result.succeed(claimed);
      }),
    settleRequest: (requestId, responseBytes) =>
      transact(async (transaction, state) => {
        const hatch = state.primary;
        const request = hatch?.requests.find((candidate) => candidate.requestId === requestId);
        if (hatch === undefined || request === undefined) return Result.succeed(undefined);
        const ingressBytes = request.ingressBytes ?? request.reservedIngressBytes;
        await transaction.putHatch({
          primary: settleHatchRequest(hatch, request, ingressBytes, responseBytes),
        });
        return Result.succeed(undefined);
      }),
    cancelRequest: (requestId) =>
      transact(async (transaction, state) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          !hatch.requests.some((request) => request.requestId === requestId)
        )
          return Result.succeed(undefined);
        const request = hatch.requests.find((candidate) => candidate.requestId === requestId);
        if (request === undefined) return Result.succeed(undefined);
        await transaction.putHatch({
          primary: settleHatchRequest(
            hatch,
            request,
            request.ingressBytes ?? request.reservedIngressBytes,
            request.status === "claimed" ? request.reservedResponseBytes : 0,
          ),
        });
        return Result.succeed(undefined);
      }),
    beginCleanup: (operationNonce, target, closeDesired, authority) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (hatch === undefined) return Result.succeed(undefined);
        if (
          typeof authority !== "string" &&
          authority.kind === "health_check" &&
          !isHealthCleanupAuthorized(hatch, authority)
        )
          return Result.fail(changed());
        if (isCleanupAlreadyPending(hatch, operationNonce, target, closeDesired))
          return Result.succeed(hatch);
        if (isCleanupAlreadySettled(hatch, target, closeDesired)) return Result.succeed(undefined);
        const authorized = await authorizeCleanup(
          transaction,
          hatch,
          operationNonce,
          target,
          authority,
        );
        if (Result.isFailure(authorized)) return Result.fail(authorized.failure);
        const generation = hatch.generation + 1;
        if (!Number.isSafeInteger(generation))
          return Result.fail(invalidState("Hatch generation exhausted"));
        const next = nextCleanupRecord(
          hatch,
          operationNonce,
          target,
          closeDesired,
          generation,
          new Date(nowMillis).toISOString(),
        );
        await transaction.putHatch({ primary: next });
        return Result.succeed(next);
      }),
    completeCleanup: (operationNonce, target) =>
      transact(async (transaction, state, nowMillis) => {
        const hatch = state.primary;
        if (
          hatch === undefined ||
          hatch.cleanup?.operationNonce !== operationNonce ||
          hatch.cleanup.target !== target ||
          hatch.cleanup.generation !== hatch.generation
        )
          return Result.fail(changed());
        const settled = withoutTransitionNonce(hatch);
        await transaction.putHatch({
          primary: {
            ...(target === "gone" ? settled : withoutCleanup(settled)),
            exposure: "closed",
            updatedAt: new Date(nowMillis).toISOString(),
          },
        });
        return Result.succeed(undefined);
      }),
    clearUnreadableAfterVaporize: (operationNonce) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            storage.transaction<Result.Result<void, HatchStateError>>(async (transaction) => {
              if (Result.isSuccess(decodeState(await transaction.getHatch())))
                return Result.fail(changed());
              const record = decodeRecord(await transaction.getRecord());
              if (
                Result.isFailure(record) ||
                record.success.operation?.kind !== "vaporize" ||
                record.success.operation.nonce !== operationNonce
              )
                return Result.fail(Result.isFailure(record) ? record.failure : changed());
              await transaction.deleteHatch();
              return Result.succeed(undefined);
            }),
          catch: storageFailure,
        });
        return yield* Effect.fromResult(result);
      }),
    clearAfterVaporize: (operationNonce) =>
      transact(async (transaction, state) => {
        const hatch = state.primary;
        if (hatch === undefined) return Result.succeed(undefined);
        if (
          hatch.cleanup?.operationNonce !== operationNonce ||
          hatch.cleanup.target !== "gone" ||
          hatch.exposure !== "closed"
        )
          return Result.fail(changed());
        await transaction.deleteHatch();
        return Result.succeed(undefined);
      }),
  });
};
