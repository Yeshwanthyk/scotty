import { assert, describe, it } from "@effect/vitest";
import type { PiConsoleSnapshot } from "../../../protocol/pi-console";
import { canonicalConversationSnapshotFromPi } from "../../src/session/conversation";

const baseSnapshot = {
  epoch: "epoch-1",
  baseSequence: 0,
  sequence: 0,
  sessionRevision: 7,
  state: { isStreaming: false, internal: "must-not-leak" },
  messages: [],
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
  pendingUiAuthority: {
    status: "partial" as const,
    reason: "pi_0_83_signal_cancellation_unobservable" as const,
  },
  extensionSurface: { statuses: {}, widgets: [], title: "must-not-leak" },
  capabilities: {
    models: [],
    thinkingLevels: [],
    commands: [],
  },
  truncated: { messages: false, values: false },
} satisfies PiConsoleSnapshot;

const snapshot = (overrides: Partial<PiConsoleSnapshot> = {}): PiConsoleSnapshot => ({
  ...baseSnapshot,
  ...overrides,
});

describe("canonical conversation snapshot mapper", () => {
  it("folds Pi messages and tools into a bounded UI-owned turn", () => {
    const result = canonicalConversationSnapshotFromPi(
      snapshot({
        messages: [
          {
            id: "user-1",
            role: "user",
            content: [{ type: "text", text: "Ship it ghp_secret" }],
            timestamp: 1_700_000_000_000,
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning must not be copied" },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
              { type: "text", text: "The result is ready." },
            ],
            timestamp: 1_700_000_012_000,
          },
          {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: { value: "safe output", token: "ghp_secret" },
            timestamp: 1_700_000_014_000,
          },
        ],
      }),
    );

    assert.ok(result);
    assert.deepStrictEqual(result.transport, {
      epoch: "epoch-1",
      baseSequence: 0,
      sequence: 0,
      sessionRevision: 7,
    });
    assert.deepStrictEqual(result.turns, [
      {
        id: "user-1",
        state: "completed",
        user: "Ship it [credential]",
        assistant: "The result is ready.",
        activitySummary: "1 action",
        tools: [
          {
            id: "tool-1",
            state: "completed",
            label: "Reading project",
            invocation: 'read({"path":"README.md"})',
            output: '{"value":"safe output","token":"[credential]"}',
          },
        ],
        elapsedSeconds: 14,
      },
    ]);
    assert.deepStrictEqual(result.truncated, { turns: false, values: false });
    const encoded = JSON.stringify(result);
    assert.notInclude(encoded, "private reasoning");
    assert.notInclude(encoded, "internal");
    assert.notInclude(encoded, "pendingUi");
    assert.notInclude(encoded, "extensionSurface");
  });

  it("applies contiguous streaming overlap and keeps active tools running", () => {
    const result = canonicalConversationSnapshotFromPi(
      snapshot({
        sequence: 2,
        state: { isStreaming: true },
        messages: [
          { id: "user-1", role: "user", content: "Continue" },
          { id: "assistant-1", role: "assistant", content: [] },
        ],
        activeTools: [{ id: "tool-1", name: "bash", status: "running", arguments: "pwd" }],
        overlapEvents: [
          {
            epoch: "epoch-1",
            sequence: 1,
            event: {
              type: "message_update",
              assistantMessageEvent: { type: "text_start", contentIndex: 0 },
            },
          },
          {
            epoch: "epoch-1",
            sequence: 2,
            event: {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" },
            },
          },
        ],
      }),
    );

    assert.ok(result);
    assert.strictEqual(result.turns[0]?.state, "streaming");
    assert.strictEqual(result.turns[0]?.assistant, "Working");
    assert.deepStrictEqual(result.turns[0]?.tools, [
      {
        id: "tool-1",
        state: "running",
        label: "Running command",
        invocation: 'bash("pwd")',
      },
    ]);
  });

  it("marks aborted work as cancelled and refuses a sequence gap", () => {
    const aborted = canonicalConversationSnapshotFromPi(
      snapshot({
        sequence: 1,
        state: { isStreaming: true },
        messages: [{ id: "user-1", role: "user", content: "Stop" }],
        activeTools: [{ id: "tool-1", name: "bash", status: "running" }],
        overlapEvents: [{ epoch: "epoch-1", sequence: 1, event: { type: "turn_aborted" } }],
      }),
    );
    assert.ok(aborted);
    assert.strictEqual(aborted.turns[0]?.state, "completed");
    assert.strictEqual(aborted.turns[0]?.tools[0]?.state, "cancelled");

    assert.isUndefined(
      canonicalConversationSnapshotFromPi(
        snapshot({
          sequence: 2,
          overlapEvents: [{ epoch: "epoch-1", sequence: 2, event: { type: "agent_end" } }],
        }),
      ),
    );
  });

  it("bounds retained turns and marks source or local truncation", () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `user-${index}`,
      role: "user" as const,
      content: `Turn ${index}`,
    }));
    const result = canonicalConversationSnapshotFromPi(snapshot({ messages }));
    assert.ok(result);
    assert.strictEqual(result.turns.length, 100);
    assert.strictEqual(result.turns[0]?.id, "user-1");
    assert.deepStrictEqual(result.truncated, { turns: true, values: false });
  });
});
