import { assert, describe, it } from "vitest";
import {
  mobileKeyData,
  sgrMouse,
  terminalCell,
  terminalFontSize,
  terminalPrompt,
  wheelButton,
  wheelSteps,
} from "../public/terminal-input.js";

describe("terminal input", () => {
  it("maps browser coordinates into clamped one-based terminal cells", () => {
    const bounds = { left: 10, top: 20, width: 800, height: 400 };
    assert.deepStrictEqual(terminalCell(bounds, 80, 20, 10, 20), { x: 1, y: 1 });
    assert.deepStrictEqual(terminalCell(bounds, 80, 20, 410, 220), { x: 41, y: 11 });
    assert.deepStrictEqual(terminalCell(bounds, 80, 20, 900, 500), { x: 80, y: 20 });
  });

  it("encodes SGR mouse presses, releases, and wheel direction", () => {
    assert.strictEqual(sgrMouse(64, { x: 7, y: 9 }), "\x1b[<64;7;9M");
    assert.strictEqual(sgrMouse(0, { x: 7, y: 9 }, true), "\x1b[<0;7;9m");
    assert.strictEqual(wheelButton(-1), 64);
    assert.strictEqual(wheelButton(1), 65);
  });

  it("normalizes trackpad and touch deltas without flooding the PTY", () => {
    assert.strictEqual(wheelSteps(0), 0);
    assert.strictEqual(wheelSteps(4), 1);
    assert.strictEqual(wheelSteps(-64), 2);
    assert.strictEqual(wheelSteps(1_000), 5);
  });

  it("exposes one-tap mobile terminal controls", () => {
    assert.deepStrictEqual(mobileKeyData, {
      escape: "\x1b",
      tab: "\t",
      interrupt: "\x03",
      enter: "\r",
    });
  });

  it("keeps composed prompts intact while rejecting empty submissions", () => {
    assert.strictEqual(terminalPrompt("  \n"), undefined);
    assert.strictEqual(terminalPrompt(" fix this\r\nthen test "), " fix this\nthen test ");
  });

  it("keeps persisted terminal text readable on a phone", () => {
    assert.strictEqual(terminalFontSize(undefined), 14);
    assert.strictEqual(terminalFontSize("15"), 15);
    assert.strictEqual(terminalFontSize(6), 12);
    assert.strictEqual(terminalFontSize(24), 18);
    assert.strictEqual(terminalFontSize("not-a-number", 13), 13);
  });
});
