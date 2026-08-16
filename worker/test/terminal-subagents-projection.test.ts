import { assert, describe, it } from "vitest";
import {
  snapshotForWidget,
  subagentCountLabel,
  subagentElapsed,
  subagentModelLabel,
  subagentTranscriptTail,
} from "../public/terminal-subagents-projection.js";

const child = {
  id: "child-1",
  backend: "pi",
  title: "Inspect files",
  status: "running",
  model: "openai/gpt",
  reasoningEffort: "high",
  prompt: "Inspect the repository",
  output: "Still working",
  transcript: [
    { kind: "user", text: "Inspect the repository" },
    { kind: "thinking", text: "Reasoning" },
    { kind: "tool", name: "read", output: "README.md" },
  ],
  tools: [],
  queued: [{ kind: "follow-up", text: "Summarize" }],
  startedAt: 1_000,
  lastActivityAt: 2_000,
} as const;

const snapshot = { version: 1, revision: 2, generatedAt: 2_000, children: [child] } as const;

describe("terminal subagent projection", () => {
  it("accepts the bounded widget shape and rejects malformed trusted state", () => {
    assert.deepStrictEqual(snapshotForWidget(JSON.stringify(snapshot)), snapshot);
    assert.isUndefined(snapshotForWidget({ ...snapshot, extra: "untrusted" }));
    assert.isUndefined(
      snapshotForWidget({
        ...snapshot,
        children: [{ ...child, tools: [{ name: "x", startedAt: "bad", updatedAt: 1 }] }],
      }),
    );
  });

  it("projects count, model, elapsed time, and transcript tail without reasoning expansion", () => {
    assert.strictEqual(subagentCountLabel(1), "1 subagent working");
    assert.strictEqual(subagentModelLabel(child), "openai/gpt · effort high");
    assert.strictEqual(subagentElapsed(child, 62_000), "1m 1s");
    assert.include(subagentTranscriptTail(child), "[Tool: read — README.md]");
    assert.notInclude(subagentTranscriptTail(child), "Reasoning");
  });
});
