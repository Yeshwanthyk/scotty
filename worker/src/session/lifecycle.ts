import type { SessionRecord } from "./contracts";

export const SESSION_SCHEDULE_CALLBACKS = [
  "expireEvidenceJob",
  "expireRetainedEvidence",
  "retryHatchCleanup",
  "sessionActorDeadline",
  "sessionActorHardCap",
] as const;

export const sessionAllowsRuntimeAccess = (
  record: SessionRecord | undefined,
): record is SessionRecord =>
  record !== undefined && record.status !== "gone" && record.operation?.kind !== "vaporize";
