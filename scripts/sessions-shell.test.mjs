import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const sessionsHtml = await readFile(
  new URL("../worker/public/sessions.html", import.meta.url),
  "utf8",
);
const sharedStyles = await readFile(
  new URL("../worker/public/scotty-ui.css", import.meta.url),
  "utf8",
);

describe("sessions shell", () => {
  it("ships the approved production header instead of prototype-only chrome", () => {
    assert.match(sessionsHtml, /<header class="masthead">/);
    assert.match(sessionsHtml, /href="\/providers"/);
    assert.match(sessionsHtml, /href="\/devices"/);
    assert.match(sessionsHtml, /id="new-session"/);
    assert.doesNotMatch(sessionsHtml, /UI PROTOTYPE/);

    assert.match(
      sessionsHtml,
      /\.masthead-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-height:\s*calc\(60px \+ env\(safe-area-inset-top\)\);/,
    );
    assert.match(
      sessionsHtml,
      /padding:\s*env\(safe-area-inset-top\) max\(24px, env\(safe-area-inset-right\)\) 0\s*max\(24px, env\(safe-area-inset-left\)\);/,
    );
    assert.match(
      sessionsHtml,
      /\.masthead-actions > \.button-primary\s*\{[\s\S]*?min-height:\s*40px;/,
    );
    assert.match(
      sharedStyles,
      /\.sessions-page \.masthead\s*\{[\s\S]*?background:\s*rgb\(3 16 23 \/ 0\.94\);[\s\S]*?backdrop-filter:\s*blur\(16px\);/,
    );
  });
});
