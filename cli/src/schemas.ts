import { Schema } from "effect";
import rawStandardToolset from "../../worker/container/toolsets/standard.json" with { type: "json" };

export const PROVIDERS = ["cloudflare", "runner"] as const;
export const ProviderSchema = Schema.Literals(PROVIDERS);

export const ConfigSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  installationName: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  stackName: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
  workerName: Schema.optionalKey(Schema.String),
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
  Schema.Literal("go"),
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

export const STANDARD_TOOLSET: StandardToolset =
  Schema.decodeUnknownSync(StandardToolsetSchema)(rawStandardToolset);

export const RawConfigSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Unknown),
  installationName: Schema.optionalKey(Schema.Unknown),
  profile: Schema.optionalKey(Schema.Unknown),
  stackName: Schema.optionalKey(Schema.Unknown),
  stage: Schema.optionalKey(Schema.Unknown),
  accountId: Schema.optionalKey(Schema.Unknown),
  workerName: Schema.optionalKey(Schema.Unknown),
  host: Schema.optionalKey(Schema.Unknown),
  token: Schema.optionalKey(Schema.Unknown),
});
export const UpResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  provider: ProviderSchema,
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
  title: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  provider: ProviderSchema,
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
  agentState: Schema.optionalKey(Schema.Unknown),
  lastAgentEventAt: Schema.optionalKey(Schema.Unknown),
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
export const PiProviderMetadataSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.Literals(["api_key", "oauth"]),
  adapter: Schema.Literals(["supported", "unsupported"]),
});
export const PiAuthStatusResponseSchema = Schema.Struct({
  sourceDigest: Schema.NonEmptyString,
  providers: Schema.Array(PiProviderMetadataSchema),
});
export type PiAuthStatusResponse = typeof PiAuthStatusResponseSchema.Type;
export const PiAuthReseedResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
  providers: Schema.Array(PiProviderMetadataSchema),
});
export const CloudflareApiEnvelopeSchema = Schema.Struct({
  success: Schema.Boolean,
});
export const RunnerRegistrationResponseSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  credential: Schema.NonEmptyString,
  replaced: Schema.Boolean,
  createdAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
});
export const RunnerStatusSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  desired: Schema.Literals(["accepting", "draining", "disabled"]),
  connection: Schema.Literals(["connected", "disconnected"]),
  lastSeenAt: Schema.NullOr(Schema.NonEmptyString),
  assignedSessions: Schema.Finite,
});
export const RunnerStatusesResponseSchema = Schema.Array(RunnerStatusSchema);
export const RunnerRemovalResponseSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  status: Schema.Literal("removed"),
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
export const decodePiAuthStatusResponse = Schema.decodeUnknownOption(PiAuthStatusResponseSchema);
export const decodePiAuthReseedResponse = Schema.decodeUnknownOption(PiAuthReseedResponseSchema);
export const decodeCloudflareApiEnvelope = Schema.decodeUnknownOption(CloudflareApiEnvelopeSchema);
export const decodeRunnerRegistrationResponse = Schema.decodeUnknownOption(
  RunnerRegistrationResponseSchema,
);
export const decodeRunnerStatusesResponse = Schema.decodeUnknownOption(
  RunnerStatusesResponseSchema,
);
export const decodeRunnerRemovalResponse = Schema.decodeUnknownOption(RunnerRemovalResponseSchema);
export const decodeString = Schema.decodeUnknownOption(Schema.String);
export const decodeNonEmptyString = Schema.decodeUnknownOption(Schema.NonEmptyString);
