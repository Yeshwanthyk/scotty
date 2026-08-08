import { Data, Option, Schema } from "effect";

export const HATCH_STATE_VERSION = 1 as const;
export const HATCH_COOKIE = "__Host-scotty-hatch";
export const HATCH_HANDOFF_PATH = "/_scotty/hatch/handoff";
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
const RouteNonceSchema = Schema.String.check(Schema.isPattern(/^h_[a-z0-9_]{14}$/u));
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

export const HatchServiceV1Schema = Schema.Struct({
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
export type HatchServiceV1 = typeof HatchServiceV1Schema.Type;

export const EnsureHatchInputV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  service: HatchServiceV1Schema,
});
export type EnsureHatchInputV1 = typeof EnsureHatchInputV1Schema.Type;
export const decodeEnsureHatchInput = Schema.decodeUnknownOption(EnsureHatchInputV1Schema, {
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

export const HatchBrowserPermitV1Schema = Schema.Struct({
  permitId: IdentifierSchema,
  browserClientId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  cookieDigest: Sha256Schema,
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  ingressBytes: NonNegativeIntSchema,
  responseBytes: NonNegativeIntSchema,
});
export type HatchBrowserPermitV1 = typeof HatchBrowserPermitV1Schema.Type;

export const HatchHttpRequestV1Schema = Schema.Struct({
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
export type HatchHttpRequestV1 = typeof HatchHttpRequestV1Schema.Type;

export const HatchCleanupTargetSchema = Schema.Literals([
  "failed",
  "sleeping",
  "stopped",
  "unhealthy",
  "gone",
]);
export type HatchCleanupTarget = typeof HatchCleanupTargetSchema.Type;
export const HatchCleanupRetryV1Schema = Schema.Struct({
  operationNonce: IdentifierSchema,
  target: HatchCleanupTargetSchema,
  closeDesired: Schema.Boolean,
});
export type HatchCleanupRetryV1 = typeof HatchCleanupRetryV1Schema.Type;
export const decodeHatchCleanupRetry = Schema.decodeUnknownOption(HatchCleanupRetryV1Schema, {
  onExcessProperty: "error",
});
const HatchCleanupV1Schema = Schema.Struct({
  operationNonce: IdentifierSchema,
  target: HatchCleanupTargetSchema,
  generation: PositiveIntSchema,
  requestedAt: IsoTimestampSchema,
});

const HatchRecordV1BaseSchema = Schema.Struct({
  hatchId: IdentifierSchema,
  sessionId: SessionIdSchema,
  generation: PositiveIntSchema,
  service: HatchServiceV1Schema,
  desiredStatus: HatchDesiredStatusSchema,
  observedStatus: HatchObservedStatusSchema,
  runtimeEpoch: Schema.optionalKey(IdentifierSchema),
  exposure: HatchExposureSchema,
  routeNonce: RouteNonceSchema,
  permits: Schema.Array(HatchBrowserPermitV1Schema).check(Schema.isMaxLength(64)),
  requests: Schema.Array(HatchHttpRequestV1Schema).check(
    Schema.isMaxLength(HATCH_MAX_CONCURRENT_REQUESTS),
  ),
  transitionNonce: Schema.optionalKey(IdentifierSchema),
  cleanup: Schema.optionalKey(HatchCleanupV1Schema),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastHealthyAt: Schema.optionalKey(IsoTimestampSchema),
});
export const HatchRecordV1Schema = HatchRecordV1BaseSchema.check(
  Schema.makeFilter(
    (record) => {
      const permitIds = new Set(record.permits.map((permit) => permit.permitId));
      const requestIds = new Set(record.requests.map((request) => request.requestId));
      const active =
        record.desiredStatus === "open" &&
        record.observedStatus === "running" &&
        record.runtimeEpoch !== undefined &&
        record.exposure === "active" &&
        record.cleanup === undefined &&
        record.transitionNonce === undefined;
      return (
        permitIds.size === record.permits.length &&
        requestIds.size === record.requests.length &&
        new Set(record.permits.map((permit) => permit.browserClientId)).size ===
          record.permits.length &&
        record.permits.every(
          (permit) =>
            permit.ingressBytes <= HATCH_MAX_PERMIT_BYTES &&
            permit.responseBytes <= HATCH_MAX_PERMIT_BYTES &&
            permit.ingressBytes + permit.responseBytes <= HATCH_MAX_PERMIT_BYTES &&
            Date.parse(permit.createdAt) < Date.parse(permit.expiresAt),
        ) &&
        record.requests.every(
          (request) =>
            permitIds.has(request.permitId) &&
            request.reservedIngressBytes <= HATCH_MAX_INGRESS_BYTES &&
            request.reservedResponseBytes === HATCH_RESERVED_RESPONSE_BYTES &&
            Date.parse(request.admittedAt) < Date.parse(request.expiresAt),
        ) &&
        Date.parse(record.createdAt) <= Date.parse(record.updatedAt) &&
        (record.lastHealthyAt === undefined ||
          Date.parse(record.createdAt) <= Date.parse(record.lastHealthyAt)) &&
        (record.exposure !== "active" || active) &&
        ((record.permits.length === 0 && record.requests.length === 0) || active) &&
        (record.exposure !== "closed" || record.runtimeEpoch === undefined) &&
        (record.cleanup === undefined ||
          (record.cleanup.generation === record.generation &&
            record.cleanup.operationNonce === record.transitionNonce) ||
          (record.cleanup.target === "gone" &&
            record.exposure === "closed" &&
            record.transitionNonce === undefined))
      );
    },
    { expected: "an internally consistent authoritative Hatch record" },
  ),
);
export type HatchRecordV1 = typeof HatchRecordV1Schema.Type;

export const HatchStateV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  primary: Schema.optionalKey(HatchRecordV1Schema),
});
export type HatchStateV1 = typeof HatchStateV1Schema.Type;
export const emptyHatchState = (): HatchStateV1 => ({ version: 1 });
export const decodeHatchStateResult = Schema.decodeUnknownResult(HatchStateV1Schema, {
  onExcessProperty: "error",
});

const PublicHatchConfiguredV1Schema = Schema.Struct({
  version: Schema.Literal(1),
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
export const PublicHatchStatusV1Schema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), status: Schema.Literal("not_configured") }),
  PublicHatchConfiguredV1Schema,
]);
export type PublicHatchStatusV1 = typeof PublicHatchStatusV1Schema.Type;

export const publicHatchStatusProjection = (state: HatchStateV1): PublicHatchStatusV1 => {
  const hatch = state.primary;
  if (hatch === undefined) return { version: 1, status: "not_configured" };
  return {
    version: 1,
    status: "configured",
    hatchId: hatch.hatchId,
    generation: hatch.generation,
    service: { name: hatch.service.name, port: hatch.service.port },
    desiredStatus: hatch.desiredStatus,
    observedStatus: hatch.observedStatus,
    exposure: hatch.exposure,
    createdAt: hatch.createdAt,
    updatedAt: hatch.updatedAt,
    ...(hatch.lastHealthyAt === undefined ? {} : { lastHealthyAt: hatch.lastHealthyAt }),
  };
};

export const HatchHostRouteV1Schema = Schema.Struct({
  sessionId: SessionIdSchema,
  port: PortSchema,
  routeNonce: RouteNonceSchema,
});
export type HatchHostRouteV1 = typeof HatchHostRouteV1Schema.Type;
export const decodeHatchHostRoute = Schema.decodeUnknownOption(HatchHostRouteV1Schema, {
  onExcessProperty: "error",
});

export const HatchRouteAuthorizationV1Schema = Schema.Struct({
  ...HatchHostRouteV1Schema.fields,
  hatchId: IdentifierSchema,
  generation: PositiveIntSchema,
  runtimeEpoch: IdentifierSchema,
});
export type HatchRouteAuthorizationV1 = typeof HatchRouteAuthorizationV1Schema.Type;

export const HatchRequestAdmissionV1Schema = Schema.Struct({
  sessionId: SessionIdSchema,
  port: PortSchema,
  routeNonce: RouteNonceSchema,
  cookieSecret: CookieSecretSchema,
  ingressBytes: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(HATCH_MAX_INGRESS_BYTES)),
});
export type HatchRequestAdmissionV1 = typeof HatchRequestAdmissionV1Schema.Type;
export const decodeHatchRequestAdmission = Schema.decodeUnknownOption(
  HatchRequestAdmissionV1Schema,
  {
    onExcessProperty: "error",
  },
);
export const decodeHatchRequestId = Schema.decodeUnknownOption(RequestIdSchema);
export const decodeHatchIngressBytes = Schema.decodeUnknownOption(
  HatchRequestAdmissionV1Schema.fields.ingressBytes,
);

export const IssuedHatchPermitV1Schema = Schema.Struct({
  expiresAt: IsoTimestampSchema,
});
export type IssuedHatchPermitV1 = typeof IssuedHatchPermitV1Schema.Type;

export const HatchRequestPermitV1Schema = Schema.Struct({
  requestId: RequestIdSchema,
  expiresAt: IsoTimestampSchema,
});
export type HatchRequestPermitV1 = typeof HatchRequestPermitV1Schema.Type;

export const HatchWebSocketAdmissionV1Schema = Schema.Struct({
  ...HatchHostRouteV1Schema.fields,
  host: HatchHostSchema,
  origin: Schema.String.check(Schema.isMaxLength(512)),
  cookieSecret: CookieSecretSchema,
});
export type HatchWebSocketAdmissionV1 = typeof HatchWebSocketAdmissionV1Schema.Type;
export const decodeHatchWebSocketAdmission = Schema.decodeUnknownOption(
  HatchWebSocketAdmissionV1Schema,
  { onExcessProperty: "error" },
);

export const HatchWebSocketPermitV1Schema = Schema.Struct({
  socketId: WebSocketIdSchema,
  generation: PositiveIntSchema,
  runtimeEpoch: IdentifierSchema,
  expiresAt: IsoTimestampSchema,
});
export type HatchWebSocketPermitV1 = typeof HatchWebSocketPermitV1Schema.Type;
export const decodeHatchWebSocketId = Schema.decodeUnknownOption(WebSocketIdSchema);

export const HatchRestoreDescriptorV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  hatchId: IdentifierSchema,
  generation: PositiveIntSchema,
  operationNonce: IdentifierSchema,
  runtimeEpoch: IdentifierSchema,
  service: HatchServiceV1Schema,
});
export type HatchRestoreDescriptorV1 = typeof HatchRestoreDescriptorV1Schema.Type;

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
  route: Pick<HatchRouteAuthorizationV1, "port" | "sessionId" | "routeNonce">,
  previewBase: string,
): string => `https://${route.port}-${route.sessionId}-${route.routeNonce}.${previewBase}`;

export const sameHatchService = (left: HatchServiceV1, right: HatchServiceV1): boolean =>
  left.name === right.name &&
  left.workingDirectory === right.workingDirectory &&
  left.port === right.port &&
  left.healthPath === right.healthPath &&
  left.argv.length === right.argv.length &&
  left.argv.every((arg, index) => arg === right.argv[index]);

export const decodeHatchCookieSecret = Schema.decodeUnknownOption(CookieSecretSchema);
export const decodeHatchCookieDigest = Schema.decodeUnknownOption(Sha256Schema);
export const decodeHatchBrowserClientId = Schema.decodeUnknownOption(
  HatchBrowserPermitV1Schema.fields.browserClientId,
);
export const decodeHatchIdentifier = Schema.decodeUnknownOption(IdentifierSchema);
export const decodeHatchRouteNonce = Schema.decodeUnknownOption(RouteNonceSchema);
export const optionalHatch = (state: HatchStateV1): Option.Option<HatchRecordV1> =>
  Option.fromUndefinedOr(state.primary);
