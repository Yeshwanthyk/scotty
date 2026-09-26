/// <reference types="node" />
import { describe, expect, it } from "@effect/vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { decodeSessionEvent, SessionEvent } from "./events.js";
import { fold, initial, invariants, type State } from "./fold.js";

const logs = join(process.cwd(), "e2e", "logs");
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(SessionEvent));

const replayLine = (state: State, text: string, file: string, line: number): State => {
  let event: SessionEvent;
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
      const lines = content.split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.trim().length === 0) continue;
        state = replayLine(state, line, file, index + 1);
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
      title: "test",
      prompt: "go",
      image: "image",
    });
    const state = replayLine(initial, row, "repeat.jsonl", 1);
    expect(() => replayLine(state, row, "repeat.jsonl", 2)).toThrow("repeat.jsonl:2");
  });
  it("replays a socket drop and resumes after the last acknowledged notification", () => {
    const rows: unknown[] = [
      {
        seq: 1,
        at: 1,
        src: "api",
        kind: "created",
        agentKind: "codex",
        repo: "https://example.org/public",
        baseBranch: "main",
        title: "test",
        prompt: "go",
        image: "image",
      },
      { seq: 2, at: 2, src: "do", kind: "container.start", gen: 1 },
      { seq: 3, at: 3, src: "sup", kind: "sup.hello", gen: 1, version: "v1" },
      { seq: 4, at: 4, src: "sup", kind: "workspace.ready", gen: 1, branch: "main", commit: "abc" },
      {
        seq: 5,
        at: 5,
        src: "sup",
        kind: "agent.event",
        agentKind: "codex",
        gen: 1,
        n: 7,
        event: { opaque: true },
      },
      { seq: 6, at: 6, src: "do", kind: "socket.closed", gen: 1 },
      { seq: 7, at: 7, src: "do", kind: "sup.redial", gen: 1 },
      { seq: 8, at: 8, src: "sup", kind: "sup.hello", gen: 1, version: "v1" },
      {
        seq: 9,
        at: 9,
        src: "sup",
        kind: "agent.event",
        agentKind: "codex",
        gen: 1,
        n: 7,
        event: { duplicate: true },
      },
      {
        seq: 10,
        at: 10,
        src: "sup",
        kind: "agent.event",
        agentKind: "codex",
        gen: 1,
        n: 8,
        event: { new: true },
      },
    ];
    let state = initial;
    for (const row of rows) {
      state = fold(state, decodeSessionEvent(row));
      expect(invariants(state)).toEqual([]);
    }
    expect(state.lastN).toBe(8);
  });
});
