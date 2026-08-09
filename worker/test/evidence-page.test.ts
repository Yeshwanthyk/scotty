import { assert, describe, it } from "vitest";
import {
  evidenceStatusLabel,
  isTerminalEvidenceStatus,
  orderedEvidenceFrames,
  shouldPollEvidence,
} from "../public/evidence-view.js";
import evidenceHtml from "../public/evidence.html?raw";
import evidenceScript from "../public/evidence.js?raw";

describe("evidence page", () => {
  it("uses a focused authenticated shell without inline code", () => {
    assert.notInclude(evidenceHtml, "<style>");
    assert.notInclude(evidenceHtml, '<script type="module">');
    assert.include(evidenceHtml, '<link rel="stylesheet" href="/evidence.css" />');
    assert.include(evidenceHtml, '<script type="module" src="/evidence.js"></script>');
  });

  it("orders verified screenshots by monotonic frame offset", () => {
    const frames = orderedEvidenceFrames({
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
      frames.map((frame) => frame.frameId),
      ["first", "second"],
    );
    assert.strictEqual(evidenceStatusLabel("failed"), "Failed");
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

  it("renders verified screenshots without a synthetic replay or unsafe HTML", () => {
    assert.include(evidenceScript, 'panel.className = "evidence-frames-panel"');
    assert.notInclude(evidenceScript, "toggleReplay");
    assert.notInclude(evidenceScript, ".innerHTML");
    assert.notInclude(evidenceHtml, "<video");
  });
});
