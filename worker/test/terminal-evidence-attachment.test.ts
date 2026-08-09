import { assert, describe, it } from "vitest";
import {
  browserEvidenceAttachment,
  browserEvidenceNoFrameCopy,
  browserEvidencePaths,
  browserEvidenceSummary,
} from "../public/terminal-evidence-attachment.js";

const SESSION_ID = "a0b1c2d3e4f5";
const JOB_ID = "job-abcd1234";

const details = () => ({
  version: 2,
  jobId: JOB_ID,
  status: "failed",
  summaryUrl: `/s/${SESSION_ID}/evidence/${JOB_ID}`,
  completedSteps: 2,
  frameCount: 1,
  video: false,
  failure: { code: "assertion_mismatch", step: 1 },
});

const summary = () => ({
  version: 2,
  sequence: 3,
  jobId: JOB_ID,
  status: "failed",
  acceptedAt: "2026-08-07T12:00:00.000Z",
  startedAt: "2026-08-07T12:00:00.100Z",
  completedAt: "2026-08-07T12:00:02.000Z",
  totalSteps: 2,
  completedSteps: 2,
  viewport: { width: 1_280, height: 720 },
  recordVideo: false,
  flowHash: "a".repeat(64),
  steps: [
    {
      index: 0,
      name: "Open home",
      action: "goto",
      status: "passed",
      assertions: [
        { kind: "visible", passed: true },
        { kind: "urlPath", passed: true },
      ],
      startedAt: "2026-08-07T12:00:00.100Z",
      completedAt: "2026-08-07T12:00:01.000Z",
      offsetMillis: 900,
      frame: {
        frameId: "frame-1",
        sha256: "a".repeat(64),
        bytes: 1234,
        capturedAt: "2026-08-07T12:00:01.000Z",
        offsetMillis: 900,
      },
    },
    {
      index: 1,
      name: "Submit form",
      action: "click",
      status: "failed",
      assertions: [{ kind: "textExact", passed: false }],
      startedAt: "2026-08-07T12:00:01.100Z",
      completedAt: "2026-08-07T12:00:02.000Z",
      offsetMillis: 1_900,
    },
  ],
  frameCount: 1,
  failure: { code: "assertion_mismatch", step: 1 },
});

describe("terminal browser evidence attachment adapter", () => {
  it("normalizes only live and persisted structured result details", () => {
    const live = browserEvidenceAttachment(
      { name: "scotty_browser_test", result: { content: [], details: details() } },
      SESSION_ID,
    );
    const persisted = browserEvidenceAttachment(
      { toolName: "scotty_browser_test", content: [], details: details() },
      SESSION_ID,
    );

    for (const attachment of [live, persisted]) {
      assert.deepInclude(attachment, {
        kind: "evidence",
        jobId: JOB_ID,
        status: "failed",
        completedSteps: 2,
        frameCount: 1,
      });
      assert.notProperty(attachment, "summaryUrl");
    }
  });

  it("leaves generic and running tools unchanged and never parses transcript text", () => {
    assert.isUndefined(browserEvidenceAttachment({ name: "bash", details: details() }, SESSION_ID));
    assert.isUndefined(
      browserEvidenceAttachment({ name: "scotty_browser_test", status: "running" }, SESSION_ID),
    );
    assert.deepStrictEqual(
      browserEvidenceAttachment(
        {
          name: "scotty_browser_test",
          result: `Authenticated summary: /s/${SESSION_ID}/evidence/${JOB_ID}`,
        },
        SESSION_ID,
      ),
      { kind: "unavailable" },
    );
  });

  it("fails safely for mismatched routes, extra storage data, and malformed identifiers", () => {
    for (const unsafe of [
      { ...details(), summaryUrl: `/s/ffffffffffff/evidence/${JOB_ID}` },
      { ...details(), summaryUrl: `/s/${SESSION_ID}/evidence/other-job` },
      { ...details(), objectKey: "evidence/v2/private/storage-key.png" },
      { ...details(), jobId: "../private" },
    ]) {
      assert.deepStrictEqual(
        browserEvidenceAttachment(
          { name: "scotty_browser_test", result: { details: unsafe } },
          SESSION_ID,
        ),
        { kind: "unavailable" },
      );
    }
  });

  it("constructs authenticated same-origin summary, detail, and frame paths locally", () => {
    const paths = browserEvidencePaths(SESSION_ID, JOB_ID);
    assert.ok(paths);
    assert.strictEqual(paths.summary, `/api/sessions/${SESSION_ID}/evidence/${JOB_ID}`);
    assert.strictEqual(paths.detail, `/s/${SESSION_ID}/evidence/${JOB_ID}`);
    assert.strictEqual(
      paths.frame("frame-1"),
      `/s/${SESSION_ID}/evidence/${JOB_ID}/frames/frame-1.png`,
    );
    assert.isUndefined(paths.frame("../private"));
    assert.isUndefined(browserEvidencePaths("wrong-session", JOB_ID));
  });

  it("projects assertion counts and frame identities from the authenticated summary", () => {
    const attachment = browserEvidenceAttachment(
      { name: "scotty_browser_test", result: { details: details() } },
      SESSION_ID,
    );
    const projected = browserEvidenceSummary(summary(), attachment);

    assert.deepStrictEqual(projected, {
      status: "failed",
      passedAssertions: 2,
      totalAssertions: 3,
      frames: [{ frameId: "frame-1", stepIndex: 0, stepName: "Open home" }],
    });
  });

  it("accepts the public contract's unbounded non-negative counters and indexes", () => {
    const attachment = browserEvidenceAttachment(
      { name: "scotty_browser_test", result: { details: details() } },
      SESSION_ID,
    );
    const contractEdge = summary();
    contractEdge.completedSteps = 20;
    contractEdge.frameCount = 1;
    contractEdge.failure = { code: "assertion_mismatch", step: 19 };
    contractEdge.steps[0].index = 19;

    assert.deepInclude(browserEvidenceSummary(contractEdge, attachment), {
      status: "failed",
      frames: [{ frameId: "frame-1", stepIndex: 19, stepName: "Open home" }],
    });
  });

  it("provides explicit zero-frame copy for every terminal status", () => {
    assert.strictEqual(
      browserEvidenceNoFrameCopy("succeeded"),
      "The run passed, but no screenshots were published.",
    );
    assert.strictEqual(
      browserEvidenceNoFrameCopy("failed"),
      "The run failed before a screenshot was available.",
    );
    assert.strictEqual(
      browserEvidenceNoFrameCopy("interrupted"),
      "The run ended before a screenshot was available.",
    );
    assert.strictEqual(
      browserEvidenceNoFrameCopy("unsupported"),
      "This browser could not publish a screenshot for the run.",
    );
  });

  it("rejects summaries for another job, malformed frames, or inconsistent frame counts", () => {
    const attachment = browserEvidenceAttachment(
      { name: "scotty_browser_test", result: { details: details() } },
      SESSION_ID,
    );
    assert.isUndefined(browserEvidenceSummary({ ...summary(), jobId: "other-job" }, attachment));
    assert.isUndefined(browserEvidenceSummary({ ...summary(), frameCount: 2 }, attachment));
    const malformedFrame = summary();
    malformedFrame.steps[0].frame = {
      ...malformedFrame.steps[0].frame,
      frameId: "../private",
    } as (typeof malformedFrame.steps)[number]["frame"];
    assert.isUndefined(browserEvidenceSummary(malformedFrame, attachment));
  });
});
