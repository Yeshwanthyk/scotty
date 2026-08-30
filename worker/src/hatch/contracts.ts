import { Data, Option, Schema } from "effect";

export const HATCH_STATE_VERSION = 1 as const;
export const HATCH_COOKIE = "__Host-scotty-hatch";
export const HATCH_HANDOFF_PATH = "/_scotty/hatch/handoff";
export const HATCH_READINESS_PATH = "/_scotty/hatch/readiness";
export const HATCH_MAX_CONCURRENT_REQUESTS = 8;
export const HATCH_MAX_CONCURRENT_SOCKETS = 4;
export const HATCH_MAX_WEBSOCKET_MESSAGE_BYTES = 1 * 1_024 * 1_024;
export const HATCH_MAX_WEBSOCKET_MESSAGES = 10_000;
export const HATCH_MAX_WEBSOCKET_AGGREGATE_BYTES = 64 * 1_024 * 1_024;
export const HATCH_WEBSOCKET_IDLE_MILLIS = 60_000;
export const HATCH_WEBSOCKET_ABSOLUTE_MILLIS = 60 * 60 * 1_000;
export const HATCH_WEBSOCKET_ADMISSION_MILLIS = 10_000;
export const HATCH_MAX_INGRESS_BYTES = 16 * 1_024 * 1_024;
export const HATCH_RESERVED_RESPONSE_BYTES = 32 * 1_024 * 1_024;
export const HATCH_MAX_PERMIT_BYTES = 256 * 1_024 * 1_024;
export const HATCH_REQUEST_DURATION_MILLIS = 30_000;
export const HATCH_PERMIT_DURATION_MILLIS = 60 * 60 * 1_000;
export const HATCH_PRIVATE_REQUEST_HEADER = "x-scotty-hatch-request";
export const HATCH_PRIVATE_CLAIMED_HEADER = "x-scotty-hatch-claimed";
export const HATCH_PRIVATE_READINESS_HEADER = "x-scotty-hatch-readiness";
export const HATCH_PRIVATE_READINESS_CLAIMED_HEADER = "x-scotty-hatch-readiness-claimed";
export const HATCH_PRIVATE_WEBSOCKET_HEADER = "x-scotty-hatch-websocket";
export const HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER = "x-scotty-hatch-websocket-claimed";
export const HATCH_RESERVED_PORTS = new Set([3_000, 43_117]);

const IdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
);
const SessionIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u));
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const IsoTimestampSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const millis = Date.parse(value);
      return Number.isFinite(millis) && new Date(millis).toISOString() === value;
    },
    { expected: "a canonical ISO 8601 timestamp" },
  ),
);
const PortSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1_024, maximum: 65_535 }),
  Schema.makeFilter((port) => !HATCH_RESERVED_PORTS.has(port), {
    expected: "a Hatch service port that is not reserved by Scotty or Sandbox",
  }),
);
// New route nonces use only lowercase alphanumerics: Cloudflare custom exposure tokens reject
// hyphens, while underscores make the resulting host invalid for DNS and CSP form-action.
// Keep the underscore form readable so existing persisted Hatch records can still be cleaned up.
const RouteNonceSchema = Schema.String.check(
  Schema.isPattern(/^(?:h[a-z0-9]{14}|h_[a-z0-9_]{14})$/u),
);
const CookieSecretSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RequestIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const WebSocketIdSchema = RequestIdSchema;
const HatchHostSchema = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.makeFilter(
    (value) => value === value.toLowerCase() && !value.includes(":") && !value.endsWith("."),
    { expected: "a canonical Hatch host" },
  ),
);
const AbsoluteWorkspacePathSchema = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      path.startsWith("/workspace/") &&
      path.length <= 1_024 &&
      !path.includes("\0") &&
      !path.split("/").includes(".."),
    { expected: "a bounded absolute path inside /workspace" },
  ),
);
const HealthPathSchema = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      path.startsWith("/") &&
      !path.startsWith("//") &&
      !path.includes("\\") &&
      !path.includes("#") &&
      [...path].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }) &&
      path.length <= 2_048,
    { expected: "a bounded same-origin absolute health path" },
  ),
);
const ArgSchema = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("\0"), { expected: "an argument without NUL" }),
);

export const HatchServiceSchema = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
  argv: Schema.NonEmptyArray(ArgSchema).check(
    Schema.isMaxLength(64),
    Schema.makeFilter((argv) => (argv[0]?.length ?? 0) > 0, {
      expected: "a non-empty Hatch command",
    }),
  ),
  workingDirectory: AbsoluteWorkspacePathSchema,
  port: PortSchema,
  healthPath: HealthPathSchema,
});
export type HatchService = typeof HatchServiceSchema.Type;

export const EnsureHatchInputSchema = Schema.Struct({
  service: HatchServiceSchema,
});
export type EnsureHatchInput = typeof EnsureHatchInputSchema.Type;
export const decodeEnsureHatchInput = Schema.decodeUnknownOption(EnsureHatchInputSchema, {
  onExcessProperty: "error",
});

export const decodeHatchToolEnsureRequest = Schema.decodeUnknownOption(EnsureHatchInputSchema, {
  onExcessProperty: "error",
});

export const HatchDesiredStatusSchema = Schema.Literals(["open", "closed"]);
export const HatchObservedStatusSchema = Schema.Literals([
  "starting",
  "running",
  "sleeping",
  "unhealthy",
  "stopped",
  "failed",
]);
export const HatchExposureSchema = Schema.Literals([
  "not_exposed",
  "active",
  "unexpose_pending",
  "closed",
]);

export const HatchBrowserPermitSchema = Schema.Struct({
  permitId: IdentifierSchema,
  browserClientId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  cookieDigest: Sha256Schema,
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  ingressBytes: NonNegativeIntSchema,
  responseBytes: NonNegativeIntSchema,
});
export type HatchBrowserPermit = typeof HatchBrowserPermitSchema.Type;

export const HatchHttpRequestSchema = Schema.Struct({
  requestId: RequestIdSchema,
  permitId: IdentifierSchema,
  generation: PositiveIntSchema,
  runtimeEpoch: IdentifierSchema,
  reservedIngressBytes: NonNegativeIntSchema,
  ingressBytes: Schema.optionalKey(NonNegativeIntSchema),
  reservedResponseBytes: PositiveIntSchema,
  status: Schema.Literals(["admitted", "claimed"]),
  admittedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
});
export type HatchHttpRequest = typeof HatchHttpRequestSchema.Type;

export const HatchCleanupTargetSchema = Schema.Literals([
  "failed",
  "sleeping",
  "stopped",
  "unhealthy",
  "gone",
]);
export type HatchCleanupTarget = typeof HatchCleanupTargetSchema.Type;
export const HatchCleanupRetrySchema = Schema.Struct({
  operationNonce: IdentifierSchema,
  target: HatchCleanupTargetSchema,
  closeDesired: Schema.Boolean,
});
export type HatchCleanupRetry = typeof HatchCleanupRetrySchema.Type;
export const decodeHatchCleanupRetry = Schema.decodeUnknownOption(HatchCleanupRetrySchema, {
  onExcessProperty: "error",
});
const HatchCleanupSchema = Schema.Struct({
  operationNonce: IdentifierSchema,
  target: HatchCleanupTargetSchema,
  generation: PositiveIntSchema,
  requestedAt: IsoTimestampSchema,
});

const HatchRecordBaseSchema = Schema.Struct({
  hatchId: IdentifierSchema,
  sessionId: SessionIdSchema,
  generation: PositiveIntSchema,
  service: HatchServiceSchema,
  desiredStatus: HatchDesiredStatusSchema,
  observedStatus: HatchObservedStatusSchema,
  runtimeEpoch: Schema.optionalKey(IdentifierSchema),
  exposure: HatchExposureSchema,
  routeNonce: RouteNonceSchema,
  permits: Schema.Array(HatchBrowserPermitSchema).check(Schema.isMaxLength(64)),
  requests: Schema.Array(HatchHttpRequestSchema).check(
    Schema.isMaxLength(HATCH_MAX_CONCURRENT_REQUESTS),
  ),
  transitionNonce: Schema.optionalKey(IdentifierSchema),
  cleanup: Schema.optionalKey(HatchCleanupSchema),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastHealthyAt: Schema.optionalKey(IsoTimestampSchema),
  publicReadyAt: Schema.optionalKey(IsoTimestampSchema),
});
type HatchRecordBase = typeof HatchRecordBaseSchema.Type;

const hasUniqueValues = (values: ReadonlyArray<string>): boolean =>
  new Set(values).size === values.length;

const isPermitConsistent = (permit: HatchBrowserPermit): boolean =>
  permit.ingressBytes <= HATCH_MAX_PERMIT_BYTES &&
  permit.responseBytes <= HATCH_MAX_PERMIT_BYTES &&
  permit.ingressBytes + permit.responseBytes <= HATCH_MAX_PERMIT_BYTES &&
  Date.parse(permit.createdAt) < Date.parse(permit.expiresAt);

const requestReservationBytes = (request: HatchHttpRequest): number =>
  request.reservedIngressBytes + request.reservedResponseBytes;

const isRequestConsistent = (
  record: HatchRecordBase,
  request: HatchHttpRequest,
  permitById: ReadonlyMap<string, HatchBrowserPermit>,
): boolean => {
  const permit = permitById.get(request.permitId);
  return (
    permit !== undefined &&
    request.generation === record.generation &&
    request.runtimeEpoch === record.runtimeEpoch &&
    request.reservedIngressBytes <= HATCH_MAX_INGRESS_BYTES &&
    request.reservedResponseBytes === HATCH_RESERVED_RESPONSE_BYTES &&
    (request.ingressBytes === undefined || request.ingressBytes <= request.reservedIngressBytes) &&
    Date.parse(request.admittedAt) < Date.parse(request.expiresAt) &&
    Date.parse(request.expiresAt) <= Date.parse(permit.expiresAt)
  );
};

const permitsHaveRoomForRequests = (
  permits: ReadonlyArray<HatchBrowserPermit>,
  requests: ReadonlyArray<HatchHttpRequest>,
): boolean =>
  permits.every((permit) => {
    const outstanding = requests
      .filter((request) => request.permitId === permit.permitId)
      .reduce((total, request) => total + requestReservationBytes(request), 0);
    return permit.ingressBytes + permit.responseBytes + outstanding <= HATCH_MAX_PERMIT_BYTES;
  });

const isActiveHatch = (record: HatchRecordBase): boolean =>
  record.desiredStatus === "open" &&
  record.observedStatus === "running" &&
  record.runtimeEpoch !== undefined &&
  record.exposure === "active" &&
  record.cleanup === undefined &&
  record.transitionNonce === undefined;

const hasValidRecordTimestamps = (record: HatchRecordBase): boolean =>
  Date.parse(record.createdAt) <= Date.parse(record.updatedAt) &&
  (record.lastHealthyAt === undefined ||
    Date.parse(record.createdAt) <= Date.parse(record.lastHealthyAt)) &&
  (record.publicReadyAt === undefined ||
    (Date.parse(record.createdAt) <= Date.parse(record.publicReadyAt) &&
      Date.parse(record.publicReadyAt) <= Date.parse(record.updatedAt)));

const hasValidCleanupState = (record: HatchRecordBase): boolean =>
  record.cleanup === undefined ||
  (record.cleanup.generation === record.generation &&
    record.cleanup.operationNonce === record.transitionNonce) ||
  (record.cleanup.target === "gone" &&
    record.exposure === "closed" &&
    record.transitionNonce === undefined);

const hasValidLifecycleState = (record: HatchRecordBase): boolean =>
  (record.exposure !== "active" || isActiveHatch(record)) &&
  (record.publicReadyAt === undefined || isActiveHatch(record)) &&
  ((record.permits.length === 0 && record.requests.length === 0) || isActiveHatch(record)) &&
  (record.exposure !== "closed" || record.runtimeEpoch === undefined);

const isConsistentHatchRecord = (record: HatchRecordBase): boolean => {
  const permitIds = record.permits.map((permit) => permit.permitId);
  const requestIds = record.requests.map((request) => request.requestId);
  const permitById = new Map(record.permits.map((permit) => [permit.permitId, permit]));
  return (
    hasUniqueValues(permitIds) &&
    hasUniqueValues(requestIds) &&
    hasUniqueValues(record.permits.map((permit) => permit.browserClientId)) &&
    record.permits.every(isPermitConsistent) &&
    record.requests.every((request) => isRequestConsistent(record, request, permitById)) &&
    permitsHaveRoomForRequests(record.permits, record.requests) &&
    hasValidRecordTimestamps(record) &&
    hasValidLifecycleState(record) &&
    hasValidCleanupState(record)
  );
};

export const HatchRecordSchema = HatchRecordBaseSchema.check(
  Schema.makeFilter(isConsistentHatchRecord, {
    expected: "an internally consistent authoritative Hatch record",
  }),
);
export type HatchRecord = typeof HatchRecordSchema.Type;

export const HatchStateSchema = Schema.Struct({
  primary: Schema.optionalKey(HatchRecordSchema),
});
export type HatchState = typeof HatchStateSchema.Type;
export const emptyHatchState = (): HatchState => ({});
export const decodeHatchStateResult = Schema.decodeUnknownResult(HatchStateSchema, {
  onExcessProperty: "error",
});

const PublicHatchConfiguredSchema = Schema.Struct({
  status: Schema.Literal("configured"),
  hatchId: IdentifierSchema,
  generation: PositiveIntSchema,
  service: Schema.Struct({
    name: Schema.String,
    port: PortSchema,
  }),
  desiredStatus: HatchDesiredStatusSchema,
  observedStatus: HatchObservedStatusSchema,
  exposure: HatchExposureSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastHealthyAt: Schema.optionalKey(IsoTimestampSchema),
});
export const PublicHatchStatusSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not_configured") }),
  PublicHatchConfiguredSchema,
]);
export type PublicHatchStatus = typeof PublicHatchStatusSchema.Type;

export const publicHatchStatusProjection = (state: HatchState): PublicHatchStatus => {
  const hatch = state.primary;
  if (hatch === undefined) return { status: "not_configured" };
  return {
    status: "configured",
    hatchId: hatch.hatchId,
    generation: hatch.generation,
    service: { name: hatch.service.name, port: hatch.service.port },
    desiredStatus: hatch.desiredStatus,
    observedStatus: hatch.observedStatus,
    exposure:
      hatch.exposure === "active" && hatch.publicReadyAt === undefined
        ? "not_exposed"
        : hatch.exposure,
    createdAt: hatch.createdAt,
    updatedAt: hatch.updatedAt,
    ...(hatch.lastHealthyAt === undefined ? {} : { lastHealthyAt: hatch.lastHealthyAt }),
  };
};

export const HatchHostRouteSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  port: PortSchema,
  routeNonce: RouteNonceSchema,
});
export type HatchHostRoute = typeof HatchHostRouteSchema.Type;
export const decodeHatchHostRoute = Schema.decodeUnknownOption(HatchHostRouteSchema, {
  onExcessProperty: "error",
});

export const HatchRouteAuthorizationSchema = Schema.Struct({
  ...HatchHostRouteSchema.fields,
  hatchId: IdentifierSchema,
  generation: PositiveIntSchema,
  runtimeEpoch: IdentifierSchema,
});
export type HatchRouteAuthorization = typeof HatchRouteAuthorizationSchema.Type;

export const sameHatchAuthorization = (
  left: Pick<HatchRouteAuthorization, "hatchId" | "generation" | "runtimeEpoch">,
  right: Pick<HatchRouteAuthorization, "hatchId" | "generation" | "runtimeEpoch">,
): boolean =>
  left.hatchId === right.hatchId &&
  left.generation === right.generation &&
  left.runtimeEpoch === right.runtimeEpoch;

export const HatchGatewayAdmissionSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  port: PortSchema,
  routeNonce: RouteNonceSchema,
  cookieSecret: CookieSecretSchema,
  ingressBytes: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(HATCH_MAX_INGRESS_BYTES)),
});
export type HatchGatewayAdmission = typeof HatchGatewayAdmissionSchema.Type;
export const decodeHatchRequestAdmission = Schema.decodeUnknownOption(HatchGatewayAdmissionSchema, {
  onExcessProperty: "error",
});
export const decodeHatchRequestId = Schema.decodeUnknownOption(RequestIdSchema);
export const decodeHatchIngressBytes = Schema.decodeUnknownOption(
  HatchGatewayAdmissionSchema.fields.ingressBytes,
);

export const IssuedHatchPermitSchema = Schema.Struct({
  expiresAt: IsoTimestampSchema,
});
export type IssuedHatchPermit = typeof IssuedHatchPermitSchema.Type;

export const HatchRequestPermitSchema = Schema.Struct({
  requestId: RequestIdSchema,
  expiresAt: IsoTimestampSchema,
});
export type HatchRequestPermit = typeof HatchRequestPermitSchema.Type;

export const HatchWebSocketAdmissionSchema = Schema.Struct({
  ...HatchHostRouteSchema.fields,
  host: HatchHostSchema,
  origin: Schema.String.check(Schema.isMaxLength(512)),
  cookieSecret: CookieSecretSchema,
});
export type HatchWebSocketAdmission = typeof HatchWebSocketAdmissionSchema.Type;
export const decodeHatchWebSocketAdmission = Schema.decodeUnknownOption(
  HatchWebSocketAdmissionSchema,
  { onExcessProperty: "error" },
);

export const HatchWebSocketPermitSchema = Schema.Struct({
  socketId: WebSocketIdSchema,
  generation: PositiveIntSchema,
  runtimeEpoch: IdentifierSchema,
  expiresAt: IsoTimestampSchema,
});
export type HatchWebSocketPermit = typeof HatchWebSocketPermitSchema.Type;
export const decodeHatchWebSocketId = Schema.decodeUnknownOption(WebSocketIdSchema);

export const HatchRestoreDescriptorSchema = Schema.Struct({
  hatchId: IdentifierSchema,
  generation: PositiveIntSchema,
  operationNonce: IdentifierSchema,
  runtimeEpoch: IdentifierSchema,
  service: HatchServiceSchema,
});
export type HatchRestoreDescriptor = typeof HatchRestoreDescriptorSchema.Type;

export type HatchStateFailureReason =
  | "conflict"
  | "invalid_state"
  | "lease_changed"
  | "not_found"
  | "over_budget"
  | "runtime_changed"
  | "storage";

export class HatchStateError extends Data.TaggedError("HatchStateError")<{
  readonly reason: HatchStateFailureReason;
  readonly message: string;
}> {}

export const hatchOrigin = (
  route: Pick<HatchRouteAuthorization, "port" | "sessionId" | "routeNonce">,
  previewBase: string,
): string => `https://${route.port}-${route.sessionId}-${route.routeNonce}.${previewBase}`;

export const sameHatchService = (left: HatchService, right: HatchService): boolean =>
  left.name === right.name &&
  left.workingDirectory === right.workingDirectory &&
  left.port === right.port &&
  left.healthPath === right.healthPath &&
  left.argv.length === right.argv.length &&
  left.argv.every((arg, index) => arg === right.argv[index]);

export const decodeHatchCookieSecret = Schema.decodeUnknownOption(CookieSecretSchema);
export const decodeHatchCookieDigest = Schema.decodeUnknownOption(Sha256Schema);
export const decodeHatchBrowserClientId = Schema.decodeUnknownOption(
  HatchBrowserPermitSchema.fields.browserClientId,
);
export const decodeHatchIdentifier = Schema.decodeUnknownOption(IdentifierSchema);
export const decodeHatchRouteNonce = Schema.decodeUnknownOption(RouteNonceSchema);
export const optionalHatch = (state: HatchState): Option.Option<HatchRecord> =>
  Option.fromUndefinedOr(state.primary);
