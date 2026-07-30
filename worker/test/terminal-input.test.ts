import { assert, describe, it } from "vitest";
import { composerText, hasAvailableRuntime } from "../public/terminal-input.js";

describe("Pi worklog composer input", () => {
  it("preserves visible prompt text while normalizing browser line endings", () => {
    assert.strictEqual(composerText("  fix this\r\nthen test  "), "  fix this\nthen test  ");
    assert.isUndefined(composerText(" \r\n\t "));
    assert.isUndefined(composerText(undefined));
  });

  it("keeps the runtime unavailable until Pi advertises a model", () => {
    assert.isFalse(hasAvailableRuntime(undefined));
    assert.isFalse(
      hasAvailableRuntime({
        state: { model: { id: "unknown" }, thinkingLevel: "off" },
        capabilities: { models: [], thinkingLevels: ["off"] },
      }),
    );
    assert.isTrue(
      hasAvailableRuntime({
        capabilities: {
          models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        },
      }),
    );
  });
});
