import { assert, describe, it } from "vitest";
import {
  assistantEvidenceReferences,
  projectSessionSummary,
} from "../public/terminal-summary-projection.js";
import terminalHtml from "../public/terminal.html?raw";
import terminalSource from "../public/terminal.js?raw";

const SESSION_ID = "a0b1c2d3e4f5";
const JOB_ID = "job-abcd1234";

const evidenceTool = (jobId = JOB_ID) => ({
  id: "tool-1",
  name: "scotty_browser_test",
  status: "done",
  result: {
    details: {
      version: 1,
      jobId,
      status: "succeeded",
      summaryUrl: `/s/${SESSION_ID}/evidence/${jobId}`,
      completedSteps: 1,
      frameCount: 1,
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
      evidence: [{ kind: "unavailable", jobId: JOB_ID }],
    });
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
    assert.include(terminalSource, "evidence.paths.replay");
    assert.include(terminalSource, 'compactSurface === "summary"');
    assert.include(terminalSource, "trapFocus(event, summarySidebar)");
    assert.include(terminalSource, "appShell.inert = open");
    assert.notInclude(terminalSource, "scotty-hatch");
  });
});
