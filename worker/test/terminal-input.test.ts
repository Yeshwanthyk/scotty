import { assert, describe, it } from "vitest";
import { composerText } from "../public/terminal-input.js";

describe("Pi worklog composer input", () => {
  it("preserves visible prompt text while normalizing browser line endings", () => {
    assert.strictEqual(composerText("  fix this\r\nthen test  "), "  fix this\nthen test  ");
    assert.isUndefined(composerText(" \r\n\t "));
    assert.isUndefined(composerText(undefined));
  });
});
