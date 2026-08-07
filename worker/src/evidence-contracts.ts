import { Option, Result, Schema } from "effect";

export const EVIDENCE_STATE_VERSION = 1 as const;
export const EVIDENCE_MAX_STEPS = 12;
export const EVIDENCE_MAX_ASSERTIONS_PER_STEP = 4;
export const EVIDENCE_TOOL_MAX_PROTOCOL_BYTES = 64 * 1_024;
export const EVIDENCE_MAX_FRAME_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MAX_JOB_BYTES = 40 * 1024 * 1024;
export const EVIDENCE_MAX_RETAINED_JOBS = 100;
export const EVIDENCE_MAX_RETAINED_ARTIFACTS = EVIDENCE_MAX_RETAINED_JOBS * EVIDENCE_MAX_STEPS;
export const EVIDENCE_JOB_TIMEOUT_MILLIS = 5 * 60 * 1_000;
export const EVIDENCE_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1_000;
export const EVIDENCE_PREVIEW_MAX_CONCURRENT_REQUESTS = 4;
export const EVIDENCE_PREVIEW_MAX_INGRESS_BYTES = 16 * 1_024 * 1_024;
export const EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES = 16 * 1_024 * 1_024;
export const EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS = 30_000;
export const EVIDENCE_PREVIEW_AGGREGATE_BYTES = 64 * 1_024 * 1_024;
export const EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS = 120_000;
export const EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER = "x-scotty-preview-request";
export const EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER = "x-scotty-preview-claimed";

const BoundedNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(120));
const BoundedValueSchema = Schema.String.check(Schema.isMaxLength(512));
export const EvidenceIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
);
const IdentifierSchema = EvidenceIdentifierSchema;
export const decodeEvidenceIdentifier = Schema.decodeUnknownOption(EvidenceIdentifierSchema);
export const EvidenceObjectKeySchema = Schema.String.check(
  Schema.isPattern(
    /^evidence\/v1\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.png$/u,
  ),
);
export const decodeEvidenceObjectKey = Schema.decodeUnknownOption(EvidenceObjectKeySchema);
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const EVIDENCE_RESERVED_PORTS = new Set([3_000, 43_117]);
const PositivePortSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1_024, maximum: 65_535 }),
  Schema.makeFilter((port) => !EVIDENCE_RESERVED_PORTS.has(port), {
    expected: "an evidence app port that is not reserved by Scotty or Sandbox",
  }),
);
export const EvidenceRouteNonceSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{16}$/u));
const PreviewCookieSecretSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RelativePathSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => value.startsWith("/") && !value.startsWith("//") && value.length <= 2_048,
    { expected: "a bounded same-origin absolute path" },
  ),
);

export const EvidenceLocatorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("testId"), value: BoundedValueSchema }),
  Schema.Struct({ kind: Schema.Literal("css"), value: BoundedValueSchema }),
]);
export type EvidenceLocator = typeof EvidenceLocatorSchema.Type;

export const EvidenceActionKindSchema = Schema.Literals(["goto", "click", "fill", "press"]);
export type EvidenceActionKind = typeof EvidenceActionKindSchema.Type;

export const EvidenceActionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("goto"), path: RelativePathSchema }),
  Schema.Struct({ kind: Schema.Literal("click"), locator: EvidenceLocatorSchema }),
  Schema.Struct({
    kind: Schema.Literal("fill"),
    locator: EvidenceLocatorSchema,
    value: Schema.String.check(Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    locator: EvidenceLocatorSchema,
    key: Schema.Literals([
      "Enter",
      "Escape",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Backspace",
      "Delete",
      "Space",
    ]),
  }),
]);
export type EvidenceAction = typeof EvidenceActionSchema.Type;

export const EvidenceAssertionKindSchema = Schema.Literals([
  "visible",
  "textExact",
  "count",
  "urlPath",
]);
export type EvidenceAssertionKind = typeof EvidenceAssertionKindSchema.Type;

export const EvidenceAssertionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("visible"),
    locator: EvidenceLocatorSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("textExact"),
    locator: EvidenceLocatorSchema,
    expected: BoundedValueSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("count"),
    locator: EvidenceLocatorSchema,
    expected: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(1_000)),
  }),
  Schema.Struct({
    kind: Schema.Literal("urlPath"),
    expected: RelativePathSchema,
  }),
]);
export type EvidenceAssertion = typeof EvidenceAssertionSchema.Type;

export const BrowserEvidenceStepV1Schema = Schema.Struct({
  name: BoundedNameSchema,
  action: EvidenceActionSchema,
  expect: Schema.NonEmptyArray(EvidenceAssertionSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
});
export type BrowserEvidenceStepV1 = typeof BrowserEvidenceStepV1Schema.Type;

export const BrowserEvidenceJobV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  port: PositivePortSchema,
  viewport: Schema.optionalKey(
    Schema.Struct({
      width: Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 1_920 })),
      height: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1_080 })),
    }),
  ),
  steps: Schema.NonEmptyArray(BrowserEvidenceStepV1Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_STEPS),
  ),
  capture: Schema.optionalKey(
    Schema.Struct({
      screenshots: Schema.Literal("after-each-step"),
      replay: Schema.Boolean,
    }),
  ),
});
export type BrowserEvidenceJobV1 = typeof BrowserEvidenceJobV1Schema.Type;

export const decodeBrowserEvidenceJob = Schema.decodeUnknownOption(BrowserEvidenceJobV1Schema, {
  onExcessProperty: "error",
});
export const decodeBrowserEvidenceJobEffect = Schema.decodeUnknownEffect(
  BrowserEvidenceJobV1Schema,
  { onExcessProperty: "error" },
);

export const EvidenceJobStatusSchema = Schema.Literals([
  "accepted",
  "exposing",
  "running",
  "finalizing",
  "succeeded",
  "failed",
  "interrupted",
  "unsupported",
]);
export type EvidenceJobStatus = typeof EvidenceJobStatusSchema.Type;

export const EvidenceTerminalStatusSchema = Schema.Literals([
  "succeeded",
  "failed",
  "interrupted",
  "unsupported",
]);
export type EvidenceTerminalStatus = typeof EvidenceTerminalStatusSchema.Type;

export const EvidenceFailureCodeSchema = Schema.Literals([
  "assertion_mismatch",
  "artifact_invalid",
  "artifact_over_budget",
  "artifact_put_unknown",
  "deadline",
  "interrupted",
  "unsupported",
]);
export type EvidenceFailureCode = typeof EvidenceFailureCodeSchema.Type;

export const EvidenceFailureSchema = Schema.Struct({
  code: EvidenceFailureCodeSchema,
  step: Schema.optionalKey(NonNegativeIntSchema),
});
export type EvidenceFailure = typeof EvidenceFailureSchema.Type;

export const EvidenceAssertionResultSchema = Schema.Struct({
  kind: EvidenceAssertionKindSchema,
  passed: Schema.Boolean,
  expected: Schema.optionalKey(BoundedValueSchema),
  actual: Schema.optionalKey(BoundedValueSchema),
});
export type EvidenceAssertionResult = typeof EvidenceAssertionResultSchema.Type;

const EvidenceFrameUploadV1Schema = Schema.Struct({
  frameId: IdentifierSchema,
  bytes: Schema.Uint8Array.check(
    Schema.makeFilter(
      (bytes) => bytes.byteLength > 0 && bytes.byteLength <= EVIDENCE_MAX_FRAME_BYTES,
      { expected: "bounded screenshot bytes" },
    ),
  ),
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
});

export const CompleteEvidenceStepPublicationV1Schema = Schema.Struct({
  index: NonNegativeIntSchema,
  startedAt: Schema.String,
  completedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  assertions: Schema.NonEmptyArray(EvidenceAssertionResultSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
  frame: Schema.optionalKey(EvidenceFrameUploadV1Schema),
});
export type CompleteEvidenceStepPublicationV1 = typeof CompleteEvidenceStepPublicationV1Schema.Type;
export const decodeCompleteEvidenceStepPublication = Schema.decodeUnknownEffect(
  CompleteEvidenceStepPublicationV1Schema,
  { onExcessProperty: "error" },
);

export const EvidenceFrameProjectionSchema = Schema.Struct({
  frameId: IdentifierSchema,
  sha256: Sha256Schema,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_FRAME_BYTES })),
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
});
export type EvidenceFrameProjection = typeof EvidenceFrameProjectionSchema.Type;

export const EvidenceStepResultSchema = Schema.Struct({
  index: NonNegativeIntSchema,
  name: BoundedNameSchema,
  action: EvidenceActionKindSchema,
  status: Schema.Literals(["passed", "failed"]),
  assertions: Schema.NonEmptyArray(EvidenceAssertionResultSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
  startedAt: Schema.String,
  completedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  frame: Schema.optionalKey(EvidenceFrameProjectionSchema),
});
export type EvidenceStepResult = typeof EvidenceStepResultSchema.Type;

export const EvidenceArtifactStatusSchema = Schema.Literals(["available", "delete_pending"]);
export const EvidenceArtifactV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: IdentifierSchema,
  jobId: IdentifierSchema,
  frameId: IdentifierSchema,
  objectKey: EvidenceObjectKeySchema,
  mediaType: Schema.Literal("image/png"),
  sha256: Sha256Schema,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_FRAME_BYTES })),
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  expiresAt: Schema.String,
  status: EvidenceArtifactStatusSchema,
});
export type EvidenceArtifactV1 = typeof EvidenceArtifactV1Schema.Type;

export const EvidenceDeleteV1Schema = Schema.Struct({
  objectKey: EvidenceObjectKeySchema,
  requestedAt: Schema.String,
  reason: Schema.Literals(["abandoned", "expired", "history_evicted", "vaporize"]),
});
export type EvidenceDeleteV1 = typeof EvidenceDeleteV1Schema.Type;

export const EvidenceJobSummaryV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeIntSchema,
  jobId: IdentifierSchema,
  status: EvidenceJobStatusSchema,
  acceptedAt: Schema.String,
  startedAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.String),
  totalSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_STEPS })),
  completedSteps: NonNegativeIntSchema,
  replay: Schema.Boolean,
  steps: Schema.Array(EvidenceStepResultSchema).check(Schema.isMaxLength(EVIDENCE_MAX_STEPS)),
  frameCount: NonNegativeIntSchema,
  failure: Schema.optionalKey(EvidenceFailureSchema),
});
export type EvidenceJobSummaryV1 = typeof EvidenceJobSummaryV1Schema.Type;

const EvidenceStepPlanSchema = Schema.Struct({
  name: BoundedNameSchema,
  action: EvidenceActionKindSchema,
  assertions: Schema.NonEmptyArray(EvidenceAssertionKindSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
});

const LegacyEvidenceActiveJobV1Schema = Schema.Struct({
  ...EvidenceJobSummaryV1Schema.fields,
  operationNonce: IdentifierSchema,
  port: PositivePortSchema,
  runtimeEpoch: IdentifierSchema,
  deadlineAt: Schema.String,
  stepPlan: Schema.NonEmptyArray(EvidenceStepPlanSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_STEPS),
  ),
});

const UnaccountedEvidenceActiveJobV1Schema = Schema.Struct({
  ...LegacyEvidenceActiveJobV1Schema.fields,
  routeNonce: EvidenceRouteNonceSchema,
  previewCookieDigest: Schema.NullOr(Sha256Schema),
  exposure: Schema.Literals(["not_exposed", "active", "unexpose_pending", "closed"]),
});

export const EvidencePreviewRequestIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/u),
);
export const decodeEvidencePreviewRequestId = Schema.decodeUnknownOption(
  EvidencePreviewRequestIdSchema,
);

export const EvidencePreviewPermitV1Schema = Schema.Struct({
  requestId: EvidencePreviewRequestIdSchema,
  state: Schema.Literals(["admitted", "claimed"]),
  cookieDigest: Sha256Schema,
  ingressBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_MAX_INGRESS_BYTES }),
  ),
  admittedAt: Schema.String,
  expiresAt: Schema.String,
});
export type EvidencePreviewPermitV1 = typeof EvidencePreviewPermitV1Schema.Type;
export const decodeEvidencePreviewIngressBytes = Schema.decodeUnknownOption(
  EvidencePreviewPermitV1Schema.fields.ingressBytes,
);

export const EvidencePreviewAccountingV1Schema = Schema.Struct({
  consumedBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_AGGREGATE_BYTES }),
  ),
  consumedRequestMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS }),
  ),
  permits: Schema.Array(EvidencePreviewPermitV1Schema).check(
    Schema.isMaxLength(EVIDENCE_PREVIEW_MAX_CONCURRENT_REQUESTS),
  ),
}).check(
  Schema.makeFilter(
    (accounting) =>
      new Set(accounting.permits.map((permit) => permit.requestId)).size ===
        accounting.permits.length &&
      accounting.consumedBytes +
        accounting.permits.reduce(
          (total, permit) => total + permit.ingressBytes + EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
          0,
        ) <=
        EVIDENCE_PREVIEW_AGGREGATE_BYTES &&
      accounting.consumedRequestMillis +
        accounting.permits.length * EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS <=
        EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS,
    { expected: "bounded unique preview permit reservations" },
  ),
);
export type EvidencePreviewAccountingV1 = typeof EvidencePreviewAccountingV1Schema.Type;

export const emptyEvidencePreviewAccounting = (): EvidencePreviewAccountingV1 => ({
  consumedBytes: 0,
  consumedRequestMillis: 0,
  permits: [],
});

export const EvidenceActiveJobV1Schema = Schema.Struct({
  ...UnaccountedEvidenceActiveJobV1Schema.fields,
  previewAccounting: EvidencePreviewAccountingV1Schema,
});
export type EvidenceActiveJobV1 = typeof EvidenceActiveJobV1Schema.Type;

export const EvidencePreviewAuthorizationV1Schema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  port: PositivePortSchema,
  routeNonce: EvidenceRouteNonceSchema,
  cookieSecret: PreviewCookieSecretSchema,
});
export type EvidencePreviewAuthorizationV1 = typeof EvidencePreviewAuthorizationV1Schema.Type;

export const EvidencePreviewAdmissionV1Schema = Schema.Struct({
  ...EvidencePreviewAuthorizationV1Schema.fields,
  ingressBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_MAX_INGRESS_BYTES }),
  ),
});
export type EvidencePreviewAdmissionV1 = typeof EvidencePreviewAdmissionV1Schema.Type;
export const decodeEvidencePreviewAdmission = Schema.decodeUnknownOption(
  EvidencePreviewAdmissionV1Schema,
  { onExcessProperty: "error" },
);

export interface EvidencePreviewPermitAdmissionV1 {
  readonly requestId: string;
  readonly expiresAt: string;
}

export interface ExposedEvidencePreviewV1 {
  readonly origin: string;
  readonly cookieSecret: string;
  readonly expiresAt: string;
}

const EvidenceStateV1CommonFields = {
  version: Schema.Literal(EVIDENCE_STATE_VERSION),
  nextSequence: NonNegativeIntSchema,
  jobs: Schema.Array(EvidenceJobSummaryV1Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_RETAINED_JOBS),
  ),
  artifacts: Schema.Array(EvidenceArtifactV1Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_RETAINED_ARTIFACTS),
  ),
  pendingDeletes: Schema.Array(EvidenceDeleteV1Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_RETAINED_ARTIFACTS),
  ),
  retainedBytes: NonNegativeIntSchema,
};

const LegacyEvidenceStateV1Schema = Schema.Struct({
  ...EvidenceStateV1CommonFields,
  activeJob: Schema.optionalKey(LegacyEvidenceActiveJobV1Schema),
});

const UnaccountedEvidenceStateV1Schema = Schema.Struct({
  ...EvidenceStateV1CommonFields,
  activeJob: Schema.optionalKey(UnaccountedEvidenceActiveJobV1Schema),
});

export const EvidenceStateV1Schema = Schema.Struct({
  ...EvidenceStateV1CommonFields,
  activeJob: Schema.optionalKey(EvidenceActiveJobV1Schema),
});
export type EvidenceStateV1 = typeof EvidenceStateV1Schema.Type;

export const emptyEvidenceState = (): EvidenceStateV1 => ({
  version: EVIDENCE_STATE_VERSION,
  nextSequence: 0,
  jobs: [],
  artifacts: [],
  pendingDeletes: [],
  retainedBytes: 0,
});

export const decodeEvidenceStateResult = Schema.decodeUnknownResult(EvidenceStateV1Schema, {
  onExcessProperty: "error",
});

const decodeUnaccountedEvidenceStateResult = Schema.decodeUnknownResult(
  UnaccountedEvidenceStateV1Schema,
  { onExcessProperty: "error" },
);

const decodeLegacyEvidenceStateResult = Schema.decodeUnknownResult(LegacyEvidenceStateV1Schema, {
  onExcessProperty: "error",
});

export const EVIDENCE_COMPATIBILITY_ROUTE_NONCE = "legacy_closed_v1";

const closeUnaccountedPreview = (
  state: typeof UnaccountedEvidenceStateV1Schema.Type,
): EvidenceStateV1 => {
  const { activeJob, ...rest } = state;
  if (activeJob === undefined) return rest;
  const mayRemainExposed =
    activeJob.exposure === "active" || activeJob.exposure === "unexpose_pending";
  return {
    ...rest,
    activeJob: {
      ...activeJob,
      status: "interrupted",
      failure: { code: "interrupted" },
      previewCookieDigest: null,
      exposure: mayRemainExposed ? "unexpose_pending" : "closed",
      previewAccounting: emptyEvidencePreviewAccounting(),
    },
  };
};

export const decodeStoredEvidenceStateResult = (value: unknown) => {
  const current = decodeEvidenceStateResult(value);
  if (Result.isSuccess(current)) return current;
  const unaccounted = decodeUnaccountedEvidenceStateResult(value);
  if (Result.isSuccess(unaccounted))
    return Result.succeed(closeUnaccountedPreview(unaccounted.success));
  return Result.map(decodeLegacyEvidenceStateResult(value), (legacy): EvidenceStateV1 => {
    const { activeJob, ...state } = legacy;
    return activeJob === undefined
      ? state
      : {
          ...state,
          activeJob: {
            ...activeJob,
            status: "interrupted",
            failure: { code: "interrupted" },
            routeNonce: EVIDENCE_COMPATIBILITY_ROUTE_NONCE,
            previewCookieDigest: null,
            exposure: "closed",
            previewAccounting: emptyEvidencePreviewAccounting(),
          },
        };
  });
};

export const BrowserEvidenceResultV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  jobId: IdentifierSchema,
  status: EvidenceTerminalStatusSchema,
  summaryUrl: Schema.String,
  completedSteps: NonNegativeIntSchema,
  frameCount: NonNegativeIntSchema,
  failure: Schema.optionalKey(EvidenceFailureSchema),
});
export type BrowserEvidenceResultV1 = typeof BrowserEvidenceResultV1Schema.Type;

const EvidenceSummaryPathSchema = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^\/s\/[0-9a-f]{12}\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
);

export const BrowserEvidenceToolResultV1Schema = Schema.Struct({
  ...BrowserEvidenceResultV1Schema.fields,
  summaryUrl: EvidenceSummaryPathSchema,
  completedSteps: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS)),
  frameCount: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS)),
  failure: Schema.optionalKey(
    Schema.Struct({
      code: EvidenceFailureCodeSchema,
      step: Schema.optionalKey(
        NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS - 1)),
      ),
    }),
  ),
}).check(
  Schema.makeFilter((result) => result.summaryUrl.endsWith(`/evidence/${result.jobId}`), {
    expected: "an authenticated summary path for the returned evidence job",
  }),
);
export type BrowserEvidenceToolResultV1 = typeof BrowserEvidenceToolResultV1Schema.Type;
export const decodeBrowserEvidenceToolResult = Schema.decodeUnknownOption(
  BrowserEvidenceToolResultV1Schema,
  { onExcessProperty: "error" },
);

const PublicEvidenceAssertionResultSchema = Schema.Struct({
  kind: EvidenceAssertionKindSchema,
  passed: Schema.Boolean,
});

const PublicEvidenceStepResultSchema = Schema.Struct({
  index: NonNegativeIntSchema,
  name: BoundedNameSchema,
  action: EvidenceActionKindSchema,
  status: Schema.Literals(["passed", "failed"]),
  assertions: Schema.NonEmptyArray(PublicEvidenceAssertionResultSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
  startedAt: Schema.String,
  completedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  frame: Schema.optionalKey(EvidenceFrameProjectionSchema),
});

export const PublicEvidenceJobSummaryV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeIntSchema,
  jobId: IdentifierSchema,
  status: EvidenceJobStatusSchema,
  acceptedAt: Schema.String,
  startedAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.String),
  totalSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_STEPS })),
  completedSteps: NonNegativeIntSchema,
  replay: Schema.Boolean,
  steps: Schema.Array(PublicEvidenceStepResultSchema).check(Schema.isMaxLength(EVIDENCE_MAX_STEPS)),
  frameCount: NonNegativeIntSchema,
  failure: Schema.optionalKey(EvidenceFailureSchema),
});
export type PublicEvidenceJobSummaryV1 = typeof PublicEvidenceJobSummaryV1Schema.Type;

export class EvidenceStateError extends Schema.TaggedErrorClass<EvidenceStateError>()(
  "EvidenceStateError",
  {
    reason: Schema.Literals([
      "invalid",
      "missing",
      "lease_changed",
      "step_out_of_order",
      "storage",
      "over_budget",
      "preview_unavailable",
      "preview_cleanup_pending",
    ]),
  },
) {}

export class EvidenceArtifactError extends Schema.TaggedErrorClass<EvidenceArtifactError>()(
  "EvidenceArtifactError",
  {
    operation: Schema.Literals(["validate", "hash", "put", "head", "open", "delete"]),
    reason: Schema.Literals([
      "invalid_png",
      "over_budget",
      "put_unknown",
      "metadata_mismatch",
      "missing",
      "invalid_state",
      "upstream",
    ]),
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export const evidenceArtifactObjectKey = (
  artifact: Pick<EvidenceArtifactV1, "sessionId" | "jobId" | "frameId">,
): string => `evidence/v1/${artifact.sessionId}/${artifact.jobId}/${artifact.frameId}.png`;

export const artifactExpiry = (capturedAtMillis: number): string =>
  new Date(capturedAtMillis + EVIDENCE_RETENTION_MILLIS).toISOString();

export const evidenceSummaryProjection = (
  job: EvidenceActiveJobV1 | EvidenceJobSummaryV1,
): EvidenceJobSummaryV1 => ({
  version: 1,
  sequence: job.sequence,
  jobId: job.jobId,
  status: job.status,
  acceptedAt: job.acceptedAt,
  ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
  ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
  totalSteps: job.totalSteps,
  completedSteps: job.completedSteps,
  replay: job.replay,
  steps: job.steps,
  frameCount: job.frameCount,
  ...(job.failure === undefined ? {} : { failure: job.failure }),
});

export const publicEvidenceSummaryProjection = (
  job: EvidenceActiveJobV1 | EvidenceJobSummaryV1,
): PublicEvidenceJobSummaryV1 => ({
  ...evidenceSummaryProjection(job),
  steps: job.steps.map((step) => ({
    ...step,
    assertions: [
      {
        kind: step.assertions[0].kind,
        passed: step.assertions[0].passed,
      },
      ...step.assertions.slice(1).map((assertion) => ({
        kind: assertion.kind,
        passed: assertion.passed,
      })),
    ],
  })),
});

export const findEvidenceJob = (
  state: EvidenceStateV1,
  jobId: string,
): Option.Option<EvidenceJobSummaryV1> => {
  if (state.activeJob?.jobId === jobId)
    return Option.some(evidenceSummaryProjection(state.activeJob));
  const completed = state.jobs.find((job) => job.jobId === jobId);
  return completed === undefined ? Option.none() : Option.some(completed);
};
