import type { SessionRecord } from "./contracts";

export const SESSION_SCHEDULE_CALLBACKS = [
  "drainSidecarFollowUps",
  "expireEvidenceJob",
  "expireRetainedEvidence",
  "retryHatchCleanup",
  "sessionActorDeadline",
  "sessionActorHardCapDrain",
  "sessionActorCheckpointMidpoint",
  "sessionActorHardCap",
] as const;

export const hardCapDrainAt = (deadlineAt: string, durationSeconds: number): string =>
  new Date(
    Date.parse(deadlineAt) - Math.min(10 * 60_000, Math.floor((durationSeconds * 1_000) / 2)),
  ).toISOString();

export const legacyHardCapDrainAt = (deadlineAt: string, durationSeconds: number): string =>
  new Date(
    Date.parse(deadlineAt) - Math.min(5 * 60_000, Math.floor((durationSeconds * 1_000) / 2)),
  ).toISOString();

export const hardCapMidpointAt = (deadlineAt: string, durationSeconds: number): string =>
  new Date(Date.parse(deadlineAt) - Math.floor((durationSeconds * 1_000) / 2)).toISOString();

export const sessionAllowsRuntimeAccess = (
  record: SessionRecord | undefined,
): record is SessionRecord =>
  record !== undefined && record.status !== "gone" && record.operation?.kind !== "vaporize";
