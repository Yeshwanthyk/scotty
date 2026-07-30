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
const ghosttyWeb = await readFile(
  new URL("../worker/public/vendor/ghostty-web.js", import.meta.url),
  "utf8",
);
const sessionForm = await readFile(
  new URL("../worker/public/session-form.js", import.meta.url),
  "utf8",
);
const statsHtml = await readFile(new URL("../worker/public/stats.html", import.meta.url), "utf8");
const statsScript = await readFile(new URL("../worker/public/stats.js", import.meta.url), "utf8");
const statsStyles = await readFile(new URL("../worker/public/stats.css", import.meta.url), "utf8");
const statsView = await readFile(
  new URL("../worker/public/stats-view.js", import.meta.url),
  "utf8",
);
const contracts = await readFile(new URL("../worker/src/contracts.ts", import.meta.url), "utf8");

describe("sessions shell", () => {
  it("ships one production header contract across app pages", () => {
    for (const html of [sessionsHtml, statsHtml, providersHtml, devicesHtml]) {
      assert.match(html, /<body class="scotty-ui app-page /);
      assert.match(html, /<header class="masthead">/);
      assert.match(html, /<nav class="masthead-nav" aria-label="Primary navigation">/);
      assert.match(html, /<details class="mobile-utilities"/);
      assert.doesNotMatch(html, /class="section-label"/);
      assert.doesNotMatch(html, /UI PROTOTYPE/);
    }

    assert.match(sessionsHtml, /href="\/providers"/);
    assert.match(sessionsHtml, /href="\/devices"/);
    assert.match(sessionsHtml, /href="\/stats"/);
    assert.match(sessionsHtml, /id="new-session"/);
    assert.match(statsHtml, /href="\/sessions"/);
    assert.match(providersHtml, /href="\/sessions"[\s\S]*?href="\/devices"/);
    assert.match(providersHtml, /href="\/stats"/);
    assert.match(devicesHtml, /href="\/sessions"[\s\S]*?href="\/providers"/);
    assert.match(devicesHtml, /href="\/stats"/);

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

  it("ships sessions-only keyboard navigation for visible, openable rows", () => {
    assert.match(sessionsHtml, /document\.addEventListener\("keydown"/);
    assert.match(
      sessionsHtml,
      /event\.defaultPrevented[\s\S]*?event\.isComposing[\s\S]*?!event\.metaKey[\s\S]*?event\.ctrlKey[\s\S]*?event\.altKey[\s\S]*?event\.shiftKey/,
    );
    assert.match(sessionsHtml, /target\.matches\("input, textarea, select"\)/);
    assert.match(sessionsHtml, /target\.isContentEditable/);
    assert.match(
      sessionsHtml,
      /querySelectorAll\("\.session-row-link"\)[\s\S]*?getClientRects\(\)\.length > 0/,
    );
    assert.match(sessionsHtml, /sessionKeyboardAction\([\s\S]*?event\.key/);
    assert.match(sessionsHtml, /action\.type === "open"[\s\S]*?sessionLink\.click\(\)/);
    assert.match(sessionsHtml, /else sessionLink\.focus\(\)/);
    assert.doesNotMatch(terminalHtml + terminalScript, /sessionKeyboardAction/);
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

  it("ships only the V1 stats values with loading, empty, and error states", () => {
    assert.equal(statsHtml.match(/data-stat=/g)?.length, 4);
    for (const label of ["Workspaces created", "Projects", "Warm now", "Sleeping now"]) {
      assert.match(statsHtml, new RegExp(`>${label}<`));
    }
    for (const label of ["Workspaces created", "Warm now", "Sleeping now", "Last created"]) {
      assert.match(statsScript, new RegExp(`\\["${label}"`));
    }
    assert.match(statsHtml, /Loading tracking history/);
    assert.match(statsScript, /Tracking starts with your next workspace/);
    assert.match(statsScript, /Stats could not be loaded/);
    assert.match(statsScript, /fetch\("\/api\/stats"/);
    assert.match(statsView, /Number\.isSafeInteger/);
    assert.match(statsStyles, /@media \(max-width: 760px\)/);
    assert.doesNotMatch(statsHtml + statsScript, /chart|date filter|launch success|token|cost/i);
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

  it("keeps terminal geometry and scrollback usable across viewport changes", () => {
    assert.match(
      terminalScript,
      /socketUrl\.searchParams\.set\("cols", String\(terminal\.cols\)\)/,
    );
    assert.match(
      terminalScript,
      /socketUrl\.searchParams\.set\("rows", String\(terminal\.rows\)\)/,
    );
    assert.match(terminalScript, /addEventListener\("touchstart"/);
    assert.match(terminalScript, /addEventListener\("touchmove"/);
    assert.match(terminalScript, /fitAddon\.observeResize\(\)/);
    assert.match(
      terminalScript,
      /terminal\.getViewportY\(\)[\s\S]*?terminal\.getScrollbackLength\(\)/,
    );
    assert.match(terminalStyles, /\.terminal\s*\{[\s\S]*?touch-action:\s*none;/);
  });

  it("ships responsive mobile input with immediate visible composition", () => {
    assert.match(ghosttyWeb, /addEventListener\("beforeinput", this\.beforeInputListener\)/);
    assert.match(ghosttyWeb, /this\.awaitingEcho = !0/);
    assert.match(terminalHtml, /id="mobile-composer"[\s\S]*?id="mobile-composer-input"/);
    assert.match(terminalHtml, /enterkeyhint="send"/);
    assert.match(terminalHtml, /data-terminal-key="ctrl-c"/);
    assert.match(terminalHtml, /data-terminal-key="arrow-up"/);
    assert.match(terminalScript, /submitComposer\(terminal, mobileComposerInput\.value\)/);
    assert.match(terminalScript, /mobileComposerInput\.addEventListener\("beforeinput"/);
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.mobile-composer\s*\{[\s\S]*?display: grid;/,
    );
    assert.match(
      terminalStyles,
      /\.mobile-composer-input\s*\{[\s\S]*?font-size:\s*16px;/,
      "mobile composer text must not trigger iOS focus zoom",
    );
    assert.match(
      terminalStyles,
      /\.mobile-terminal-key[\s\S]*?min-height:\s*44px;/,
      "mobile terminal keys need touch-sized targets",
    );
  });

  it("keeps the Ghostty canvas backing size scaled for high-density displays", () => {
    assert.match(
      ghosttyWeb,
      /this\.canvas\.width = g \* this\.devicePixelRatio/,
      "the renderer must allocate DPR-scaled backing pixels",
    );
    assert.equal(
      ghosttyWeb.match(/this\.canvas\.width\s*=/gu)?.length,
      1,
      "terminal resize must not overwrite the renderer's DPR-scaled canvas width",
    );
  });
});
