import { describe, expect, it } from "@effect/vitest";
import { decodeSessionEvent } from "./events.js";
import { command } from "./commands.js";
import { deadline, deadlines, fold, initial, startStep, type State } from "./fold.js";
import { sessionView } from "./view.js";
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
    // The open turn stalls only after the agent is silent that long.
    expect(state.pending).toEqual([{ op: "stalled", due: delivered.at + deadlines.stalled }]);
    check(state);
  });

  it("keeps a prompt that arrives while the workspace is made and sends it with the first", () => {
    let state = [created, start].reduce(fold, initial);
    const early = make(3, "prompt.requested", {
      req: "early",
      turn: "0",
      text: "more",
      images: [],
    });
    state = fold(state, early);
    expect(state.requests.find((item) => item.req === "early")?.status).toBe("pending");
    expect(command(state, early)).toBeUndefined();
    check(state);
    const again = make(4, "prompt.requested", {
      req: "early",
      turn: "0",
      text: "x",
      images: [],
    });
    state = fold(state, again);
    expect(state.requests).toHaveLength(1);
    check(state);
    const up = make(5, "sup.hello", { gen: 1, version: "v1" });
    const workspace = make(6, "workspace.ready", { gen: 1, branch: "main", commit: "abc" });
    state = fold(fold(state, up), workspace);
    const sent = command(state, workspace);
    expect(sent?.kind).toBe("resend");
    expect(sent?.kind === "resend" ? sent.requests.map((item) => item.req) : []).toEqual([
      "initial:1",
      "early",
    ]);
    expect(deadline(state)).toBeDefined();
    check(state);
    // An interrupt still has nothing to stop before the workspace exists.
    const stop = make(3, "interrupt.requested", { req: "i", turn: "0" });
    expect(
      fold([created, start].reduce(fold, initial), stop).requests.find((r) => r.req === "i")
        ?.status,
    ).toBe("stale");
  });

  it("sends the first prompt under the creator's request id and ignores a retry of it", () => {
    const named = make(1, "created", { ...created, req: "create-1" });
    const retry = (seq: number) =>
      make(seq, "prompt.requested", { req: "create-1", turn: "0", text: "hello", images: [] });
    let state = [named, start, hello].reduce(fold, initial);
    state = fold(state, retry(4));
    expect(state.requests).toEqual([]);
    const workspace = make(5, "workspace.ready", { gen: 1, branch: "main", commit: "abc" });
    state = fold(state, workspace);
    expect(command(state, workspace)).toEqual({
      kind: "prompt",
      req: "create-1",
      turn: "0",
      text: "hello",
    });
    state = fold(state, retry(6));
    expect(state.requests.map((item) => item.req)).toEqual(["create-1"]);
    check(state);
  });

  it("answers a start by what the session has already seen", () => {
    const input = {
      req: "create-1",
      repo: "https://example.org/repo",
      agent: "codex" as const,
      prompt: "hello",
    };
    expect(startStep(initial, input)).toBe("create");
    const named = make(1, "created", { ...created, req: "create-1" });
    const first = make(5, "prompt.delivered", { req: "create-1" });
    let state = [named, start, hello, ready, first].reduce(fold, initial);
    expect(startStep(state, input)).toBe("duplicate");
    expect(startStep(state, { ...input, prompt: "other" })).toBe("conflict");
    expect(startStep(state, { ...input, repo: "https://example.org/other" })).toBe("conflict");
    expect(startStep(state, { ...input, req: "steer-1", agent: "claude" })).toBe("conflict");
    const steer = { ...input, req: "steer-1", prompt: "more" };
    expect(startStep(state, steer)).toBe("prompt");
    state = fold(
      state,
      make(6, "prompt.requested", { req: "steer-1", turn: "0", text: "more", images: [] }),
    );
    expect(startStep(state, steer)).toBe("duplicate");
    expect(startStep(state, { ...steer, prompt: "else" })).toBe("conflict");
    // A steer whose turn has since ended went in: its retry is still a duplicate.
    state = fold(state, make(7, "prompt.delivered", { req: "steer-1" }));
    state = fold(
      state,
      make(8, "turn.ended", { gen: 1, turn: "0", codexTurn: "cx", state: "completed" }),
    );
    expect(startStep(state, steer)).toBe("duplicate");
    // One the session refused did not go in, and a retry cannot put it in.
    state = fold(
      state,
      make(9, "prompt.requested", { req: "late", turn: "0", text: "late", images: [] }),
    );
    expect(state.requests.find((item) => item.req === "late")?.status).toBe("stale");
    expect(startStep(state, { ...input, req: "late", prompt: "late" })).toBe("unavailable");
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
    expect(state.pending).toEqual([{ op: "stalled", due: 10_000 + deadlines.stalled }]);
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

  it("records a retryable reason for each lifecycle timeout and destroys the container", () => {
    const started = fold(fold(initial, created), start);
    const cases = [
      { op: "container", state: started, code: "container_timeout" },
      { op: "workspace", state: fold(started, hello), code: "workspace_timeout" },
    ];
    for (const item of cases) {
      const due = item.state.pending.find((p) => p.op === item.op)?.due;
      const event = decodeSessionEvent({
        seq: item.state.lastSeq + 1,
        at: due,
        src: "alarm",
        kind: "timeout",
        op: item.op,
      });
      const timed = fold(item.state, event);
      expect(timed.failure).toEqual({ code: item.code, retryable: true });
      // A start placed after its deadline would otherwise run until the inactivity timeout.
      expect(command(timed, event)).toEqual({ kind: "destroy" });
      check(timed);
    }
  });

  it("fails at once when the supervisor reports a failed start", () => {
    const started = fold(fold(fold(initial, created), start), hello);
    const error = make(4, "sup.error", { code: "workspace" });
    const failed = fold(started, error);
    expect(failed.phase).toBe("failed");
    expect(command(failed, error)).toEqual({ kind: "destroy" });
    expect(failed.failure).toEqual({ code: "workspace", retryable: true });
    expect(deadline(failed)).toBeUndefined();
    check(failed);
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

  it("ends a running session with reason ended", () => {
    const state = fold(
      boot(),
      make(6, "container.stopped", { gen: 1, reason: "ended", req: "end" }),
    );
    expect(state.phase).toBe("stopped");
    expect(state.stop).toEqual({ reason: "ended" });
    check(state);
  });

  it("records an ended stop on a failed session without making it resumable or taking prompts", () => {
    const failed = fold(
      boot(),
      make(6, "failed", { phase: "agent", code: "agent_exited", retryable: false }),
    );
    const old = make(7, "container.stopped", { gen: 0, reason: "ended", req: "old-end" });
    const ignored = fold(failed, old);
    expect(ignored.stopSeq).toBe(failed.stopSeq);
    expect(command(ignored, old)).toBeUndefined();
    const gone = fold(ignored, make(8, "container.stopped", { gen: 1, reason: "gone" }));
    expect(gone.stopSeq).toBe(failed.stopSeq);
    const stopped = make(8, "container.stopped", { gen: 1, reason: "ended", req: "end" });
    const state = fold(ignored, stopped);
    expect(state).toEqual({ ...failed, lastSeq: 8, stopSeq: 8 });
    expect(command(state, stopped)).toEqual({ kind: "destroy" });
    const resumed = fold(state, make(9, "resume.requested"));
    expect(resumed).toEqual({ ...state, lastSeq: 9 });
    const prompted = fold(
      resumed,
      make(10, "prompt.requested", { req: "new", turn: state.currentTurn, text: "hi", images: [] }),
    );
    expect(prompted.phase).toBe("failed");
    expect(prompted.requests.find((request) => request.req === "new")?.status).toBe("stale");
    check(prompted);
  });

  it("records when a session went to sleep and clears it on resume", () => {
    const stopped = make(6, "container.stopped", { gen: 1 });
    let state = fold(boot(), stopped);
    expect(state.stoppedAt).toBe(stopped.at);
    expect(sessionView("session-1", state).display.stoppedAt).toBe(
      new Date(stopped.at).toISOString(),
    );
    state = fold(state, make(7, "agent.event", { gen: 1, n: 7, agentKind: "codex", event: null }));
    expect(state.stoppedAt).toBe(stopped.at);
    state = fold(state, make(8, "resume.requested"));
    expect(state.phase).toBe("provisioning");
    expect(state.stoppedAt).toBeUndefined();
    expect(sessionView("session-1", state).display.stoppedAt).toBeNull();
  });

  it("saves after an accepted turn end and clears the save deadline on its result", () => {
    const end = make(6, "turn.ended", { gen: 1, turn: "0", codexTurn: "cx", state: "completed" });
    const ended = fold(boot(), end);
    expect(command(ended, end)).toEqual({ kind: "save", gen: 1, turn: "0", ack: 6 });
    expect(ended.pending.find((p) => p.op === "save")?.due).toBe(6_000 + deadlines.save);
    const done = fold(ended, make(7, "save.done", { turn: "0" }));
    expect(done.pending.some((p) => p.op === "save")).toBe(false);
    check(done);
  });

  it("records a save timeout without failing the session", () => {
    const end = make(6, "turn.ended", { gen: 1, turn: "0", codexTurn: "cx", state: "completed" });
    const ended = fold(boot(), end);
    const timeout = decodeSessionEvent({
      seq: 7,
      at: 6_000 + deadlines.save,
      src: "alarm",
      kind: "timeout",
      op: "save",
    });
    const state = fold(ended, timeout);
    expect(state.phase).toBe("running");
    expect(state.pending.some((p) => p.op === "save")).toBe(false);
    check(state);
  });

  const stoppedWithThread = () =>
    [
      make(6, "agent.ready", { gen: 1, n: 6, agentKind: "codex", session: "thread-1" }),
      make(7, "container.stopped", { gen: 1 }),
    ].reduce(fold, boot());

  it("resumes a stopped session on request with a fresh container and the saved thread", () => {
    const requested = make(8, "resume.requested");
    let state = fold(stoppedWithThread(), requested);
    expect(state).toMatchObject({ phase: "provisioning", gen: 2, lastN: 0, hello: false });
    expect(command(state, requested)).toEqual({ kind: "container.start", gen: 2, fresh: true });
    const greeting = make(9, "sup.hello", { gen: 2, n: 1, version: "v1", boot: "boot-2" });
    state = fold(state, greeting);
    expect(command(state, greeting)).toMatchObject({
      kind: "start",
      gen: 2,
      resume: { threadId: "thread-1", commit: "abc" },
    });
    check(state);
  });

  it("resumes on a steer to a stopped session and resends it once the workspace is ready", () => {
    // The stop interrupted turn 0, so the steer starts turn 1.
    const stale = make(8, "prompt.requested", { req: "s0", turn: "0", text: "late", images: [] });
    let state = fold(stoppedWithThread(), stale);
    expect(state.requests.find((r) => r.req === "s0")?.status).toBe("stale");
    expect(state.phase).toBe("stopped");
    const steer = make(9, "prompt.requested", { req: "s1", turn: "1", text: "again", images: [] });
    state = fold(state, steer);
    expect(command(state, steer)).toEqual({ kind: "container.start", gen: 2, fresh: true });
    expect(state.requests.find((r) => r.req === "s1")?.status).toBe("pending");
    check(state);
    state = fold(state, make(10, "sup.hello", { gen: 2, n: 1, version: "v1", boot: "boot-2" }));
    const resumed = make(11, "workspace.ready", { gen: 2, n: 2, branch: "main", commit: "abc" });
    state = fold(state, resumed);
    expect(state.phase).toBe("running");
    expect(state.requests.some((r) => r.req === "initial:2")).toBe(false);
    expect(state.pending.find((p) => p.op === "req:s1")?.due).toBe(11_000 + deadlines.prompt);
    expect(command(state, resumed)).toEqual({
      kind: "resend",
      gen: 2,
      requests: [{ req: "s1", kind: "prompt", turn: "1", text: "again" }],
    });
    check(state);
  });

  it("gives an attached file to the current turn, during a turn and after a stop", () => {
    const shot = { file: "f1", name: "shot.png", type: "image/png", size: 10, caption: "home" };
    let state = fold(boot(), make(6, "file.attached", shot));
    expect(state.files).toEqual([{ ...shot, turn: "0" }]);
    state = fold(state, make(7, "turn.ended", { gen: 1, turn: "0", state: "completed" }));
    const stopped = make(8, "container.stopped", { gen: 1 });
    state = fold(state, stopped);
    const late = make(9, "file.attached", {
      file: "f2",
      name: "a.webm",
      type: "video/webm",
      size: 5,
    });
    state = fold(state, late);
    expect(state.phase).toBe("stopped");
    expect(state.files.map((file) => [file.file, file.turn])).toEqual([
      ["f1", "0"],
      ["f2", "1"],
    ]);
    expect(command(state, late)).toBeUndefined();
    check(state);
  });

  it("keeps what started a session, and a steer on the same turn behaves as any other prompt", () => {
    const origin = { kind: "hook", connection: "ci", delivery: "msg_1", key: "pr-7" };
    const hooked = make(1, "created", { ...created, origin });
    let state = fold(fold(initial, hooked), start);
    expect(state.created?.origin).toEqual(origin);
    expect(sessionView("session-1", state).display.origin).toEqual(origin);
    expect(sessionView("session-1", fold(initial, created)).display.origin).toBeNull();
    state = [hello, ready, delivered].reduce(fold, state);
    state = fold(
      state,
      make(6, "prompt.requested", { req: "hook:ci:msg_2", turn: "0", text: "again", images: [] }),
    );
    expect(state.requests.map((item) => [item.req, item.status])).toEqual([
      ["initial:1", "delivered"],
      ["hook:ci:msg_2", "pending"],
    ]);
    // A retried delivery names the same req and does nothing.
    const retried = make(7, "prompt.requested", {
      req: "hook:ci:msg_2",
      turn: "0",
      text: "again",
      images: [],
    });
    expect(fold(state, retried).requests).toHaveLength(2);
    expect(state.created?.origin).toEqual(origin);
    check(state);
  });

  it("decodes an api origin and refuses a hook origin without its connection", () => {
    expect(() =>
      decodeSessionEvent({ ...created, origin: { kind: "api", key: "nightly" } }),
    ).not.toThrow();
    expect(() => decodeSessionEvent({ ...created, origin: { kind: "hook" } })).toThrow();
  });

  it("re-arms the watch deadline on each watch, re-watches when it fires and drops it on a stop", () => {
    const watches = (state: State) => state.pending.filter((item) => item.op === "watch");
    let state = fold(boot(), make(6, "container.watched", { gen: 1 }));
    expect(watches(state)).toEqual([{ op: "watch", due: 6_000 + deadlines.watch }]);
    state = fold(state, make(7, "container.watched", { gen: 1 }));
    expect(watches(state)).toEqual([{ op: "watch", due: 7_000 + deadlines.watch }]);
    const early = decodeSessionEvent({
      seq: 8,
      at: 8_000,
      src: "alarm",
      kind: "timeout",
      op: "watch",
    });
    state = fold(state, early);
    expect(watches(state)).toHaveLength(1);
    const due = decodeSessionEvent({
      seq: 9,
      at: 7_000 + deadlines.watch,
      src: "alarm",
      kind: "timeout",
      op: "watch",
    });
    state = fold(state, due);
    expect(watches(state)).toEqual([]);
    expect(command(state, due)).toEqual({ kind: "watch", gen: 1 });
    state = fold(state, make(10, "container.watched", { gen: 1 }));
    const crashed = decodeSessionEvent({
      seq: 11,
      at: 11_000,
      src: "session",
      kind: "container.stopped",
      gen: 1,
      reason: "crashed",
      exitCode: 137,
    });
    state = fold(state, crashed);
    expect(state.phase).toBe("stopped");
    expect(state.pending).toEqual([]);
    expect(command(state, crashed)).toEqual({ kind: "destroy" });
    state = fold(state, make(12, "container.watched", { gen: 1 }));
    expect(state.pending).toEqual([]);
    check(state);
  });

  it("sleeps an idle session after its window, pushed back by prompts and use", () => {
    const timeout = (seq: number, at: number) =>
      decodeSessionEvent({ seq, at, src: "alarm", kind: "timeout", op: "idle" });
    let state = fold(boot(), make(6, "turn.ended", { gen: 1, turn: "0", state: "completed" }));
    expect(state.pending.map((item) => item.op)).toEqual(["save"]);
    state = fold(state, make(7, "save.done", { turn: "0" }));
    expect(state.pending).toEqual([{ op: "idle", due: 7_000 + deadlines.idle }]);
    state = fold(state, make(8, "active"));
    expect(state.pending).toEqual([{ op: "idle", due: 8_000 + deadlines.idle }]);
    const early = timeout(9, 9_000);
    state = fold(state, early);
    expect(command(state, early)).toBeUndefined();
    state = fold(
      state,
      make(10, "prompt.requested", { req: "p", turn: "1", text: "more", images: [] }),
    );
    expect(state.pending.map((item) => item.op).sort()).toEqual(["req:p", "stalled"]);
    state = fold(state, make(11, "prompt.delivered", { req: "p" }));
    state = fold(state, make(12, "turn.ended", { gen: 1, turn: "1", state: "completed" }));
    state = fold(state, make(13, "save.failed", { turn: "1", code: "save_failed" }));
    expect(state.pending).toEqual([{ op: "idle", due: 13_000 + deadlines.idle }]);
    const settledState = state;
    const state0 = () => settledState;
    const due = timeout(14, 13_000 + deadlines.idle);
    state = fold(state, due);
    expect(command(state, due)).toEqual({ kind: "idle", gen: 1, seq: 14 });
    // The next window starts at once, for when the Session DO finds the owner still at it.
    expect(state.pending).toEqual([{ op: "idle", due: due.at + deadlines.idle }]);
    const slept = make(15, "container.stopped", { gen: 1, reason: "idle", idleSeq: 14 });
    state = fold(state, slept);
    expect(state).toMatchObject({
      phase: "stopped",
      stoppedAt: slept.at,
      stop: { reason: "idle" },
      pending: [],
    });
    expect(command(state, slept)).toEqual({ kind: "destroy" });
    check(state);
    // A steer that lands while the Session DO checks for use keeps the session awake.
    const woke = fold(
      fold(
        fold(state0(), timeout(14, 13_000 + deadlines.idle)),
        make(15, "prompt.requested", { req: "q", turn: "2", text: "again", images: [] }),
      ),
      make(16, "container.stopped", { gen: 1, reason: "idle", idleSeq: 14 }),
    );
    expect(woke).toMatchObject({ phase: "running", stop: undefined });
    check(woke);
    // So does a steer whose turn and save both finish before the check's verdict lands.
    const checking = () => fold(state0(), timeout(14, 13_000 + deadlines.idle));
    const finished = [
      make(15, "prompt.requested", { req: "q", turn: "2", text: "again", images: [] }),
      make(16, "prompt.delivered", { req: "q" }),
      make(17, "turn.ended", { gen: 1, turn: "2", state: "completed" }),
      make(18, "save.done", { turn: "2" }),
      make(19, "container.stopped", { gen: 1, reason: "idle", idleSeq: 14 }),
    ].reduce(fold, checking());
    expect(finished).toMatchObject({ phase: "running", stop: undefined });
    check(finished);
    // And use the Session DO records during the check.
    const used = [
      make(15, "active"),
      make(16, "container.stopped", { gen: 1, reason: "idle", idleSeq: 14 }),
    ].reduce(fold, checking());
    expect(used).toMatchObject({ phase: "running", stop: undefined });
    check(used);
    const short = make(1, "created", { ...created, idleAfter: 30_000 });
    const quick = [short, start, hello, ready, delivered].reduce(fold, initial);
    const settled = fold(
      fold(quick, make(6, "turn.ended", { gen: 1, turn: "0", state: "completed" })),
      make(7, "save.done", { turn: "0" }),
    );
    expect(settled.pending).toEqual([{ op: "idle", due: 7_000 + 30_000 }]);
  });

  it("interrupts a stalled turn, then stops once its save settles or it never ends", () => {
    const timeout = (seq: number, at: number) =>
      decodeSessionEvent({ seq, at, src: "alarm", kind: "timeout", op: "stalled" });
    let state = boot();
    expect(state.pending).toEqual([{ op: "stalled", due: 5_000 + deadlines.stalled }]);
    const stall = timeout(6, 5_000 + deadlines.stalled);
    state = fold(state, stall);
    expect(command(state, stall)).toEqual({ kind: "interrupt", req: "stalled:0" });
    expect(state.pending).toEqual([
      { op: "req:stalled:0", due: stall.at + deadlines.interrupt },
      { op: "stalled", due: stall.at + deadlines.interrupt + deadlines.save },
    ]);
    check(state);
    let ended = fold(state, make(7, "turn.ended", { gen: 1, turn: "0", state: "interrupted" }));
    expect(ended.pending.map((item) => item.op)).toEqual(["save"]);
    const saved = make(8, "save.done", { turn: "0" });
    ended = fold(ended, saved);
    expect(ended).toMatchObject({ phase: "stopped", stop: { reason: "stalled" }, pending: [] });
    expect(command(ended, saved)).toEqual({ kind: "destroy" });
    check(ended);
    // The owner's next turn outlives the stalled turn's save.
    const next = fold(
      fold(
        fold(state, make(7, "turn.ended", { gen: 1, turn: "0", state: "interrupted" })),
        make(8, "prompt.requested", { req: "p", turn: "1", text: "go on", images: [] }),
      ),
      make(9, "save.done", { turn: "0" }),
    );
    expect(next).toMatchObject({ phase: "running", stop: undefined, currentTurn: "1" });
    check(next);
    // A turn that ignores the interrupt stops at the next stalled deadline.
    const again = timeout(7, stall.at + deadlines.interrupt + deadlines.save);
    state = fold(state, again);
    expect(state).toMatchObject({
      phase: "stopped",
      stop: { reason: "stalled" },
      currentTurn: "1",
      pending: [],
    });
    expect(command(state, again)).toEqual({ kind: "destroy" });
    check(state);
  });

  it("resumes a retryable failure and leaves one that is not retryable failed", () => {
    const retryable = make(6, "failed", { phase: "start", code: "start_failed", retryable: true });
    let state = fold(boot(), retryable);
    expect(state).toMatchObject({ phase: "failed", currentTurn: "1" });
    expect(state.turns.at(-1)).toEqual({ turn: "0", codexTurn: "", state: "interrupted" });
    const requested = make(7, "resume.requested");
    state = fold(state, requested);
    expect(state).toMatchObject({ phase: "provisioning", gen: 2, failure: undefined });
    expect(command(state, requested)).toEqual({ kind: "container.start", gen: 2, fresh: true });
    check(state);
    const fatal = make(6, "failed", { phase: "start", code: "broken", retryable: false });
    state = fold(fold(boot(), fatal), make(7, "resume.requested"));
    expect(state.phase).toBe("failed");
    check(state);
  });
});
