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

it("projects native command start, output and completion without excess native fields", () => {
  const tools = makeCodexTools();
  const started = decode(item("inProgress"));
  assert.notInclude(JSON.stringify(started), "MUST_NOT_RETAIN");
  tools.accept(started);
  assert.equal(tools.snapshot().tools[0]?.state, "running");
  tools.accept(
    decode({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "command-1",
        delta: "PRO",
      },
    }),
  );
  assert.equal(tools.snapshot().tools[0]?.output, "PRO");
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
    sequence: 3,
  });
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
