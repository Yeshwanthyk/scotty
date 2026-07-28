import { Schema } from "effect";

export const RUNNER_PROTOCOL_VERSION = 2 as const;
export const RUNNER_HTTP_PATH_PREFIX = "/_scotty/runner-http/";
export const RUNNER_TEXT_FRAME_LIMIT = 256 * 1024;
export const RUNNER_DATA_CHUNK_LIMIT = 32 * 1024;
export const RUNNER_CREDIT_WINDOW = 128 * 1024;
export const RUNNER_STREAMS_PER_LINK_LIMIT = 64;
export const RUNNER_STREAMS_PER_SESSION_LIMIT = 16;
export const RUNNER_REQUEST_BODY_LIMIT = 16 * 1024 * 1024;
export const RUNNER_HEADER_COUNT_LIMIT = 128;
export const RUNNER_HEADER_BYTES_LIMIT = 64 * 1024;
export const RUNNER_METHOD_LENGTH_LIMIT = 16;
export const RUNNER_TARGET_LENGTH_LIMIT = 16 * 1024;
export const RUNNER_STATUS_TEXT_LENGTH_LIMIT = 256;

const OperationIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
);
const ProbeIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/));
const SessionIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));
const RuntimeIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/));
const StreamIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/));
const ArgumentSchema = Schema.String.check(Schema.isMaxLength(64 * 1024));

const OperationFields = {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  operationId: OperationIdSchema,
  sessionId: SessionIdSchema,
};

export const EnsureRuntimeSchema = Schema.TaggedStruct("EnsureRuntime", OperationFields);
export type EnsureRuntime = typeof EnsureRuntimeSchema.Type;

export const InspectRuntimeSchema = Schema.TaggedStruct("InspectRuntime", OperationFields);
export type InspectRuntime = typeof InspectRuntimeSchema.Type;

export const ExecRuntimeSchema = Schema.TaggedStruct("ExecRuntime", {
  ...OperationFields,
  argv: Schema.NonEmptyArray(ArgumentSchema).check(Schema.isMaxLength(128)),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
export type ExecRuntime = typeof ExecRuntimeSchema.Type;

export const StopRuntimeSchema = Schema.TaggedStruct("StopRuntime", OperationFields);
export type StopRuntime = typeof StopRuntimeSchema.Type;

export const RemoveRuntimeSchema = Schema.TaggedStruct("RemoveRuntime", OperationFields);
export type RemoveRuntime = typeof RemoveRuntimeSchema.Type;

export const RunnerOperationSchema = Schema.Union([
  EnsureRuntimeSchema,
  InspectRuntimeSchema,
  ExecRuntimeSchema,
  StopRuntimeSchema,
  RemoveRuntimeSchema,
]);
export type RunnerOperation = typeof RunnerOperationSchema.Type;

export const RunnerProbeSchema = Schema.TaggedStruct("RunnerProbe", {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  probeId: ProbeIdSchema,
});
export type RunnerProbe = typeof RunnerProbeSchema.Type;

export const RunnerProbeAckSchema = Schema.TaggedStruct("RunnerProbeAck", {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  probeId: ProbeIdSchema,
});
export type RunnerProbeAck = typeof RunnerProbeAckSchema.Type;

export const HeaderPairSchema = Schema.Tuple([
  Schema.String.check(Schema.isMaxLength(RUNNER_HEADER_BYTES_LIMIT)),
  Schema.String.check(Schema.isMaxLength(RUNNER_HEADER_BYTES_LIMIT)),
]);
export type HeaderPair = typeof HeaderPairSchema.Type;

const HeadersSchema = Schema.Array(HeaderPairSchema).check(
  Schema.isMaxLength(RUNNER_HEADER_COUNT_LIMIT),
  Schema.makeFilter(
    (headers) =>
      headers.reduce(
        (size, [name, value]) =>
          size +
          new TextEncoder().encode(name).byteLength +
          new TextEncoder().encode(value).byteLength,
        0,
      ) <= RUNNER_HEADER_BYTES_LIMIT,
  ),
);
const DirectionSchema = Schema.Literals(["request", "response"]);
const CancelDirectionSchema = Schema.Literals(["request", "response", "both"]);
const CreditSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: RUNNER_CREDIT_WINDOW }),
);
const canonicalBase64 = (value: string): boolean => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = atob(value);
  return (
    decoded.length >= 1 && decoded.length <= RUNNER_DATA_CHUNK_LIMIT && btoa(decoded) === value
  );
};
const DataSchema = Schema.String.check(Schema.makeFilter(canonicalBase64));
const HttpStreamFields = {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  streamId: StreamIdSchema,
};

export const HttpOpenSchema = Schema.TaggedStruct("HttpOpen", {
  ...HttpStreamFields,
  sessionId: SessionIdSchema,
  runtimeId: RuntimeIdSchema,
  method: Schema.String.check(
    Schema.isPattern(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
    Schema.isMaxLength(RUNNER_METHOD_LENGTH_LIMIT),
  ),
  target: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(RUNNER_TARGET_LENGTH_LIMIT),
  ),
  headers: HeadersSchema,
  hasBody: Schema.Boolean,
  responseCredit: Schema.Literal(RUNNER_CREDIT_WINDOW),
});
export type HttpOpen = typeof HttpOpenSchema.Type;

export const HttpCreditSchema = Schema.TaggedStruct("HttpCredit", {
  ...HttpStreamFields,
  direction: DirectionSchema,
  credit: CreditSchema,
});
export type HttpCredit = typeof HttpCreditSchema.Type;

export const HttpDataSchema = Schema.TaggedStruct("HttpData", {
  ...HttpStreamFields,
  direction: DirectionSchema,
  data: DataSchema,
});
export type HttpData = typeof HttpDataSchema.Type;

export const HttpEndSchema = Schema.TaggedStruct("HttpEnd", {
  ...HttpStreamFields,
  direction: DirectionSchema,
});
export type HttpEnd = typeof HttpEndSchema.Type;

export const HttpCancelSchema = Schema.TaggedStruct("HttpCancel", {
  ...HttpStreamFields,
  direction: CancelDirectionSchema,
});
export type HttpCancel = typeof HttpCancelSchema.Type;

export const HttpResponseSchema = Schema.TaggedStruct("HttpResponse", {
  ...HttpStreamFields,
  status: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 })),
  statusText: Schema.String.check(Schema.isMaxLength(RUNNER_STATUS_TEXT_LENGTH_LIMIT)),
  headers: HeadersSchema,
  hasBody: Schema.Boolean,
});
export type HttpResponse = typeof HttpResponseSchema.Type;

export const HttpFailureCodeSchema = Schema.Literals([
  "runtime_not_running",
  "request_failed",
  "response_failed",
]);
export type HttpFailureCode = typeof HttpFailureCodeSchema.Type;
export const HttpFailedSchema = Schema.TaggedStruct("HttpFailed", {
  ...HttpStreamFields,
  code: HttpFailureCodeSchema,
});
export type HttpFailed = typeof HttpFailedSchema.Type;

const RequestCreditSchema = HttpCreditSchema.check(
  Schema.makeFilter((frame) => frame.direction === "request"),
);
const ResponseCreditSchema = HttpCreditSchema.check(
  Schema.makeFilter((frame) => frame.direction === "response"),
);
const RequestDataSchema = HttpDataSchema.check(
  Schema.makeFilter((frame) => frame.direction === "request"),
);
const ResponseDataSchema = HttpDataSchema.check(
  Schema.makeFilter((frame) => frame.direction === "response"),
);
const RequestEndSchema = HttpEndSchema.check(
  Schema.makeFilter((frame) => frame.direction === "request"),
);
const ResponseEndSchema = HttpEndSchema.check(
  Schema.makeFilter((frame) => frame.direction === "response"),
);

export const RunnerRequestSchema = Schema.Union([
  RunnerOperationSchema,
  RunnerProbeSchema,
  RunnerProbeAckSchema,
  HttpOpenSchema,
  ResponseCreditSchema,
  RequestDataSchema,
  RequestEndSchema,
  HttpCancelSchema,
]);
export type RunnerRequest = typeof RunnerRequestSchema.Type;

export const RunnerPhaseSchema = Schema.Literals(["absent", "running", "stopped"]);
export type RunnerPhase = typeof RunnerPhaseSchema.Type;

const RuntimeStateFields = {
  phase: RunnerPhaseSchema,
  resourceId: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
};

export const EnsureRuntimeResultSchema = Schema.TaggedStruct(
  "EnsureRuntimeResult",
  RuntimeStateFields,
);
export type EnsureRuntimeResult = typeof EnsureRuntimeResultSchema.Type;

export const InspectRuntimeResultSchema = Schema.TaggedStruct(
  "InspectRuntimeResult",
  RuntimeStateFields,
);
export type InspectRuntimeResult = typeof InspectRuntimeResultSchema.Type;

export const ExecRuntimeResultSchema = Schema.TaggedStruct("ExecRuntimeResult", {
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type ExecRuntimeResult = typeof ExecRuntimeResultSchema.Type;

export const StopRuntimeResultSchema = Schema.TaggedStruct("StopRuntimeResult", RuntimeStateFields);
export type StopRuntimeResult = typeof StopRuntimeResultSchema.Type;

export const RemoveRuntimeResultSchema = Schema.TaggedStruct(
  "RemoveRuntimeResult",
  RuntimeStateFields,
);
export type RemoveRuntimeResult = typeof RemoveRuntimeResultSchema.Type;

export const RunnerResultSchema = Schema.Union([
  EnsureRuntimeResultSchema,
  InspectRuntimeResultSchema,
  ExecRuntimeResultSchema,
  StopRuntimeResultSchema,
  RemoveRuntimeResultSchema,
]);
export type RunnerResult = typeof RunnerResultSchema.Type;

export const RunnerSuccessSchema = Schema.TaggedStruct("RunnerSuccess", {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  operationId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  result: RunnerResultSchema,
});
export type RunnerSuccess = typeof RunnerSuccessSchema.Type;

export const RunnerFailureCodeSchema = Schema.Literals([
  "idempotency_conflict",
  "operation_unknown",
  "recovery_required",
  "runtime_not_running",
  "invalid_cwd",
  "filesystem_failed",
  "process_failed",
]);
export type RunnerFailureCode = typeof RunnerFailureCodeSchema.Type;

export const RunnerFailureSchema = Schema.TaggedStruct("RunnerFailure", {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  operationId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  code: RunnerFailureCodeSchema,
});
export type RunnerFailure = typeof RunnerFailureSchema.Type;

export const RunnerResponseSchema = Schema.Union([RunnerSuccessSchema, RunnerFailureSchema]);
export type RunnerResponse = typeof RunnerResponseSchema.Type;

export const RunnerProtocolRejectedSchema = Schema.TaggedStruct("RunnerProtocolRejected", {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  code: Schema.Literal("invalid_message"),
});
export type RunnerProtocolRejected = typeof RunnerProtocolRejectedSchema.Type;

export const RunnerHelloSchema = Schema.TaggedStruct("RunnerHello", {
  version: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  runner: Schema.NonEmptyString,
});
export type RunnerHello = typeof RunnerHelloSchema.Type;

export const RunnerReplySchema = Schema.Union([
  RunnerResponseSchema,
  RunnerProbeSchema,
  RunnerProbeAckSchema,
  RequestCreditSchema,
  ResponseDataSchema,
  ResponseEndSchema,
  HttpCancelSchema,
  HttpResponseSchema,
  HttpFailedSchema,
]);
export type RunnerReply = typeof RunnerReplySchema.Type;

export const RunnerFrameSchema = Schema.Union([
  RunnerHelloSchema,
  RunnerProbeSchema,
  RunnerResponseSchema,
  RunnerProbeAckSchema,
  RunnerProtocolRejectedSchema,
  RequestCreditSchema,
  ResponseDataSchema,
  ResponseEndSchema,
  HttpCancelSchema,
  HttpResponseSchema,
  HttpFailedSchema,
]);
export type RunnerFrame = typeof RunnerFrameSchema.Type;

export const decodeRunnerOperationText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunnerOperationSchema),
  { onExcessProperty: "error" },
);
export const decodeRunnerRequestText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunnerRequestSchema),
  { onExcessProperty: "error" },
);
export const decodeRunnerReplyText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunnerReplySchema),
  { onExcessProperty: "error" },
);
export const decodeRunnerFrameText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunnerFrameSchema),
  { onExcessProperty: "error" },
);

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(RunnerFrameSchema));
const encodeOperation = Schema.encodeSync(Schema.fromJsonString(RunnerOperationSchema));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(RunnerRequestSchema));

export const encodeRunnerFrame = (frame: RunnerFrame): string => encodeFrame(frame);
export const encodeRunnerOperation = (operation: RunnerOperation): string =>
  encodeOperation(operation);
export const encodeRunnerRequest = (request: RunnerRequest): string => encodeRequest(request);
