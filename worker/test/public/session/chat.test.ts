import { assert, describe, it } from "vitest";
import {
  applyEvent,
  conversationTurns,
  projectionFromSnapshot,
  safeMarkdownTree,
  sanitizeText,
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
    assert.deepInclude(projection.tools.get("tool-1"), {
      name: "read",
      result: "done",
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
  });
});
