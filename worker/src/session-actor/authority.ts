import { Schema } from "effect";

const SafeIdentifierSchema = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const SafeTimestampSchema = Schema.NonEmptyString.check(Schema.isMaxLength(64));

export const StableKindSchema = Schema.Literals(["Warm", "Sleeping", "Failed", "Gone"]);
export type StableKind = typeof StableKindSchema.Type;
export const OriginSchema = Schema.Literals(["Absent", "Warm", "Sleeping", "Failed", "Gone"]);
export type Origin = typeof OriginSchema.Type;

export const ExecutionModeSchema = Schema.Literals(["executing", "reconciling"]);
export type ExecutionMode = typeof ExecutionModeSchema.Type;

export const HardCapProofSchema = Schema.Struct({
  durationSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  deadlineAt: SafeTimestampSchema,
  generation: SafeIdentifierSchema,
});
export type HardCapProof = typeof HardCapProofSchema.Type;

export const ExecutionBindingSchema = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("cloudflare"), runtimeName: Schema.String }),
  Schema.Struct({ provider: Schema.Literal("runner"), runnerName: Schema.String }),
]);
export const SessionIdentitySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  repository: Schema.String,
  execution: ExecutionBindingSchema,
  createdAt: Schema.String,
});
export type SessionIdentity = typeof SessionIdentitySchema.Type;

export const RuntimeProofSchema = Schema.Struct({
  providerRuntimeId: Schema.String,
  runtimeGeneration: Schema.String,
  containerIncarnation: Schema.String,
});
export type RuntimeProof = typeof RuntimeProofSchema.Type;

export const SupervisorProofSchema = Schema.Struct({
  processId: Schema.String,
  supervisorEpoch: Schema.String,
  runtimeGeneration: Schema.String,
  containerIncarnation: Schema.String,
});
export type SupervisorProof = typeof SupervisorProofSchema.Type;

export const TransportProofSchema = Schema.Struct({
  transportId: Schema.String,
  supervisorEpoch: Schema.String,
  runtimeGeneration: Schema.String,
  containerIncarnation: Schema.String,
});
export type TransportProof = typeof TransportProofSchema.Type;

export const ReadinessProofSchema = Schema.Struct({
  runtime: RuntimeProofSchema,
  supervisor: SupervisorProofSchema,
  transport: TransportProofSchema,
});
export type ReadinessProof = typeof ReadinessProofSchema.Type;
export const ReadinessProgressSchema = Schema.Struct({
  runtime: Schema.NullOr(RuntimeProofSchema),
  supervisor: Schema.NullOr(SupervisorProofSchema),
  transport: Schema.NullOr(TransportProofSchema),
});
export type ReadinessProgress = typeof ReadinessProgressSchema.Type;

export const BackupIdentitySchema = Schema.Struct({
  backupId: Schema.String,
  preparedAt: Schema.String,
  confirmedAt: Schema.NullOr(Schema.String),
  sourceRuntimeGeneration: Schema.String,
});
export type BackupIdentity = typeof BackupIdentitySchema.Type;

export const BackupProofSchema = Schema.Struct({
  ownedBackupIds: Schema.Array(Schema.String),
  prepared: Schema.NullOr(BackupIdentitySchema),
  currentBackupId: Schema.NullOr(Schema.String),
  confirmed: Schema.optionalKey(Schema.NullOr(BackupIdentitySchema)),
});
export type BackupProof = typeof BackupProofSchema.Type;

export const StopObservationSchema = Schema.Struct({
  requestedAt: Schema.String,
  observedAt: Schema.String,
  runtimeGeneration: Schema.String,
});
export type StopObservation = typeof StopObservationSchema.Type;

export const ActivityProofSchema = Schema.Struct({
  supervisorEpoch: SafeIdentifierSchema,
  piSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literals(["working", "waiting", "completed", "tool-stalled"]),
  observedAt: SafeTimestampSchema,
  expiresAt: SafeTimestampSchema,
});
export type ActivityProof = typeof ActivityProofSchema.Type;

export const VaporizeAbsenceCategorySchema = Schema.Literals([
  "runtime",
  "backups",
  "evidence",
  "grants",
  "hatch",
  "idempotency",
  "schedules",
]);
export type VaporizeAbsenceCategory = typeof VaporizeAbsenceCategorySchema.Type;

export const CleanupProofSchema = Schema.Struct({
  absent: Schema.Array(VaporizeAbsenceCategorySchema),
  lastObservedAt: Schema.String,
});
export type CleanupProof = typeof CleanupProofSchema.Type;

export const WarmStableSchema = Schema.TaggedStruct("Warm", {
  readiness: ReadinessProofSchema,
  backups: BackupProofSchema,
  activity: Schema.NullOr(ActivityProofSchema),
});
export const SleepingStableSchema = Schema.TaggedStruct("Sleeping", {
  backup: BackupIdentitySchema,
  ownedBackupIds: Schema.Array(Schema.String),
  stop: StopObservationSchema,
  wakeSource: Schema.Struct({
    backupId: Schema.String,
    confirmedAt: Schema.String,
  }),
});
export const FailedStableSchema = Schema.TaggedStruct("Failed", {
  code: Schema.String,
  actionable: Schema.Boolean,
  origin: OriginSchema,
  lastStable: Schema.NullOr(Schema.Literals(["Warm", "Sleeping"])),
  backup: Schema.NullOr(BackupIdentitySchema),
  ownedBackupIds: Schema.Array(Schema.String),
  wakeSource: Schema.NullOr(Schema.Struct({ backupId: Schema.String, confirmedAt: Schema.String })),
});
export const GoneStableSchema = Schema.TaggedStruct("Gone", { cleanup: CleanupProofSchema });
export const StableStateSchema = Schema.Union([
  WarmStableSchema,
  SleepingStableSchema,
  FailedStableSchema,
  GoneStableSchema,
]).pipe(Schema.toTaggedUnion("_tag"));
export type StableState = typeof StableStateSchema.Type;

export const CreatePhaseSchema = Schema.Literals([
  "IntentCommitted",
  "WorkspacePreparing",
  "RuntimeMaterializing",
  "RuntimeReady",
  "SupervisorStarting",
  "SupervisorReady",
  "TransportVerifying",
]);
export const CheckpointPhaseSchema = Schema.Literals([
  "Quiescing",
  "PiStopped",
  "Syncing",
  "BackupPrepared",
  "BackupConfirmed",
  "SupervisorRestarting",
  "TransportReady",
]);
export const SleepPhaseSchema = Schema.Literals([
  "Quiescing",
  "PiStopped",
  "Syncing",
  "BackupConfirmed",
  "StopRequested",
  "RuntimeStopped",
]);
export const ResumePhaseSchema = Schema.Literals([
  "WatchdogArmed",
  "BackupRestoring",
  "RuntimeReady",
  "SupervisorStarting",
  "SupervisorReady",
  "TransportReady",
]);
export const VaporizePhaseSchema = Schema.Literals([
  "Admitted",
  "RuntimeAccessRevoked",
  "HatchClosing",
  "EvidenceInterrupting",
  "RuntimeDestroying",
  "BackupsDeleting",
  "EvidenceDeleting",
  "GrantsReleasing",
  "AbsenceConfirming",
]);
export const WarmWorkKindSchema = Schema.Literals([
  "Evidence",
  "Hatch",
  "Down",
  "ManualCheckpoint",
  "RuntimePreparation",
]);
export type WarmWorkKind = typeof WarmWorkKindSchema.Type;
export const WarmWorkPhaseSchema = Schema.Literals(["Admitted", "Running", "Settling"]);

const TransitionBase = {
  nonce: Schema.String,
  origin: OriginSchema,
  attempt: Schema.String,
  startedAt: Schema.String,
  lastProgressAt: Schema.String,
  deadlineAt: Schema.String,
  mode: ExecutionModeSchema,
};

export const CreateProofSchema = Schema.Struct({
  workspaceId: Schema.NullOr(Schema.String),
  readiness: ReadinessProgressSchema,
});
export const CheckpointProofSchema = Schema.Struct({
  readiness: ReadinessProofSchema,
  piStoppedAt: Schema.NullOr(Schema.String),
  backup: BackupProofSchema,
});
export const SleepProofSchema = Schema.Struct({
  readiness: ReadinessProofSchema,
  piStoppedAt: Schema.NullOr(Schema.String),
  backup: BackupProofSchema,
  stopRequestedAt: Schema.optional(Schema.NullOr(Schema.String)),
  stop: Schema.NullOr(StopObservationSchema),
});
export const ResumeProofSchema = Schema.Struct({
  backup: BackupIdentitySchema,
  ownedBackupIds: Schema.Array(Schema.String),
  lastStable: Schema.Literals(["Warm", "Sleeping"]),
  watchdogArmedAt: Schema.String,
  readiness: ReadinessProgressSchema,
});
export const WarmWorkProofSchema = Schema.Struct({
  readiness: ReadinessProofSchema,
  backups: BackupProofSchema,
  activity: Schema.NullOr(ActivityProofSchema),
  activityGeneration: Schema.String,
  resultCode: Schema.NullOr(Schema.String),
});
export const VaporizeProofSchema = Schema.Struct({
  revokedAt: Schema.NullOr(Schema.String),
  ownedBackupIds: Schema.Array(Schema.String),
  cleanup: CleanupProofSchema,
});

export const CreateTransitionSchema = Schema.TaggedStruct("Create", {
  ...TransitionBase,
  phase: CreatePhaseSchema,
  proof: CreateProofSchema,
});
export const CheckpointTransitionSchema = Schema.TaggedStruct("Checkpoint", {
  ...TransitionBase,
  phase: CheckpointPhaseSchema,
  proof: CheckpointProofSchema,
});
export const SleepTransitionSchema = Schema.TaggedStruct("Sleep", {
  ...TransitionBase,
  phase: SleepPhaseSchema,
  proof: SleepProofSchema,
});
export const ResumeTransitionSchema = Schema.TaggedStruct("Resume", {
  ...TransitionBase,
  phase: ResumePhaseSchema,
  proof: ResumeProofSchema,
});
export const WarmWorkTransitionSchema = Schema.TaggedStruct("WarmWork", {
  ...TransitionBase,
  phase: WarmWorkPhaseSchema,
  workKind: WarmWorkKindSchema,
  proof: WarmWorkProofSchema,
});
export const VaporizeTransitionSchema = Schema.TaggedStruct("Vaporize", {
  ...TransitionBase,
  phase: VaporizePhaseSchema,
  proof: VaporizeProofSchema,
});
export const TransitionSchema = Schema.Union([
  CreateTransitionSchema,
  CheckpointTransitionSchema,
  SleepTransitionSchema,
  ResumeTransitionSchema,
  WarmWorkTransitionSchema,
  VaporizeTransitionSchema,
]).pipe(Schema.toTaggedUnion("_tag"));
export type Transition = typeof TransitionSchema.Type;

export const AuthorityStateSchema = Schema.Union([
  Schema.TaggedStruct("Stable", { stable: StableStateSchema }),
  Schema.TaggedStruct("Transitioning", { transition: TransitionSchema }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type AuthorityState = typeof AuthorityStateSchema.Type;

export const SessionAuthoritySchema = Schema.Struct({
  session: SessionIdentitySchema,
  hardCap: HardCapProofSchema,
  revision: Schema.Int,
  state: AuthorityStateSchema,
});
export type SessionAuthority = typeof SessionAuthoritySchema.Type;

export const decodeSessionAuthority = Schema.decodeUnknownResult(SessionAuthoritySchema, {
  onExcessProperty: "error",
});

export const emptyBackupProof = (): BackupProof => ({
  ownedBackupIds: [],
  prepared: null,
  currentBackupId: null,
  confirmed: null,
});

export const emptyCleanupProof = (timestamp: string): CleanupProof => ({
  absent: [],
  lastObservedAt: timestamp,
});
