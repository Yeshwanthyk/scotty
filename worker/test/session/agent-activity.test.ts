import { assert, describe, it } from "@effect/vitest";
import { drainDecision, HARD_CAP_SLEEP_RESERVE_MS } from "../../src/session/agent-activity";

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
    const deadline = 8 * 60_000;
    assert.strictEqual(drainDecision(4 * 60_000 - 1, 0, deadline, true), "wait");
    assert.strictEqual(drainDecision(4 * 60_000, 0, deadline, true), "sleep");
  });

  it("reserves backup time before the deadline on short caps", () => {
    // 5-minute cap: drainAt = deadline - 150s; a busy turn previously waited until deadline - 75s.
    const deadline = 5 * 60_000;
    const drainAt = deadline - 150_000;
    assert.strictEqual(drainDecision(drainAt, drainAt, deadline, true), "sleep");
    // 10-minute cap: drain window is 5m, so the reserve (not half the window) sets forceAt.
    const longer = 10 * 60_000;
    const forceAt = longer - HARD_CAP_SLEEP_RESERVE_MS;
    assert.strictEqual(drainDecision(forceAt - 1, 5 * 60_000, longer, true), "wait");
    assert.strictEqual(drainDecision(forceAt, 5 * 60_000, longer, true), "sleep");
  });
});
