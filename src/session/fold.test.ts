import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import { decodeSessionEvent, type SessionEvent } from "./events.js";
import { command } from "./commands.js";
import { deadline, deadlines, fold, initial, invariants, type State } from "./fold.js";

const make = (seq: number, kind: string, fields: Record<string, unknown> = {}): SessionEvent =>
  decodeSessionEvent({ seq, at: seq * 1_000, src: "test", kind, ...fields });
const created = make(1, "created", {
  agentKind: "codex",
  repo: "https://example.org/repo",
  baseBranch: "main",
  title: "test",
  prompt: "hello",
  image: "image",
});
const start = make(2, "container.start", { gen: 1 });
const hello = make(3, "sup.hello", { gen: 1, version: "v1" });
const ready = make(4, "workspace.ready", { gen: 1, branch: "main", commit: "abc" });
const delivered = make(5, "prompt.delivered", { req: "initial:1" });
const boot = (): State => [created, start, hello, ready, delivered].reduce(fold, initial);

const check = (state: State): void => {
  expect(invariants(state)).toEqual([]);
  const pending = state.pending;
  expect(deadline(state)).toBe(
    pending.length === 0 ? undefined : Math.min(...pending.map((item) => item.due)),
  );
  expect(pending.some((p) => p.op === "container")).toBe(
    state.gen !== undefined && !state.hello && state.phase !== "failed",
  );
  expect(pending.some((p) => p.op === "workspace")).toBe(
    state.hello && !state.ready && state.phase !== "failed",
  );
  expect(pending.some((p) => p.op === "dial")).toBe(
    state.hello && !state.connected && state.phase !== "failed",
  );
  for (const request of state.requests)
    expect(pending.some((p) => p.op === `req:${request.req}`)).toBe(request.status === "pending");
};

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
      branch: "main",
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
      make(6, "agent.event", { agentKind: "codex", gen: 1, n: 4, event: { opaque: true } }),
    );
    const request = make(7, "prompt.requested", { req: "x", turn: "0", text: "more", images: [] });
    state = fold(state, request);
    const redial = make(8, "sup.redial", { gen: 1 });
    state = fold(state, redial);
    expect(command(state, redial)).toEqual({ kind: "dial", gen: 1, after: 4 });
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
    expect(command(state, tick)).toEqual({ kind: "dial", gen: 1, after: 4 });
    const reconnect = make(13, "sup.hello", { gen: 1, version: "v1" });
    state = fold(state, reconnect);
    expect(command(state, reconnect)).toEqual({
      kind: "ack",
      gen: 1,
      after: 4,
      resend: [{ req: "x", kind: "prompt", turn: "0", text: "more" }],
    });
    state = fold(state, make(14, "agent.event", { agentKind: "codex", gen: 1, n: 4, event: null }));
    expect(state.lastN).toBe(4);
    state = fold(state, make(15, "agent.event", { agentKind: "codex", gen: 1, n: 5, event: null }));
    expect(state.lastN).toBe(5);
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

  it("rejects negative and fractional sequence, generation and message numbers", () => {
    expect(() =>
      make(-1, "created", {
        agentKind: "codex",
        repo: "repo",
        baseBranch: "main",
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
  });
  it("reports each invariant without throwing", () => {
    const state = boot();
    const bad: State = {
      ...state,
      lastSeq: -1,
      gen: -1,
      lastN: -1,
      currentTurn: "-1",
      turns: [{ turn: "2", state: "wrong" }],
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
});

const kinds = Schema.Literals([
  "created",
  "container.start",
  "sup.hello",
  "workspace.ready",
  "prompt.requested",
  "prompt.delivered",
  "interrupt.requested",
  "agent.event",
  "turn.ended",
  "failed",
  "timeout",
  "socket.closed",
  "dial.failed",
  "sup.redial",
  "invariant.violated",
]);
const generated = Arbitrary.schema(
  Schema.Struct({
    kind: kinds,
    gen: Schema.Literals([0, 1, 2]),
    req: Schema.Literals(["x", "y", "initial:1"]),
    turn: Schema.Literals(["0", "1", "2"]),
    n: Schema.Literals([0, 1, 2, 3]),
    op: Schema.Literals([
      "container",
      "workspace",
      "dial",
      "redial",
      "req:x",
      "req:y",
      "req:initial:1",
    ]),
    state: Schema.Literals(["completed", "failed"]),
    dt: Schema.Literals([0, 1_000, 2_000, 30_000, 120_000]),
  }),
);
let shortest = Infinity;
let longest = 0;
let generatedRuns = 0;
it.prop(
  "after every generated event the alarm matches outstanding work",
  [Arbitrary.array(generated, { minLength: 20, maxLength: 200 })],
  ([steps]) => {
    shortest = Math.min(shortest, steps.length);
    longest = Math.max(longest, steps.length);
    generatedRuns++;
    if (generatedRuns === 200) {
      expect(shortest).toBeGreaterThanOrEqual(20);
      expect(longest).toBeGreaterThanOrEqual(120);
    }
    for (const prefix of [[], [created, start, hello, ready]]) {
      let state: State = initial;
      let priorDial: number | undefined;
      let at = 0;
      for (const event of prefix) {
        state = fold(state, event);
        check(state);
      }
      for (const [index, step] of steps.entries()) {
        const fields: Record<string, unknown> = {
          gen: step.gen,
          req: step.req,
          turn: step.turn,
          n: step.n,
          op: step.op,
          state: step.state,
          agentKind: "codex",
          repo: "https://example.org/repo",
          baseBranch: "main",
          title: "test",
          prompt: "hello",
          image: "image",
          version: "v1",
          branch: "main",
          commit: "abc",
          text: "go",
          images: [],
          event: { value: step.n },
          phase: "boot",
          code: "error",
          retryable: false,
          detail: "detail",
        };
        const kind =
          step.kind === "failed" && (step.n !== 0 || step.req !== "x") ? "agent.event" : step.kind;
        if (kind === "prompt.requested" || kind === "interrupt.requested")
          fields.req = step.req === "initial:1" ? "z" : step.req;
        at += step.dt;
        const event = decodeSessionEvent({
          seq: index + prefix.length + 1,
          at: 4_000 + at,
          src: "test",
          kind,
          ...fields,
        });
        const before = state;
        state = fold(state, event);
        const issued = command(state, event);
        if (before.phase === "failed") expect(issued).toBeUndefined();
        if (issued?.kind === "dial") {
          const wake = event.kind === "sup.redial" && event.gen === before.gen && before.hello;
          const retry =
            event.kind === "timeout" &&
            event.op === "redial" &&
            before.pending.some((p) => p.op === "redial" && p.due <= event.at);
          expect(wake || retry).toBe(true);
        }
        for (const request of before.requests) {
          if (request.status !== "pending")
            expect(state.requests.find((r) => r.req === request.req)?.status).toBe(request.status);
        }
        if (
          event.kind === "timeout" &&
          event.op.startsWith("req:") &&
          before.pending.some((p) => p.op === event.op && p.due <= event.at)
        )
          expect(state.requests.find((r) => `req:${r.req}` === event.op)?.status).toBe("timed_out");
        check(state);
        const dialDue = state.pending.find((p) => p.op === "dial")?.due;
        if (priorDial !== undefined && dialDue !== undefined)
          expect(dialDue).toBeLessThanOrEqual(priorDial);
        priorDial = dialDue;
      }
    }
  },
  { arbitrary: { runs: 200, seed: "fold", size: 200 } },
);
