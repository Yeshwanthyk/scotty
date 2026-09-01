import { Schema } from "effect";
import {
  BackupIdentitySchema,
  ActivityProofSchema,
  CheckpointProofSchema,
  CreateProofSchema,
  ResumeProofSchema,
  SessionIdentitySchema,
  SleepProofSchema,
  TransitionSchema,
  VaporizeProofSchema,
  WarmWorkKindSchema,
  WarmWorkProofSchema,
} from "./authority";

const CommandFence = {
  expectedRevision: Schema.Int,
  correlationId: Schema.String,
  nonce: Schema.String,
  attempt: Schema.String,
  timestamp: Schema.String,
  deadlineAt: Schema.String,
};

export const SessionCommandSchema = Schema.Union([
  Schema.TaggedStruct("CreateCommand", { ...CommandFence, session: SessionIdentitySchema }),
  Schema.TaggedStruct("CheckpointCommand", CommandFence),
  Schema.TaggedStruct("SleepCommand", CommandFence),
  Schema.TaggedStruct("ResumeCommand", CommandFence),
  Schema.TaggedStruct("WarmWorkCommand", { ...CommandFence, workKind: WarmWorkKindSchema }),
  Schema.TaggedStruct("VaporizeCommand", CommandFence),
]).pipe(Schema.toTaggedUnion("_tag"));
export type SessionCommand = typeof SessionCommandSchema.Type;

export const TransitionProofSchema = Schema.Union([
  CreateProofSchema,
  CheckpointProofSchema,
  SleepProofSchema,
  ResumeProofSchema,
  WarmWorkProofSchema,
  VaporizeProofSchema,
]);
export type TransitionProof = typeof TransitionProofSchema.Type;

const FactFence = {
  revision: Schema.Int,
  transitionNonce: Schema.String,
  attempt: Schema.String,
  expectedPhase: Schema.String,
  timestamp: Schema.String,
  correlationId: Schema.String,
};

export const ActorFactSchema = Schema.TaggedStruct("ActorFact", {
  ...FactFence,
  nextPhase: Schema.String,
  proof: TransitionProofSchema,
  resultCode: Schema.String,
});
export const RuntimeObservationSchema = Schema.TaggedStruct("RuntimeObservation", {
  ...FactFence,
  expectedRuntimeGeneration: Schema.NullOr(Schema.String),
  nextPhase: Schema.String,
  proof: TransitionProofSchema,
  resultCode: Schema.String,
});
export const ProviderObservationSchema = Schema.TaggedStruct("ProviderObservation", {
  ...FactFence,
  expectedProviderRuntimeId: Schema.NullOr(Schema.String),
  nextPhase: Schema.String,
  proof: TransitionProofSchema,
  resultCode: Schema.String,
});
export const TransitionCompletedSchema = Schema.TaggedStruct("TransitionCompleted", {
  ...FactFence,
  proof: TransitionProofSchema,
  resultCode: Schema.String,
});
export const TransitionFailedSchema = Schema.TaggedStruct("TransitionFailed", {
  ...FactFence,
  failureCode: Schema.String,
  actionable: Schema.Boolean,
  backup: Schema.NullOr(BackupIdentitySchema),
  ownedBackupIds: Schema.Array(Schema.String),
  wakeSource: Schema.NullOr(Schema.Struct({ backupId: Schema.String, confirmedAt: Schema.String })),
  resultCode: Schema.String,
});
export const DeadlineAlarmSchema = Schema.TaggedStruct("DeadlineAlarm", {
  ...FactFence,
  alarmId: Schema.String,
  expectedDeadlineAt: Schema.String,
});
export const UnknownProviderOutcomeSchema = Schema.TaggedStruct("UnknownProviderOutcome", {
  ...FactFence,
  expectedProviderRuntimeId: Schema.NullOr(Schema.String),
  resultCode: Schema.String,
});
export const ActivityObservedSchema = Schema.TaggedStruct("ActivityObserved", {
  revision: Schema.Int,
  expectedRuntimeGeneration: Schema.String,
  expectedSupervisorEpoch: Schema.String,
  correlationId: Schema.String,
  timestamp: Schema.String,
  activity: ActivityProofSchema,
});

export const SessionActorInputSchema = Schema.Union([
  SessionCommandSchema,
  ActorFactSchema,
  RuntimeObservationSchema,
  ProviderObservationSchema,
  TransitionCompletedSchema,
  TransitionFailedSchema,
  DeadlineAlarmSchema,
  UnknownProviderOutcomeSchema,
  ActivityObservedSchema,
]).pipe(Schema.toTaggedUnion("_tag"));
export type SessionActorInput = typeof SessionActorInputSchema.Type;

export const decodeSessionActorInput = Schema.decodeUnknownResult(SessionActorInputSchema, {
  onExcessProperty: "error",
});

export const transitionProofOf = (transition: typeof TransitionSchema.Type): TransitionProof =>
  transition.proof;
