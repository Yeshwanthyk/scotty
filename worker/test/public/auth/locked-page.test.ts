import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import lockedHtml from "../../../public/auth/locked.html?raw";
const authStyles = readFileSync("worker/public/auth/styles.css", "utf8");

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

  it("uses the existing restrained auth surface at desktop and mobile sizes", () => {
    assert.match(lockedHtml, /class="auth-card locked-card"/u);
    assert.match(lockedHtml, /class="recovery-command"/u);
    assert.match(authStyles, /\.recovery-command/u);
    assert.match(authStyles, /\.locked-steps/u);
    assert.match(authStyles, /@media \(max-width: 620px\)/u);
  });
});
