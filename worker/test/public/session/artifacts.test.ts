import { assert, describe, it } from "vitest";
import { artifactForTool } from "../../../public/session/artifacts.js";
import artifactsSource from "../../../public/session/artifacts.js?raw";

const sessionId = "a0b1c2d3e4f5";

describe("session artifacts", () => {
  it("creates an authenticated Evidence card only from the exact structured result", () => {
    const artifact = artifactForTool(
      {
        name: "scotty_browser_test",
        result: {
          details: {
            jobId: "job-1",
            status: "succeeded",
            summaryUrl: `/s/${sessionId}/evidence/job-1`,
            completedSteps: 3,
            frameCount: 2,
            video: true,
          },
        },
      },
      sessionId,
    );
    assert.deepStrictEqual(artifact, {
      kind: "evidence",
      reference: "scotty-evidence:job-1",
      jobId: "job-1",
      label: "Browser evidence",
      status: "succeeded",
      completedSteps: 3,
      frameCount: 2,
      video: true,
      href: `/s/${sessionId}/evidence/job-1`,
    });
  });

  it("rejects malformed, cross-session, and arbitrary Evidence URLs", () => {
    for (const summaryUrl of [
      "/s/ffffffffffff/evidence/job-1",
      "https://example.com/evidence/job-1",
      `/s/${sessionId}/evidence/other`,
    ]) {
      assert.deepStrictEqual(
        artifactForTool(
          {
            name: "scotty_browser_test",
            details: {
              jobId: "job-1",
              status: "failed",
              summaryUrl,
              completedSteps: 1,
              frameCount: 0,
              video: false,
            },
          },
          sessionId,
        ),
        { kind: "unavailable", label: "Evidence unavailable" },
      );
    }
  });

  it("exposes only the authenticated Hatch handoff when the service is open", () => {
    const hatch = {
      operation: "status",
      reference: "scotty-hatch:hatch-1",
      hatch: {
        status: "configured",
        hatchId: "hatch-1",
        service: { name: "Preview", port: 4173 },
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "active",
      },
      process: { status: "running", stdoutTail: "", stderrTail: "" },
    };
    assert.deepStrictEqual(artifactForTool({ name: "scotty_hatch", details: hatch }, sessionId), {
      kind: "hatch",
      reference: "scotty-hatch:hatch-1",
      hatchId: "hatch-1",
      label: "Preview",
      status: "running",
      available: true,
    });
    assert.notProperty(
      artifactForTool(
        {
          name: "scotty_hatch",
          details: { ...hatch, hatch: { ...hatch.hatch, exposure: "closed" } },
        },
        sessionId,
      ),
      "href",
    );
    assert.include(artifactsSource, "Historical result ·");
    assert.notInclude(artifactsSource, 'artifact.kind === "hatch" ? "Open Hatch"');
  });
});
