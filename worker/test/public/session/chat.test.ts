import { assert, describe, it } from "vitest";
import {
  applyEvent,
  conversationPresentation,
  conversationTurns,
  currentWorkPresentation,
  isNearBottom,
  projectionFromSnapshot,
  safeMarkdownTree,
  sanitizeText,
  toolOutputText,
} from "../../../public/session/chat.js";
import chatSource from "../../../public/session/chat.js?raw";

const message = { id: "user-1", role: "user", content: [{ type: "text", text: "Ship it" }] };
type SnapshotOverrides = {
  readonly state?: { readonly isStreaming: boolean };
  readonly messages?: ReadonlyArray<unknown>;
  readonly sequence?: number;
  readonly overlapEvents?: ReadonlyArray<unknown>;
  readonly activeTools?: ReadonlyArray<unknown>;
  readonly pendingUi?: ReadonlyArray<unknown>;
};
const snapshot = (overrides: SnapshotOverrides = {}) => ({
  epoch: "epoch-1",
  sessionRevision: 7,
  baseSequence: 0,
  sequence: 0,
  state: { isStreaming: false },
  messages: [],
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
  pendingUiAuthority: { status: "partial", reason: "pi_0_83_signal_cancellation_unobservable" },
  extensionSurface: { statuses: {}, widgets: [] },
  capabilities: { models: [], thinkingLevels: [], commands: [] },
  truncated: { messages: false, values: false },
  ...overrides,
});

describe("canonical chat projection", () => {
  it("reconciles exact snapshot overlap without duplicating messages", () => {
    const projection = projectionFromSnapshot(
      snapshot({
        messages: [message],
        sequence: 1,
        overlapEvents: [{ epoch: "epoch-1", sequence: 1, event: { type: "message_end", message } }],
      }),
    );
    assert.deepStrictEqual(projection.messages, [message]);
    assert.strictEqual(projection.sequence, 1);
  });

  it("finalizes one anonymous Pi message without rendering start and end twice", () => {
    const projection = projectionFromSnapshot(snapshot());
    const start = { role: "user", content: [{ type: "text", text: "Ship it" }] };
    const end = { ...start, timestamp: 1_788_044_446_835 };
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 1,
      event: { type: "message_start", message: start },
    });
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 2,
      event: { type: "message_end", message: end },
    });

    assert.deepStrictEqual(projection.messages, [end]);
  });

  it("suppresses duplicates and requires a fresh snapshot for gaps or epoch changes", () => {
    const projection = projectionFromSnapshot(snapshot());
    assert.strictEqual(
      applyEvent(projection, { epoch: "epoch-1", sequence: 1, event: { type: "agent_start" } }),
      "applied",
    );
    assert.isTrue(projection.active);
    assert.strictEqual(
      applyEvent(projection, { epoch: "epoch-1", sequence: 1, event: { type: "agent_start" } }),
      "duplicate",
    );
    assert.strictEqual(
      applyEvent(projection, { epoch: "epoch-1", sequence: 3, event: { type: "agent_settled" } }),
      "refresh",
    );
    assert.strictEqual(
      applyEvent(projection, { epoch: "epoch-2", sequence: 2, event: { type: "agent_settled" } }),
      "refresh",
    );
  });

  it("settles live work only from terminal authority, never a non-terminal state update", () => {
    const projection = projectionFromSnapshot(snapshot({ state: { isStreaming: true } }));
    assert.isTrue(projection.active);

    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 1,
      event: { type: "state_update", state: { isStreaming: false } },
    });
    assert.isTrue(projection.active);

    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 2,
      event: { type: "agent_settled" },
    });
    assert.isFalse(projection.active);

    assert.isFalse(projectionFromSnapshot(snapshot({ state: { isStreaming: false } })).active);
  });

  it("applies streaming assistant deltas and tool lifecycle updates", () => {
    const projection = projectionFromSnapshot(snapshot());
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 1,
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      },
    });
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 2,
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
      },
    });
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 3,
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
      },
    });
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 4,
      event: {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
      },
    });
    applyEvent(projection, {
      epoch: "epoch-1",
      sequence: 5,
      event: { type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "done" },
    });

    assert.deepInclude(projection.messages[0], {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    });
    assert.strictEqual(projection.tools.size, 1);
    assert.deepInclude(projection.tools.get("tool-1"), {
      name: "read",
      result: "done",
      status: "done",
    });
  });

  it("coalesces repeated tool updates by tool-call ID", () => {
    const projection = projectionFromSnapshot(snapshot({ state: { isStreaming: true } }));
    for (const [sequence, event] of [
      [1, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" }],
      [2, { type: "tool_execution_update", toolCallId: "tool-1", partialResult: "half" }],
      [3, { type: "tool_execution_end", toolCallId: "tool-1", result: "complete" }],
    ])
      applyEvent(projection, { epoch: "epoch-1", sequence, event });

    assert.strictEqual(projection.tools.size, 1);
    assert.deepInclude(projection.tools.get("tool-1"), {
      id: "tool-1",
      name: "bash",
      result: "complete",
      status: "done",
    });
  });

  it("groups user, assistant, tool, and Pi question state into one projection", () => {
    const projection = projectionFromSnapshot(
      snapshot({
        state: { isStreaming: true },
        messages: [
          message,
          {
            id: "assistant-1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Checking" },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
              { type: "text", text: "Done" },
            ],
          },
          { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: "file" },
        ],
        pendingUi: [
          { id: "question-1", method: "confirm", title: "Continue?", message: "Continue?" },
        ],
      }),
    );
    const turns = conversationTurns(projection);
    assert.strictEqual(turns.length, 1);
    assert.deepInclude(turns[0], { key: "user-1", user: message });
    assert.strictEqual(turns[0].assistants.length, 1);
    assert.strictEqual(turns[0].tools.length, 1);
    assert.strictEqual(projection.pendingUi.get("question-1")?.method, "confirm");
  });
  it("keeps three newest turns visible and bounds one earlier-turn preview", () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      key: `turn-${index}`,
      user: {
        role: "user",
        content: [{ type: "text", text: `Turn ${index} ${"detail ".repeat(40)}` }],
      },
      assistants: [],
      tools: [],
    }));
    const presentation = conversationPresentation(turns);

    assert.deepStrictEqual(
      presentation.visible.map((turn) => turn.key),
      ["turn-3", "turn-4", "turn-5"],
    );
    assert.strictEqual(presentation.earlier.length, 3);
    assert.isAtMost(presentation.preview.length, 220);
  });

  it("bounds current work for desktop and mobile and names every work state", () => {
    const tools = [
      { id: "one", name: "read", status: "done", result: "read", arguments: "" },
      { id: "two", name: "edit", status: "done", result: "edited", arguments: "" },
      { id: "three", name: "bash", status: "error", result: "failed", arguments: "" },
      { id: "four", name: "browser", status: "running", result: "", arguments: "testing" },
    ];
    const turn = {
      key: "turn",
      assistants: [
        { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(2_000) }] },
      ],
      tools,
    };
    const running = currentWorkPresentation(turn, { active: true, pendingUi: new Map() });
    const waiting = currentWorkPresentation(turn, {
      active: true,
      pendingUi: new Map([["question", {}]]),
    });
    const failed = currentWorkPresentation(turn, { active: false, pendingUi: new Map() });
    const done = currentWorkPresentation(
      { ...turn, tools: tools.filter((tool) => tool.status === "done") },
      { active: false, pendingUi: new Map() },
    );

    assert.strictEqual(running.state, "running");
    assert.strictEqual(waiting.state, "waiting");
    assert.strictEqual(failed.state, "failed");
    assert.strictEqual(done.state, "done");
    assert.strictEqual(running.tools.length, 3);
    assert.strictEqual(
      currentWorkPresentation(turn, { active: true, pendingUi: new Map() }, 2).tools.length,
      2,
    );
    assert.isAtMost(running.thinking.length, 600);
    assert.isAtMost(toolOutputText({ status: "done", result: "y".repeat(5_000) }).length, 1_200);
  });

  it("pins only readers already near the transcript tail", () => {
    assert.isTrue(isNearBottom({ scrollHeight: 1_000, scrollTop: 420, clientHeight: 500 }));
    assert.isFalse(isNearBottom({ scrollHeight: 1_000, scrollTop: 200, clientHeight: 500 }));
  });
});

describe("safe chat rendering", () => {
  it("allows safe links, isolates cross-origin links, and renders HTML and images inertly", () => {
    const tree = safeMarkdownTree(
      "[same](/sessions) [away](https://example.com) [bad](javascript:alert(1)) <b>raw</b> ![x](https://example.com/x.png)",
      "https://scotty.example/s/current",
    );
    const serialized = JSON.stringify(tree);
    assert.include(serialized, '"href":"/sessions"');
    assert.include(serialized, '"rel":"noopener noreferrer"');
    assert.notInclude(serialized, '"href":"javascript:alert(1)"');
    assert.include(serialized, "markdown-raw");
    assert.notInclude(chatSource, "innerHTML");
    assert.notInclude(chatSource, "insertAdjacentHTML");
  });

  it("removes terminal controls and credential-like browser text", () => {
    assert.strictEqual(
      sanitizeText("\u001b]0;owned\u0007safe ghp_secret scotty-managed://github/token\u007f"),
      "safe [credential] [managed-handle]",
    );
  });

  it("preserves focused controls and selection across keyed streaming renders", () => {
    assert.include(chatSource, "document.activeElement?.dataset?.focusKey");
    assert.include(chatSource, "target.focus({ preventScroll: true })");
    assert.include(chatSource, "target.setSelectionRange(selection.start, selection.end)");
    assert.include(chatSource, "previous?.dataset.signature === candidate.dataset.signature");
    assert.include(chatSource, 'querySelectorAll("[data-tool-id]")');
    assert.include(chatSource, "scroller.scrollTop = previousScrollTop");
    assert.include(chatSource, "newActivity.hidden = false");
    assert.include(chatSource, "captureScrollAnchor(feed, scroller)");
    assert.include(chatSource, "restoreScrollAnchor(feed, scroller, scrollAnchor)");
    assert.include(chatSource, "flushToolRun()");
    assert.include(chatSource, 'run.className = "tool-run"');
    assert.include(chatSource, 'assistant.className = "assistant-message"');
    assert.notInclude(chatSource, 'title.textContent = "Worked"');
    assert.include(chatSource, "const HISTORY_BATCH_COUNT = 10");
    assert.include(chatSource, "visibleHistoryCount > 0");
    assert.include(chatSource, "presentation.earlier.slice(-visibleHistoryCount)");
    assert.include(chatSource, "visibleHistoryCount += HISTORY_BATCH_COUNT");
    assert.include(chatSource, "const latestTool = tools.at(-1)");
    assert.include(chatSource, 'activity.dataset.activityState = working ? "running" : "settled"');
    assert.include(chatSource, 'document.createElement("details")');
    assert.include(chatSource, "activity.open = working");
    assert.include(chatSource, 'thoughts.join(" · ")');
    assert.notInclude(chatSource, "appendUnrenderedTools();\n        flushToolRun();");
    assert.include(chatSource, "for (const tool of tools)");
    assert.include(chatSource, 'invocation.textContent = sanitizeText(tool.name ?? "tool", 120)');
    assert.notInclude(chatSource, 'row.open = tool.status === "running"');
  });
});
