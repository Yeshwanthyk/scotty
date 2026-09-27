/// <reference types="node" />
import { describe, expect, it } from "@effect/vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { command } from "./commands.js";
import { SessionEvent } from "./events.js";
import { fold, initial, invariants, type State } from "./fold.js";

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
});
