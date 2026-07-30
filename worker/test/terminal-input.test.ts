import { assert, describe, it, vi } from "vitest";
import {
  composerText,
  sendTerminalKey,
  submitComposer,
  terminalKeySequence,
} from "../public/terminal-input.js";

describe("mobile terminal input", () => {
  it("preserves visible prompt text while normalizing browser line endings", () => {
    assert.strictEqual(composerText("  fix this\r\nthen test  "), "  fix this\nthen test  ");
    assert.isUndefined(composerText(" \r\n\t "));
    assert.isUndefined(composerText(undefined));
  });

  it("submits the prompt as one paste followed by a user Enter", () => {
    const terminal = {
      paste: vi.fn(),
      input: vi.fn(),
    };

    assert.isTrue(submitComposer(terminal, "fix this\r\nthen test"));
    assert.deepEqual(terminal.paste.mock.calls, [["fix this\nthen test"]]);
    assert.deepEqual(terminal.input.mock.calls, [["\r", true]]);
  });

  it("does not submit an empty prompt", () => {
    const terminal = {
      paste: vi.fn(),
      input: vi.fn(),
    };

    assert.isFalse(submitComposer(terminal, " \n "));
    assert.isEmpty(terminal.paste.mock.calls);
    assert.isEmpty(terminal.input.mock.calls);
  });

  it("maps accessory controls to terminal input without writing the canvas directly", () => {
    const terminal = {
      paste: vi.fn(),
      input: vi.fn(),
    };

    assert.strictEqual(terminalKeySequence("escape"), "\u001b");
    assert.strictEqual(terminalKeySequence("ctrl-c"), "\u0003");
    assert.strictEqual(terminalKeySequence("arrow-up"), "\u001b[A");
    assert.isUndefined(terminalKeySequence("unknown"));
    assert.isTrue(sendTerminalKey(terminal, "tab"));
    assert.deepEqual(terminal.input.mock.calls, [["\t", true]]);
    assert.isFalse(sendTerminalKey(terminal, "unknown"));
  });
});
