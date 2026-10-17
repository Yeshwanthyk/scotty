/// <reference types="node" />
import { describe, expect, it } from "@effect/vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { command } from "./commands.js";
import { deadlines } from "./deadlines.js";
import { SessionEvent } from "./events.js";
import { repoStats, sessionStats } from "./stats.js";
import { fold, initial, invariants, type State } from "./fold.js";
import { conversationView, sessionView } from "./view.js";

const logs = join(process.cwd(), "e2e", "logs");
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(SessionEvent));

const replayLine = (state: State, text: string, file: string, line: number): State => {
  let event: typeof SessionEvent.Type;
  try {
    event = decodeLine(text);
  } catch (error) {
    throw new Error(`${file}:${line}: invalid event`, { cause: error });
  }
  expect(event.seq, `${file}:${line}: event sequence must increase`).toBeGreaterThan(state.lastSeq);
  const next = fold(state, event);
  expect(invariants(next), `${file}:${line}`).toEqual([]);
  return next;
};

describe("saved session event logs", () => {
  it("decodes and checks every JSONL replay, including an empty directory", async () => {
    const files = (await readdir(logs)).filter((name) => name.endsWith(".jsonl"));
    const contents = await Promise.all(files.map((file) => readFile(join(logs, file), "utf8")));
    for (const [fileIndex, content] of contents.entries()) {
      const file = files[fileIndex] ?? "unknown log";
      let state = initial;
      for (const [index, line] of content.split("\n").entries()) {
        if (line.trim().length > 0) state = replayLine(state, line, file, index + 1);
      }
    }
  });
  it("identifies malformed and out-of-order log lines", () => {
    expect(() => replayLine(initial, "{", "broken.jsonl", 3)).toThrow("broken.jsonl:3");
    const row = JSON.stringify({
      seq: 1,
      at: 1,
      src: "api",
      kind: "created",
      agentKind: "codex",
      repo: "repo",
      baseBranch: "main",
      branch: "scotty/session-1",
      title: "test",
      prompt: "go",
      image: "image",
    });
    const state = replayLine(initial, row, "repeat.jsonl", 1);
    expect(() => replayLine(state, row, "repeat.jsonl", 2)).toThrow("repeat.jsonl:2");
  });
  it("replays the alarm-paced redial after a socket drop", async () => {
    const file = "redial-alarm.jsonl";
    const lines = (await readFile(join(logs, file), "utf8")).trim().split("\n");
    let state = initial;
    for (const [index, line] of lines.entries()) {
      const event = decodeLine(line);
      state = replayLine(state, line, file, index + 1);
      if (event.kind === "socket.closed")
        expect(state.pending.find((p) => p.op === "redial")?.due).toBe(8_000);
      if (event.kind === "timeout")
        expect(command(state, event)).toEqual({ kind: "dial", gen: 1, after: 3 });
      if (event.kind === "sup.hello" && event.seq === 8)
        expect(command(state, event)).toEqual({ kind: "resend", gen: 1, requests: [] });
    }
    expect(state.lastN).toBe(4);
    expect(state.phase).toBe("running");
  });
  it("replays a socket drop mid-clone and repeats start on the same boot", async () => {
    const file = "reconnect-before-ready.jsonl";
    const lines = (await readFile(join(logs, file), "utf8")).trim().split("\n");
    let state = initial;
    for (const [index, line] of lines.entries()) {
      const event = decodeLine(line);
      state = replayLine(state, line, file, index + 1);
      const issued = command(state, event);
      if (event.seq === 3 || event.seq === 6)
        expect(issued).toMatchObject({
          kind: "start",
          gen: 1,
          base: "main",
          branch: "scotty/session-1",
        });
      if (event.seq === 5) expect(issued).toEqual({ kind: "dial", gen: 1, after: 1 });
      if (event.seq === 7)
        expect(issued).toEqual({
          kind: "prompt",
          req: "initial:1",
          turn: "0",
          text: "Describe this repository",
        });
    }
    expect(state.phase).toBe("running");
    expect(state.boot).toBe("boot-a");
    expect(state.agentSession).toBe("thread-1");
    expect(state.lastN).toBe(4);
    expect(state.requests.find((r) => r.req === "initial:1")?.status).toBe("delivered");
  });
  it("replays a warm session whose container stopped and ends stopped, not failed", async () => {
    const file = "2026-09-27-warm-after-container-stopped.jsonl";
    const lines = (await readFile(join(logs, file), "utf8")).trim().split("\n");
    let state = initial;
    for (const [index, line] of lines.entries()) state = replayLine(state, line, file, index + 1);
    expect(state.phase).toBe("stopped");
    expect(state.failure).toBeUndefined();
    expect(state.pending).toEqual([]);
  });
  it("replays a resume the Session DO gave up on before the container deadline", async () => {
    // The fold is right for these events; the defect was the DO appending container.stopped
    // after ~10 s of dial retries while this deadline still had ~110 s left.
    const file = "2026-09-28-resume-dial-gave-up.jsonl";
    const lines = (await readFile(join(logs, file), "utf8")).trim().split("\n");
    let state = initial;
    let containerDue: number | undefined;
    for (const [index, line] of lines.entries()) {
      const event = decodeLine(line);
      state = replayLine(state, line, file, index + 1);
      if (event.kind === "prompt.requested") {
        expect(command(state, event)).toEqual({ kind: "container.start", gen: 2, fresh: true });
        containerDue = state.pending.find((p) => p.op === "container")?.due;
        expect(containerDue).toBe(event.at + deadlines.container);
      }
      if (event.kind === "container.stopped" && event.gen === 2)
        expect(event.at).toBeLessThan(containerDue ?? 0);
    }
    expect(state.phase).toBe("stopped");
  });
  it("replays a turn whose container stopped while the Session DO was away, ending it interrupted", async () => {
    // Cloudflare evicted the quiet Session DO mid-turn and stopped its container; the redial on
    // wake found it gone. The UI kept showing the reply as streaming.
    const file = "2026-09-30-idle-container-stopped.jsonl";
    const lines = (await readFile(join(logs, file), "utf8")).trim().split("\n");
    let state = initial;
    const history: (typeof SessionEvent.Type)[] = [];
    for (const [index, line] of lines.entries()) {
      history.push(decodeLine(line));
      state = replayLine(state, line, file, index + 1);
    }
    expect(state.phase).toBe("stopped");
    expect(state.stop).toEqual({ reason: "gone" });
    expect(state.currentTurn).toBe("1");
    expect(sessionView("s", state).progress.working).toBe(false);
    expect(conversationView(state, history).turns.map((turn) => turn.state)).toEqual(["aborted"]);
  });
  it("replays a queued prompt, startup timeout, resume and first turn completion", async () => {
    const file = "2026-09-30-queued-prompt-startup-timeout.jsonl";
    const lines = (await readFile(join(logs, file), "utf8")).trim().split("\n");
    let state = initial;
    for (const [index, line] of lines.entries()) {
      const event = decodeLine(line);
      state = replayLine(state, line, file, index + 1);
      if (event.kind === "prompt.requested") {
        expect(state.ready).toBe(false);
        expect(state.requests.find((request) => request.req === "s")?.status).toBe("pending");
      }
      if (event.kind === "sup.error") {
        expect(state).toMatchObject({
          phase: "failed",
          failure: { code: "timeout", retryable: true },
          currentTurn: "1",
        });
        expect(state.requests.find((request) => request.req === "s")?.status).toBe("ended");
        expect(state.turns.at(-1)?.state).toBe("interrupted");
      }
      if (event.kind === "workspace.ready")
        expect(command(state, event)).toEqual({
          kind: "prompt",
          req: "initial:2",
          turn: "1",
          text: "hello",
        });
      if (event.kind === "workspace.ready" || event.kind === "prompt.delivered") {
        expect(sessionView("s", state).progress.working).toBe(true);
        expect(state.pending.some((item) => item.op === "idle")).toBe(false);
      }
      if (event.kind === "turn.ended") {
        expect(command(state, event)).toEqual({ kind: "save", gen: 2, turn: "1", ack: 5 });
        expect(state.pending.some((item) => item.op === "save")).toBe(true);
      }
    }
    expect(state).toMatchObject({
      phase: "running",
      currentTurn: "2",
      turns: [
        { turn: "0", state: "interrupted" },
        { turn: "1", state: "completed" },
      ],
    });
    expect(state.pending.some((item) => item.op === "save")).toBe(false);
    expect(sessionView("s", state).progress.working).toBe(false);
  });
});

describe("stats from saved session event logs", () => {
  const read = async (file: string) =>
    (await readFile(join(logs, file), "utf8"))
      .trim()
      .split("\n")
      .map((line) => decodeLine(line));
  const at = (events: readonly (typeof SessionEvent.Type)[], seq: number) =>
    events.find((event) => event.seq === seq)?.at;

  it("times a run from its container.start to the container.stopped that ended it", async () => {
    const events = await read("2026-09-30-idle-container-stopped.jsonl");
    const stats = sessionStats(events);
    expect(stats).toMatchObject({ repo: "Yeshwanthyk/scotty", agentKind: "claude", live: false });
    expect(stats?.runs).toEqual([{ gen: 1, start: at(events, 2), end: at(events, 20) }]);
    expect(stats?.turns).toEqual([at(events, 20)]);
    expect(stats?.failures).toEqual([]);
  });
  it("ends a run at its failure and starts the next at the resume, left open while live", async () => {
    const events = await read("2026-09-30-queued-prompt-startup-timeout.jsonl");
    const stats = sessionStats(events);
    expect(stats?.runs).toEqual([
      { gen: 1, start: 124_000, end: 371_000 },
      { gen: 2, start: 372_000, end: null },
    ]);
    expect(stats).toMatchObject({
      live: true,
      failures: [{ at: 371_000, code: "timeout" }],
      turns: [371_000, 377_000],
    });
    if (stats === null) return;
    const now = 372_000 + 3_600_000;
    const all = repoStats([stats], "all", now);
    expect(all.total).toMatchObject({
      sessions: 1,
      runMs: 247_000 + 3_600_000,
      turns: 2,
      failed: 1,
      failureCodes: [{ key: "timeout", count: 1 }],
      running: 1,
      agents: { codex: { sessions: 1, runMs: 247_000 + 3_600_000 } },
    });
    // Seven days after the failure, only the open run's last week counts.
    const later = repoStats([stats], "7d", 371_000 + 8 * 86_400_000);
    expect(later.total).toMatchObject({ sessions: 1, runMs: 7 * 86_400_000, failed: 0, turns: 0 });
  });
  it("starts a run at the prompt that wakes a stopped session", async () => {
    const events = await read("2026-09-27-crash-kill-unnoticed.jsonl");
    const runs = sessionStats(events)?.runs ?? [];
    expect(runs[0]).toEqual({ gen: 1, start: at(events, 2), end: at(events, 31) });
    expect(runs[1]).toMatchObject({ gen: 2, start: at(events, 33) });
  });
});
