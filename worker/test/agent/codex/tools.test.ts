import { assert, it } from "@effect/vitest";
import { Result } from "effect";
import { decodeCodexNotification } from "../../../../protocol/codex-app-server";
import { makeCodexTools } from "../../../src/agent/codex/tools";

const item = (status: string, output?: string) => ({
  method: status === "inProgress" ? "item/started" : "item/completed",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: {
      type: "commandExecution",
      id: "command-1",
      command: "printf PROOF",
      status,
      cwd: "/workspace",
      commandActions: [],
      processId: null,
      aggregatedOutput: output ?? null,
      exitCode: status === "completed" ? 0 : null,
      untrustedExtra: "MUST_NOT_RETAIN",
    },
  },
});
const decode = (input: unknown) => {
  const result = decodeCodexNotification(JSON.stringify(input));
  assert.ok(Result.isSuccess(result));
  return result.success;
};
const outputDelta = (delta: string) =>
  decode({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "command-1",
      delta,
    },
  });

it("projects native command start, output and completion without excess native fields", () => {
  const tools = makeCodexTools();
  const started = decode(item("inProgress"));
  assert.notInclude(JSON.stringify(started), "MUST_NOT_RETAIN");
  tools.accept(started);
  assert.equal(tools.snapshot().tools[0]?.state, "running");
  tools.accept(outputDelta("PRO"));
  tools.accept(outputDelta("OF"));
  assert.equal(tools.snapshot().tools[0]?.output, "PROOF");
  tools.accept(decode(item("completed", "PROOF")));
  assert.deepStrictEqual(tools.snapshot(), {
    tools: [
      {
        id: "command-1",
        label: "Command",
        invocation: "printf PROOF",
        state: "completed",
        output: "PROOF",
      },
    ],
    toolsTruncated: false,
    sequence: 4,
  });
});

it("projects Hatch and evidence calls with safe labels and bounded result references", () => {
  const tools = makeCodexTools();
  tools.accept(
    decode({
      method: "turn/started",
      params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } },
    }),
  );
  tools.accept(
    decode({
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "dynamicToolCall",
          id: "hatch-1",
          tool: "scotty_hatch",
          status: "inProgress",
          arguments: { argv: ["private"] },
        },
      },
    }),
  );
  tools.acceptDynamicResult("hatch-1", "scotty-hatch:proof");
  tools.accept(
    decode({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { type: "dynamicToolCall", id: "hatch-1", tool: "scotty_hatch", status: "completed" },
      },
    }),
  );
  tools.accept(
    decode({
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "dynamicToolCall",
          id: "evidence-1",
          tool: "scotty_browser_test",
          status: "inProgress",
        },
      },
    }),
  );
  tools.acceptDynamicResult("evidence-1", "scotty-evidence:proof");
  tools.accept(
    decode({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "dynamicToolCall",
          id: "evidence-1",
          tool: "scotty_browser_test",
          status: "completed",
        },
      },
    }),
  );
  assert.deepEqual(
    tools
      .snapshot()
      .tools.map(({ label, invocation, state, output }) => ({ label, invocation, state, output })),
    [
      { label: "Hatch", invocation: "Hatch", state: "completed", output: "scotty-hatch:proof" },
      {
        label: "Browser evidence",
        invocation: "Browser evidence",
        state: "completed",
        output: "scotty-evidence:proof",
      },
    ],
  );
  assert.notInclude(JSON.stringify(tools.snapshot()), "private");
});

it("keeps ordered repeated deltas when the completion aggregate is ambiguous", () => {
  const tools = makeCodexTools();
  tools.accept(decode(item("inProgress")));
  tools.accept(outputDelta("PRO"));
  tools.accept(outputDelta("PRO"));
  tools.accept(decode(item("completed", "PRO")));
  assert.equal(tools.snapshot().tools[0]?.output, "PROPRO");
});

it("uses the completion aggregate when no output deltas arrive", () => {
  const tools = makeCodexTools();
  tools.accept(decode(item("inProgress")));
  tools.accept(decode(item("completed", "PROOF")));
  assert.equal(tools.snapshot().tools[0]?.output, "PROOF");
});

it("bounds UTF-8 output and records truncation, cancellation and a fresh turn", () => {
  const tools = makeCodexTools();
  tools.accept(decode(item("inProgress", "😀".repeat(1000))));
  assert.equal(new TextEncoder().encode(tools.snapshot().tools[0]?.output).length, 1200);
  assert.equal(tools.snapshot().toolsTruncated, true);
  tools.accept(
    decode({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "turn",
          status: "interrupted",
          items: [],
        },
      },
    }),
  );
  assert.equal(tools.snapshot().tools[0]?.state, "cancelled");
  tools.accept(
    decode({
      method: "turn/started",
      params: {
        threadId: "thread",
        turn: {
          id: "next",
          status: "inProgress",
          items: [],
        },
      },
    }),
  );
  assert.deepStrictEqual(tools.snapshot().tools, []);
  assert.equal(tools.snapshot().toolsTruncated, false);
});

it("rejects malformed command items rather than treating them as unknown item kinds", () => {
  const input = item("bogus");
  assert.ok(Result.isFailure(decodeCodexNotification(JSON.stringify(input))));
});

it("caps retained commands and preserves native failed and declined results", () => {
  const tools = makeCodexTools();
  for (let index = 0; index < 33; index++) {
    const event = item(index === 0 ? "failed" : "declined");
    event.params.item.id = `command-${index}`;
    tools.accept(decode(event));
  }
  assert.equal(tools.snapshot().tools.length, 32);
  assert.equal(tools.snapshot().toolsTruncated, true);
  assert.equal(tools.snapshot().tools[0]?.state, "failed");
  assert.equal(tools.snapshot().tools[1]?.state, "cancelled");
});
