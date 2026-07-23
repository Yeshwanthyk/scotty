import type { SessionRecord } from "./contracts";

export const SESSION_SCHEDULE_CALLBACKS = [
  "captureThreadId",
  "enforceHardCap",
  "expireTerminalAttachment",
  "finalizeManagedStop",
  "finalizeTerminalAttachment",
  "retryHardCapDestroy",
  "retryVaporizeSession",
] as const;

export const VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS = SESSION_SCHEDULE_CALLBACKS.filter(
  (callback) => callback !== "retryVaporizeSession",
);

export const sessionAllowsRuntimeAccess = (
  record: SessionRecord | undefined,
): record is SessionRecord =>
  record !== undefined && record.status !== "gone" && record.operation?.kind !== "vaporize";

export const hardCapObservationIsCurrent = (
  observed: SessionRecord,
  current: SessionRecord | undefined,
): current is SessionRecord =>
  current !== undefined &&
  current.id === observed.id &&
  current.status === observed.status &&
  current.updatedAt === observed.updatedAt &&
  current.hardCapAt === observed.hardCapAt &&
  current.operation?.nonce === observed.operation?.nonce;
