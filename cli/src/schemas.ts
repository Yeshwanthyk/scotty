import { Effect, Option, Schema } from "effect";
import { PiConsoleSnapshotSchema } from "../../protocol/pi-console";
import {
  RepositoryRegistryEntrySchema,
  RepositoryRegistryRemovalResponseSchema,
} from "../../protocol/repository";

export const PROVIDERS = ["cloudflare", "runner"] as const;
export const ProviderSchema = Schema.Literals(PROVIDERS);

export const ConfigSchema = Schema.Struct({
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
  host: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String),
});
export type Config = typeof ConfigSchema.Type;

export const PendingUpSchema = Schema.Struct({
  key: Schema.String,
  createdAt: Schema.String,
});
export type PendingUp = typeof PendingUpSchema.Type;

export const InitJournalSchema = Schema.Struct({
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
  credentialWrappingKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
});
export type InitJournal = typeof InitJournalSchema.Type;

export const RawConfigSchema = Schema.Struct({
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
  host: Schema.optionalKey(Schema.Unknown),
  token: Schema.optionalKey(Schema.Unknown),
});
export type RawConfig = typeof RawConfigSchema.Type;
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
const SessionLifecycleSchema = Schema.Literals(["warm", "sleeping", "failed", "gone"]);
const SessionActionSchema = Schema.Literals([
  "create",
  "checkpoint",
  "sleep",
  "resume",
  "work",
  "evidence",
  "hatch",
  "down",
  "vaporize",
]);
const SessionFailureSchema = Schema.Struct({
  code: Schema.NonEmptyString,
  recoverable: Schema.Boolean,
});
const SessionAuthoritySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stable"),
    lifecycle: SessionLifecycleSchema,
    failure: Schema.NullOr(SessionFailureSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("transitioning"),
    action: SessionActionSchema,
    phase: Schema.NonEmptyString,
    mode: Schema.Literals(["executing", "reconciling"]),
    startedAt: Schema.NonEmptyString,
  }),
]);
const SessionCapabilitiesSchema = Schema.Struct({
  checkpoint: Schema.Boolean,
  sleep: Schema.Boolean,
  resume: Schema.Boolean,
  work: Schema.Boolean,
  vaporize: Schema.Boolean,
});
export const SessionResponseSchema = Schema.Struct({
  identity: Schema.Struct({ id: Schema.NonEmptyString }),
  authority: SessionAuthoritySchema,
  runtime: Schema.Struct({
    provider: ProviderSchema,
    readiness: Schema.Literals(["unchecked", "not-applicable"]),
  }),
  capabilities: SessionCapabilitiesSchema,
  display: Schema.Struct({
    title: Schema.NonEmptyString,
    repository: Schema.NonEmptyString,
    branch: Schema.NullOr(Schema.NonEmptyString),
    defaultBranch: Schema.NullOr(Schema.NonEmptyString),
  }),
  times: Schema.Struct({ capRemainingSeconds: Schema.Finite }),
  projection: Schema.Struct({ projectedAt: Schema.NonEmptyString }),
});
export const SessionsResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(SessionResponseSchema),
});
export type SessionsResponse = typeof SessionsResponseSchema.Type;
export const InspectResponseSchema = PiConsoleSnapshotSchema;
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
    journal.evidenceEnabled !== true ||
    journal.previewBase === undefined ||
    journal.previewZoneId === undefined
  )
    return Option.none();
  return decoded;
};
export const decodeUpResponse = Schema.decodeUnknownOption(UpResponseSchema);
export const decodeRecoveryGrantResponse = Schema.decodeUnknownOption(RecoveryGrantResponseSchema);
export const decodeOperationResponse = Schema.decodeUnknownOption(OperationResponseSchema);
export const decodeSessionsResponse = Schema.decodeUnknownOption(SessionsResponseSchema, {
  onExcessProperty: "error",
});
export const decodeInspectResponse = Schema.decodeUnknownOption(InspectResponseSchema, {
  onExcessProperty: "ignore",
});
export const decodeSteerResponse = Schema.decodeUnknownOption(SteerResponseSchema, {
  onExcessProperty: "error",
});
export const decodeErrorEnvelope = Schema.decodeUnknownOption(ErrorEnvelopeSchema);
export const decodeErrorFields = Schema.decodeUnknownOption(ErrorFieldsSchema);
export const decodeVaporizeResponse = Schema.decodeUnknownOption(VaporizeResponseSchema);
export const decodeCloudflareApiEnvelope = Schema.decodeUnknownOption(CloudflareApiEnvelopeSchema);
export const decodeRunnerRegistrationResponse = Schema.decodeUnknownOption(
  RunnerRegistrationResponseSchema,
);
export const decodeRunnerStatusesResponse = Schema.decodeUnknownOption(
  RunnerStatusesResponseSchema,
);
export const decodeRunnerRemovalResponse = Schema.decodeUnknownOption(RunnerRemovalResponseSchema);
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
