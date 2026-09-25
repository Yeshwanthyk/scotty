import { assert, describe, it } from "vitest";
import {
  evidenceFailurePresentation,
  evidenceStatusLabel,
  isTerminalEvidenceStatus,
  orderedEvidenceFrames,
  orderedEvidenceSteps,
  shouldPollEvidence,
} from "../../../public/evidence/view.js";
import evidenceScript from "../../../public/evidence/index.js?raw";

describe("evidence page", () => {
  it("orders checkpoints by offsets and falls back to checkpoint index", () => {
    const withFrames = orderedEvidenceSteps({
      steps: [
        {
          index: 1,
          name: "Second",
          status: "failed",
          frame: { frameId: "second", offsetMillis: 5_500 },
        },
        {
          index: 0,
          name: "First",
          status: "passed",
          frame: { frameId: "first", offsetMillis: 500 },
        },
      ],
    });
    assert.deepStrictEqual(
      withFrames.map((step) => step.name),
      ["First", "Second"],
    );
    assert.deepStrictEqual(
      orderedEvidenceFrames({ steps: withFrames }).map((frame) => frame.frameId),
      ["first", "second"],
    );
    assert.strictEqual(evidenceStatusLabel("failed"), "Failed");

    const withMissingFrame = orderedEvidenceSteps({
      steps: [
        {
          index: 2,
          name: "Third",
          status: "passed",
          frame: { frameId: "third", offsetMillis: 100 },
        },
        { index: 0, name: "First", status: "passed" },
        {
          index: 1,
          name: "Second",
          status: "passed",
          frame: { frameId: "second", offsetMillis: 200 },
        },
      ],
    });
    assert.deepStrictEqual(
      withMissingFrame.map((step) => step.name),
      ["First", "Second", "Third"],
    );
  });

  it("polls while any run is active and stops at every terminal state", () => {
    assert.isFalse(isTerminalEvidenceStatus("running"));
    for (const status of ["succeeded", "failed", "interrupted", "unsupported"]) {
      assert.isTrue(isTerminalEvidenceStatus(status));
      assert.isFalse(shouldPollEvidence({ status }, true));
    }
    assert.isTrue(shouldPollEvidence({ status: "accepted" }, true));
    assert.isTrue(shouldPollEvidence([{ status: "succeeded" }, { status: "finalizing" }], false));
    assert.isFalse(shouldPollEvidence([{ status: "succeeded" }, { status: "failed" }], false));
    assert.include(evidenceScript, "const POLL_INTERVAL = 1_000");
    assert.include(evidenceScript, "schedulePoll(shouldPollEvidence(payload, true))");
  });

  it("shows the actionable reason for zero-frame target and capture failures", () => {
    assert.deepStrictEqual(evidenceFailurePresentation({ code: "port_conflict" }), {
      title: "Evidence target conflicts with Hatch",
      detail: "The requested app port is owned by Hatch or is still exposed.",
      hint: "Start a separate temporary app server on a different port, then rerun the same flow. Leave Hatch running.",
    });
    assert.deepInclude(evidenceFailurePresentation({ code: "artifact_invalid", step: 0 }), {
      title: "Evidence capture failed",
      detail: "Evidence did not produce a valid screenshot or recording.",
    });
    assert.include(evidenceScript, "evidenceFailurePresentation(summary.failure)");
  });

  it("evidence page script never writes innerHTML", () => {
    assert.notInclude(evidenceScript, ".innerHTML");
  });
});
