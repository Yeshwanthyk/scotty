import assert from "node:assert/strict";
import test from "node:test";

import {
  createMessageProjectionState,
  finishMessageSnapshot,
  projectMessageEvent,
} from "../worker/public/terminal-message-projection.js";

const steerMessage = () => ({
  role: "user",
  content: [{ type: "text", text: "Focus on the regression test" }],
  timestamp: 1_722_000_000_001,
});

const applySteerLifecycle = (messages, state) => {
  projectMessageEvent(messages, state, "message_start", steerMessage());
  projectMessageEvent(messages, state, "message_end", steerMessage());
};

test("one live Pi steer lifecycle projects exactly one user message", () => {
  const messages = [];
  const state = createMessageProjectionState();

  applySteerLifecycle(messages, state);

  assert.deepEqual(messages, [steerMessage()]);
});

test("identical Steer actions remain separate messages", () => {
  const messages = [];
  const state = createMessageProjectionState();

  applySteerLifecycle(messages, state);
  applySteerLifecycle(messages, state);

  assert.deepEqual(messages, [steerMessage(), steerMessage()]);
});

test("snapshot overlap does not replay a persisted Steer message", () => {
  const messages = [steerMessage()];
  const state = createMessageProjectionState(messages, true);

  applySteerLifecycle(messages, state);
  finishMessageSnapshot(state);

  assert.deepEqual(messages, [steerMessage()]);
});
