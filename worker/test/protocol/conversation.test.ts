import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  CanonicalConversationTurnSchema,
  decodeCanonicalConversationSnapshotSync,
} from "../../../protocol/session/conversation";
import { decodeAgentSelection } from "../../../protocol/agents/agent-selection";

const decodeTurn = Schema.decodeUnknownResult(CanonicalConversationTurnSchema, {
  onExcessProperty: "error",
});
describe("public agent and conversation schemas", () => {
  for (const state of ["completed", "streaming", "failed", "aborted"]) {
    it(`accepts the honest ${state} turn state`, () => {
      assert.isTrue(
        Result.isSuccess(
          decodeTurn({ id: "turn-1", state, user: "prompt", assistant: "", tools: [] }),
        ),
      );
    });
  }
  it("decodes producer payloads with 101 turns, 53 tools, and full UTF-8 values", () => {
    const tools = Array.from({ length: 53 }, (_, index) => ({
      id: `tool-${index}`,
      state: "completed" as const,
      label: `Tool ${index}`,
      invocation: "界".repeat(2_000),
      output: "🚀".repeat(2_000),
    }));
    const turns = Array.from({ length: 101 }, (_, index) => ({
      id: `turn-${index}`,
      state: "completed" as const,
      user: "é".repeat(20_000),
      assistant: "🙂".repeat(20_000),
      tools: index === 100 ? tools : [],
    }));
    const value = {
      version: 1 as const,
      transport: { epoch: "epoch-1", baseSequence: 0, sequence: 1, sessionRevision: 1 },
      turns,
      queue: { steer: [], followUp: [] },
      truncated: { turns: false, values: false },
    };

    assert.deepStrictEqual(decodeCanonicalConversationSnapshotSync(value), value);
  });

  it("accepts long conversation text and rejects invented terminal states", () => {
    for (const state of ["interrupted", "successful", "unknown"])
      assert.isTrue(
        Result.isFailure(
          decodeTurn({ id: "turn-1", state, user: "prompt", assistant: "", tools: [] }),
        ),
      );
    assert.isTrue(
      Result.isSuccess(
        decodeTurn({
          id: "turn-1",
          state: "failed",
          user: "prompt",
          assistant: "😀".repeat(4097),
          tools: [],
        }),
      ),
    );
  });
  it("requires a supported explicit Codex pair without changing Pi selection", () => {
    assert.isTrue(Result.isSuccess(decodeAgentSelection({ agent: "pi" })));
    assert.isTrue(Result.isSuccess(decodeAgentSelection({ agent: "pi", model: "gpt-5.4" })));
    assert.isTrue(Result.isSuccess(decodeAgentSelection({ agent: "pi", effort: "max" })));
    assert.isTrue(
      Result.isSuccess(decodeAgentSelection({ agent: "pi", modelProvider: "openai-codex" })),
    );
    assert.isTrue(
      Result.isSuccess(decodeAgentSelection({ agent: "codex", model: "gpt-5.4", effort: "high" })),
    );
    for (const value of [
      { agent: "codex" },
      { agent: "codex", model: "gpt-5.4", effort: "ultra" },
      { agent: "codex", model: "invented-model", effort: "high" },
      { agent: "pi", effort: "ultra" },
      { agent: "pi", model: "" },
      { agent: "pi", modelProvider: " leading-space" },
    ])
      assert.isTrue(Result.isFailure(decodeAgentSelection(value)));
  });
});
