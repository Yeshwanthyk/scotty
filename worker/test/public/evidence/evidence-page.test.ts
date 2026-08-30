import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { assert, describe, it } from "vitest";
import {
  evidenceFailurePresentation,
  evidenceStatusLabel,
  isTerminalEvidenceStatus,
  orderedEvidenceFrames,
  orderedEvidenceSteps,
  shouldPollEvidence,
} from "../../../public/evidence/view.js";
import evidenceHtml from "../../../public/evidence/index.html?raw";
import evidenceScript from "../../../public/evidence/index.js?raw";

const evidenceStyles = readFileSync(
  new URL("../../../public/evidence/styles.css", import.meta.url),
  "utf8",
);

describe("evidence page", () => {
  it("uses a focused authenticated shell without inline code", () => {
    assert.notInclude(evidenceHtml, "<style>");
    assert.notInclude(evidenceHtml, '<script type="module">');
    assert.include(evidenceHtml, '<link rel="stylesheet" href="/evidence/styles.css" />');
    assert.include(evidenceHtml, '<script type="module" src="/evidence/index.js"></script>');
    assert.include(evidenceHtml, '<details class="mobile-utilities">');
    assert.include(evidenceHtml, 'id="session-link-mobile"');
    assert.include(evidenceHtml, 'id="evidence-list-link-mobile"');
  });

  it("orders checkpoints and screenshots by monotonic frame offset", () => {
    const summary = {
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
    };
    const steps = orderedEvidenceSteps(summary);
    const frames = orderedEvidenceFrames(summary);
    assert.deepStrictEqual(
      steps.map((step) => step.name),
      ["First", "Second"],
    );
    assert.deepStrictEqual(
      frames.map((frame) => frame.frameId),
      ["first", "second"],
    );
    assert.strictEqual(evidenceStatusLabel("failed"), "Failed");
  });

  it("uses checkpoint index when only some steps have a frame offset", () => {
    const steps = orderedEvidenceSteps({
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
      steps.map((step) => step.name),
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

  it("renders verified screenshots without a synthetic replay or unsafe HTML", () => {
    assert.include(evidenceScript, 'panel.className = "evidence-frames-panel"');
    assert.include(evidenceScript, 'link.className = "evidence-frame-link"');
    assert.include(evidenceScript, "link.href = framePath(frame.frameId)");
    assert.include(evidenceScript, 'link.setAttribute("aria-label"');
    assert.include(evidenceStyles, ".evidence-frame-link:focus-visible");
    assert.include(evidenceStyles, ".evidence-page .subtitle");
    assert.match(evidenceStyles, /\.evidence-step-action,[\s\S]*?font-size: 0\.8rem;/u);
    assert.match(evidenceStyles, /\.evidence-frames-grid figcaption[\s\S]*?font-size: 0\.8rem;/u);
    assert.notInclude(evidenceScript, "toggleReplay");
    assert.notInclude(evidenceScript, ".innerHTML");
    assert.notInclude(evidenceHtml, "<video");
  });
});
