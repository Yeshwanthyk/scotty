import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_FRAMES, ACTIVITY_INTERVAL_MS, ActivityController } from "./activity.ts";

function timerToken(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {}, 60_000);
  clearInterval(timer);
  return timer;
}

test("animates Amp's five-frame status sequence every 200ms", () => {
  let tick: (() => void) | undefined;
  let interval = 0;
  let renders = 0;
  const controller = new ActivityController(
    () => renders++,
    (callback, intervalMs) => {
      tick = callback;
      interval = intervalMs;
      return timerToken();
    },
    () => {},
  );

  controller.startAgent();
  assert.equal(interval, ACTIVITY_INTERVAL_MS);
  assert.equal(controller.glyph, ACTIVITY_FRAMES[0]);
  tick?.();
  assert.equal(controller.glyph, ACTIVITY_FRAMES[1]);
  tick?.();
  assert.equal(controller.glyph, ACTIVITY_FRAMES[2]);
  assert.equal(renders, 3);
  controller.dispose();
});

test("distinguishes stream phases and only shows provider-reported tokens", () => {
  const controller = new ActivityController(() => {});
  controller.startAgent();
  controller.updateMessage("thinking_delta", 0);
  assert.equal(controller.state, "thinking");
  assert.equal(controller.tokens, 0);
  controller.updateMessage("text_delta", 0);
  assert.equal(controller.state, "streaming");
  assert.equal(controller.tokens, 0);
  controller.updateMessage("text_delta", 37);
  assert.equal(controller.tokens, 37);
  controller.completeMessage(41);
  assert.equal(controller.tokens, 41);
  controller.dispose();
});

test("keeps Running Tools until every concurrent tool finishes", () => {
  const controller = new ActivityController(() => {});
  controller.startTool("one", "read");
  assert.equal(controller.activeToolLabel, "read");
  controller.startTool("two", "bash");
  assert.equal(controller.activeToolLabel, "2 tools");
  controller.updateMessage("text_delta", 5);
  assert.equal(controller.state, "tool");
  controller.endTool("one");
  assert.equal(controller.state, "tool");
  controller.endTool("two");
  assert.equal(controller.state, "thinking");
  controller.dispose();
});

test("exposes an explicit label for every activity state", () => {
  const controller = new ActivityController(() => {});
  assert.equal(controller.label, "Idle");
  controller.startAgent();
  assert.equal(controller.label, "Thinking");
  controller.updateMessage("text_delta", 5);
  assert.equal(controller.label, "Streaming");
  controller.startTool("one", "read");
  assert.equal(controller.label, "Running read");
  controller.transition("compacting");
  assert.equal(controller.label, "Auto-Compacting");
  controller.transition("queued");
  assert.equal(controller.label, "Queued Follow-Up");
  controller.dispose();
});

test("stops animation when idle", () => {
  let cancelled = false;
  const controller = new ActivityController(
    () => {},
    () => timerToken(),
    () => {
      cancelled = true;
    },
  );
  controller.startAgent();
  controller.transition("idle");
  assert.equal(cancelled, true);
});
