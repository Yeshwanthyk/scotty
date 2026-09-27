import { describe, expect, it } from "@effect/vitest";
import { command } from "./commands.js";
import { fold, initial, invariants, type State } from "./fold.js";
import { boot, check, created, hello, make, start } from "./fold-fixtures.js";

describe("supervisor outputs", () => {
  it("fails a generation when its supervisor boot identity changes", () => {
    let state = fold(fold(fold(initial, created), start), hello);
    state = fold(state, make(4, "socket.closed", { gen: 1 }));
    const replacement = make(5, "sup.hello", { gen: 1, n: 1, boot: "boot-2", version: "v1" });
    state = fold(state, replacement);
    expect(state.phase).toBe("failed");
    expect(state.failure).toEqual({ code: "supervisor_restarted", retryable: true });
    expect(command(state, replacement)).toBeUndefined();
    check(state);
  });

  it("counts all accepted supervisor outputs and acks after fifty or a turn end", () => {
    let state = fold(fold(initial, created), start);
    state = fold(state, hello);
    expect(state.lastN).toBe(1);
    state = fold(
      state,
      make(4, "workspace.ready", { gen: 1, n: 2, branch: "scotty/session-1", commit: "abc" }),
    );
    expect(state.lastN).toBe(2);
    state = fold(
      state,
      make(5, "agent.ready", { gen: 1, n: 3, agentKind: "codex", session: "thread-1" }),
    );
    expect(state.lastN).toBe(3);
    expect(state.agentSession).toBe("thread-1");
    state = fold(state, make(6, "prompt.delivered", { gen: 1, n: 4, req: "initial:1" }));
    expect(state.lastN).toBe(4);
    state = fold(
      state,
      make(7, "agent.event", { gen: 1, n: 5, agentKind: "codex", event: { untouched: true } }),
    );
    expect(state.lastN).toBe(5);
    state = fold(state, make(8, "sup.error", { gen: 1, n: 5, code: "exit", message: "duplicate" }));
    expect(state.lastN).toBe(5);
    const gap = make(9, "sup.error", { gen: 1, n: 55, code: "protocol", message: "no request" });
    state = fold(state, gap);
    expect(state.lastN).toBe(55);
    expect(command(state, gap)).toEqual({ kind: "ack", gen: 1, ack: 55 });
    const small = make(10, "agent.event", { gen: 1, n: 56, agentKind: "codex", event: null });
    state = fold(state, small);
    expect(command(state, small)).toBeUndefined();
    const ended = make(11, "turn.ended", {
      gen: 1,
      n: 57,
      turn: "0",
      codexTurn: "codex-123",
      state: "completed",
    });
    state = fold(state, ended);
    expect(state.turns[0]).toEqual({ turn: "0", codexTurn: "codex-123", state: "completed" });
    expect(command(state, ended)).toEqual({ kind: "save", gen: 1, turn: "0", ack: 57 });
    check(state);
  });

  it("acks a repeated workspace output at the threshold but not its duplicate", () => {
    let state = boot();
    const repeated = make(6, "workspace.ready", {
      gen: 1,
      n: 50,
      base: "main",
      branch: "scotty/session-1",
      commit: "abc",
    });
    state = fold(state, repeated);
    expect(command(state, repeated)).toEqual({ kind: "ack", gen: 1, ack: 50 });
    const duplicate = make(7, "workspace.ready", {
      gen: 1,
      n: 50,
      base: "main",
      branch: "scotty/session-1",
      commit: "abc",
    });
    state = fold(state, duplicate);
    expect(command(state, duplicate)).toBeUndefined();
    check(state);
  });
  it("keeps timeout-coded errors pending and settles other request errors once", () => {
    let state = fold(
      boot(),
      make(6, "prompt.requested", { req: "p", turn: "0", text: "go", images: [] }),
    );
    const unknown = make(7, "sup.error", {
      gen: 1,
      n: 6,
      req: "p",
      code: "timeout",
      message: "unknown outcome",
    });
    state = fold(state, unknown);
    expect(state.requests.find((r) => r.req === "p")?.status).toBe("pending");
    const failure = make(8, "sup.error", {
      gen: 1,
      n: 7,
      req: "p",
      code: "stale",
      message: "turn already ended",
    });
    state = fold(state, failure);
    expect(state.requests.find((r) => r.req === "p")?.status).toBe("failed");
    expect(state.pending.some((p) => p.op === "req:p")).toBe(false);
    state = fold(
      state,
      make(9, "sup.error", { gen: 1, n: 8, req: "p", code: "other", message: "late" }),
    );
    state = fold(state, make(10, "prompt.delivered", { gen: 1, n: 9, req: "p" }));
    expect(state.requests.find((r) => r.req === "p")?.status).toBe("failed");
    check(state);
  });
  it("ignores outputs after close and does not ack a duplicate turn end", () => {
    let closed = fold(boot(), make(6, "socket.closed", { gen: 1 }));
    const late = make(7, "agent.event", {
      gen: 1,
      n: closed.lastN + 1,
      agentKind: "codex",
      event: null,
    });
    closed = fold(closed, late);
    expect(closed.lastN).toBe(5);
    expect(command(closed, late)).toBeUndefined();
    check(closed);
    let state = boot();
    const end = make(6, "turn.ended", {
      gen: 1,
      n: 6,
      turn: "0",
      codexTurn: "cx",
      state: "completed",
    });
    state = fold(state, end);
    expect(command(state, end)).toEqual({ kind: "save", gen: 1, turn: "0", ack: 6 });
    const duplicate = make(7, "turn.ended", {
      gen: 1,
      n: 6,
      turn: "0",
      codexTurn: "cx",
      state: "completed",
    });
    state = fold(state, duplicate);
    expect(command(state, duplicate)).toBeUndefined();
    expect(state.turns).toHaveLength(1);
    check(state);
  });

  it("ignores hello on an already connected socket", () => {
    const before = boot();
    const again = make(6, "sup.hello", { gen: 1, n: 1, boot: "boot-1", version: "v1" });
    const state = fold(before, again);
    expect(state).toEqual({ ...before, lastSeq: 6 });
    expect(command(state, again)).toBeUndefined();
    check(state);
  });

  it("stops the session on a request-less agent exit", () => {
    const event = make(6, "sup.error", { gen: 1, n: 6, code: "exit", message: "agent exited" });
    const state = fold(boot(), event);
    expect(state.failure).toBeUndefined();
    expect(state.phase).toBe("stopped");
    expect(state.lastN).toBe(6);
    expect(command(state, event)).toEqual({ kind: "destroy" });
    check(state);
  });
  it("reports each invariant without throwing", () => {
    const state = boot();
    const bad: State = {
      ...state,
      lastSeq: -1,
      gen: -1,
      lastN: -1,
      currentTurn: "-1",
      turns: [{ turn: "2", codexTurn: "codex-2", state: "wrong" }],
      connected: true,
      hello: false,
      ready: false,
      requests: [
        { req: "x", kind: "prompt", turn: "0", text: "a", status: "pending", seq: 3 },
        { req: "x", kind: "prompt", turn: "0", text: "b", status: "stale", seq: 4 },
      ],
      pending: [
        { op: "req:orphan", due: Number.NaN },
        { op: "req:orphan", due: 3 },
      ],
    };
    expect(invariants(bad).map((v) => v.code)).toEqual(
      expect.arrayContaining([
        "sequence",
        "generation",
        "ack",
        "turns",
        "connection",
        "requests",
        "deadlines",
        "pending",
        "operations",
        "container",
      ]),
    );
    expect(
      invariants({ ...state, phase: "failed", pending: [{ op: "dial", due: 1 }] }).map(
        (v) => v.code,
      ),
    ).toContain("failed");
    expect(invariants({ ...state, phase: "running", ready: false }).map((v) => v.code)).toContain(
      "running",
    );
    expect(invariants({ ...state, connected: false }).map((v) => v.code)).toContain("dial");
    expect(
      invariants({ ...state, ready: false, phase: "provisioning" }).map((v) => v.code),
    ).toContain("workspaceDeadline");
    expect(
      invariants({ ...state, pending: [{ op: "redial", due: 1 }] }).map((v) => v.code),
    ).toContain("redial");
  });
  it("rejects negative and fractional sequence, generation and message numbers", () => {
    expect(() =>
      make(-1, "created", {
        agentKind: "codex",
        repo: "repo",
        baseBranch: "main",
        branch: "scotty/session-1",
        title: "x",
        prompt: "x",
        image: "i",
      }),
    ).toThrow();
    expect(() => make(1.5, "container.start", { gen: 1 })).toThrow();
    expect(() => make(2, "container.start", { gen: -1 })).toThrow();
    expect(() => make(2, "container.start", { gen: 1.5 })).toThrow();
    expect(() =>
      make(2, "agent.event", { agentKind: "codex", gen: 1, n: -1, event: null }),
    ).toThrow();
    expect(() =>
      make(2, "agent.event", { agentKind: "codex", gen: 1, n: 0, event: null }),
    ).toThrow();
  });
});
