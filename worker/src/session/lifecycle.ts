import type { SessionRecord } from "./contracts";

export const SESSION_SCHEDULE_CALLBACKS = [
  "expireEvidenceJob",
  "expireRetainedEvidence",
  "retryHatchCleanup",
  "sessionActorDeadline",
  "sessionActorHardCapDrain",
  "sessionActorHardCap",
] as const;

export const hardCapDrainAt = (deadlineAt: string, durationSeconds: number): string =>
  new Date(
    Date.parse(deadlineAt) - Math.min(5 * 60_000, Math.floor((durationSeconds * 1_000) / 2)),
  ).toISOString();

export const sessionAllowsRuntimeAccess = (
  record: SessionRecord | undefined,
): record is SessionRecord =>
  record !== undefined && record.status !== "gone" && record.operation?.kind !== "vaporize";
