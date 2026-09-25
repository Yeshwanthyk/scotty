import { assert, describe, it } from "@effect/vitest";
import { drainDecision } from "../../src/session/agent-activity";

describe("hard-cap drain decision", () => {
  const drainAt = 0;
  const deadline = 10 * 60_000;

  it("waits for an active turn before forceAt", () => {
    assert.strictEqual(drainDecision(drainAt, drainAt, deadline, true), "wait");
    assert.strictEqual(drainDecision(5 * 60_000 - 1, drainAt, deadline, true), "wait");
  });

  it("sleeps at and after forceAt", () => {
    assert.strictEqual(drainDecision(5 * 60_000, drainAt, deadline, true), "sleep");
    assert.strictEqual(drainDecision(deadline - 1, drainAt, deadline, true), "sleep");
  });

  it("sleeps for idle and unknown observations", () => {
    assert.strictEqual(drainDecision(drainAt, drainAt, deadline, false), "sleep");
    assert.strictEqual(drainDecision(drainAt, drainAt, deadline, "unknown"), "sleep");
  });

  it("uses half the drain window when it is shorter than ten minutes", () => {
    assert.strictEqual(drainDecision(19_999, 0, 40_000, true), "wait");
    assert.strictEqual(drainDecision(20_000, 0, 40_000, true), "sleep");
  });
});
