import assert from "node:assert/strict";
import test from "node:test";

import { conversationItems } from "../worker/public/terminal-timeline.js";

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
