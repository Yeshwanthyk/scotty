import type { SessionRecord } from "./contracts";

export const SESSION_SCHEDULE_CALLBACKS = [
  "expireEvidenceJob",
  "expireRetainedEvidence",
  "retryHatchCleanup",
  "retryVaporizeSession",
  "sessionActorDeadline",
  "sessionActorHardCap",
] as const;

export const VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS = SESSION_SCHEDULE_CALLBACKS.filter(
  (callback) => callback !== "retryVaporizeSession",
);

export const sessionAllowsRuntimeAccess = (
  record: SessionRecord | undefined,
): record is SessionRecord =>
  record !== undefined && record.status !== "gone" && record.operation?.kind !== "vaporize";
