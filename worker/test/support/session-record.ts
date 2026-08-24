import type { SessionOperationFailureCode, SessionRecord } from "../../src/contracts";
import { TEST_SANDBOX_SNAPSHOT } from "./sandbox-snapshot";

const stoppedOperationResult = (): NonNullable<SessionRecord["operationResult"]> => ({
  kind: "snapshot",
  stage: "commit",
  progress: "completed",
  lastProvenEffect: "runtime_stopped",
  retainedState: "checkpoint",
  ambiguity: "none",
  safeRetry: "none",
  humanAction: "resume",
  outcome: { status: "succeeded" },
  stoppedReason: "snapshot",
  recoveryAction: "resume",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
});

const activeOperationResult = (
  record: SessionRecord,
): NonNullable<SessionRecord["operationResult"]> => {
  if (record.operation === null) throw new TypeError("An active operation is required");
  const stageByKind = {
    create: "setup",
    snapshot: "checkpoint",
    resume: "restore",
    refresh: "refresh",
    evidence: "evidence",
    hatch: "hatch",
    down: "publish",
    vaporize: "cleanup",
  } as const;
  return {
    kind: record.operation.kind,
    stage: stageByKind[record.operation.kind],
    progress: "running",
    lastProvenEffect:
      record.status === "warm"
        ? "runtime_ready"
        : record.status === "stopped"
          ? "runtime_stopped"
          : "session_created",
    retainedState: record.status === "stopped" ? "checkpoint" : "operation_lease",
    ambiguity: "none",
    safeRetry: "none",
    humanAction: "none",
    outcome: { status: "pending" },
    ...(record.status === "stopped" ? { stoppedReason: "runtime_exit" as const } : {}),
    recoveryAction: "none",
    startedAt: record.operation.startedAt,
    updatedAt: record.updatedAt,
  };
};

export const makeSessionRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => {
  const record: SessionRecord = {
    version: 1,
    id: "a0b1c2d3e4f5",
    status: "warm",
    operation: null,
    operationResult: null,
    execution: { provider: "cloudflare" },
    provider: "cloudflare",
    repo: "owner/project",
    repoExistsAtCreate: true,
    defaultBranch: "dev",
    branch: "scotty/a0b1c2d3e4f5",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    hardCapAt: "2026-01-01T04:00:00.000Z",
    hardCapDurationSeconds: 14_400,
    sandboxBundle: {
      revision: TEST_SANDBOX_SNAPSHOT.revision,
      digest: TEST_SANDBOX_SNAPSHOT.digest,
      manifestVersion: 1,
    },
    ownedBackupIds: [],
    piSessionTransportToken: "a".repeat(64),
    ...overrides,
    title: overrides.title ?? "Test session",
  };
  const recordWithOperationResult =
    record.operation !== null && overrides.operationResult === undefined
      ? { ...record, operationResult: activeOperationResult(record) }
      : record;
  if (recordWithOperationResult.status !== "stopped") return recordWithOperationResult;
  return {
    ...recordWithOperationResult,
    operationResult: recordWithOperationResult.operationResult ?? stoppedOperationResult(),
    backup: recordWithOperationResult.backup ?? {
      current: {
        id: "backup-1",
        dir: "/workspace/a0b1c2d3e4f5",
        localBucket: true,
      },
    },
  };
};

export const sessionOperationFailure = (record: SessionRecord | undefined) => {
  const outcome = record?.operationResult?.outcome;
  return outcome?.status === "failed" ? outcome.failure : undefined;
};

export const makeFailedOperationResult = (
  code: SessionOperationFailureCode,
  message: string,
  safeToRetry = false,
): NonNullable<SessionRecord["operationResult"]> => ({
  kind: "snapshot",
  stage: "checkpoint",
  progress: "completed",
  lastProvenEffect: "runtime_ready",
  retainedState: "session",
  ambiguity: "none",
  safeRetry: safeToRetry ? "retry_operation" : "none",
  humanAction: safeToRetry ? "retry" : "inspect",
  outcome: { status: "failed", failure: { code, message } },
  recoveryAction: safeToRetry ? "retry" : "vaporize",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
});
