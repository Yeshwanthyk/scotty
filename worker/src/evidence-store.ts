import { Clock, Context, Effect, Layer, Option, Result } from "effect";
import {
  conflict,
  decodeSessionRecordResult,
  notFound,
  wrongState,
  type ScottyError,
  type SessionRecord,
} from "./contracts";
import {
  EVIDENCE_JOB_TIMEOUT_MILLIS,
  EVIDENCE_MAX_JOB_BYTES,
  EVIDENCE_MAX_RETAINED_ARTIFACTS,
  EVIDENCE_MAX_RETAINED_JOBS,
  EVIDENCE_MAX_STEPS,
  EVIDENCE_PREVIEW_AGGREGATE_BYTES,
  EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS,
  EVIDENCE_PREVIEW_MAX_CONCURRENT_REQUESTS,
  EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  EvidenceStateError,
  artifactExpiry,
  decodeEvidenceObjectKey,
  decodeStoredEvidenceStateResult,
  emptyEvidencePreviewAccounting,
  emptyEvidenceState,
  evidenceArtifactObjectKey,
  evidenceSummaryProjection,
  findEvidenceJob,
  type BrowserEvidenceJobV1,
  type BrowserEvidenceStepV1,
  type EvidenceActiveJobV1,
  type EvidenceArtifactV1,
  type EvidenceDeleteV1,
  type EvidenceFailure,
  type EvidenceJobStatus,
  type EvidenceJobSummaryV1,
  type EvidencePreviewAccountingV1,
  type EvidencePreviewPermitAdmissionV1,
  type EvidenceStateV1,
  type EvidenceStepResult,
  type EvidenceTerminalStatus,
} from "./evidence-contracts";
import { constantTimeStringEqual } from "./digest";
import type { SessionEvidenceTransaction, SessionRecordStorage } from "./session-store";

export interface AcceptEvidenceJobInput {
  readonly jobId: string;
  readonly operationNonce: string;
  readonly runtimeEpoch: string;
  readonly routeNonce: string;
  readonly deadlineAt: string;
  readonly job: BrowserEvidenceJobV1;
}

export interface BeginEvidencePreviewInput {
  readonly runtimeEpoch: string;
  readonly runtimeRunning: boolean;
}

export interface PublishEvidencePreviewInput extends BeginEvidencePreviewInput {
  readonly cookieDigest: string;
}

export interface AdmitEvidencePreviewInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly port: number;
  readonly routeNonce: string;
  readonly runtimeEpoch: string;
  readonly cookieDigest: string;
  readonly ingressBytes: number;
  readonly runtimeRunning: boolean;
}

export interface ClaimEvidencePreviewInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly port: number;
  readonly routeNonce: string;
  readonly runtimeEpoch: string;
  readonly runtimeRunning: boolean;
}

export interface ClaimedEvidencePreviewPermit {
  readonly operationNonce: string;
  readonly expiresAt: string;
}

export interface CompleteEvidenceStepInput {
  readonly index: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly offsetMillis: number;
  readonly assertions: EvidenceStepResult["assertions"];
  readonly artifact?: EvidenceArtifactV1;
}

interface EvidenceStoreShape {
  readonly read: Effect.Effect<EvidenceStateV1, EvidenceStateError>;
  readonly list: Effect.Effect<ReadonlyArray<EvidenceJobSummaryV1>, EvidenceStateError>;
  readonly getJob: (
    jobId: string,
  ) => Effect.Effect<EvidenceJobSummaryV1, EvidenceStateError | ScottyError>;
  readonly getArtifact: (
    jobId: string,
    frameId: string,
  ) => Effect.Effect<EvidenceArtifactV1, EvidenceStateError | ScottyError>;
  readonly prepareJobCapacity: Effect.Effect<ReadonlyArray<EvidenceArtifactV1>, EvidenceStateError>;
  readonly accept: (
    input: AcceptEvidenceJobInput,
  ) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError | ScottyError>;
  readonly setPhase: (
    nonce: string,
    status: Extract<EvidenceJobStatus, "exposing" | "running" | "finalizing">,
  ) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
  readonly beginPreviewExposure: (
    nonce: string,
    input: BeginEvidencePreviewInput,
  ) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
  readonly publishPreviewExposure: (
    nonce: string,
    input: PublishEvidencePreviewInput,
  ) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
  readonly admitPreview: (
    input: AdmitEvidencePreviewInput,
  ) => Effect.Effect<EvidencePreviewPermitAdmissionV1 | undefined, EvidenceStateError>;
  readonly adjustPreview: (
    requestId: string,
    ingressBytes: number,
  ) => Effect.Effect<boolean, EvidenceStateError>;
  readonly claimPreview: (
    input: ClaimEvidencePreviewInput,
  ) => Effect.Effect<ClaimedEvidencePreviewPermit | undefined, EvidenceStateError>;
  readonly settlePreview: (
    requestId: string,
    responseBytes: number,
  ) => Effect.Effect<void, EvidenceStateError>;
  readonly cancelPreview: (requestId: string) => Effect.Effect<void, EvidenceStateError>;
  readonly expirePreview: (requestId: string) => Effect.Effect<void, EvidenceStateError>;
  readonly revokePreview: (
    nonce: string,
    interruptionReason?: "deadline" | "interrupted",
  ) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
  readonly closePreview: (nonce: string) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
  readonly prepareArtifactUpload: (
    nonce: string,
    index: number,
    artifact: EvidenceArtifactV1,
  ) => Effect.Effect<void, EvidenceStateError>;
  readonly completeStep: (
    nonce: string,
    input: CompleteEvidenceStepInput,
  ) => Effect.Effect<EvidenceStepResult, EvidenceStateError>;
  readonly recordFailure: (
    nonce: string,
    failure: EvidenceFailure,
  ) => Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
  readonly finalize: (
    nonce: string,
    status: EvidenceTerminalStatus,
  ) => Effect.Effect<EvidenceJobSummaryV1, EvidenceStateError>;
  readonly interrupt: (
    nonce: string,
    reason: "deadline" | "interrupted",
  ) => Effect.Effect<EvidenceJobSummaryV1, EvidenceStateError>;
  readonly requestVerifiedDelete: (
    artifact: EvidenceArtifactV1,
    reason: EvidenceDeleteV1["reason"],
  ) => Effect.Effect<EvidenceArtifactV1 | undefined, EvidenceStateError>;
  readonly prepareExpiredDeletes: Effect.Effect<
    ReadonlyArray<EvidenceArtifactV1>,
    EvidenceStateError
  >;
  readonly prepareVaporizeDeletes: (
    nonce: string,
  ) => Effect.Effect<ReadonlyArray<EvidenceArtifactV1>, EvidenceStateError>;
  readonly confirmDelete: (objectKey: string) => Effect.Effect<void, EvidenceStateError>;
  readonly clearForVaporize: (nonce: string) => Effect.Effect<void, EvidenceStateError>;
}

export class EvidenceStore extends Context.Service<EvidenceStore, EvidenceStoreShape>()(
  "scotty/EvidenceStore",
) {}

const INVALID_SESSION = new EvidenceStateError({ reason: "invalid" });
const STORAGE_ERROR = new EvidenceStateError({ reason: "storage" });

const decodeSession = (value: unknown): Result.Result<SessionRecord, EvidenceStateError> =>
  Result.mapError(decodeSessionRecordResult(value), () => INVALID_SESSION);

const decodeState = (
  value: unknown | undefined,
): Result.Result<EvidenceStateV1, EvidenceStateError> =>
  value === undefined
    ? Result.succeed(emptyEvidenceState())
    : Result.mapError(
        decodeStoredEvidenceStateResult(value),
        () => new EvidenceStateError({ reason: "invalid" }),
      );

const requireActive = (
  state: EvidenceStateV1,
  nonce: string,
): Result.Result<EvidenceActiveJobV1, EvidenceStateError> =>
  state.activeJob?.operationNonce === nonce
    ? Result.succeed(state.activeJob)
    : Result.fail(new EvidenceStateError({ reason: "lease_changed" }));

const evidenceStepPlan = (
  step: BrowserEvidenceStepV1,
): EvidenceActiveJobV1["stepPlan"][number] => ({
  name: step.name,
  action: step.action.kind,
  assertions: [step.expect[0].kind, ...step.expect.slice(1).map((assertion) => assertion.kind)],
});

const artifactManifestMatches = (left: EvidenceArtifactV1, right: EvidenceArtifactV1): boolean =>
  left.version === right.version &&
  left.sessionId === right.sessionId &&
  left.jobId === right.jobId &&
  left.frameId === right.frameId &&
  left.objectKey === right.objectKey &&
  left.mediaType === right.mediaType &&
  left.sha256 === right.sha256 &&
  left.bytes === right.bytes &&
  left.capturedAt === right.capturedAt &&
  left.offsetMillis === right.offsetMillis &&
  left.expiresAt === right.expiresAt;

const artifactIsCanonical = (artifact: EvidenceArtifactV1): boolean => {
  const capturedAtMillis = Date.parse(artifact.capturedAt);
  return (
    artifact.objectKey === evidenceArtifactObjectKey(artifact) &&
    Number.isFinite(capturedAtMillis) &&
    artifact.expiresAt === artifactExpiry(capturedAtMillis)
  );
};

const requestDeletes = (
  state: EvidenceStateV1,
  artifacts: ReadonlyArray<EvidenceArtifactV1>,
  reason: EvidenceDeleteV1["reason"],
  requestedAt: string,
): EvidenceStateV1 => {
  const requestedKeys = new Set(artifacts.map((artifact) => artifact.objectKey));
  const pendingKeys = new Set(state.pendingDeletes.map((pending) => pending.objectKey));
  return {
    ...state,
    artifacts: state.artifacts.map((artifact) =>
      requestedKeys.has(artifact.objectKey) ? { ...artifact, status: "delete_pending" } : artifact,
    ),
    pendingDeletes: [
      ...state.pendingDeletes,
      ...artifacts
        .filter((artifact) => !pendingKeys.has(artifact.objectKey))
        .map((artifact) => ({ objectKey: artifact.objectKey, requestedAt, reason })),
    ],
  };
};

const terminalFailure = (
  active: EvidenceActiveJobV1,
  requested: EvidenceTerminalStatus,
  interruptionReason?: "deadline" | "interrupted",
): Pick<EvidenceJobSummaryV1, "status" | "failure"> => {
  const failedStep = active.steps.find((step) => step.status === "failed");
  if (failedStep !== undefined)
    return {
      status: "failed",
      failure: { code: "assertion_mismatch", step: failedStep.index },
    };
  if (requested === "interrupted")
    return { status: requested, failure: { code: interruptionReason ?? "interrupted" } };
  return active.failure === undefined
    ? { status: requested }
    : { status: requested, failure: active.failure };
};

const reservedPermitBytes = (permit: EvidencePreviewAccountingV1["permits"][number]): number =>
  permit.ingressBytes + EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES;

const settlePermitAccounting = (
  accounting: EvidencePreviewAccountingV1,
  requestId: string,
  nowMillis: number,
  responseBytes: number,
  conservative: boolean,
): EvidencePreviewAccountingV1 => {
  const permit = accounting.permits.find((candidate) => candidate.requestId === requestId);
  if (permit === undefined) return accounting;
  const admittedAtMillis = Date.parse(permit.admittedAt);
  const elapsed =
    conservative || !Number.isFinite(admittedAtMillis)
      ? EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS
      : Math.min(
          EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
          Math.max(0, nowMillis - admittedAtMillis),
        );
  return {
    consumedBytes:
      accounting.consumedBytes +
      permit.ingressBytes +
      (conservative ? EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES : responseBytes),
    consumedRequestMillis: accounting.consumedRequestMillis + elapsed,
    permits: accounting.permits.filter((candidate) => candidate.requestId !== requestId),
  };
};

const reconcileExpiredPermits = (
  accounting: EvidencePreviewAccountingV1,
  nowMillis: number,
): EvidencePreviewAccountingV1 =>
  accounting.permits.reduce(
    (current, permit) =>
      !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= nowMillis
        ? settlePermitAccounting(current, permit.requestId, nowMillis, 0, true)
        : current,
    accounting,
  );

const revokePermitAccounting = (
  accounting: EvidencePreviewAccountingV1,
): EvidencePreviewAccountingV1 =>
  accounting.permits.reduce(
    (current, permit) => settlePermitAccounting(current, permit.requestId, 0, 0, true),
    accounting,
  );

export const evidenceStoreLayer = (storage: SessionRecordStorage): Layer.Layer<EvidenceStore> =>
  Layer.succeed(EvidenceStore)(makeEvidenceStore(storage));

const makeEvidenceStore = (storage: SessionRecordStorage): EvidenceStoreShape => {
  const getEvidence = storage.getEvidence;
  const evidenceTransaction = storage.evidenceTransaction;

  const read = Effect.fnUntraced(function* () {
    if (getEvidence === undefined) return yield* new EvidenceStateError({ reason: "storage" });
    const stored = yield* Effect.tryPromise({ try: getEvidence, catch: () => STORAGE_ERROR });
    return yield* Effect.fromResult(decodeState(stored));
  });

  const transact = <A>(
    operation: (
      transaction: SessionEvidenceTransaction,
    ) => Promise<Result.Result<A, EvidenceStateError | ScottyError>>,
  ) => {
    if (evidenceTransaction === undefined)
      return Effect.fail(new EvidenceStateError({ reason: "storage" }));
    return Effect.tryPromise({
      try: () => evidenceTransaction(operation),
      catch: () => STORAGE_ERROR,
    }).pipe(Effect.flatMap(Effect.fromResult));
  };

  const updateActive = (
    nonce: string,
    update: (
      active: EvidenceActiveJobV1,
      state: EvidenceStateV1,
      session: SessionRecord,
    ) => Result.Result<
      { readonly active: EvidenceActiveJobV1; readonly state: EvidenceStateV1 },
      EvidenceStateError
    >,
  ): Effect.Effect<EvidenceActiveJobV1, EvidenceStateError> =>
    transact(async (transaction) => {
      const [storedSession, storedEvidence] = await Promise.all([
        transaction.getRecord(),
        transaction.getEvidence(),
      ]);
      const session = decodeSession(storedSession);
      const state = decodeState(storedEvidence);
      if (Result.isFailure(session)) return Result.fail(session.failure);
      if (Result.isFailure(state)) return Result.fail(state.failure);
      if (
        session.success.operation?.kind !== "evidence" ||
        session.success.operation.nonce !== nonce
      )
        return Result.fail(new EvidenceStateError({ reason: "lease_changed" }));
      const active = requireActive(state.success, nonce);
      if (Result.isFailure(active)) return Result.fail(active.failure);
      const updated = update(active.success, state.success, session.success);
      if (Result.isFailure(updated)) return Result.fail(updated.failure);
      await transaction.putEvidence(updated.success.state);
      return Result.succeed(updated.success.active);
    }) as Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;

  const finalize = Effect.fnUntraced(function* (
    nonce: string,
    requestedStatus: EvidenceTerminalStatus,
    interruptionReason?: "deadline" | "interrupted",
  ) {
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* transact(async (transaction) => {
      const [storedSession, storedEvidence] = await Promise.all([
        transaction.getRecord(),
        transaction.getEvidence(),
      ]);
      const session = decodeSession(storedSession);
      const state = decodeState(storedEvidence);
      if (Result.isFailure(session)) return Result.fail(session.failure);
      if (Result.isFailure(state)) return Result.fail(state.failure);
      if (
        session.success.operation?.kind !== "evidence" ||
        session.success.operation.nonce !== nonce
      )
        return Result.fail(new EvidenceStateError({ reason: "lease_changed" }));
      const active = requireActive(state.success, nonce);
      if (Result.isFailure(active)) return Result.fail(active.failure);
      if (
        active.success.previewCookieDigest !== null ||
        active.success.previewAccounting.permits.length > 0 ||
        (active.success.exposure !== "closed" && active.success.exposure !== "not_exposed")
      )
        return Result.fail(new EvidenceStateError({ reason: "preview_cleanup_pending" }));
      const terminal = terminalFailure(active.success, requestedStatus, interruptionReason);
      const summary: EvidenceJobSummaryV1 = {
        ...evidenceSummaryProjection(active.success),
        ...terminal,
        completedAt: now,
      };
      const allJobs = [summary, ...state.success.jobs];
      const jobs = allJobs.slice(0, EVIDENCE_MAX_RETAINED_JOBS);
      const evictedJobIds = new Set(
        allJobs.slice(EVIDENCE_MAX_RETAINED_JOBS).map((job) => job.jobId),
      );
      const nextState = requestDeletes(
        {
          version: 1,
          nextSequence: state.success.nextSequence,
          jobs,
          artifacts: state.success.artifacts,
          pendingDeletes: state.success.pendingDeletes,
          retainedBytes: state.success.retainedBytes,
        },
        state.success.artifacts.filter(
          (artifact) => evictedJobIds.has(artifact.jobId) && artifact.status === "available",
        ),
        "history_evicted",
        now,
      );
      await transaction.putEvidence(nextState);
      await transaction.putRecord({
        ...session.success,
        operation: null,
        updatedAt: now,
      });
      return Result.succeed(summary);
    }) as Effect.Effect<EvidenceJobSummaryV1, EvidenceStateError>;
  });

  return EvidenceStore.of({
    read: read(),
    list: read().pipe(
      Effect.map((state) =>
        state.activeJob === undefined
          ? state.jobs
          : [evidenceSummaryProjection(state.activeJob), ...state.jobs],
      ),
    ),
    getJob: (jobId) =>
      read().pipe(
        Effect.flatMap((state) => {
          const job = findEvidenceJob(state, jobId);
          return Option.isNone(job) ? Effect.fail(notFound(jobId)) : Effect.succeed(job.value);
        }),
      ),
    getArtifact: (jobId, frameId) =>
      read().pipe(
        Effect.flatMap((state) => {
          const artifact = state.artifacts.find(
            (candidate) =>
              candidate.jobId === jobId &&
              candidate.frameId === frameId &&
              candidate.status === "available",
          );
          return artifact === undefined ? Effect.fail(notFound(frameId)) : Effect.succeed(artifact);
        }),
      ),
    prepareJobCapacity: Effect.fnUntraced(function* () {
      const requestedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        if (state.success.activeJob !== undefined)
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        const cleanupKeys = new Set(
          state.success.pendingDeletes
            .filter((pending) => pending.reason === "history_evicted")
            .map((pending) => pending.objectKey),
        );
        let jobs = [...state.success.jobs];
        const projectedArtifactCount = (): number =>
          state.success.artifacts.filter((artifact) => !cleanupKeys.has(artifact.objectKey)).length;
        while (
          (jobs.length >= EVIDENCE_MAX_RETAINED_JOBS ||
            projectedArtifactCount() > EVIDENCE_MAX_RETAINED_ARTIFACTS - EVIDENCE_MAX_STEPS) &&
          jobs.length > 0
        ) {
          const oldest = jobs.at(-1);
          if (oldest === undefined) break;
          jobs = jobs.slice(0, -1);
          for (const artifact of state.success.artifacts) {
            if (artifact.jobId === oldest.jobId) cleanupKeys.add(artifact.objectKey);
          }
        }
        if (
          jobs.length >= EVIDENCE_MAX_RETAINED_JOBS ||
          projectedArtifactCount() > EVIDENCE_MAX_RETAINED_ARTIFACTS - EVIDENCE_MAX_STEPS
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        const cleanup = state.success.artifacts.filter((artifact) =>
          cleanupKeys.has(artifact.objectKey),
        );
        const requested = requestDeletes(
          { ...state.success, jobs },
          cleanup,
          "history_evicted",
          requestedAt,
        );
        if (jobs.length !== state.success.jobs.length || cleanup.length > 0)
          await transaction.putEvidence(requested);
        return Result.succeed(
          requested.artifacts.filter(
            (artifact) =>
              cleanupKeys.has(artifact.objectKey) && artifact.status === "delete_pending",
          ),
        );
      }) as Effect.Effect<ReadonlyArray<EvidenceArtifactV1>, EvidenceStateError>;
    })(),
    accept: Effect.fnUntraced(function* (input) {
      const acceptedAtMillis = yield* Clock.currentTimeMillis;
      const acceptedAt = new Date(acceptedAtMillis).toISOString();
      return yield* transact(async (transaction) => {
        const [storedSession, storedEvidence, runtimeEpoch] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
          transaction.getRuntimeEpoch(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const record = session.success;
        if (record.status === "gone") return Result.fail(notFound(record.id));
        if (record.status !== "warm") return Result.fail(wrongState(record.status, "evidence"));
        if (record.execution.provider !== "cloudflare")
          return Result.fail(
            wrongState(record.status, "evidence", "Runner-backed evidence is disabled"),
          );
        if (record.operation !== null)
          return Result.fail(conflict(`Session is already running ${record.operation.kind}`));
        const deadlineMillis = Date.parse(input.deadlineAt);
        const hardCapMillis = Date.parse(record.hardCapAt);
        if (
          !Number.isFinite(deadlineMillis) ||
          deadlineMillis <= acceptedAtMillis ||
          deadlineMillis - acceptedAtMillis > EVIDENCE_JOB_TIMEOUT_MILLIS ||
          deadlineMillis > hardCapMillis
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        if (state.success.activeJob !== undefined)
          return Result.fail(conflict("Session already has an active evidence job"));
        if (
          state.success.jobs.length >= EVIDENCE_MAX_RETAINED_JOBS ||
          state.success.artifacts.length > EVIDENCE_MAX_RETAINED_ARTIFACTS - EVIDENCE_MAX_STEPS ||
          state.success.pendingDeletes.some((pending) => pending.reason === "history_evicted")
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        if (runtimeEpoch !== input.runtimeEpoch)
          return Result.fail(new EvidenceStateError({ reason: "preview_unavailable" }));
        const active: EvidenceActiveJobV1 = {
          version: 1,
          sequence: state.success.nextSequence,
          jobId: input.jobId,
          status: "accepted",
          acceptedAt,
          totalSteps: input.job.steps.length,
          completedSteps: 0,
          replay: input.job.capture?.replay ?? false,
          steps: [],
          frameCount: 0,
          operationNonce: input.operationNonce,
          port: input.job.port,
          runtimeEpoch: input.runtimeEpoch,
          routeNonce: input.routeNonce,
          previewCookieDigest: null,
          exposure: "not_exposed",
          previewAccounting: emptyEvidencePreviewAccounting(),
          deadlineAt: input.deadlineAt,
          stepPlan: [
            evidenceStepPlan(input.job.steps[0]),
            ...input.job.steps.slice(1).map(evidenceStepPlan),
          ],
        };
        const nextState: EvidenceStateV1 = {
          ...state.success,
          nextSequence: state.success.nextSequence + 1,
          activeJob: active,
        };
        await transaction.putEvidence(nextState);
        await transaction.putRecord({
          ...record,
          operation: {
            kind: "evidence",
            nonce: input.operationNonce,
            startedAt: acceptedAt,
          },
          updatedAt: acceptedAt,
        });
        return Result.succeed(active);
      });
    }),
    setPhase: (nonce, status) =>
      updateActive(nonce, (active, state) => {
        const next = {
          ...active,
          status,
          startedAt:
            status === "running" ? (active.startedAt ?? active.acceptedAt) : active.startedAt,
        };
        return Result.succeed({ active: next, state: { ...state, activeJob: next } });
      }),
    beginPreviewExposure: Effect.fnUntraced(function* (nonce, input) {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* transact(async (transaction) => {
        const [storedSession, storedEvidence, storedRuntimeEpoch] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
          transaction.getRuntimeEpoch(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = requireActive(state.success, nonce);
        if (Result.isFailure(active)) return Result.fail(active.failure);
        const deadlineMillis = Date.parse(active.success.deadlineAt);
        const hardCapMillis = Date.parse(session.success.hardCapAt);
        if (
          session.success.status !== "warm" ||
          session.success.execution.provider !== "cloudflare" ||
          session.success.operation?.kind !== "evidence" ||
          session.success.operation.nonce !== nonce ||
          active.success.status !== "accepted" ||
          active.success.exposure !== "not_exposed" ||
          active.success.previewCookieDigest !== null ||
          active.success.runtimeEpoch !== input.runtimeEpoch ||
          storedRuntimeEpoch !== input.runtimeEpoch ||
          !input.runtimeRunning ||
          !Number.isFinite(deadlineMillis) ||
          !Number.isFinite(hardCapMillis) ||
          nowMillis >= deadlineMillis ||
          nowMillis >= hardCapMillis ||
          deadlineMillis > hardCapMillis
        )
          return Result.fail(new EvidenceStateError({ reason: "preview_unavailable" }));
        const next: EvidenceActiveJobV1 = {
          ...active.success,
          status: "exposing",
          exposure: "unexpose_pending",
        };
        await transaction.putEvidence({ ...state.success, activeJob: next });
        return Result.succeed(next);
      }) as Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
    }),
    publishPreviewExposure: Effect.fnUntraced(function* (nonce, input) {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* transact(async (transaction) => {
        const [storedSession, storedEvidence, storedRuntimeEpoch] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
          transaction.getRuntimeEpoch(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = requireActive(state.success, nonce);
        if (Result.isFailure(active)) return Result.fail(active.failure);
        const deadlineMillis = Date.parse(active.success.deadlineAt);
        const hardCapMillis = Date.parse(session.success.hardCapAt);
        if (
          session.success.status !== "warm" ||
          session.success.execution.provider !== "cloudflare" ||
          session.success.operation?.kind !== "evidence" ||
          session.success.operation.nonce !== nonce ||
          active.success.status !== "exposing" ||
          active.success.exposure !== "unexpose_pending" ||
          active.success.previewCookieDigest !== null ||
          active.success.runtimeEpoch !== input.runtimeEpoch ||
          storedRuntimeEpoch !== input.runtimeEpoch ||
          !input.runtimeRunning ||
          !Number.isFinite(deadlineMillis) ||
          !Number.isFinite(hardCapMillis) ||
          nowMillis >= deadlineMillis ||
          nowMillis >= hardCapMillis ||
          deadlineMillis > hardCapMillis
        )
          return Result.fail(new EvidenceStateError({ reason: "preview_unavailable" }));
        const next: EvidenceActiveJobV1 = {
          ...active.success,
          exposure: "active",
          previewCookieDigest: input.cookieDigest,
        };
        await transaction.putEvidence({ ...state.success, activeJob: next });
        return Result.succeed(next);
      }) as Effect.Effect<EvidenceActiveJobV1, EvidenceStateError>;
    }),
    admitPreview: Effect.fnUntraced(function* (input) {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* transact(async (transaction) => {
        const [storedSession, storedEvidence, storedRuntimeEpoch] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
          transaction.getRuntimeEpoch(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = state.success.activeJob;
        if (active === undefined) return Result.succeed(undefined);
        const accounting = reconcileExpiredPermits(active.previewAccounting, nowMillis);
        const deadlineMillis = Date.parse(active.deadlineAt);
        const hardCapMillis = Date.parse(session.success.hardCapAt);
        const digestMatches =
          active.previewCookieDigest === null
            ? false
            : await constantTimeStringEqual(active.previewCookieDigest, input.cookieDigest);
        const reservedBytes = accounting.permits.reduce(
          (total, permit) => total + reservedPermitBytes(permit),
          0,
        );
        const admittedBytes = input.ingressBytes + EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES;
        const authorized =
          session.success.id === input.sessionId &&
          session.success.status === "warm" &&
          session.success.execution.provider === "cloudflare" &&
          session.success.operation?.kind === "evidence" &&
          session.success.operation.nonce === active.operationNonce &&
          active.port === input.port &&
          active.routeNonce === input.routeNonce &&
          active.runtimeEpoch === input.runtimeEpoch &&
          storedRuntimeEpoch === input.runtimeEpoch &&
          active.exposure === "active" &&
          digestMatches &&
          input.runtimeRunning &&
          Number.isFinite(deadlineMillis) &&
          Number.isFinite(hardCapMillis) &&
          nowMillis < deadlineMillis &&
          nowMillis < hardCapMillis &&
          deadlineMillis <= hardCapMillis &&
          accounting.permits.length < EVIDENCE_PREVIEW_MAX_CONCURRENT_REQUESTS &&
          !accounting.permits.some((permit) => permit.requestId === input.requestId) &&
          accounting.consumedBytes + reservedBytes + admittedBytes <=
            EVIDENCE_PREVIEW_AGGREGATE_BYTES &&
          accounting.consumedRequestMillis +
            (accounting.permits.length + 1) * EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS <=
            EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS;
        if (!authorized) {
          if (accounting !== active.previewAccounting) {
            const reconciled = { ...active, previewAccounting: accounting };
            await transaction.putEvidence({ ...state.success, activeJob: reconciled });
          }
          return Result.succeed(undefined);
        }
        const expiresAtMillis = Math.min(
          nowMillis + EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
          deadlineMillis,
          hardCapMillis,
        );
        const expiresAt = new Date(expiresAtMillis).toISOString();
        const next: EvidenceActiveJobV1 = {
          ...active,
          previewAccounting: {
            ...accounting,
            permits: [
              ...accounting.permits,
              {
                requestId: input.requestId,
                state: "admitted",
                cookieDigest: input.cookieDigest,
                ingressBytes: input.ingressBytes,
                admittedAt: new Date(nowMillis).toISOString(),
                expiresAt,
              },
            ],
          },
        };
        await transaction.putEvidence({ ...state.success, activeJob: next });
        return Result.succeed({ requestId: input.requestId, expiresAt });
      }) as Effect.Effect<EvidencePreviewPermitAdmissionV1 | undefined, EvidenceStateError>;
    }),
    adjustPreview: Effect.fnUntraced(function* (requestId, ingressBytes) {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = state.success.activeJob;
        if (active === undefined) return Result.succeed(false);
        const accounting = reconcileExpiredPermits(active.previewAccounting, nowMillis);
        const permit = accounting.permits.find((candidate) => candidate.requestId === requestId);
        const accepted = permit?.state === "admitted" && ingressBytes <= permit.ingressBytes;
        const adjusted = accepted
          ? {
              ...accounting,
              permits: accounting.permits.map((candidate) =>
                candidate.requestId === requestId ? { ...candidate, ingressBytes } : candidate,
              ),
            }
          : accounting;
        if (adjusted !== active.previewAccounting) {
          await transaction.putEvidence({
            ...state.success,
            activeJob: { ...active, previewAccounting: adjusted },
          });
        }
        return Result.succeed(accepted);
      }) as Effect.Effect<boolean, EvidenceStateError>;
    }),
    claimPreview: Effect.fnUntraced(function* (input) {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* transact(async (transaction) => {
        const [storedSession, storedEvidence, storedRuntimeEpoch] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
          transaction.getRuntimeEpoch(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = state.success.activeJob;
        if (active === undefined) return Result.succeed(undefined);
        const accounting = reconcileExpiredPermits(active.previewAccounting, nowMillis);
        const permit = accounting.permits.find(
          (candidate) => candidate.requestId === input.requestId,
        );
        const deadlineMillis = Date.parse(active.deadlineAt);
        const hardCapMillis = Date.parse(session.success.hardCapAt);
        const authorized =
          permit?.state === "admitted" &&
          permit.cookieDigest === active.previewCookieDigest &&
          session.success.id === input.sessionId &&
          session.success.status === "warm" &&
          session.success.execution.provider === "cloudflare" &&
          session.success.operation?.kind === "evidence" &&
          session.success.operation.nonce === active.operationNonce &&
          active.port === input.port &&
          active.routeNonce === input.routeNonce &&
          active.runtimeEpoch === input.runtimeEpoch &&
          storedRuntimeEpoch === input.runtimeEpoch &&
          active.exposure === "active" &&
          input.runtimeRunning &&
          Number.isFinite(deadlineMillis) &&
          Number.isFinite(hardCapMillis) &&
          nowMillis < Date.parse(permit.expiresAt) &&
          nowMillis < deadlineMillis &&
          nowMillis < hardCapMillis &&
          deadlineMillis <= hardCapMillis;
        const nextAccounting = authorized
          ? {
              ...accounting,
              permits: accounting.permits.map((candidate) =>
                candidate.requestId === input.requestId
                  ? { ...candidate, state: "claimed" as const }
                  : candidate,
              ),
            }
          : permit === undefined
            ? accounting
            : settlePermitAccounting(accounting, input.requestId, nowMillis, 0, true);
        if (nextAccounting !== active.previewAccounting) {
          const next = { ...active, previewAccounting: nextAccounting };
          await transaction.putEvidence({ ...state.success, activeJob: next });
        }
        return Result.succeed(
          authorized
            ? { operationNonce: active.operationNonce, expiresAt: permit.expiresAt }
            : undefined,
        );
      }) as Effect.Effect<ClaimedEvidencePreviewPermit | undefined, EvidenceStateError>;
    }),
    settlePreview: Effect.fnUntraced(function* (requestId, responseBytes) {
      const nowMillis = yield* Clock.currentTimeMillis;
      yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = state.success.activeJob;
        if (active === undefined) return Result.succeed(undefined);
        const reconciled = reconcileExpiredPermits(active.previewAccounting, nowMillis);
        const permit = reconciled.permits.find((candidate) => candidate.requestId === requestId);
        const accounting =
          permit === undefined
            ? reconciled
            : settlePermitAccounting(
                reconciled,
                requestId,
                nowMillis,
                responseBytes,
                permit.state !== "claimed",
              );
        if (accounting !== active.previewAccounting) {
          await transaction.putEvidence({
            ...state.success,
            activeJob: { ...active, previewAccounting: accounting },
          });
        }
        return Result.succeed(undefined);
      }) as Effect.Effect<void, EvidenceStateError>;
    }),
    cancelPreview: Effect.fnUntraced(function* (requestId) {
      const nowMillis = yield* Clock.currentTimeMillis;
      yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = state.success.activeJob;
        if (active === undefined) return Result.succeed(undefined);
        const reconciled = reconcileExpiredPermits(active.previewAccounting, nowMillis);
        const permit = reconciled.permits.find((candidate) => candidate.requestId === requestId);
        const accounting =
          permit === undefined
            ? reconciled
            : settlePermitAccounting(reconciled, requestId, nowMillis, 0, false);
        if (accounting !== active.previewAccounting) {
          await transaction.putEvidence({
            ...state.success,
            activeJob: { ...active, previewAccounting: accounting },
          });
        }
        return Result.succeed(undefined);
      }) as Effect.Effect<void, EvidenceStateError>;
    }),
    expirePreview: Effect.fnUntraced(function* (requestId) {
      const nowMillis = yield* Clock.currentTimeMillis;
      yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const active = state.success.activeJob;
        const permit = active?.previewAccounting.permits.find(
          (candidate) => candidate.requestId === requestId,
        );
        if (active === undefined || permit === undefined) return Result.succeed(undefined);
        const accounting = settlePermitAccounting(
          active.previewAccounting,
          requestId,
          nowMillis,
          0,
          true,
        );
        await transaction.putEvidence({
          ...state.success,
          activeJob: { ...active, previewAccounting: accounting },
        });
        return Result.succeed(undefined);
      }) as Effect.Effect<void, EvidenceStateError>;
    }),
    revokePreview: (nonce, interruptionReason) =>
      updateActive(nonce, (active, state) => {
        const hasExposure = active.exposure === "active" || active.exposure === "unexpose_pending";
        const next: EvidenceActiveJobV1 = {
          ...active,
          status: interruptionReason === undefined ? "finalizing" : "interrupted",
          exposure: hasExposure ? "unexpose_pending" : "closed",
          previewCookieDigest: null,
          previewAccounting: revokePermitAccounting(active.previewAccounting),
          ...(interruptionReason === undefined ? {} : { failure: { code: interruptionReason } }),
        };
        return Result.succeed({ active: next, state: { ...state, activeJob: next } });
      }),
    closePreview: (nonce) =>
      updateActive(nonce, (active, state) => {
        if (active.previewCookieDigest !== null || active.previewAccounting.permits.length > 0)
          return Result.fail(new EvidenceStateError({ reason: "preview_cleanup_pending" }));
        const next: EvidenceActiveJobV1 = { ...active, exposure: "closed" };
        return Result.succeed({ active: next, state: { ...state, activeJob: next } });
      }),
    prepareArtifactUpload: Effect.fnUntraced(function* (nonce, index, artifact) {
      const requestedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* updateActive(nonce, (active, state, session) => {
        if (
          index !== active.steps.length ||
          index >= active.stepPlan.length ||
          artifact.sessionId !== session.id ||
          artifact.jobId !== active.jobId ||
          artifact.status !== "delete_pending" ||
          !artifactIsCanonical(artifact) ||
          state.artifacts.some(
            (candidate) =>
              candidate.objectKey === artifact.objectKey ||
              (candidate.jobId === artifact.jobId && candidate.frameId === artifact.frameId),
          )
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        const jobBytes = state.artifacts
          .filter((candidate) => candidate.jobId === active.jobId)
          .reduce((total, candidate) => total + candidate.bytes, 0);
        if (jobBytes + artifact.bytes > EVIDENCE_MAX_JOB_BYTES)
          return Result.fail(new EvidenceStateError({ reason: "over_budget" }));
        if (
          state.artifacts.length >= EVIDENCE_MAX_RETAINED_ARTIFACTS ||
          state.pendingDeletes.length >= EVIDENCE_MAX_RETAINED_ARTIFACTS
        )
          return Result.fail(new EvidenceStateError({ reason: "over_budget" }));
        const withIntent: EvidenceStateV1 = {
          ...state,
          artifacts: [...state.artifacts, artifact],
          retainedBytes: state.retainedBytes + artifact.bytes,
        };
        return Result.succeed({
          active,
          state: requestDeletes(withIntent, [artifact], "abandoned", requestedAt),
        });
      });
    }),
    completeStep: Effect.fnUntraced(function* (nonce, input) {
      const active = yield* updateActive(nonce, (current, state, session) => {
        if (input.index !== current.steps.length || input.index >= current.stepPlan.length)
          return Result.fail(new EvidenceStateError({ reason: "step_out_of_order" }));
        const plan = current.stepPlan[input.index];
        if (
          plan === undefined ||
          input.assertions.length !== plan.assertions.length ||
          input.assertions.some((assertion, index) => assertion.kind !== plan.assertions[index])
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        const artifact = input.artifact;
        const intent =
          artifact === undefined
            ? undefined
            : state.artifacts.find((candidate) => candidate.objectKey === artifact.objectKey);
        if (
          artifact !== undefined &&
          (artifact.sessionId !== session.id ||
            artifact.jobId !== current.jobId ||
            artifact.status !== "available" ||
            artifact.offsetMillis !== input.offsetMillis ||
            !artifactIsCanonical(artifact) ||
            intent?.status !== "delete_pending" ||
            !artifactManifestMatches(intent, artifact) ||
            !state.pendingDeletes.some(
              (pending) =>
                pending.objectKey === artifact.objectKey && pending.reason === "abandoned",
            ))
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        const passed = input.assertions.every((assertion) => assertion.passed);
        const step: EvidenceStepResult = {
          index: input.index,
          name: plan.name,
          action: plan.action,
          status: passed ? "passed" : "failed",
          assertions: input.assertions,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          offsetMillis: input.offsetMillis,
          ...(artifact === undefined
            ? {}
            : {
                frame: {
                  frameId: artifact.frameId,
                  sha256: artifact.sha256,
                  bytes: artifact.bytes,
                  capturedAt: artifact.capturedAt,
                  offsetMillis: artifact.offsetMillis,
                },
              }),
        };
        const next: EvidenceActiveJobV1 = {
          ...current,
          status: "running",
          startedAt: current.startedAt ?? input.startedAt,
          completedSteps: current.completedSteps + 1,
          steps: [...current.steps, step],
          frameCount: current.frameCount + (artifact === undefined ? 0 : 1),
        };
        return Result.succeed({
          active: next,
          state: {
            ...state,
            activeJob: next,
            artifacts:
              artifact === undefined
                ? state.artifacts
                : state.artifacts.map((candidate) =>
                    candidate.objectKey === artifact.objectKey ? artifact : candidate,
                  ),
            pendingDeletes:
              artifact === undefined
                ? state.pendingDeletes
                : state.pendingDeletes.filter(
                    (pending) => pending.objectKey !== artifact.objectKey,
                  ),
          },
        });
      });
      const completed = active.steps.at(-1);
      if (completed === undefined)
        return yield* new EvidenceStateError({ reason: "step_out_of_order" });
      return completed;
    }),
    recordFailure: (nonce, failure) =>
      updateActive(nonce, (active, state) => {
        const next: EvidenceActiveJobV1 = { ...active, failure };
        return Result.succeed({ active: next, state: { ...state, activeJob: next } });
      }),
    finalize,
    interrupt: (nonce, reason) => finalize(nonce, "interrupted", reason),
    requestVerifiedDelete: Effect.fnUntraced(function* (artifact, reason) {
      if (!artifactIsCanonical(artifact))
        return yield* new EvidenceStateError({ reason: "invalid" });
      const requestedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const existing = state.success.artifacts.find(
          (candidate) => candidate.objectKey === artifact.objectKey,
        );
        if (existing !== undefined) {
          if (!artifactManifestMatches(existing, artifact))
            return Result.fail(new EvidenceStateError({ reason: "invalid" }));
          const pending: EvidenceArtifactV1 = { ...existing, status: "delete_pending" };
          if (
            existing.status === "available" ||
            !state.success.pendingDeletes.some(
              (candidate) => candidate.objectKey === existing.objectKey,
            )
          )
            await transaction.putEvidence(
              requestDeletes(state.success, [pending], reason, requestedAt),
            );
          return Result.succeed(pending);
        }
        if (
          state.success.artifacts.length >= EVIDENCE_MAX_RETAINED_ARTIFACTS ||
          state.success.pendingDeletes.length >= EVIDENCE_MAX_RETAINED_ARTIFACTS
        )
          return Result.fail(new EvidenceStateError({ reason: "over_budget" }));
        const pending: EvidenceArtifactV1 = { ...artifact, status: "delete_pending" };
        const withArtifact: EvidenceStateV1 = {
          ...state.success,
          artifacts: [...state.success.artifacts, pending],
          retainedBytes: state.success.retainedBytes + pending.bytes,
        };
        await transaction.putEvidence(requestDeletes(withArtifact, [pending], reason, requestedAt));
        return Result.succeed(pending);
      }) as Effect.Effect<EvidenceArtifactV1 | undefined, EvidenceStateError>;
    }),
    prepareExpiredDeletes: Effect.fnUntraced(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const requestedAt = new Date(nowMillis).toISOString();
      return yield* transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const expired = state.success.artifacts.filter(
          (artifact) =>
            artifact.status === "available" && Date.parse(artifact.expiresAt) <= nowMillis,
        );
        if (expired.length > 0)
          await transaction.putEvidence(
            requestDeletes(state.success, expired, "expired", requestedAt),
          );
        return Result.succeed(
          expired.map((artifact) => ({ ...artifact, status: "delete_pending" })),
        );
      }) as Effect.Effect<ReadonlyArray<EvidenceArtifactV1>, EvidenceStateError>;
    })(),
    prepareVaporizeDeletes: Effect.fnUntraced(function* (nonce) {
      const requestedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* transact(async (transaction) => {
        const [storedSession, storedEvidence] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        if (
          session.success.operation?.kind !== "vaporize" ||
          session.success.operation.nonce !== nonce
        )
          return Result.fail(new EvidenceStateError({ reason: "lease_changed" }));
        const requested = requestDeletes(
          state.success,
          state.success.artifacts,
          "vaporize",
          requestedAt,
        );
        if (state.success.artifacts.length > 0) await transaction.putEvidence(requested);
        return Result.succeed(requested.artifacts);
      }) as Effect.Effect<ReadonlyArray<EvidenceArtifactV1>, EvidenceStateError>;
    }),
    confirmDelete: (objectKey) => {
      if (Option.isNone(decodeEvidenceObjectKey(objectKey)))
        return Effect.fail(new EvidenceStateError({ reason: "invalid" }));
      return transact(async (transaction) => {
        const state = decodeState(await transaction.getEvidence());
        if (Result.isFailure(state)) return Result.fail(state.failure);
        const artifact = state.success.artifacts.find(
          (candidate) => candidate.objectKey === objectKey,
        );
        const pending = state.success.pendingDeletes.some(
          (candidate) => candidate.objectKey === objectKey,
        );
        if (artifact === undefined || artifact.status !== "delete_pending" || !pending)
          return Result.fail(new EvidenceStateError({ reason: "missing" }));
        await transaction.putEvidence({
          ...state.success,
          artifacts: state.success.artifacts.filter(
            (candidate) => candidate.objectKey !== objectKey,
          ),
          pendingDeletes: state.success.pendingDeletes.filter(
            (candidate) => candidate.objectKey !== objectKey,
          ),
          retainedBytes: state.success.retainedBytes - artifact.bytes,
        });
        return Result.succeed(undefined);
      }) as Effect.Effect<void, EvidenceStateError>;
    },
    clearForVaporize: (nonce) =>
      transact(async (transaction) => {
        const [storedSession, storedEvidence] = await Promise.all([
          transaction.getRecord(),
          transaction.getEvidence(),
        ]);
        const session = decodeSession(storedSession);
        const state = decodeState(storedEvidence);
        if (Result.isFailure(session)) return Result.fail(session.failure);
        if (Result.isFailure(state)) return Result.fail(state.failure);
        if (
          session.success.operation?.kind !== "vaporize" ||
          session.success.operation.nonce !== nonce
        )
          return Result.fail(new EvidenceStateError({ reason: "lease_changed" }));
        if (
          state.success.activeJob !== undefined ||
          state.success.artifacts.length > 0 ||
          state.success.pendingDeletes.length > 0
        )
          return Result.fail(new EvidenceStateError({ reason: "invalid" }));
        await transaction.deleteEvidence();
        return Result.succeed(undefined);
      }) as Effect.Effect<void, EvidenceStateError>,
  });
};
