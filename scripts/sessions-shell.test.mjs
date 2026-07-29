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
const providersHtml = await readFile(
  new URL("../worker/public/providers.html", import.meta.url),
  "utf8",
);
const providersStyles = await readFile(
  new URL("../worker/public/providers.css", import.meta.url),
  "utf8",
);
const devicesHtml = await readFile(
  new URL("../worker/public/devices.html", import.meta.url),
  "utf8",
);
const devicesStyles = await readFile(
  new URL("../worker/public/devices.css", import.meta.url),
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
const sessionForm = await readFile(
  new URL("../worker/public/session-form.js", import.meta.url),
  "utf8",
);
const contracts = await readFile(new URL("../worker/src/contracts.ts", import.meta.url), "utf8");

describe("sessions shell", () => {
  it("ships one production header contract across app pages", () => {
    for (const html of [sessionsHtml, providersHtml, devicesHtml]) {
      assert.match(html, /<body class="scotty-ui app-page /);
      assert.match(html, /<header class="masthead">/);
      assert.match(html, /<nav class="masthead-nav" aria-label="Primary navigation">/);
      assert.match(html, /<details class="mobile-utilities"/);
      assert.doesNotMatch(html, /class="section-label"/);
      assert.doesNotMatch(html, /UI PROTOTYPE/);
    }

    assert.match(sessionsHtml, /href="\/providers"/);
    assert.match(sessionsHtml, /href="\/devices"/);
    assert.match(sessionsHtml, /id="new-session"/);
    assert.match(providersHtml, /href="\/sessions"[\s\S]*?href="\/devices"/);
    assert.match(devicesHtml, /href="\/sessions"[\s\S]*?href="\/providers"/);

    assert.match(
      sharedStyles,
      /\.app-page \.masthead-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-height:\s*calc\(60px \+ env\(safe-area-inset-top\)\);/,
    );
    assert.match(
      sharedStyles,
      /padding:\s*env\(safe-area-inset-top\) max\(24px, env\(safe-area-inset-right\)\) 0\s*max\(24px, env\(safe-area-inset-left\)\);/,
    );
    assert.match(
      sharedStyles,
      /\.masthead-actions > \.button-primary\s*\{[\s\S]*?min-height:\s*40px;/,
    );
    assert.match(
      sharedStyles,
      /\.app-page \.masthead\s*\{[\s\S]*?background:\s*rgb\(3 16 23 \/ 0\.94\);[\s\S]*?backdrop-filter:\s*blur\(16px\);/,
    );
    assert.doesNotMatch(providersStyles, /\.masthead-inner/);
    assert.doesNotMatch(devicesStyles, /\.masthead-inner/);
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

  it("requires real session titles without a repository or ID display fallback", () => {
    assert.match(
      contracts,
      /SessionRecordSchema = Schema\.Struct\(\{[\s\S]*?title: Schema\.String/,
    );
    assert.match(
      contracts,
      /SessionProjectionSchema = Schema\.Struct\(\{[\s\S]*?title: Schema\.String/,
    );
    assert.match(
      contracts,
      /CreateSessionInputSchema = Schema\.Struct\(\{[\s\S]*?title: Schema\.String/,
    );
    assert.match(sessionForm, /return titleText\(session\.title\) \|\| "";/);
    assert.doesNotMatch(sessionForm, /session\.repo|session\.id|`Session \$\{/);
  });

  it("ships project-grouped desktop and mobile warm-session navigation", () => {
    assert.match(terminalHtml, /class="workspace-rail"/);
    assert.match(terminalHtml, /class="workspace-picker"/);
    assert.match(terminalHtml, /class="home-link" href="\/sessions">Home<\/a>/);
    assert.doesNotMatch(terminalHtml, /Sleeping containers only appear on Home\./);
    assert.match(terminalScript, /sessions\.filter\(\(session\) => session\?\.status === "warm"\)/);
    assert.match(terminalScript, /groupSessionsByRepository\(warm\)/);
    assert.match(terminalScript, /function visibleWorkspaceSignature\(groups\)/);
    assert.match(
      terminalScript,
      /if \(signature !== workspaceListSignature\) \{[\s\S]*?workspaceList\.replaceChildren\(\)/,
    );
    assert.doesNotMatch(terminalScript, /\/resume|resumeScottySession|status === "sleeping"/);
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.workspace-rail\s*\{[\s\S]*?position: fixed;[\s\S]*?inset: auto 0 0;/,
    );
  });
});
