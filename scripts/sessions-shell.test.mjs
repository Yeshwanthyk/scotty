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
const terminalHtml = await readFile(
  new URL("../worker/public/terminal.html", import.meta.url),
  "utf8",
);
const terminalScript = await readFile(
  new URL("../worker/public/terminal.js", import.meta.url),
  "utf8",
);
const terminalStyles = await readFile(
  new URL("../worker/public/terminal.css", import.meta.url),
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

  it("ships the approved project ledger and Home-only lifecycle controls", () => {
    assert.match(
      sessionsHtml,
      /id="session-title"[\s\S]*?name="title"[\s\S]*?maxlength="120"[\s\S]*?required/,
    );
    assert.match(
      sessionsHtml,
      /if \(status === "warm"[\s\S]*?rowLink\.className = "session-row-link"/,
    );
    assert.match(sessionsHtml, /sleeping\.className = "sleeping-group"/);
    assert.match(sessionsHtml, /actionButton\("Resume & open", "resume"/);
    assert.match(sessionsHtml, /method: "PATCH"/);
    assert.doesNotMatch(sessionsHtml, /Running tests|Editing terminal\.js|agent activity/i);
  });

  it("ships project-grouped desktop and mobile warm-session navigation", () => {
    assert.match(terminalHtml, /class="workspace-rail"/);
    assert.match(terminalHtml, /class="workspace-picker"/);
    assert.match(terminalHtml, /Sleeping containers only appear on Home\./);
    assert.match(terminalScript, /sessions\.filter\(\(session\) => session\?\.status === "warm"\)/);
    assert.match(terminalScript, /groupSessionsByRepository\(warm\)/);
    assert.doesNotMatch(terminalScript, /\/resume|resumeScottySession|status === "sleeping"/);
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.workspace-rail\s*\{[\s\S]*?position: fixed;[\s\S]*?inset: auto 0 0;/,
    );
  });
});
