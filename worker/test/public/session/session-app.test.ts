import { assert, describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import appSource from "../../../public/session/index.js?raw";
import sessionHtml from "../../../public/session/index.html?raw";

const sessionCss = readFileSync(
  new URL("../../../public/session/styles.css", import.meta.url),
  "utf8",
);

describe("cloud-agent session application", () => {
  it("wires one semantic shell to the focused native modules", () => {
    assert.include(sessionHtml, '<aside id="agent-sidebar"');
    assert.include(sessionHtml, '<main class="agent-workspace">');
    assert.include(sessionHtml, '<section id="transcript"');
    assert.include(sessionHtml, '<form id="composer"');
    assert.include(sessionHtml, '<script type="module" src="/session/index.js"></script>');
    assert.include(appSource, 'from "./cloud-agents.js"');
    assert.include(appSource, 'from "./pi-connection.js"');
    assert.include(appSource, 'from "./chat.js"');
    assert.include(appSource, 'from "./summary.js"');
    assert.include(sessionHtml, '<aside id="summary-panel"');
    assert.include(sessionHtml, '<div id="summary-content"');
    assert.include(sessionHtml, 'aria-controls="summary-panel"');
    assert.notInclude(sessionHtml, "subagent");
    assert.notInclude(sessionHtml, "workflow");
  });

  it("keeps only drafts and scroll positions across agent switches", () => {
    assert.include(appSource, "const memory = new Map()");
    assert.include(appSource, 'entry = { draft: "", scrollTop: 0 }');
    assert.include(appSource, "connection.open(sessionId)");
    assert.include(appSource, "window.history.pushState");
    assert.include(appSource, 'window.addEventListener("popstate"');
    assert.notInclude(appSource, "localStorage");
    assert.notInclude(appSource, "sessionStorage");
    assert.notInclude(appSource, "prefetch");
  });

  it("provides fenced command recovery and browser question responses", () => {
    assert.include(appSource, 'deliveryMode.value === "steer" ? "steer" : "follow_up"');
    assert.include(appSource, 'type: "abort"');
    assert.include(appSource, 'type: "extension_ui_response"');
    assert.include(appSource, "connection.discard(currentSessionId)");
    assert.include(appSource, "syncDeliveredUiResponses");
    assert.include(appSource, '"This agent runtime stopped"');
    assert.include(appSource, '"Recover runtime"');
    assert.include(appSource, "await transport.prepare(sessionId)");
    assert.include(appSource, "Pending commands will not be replayed");
    assert.notInclude(appSource, "new WebSocket");
    assert.notInclude(appSource, "/rpc/");
  });

  it("links the conversation to its focused session management row", () => {
    assert.include(sessionHtml, 'id="manage-session"');
    assert.include(sessionHtml, "Manage session");
    assert.include(appSource, "`/sessions?focus=${encodeURIComponent(sessionId)}`");
    assert.include(appSource, "updateManageSessionLink(sessionId)");
  });

  it("makes accepted follow-up delivery visible while Pi is working", () => {
    assert.include(sessionHtml, 'id="composer-hint" class="composer-hint" role="status"');
    assert.include(sessionHtml, 'aria-live="polite"');
    assert.include(appSource, "projection?.queue?.followUp");
    assert.include(appSource, "follow-up queued · sends after Pi finishes");
    assert.include(appSource, "follow-ups queued · send after Pi finishes");
    assert.include(appSource, "composerHint.textContent !== nextComposerHint");
  });

  it("uses a modal mobile sidebar, visible focus, safe areas, and reduced motion", () => {
    assert.include(sessionHtml, 'aria-controls="agent-sidebar"');
    assert.match(sessionHtml, /role="status"[\s\S]*?aria-live="polite"/u);
    assert.include(appSource, "trapDrawerFocus");
    assert.include(appSource, "setSummary(false)");
    assert.include(appSource, 'event.key === "Escape"');
    assert.include(sessionCss, "env(safe-area-inset-bottom)");
    assert.match(sessionCss, /\[hidden\]\s*\{\s*display: none !important;/u);
    assert.include(sessionCss, "@media (prefers-reduced-motion: reduce)");
    assert.include(sessionCss, ":focus-visible");
    assert.include(sessionCss, "font-size: 16px");
  });
});
