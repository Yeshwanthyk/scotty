import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPreviewSession } from "./ui-preview-state.mjs";

const envelope = (intent, commandId) => ({
  epoch: "preview-epoch",
  commandId,
  expectedSessionRevision: 7,
  intent,
});

const scheduler = () => {
  const tasks = [];
  return {
    schedule(task, delay) {
      const timer = { task, delay, cancelled: false };
      tasks.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
    runAll() {
      while (tasks.some((task) => !task.cancelled)) {
        tasks.sort((left, right) => left.delay - right.delay);
        const next = tasks.shift();
        if (!next.cancelled) next.task();
      }
    },
  };
};

describe("local UI preview session", () => {
  it("streams ordered deltas, reconciles queued work, and completes without duplication", async () => {
    const clock = scheduler();
    const session = createPreviewSession(clock);

    const prompt = await session.command(
      envelope({ type: "prompt", message: "Prove the stream" }, "command-prompt"),
    );
    assert.equal(prompt.statusCode, 202);
    await session.command(
      envelope({ type: "follow_up", message: "Then verify mobile" }, "command-follow-up"),
    );
    await session.command(envelope({ type: "steer", message: "Keep it concise" }, "command-steer"));
    clock.runAll();

    const events = session.events();
    assert.deepEqual(
      events.slice(0, 3).map(({ event }) => event.type),
      ["message_start", "agent_start", "message_start"],
    );
    assert.equal(events.filter(({ event }) => event.type === "message_update").length, 12);
    assert.equal(events.filter(({ event }) => event.type === "tool_execution_start").length, 6);
    assert.equal(events.filter(({ event }) => event.type === "tool_execution_update").length, 2);
    assert.equal(events.filter(({ event }) => event.type === "tool_execution_end").length, 6);
    assert.equal(events.filter(({ event }) => event.type === "message_end").length, 8);
    assert.equal(events.filter(({ event }) => event.type === "agent_end").length, 2);
    assert.deepEqual(
      events.map(({ sequence }) => sequence),
      events.map((_event, index) => index + 1),
    );
    assert.deepEqual(session.snapshot().queue, { steer: [], followUp: [] });
    assert.equal(session.snapshot().state.isStreaming, false);
    const completedAssistants = session
      .snapshot()
      .messages.filter(({ role }) => role === "assistant");
    assert.equal(completedAssistants.length, 19);
    for (const assistant of completedAssistants.slice(-2)) {
      assert.match(assistant.content[0].thinking, /inspect the current hierarchy/u);
      assert.match(assistant.content[2].text, /ordered SSE deltas/u);
    }
    assert.deepEqual(
      completedAssistants.slice(-2).map(({ model }) => model),
      ["gpt-5.6-luna", "gpt-5.6-sol"],
    );
    assert.equal(
      session.snapshot().messages.filter(({ role }) => role === "toolResult").length,
      22,
    );
  });

  it("aborts timers and clears queued work", async () => {
    const clock = scheduler();
    const session = createPreviewSession(clock);
    await session.command(envelope({ type: "prompt", message: "Long work" }, "command-prompt"));
    await session.command(
      envelope({ type: "follow_up", message: "Queued work" }, "command-follow-up"),
    );
    await session.command(envelope({ type: "abort" }, "command-abort"));
    clock.runAll();

    assert.equal(session.events().at(-1).event.type, "agent_abort");
    assert.deepEqual(session.snapshot().queue, { steer: [], followUp: [] });
    assert.equal(session.snapshot().state.isStreaming, false);
  });
});
