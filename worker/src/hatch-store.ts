import { Clock, Context, Effect, Layer, Result } from "effect";
import { decodeSessionRecordResult, type SessionRecord } from "./contracts";
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
  type HatchHttpRequestV1,
  type HatchRecordV1,
  type HatchRequestPermitV1,
  type HatchRouteAuthorizationV1,
  type HatchServiceV1,
  type HatchStateV1,
  type PublicHatchStatusV1,
} from "./hatch-contracts";
import {
  HATCH_STATE_KEY,
  RUNTIME_EPOCH_KEY,
  SESSION_RECORD_KEY,
  type SessionControlGate,
} from "./session-store";

export interface HatchStateTransaction {
  readonly getHatch: () => Promise<unknown | undefined>;
  readonly getRecord: () => Promise<unknown | undefined>;
  readonly getRuntimeEpoch: () => Promise<unknown | undefined>;
  readonly putHatch: (state: HatchStateV1) => Promise<void>;
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
  readonly service: HatchServiceV1;
}

export interface BeginHatchEnsureResult {
  readonly hatch: HatchRecordV1;
  readonly needsExposure: boolean;
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

export type HatchCleanupAuthority =
  | "operation"
  | "hard_cap"
  | "runtime_start"
  | "runtime_stop"
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
  readonly read: Effect.Effect<HatchStateV1, HatchStateError>;
  readonly publicStatus: Effect.Effect<PublicHatchStatusV1, HatchStateError>;
  readonly beginEnsure: (
    input: BeginHatchEnsure,
  ) => Effect.Effect<BeginHatchEnsureResult, HatchStateError>;
  readonly publishRunning: (
    operationNonce: string,
    hatchId: string,
    generation: number,
    runtimeEpoch: string,
  ) => Effect.Effect<HatchRecordV1, HatchStateError>;
  readonly activeRoute: Effect.Effect<HatchRouteAuthorizationV1, HatchStateError>;
  readonly issuePermit: (
    route: Pick<HatchRouteAuthorizationV1, "sessionId" | "port" | "routeNonce">,
    browserClientId: string,
    cookieDigest: string,
  ) => Effect.Effect<{ readonly expiresAt: string }, HatchStateError>;
  readonly admitRequest: (
    input: HatchRequestAdmission,
  ) => Effect.Effect<HatchRequestPermitV1 | undefined, HatchStateError>;
  readonly adjustRequest: (
    requestId: string,
    ingressBytes: number,
  ) => Effect.Effect<boolean, HatchStateError>;
  readonly claimRequest: (
    input: HatchRequestClaim,
  ) => Effect.Effect<HatchHttpRequestV1 | undefined, HatchStateError>;
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
  ) => Effect.Effect<HatchRecordV1 | undefined, HatchStateError>;
  readonly completeCleanup: (
    operationNonce: string,
    target: HatchCleanupTarget,
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

const withoutRuntimeEpoch = (hatch: HatchRecordV1): HatchRecordV1 => {
  const { runtimeEpoch: _runtimeEpoch, ...current } = hatch;
  return current;
};

const withoutTransitionNonce = (hatch: HatchRecordV1): HatchRecordV1 => {
  const { transitionNonce: _transitionNonce, ...current } = hatch;
  return current;
};

const withoutCleanup = (hatch: HatchRecordV1): HatchRecordV1 => {
  const { cleanup: _cleanup, ...current } = hatch;
  return current;
};

const settleHatchRequest = (
  hatch: HatchRecordV1,
  request: HatchHttpRequestV1,
  ingressBytes: number,
  responseBytes: number,
): HatchRecordV1 => ({
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

const decodeState = (value: unknown | undefined): Result.Result<HatchStateV1, HatchStateError> => {
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
      state: HatchStateV1,
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

  return HatchStore.of({
    read: read(),
    publicStatus: read().pipe(Effect.map(publicHatchStatusProjection)),
    beginEnsure: (input) =>
      transact<BeginHatchEnsureResult>(async (transaction, state, nowMillis) => {
        const lease = await requireWarmLease(transaction, input.sessionId, input.operationNonce);
        if (Result.isFailure(lease)) return Result.fail(lease.failure);
        const runtime = await currentRuntime(transaction);
        if (Result.isFailure(runtime) || runtime.success !== input.runtimeEpoch)
          return Result.fail(
            new HatchStateError({ reason: "runtime_changed", message: "Hatch runtime changed" }),
          );
        const existing = state.primary;
        if (existing !== undefined && !sameHatchService(existing.service, input.service))
          return Result.fail(
            new HatchStateError({
              reason: "conflict",
              message: "A different primary Hatch is already configured",
            }),
          );
        if (
          existing?.desiredStatus === "open" &&
          existing.observedStatus === "running" &&
          existing.exposure === "active" &&
          existing.runtimeEpoch === input.runtimeEpoch
        )
          return Result.succeed({ hatch: existing, needsExposure: false });
        const now = new Date(nowMillis).toISOString();
        const generation = (existing?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation))
          return Result.fail(invalidState("Hatch generation exhausted"));
        const hatch: HatchRecordV1 = {
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
        await transaction.putHatch({ version: 1, primary: hatch });
        return Result.succeed({ hatch, needsExposure: true });
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
        const next: HatchRecordV1 = {
          ...withoutTransitionNonce(hatch),
          observedStatus: "running",
          exposure: "active",
          updatedAt: now,
          lastHealthyAt: now,
        };
        await transaction.putHatch({ version: 1, primary: next });
        return Result.succeed(next);
      }),
    activeRoute: transact(async (transaction, state) => {
      const hatch = state.primary;
      if (
        hatch === undefined ||
        hatch.desiredStatus !== "open" ||
        hatch.observedStatus !== "running" ||
        hatch.exposure !== "active" ||
        hatch.runtimeEpoch === undefined
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
    }),
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
          version: 1,
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
        const request: HatchHttpRequestV1 = {
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
          version: 1,
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
          version: 1,
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
        const claimed: HatchHttpRequestV1 = { ...request, status: "claimed" };
        await transaction.putHatch({
          version: 1,
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
          version: 1,
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
          version: 1,
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
          hatch.cleanup?.operationNonce === operationNonce &&
          hatch.cleanup.target === target &&
          (!closeDesired || hatch.desiredStatus === "closed")
        )
          return Result.succeed(hatch);
        const stableObservedStatus =
          target === "failed" ? "failed" : target === "sleeping" ? "sleeping" : "stopped";
        if (
          target !== "gone" &&
          hatch.cleanup === undefined &&
          hatch.runtimeEpoch === undefined &&
          hatch.exposure === "closed" &&
          hatch.observedStatus === stableObservedStatus &&
          (!closeDesired || hatch.desiredStatus === "closed")
        )
          return Result.succeed(undefined);
        const record = decodeRecord(await transaction.getRecord());
        if (Result.isFailure(record)) return Result.fail(record.failure);
        if (authority === "operation") {
          const expectedKind =
            target === "gone" ? "vaporize" : target === "sleeping" ? "snapshot" : "hatch";
          if (
            record.success.operation?.nonce !== operationNonce ||
            record.success.operation.kind !== expectedKind
          )
            return Result.fail(changed());
        } else if (authority === "failed_runtime") {
          if (record.success.status !== "failed") return Result.fail(changed());
        } else if (authority === "hard_cap") {
          if (target !== "stopped" || record.success.operation?.kind !== "evidence")
            return Result.fail(changed());
        } else if (authority === "runtime_start") {
          if (target !== "sleeping" || record.success.status === "gone")
            return Result.fail(changed());
        } else if (authority === "scheduled") {
          return Result.fail(changed());
        } else {
          const runtime = await currentRuntime(transaction);
          if (
            hatch.runtimeEpoch === undefined ||
            Result.isFailure(runtime) ||
            runtime.success !== hatch.runtimeEpoch ||
            record.success.status === "gone"
          )
            return Result.fail(changed());
        }
        const generation = hatch.generation + 1;
        if (!Number.isSafeInteger(generation))
          return Result.fail(invalidState("Hatch generation exhausted"));
        const now = new Date(nowMillis).toISOString();
        const next: HatchRecordV1 = {
          ...withoutRuntimeEpoch(hatch),
          generation,
          desiredStatus: closeDesired ? "closed" : hatch.desiredStatus,
          observedStatus:
            target === "failed" ? "failed" : target === "sleeping" ? "sleeping" : "stopped",
          exposure:
            hatch.exposure === "active" || hatch.exposure === "unexpose_pending"
              ? "unexpose_pending"
              : "closed",
          permits: [],
          requests: [],
          transitionNonce: operationNonce,
          cleanup: { operationNonce, target, generation, requestedAt: now },
          updatedAt: now,
        };
        await transaction.putHatch({ version: 1, primary: next });
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
          version: 1,
          primary: {
            ...(target === "gone" ? settled : withoutCleanup(settled)),
            exposure: "closed",
            updatedAt: new Date(nowMillis).toISOString(),
          },
        });
        return Result.succeed(undefined);
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
