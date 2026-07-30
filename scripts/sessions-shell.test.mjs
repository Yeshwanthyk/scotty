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
const terminalTimeline = await readFile(
  new URL("../worker/public/terminal-timeline.js", import.meta.url),
  "utf8",
);
const terminalMarkdown = await readFile(
  new URL("../worker/public/terminal-markdown.js", import.meta.url),
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
    assert.match(terminalHtml, /class="home-link" href="\/sessions">Sessions Home<\/a>/);
    assert.doesNotMatch(terminalHtml, /Sleeping containers only appear on Home\./);
    assert.match(terminalScript, /sessions\.filter\(\(session\) => session\?\.status === "warm"\)/);
    assert.match(terminalScript, /groupSessionsByRepository\(warm\)/);
    assert.match(terminalScript, /function visibleWorkspaceSignature\(groups\)/);
    assert.match(
      terminalScript,
      /if \(signature === workspaceListSignature\)[\s\S]*?workspaceList\.replaceChildren\(\)/,
    );
    assert.match(
      terminalScript,
      /if \(!nextSessions\.some\(\(session\) => session\?\.id === currentSessionId\)\)[\s\S]*?`\/api\/sessions\/\$\{encodeURIComponent\(currentSessionId\)\}`[\s\S]*?nextSessions = \[current, \.\.\.nextSessions\]/,
      "a just-created current session must appear before its list projection converges",
    );
    assert.doesNotMatch(terminalScript, /\/resume|resumeScottySession|status === "sleeping"/);
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.workspace-rail\s*\{[\s\S]*?position: fixed;[\s\S]*?inset: auto 0 0;/,
    );
  });

  it("ships the native Pi worklog, live RPC projection, and one responsive composer", () => {
    assert.match(terminalHtml, /id="worklog"[\s\S]*?id="worklog-feed"/);
    assert.match(terminalHtml, /id="activity-drawer"/);
    assert.match(
      terminalHtml,
      /id="runtime-menu"[\s\S]*?id="model-select"[\s\S]*?id="thinking-select"/,
    );
    assert.match(terminalHtml, /id="runtime-controls"[\s\S]*?id="runtime-model-label"/);
    assert.match(
      terminalHtml,
      /class="composer-shell"[\s\S]*?id="delivery-receipts"[\s\S]*?<form id="composer" class="composer"[\s\S]*?id="composer-input"[\s\S]*?rows="2"/,
    );
    assert.match(terminalScript, /rpcUrl\(sessionId, "snapshot"\)/);
    assert.match(terminalScript, /rpcUrl\(sessionId, "events"\)/);
    assert.match(terminalScript, /rpcUrl\(currentSessionId, "command"\)/);
    assert.match(terminalScript, /new EventSource\(url\)/);
    assert.match(terminalScript, /window\.history\.pushState/);
    assert.match(terminalScript, /window\.addEventListener\("popstate"/);
    assert.match(terminalScript, /const sessionCache = new Map\(\)/);
    assert.match(
      terminalScript,
      /import \{[\s\S]*?conversationItems,[\s\S]*?\} from "\/terminal-timeline\.js"/,
    );
    assert.match(
      terminalScript,
      /import \{ assistantMarkdownFragment \} from "\/terminal-markdown\.js"/,
    );
    assert.match(terminalScript, /body\.append\(renderAssistantCopy\(text\)\)/);
    assert.match(
      terminalScript,
      /function renderUserMessage\([\s\S]*?textElement\("div", "message-copy", text\)/,
    );
    assert.match(
      terminalScript,
      /function renderSystemMessage\([\s\S]*?textElement\("div", "message-copy", text\)/,
    );
    assert.match(terminalTimeline, /export function conversationItems\(messages\)/);
    assert.match(terminalMarkdown, /export function assistantMarkdownFragment\(/);
    assert.match(terminalMarkdown, /document\.createTextNode\(descriptor\)/);
    assert.doesNotMatch(terminalMarkdown, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.match(
      terminalStyles,
      /\.message-copy\.markdown\s*\{[\s\S]*?white-space:\s*normal;/,
    );
    assert.match(
      terminalStyles,
      /\.markdown-table-wrap\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-x:\s*auto;/,
    );
    assert.match(
      terminalScript,
      /function renderActivityFold\(reasoningParts, tools, active, conversationKey\)/,
    );
    assert.match(
      terminalScript,
      /function applyDisclosureState\(details, key, defaultOpen = false\)/,
    );
    assert.doesNotMatch(terminalScript, /function renderStandaloneTool/);
    assert.match(
      terminalScript,
      /type: "set_model"[\s\S]*?provider: selected\.provider[\s\S]*?modelId:/,
    );
    assert.match(terminalScript, /sendCommand\(\{ type: "set_thinking_level", level \}\)/);
    assert.match(
      terminalScript,
      /const streamingBehavior = deliveryMode === "steer" \? "steer" : "followUp";[\s\S]*?sendCommand\(\{ type: "prompt", message: text, streamingBehavior \}\)/,
      "prompt delivery must let Pi atomically start or queue instead of racing a stale snapshot",
    );
    assert.doesNotMatch(terminalScript, /active \? deliveryMode : "prompt"/);
    assert.doesNotMatch(terminalScript, /ghostty|new WebSocket|\/terminal["'`]/u);
    assert.match(
      terminalStyles,
      /\.composer-shell\s*\{[\s\S]*?linear-gradient[\s\S]*?\.composer\s*\{[\s\S]*?max-width:\s*820px;/,
      "composer must preserve the approved outer fade and inner card structure",
    );
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.composer textarea\s*\{[\s\S]*?font-size:\s*16px;/,
      "mobile composer text must not trigger iOS focus zoom",
    );
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.quiet-button,[\s\S]*?\.send-button\s*\{[\s\S]*?min-height:\s*44px;/,
      "mobile composer controls need touch-sized targets",
    );
    assert.match(
      terminalStyles,
      /\.worklog-turn\.user \.turn-body\s*\{[\s\S]*?max-width:\s*min\(80%, 720px\);[\s\S]*?border-radius:\s*14px 14px 4px;/,
      "user messages should read as compact right-aligned turns",
    );
    assert.match(terminalStyles, /\.turn-activity > summary\s*\{/);
    assert.match(
      terminalStyles,
      /@media \(max-width: 780px\)[\s\S]*?\.runtime-menu-inner\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
      "runtime controls should remain usable in the mobile composer",
    );
    assert.doesNotMatch(
      terminalStyles,
      /\.workspace-link\[aria-current="page"\]\s*\{[^}]*box-shadow:/,
      "the current session should use a quiet fill instead of an accent rail",
    );
  });
});
