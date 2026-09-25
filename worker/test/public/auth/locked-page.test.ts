import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import lockedHtml from "../../../public/auth/locked.html?raw";

describe("locked browser entry page", () => {
  it("gives the operator one explicit recovery command without accepting secrets", () => {
    assert.match(lockedHtml, /Browser access is locked/u);
    assert.match(lockedHtml, /<code>scotty owner recover<\/code>/u);
    assert.match(lockedHtml, /installation secret stays with the CLI/u);
    assert.doesNotMatch(lockedHtml, /<script|<form|<input|<textarea/iu);
    assert.doesNotMatch(
      lockedHtml,
      /scotty_recovery\.|authorization\s*:|bearer\s+|__Host-scotty|token=|credential=/iu,
    );
  });
});
