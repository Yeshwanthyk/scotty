import { assert, describe, it } from "@effect/vitest";
import {
  assessSessionDeploymentReadiness,
  SessionDeploymentReadinessResponseSchema,
} from "../../../protocol/session-deployment-safety";
import { Schema } from "effect";

const base = {
  id: "session-1",
  title: "Fix deploy safety",
  recordStatus: "sleeping" as const,
  operation: null,
  runtime: "stopped" as const,
  agentRuntime: { agent: "pi" as const, state: "not_running" as const },
};
const decodeReadinessResponse = Schema.decodeUnknownSync(SessionDeploymentReadinessResponseSchema);

describe("session deployment readiness", () => {
  it("allows only checkpointed sleeping sessions with stopped runtimes", () => {
    assert.deepStrictEqual(assessSessionDeploymentReadiness(base), {
      ...base,
      ready: true,
      reason: "sleeping_checkpointed",
    });
  });

  it("blocks warm sessions while reporting the selected agent runtime", () => {
    const readiness = assessSessionDeploymentReadiness({
      ...base,
      recordStatus: "warm",
      runtime: "running",
      agentRuntime: { agent: "codex", state: "unknown" },
    });
    assert.deepInclude(readiness, {
      ready: false,
      reason: "runtime_running",
      recordStatus: "warm",
      runtime: "running",
      agentRuntime: { agent: "codex", state: "unknown" },
    });
  });

  it("prioritizes persisted lifecycle leases and agent work", () => {
    assert.strictEqual(
      assessSessionDeploymentReadiness({
        ...base,
        operation: "snapshot",
        runtime: "stopped",
      }).reason,
      "lifecycle_busy",
    );
    assert.strictEqual(
      assessSessionDeploymentReadiness({
        ...base,
        agentState: "working",
        runtime: "stopped",
      }).reason,
      "agent_working",
    );
  });

  it("blocks unknown or unreachable runtime observations", () => {
    assert.strictEqual(
      assessSessionDeploymentReadiness({ ...base, runtime: "unreachable" }).reason,
      "runtime_unreachable",
    );
    assert.strictEqual(
      assessSessionDeploymentReadiness({ ...base, runtime: "unknown" }).reason,
      "record_unknown",
    );
  });

  it("owns a strict JSON response contract", () => {
    assert.deepStrictEqual(decodeReadinessResponse([assessSessionDeploymentReadiness(base)]), [
      assessSessionDeploymentReadiness(base),
    ]);
  });
});
