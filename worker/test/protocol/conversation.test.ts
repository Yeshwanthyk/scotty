import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { CanonicalConversationTurnSchema } from "../../../protocol/conversation";
import { decodeAgentSelection } from "../../../protocol/agent-selection";

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
  it("retains strict text bounds and rejects invented terminal states", () => {
    for (const state of ["interrupted", "successful", "unknown"])
      assert.isTrue(
        Result.isFailure(
          decodeTurn({ id: "turn-1", state, user: "prompt", assistant: "", tools: [] }),
        ),
      );
    assert.isTrue(
      Result.isFailure(
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
