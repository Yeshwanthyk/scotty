import assert from "node:assert/strict";
import test from "node:test";

import {
  appendAssistantMessageDelta,
  conversationItems,
} from "../worker/public/terminal-timeline.js";

test("assembles Pi 0.84 assistant deltas without duplicating block ends or split credentials", () => {
  const messages = [{ role: "assistant", content: [] }];
  const update = (assistantMessageEvent) =>
    appendAssistantMessageDelta(messages, { type: "message_update", assistantMessageEvent });

  update({ type: "text_start", contentIndex: 0 });
  update({ type: "text_delta", contentIndex: 0, delta: "ghp_" });
  update({ type: "text_delta", contentIndex: 0, delta: "secretvalue" });
  assert.equal(messages[0].content[0].text, "[credential]");
  update({ type: "text_end", contentIndex: 0, content: "complete" });
  update({ type: "thinking_start", contentIndex: 1 });
  update({ type: "thinking_delta", contentIndex: 1, delta: "check" });
  update({ type: "thinking_end", contentIndex: 1, content: "checked" });
  update({ type: "toolcall_start", contentIndex: 2 });
  update({ type: "toolcall_delta", contentIndex: 2, delta: '{"path":"README.md"}' });
  update({
    type: "toolcall_end",
    contentIndex: 2,
    toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
  });

  assert.deepEqual(messages[0].content, [
    { type: "text", text: "complete" },
    { type: "thinking", thinking: "checked" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
  ]);
});

test("tool results remain owned by their original conversation across custom messages", () => {
  const { items, claimedToolIds } = conversationItems([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a.ts" } }],
    },
    { role: "custom", content: "extension status" },
    {
      role: "toolResult",
      toolCallId: "tool-a",
      toolName: "read",
      content: "file contents",
    },
  ]);

  const conversations = items.filter((item) => item.kind === "conversation");
  assert.equal(conversations.length, 1);
  assert.deepEqual(conversations[0].toolIds, ["tool-a"]);
  assert.deepEqual([...claimedToolIds], ["tool-a"]);
});

test("unlinked tool results still render in the current conversation", () => {
  const { items } = conversationItems([
    { role: "user", content: "Inspect it" },
    { role: "toolResult", toolCallId: "tool-b", toolName: "read", content: "result" },
  ]);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0].toolIds, ["tool-b"]);
});
