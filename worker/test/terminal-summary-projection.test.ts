import { assert, describe, it } from "vitest";
import {
  browserHatchPaths,
  browserHatchReference,
  browserHatchStatus,
  hatchActions,
} from "../public/terminal-hatch-reference.js";
import {
  assistantEvidenceReferences,
  assistantHatchReferences,
  projectSessionSummary,
} from "../public/terminal-summary-projection.js";
import terminalHtml from "../public/terminal.html?raw";
import terminalSource from "../public/terminal.js?raw";

const SESSION_ID = "a0b1c2d3e4f5";
const JOB_ID = "job-abcd1234";
const HATCH_ID = "hatch-abcd1234";

const evidenceTool = (jobId = JOB_ID, video = false, id = "tool-1") => ({
  id,
  name: "scotty_browser_test",
  status: "done",
  result: {
    details: {
      version: 2,
      jobId,
      status: "succeeded",
      summaryUrl: `/s/${SESSION_ID}/evidence/${jobId}`,
      completedSteps: 1,
      frameCount: 1,
      video,
    },
  },
});

const hatchStatus = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  version: 1 as const,
  status: "configured" as const,
  hatchId: HATCH_ID,
  generation: 2,
  service: { name: "Web", port: 4_173 },
  desiredStatus: "open" as const,
  observedStatus: "running" as const,
  exposure: "active" as const,
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:01:00.000Z",
  lastHealthyAt: "2026-08-09T10:01:00.000Z",
  ...overrides,
});

const hatchTool = () => ({
  id: "tool-hatch",
  name: "scotty_hatch",
  status: "done",
  result: {
    details: {
      version: 1,
      operation: "ensure",
      reference: `scotty-hatch:${HATCH_ID}`,
      hatch: hatchStatus(),
      process: { status: "running", stdoutTail: "", stderrTail: "" },
    },
  },
});

const conversationWithEvidence = (update: string) => {
  const tool = evidenceTool();
  return {
    messages: [
      { role: "user", id: "user-1", content: "Check the page" },
      {
        role: "assistant",
        id: "assistant-1",
        content: [{ type: "toolCall", id: tool.id, name: tool.name, arguments: {} }],
      },
      { role: "toolResult", id: tool.id, toolCallId: tool.id, content: tool.result },
      { role: "assistant", id: "assistant-2", content: [{ type: "text", text: update }] },
    ],
    tools: new Map([[tool.id, tool]]),
  };
};

describe("terminal Summary projection", () => {
  it("selects the latest assistant update and validates same-conversation evidence", () => {
    const current = conversationWithEvidence(
      `The responsive flow is ready.\n\n[Review the run](scotty-evidence:${JOB_ID})`,
    );
    const projection = projectSessionSummary(current.messages, current.tools, SESSION_ID);

    if (projection.kind !== "summary") throw new Error("Expected a Summary projection");
    assert.include(projection.update, "responsive flow is ready");
    assert.lengthOf(projection.evidence, 1);
    const evidence = projection.evidence[0];
    if (evidence?.kind !== "evidence") throw new Error("Expected validated evidence");
    assert.deepInclude(evidence, {
      kind: "evidence",
      jobId: JOB_ID,
      status: "succeeded",
    });
    assert.strictEqual(evidence.paths.summary, `/api/sessions/${SESSION_ID}/evidence/${JOB_ID}`);
  });

  it("projects one private Showcase link from referenced before and recorded after proof", () => {
    const before = evidenceTool("job-before", false, "tool-before");
    const after = evidenceTool("job-after", true, "tool-after");
    const messages = [
      { role: "user", id: "user-showcase", content: "Make and prove the change" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: before.id, name: before.name, arguments: {} },
          { type: "toolCall", id: after.id, name: after.name, arguments: {} },
        ],
      },
      { role: "toolResult", id: before.id, toolCallId: before.id, content: before.result },
      { role: "toolResult", id: after.id, toolCallId: after.id, content: after.result },
      {
        role: "assistant",
        content: `Verified scotty-evidence:job-before and scotty-evidence:job-after`,
      },
    ];

    assert.deepInclude(
      projectSessionSummary(
        messages,
        new Map([
          [before.id, before],
          [after.id, after],
        ]),
        SESSION_ID,
      ),
      {
        showcase: {
          beforeJobId: "job-before",
          afterJobId: "job-after",
          path: `/s/${SESSION_ID}/showcase/job-before/job-after`,
        },
      },
    );
  });

  it("fails a valid reference closed when its tool result belongs to another conversation", () => {
    const current = conversationWithEvidence("First update");
    current.messages.push(
      { role: "user", id: "user-2", content: "What changed?" },
      {
        role: "assistant",
        id: "assistant-3",
        content: [{ type: "text", text: `See scotty-evidence:${JOB_ID}` }],
      },
    );

    assert.deepStrictEqual(projectSessionSummary(current.messages, current.tools, SESSION_ID), {
      kind: "summary",
      conversationKey: "user-2",
      update: `See scotty-evidence:${JOB_ID}`,
      hatches: [],
      evidence: [{ kind: "unavailable", jobId: JOB_ID }],
    });
  });

  it("validates and deduplicates exact same-conversation Hatch references", () => {
    const tool = hatchTool();
    const messages = [
      { role: "user", id: "user-hatch", content: "Show the app" },
      {
        role: "assistant",
        id: "assistant-hatch-tool",
        content: [{ type: "toolCall", id: tool.id, name: tool.name, arguments: {} }],
      },
      { role: "toolResult", id: tool.id, toolCallId: tool.id, content: tool.result },
      {
        role: "assistant",
        id: "assistant-hatch-update",
        content: [
          {
            type: "text",
            text: `Ready: scotty-hatch:${HATCH_ID} and [open](scotty-hatch:${HATCH_ID})`,
          },
        ],
      },
    ];
    const projection = projectSessionSummary(messages, new Map([[tool.id, tool]]), SESSION_ID);
    assert.deepInclude(projection, {
      hatches: [
        {
          kind: "hatch",
          version: 1,
          hatchId: HATCH_ID,
          paths: {
            status: `/api/sessions/${SESSION_ID}/hatch`,
            open: `/s/${SESSION_ID}/hatch/open`,
            stop: `/api/sessions/${SESSION_ID}/hatch`,
            wake: `/api/sessions/${SESSION_ID}/resume`,
          },
        },
      ],
    });
  });

  it("retains and deduplicates references from meaningful updates through the final update", () => {
    const evidence = evidenceTool();
    const hatch = hatchTool();
    const messages = [
      { role: "user", id: "user-progress", content: "Build and verify it" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: hatch.id, name: hatch.name, arguments: {} },
          { type: "toolCall", id: evidence.id, name: evidence.name, arguments: {} },
        ],
      },
      { role: "toolResult", id: hatch.id, toolCallId: hatch.id, content: hatch.result },
      { role: "toolResult", id: evidence.id, toolCallId: evidence.id, content: evidence.result },
      {
        role: "assistant",
        content: `The app is ready: scotty-hatch:${HATCH_ID} scotty-evidence:${JOB_ID}`,
      },
      {
        role: "assistant",
        content: `Verified again: scotty-hatch:${HATCH_ID} scotty-evidence:${JOB_ID}`,
      },
      { role: "assistant", content: "Finished with all focused checks passing." },
    ];
    const projection = projectSessionSummary(
      messages,
      new Map<string, unknown>([
        [hatch.id, hatch],
        [evidence.id, evidence],
      ]),
      SESSION_ID,
    );

    if (projection.kind !== "summary") throw new Error("Expected a Summary projection");
    assert.strictEqual(projection.update, "Finished with all focused checks passing.");
    assert.lengthOf(projection.hatches, 1);
    assert.lengthOf(projection.evidence, 1);
    assert.deepInclude(projection.hatches[0], { kind: "hatch", hatchId: HATCH_ID });
    assert.deepInclude(projection.evidence[0], { kind: "evidence", jobId: JOB_ID });
  });

  it("fails Hatch references closed across conversations and malformed tool results", () => {
    const tool = hatchTool();
    const messages = [
      { role: "user", id: "user-old", content: "Start it" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: tool.id, name: tool.name, arguments: {} }],
      },
      { role: "toolResult", id: tool.id, toolCallId: tool.id, content: tool.result },
      { role: "user", id: "user-current", content: "Status?" },
      { role: "assistant", content: `See scotty-hatch:${HATCH_ID}` },
    ];
    assert.deepInclude(projectSessionSummary(messages, new Map([[tool.id, tool]]), SESSION_ID), {
      hatches: [{ kind: "unavailable", hatchId: HATCH_ID }],
    });

    const forged = {
      ...tool,
      result: {
        details: {
          ...tool.result.details,
          openUrl: "https://attacker.example/hatch",
        },
      },
    };
    assert.deepStrictEqual(browserHatchReference(forged, SESSION_ID), { kind: "unavailable" });
    assert.deepStrictEqual(
      browserHatchReference(
        {
          ...tool,
          result: {
            details: {
              ...tool.result.details,
              process: {
                ...tool.result.details.process,
                stdoutTail: "🪺".repeat(1_025),
              },
            },
          },
        },
        SESSION_ID,
      ),
      { kind: "unavailable" },
    );
  });

  it("parses only exact Hatch references outside code and untrusted URLs", () => {
    const source = [
      `scotty-hatch:${HATCH_ID}`,
      `[same](scotty-hatch:${HATCH_ID})`,
      "`scotty-hatch:code-only`",
      "```text\nscotty-hatch:fenced\n```",
      "scotty-hatch:../private",
      "scotty-hatch:hatch/extra",
      "scotty-hatch:hatch?nonce=secret",
      "https://example.com/scotty-hatch:remote",
    ].join("\n\n");
    assert.deepStrictEqual(assistantHatchReferences(source), [HATCH_ID]);
  });

  it("accepts current authenticated status only for the exact referenced Hatch", () => {
    const reference = browserHatchReference(hatchTool(), SESSION_ID);
    if (reference?.kind !== "hatch") throw new Error("Expected a validated Hatch reference");
    assert.deepStrictEqual(browserHatchStatus(hatchStatus(), reference), hatchStatus());
    assert.isUndefined(browserHatchStatus(hatchStatus({ hatchId: "hatch-other" }), reference));
    assert.isUndefined(browserHatchStatus({ ...hatchStatus(), routeNonce: "h_secret" }, reference));
    assert.isUndefined(
      browserHatchStatus(
        { ...hatchStatus(), service: { name: "Web", port: 4_173, url: "https://unsafe.test" } },
        reference,
      ),
    );
    assert.isUndefined(
      browserHatchStatus(hatchStatus({ service: { name: "Web", port: 3_000 } }), reference),
    );
    assert.isUndefined(browserHatchPaths(SESSION_ID, "../unsafe"));
  });

  it("permits Hatch controls only for compatible current states", () => {
    const reference = browserHatchReference(hatchTool(), SESSION_ID);
    if (reference?.kind !== "hatch") throw new Error("Expected a validated Hatch reference");
    const running = browserHatchStatus(hatchStatus(), reference);
    if (!running) throw new Error("Expected current Hatch status");
    assert.deepStrictEqual(hatchActions(running), {
      open: true,
      verify: true,
      wakeAndOpen: false,
      stop: true,
    });
    assert.deepStrictEqual(
      hatchActions({ ...running, observedStatus: "sleeping", exposure: "closed" }),
      { open: false, verify: true, wakeAndOpen: true, stop: false },
    );
    assert.deepStrictEqual(
      hatchActions({ ...running, observedStatus: "starting", exposure: "not_exposed" }),
      { open: false, verify: true, wakeAndOpen: false, stop: false },
    );
    assert.deepStrictEqual(
      hatchActions({ ...running, observedStatus: "failed", exposure: "closed" }),
      { open: false, verify: true, wakeAndOpen: true, stop: false },
    );
    assert.deepStrictEqual(
      hatchActions({
        ...running,
        desiredStatus: "closed",
        observedStatus: "stopped",
        exposure: "closed",
      }),
      { open: false, verify: true, wakeAndOpen: false, stop: false },
    );
  });

  it("parses only exact evidence references outside code and deduplicates them", () => {
    const markdown = [
      `scotty-evidence:${JOB_ID}`,
      `[same](scotty-evidence:${JOB_ID})`,
      `\`scotty-evidence:code-only\``,
      "```text\nscotty-evidence:fenced\n```",
      "scotty-evidence:../private",
      "scotty-evidence:job/extra",
      "scotty-evidence:job?nonce=secret",
      "https://example.com/scotty-evidence:remote",
    ].join("\n\n");

    assert.deepStrictEqual(assistantEvidenceReferences(markdown), [JOB_ID]);
  });

  it("does not treat a custom scheme as a generally safe URL", () => {
    assert.deepStrictEqual(
      assistantEvidenceReferences(
        `[unsafe](scotty-evidence:${JOB_ID}/frames/private.png) [safe](scotty-evidence:${JOB_ID})`,
      ),
      [JOB_ID],
    );
  });

  it("uses the last assistant text message and provides a stable empty state", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "Older update" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "not an update" }] },
      { role: "assistant", content: [{ type: "text", text: "Latest update" }] },
    ];
    assert.deepInclude(projectSessionSummary(messages, new Map(), SESSION_ID), {
      kind: "summary",
      update: "Latest update",
    });
    assert.deepStrictEqual(projectSessionSummary([], new Map(), SESSION_ID), {
      kind: "empty",
      hatches: [],
      evidence: [],
    });
  });

  it("rejects malformed structured evidence even when the identifier matches", () => {
    const current = conversationWithEvidence(`See scotty-evidence:${JOB_ID}`);
    current.tools.set("tool-1", {
      ...evidenceTool(),
      result: {
        details: {
          ...evidenceTool().result.details,
          summaryUrl: `https://example.com/evidence/${JOB_ID}`,
        },
      },
    });

    assert.deepInclude(projectSessionSummary(current.messages, current.tools, SESSION_ID), {
      evidence: [{ kind: "unavailable", jobId: JOB_ID }],
    });
  });

  it("ships Summary as a distinct responsive surface without replacing Activity", () => {
    assert.include(terminalHtml, 'id="summary-sidebar"');
    assert.include(terminalHtml, 'aria-label="Summary"');
    assert.include(terminalHtml, 'id="activity-drawer"');
    assert.include(terminalHtml, "Tasks, subagents, and workflows");
    assert.include(terminalSource, 'window.matchMedia("(max-width: 1100px)")');
    assert.include(terminalSource, 'document.body.classList.toggle("summary-collapsed"');
    assert.include(terminalSource, 'summarySidebar.classList.toggle("open"');
  });

  it("loads only locally constructed authenticated evidence routes and coordinates focus", () => {
    assert.include(terminalSource, 'from "/terminal-summary-projection.js"');
    assert.include(terminalSource, 'credentials: "same-origin"');
    assert.include(terminalSource, "evidence.paths.summary");
    assert.include(terminalSource, "evidence.paths.frame(frame.frameId)");
    assert.include(terminalSource, "evidence.paths.detail");
    assert.include(terminalSource, "reference.paths.status");
    assert.include(terminalSource, "reference.paths.open");
    assert.include(terminalSource, "reference.paths.wake");
    assert.include(terminalSource, "reference.paths.stop");
    assert.include(terminalSource, 'credentials: "same-origin"');
    assert.include(terminalSource, 'method: action === "wake" ? "POST" : "DELETE"');
    assert.include(terminalSource, '"Open Hatch", "open"');
    assert.include(terminalSource, '"Wake and Open", "wake"');
    assert.include(terminalSource, '"Verify", "verify"');
    assert.include(terminalSource, '"Stop", "stop"');
    assert.include(terminalSource, 'compactSurface === "summary"');
    assert.include(terminalSource, "trapFocus(event, summarySidebar)");
    assert.include(terminalSource, "appShell.inert = open");
    assert.include(terminalSource, "focusedKey");
    assert.include(terminalSource, "card.dataset.pendingFocusKey = focusedKey");
    assert.include(terminalSource, "restoreSummaryHatchFocus(card, focusedKey)");
    assert.include(terminalSource, "replacement?.focus({ preventScroll: true })");
    assert.include(terminalSource, "browserHatchStatus");
    assert.notInclude(terminalSource, "summary-hatch-meta");
    assert.notInclude(terminalSource, "status.service.port");
    assert.notInclude(terminalSource, "routeNonce");
    assert.notInclude(terminalSource, "cookieSecret");
  });
});
