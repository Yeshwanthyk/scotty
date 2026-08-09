import { Option, Schema } from "effect";

export const EVIDENCE_STATE_VERSION = 2 as const;
export const EVIDENCE_MAX_STEPS = 12;
export const EVIDENCE_MAX_ASSERTIONS_PER_STEP = 4;
export const EVIDENCE_TOOL_MAX_PROTOCOL_BYTES = 64 * 1_024;
export const EVIDENCE_MAX_FRAME_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const EVIDENCE_MAX_JOB_BYTES = 64 * 1024 * 1024;
export const EVIDENCE_MAX_RETAINED_JOBS = 100;
export const EVIDENCE_MAX_ARTIFACTS_PER_JOB = EVIDENCE_MAX_STEPS + 1;
export const EVIDENCE_MAX_RETAINED_ARTIFACTS =
  EVIDENCE_MAX_RETAINED_JOBS * EVIDENCE_MAX_ARTIFACTS_PER_JOB;
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
    /^evidence\/v2\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:png|webm)$/u,
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

export const BrowserEvidenceStepV2Schema = Schema.Struct({
  name: BoundedNameSchema,
  action: EvidenceActionSchema,
  expect: Schema.NonEmptyArray(EvidenceAssertionSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
});
export type BrowserEvidenceStepV2 = typeof BrowserEvidenceStepV2Schema.Type;

export const BrowserEvidenceJobV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  port: PositivePortSchema,
  viewport: Schema.Struct({
    width: Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 1_920 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1_080 })),
  }),
  steps: Schema.NonEmptyArray(BrowserEvidenceStepV2Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_STEPS),
  ),
  capture: Schema.Struct({
    screenshots: Schema.Literal("after-each-step"),
    video: Schema.Boolean,
  }),
});
export type BrowserEvidenceJobV2 = typeof BrowserEvidenceJobV2Schema.Type;

export const decodeBrowserEvidenceJob = Schema.decodeUnknownOption(BrowserEvidenceJobV2Schema, {
  onExcessProperty: "error",
});
export const decodeBrowserEvidenceJobEffect = Schema.decodeUnknownEffect(
  BrowserEvidenceJobV2Schema,
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

export const EvidenceWorkflowOperationSchema = Schema.Literals([
  "validate",
  "preview",
  "phase",
  "browser",
  "action",
  "assertion",
  "screenshot",
  "video",
  "publish",
  "finalize",
]);
export const EvidenceWorkflowReasonSchema = Schema.Literals([
  "invalid",
  "unsupported",
  "ambiguous",
  "assertion",
  "deadline",
  "cleanup",
  "state",
  "upstream",
]);
const LegacyKitesurfDiagnosticSchema = Schema.Struct({
  operation: Schema.Literals([
    "launch",
    "verify_session",
    "create_context",
    "install_network_guard",
    "install_cookie",
    "create_page",
    "goto",
    "click",
    "fill",
    "press",
    "visible",
    "text_exact",
    "count",
    "url_path",
    "screenshot",
    "close_page",
    "close_context",
    "close_browser",
  ]),
  reason: Schema.Literals(["ambiguous", "cleanup", "unsupported"]),
});
export const EvidenceDiagnosticSchema = Schema.Struct({
  operation: EvidenceWorkflowOperationSchema,
  reason: EvidenceWorkflowReasonSchema,
  step: Schema.optionalKey(
    NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS - 1)),
  ),
  // Temporary read compatibility so the last pre-v97 sandbox can be vaporized authoritatively.
  kitesurf: Schema.optionalKey(LegacyKitesurfDiagnosticSchema),
});
export type EvidenceDiagnostic = typeof EvidenceDiagnosticSchema.Type;

export const EvidenceAssertionResultSchema = Schema.Struct({
  kind: EvidenceAssertionKindSchema,
  passed: Schema.Boolean,
  expected: Schema.optionalKey(BoundedValueSchema),
  actual: Schema.optionalKey(BoundedValueSchema),
});
export type EvidenceAssertionResult = typeof EvidenceAssertionResultSchema.Type;

const EvidenceFrameUploadV2Schema = Schema.Struct({
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

export const CompleteEvidenceStepPublicationV2Schema = Schema.Struct({
  index: NonNegativeIntSchema,
  startedAt: Schema.String,
  completedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  assertions: Schema.NonEmptyArray(EvidenceAssertionResultSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
  frame: Schema.optionalKey(EvidenceFrameUploadV2Schema),
});
export type CompleteEvidenceStepPublicationV2 = typeof CompleteEvidenceStepPublicationV2Schema.Type;
export const decodeCompleteEvidenceStepPublication = Schema.decodeUnknownEffect(
  CompleteEvidenceStepPublicationV2Schema,
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
export const EvidenceArtifactV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  sessionId: IdentifierSchema,
  jobId: IdentifierSchema,
  frameId: IdentifierSchema,
  objectKey: EvidenceObjectKeySchema,
  mediaType: Schema.Literals(["image/png", "video/webm"]),
  sha256: Sha256Schema,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_VIDEO_BYTES })),
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  expiresAt: Schema.String,
  status: EvidenceArtifactStatusSchema,
}).check(
  Schema.makeFilter(
    (artifact) => artifact.mediaType === "video/webm" || artifact.bytes <= EVIDENCE_MAX_FRAME_BYTES,
    { expected: "a media-specific bounded evidence artifact" },
  ),
);
export type EvidenceArtifactV2 = typeof EvidenceArtifactV2Schema.Type;

export const CompleteEvidenceVideoPublicationV2Schema = Schema.Struct({
  artifactId: Schema.Literal("recording"),
  bytes: Schema.Uint8Array.check(
    Schema.makeFilter(
      (bytes) => bytes.byteLength > 0 && bytes.byteLength <= EVIDENCE_MAX_VIDEO_BYTES,
      { expected: "bounded WebM bytes" },
    ),
  ),
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
});
export type CompleteEvidenceVideoPublicationV2 =
  typeof CompleteEvidenceVideoPublicationV2Schema.Type;
export const decodeCompleteEvidenceVideoPublication = Schema.decodeUnknownEffect(
  CompleteEvidenceVideoPublicationV2Schema,
  { onExcessProperty: "error" },
);

export const EvidenceVideoProjectionSchema = Schema.Struct({
  artifactId: Schema.Literal("recording"),
  sha256: Sha256Schema,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_VIDEO_BYTES })),
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
});
export type EvidenceVideoProjection = typeof EvidenceVideoProjectionSchema.Type;

export const EvidenceDeleteV2Schema = Schema.Struct({
  objectKey: EvidenceObjectKeySchema,
  requestedAt: Schema.String,
  reason: Schema.Literals(["abandoned", "expired", "history_evicted", "vaporize"]),
});
export type EvidenceDeleteV2 = typeof EvidenceDeleteV2Schema.Type;

export const EvidenceJobSummaryV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  sequence: NonNegativeIntSchema,
  jobId: IdentifierSchema,
  status: EvidenceJobStatusSchema,
  acceptedAt: Schema.String,
  startedAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.String),
  totalSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_STEPS })),
  completedSteps: NonNegativeIntSchema,
  viewport: Schema.Struct({
    width: Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 1_920 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1_080 })),
  }),
  recordVideo: Schema.Boolean,
  flowHash: Sha256Schema,
  video: Schema.optionalKey(EvidenceVideoProjectionSchema),
  steps: Schema.Array(EvidenceStepResultSchema).check(Schema.isMaxLength(EVIDENCE_MAX_STEPS)),
  frameCount: NonNegativeIntSchema,
  failure: Schema.optionalKey(EvidenceFailureSchema),
  diagnostic: Schema.optionalKey(EvidenceDiagnosticSchema),
});
export type EvidenceJobSummaryV2 = typeof EvidenceJobSummaryV2Schema.Type;

const EvidenceStepPlanSchema = Schema.Struct({
  name: BoundedNameSchema,
  action: EvidenceActionKindSchema,
  assertions: Schema.NonEmptyArray(EvidenceAssertionKindSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
});

const EvidenceActiveJobBaseSchema = Schema.Struct({
  ...EvidenceJobSummaryV2Schema.fields,
  operationNonce: IdentifierSchema,
  port: PositivePortSchema,
  runtimeEpoch: IdentifierSchema,
  deadlineAt: Schema.String,
  stepPlan: Schema.NonEmptyArray(EvidenceStepPlanSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_STEPS),
  ),
});

const EvidenceActiveJobPreviewSchema = Schema.Struct({
  ...EvidenceActiveJobBaseSchema.fields,
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

export const EvidencePreviewPermitV2Schema = Schema.Struct({
  requestId: EvidencePreviewRequestIdSchema,
  state: Schema.Literals(["admitted", "claimed"]),
  cookieDigest: Sha256Schema,
  ingressBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_MAX_INGRESS_BYTES }),
  ),
  admittedAt: Schema.String,
  expiresAt: Schema.String,
});
export type EvidencePreviewPermitV2 = typeof EvidencePreviewPermitV2Schema.Type;
export const decodeEvidencePreviewIngressBytes = Schema.decodeUnknownOption(
  EvidencePreviewPermitV2Schema.fields.ingressBytes,
);

export const EvidencePreviewAccountingV2Schema = Schema.Struct({
  consumedBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_AGGREGATE_BYTES }),
  ),
  consumedRequestMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS }),
  ),
  permits: Schema.Array(EvidencePreviewPermitV2Schema).check(
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
export type EvidencePreviewAccountingV2 = typeof EvidencePreviewAccountingV2Schema.Type;

export const emptyEvidencePreviewAccounting = (): EvidencePreviewAccountingV2 => ({
  consumedBytes: 0,
  consumedRequestMillis: 0,
  permits: [],
});

export const EvidenceActiveJobV2Schema = Schema.Struct({
  ...EvidenceActiveJobPreviewSchema.fields,
  previewAccounting: EvidencePreviewAccountingV2Schema,
});
export type EvidenceActiveJobV2 = typeof EvidenceActiveJobV2Schema.Type;

export const EvidencePreviewAuthorizationV2Schema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  port: PositivePortSchema,
  routeNonce: EvidenceRouteNonceSchema,
  cookieSecret: PreviewCookieSecretSchema,
});
export type EvidencePreviewAuthorizationV2 = typeof EvidencePreviewAuthorizationV2Schema.Type;

export const EvidencePreviewAdmissionV2Schema = Schema.Struct({
  ...EvidencePreviewAuthorizationV2Schema.fields,
  ingressBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EVIDENCE_PREVIEW_MAX_INGRESS_BYTES }),
  ),
});
export type EvidencePreviewAdmissionV2 = typeof EvidencePreviewAdmissionV2Schema.Type;
export const decodeEvidencePreviewAdmission = Schema.decodeUnknownOption(
  EvidencePreviewAdmissionV2Schema,
  { onExcessProperty: "error" },
);

export interface EvidencePreviewPermitAdmissionV2 {
  readonly requestId: string;
  readonly expiresAt: string;
}

export interface ExposedEvidencePreviewV2 {
  readonly origin: string;
  readonly cookieSecret: string;
  readonly expiresAt: string;
}

const EvidenceStateV2CommonFields = {
  version: Schema.Literal(EVIDENCE_STATE_VERSION),
  nextSequence: NonNegativeIntSchema,
  jobs: Schema.Array(EvidenceJobSummaryV2Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_RETAINED_JOBS),
  ),
  artifacts: Schema.Array(EvidenceArtifactV2Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_RETAINED_ARTIFACTS),
  ),
  pendingDeletes: Schema.Array(EvidenceDeleteV2Schema).check(
    Schema.isMaxLength(EVIDENCE_MAX_RETAINED_ARTIFACTS),
  ),
  retainedBytes: NonNegativeIntSchema,
};

export const EvidenceStateV2Schema = Schema.Struct({
  ...EvidenceStateV2CommonFields,
  activeJob: Schema.optionalKey(EvidenceActiveJobV2Schema),
});
export type EvidenceStateV2 = typeof EvidenceStateV2Schema.Type;

export const emptyEvidenceState = (): EvidenceStateV2 => ({
  version: EVIDENCE_STATE_VERSION,
  nextSequence: 0,
  jobs: [],
  artifacts: [],
  pendingDeletes: [],
  retainedBytes: 0,
});

export const decodeEvidenceStateResult = Schema.decodeUnknownResult(EvidenceStateV2Schema, {
  onExcessProperty: "error",
});

export const decodeStoredEvidenceStateResult = decodeEvidenceStateResult;

export const BrowserEvidenceResultV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  jobId: IdentifierSchema,
  status: EvidenceTerminalStatusSchema,
  summaryUrl: Schema.String,
  completedSteps: NonNegativeIntSchema,
  frameCount: NonNegativeIntSchema,
  video: Schema.Boolean,
  failure: Schema.optionalKey(EvidenceFailureSchema),
});
export type BrowserEvidenceResultV2 = typeof BrowserEvidenceResultV2Schema.Type;

const EvidenceSummaryPathSchema = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^\/s\/[0-9a-f]{12}\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
);

export const BrowserEvidenceToolResultV2Schema = Schema.Struct({
  ...BrowserEvidenceResultV2Schema.fields,
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
export type BrowserEvidenceToolResultV2 = typeof BrowserEvidenceToolResultV2Schema.Type;
// Cloudflare RPC may attach transport-only fields to a returned object. Decode and project the
// allow-listed tool result instead of letting harmless transport metadata hide a committed job.
export const decodeBrowserEvidenceToolResult = Schema.decodeUnknownOption(
  BrowserEvidenceToolResultV2Schema,
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

export const PublicEvidenceJobSummaryV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  sequence: NonNegativeIntSchema,
  jobId: IdentifierSchema,
  status: EvidenceJobStatusSchema,
  acceptedAt: Schema.String,
  startedAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.String),
  totalSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: EVIDENCE_MAX_STEPS })),
  completedSteps: NonNegativeIntSchema,
  viewport: EvidenceJobSummaryV2Schema.fields.viewport,
  recordVideo: Schema.Boolean,
  flowHash: Sha256Schema,
  video: Schema.optionalKey(EvidenceVideoProjectionSchema),
  steps: Schema.Array(PublicEvidenceStepResultSchema).check(Schema.isMaxLength(EVIDENCE_MAX_STEPS)),
  frameCount: NonNegativeIntSchema,
  failure: Schema.optionalKey(EvidenceFailureSchema),
});
export type PublicEvidenceJobSummaryV2 = typeof PublicEvidenceJobSummaryV2Schema.Type;

export interface PublicEvidenceShowcaseV2 {
  readonly version: 2;
  readonly before: PublicEvidenceJobSummaryV2;
  readonly after: PublicEvidenceJobSummaryV2;
  readonly paths: {
    readonly hatch: string;
    readonly video: string;
  };
}

const completeProofRun = (job: PublicEvidenceJobSummaryV2): boolean =>
  job.status === "succeeded" &&
  job.completedSteps === job.totalSteps &&
  job.frameCount === job.totalSteps &&
  job.steps.length === job.totalSteps &&
  job.steps.every(
    (step) =>
      step.status === "passed" &&
      step.frame !== undefined &&
      step.assertions.every((assertion) => assertion.passed),
  );

export const evidenceShowcaseProjection = (
  sessionId: string,
  before: PublicEvidenceJobSummaryV2,
  after: PublicEvidenceJobSummaryV2,
): PublicEvidenceShowcaseV2 | undefined => {
  if (
    !completeProofRun(before) ||
    !completeProofRun(after) ||
    before.recordVideo ||
    !after.recordVideo ||
    after.video === undefined ||
    before.flowHash !== after.flowHash ||
    before.viewport.width !== after.viewport.width ||
    before.viewport.height !== after.viewport.height
  )
    return undefined;
  return {
    version: 2,
    before,
    after,
    paths: {
      hatch: `/s/${sessionId}/hatch/open`,
      video: `/s/${sessionId}/evidence/${after.jobId}/video.webm`,
    },
  };
};

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
      "invalid_webm",
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
  artifact: Pick<EvidenceArtifactV2, "sessionId" | "jobId" | "frameId"> & {
    readonly mediaType?: EvidenceArtifactV2["mediaType"];
  },
): string =>
  `evidence/v2/${artifact.sessionId}/${artifact.jobId}/${artifact.frameId}.${artifact.mediaType === "video/webm" ? "webm" : "png"}`;

export const artifactExpiry = (capturedAtMillis: number): string =>
  new Date(capturedAtMillis + EVIDENCE_RETENTION_MILLIS).toISOString();

export const evidenceSummaryProjection = (
  job: EvidenceActiveJobV2 | EvidenceJobSummaryV2,
): EvidenceJobSummaryV2 => ({
  version: 2,
  sequence: job.sequence,
  jobId: job.jobId,
  status: job.status,
  acceptedAt: job.acceptedAt,
  ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
  ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
  totalSteps: job.totalSteps,
  completedSteps: job.completedSteps,
  viewport: job.viewport,
  recordVideo: job.recordVideo,
  flowHash: job.flowHash,
  ...(job.video === undefined ? {} : { video: job.video }),
  steps: job.steps,
  frameCount: job.frameCount,
  ...(job.failure === undefined ? {} : { failure: job.failure }),
  ...(job.diagnostic === undefined ? {} : { diagnostic: job.diagnostic }),
});

export const publicEvidenceSummaryProjection = (
  job: EvidenceActiveJobV2 | EvidenceJobSummaryV2,
): PublicEvidenceJobSummaryV2 => ({
  version: 2,
  sequence: job.sequence,
  jobId: job.jobId,
  status: job.status,
  acceptedAt: job.acceptedAt,
  ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
  ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
  totalSteps: job.totalSteps,
  completedSteps: job.completedSteps,
  viewport: job.viewport,
  recordVideo: job.recordVideo,
  flowHash: job.flowHash,
  ...(job.video === undefined ? {} : { video: job.video }),
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
  frameCount: job.frameCount,
  ...(job.failure === undefined ? {} : { failure: job.failure }),
  // Internal diagnostics are durable but never part of the public summary contract.
});

export const findEvidenceJob = (
  state: EvidenceStateV2,
  jobId: string,
): Option.Option<EvidenceJobSummaryV2> => {
  if (state.activeJob?.jobId === jobId)
    return Option.some(evidenceSummaryProjection(state.activeJob));
  const completed = state.jobs.find((job) => job.jobId === jobId);
  return completed === undefined ? Option.none() : Option.some(completed);
};
