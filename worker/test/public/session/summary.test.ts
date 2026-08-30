import { assert, describe, it } from "vitest";
import { projectionFromSnapshot } from "../../../public/session/chat.js";
import {
  decodeSummaryEvidence,
  decodeSummaryHatch,
  createHatchStatusLoader,
  extractSummaryReferences,
  summaryProjection,
} from "../../../public/session/summary.js";
import summarySource from "../../../public/session/summary.js?raw";

const sessionId = "a0b1c2d3e4f5";
const evidenceResult = {
  id: "result-1",
  role: "toolResult",
  toolCallId: "tool-1",
  toolName: "scotty_browser_test",
  content: {
    details: {
      jobId: "job-1",
      status: "succeeded",
      summaryUrl: `/s/${sessionId}/evidence/job-1`,
      completedSteps: 1,
      frameCount: 1,
      video: false,
    },
  },
};
const snapshot = (messages: ReadonlyArray<unknown>) => ({
  epoch: "epoch-1",
  sessionRevision: 1,
  baseSequence: 0,
  sequence: 0,
  state: { isStreaming: false },
  messages,
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
});

describe("agent Summary projection", () => {
  it("selects the latest assistant update and verifies its same-conversation reference", () => {
    const projection = projectionFromSnapshot(
      snapshot([
        { id: "u1", role: "user", content: "Check the page" },
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "scotty_browser_test" }],
        },
        evidenceResult,
        {
          id: "a2",
          role: "assistant",
          content: "Looks good. scotty-evidence:job-1",
        },
      ]),
    );

    const summary = summaryProjection(projection, sessionId);
    assert.strictEqual(summary.update, "Looks good. scotty-evidence:job-1");
    assert.deepInclude(summary.artifacts[0], {
      kind: "evidence",
      reference: "scotty-evidence:job-1",
      jobId: "job-1",
    });
  });

  it("does not project a structured result that the assistant did not reference", () => {
    const projection = projectionFromSnapshot(
      snapshot([
        { id: "u1", role: "user", content: "Check the page" },
        evidenceResult,
        { id: "a1", role: "assistant", content: "The run completed." },
      ]),
    );
    assert.deepStrictEqual(summaryProjection(projection, sessionId), {
      update: "The run completed.",
      artifacts: [],
    });
  });

  it("renders invented and stale cross-conversation references as unavailable", () => {
    const projection = projectionFromSnapshot(
      snapshot([
        { id: "u1", role: "user", content: "Check the page" },
        evidenceResult,
        { id: "a1", role: "assistant", content: "scotty-evidence:job-1" },
        { id: "u2", role: "user", content: "Again" },
        {
          id: "a2",
          role: "assistant",
          content: "scotty-evidence:job-1 and scotty-hatch:invented",
        },
      ]),
    );
    assert.deepStrictEqual(summaryProjection(projection, sessionId), {
      update: "scotty-evidence:job-1 and scotty-hatch:invented",
      artifacts: [
        {
          kind: "unavailable",
          reference: "scotty-evidence:job-1",
          label: "Evidence unavailable",
        },
      ],
    });
  });

  it("reconstructs the same Summary after a fresh snapshot", () => {
    const messages = [
      { id: "u1", role: "user", content: "Check the page" },
      evidenceResult,
      { id: "a1", role: "assistant", content: "scotty-evidence:job-1" },
    ];
    const before = summaryProjection(projectionFromSnapshot(snapshot(messages)), sessionId);
    const after = summaryProjection(projectionFromSnapshot(snapshot(messages)), sessionId);
    assert.deepStrictEqual(after, before);
  });

  it("accepts only bounded exact reference markers", () => {
    assert.deepStrictEqual(
      extractSummaryReferences(
        "scotty-evidence:job-1 scotty-evidence:job-1 scotty-hatch:hatch_2 nope:job-1",
      ),
      ["scotty-evidence:job-1", "scotty-hatch:hatch_2"],
    );
  });

  it("decodes allow-listed evidence and Hatch projections", () => {
    const evidencePayload = {
      jobId: "job-1",
      status: "succeeded",
      totalSteps: 1,
      completedSteps: 1,
      frameCount: 1,
      steps: [
        {
          index: 0,
          name: "Home",
          status: "passed",
          assertions: [{ kind: "text", passed: true }],
          frame: { frameId: "frame-1", offsetMillis: 10 },
        },
      ],
    };
    const evidence = decodeSummaryEvidence(evidencePayload, "job-1");
    assert.deepInclude(evidence, { jobId: "job-1", frameCount: 1 });
    assert.isUndefined(decodeSummaryEvidence({ ...evidencePayload, jobId: "other" }, "job-1"));

    assert.deepInclude(
      decodeSummaryEvidence(
        {
          ...evidencePayload,
          status: "failed",
          completedSteps: 0,
          frameCount: 0,
          steps: [],
          failure: { code: "port_conflict" },
        },
        "job-1",
      ),
      { failure: { code: "port_conflict" }, frameCount: 0 },
    );
    assert.isUndefined(
      decodeSummaryEvidence({ ...evidencePayload, failure: { code: "private_failure" } }, "job-1"),
    );

    const recordedEvidence = decodeSummaryEvidence(
      {
        ...evidencePayload,
        video: {
          artifactId: "recording",
          sha256: "a".repeat(64),
          bytes: 1_024,
          capturedAt: "2026-08-30T12:00:00.000Z",
          offsetMillis: 100,
        },
      },
      "job-1",
    );
    assert.deepStrictEqual(recordedEvidence?.video, {
      artifactId: "recording",
      sha256: "a".repeat(64),
      bytes: 1_024,
      capturedAt: "2026-08-30T12:00:00.000Z",
      offsetMillis: 100,
    });
    assert.isUndefined(
      decodeSummaryEvidence(
        { ...evidencePayload, video: { artifactId: "recording", sha256: "not-a-digest" } },
        "job-1",
      ),
    );

    assert.deepStrictEqual(
      decodeSummaryHatch({
        status: "configured",
        hatchId: "hatch-1",
        service: { name: "Preview", port: 4173 },
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "active",
      }),
      {
        configured: true,
        hatchId: "hatch-1",
        serviceName: "Preview",
        observedStatus: "running",
        available: true,
      },
    );
    assert.deepStrictEqual(decodeSummaryHatch({ status: "not_configured" }), {
      configured: false,
      available: false,
    });
    assert.deepStrictEqual(
      decodeSummaryHatch({
        status: "configured",
        hatchId: "hatch-1",
        service: { name: "Preview", port: 4173 },
        desiredStatus: "open",
        observedStatus: "running",
        exposure: "closed",
      }),
      {
        configured: true,
        hatchId: "hatch-1",
        serviceName: "Preview",
        observedStatus: "running",
        available: false,
      },
    );
  });

  it("fences stale fetches and constructs only authenticated same-origin routes", () => {
    assert.include(summarySource, "generation !== currentGeneration");
    assert.include(summarySource, 'credentials: "same-origin"');
    assert.include(summarySource, 'cache: "no-store"');
    assert.include(summarySource, "/api/sessions/");
    assert.include(summarySource, 'hatchTarget.dataset.currentHatch = ""');
    assert.include(summarySource, "public HTTPS ready");
    assert.include(summarySource, "public HTTPS unavailable");
    assert.include(summarySource, "/hatch/open");
    assert.include(summarySource, "/video.webm");
    assert.include(summarySource, "Watch browser recording");
    assert.include(summarySource, "Open full evidence");
    assert.notInclude(summarySource, "localStorage");
    assert.notInclude(summarySource, "innerHTML");
  });

  it("keeps the last verified Hatch state visible while refreshing", async () => {
    const pending: Array<(value: { status: string }) => void> = [];
    const loader = createHatchStatusLoader(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );

    const first = loader.refresh(sessionId);
    const duplicate = loader.refresh(sessionId);
    assert.strictEqual(first, duplicate);
    await Promise.resolve();
    assert.lengthOf(pending, 1);
    pending[0]?.({ status: "not_configured" });
    await first;
    assert.deepStrictEqual(loader.current(sessionId), { status: "not_configured" });

    const refreshing = loader.refresh(sessionId);
    assert.deepStrictEqual(loader.current(sessionId), { status: "not_configured" });
    await Promise.resolve();
    assert.lengthOf(pending, 2);
    pending[1]?.({ status: "configured" });
    await refreshing;
    assert.deepStrictEqual(loader.current(sessionId), { status: "configured" });
  });

  it("does not let an old session Hatch response replace the current session", async () => {
    const pending = new Map<string, (value: { status: string }) => void>();
    const loader = createHatchStatusLoader(
      (id) =>
        new Promise((resolve) => {
          pending.set(id, resolve);
        }),
    );
    const oldRefresh = loader.refresh("old-session");
    await Promise.resolve();
    const currentRefresh = loader.refresh("current-session");
    await Promise.resolve();
    pending.get("old-session")?.({ status: "configured" });
    await oldRefresh;
    assert.isUndefined(loader.current("current-session"));
    pending.get("current-session")?.({ status: "not_configured" });
    await currentRefresh;
    assert.deepStrictEqual(loader.current("current-session"), { status: "not_configured" });
  });
});
