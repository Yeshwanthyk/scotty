import { describe, expect, it } from "@effect/vitest";
import { decodeSessionEvent } from "./events.js";
import { command } from "./commands.js";
import { deadline, deadlines, fold, initial } from "./fold.js";
import { boot, check, created, delivered, hello, make, ready, start } from "./fold-fixtures.js";

describe("session fold", () => {
  it("provisions from an intent, sends initial prompt after workspace and waits for delivery", () => {
    let state = fold(initial, created);
    state = fold(state, start);
    expect(command(state, start)).toEqual({ kind: "container.start", gen: 1 });
    expect(deadline(state)).toBe(start.at + deadlines.container);
    state = fold(state, hello);
    expect(command(state, hello)).toEqual({
      kind: "start",
      gen: 1,
      repo: "https://example.org/repo",
      base: "main",
      branch: "scotty/session-1",
      agentKind: "codex",
    });
    state = fold(state, ready);
    expect(command(state, ready)).toEqual({
      kind: "prompt",
      req: "initial:1",
      turn: "0",
      text: "hello",
    });
    expect(state.requests[0]?.status).toBe("pending");
    state = fold(state, delivered);
    expect(state.phase).toBe("running");
    expect(deadline(state)).toBeUndefined();
    check(state);
  });

  it("deduplicates start and request ids; rejects reserved initial names and stale turns", () => {
    let state = fold(fold(initial, created), start);
    const repeated = make(3, "container.start", { gen: 1 });
    state = fold(state, repeated);
    expect(command(state, repeated)).toBeUndefined();
    expect(state.startSeq).toBe(2);
    expect(() =>
      make(4, "prompt.requested", { req: "initial:1", turn: "0", text: "bad", images: [] }),
    ).toThrow();
    state = boot();
    const prompt = make(6, "prompt.requested", { req: "p", turn: "0", text: "steer", images: [] });
    state = fold(state, prompt);
    expect(command(state, prompt)).toEqual({ kind: "prompt", req: "p", turn: "0", text: "steer" });
    const duplicate = make(7, "prompt.requested", {
      req: "p",
      turn: "0",
      text: "other",
      images: [],
    });
    state = fold(state, duplicate);
    expect(command(state, duplicate)).toBeUndefined();
    expect(state.requests).toHaveLength(2);
    state = fold(state, make(8, "turn.ended", { gen: 1, turn: "0", state: "completed" }));
    const stale = make(9, "prompt.requested", { req: "late", turn: "0", text: "late", images: [] });
    state = fold(state, stale);
    expect(state.requests.find((item) => item.req === "late")?.status).toBe("stale");
    expect(command(state, stale)).toBeUndefined();
    check(state);
  });

  it("delivered settles prompts and interrupts; early timeouts do nothing", () => {
    let state = boot();
    const prompt = make(6, "prompt.requested", { req: "p", turn: "0", text: "text", images: [] });
    state = fold(state, prompt);
    state = fold(state, make(7, "timeout", { op: "req:p" }));
    expect(state.requests.find((item) => item.req === "p")?.status).toBe("pending");
    state = fold(state, make(8, "prompt.delivered", { req: "p" }));
    const interrupt = make(9, "interrupt.requested", { req: "i", turn: "0" });
    state = fold(state, interrupt);
    expect(command(state, interrupt)).toEqual({ kind: "interrupt", req: "i" });
    state = fold(state, make(10, "prompt.delivered", { req: "i" }));
    expect(state.requests.find((item) => item.req === "i")?.status).toBe("delivered");
    expect(deadline(state)).toBeUndefined();
    check(state);
  });

  it("expires a request at its due time without reporting delivery", () => {
    const prompt = make(6, "prompt.requested", { req: "p", turn: "0", text: "text", images: [] });
    let state = fold(boot(), prompt);
    const due = state.pending.find((item) => item.op === "req:p")?.due;
    expect(due).toBeDefined();
    const expired = decodeSessionEvent({
      seq: 7,
      at: due,
      src: "alarm",
      kind: "timeout",
      op: "req:p",
    });
    state = fold(state, expired);
    expect(state.requests.find((item) => item.req === "p")?.status).toBe("timed_out");
    expect(state.requests.find((item) => item.req === "p")?.status).not.toBe("delivered");
    check(state);
  });
  it("redeploy re-dials without a close; reconnect acknowledges n and resends pending work", () => {
    let state = fold(
      boot(),
      make(6, "agent.event", { agentKind: "codex", gen: 1, n: 6, event: { opaque: true } }),
    );
    const request = make(7, "prompt.requested", { req: "x", turn: "0", text: "more", images: [] });
    state = fold(state, request);
    const redial = make(8, "sup.redial", { gen: 1 });
    state = fold(state, redial);
    expect(command(state, redial)).toEqual({ kind: "dial", gen: 1, after: 6 });
    const again = make(9, "sup.redial", { gen: 1 });
    state = fold(state, again);
    const due = state.pending.find((p) => p.op === "dial")?.due;
    expect(command(state, again)?.kind).toBe("dial");
    const failed = make(10, "dial.failed", { gen: 1 });
    state = fold(state, failed);
    expect(state.pending.find((p) => p.op === "dial")?.due).toBe(due);
    expect(state.pending.find((p) => p.op === "redial")?.due).toBe(failed.at + deadlines.redial);
    const tick = make(12, "timeout", { op: "redial" });
    state = fold(state, tick);
    expect(command(state, tick)).toEqual({ kind: "dial", gen: 1, after: 6 });
    const reconnect = make(13, "sup.hello", { gen: 1, version: "v1" });
    state = fold(state, reconnect);
    expect(command(state, reconnect)).toEqual({
      kind: "resend",
      gen: 1,
      requests: [{ req: "x", kind: "prompt", turn: "0", text: "more" }],
    });
    state = fold(state, make(14, "agent.event", { agentKind: "codex", gen: 1, n: 6, event: null }));
    expect(state.lastN).toBe(6);
    state = fold(state, make(15, "agent.event", { agentKind: "codex", gen: 1, n: 7, event: null }));
    expect(state.lastN).toBe(7);
    check(state);
  });

  it("socket-close retries are paced, deadlines do not slide and expired startup fails closed", () => {
    let state = fold(boot(), make(6, "socket.closed", { gen: 1 }));
    const due = state.pending.find((p) => p.op === "dial")?.due;
    const retry = state.pending.find((p) => p.op === "redial")?.due;
    state = fold(state, make(7, "dial.failed", { gen: 1 }));
    expect(state.pending.find((p) => p.op === "dial")?.due).toBe(due);
    expect(state.pending.find((p) => p.op === "redial")?.due).toBe(retry);
    check(state);
    let startup = fold(fold(initial, created), start);
    startup = fold(startup, make(3, "dial.failed", { gen: 1 }));
    expect(startup.pending.some((p) => p.op === "dial")).toBe(false);
    startup = fold(startup, make(200, "timeout", { op: "container" }));
    expect(startup.phase).toBe("failed");
    startup = fold(startup, make(201, "sup.hello", { gen: 1, version: "v1" }));
    check(startup);
  });

  it("refuses new generations and mismatched turn generations", () => {
    let state = fold(
      boot(),
      make(6, "prompt.requested", { req: "p", turn: "0", text: "text", images: [] }),
    );
    state = fold(state, make(7, "container.start", { gen: 2 }));
    state = fold(state, make(8, "turn.ended", { gen: 2, turn: "0", state: "completed" }));
    expect(state.gen).toBe(1);
    expect(state.currentTurn).toBe("0");
    expect(state.requests.find((r) => r.req === "p")?.status).toBe("pending");
    check(state);
  });

  it("restarts a container on wake before its first hello", () => {
    let state = fold(fold(initial, created), start);
    const wake = decodeSessionEvent({ seq: 3, at: 60_000, src: "do", kind: "sup.redial", gen: 1 });
    state = fold(state, wake);
    expect(command(state, wake)).toEqual({ kind: "container.start", gen: 1 });
    expect(state.pending.find((p) => p.op === "container")?.due).toBe(
      start.at + deadlines.container,
    );
    check(state);
  });

  it("never emits a command after failure", () => {
    let state = fold(fold(initial, created), start);
    state = fold(state, make(3, "failed", { phase: "boot", code: "lost", retryable: false }));
    const wake = make(4, "sup.redial", { gen: 1 });
    state = fold(state, wake);
    expect(command(state, wake)).toBeUndefined();
    check(state);
  });

  it("ignores a late delivery after a request times out", () => {
    let state = fold(
      boot(),
      make(6, "prompt.requested", { req: "p", turn: "0", text: "text", images: [] }),
    );
    const due = state.pending.find((p) => p.op === "req:p")?.due;
    state = fold(
      state,
      decodeSessionEvent({ seq: 7, at: due, src: "alarm", kind: "timeout", op: "req:p" }),
    );
    state = fold(state, make(8, "prompt.delivered", { req: "p" }));
    expect(state.requests.find((r) => r.req === "p")?.status).toBe("timed_out");
    check(state);
  });

  it("does not dial for a timeout without a pending redial", () => {
    let state = boot();
    const wake = make(6, "sup.redial", { gen: 1 });
    state = fold(state, wake);
    const stray = make(7, "timeout", { op: "redial" });
    state = fold(state, stray);
    expect(command(state, stray)).toBeUndefined();
    check(state);
  });

  it("records a retryable reason for each lifecycle timeout", () => {
    const started = fold(fold(initial, created), start);
    const cases = [
      { op: "container", state: started, code: "container_timeout" },
      { op: "workspace", state: fold(started, hello), code: "workspace_timeout" },
    ];
    for (const item of cases) {
      const due = item.state.pending.find((p) => p.op === item.op)?.due;
      const timed = fold(
        item.state,
        decodeSessionEvent({
          seq: item.state.lastSeq + 1,
          at: due,
          src: "alarm",
          kind: "timeout",
          op: item.op,
        }),
      );
      expect(timed.failure).toEqual({ code: item.code, retryable: true });
      check(timed);
    }
  });

  it("stops, not fails, when the dial deadline passes", () => {
    const closed = fold(boot(), make(6, "socket.closed", { gen: 1 }));
    const due = closed.pending.find((p) => p.op === "dial")?.due;
    const timeout = decodeSessionEvent({
      seq: 7,
      at: due,
      src: "alarm",
      kind: "timeout",
      op: "dial",
    });
    const state = fold(closed, timeout);
    expect(state.phase).toBe("stopped");
    expect(state.failure).toBeUndefined();
    expect(command(state, timeout)).toEqual({ kind: "destroy" });
    check(state);
  });

  it("stops on container.stopped, ends pending requests and ignores later output", () => {
    const stopped = make(6, "container.stopped", { gen: 1 });
    const state = fold(boot(), stopped);
    expect(state.phase).toBe("stopped");
    expect(state.requests.every((r) => r.status !== "pending")).toBe(true);
    expect(command(state, stopped)).toEqual({ kind: "destroy" });
    const late = fold(
      state,
      make(7, "agent.event", { gen: 1, n: 7, agentKind: "codex", event: null }),
    );
    expect(late).toEqual({ ...state, lastSeq: 7 });
    check(late);
  });
});
