import { Effect, Option, Schema } from "effect";
import { PiAuthDigestSchema, PiAuthUpdatedAtSchema } from "../../protocol/pi-auth";
import { PiConsoleSnapshotV1Schema } from "../../protocol/pi-console";
import {
  RepositoryRegistryEntrySchema,
  RepositoryRegistryRemovalResponseSchema,
} from "../../protocol/repository";
import rawStandardToolset from "../../worker/container/toolsets/standard.json" with { type: "json" };
import {
  EnvironmentMutationResponseSchema,
  EnvironmentViewSchema,
} from "../../worker/src/environment-contracts";
import { SessionEnvironmentStatusSchema } from "../../worker/src/contracts";

export const PROVIDERS = ["cloudflare", "runner"] as const;
export const ProviderSchema = Schema.Literals(PROVIDERS);

export const ConfigSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Literals([1, 2, 3])),
  installationName: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  stackName: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
  workerName: Schema.optionalKey(Schema.String),
  runnerWorkerName: Schema.optionalKey(Schema.String),
  containerName: Schema.optionalKey(Schema.String),
  kvTitle: Schema.optionalKey(Schema.String),
  backupBucketName: Schema.optionalKey(Schema.String),
  previewBase: Schema.optionalKey(Schema.String),
  previewZoneId: Schema.optionalKey(Schema.String),
  evidenceEnabled: Schema.optionalKey(Schema.Literal(true)),
  adoptionManifestPath: Schema.optionalKey(Schema.String),
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

export const InitJournalSchema = Schema.Struct({
  version: Schema.Literals([1, 2, 3]),
  operation: Schema.Literal("init"),
  phase: Schema.Literals(["prepared", "apply_started"]),
  installationName: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  stackName: Schema.NonEmptyString,
  workerName: Schema.NonEmptyString,
  runnerWorkerName: Schema.NonEmptyString,
  containerName: Schema.NonEmptyString,
  kvTitle: Schema.NonEmptyString,
  backupBucketName: Schema.NonEmptyString,
  previewBase: Schema.optionalKey(Schema.NonEmptyString),
  previewZoneId: Schema.optionalKey(Schema.NonEmptyString),
  evidenceEnabled: Schema.optionalKey(Schema.Literal(true)),
  planFingerprint: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});
export type InitJournal = typeof InitJournalSchema.Type;

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
  runnerWorkerName: Schema.optionalKey(Schema.Unknown),
  containerName: Schema.optionalKey(Schema.Unknown),
  kvTitle: Schema.optionalKey(Schema.Unknown),
  backupBucketName: Schema.optionalKey(Schema.Unknown),
  previewBase: Schema.optionalKey(Schema.Unknown),
  previewZoneId: Schema.optionalKey(Schema.Unknown),
  evidenceEnabled: Schema.optionalKey(Schema.Unknown),
  adoptionManifestPath: Schema.optionalKey(Schema.Unknown),
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
const BeamUpRequestFields = {
  title: Schema.NonEmptyString,
  prompt: Schema.String,
  provider: ProviderSchema,
  repo: Schema.NonEmptyString,
  newRepo: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
};
export const BeamUpRequestSchema = Schema.Union([
  Schema.Struct({
    ...BeamUpRequestFields,
    cap: Schema.NonEmptyString,
    hardCapSeconds: Schema.Finite,
  }),
  Schema.Struct(BeamUpRequestFields),
]);
export type BeamUpRequest = Schema.Codec.Encoded<typeof BeamUpRequestSchema>;
export const BeamUpOutputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  provider: ProviderSchema,
  status: Schema.NonEmptyString,
});
export type BeamUpOutput = typeof BeamUpOutputSchema.Type;
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
const SessionSandboxBundleSchema = Schema.Struct({
  digest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  manifestVersion: Schema.Literal(1),
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
  sandboxBundle: Schema.optionalKey(SessionSandboxBundleSchema),
});
export const SessionsResponseSchema = Schema.Array(SessionResponseSchema);
const StableSessionFailureSchema = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  recoverable: Schema.Boolean,
});
export const StableSessionSchema = Schema.Struct({
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
  projectedAt: Schema.optionalKey(Schema.NonEmptyString),
  codexThreadId: Schema.optionalKey(Schema.NonEmptyString),
  agentState: Schema.optionalKey(Schema.NonEmptyString),
  lastAgentEventAt: Schema.optionalKey(Schema.NonEmptyString),
  failure: Schema.optionalKey(StableSessionFailureSchema),
  sandboxBundle: Schema.optionalKey(SessionSandboxBundleSchema),
});
export type StableSession = typeof StableSessionSchema.Type;
export const InspectResponseSchema = PiConsoleSnapshotV1Schema;
export type InspectResponse = typeof InspectResponseSchema.Type;
const SteerAcceptedResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("accepted"),
  commandId: Schema.NonEmptyString,
  epoch: Schema.NonEmptyString,
  sessionRevision: Schema.Int,
});
const SteerStaleResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("stale"),
  reason: Schema.Literals(["session_revision_changed", "epoch_changed"]),
  expectedSessionRevision: Schema.Int,
  sessionRevision: Schema.optionalKey(Schema.Int),
  retryable: Schema.Literal(false),
});
const SteerUnavailableResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("unavailable"),
  reason: Schema.Literals([
    "provider_passive_relay_unavailable",
    "session_authority_unavailable",
    "session_not_warm",
    "session_operation_active",
    "provider_unsupported",
    "command_id_conflict",
    "extension_ui_not_pending",
    "extension_ui_response_already_delivered",
    "invalid_command",
    "pi_quiescing",
    "command_rejected",
  ]),
  retryable: Schema.Boolean,
});
const SteerAmbiguousResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("ambiguous"),
  reason: Schema.Literals([
    "command_transport_failed",
    "command_response_invalid",
    "command_receipt_mismatch",
  ]),
});
export const SteerResponseSchema = Schema.Union([
  SteerAcceptedResponseSchema,
  SteerStaleResponseSchema,
  SteerUnavailableResponseSchema,
  SteerAmbiguousResponseSchema,
]);
export type SteerResponse = typeof SteerResponseSchema.Type;
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
export const AttachOutputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  opened: Schema.Literal(true),
});
export type AttachOutput = typeof AttachOutputSchema.Type;
export const SessionOperationOutputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.NonEmptyString),
  branch: Schema.optionalKey(Schema.NonEmptyString),
  backupId: Schema.optionalKey(Schema.NonEmptyString),
});
export type SessionOperationOutput = typeof SessionOperationOutputSchema.Type;
export const VaporizeOutputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("gone"),
});
export type VaporizeOutput = typeof VaporizeOutputSchema.Type;
export const DownOutputSchema = Schema.Struct({
  branch: Schema.NonEmptyString,
  sha: Schema.NonEmptyString,
  rolloutPath: Schema.NullOr(Schema.String),
  resumeCmd: Schema.NullOr(Schema.String),
});
export type DownOutput = typeof DownOutputSchema.Type;
export const PiProviderMetadataSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.Literals(["api_key", "oauth"]),
  adapter: Schema.Literals(["supported", "unsupported"]),
});
export const PiAuthStatusResponseSchema = Schema.Struct({
  source: Schema.Literals(["bootstrap", "sync", "rotation"]),
  sourceDigest: PiAuthDigestSchema,
  updatedAt: Schema.NullOr(PiAuthUpdatedAtSchema),
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

export const EnvironmentResponseSchema = EnvironmentViewSchema;
export const EnvironmentMutationSchema = EnvironmentMutationResponseSchema;

export const RepositoryResponseSchema = RepositoryRegistryEntrySchema;
export const RepositoriesResponseSchema = Schema.Array(RepositoryResponseSchema);
export const RepositoryRemovalResponseSchema = RepositoryRegistryRemovalResponseSchema;

export type SessionResponse = typeof SessionResponseSchema.Type;

export const decodeJsonValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
export const decodeRawConfig = Schema.decodeUnknownOption(RawConfigSchema);
export const decodePendingUp = Schema.decodeUnknownOption(PendingUpSchema);
const decodeInitJournalJsonStructure = Schema.decodeUnknownOption(
  Schema.fromJsonString(InitJournalSchema),
  { onExcessProperty: "error" },
);
export const decodeInitJournalJson = (input: unknown): Option.Option<InitJournal> => {
  const decoded = decodeInitJournalJsonStructure(input);
  if (Option.isNone(decoded)) return Option.none();
  const journal = decoded.value;
  if (
    (journal.version === 3 &&
      (journal.evidenceEnabled !== true ||
        journal.previewBase === undefined ||
        journal.previewZoneId === undefined)) ||
    (journal.version !== 3 && journal.evidenceEnabled !== undefined)
  )
    return Option.none();
  return decoded;
};
export const decodeUpResponse = Schema.decodeUnknownOption(UpResponseSchema);
export const decodeRecoveryGrantResponse = Schema.decodeUnknownOption(RecoveryGrantResponseSchema);
export const decodeOperationResponse = Schema.decodeUnknownOption(OperationResponseSchema);
export const decodeRawSessionFailure = Schema.decodeUnknownOption(RawSessionFailureSchema);
export const decodeSessionsResponse = Schema.decodeUnknownOption(SessionsResponseSchema);
export const decodeInspectResponse = Schema.decodeUnknownOption(InspectResponseSchema, {
  onExcessProperty: "ignore",
});
export const decodeSteerResponse = Schema.decodeUnknownOption(SteerResponseSchema, {
  onExcessProperty: "error",
});
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
export const decodeEnvironmentResponse = Schema.decodeUnknownOption(EnvironmentResponseSchema, {
  onExcessProperty: "error",
});
export const decodeEnvironmentMutation = Schema.decodeUnknownOption(EnvironmentMutationSchema, {
  onExcessProperty: "error",
});
export const decodeSessionEnvironmentStatus = Schema.decodeUnknownOption(
  SessionEnvironmentStatusSchema,
  { onExcessProperty: "error" },
);
export const decodeRepositoryResponse = Schema.decodeUnknownOption(RepositoryResponseSchema, {
  onExcessProperty: "error",
});
export const decodeRepositoriesResponse = Schema.decodeUnknownOption(RepositoriesResponseSchema, {
  onExcessProperty: "error",
});
export const decodeRepositoryRemovalResponse = Schema.decodeUnknownOption(
  RepositoryRemovalResponseSchema,
  { onExcessProperty: "error" },
);
export const decodeString = Schema.decodeUnknownOption(Schema.String);
export const decodeTrue = Schema.decodeUnknownOption(Schema.Literal(true));
export const decodeNonEmptyString = Schema.decodeUnknownOption(Schema.NonEmptyString);
