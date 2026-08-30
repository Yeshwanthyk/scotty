import { Schema } from "effect";

export const SessionDeploymentRecordStatusSchema = Schema.Literals([
  "booting",
  "warm",
  "sleeping",
  "failed",
  "gone",
]);
export type SessionDeploymentRecordStatus = typeof SessionDeploymentRecordStatusSchema.Type;

export const SessionDeploymentAgentStateSchema = Schema.Literals([
  "working",
  "waiting",
  "completed",
  "tool-stalled",
]);
export type SessionDeploymentAgentState = typeof SessionDeploymentAgentStateSchema.Type;

export const SessionDeploymentRuntimeStateSchema = Schema.Literals([
  "running",
  "stopped",
  "unreachable",
  "unknown",
]);
export type SessionDeploymentRuntimeState = typeof SessionDeploymentRuntimeStateSchema.Type;

export const SessionDeploymentPiStateSchema = Schema.Literals([
  "reachable",
  "unreachable",
  "not_running",
  "unknown",
]);
export type SessionDeploymentPiState = typeof SessionDeploymentPiStateSchema.Type;

export const SessionDeploymentReadinessReasonSchema = Schema.Literals([
  "record_booting",
  "record_warm",
  "record_failed",
  "record_unknown",
  "lifecycle_busy",
  "agent_working",
  "runtime_running",
  "runtime_unreachable",
  "pi_unreachable",
  "sleeping_checkpointed",
  "gone",
]);
export type SessionDeploymentReadinessReason = typeof SessionDeploymentReadinessReasonSchema.Type;

export const SessionDeploymentReadinessSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  recordStatus: SessionDeploymentRecordStatusSchema,
  operation: Schema.NullOr(Schema.String),
  agentState: Schema.optionalKey(SessionDeploymentAgentStateSchema),
  lastAgentEventAt: Schema.optionalKey(Schema.String),
  runtime: SessionDeploymentRuntimeStateSchema,
  pi: SessionDeploymentPiStateSchema,
  ready: Schema.Boolean,
  reason: SessionDeploymentReadinessReasonSchema,
});
export type SessionDeploymentReadiness = typeof SessionDeploymentReadinessSchema.Type;

export const SessionDeploymentReadinessResponseSchema = Schema.Array(
  SessionDeploymentReadinessSchema,
);
export type SessionDeploymentReadinessResponse =
  typeof SessionDeploymentReadinessResponseSchema.Type;

export interface SessionDeploymentReadinessInput {
  readonly id: string;
  readonly title: string;
  readonly recordStatus: SessionDeploymentRecordStatus;
  readonly operation: string | null;
  readonly agentState?: SessionDeploymentAgentState;
  readonly lastAgentEventAt?: string;
  readonly runtime: SessionDeploymentRuntimeState;
  readonly pi: SessionDeploymentPiState;
}

/**
 * A Container image update is safe only after the Session has checkpointed and
 * its runtime is stopped. This is deliberately conservative: unknown and
 * failed states remain blockers until an operator can inspect them.
 */
export const assessSessionDeploymentReadiness = (
  input: SessionDeploymentReadinessInput,
): SessionDeploymentReadiness => {
  const shared = {
    id: input.id,
    title: input.title,
    recordStatus: input.recordStatus,
    operation: input.operation,
    ...(input.agentState === undefined ? {} : { agentState: input.agentState }),
    ...(input.lastAgentEventAt === undefined ? {} : { lastAgentEventAt: input.lastAgentEventAt }),
    runtime: input.runtime,
    pi: input.pi,
  };

  if (input.operation !== null) return { ...shared, ready: false, reason: "lifecycle_busy" };
  if (input.agentState === "working") return { ...shared, ready: false, reason: "agent_working" };
  if (input.runtime === "unreachable")
    return { ...shared, ready: false, reason: "runtime_unreachable" };
  if (input.runtime === "running") return { ...shared, ready: false, reason: "runtime_running" };
  if (input.recordStatus === "booting")
    return { ...shared, ready: false, reason: "record_booting" };
  if (input.recordStatus === "warm") return { ...shared, ready: false, reason: "record_warm" };
  if (input.recordStatus === "failed") return { ...shared, ready: false, reason: "record_failed" };
  if (input.recordStatus === "gone") return { ...shared, ready: true, reason: "gone" };
  if (input.recordStatus === "sleeping" && input.runtime === "stopped")
    return { ...shared, ready: true, reason: "sleeping_checkpointed" };
  return { ...shared, ready: false, reason: "record_unknown" };
};
