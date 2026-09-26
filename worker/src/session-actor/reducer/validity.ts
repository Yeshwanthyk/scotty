import { Match, Predicate, Schema } from "effect";
import type {
  BackupIdentity,
  BackupProof,
  CleanupProof,
  HardCapProof,
  ReadinessProof,
  ReadinessProgress,
  SessionAuthority,
  StableState,
  Transition,
} from "./authority";
import {
  CheckpointPhaseSchema,
  CheckpointProofSchema,
  CreatePhaseSchema,
  CreateProofSchema,
  ResumePhaseSchema,
  ResumeProofSchema,
  SleepPhaseSchema,
  SleepProofSchema,
  VaporizePhaseSchema,
  VaporizeProofSchema,
  WarmWorkPhaseSchema,
  WarmWorkProofSchema,
} from "./authority";
import { confirmedBackup } from "./backup";
import { phaseIndex } from "./transition";

export const isCreateProof = Schema.is(CreateProofSchema);
export const isCheckpointProof = Schema.is(CheckpointProofSchema);
export const isSleepProof = Schema.is(SleepProofSchema);
export const isResumeProof = Schema.is(ResumeProofSchema);
export const isWarmWorkProof = Schema.is(WarmWorkProofSchema);
export const isVaporizeProof = Schema.is(VaporizeProofSchema);
export const isCreatePhase = Schema.is(CreatePhaseSchema);
export const isCheckpointPhase = Schema.is(CheckpointPhaseSchema);
export const isSleepPhase = Schema.is(SleepPhaseSchema);
export const isResumePhase = Schema.is(ResumePhaseSchema);
export const isWarmWorkPhase = Schema.is(WarmWorkPhaseSchema);
export const isVaporizePhase = Schema.is(VaporizePhaseSchema);

const requiredAbsence = [
  "runtime",
  "backups",
  "evidence",
  "grants",
  "hatch",
  "idempotency",
  "schedules",
] as const;

export const nonEmpty = (value: string): boolean => value.length > 0;
const validTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));
const orderedTimestamps = (transition: Transition): boolean => {
  const startedAt = Date.parse(transition.startedAt);
  const lastProgressAt = Date.parse(transition.lastProgressAt);
  const deadlineAt = Date.parse(transition.deadlineAt);
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(lastProgressAt) &&
    Number.isFinite(deadlineAt) &&
    startedAt <= lastProgressAt &&
    startedAt <= deadlineAt
  );
};

const validReadiness = (readiness: ReadinessProof): boolean =>
  [
    readiness.runtime.providerRuntimeId,
    readiness.runtime.runtimeGeneration,
    readiness.runtime.containerIncarnation,
    readiness.supervisor.processId,
    readiness.supervisor.supervisorEpoch,
    readiness.transport.transportId,
  ].every(nonEmpty) &&
  readiness.supervisor.runtimeGeneration === readiness.runtime.runtimeGeneration &&
  readiness.supervisor.containerIncarnation === readiness.runtime.containerIncarnation &&
  readiness.transport.runtimeGeneration === readiness.runtime.runtimeGeneration &&
  readiness.transport.containerIncarnation === readiness.runtime.containerIncarnation &&
  readiness.transport.supervisorEpoch === readiness.supervisor.supervisorEpoch;

const validReadinessProgress = (readiness: ReadinessProgress): boolean => {
  const { runtime, supervisor, transport } = readiness;
  if (supervisor !== null && runtime === null) return false;
  if (transport !== null && (runtime === null || supervisor === null)) return false;
  if (
    runtime !== null &&
    ![runtime.providerRuntimeId, runtime.runtimeGeneration, runtime.containerIncarnation].every(
      nonEmpty,
    )
  )
    return false;
  if (
    runtime !== null &&
    supervisor !== null &&
    (![supervisor.processId, supervisor.supervisorEpoch].every(nonEmpty) ||
      supervisor.runtimeGeneration !== runtime.runtimeGeneration ||
      supervisor.containerIncarnation !== runtime.containerIncarnation)
  )
    return false;
  return (
    transport === null ||
    (runtime !== null &&
      supervisor !== null &&
      nonEmpty(transport.transportId) &&
      transport.runtimeGeneration === runtime.runtimeGeneration &&
      transport.containerIncarnation === runtime.containerIncarnation &&
      transport.supervisorEpoch === supervisor.supervisorEpoch)
  );
};

export const completeReadiness = (progress: ReadinessProgress): ReadinessProof | undefined =>
  progress.runtime !== null && progress.supervisor !== null && progress.transport !== null
    ? { runtime: progress.runtime, supervisor: progress.supervisor, transport: progress.transport }
    : undefined;

const validBackupIdentity = (backup: BackupIdentity): boolean =>
  nonEmpty(backup.backupId) &&
  nonEmpty(backup.sourceRuntimeGeneration) &&
  validTimestamp(backup.preparedAt) &&
  (backup.confirmedAt === null ||
    (validTimestamp(backup.confirmedAt) &&
      Date.parse(backup.preparedAt) <= Date.parse(backup.confirmedAt)));

const validBackup = (backup: BackupProof, currentRequired: boolean): boolean => {
  if (new Set(backup.ownedBackupIds).size !== backup.ownedBackupIds.length) return false;
  if (
    backup.prepared !== null &&
    (!validBackupIdentity(backup.prepared) ||
      !backup.ownedBackupIds.includes(backup.prepared.backupId))
  )
    return false;
  if (backup.confirmed !== undefined && backup.confirmed !== null) {
    if (
      !validBackupIdentity(backup.confirmed) ||
      backup.confirmed.confirmedAt === null ||
      !backup.ownedBackupIds.includes(backup.confirmed.backupId) ||
      backup.confirmed.backupId !== backup.currentBackupId
    )
      return false;
  }
  if (backup.currentBackupId === null)
    return !currentRequired && (backup.confirmed === undefined || backup.confirmed === null);
  return confirmedBackup(backup) !== null && backup.ownedBackupIds.includes(backup.currentBackupId);
};

export const validCleanup = (cleanup: CleanupProof, complete: boolean): boolean =>
  validTimestamp(cleanup.lastObservedAt) &&
  new Set(cleanup.absent).size === cleanup.absent.length &&
  (!complete ||
    (cleanup.absent.length === requiredAbsence.length &&
      requiredAbsence.every((category) => cleanup.absent.includes(category))));

export const validHardCap = (hardCap: HardCapProof): boolean =>
  Number.isInteger(hardCap.durationSeconds) &&
  hardCap.durationSeconds > 0 &&
  nonEmpty(hardCap.generation) &&
  validTimestamp(hardCap.deadlineAt);

const validActivity = (activity: NonNullable<StableCase<"Warm">["activity"]>): boolean =>
  nonEmpty(activity.supervisorEpoch) &&
  Number.isInteger(activity.piSequence) &&
  activity.piSequence >= 0 &&
  validTimestamp(activity.observedAt) &&
  validTimestamp(activity.expiresAt) &&
  Date.parse(activity.observedAt) <= Date.parse(activity.expiresAt);

export type StableCase<Tag extends StableState["_tag"]> = Extract<StableState, { _tag: Tag }>;

const validWarm = (stable: StableCase<"Warm">): boolean =>
  validReadiness(stable.readiness) &&
  validBackup(stable.backups, stable.backups.currentBackupId !== null) &&
  (stable.activity === null ||
    (stable.activity.supervisorEpoch === stable.readiness.supervisor.supervisorEpoch &&
      validActivity(stable.activity)));

const validSleeping = (stable: StableCase<"Sleeping">): boolean =>
  validBackupIdentity(stable.backup) &&
  stable.backup.confirmedAt !== null &&
  stable.ownedBackupIds.includes(stable.backup.backupId) &&
  stable.wakeSource.backupId === stable.backup.backupId &&
  stable.wakeSource.confirmedAt === stable.backup.confirmedAt &&
  stable.stop.runtimeGeneration === stable.backup.sourceRuntimeGeneration &&
  validTimestamp(stable.stop.requestedAt) &&
  validTimestamp(stable.stop.observedAt) &&
  stable.stop.requestedAt <= stable.stop.observedAt;

const validFailed = (stable: StableCase<"Failed">): boolean =>
  nonEmpty(stable.code) &&
  new Set(stable.ownedBackupIds).size === stable.ownedBackupIds.length &&
  ((stable.lastStable === null && (stable.origin === "Absent" || stable.origin === "Failed")) ||
    (stable.lastStable !== null && stable.origin !== "Absent")) &&
  ((Predicate.isTagged(stable.recovery, "Create") &&
    stable.lastStable === null &&
    stable.ownedBackupIds.length === 0 &&
    (stable.origin === "Absent" || stable.origin === "Failed")) ||
    (Predicate.isTagged(stable.recovery, "Terminal") && stable.lastStable !== null) ||
    (Predicate.isTagged(stable.recovery, "Resume") &&
      stable.lastStable !== null &&
      stable.recovery.backup.confirmedAt !== null &&
      validBackupIdentity(stable.recovery.backup) &&
      stable.ownedBackupIds.includes(stable.recovery.backup.backupId)));

export const validStable = (stable: StableState): boolean =>
  Match.valueTags(stable, {
    Warm: validWarm,
    Sleeping: validSleeping,
    Failed: validFailed,
    Gone: ({ cleanup }) => validCleanup(cleanup, true),
  });

type TransitionCase<Tag extends Transition["_tag"]> = Extract<Transition, { _tag: Tag }>;

const validCreateTransition = (transition: TransitionCase<"Create">, index: number): boolean =>
  (transition.origin === "Absent" || transition.origin === "Failed") &&
  validReadinessProgress(transition.proof.readiness) &&
  (index < 4 || transition.proof.readiness.runtime !== null) &&
  (index < 7 || transition.proof.readiness.supervisor !== null);

const validCheckpointTransition = (
  transition: TransitionCase<"Checkpoint">,
  index: number,
): boolean =>
  transition.origin === "Warm" &&
  validReadiness(transition.proof.readiness) &&
  validBackup(transition.proof.backup, index >= 4) &&
  (index < 1 || transition.proof.piStoppedAt !== null);

const validSleepTransition = (transition: TransitionCase<"Sleep">, index: number): boolean => {
  const stopRequestedAt = transition.proof.stopRequestedAt ?? transition.proof.stop?.requestedAt;
  return (
    transition.origin === "Warm" &&
    validReadiness(transition.proof.readiness) &&
    validBackup(transition.proof.backup, index >= 4) &&
    (index < 1 || transition.proof.piStoppedAt !== null) &&
    (index < 5 || (stopRequestedAt !== undefined && validTimestamp(stopRequestedAt))) &&
    (index < 6 || transition.proof.stop !== null) &&
    (transition.proof.stop === null || stopRequestedAt === transition.proof.stop.requestedAt)
  );
};

const validResumeTransition = (transition: TransitionCase<"Resume">, index: number): boolean =>
  (transition.origin === "Sleeping" || transition.origin === "Failed") &&
  validBackupIdentity(transition.proof.backup) &&
  transition.proof.backup.confirmedAt !== null &&
  transition.proof.ownedBackupIds.includes(transition.proof.backup.backupId) &&
  validTimestamp(transition.proof.watchdogArmedAt) &&
  validReadinessProgress(transition.proof.readiness) &&
  (index < 2 || transition.proof.readiness.runtime !== null) &&
  (index < 4 || transition.proof.readiness.supervisor !== null) &&
  (index < 5 || transition.proof.readiness.transport !== null);

const validWarmWorkTransition = (transition: TransitionCase<"WarmWork">, index: number): boolean =>
  transition.origin === "Warm" &&
  validReadiness(transition.proof.readiness) &&
  validBackup(transition.proof.backups, transition.proof.backups.currentBackupId !== null) &&
  (transition.proof.activity === null ||
    (transition.proof.activity.supervisorEpoch ===
      transition.proof.readiness.supervisor.supervisorEpoch &&
      validActivity(transition.proof.activity))) &&
  nonEmpty(transition.proof.activityGeneration) &&
  (index < 2 || transition.proof.resultCode !== null);

const validVaporizeTransition = (transition: TransitionCase<"Vaporize">, index: number): boolean =>
  validCleanup(transition.proof.cleanup, false) &&
  new Set(transition.proof.ownedBackupIds).size === transition.proof.ownedBackupIds.length &&
  (index < 1 || transition.proof.revokedAt !== null);

export const validTransitionProof = (transition: Transition): boolean => {
  const index = phaseIndex(transition);
  if (
    index < 0 ||
    !orderedTimestamps(transition) ||
    !nonEmpty(transition.nonce) ||
    !nonEmpty(transition.attempt)
  )
    return false;
  return Match.valueTags(transition, {
    Create: (value) => validCreateTransition(value, index),
    Checkpoint: (value) => validCheckpointTransition(value, index),
    Sleep: (value) => validSleepTransition(value, index),
    Resume: (value) => validResumeTransition(value, index),
    WarmWork: (value) => validWarmWorkTransition(value, index),
    Vaporize: (value) => validVaporizeTransition(value, index),
  });
};

export const validateAuthority = (authority: SessionAuthority): boolean =>
  [
    authority.session.id,
    authority.session.title,
    authority.session.repository,
    authority.session.createdAt,
  ].every(nonEmpty) &&
  validTimestamp(authority.session.createdAt) &&
  validHardCap(authority.hardCap) &&
  Number.isInteger(authority.revision) &&
  authority.revision >= 1 &&
  Match.valueTags(authority.state, {
    Stable: ({ stable }) => validStable(stable),
    Transitioning: ({ transition }) => validTransitionProof(transition),
  });
