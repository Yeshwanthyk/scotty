import { Option, Schema } from "effect";
import rawStandardToolset from "../../worker/container/toolsets/standard.json" with { type: "json" };

export const ConfigSchema = Schema.Struct({
  host: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
});
export type Config = typeof ConfigSchema.Type;

export const PendingUpSchema = Schema.Struct({
  version: Schema.Literal(1),
  key: Schema.String,
  createdAt: Schema.String,
});
export type PendingUp = typeof PendingUpSchema.Type;

export const ToolCategorySchema = Schema.Union([
  Schema.Literal("search-data"),
  Schema.Literal("python"),
  Schema.Literal("git-process"),
  Schema.Literal("javascript"),
  Schema.Literal("browser"),
  Schema.Literal("build"),
  Schema.Literal("scotty"),
]);
export const StandardToolSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  category: ToolCategorySchema,
  commands: Schema.Array(Schema.NonEmptyString),
  source: Schema.NonEmptyString,
  versionPolicy: Schema.Union([Schema.Literal("pinned"), Schema.Literal("image")]),
  expectedVersion: Schema.optionalKey(Schema.NonEmptyString),
  probe: Schema.NonEmptyArray(Schema.NonEmptyString),
});
export const StandardToolsetSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.Literal("standard"),
  tools: Schema.NonEmptyArray(StandardToolSchema),
});
export type StandardToolset = typeof StandardToolsetSchema.Type;

export const decodedStandardToolset =
  Schema.decodeUnknownOption(StandardToolsetSchema)(rawStandardToolset);
export const STANDARD_TOOLSET: StandardToolset = Option.isSome(decodedStandardToolset)
  ? decodedStandardToolset.value
  : (rawStandardToolset as StandardToolset);

export const RawConfigSchema = Schema.Struct({
  host: Schema.optionalKey(Schema.Unknown),
  token: Schema.optionalKey(Schema.Unknown),
});
export const UpResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
});
export const RecoveryGrantResponseSchema = Schema.Struct({
  url: Schema.NonEmptyString,
  expiresAt: Schema.NonEmptyString,
});
export const OperationResponseSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  url: Schema.optionalKey(Schema.Unknown),
  branch: Schema.optionalKey(Schema.Unknown),
  backupId: Schema.optionalKey(Schema.Unknown),
  status: Schema.NonEmptyString,
});
export const RawSessionFailureSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  recoverable: Schema.optionalKey(Schema.Unknown),
});
export const SessionResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  defaultBranch: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
  hardCapAt: Schema.NonEmptyString,
  ageSeconds: Schema.Finite,
  capRemainingSeconds: Schema.Finite,
  projectedAt: Schema.optionalKey(Schema.Unknown),
  codexThreadId: Schema.optionalKey(Schema.Unknown),
  failure: Schema.optionalKey(Schema.Unknown),
});
export const SessionsResponseSchema = Schema.Array(SessionResponseSchema);
export const ErrorEnvelopeSchema = Schema.Struct({ error: Schema.optionalKey(Schema.Unknown) });
export const ErrorFieldsSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  hint: Schema.optionalKey(Schema.Unknown),
});
export const DownMetadataSchema = Schema.Struct({
  branch: Schema.NonEmptyString,
  sha: Schema.NonEmptyString,
  codexThreadId: Schema.optionalKey(Schema.Unknown),
  rolloutFile: Schema.optionalKey(Schema.Unknown),
  rolloutPath: Schema.optionalKey(Schema.Unknown),
  rolloutBase64: Schema.optionalKey(Schema.Unknown),
  rolloutName: Schema.optionalKey(Schema.Unknown),
});
export const VaporizeResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("gone"),
});

export type SessionResponse = typeof SessionResponseSchema.Type;

export const decodeJsonValue = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
export const decodeRawConfig = Schema.decodeUnknownOption(RawConfigSchema);
export const decodePendingUp = Schema.decodeUnknownOption(PendingUpSchema);
export const decodeUpResponse = Schema.decodeUnknownOption(UpResponseSchema);
export const decodeRecoveryGrantResponse = Schema.decodeUnknownOption(RecoveryGrantResponseSchema);
export const decodeOperationResponse = Schema.decodeUnknownOption(OperationResponseSchema);
export const decodeRawSessionFailure = Schema.decodeUnknownOption(RawSessionFailureSchema);
export const decodeSessionsResponse = Schema.decodeUnknownOption(SessionsResponseSchema);
export const decodeErrorEnvelope = Schema.decodeUnknownOption(ErrorEnvelopeSchema);
export const decodeErrorFields = Schema.decodeUnknownOption(ErrorFieldsSchema);
export const decodeDownMetadata = Schema.decodeUnknownOption(DownMetadataSchema);
export const decodeVaporizeResponse = Schema.decodeUnknownOption(VaporizeResponseSchema);
export const decodeString = Schema.decodeUnknownOption(Schema.String);
export const decodeNonEmptyString = Schema.decodeUnknownOption(Schema.NonEmptyString);
