import { Schema } from "effect";

const OperationIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
);
const ProbeIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/));
const SessionIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));
const ArgumentSchema = Schema.String.check(Schema.isMaxLength(64 * 1024));

const OperationFields = {
  version: Schema.Literal(1),
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
  version: Schema.Literal(1),
  probeId: ProbeIdSchema,
});
export type RunnerProbe = typeof RunnerProbeSchema.Type;

export const RunnerRequestSchema = Schema.Union([RunnerOperationSchema, RunnerProbeSchema]);
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
  version: Schema.Literal(1),
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
  version: Schema.Literal(1),
  operationId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  code: RunnerFailureCodeSchema,
});
export type RunnerFailure = typeof RunnerFailureSchema.Type;

export const RunnerResponseSchema = Schema.Union([RunnerSuccessSchema, RunnerFailureSchema]);
export type RunnerResponse = typeof RunnerResponseSchema.Type;

export const RunnerProtocolRejectedSchema = Schema.TaggedStruct("RunnerProtocolRejected", {
  version: Schema.Literal(1),
  code: Schema.Literal("invalid_message"),
});
export type RunnerProtocolRejected = typeof RunnerProtocolRejectedSchema.Type;

export const RunnerHelloSchema = Schema.TaggedStruct("RunnerHello", {
  version: Schema.Literal(1),
  runner: Schema.NonEmptyString,
});
export type RunnerHello = typeof RunnerHelloSchema.Type;

export const RunnerProbeAckSchema = Schema.TaggedStruct("RunnerProbeAck", {
  version: Schema.Literal(1),
  probeId: ProbeIdSchema,
});
export type RunnerProbeAck = typeof RunnerProbeAckSchema.Type;

export const RunnerReplySchema = Schema.Union([RunnerResponseSchema, RunnerProbeAckSchema]);
export type RunnerReply = typeof RunnerReplySchema.Type;

export const RunnerFrameSchema = Schema.Union([
  RunnerHelloSchema,
  RunnerResponseSchema,
  RunnerProbeAckSchema,
  RunnerProtocolRejectedSchema,
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

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(RunnerFrameSchema));
const encodeOperation = Schema.encodeSync(Schema.fromJsonString(RunnerOperationSchema));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(RunnerRequestSchema));

export const encodeRunnerFrame = (frame: RunnerFrame): string => encodeFrame(frame);
export const encodeRunnerOperation = (operation: RunnerOperation): string =>
  encodeOperation(operation);
export const encodeRunnerRequest = (request: RunnerRequest): string => encodeRequest(request);
