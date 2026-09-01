import { assert, describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import appSource from "../../../public/session/index.js?raw";
import sessionHtml from "../../../public/session/index.html?raw";
import terminalSource from "../../../public/session/terminal.js?raw";

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
    assert.include(appSource, 'from "./changes.js"');
    assert.include(sessionHtml, '<link rel="stylesheet" href="/session/changes.css" />');
    assert.include(sessionHtml, '<aside id="summary-panel"');
    assert.include(sessionHtml, '<div id="summary-content"');
    assert.include(sessionHtml, 'aria-controls="summary-panel"');
    assert.notInclude(sessionHtml, "subagent");
    assert.notInclude(sessionHtml, "workflow");
  });

  it("keeps composer memory scoped across agent switches", () => {
    assert.include(appSource, "createSessionMemory()");
    assert.include(appSource, "memoryEntry(sessionId)");
    assert.include(appSource, "connection.open(sessionId)");
    assert.include(appSource, "window.history.pushState");
    assert.include(appSource, 'window.addEventListener("popstate"');
    assert.notInclude(appSource, "localStorage");
    assert.notInclude(appSource, "sessionStorage");
    assert.notInclude(appSource, "prefetch");
  });

  it("provides fenced command recovery and browser question responses", () => {
    assert.include(appSource, "selectedDeliveryMode(deliveryMode)");
    assert.include(appSource, 'type: "abort"');
    assert.include(appSource, 'type: "extension_ui_response"');
    assert.match(
      appSource,
      /connection\.discard\(sessionId\);\s*chatView\.reset\(\);\s*summaryView\.reset\(\);/u,
    );
    assert.include(appSource, "syncDeliveredUiResponses");
    assert.include(appSource, '"This agent runtime stopped"');
    assert.include(appSource, '"Recover runtime"');
    assert.include(appSource, "await transport.prepare(sessionId)");
    assert.include(appSource, "connection.discard(sessionId)");
    assert.include(sessionHtml, "Scotty will never replay it automatically");
    assert.notInclude(appSource, "new WebSocket");
    assert.notInclude(appSource, "/rpc/");
  });

  it("presents one explicit, resizable session terminal drawer", () => {
    assert.include(sessionHtml, 'id="open-terminal"');
    assert.include(sessionHtml, 'aria-controls="terminal-drawer"');
    assert.include(sessionHtml, 'id="terminal-drawer"');
    assert.include(sessionHtml, 'id="terminal-resizer"');
    assert.include(sessionHtml, 'aria-orientation="horizontal"');
    assert.include(sessionHtml, 'id="restart-terminal"');
    assert.include(sessionHtml, 'aria-label="Close terminal"');
    assert.include(appSource, 'await import("./terminal.js")');
    assert.include(appSource, "terminalDrawer.open(currentSessionId, openTerminalButton)");
    assert.include(sessionCss, "height: min(var(--terminal-height, 360px), 70vh)");
    assert.match(
      sessionCss,
      /@media \(max-width: 760px\)[\s\S]*?\.terminal-drawer \{[\s\S]*?position: fixed;[\s\S]*?height: 100dvh;/u,
    );
  });

  it("ignores a terminal restart result after the drawer changes sessions", () => {
    assert.include(terminalSource, "const restartingSessionId = sessionId");
    assert.include(terminalSource, "terminalRestartUrl(restartingSessionId)");
    assert.include(terminalSource, "if (!open || sessionId !== restartingSessionId) return");
    assert.include(terminalSource, "if (open && sessionId === restartingSessionId)");
  });

  it("links the conversation to its focused session management row", () => {
    assert.include(sessionHtml, 'id="manage-session"');
    assert.include(sessionHtml, "Manage session");
    assert.include(appSource, "`/sessions?focus=${encodeURIComponent(sessionId)}`");
    assert.include(appSource, "updateManageSessionLink(sessionId)");
  });

  it("reconciles accepted or queued delivery state from each authoritative reload", () => {
    assert.match(
      appSource,
      /projection = projectionFromSnapshot\(snapshot\);[\s\S]{0,240}entry\.delivery = reconcileDelivery\(entry\.delivery, projection\);/u,
    );
  });

  it("uses clear delivery choices and keeps Stop outside the message form", () => {
    assert.include(sessionHtml, 'id="composer-hint" class="composer-hint" role="status"');
    assert.include(sessionHtml, 'aria-live="polite"');
    assert.match(sessionHtml, /id="stop-agent"[\s\S]*?<form id="composer"/u);
    assert.include(sessionHtml, 'type="radio" name="delivery-mode" value="follow_up" checked');
    assert.include(sessionHtml, 'type="radio" name="delivery-mode" value="steer"');
    assert.include(sessionHtml, "After Pi finishes");
    assert.include(sessionHtml, "Guide the next turn");
    assert.notInclude(sessionHtml, '<select id="delivery-mode">');
    assert.strictEqual(sessionHtml.match(/aria-live="polite"/gu)?.length, 1);
    assert.notInclude(appSource, 'setAttribute("aria-live"');
  });

  it("uses a modal mobile sidebar, visible focus, safe areas, and reduced motion", () => {
    assert.include(sessionHtml, 'aria-controls="agent-sidebar"');
    assert.include(sessionHtml, 'id="composer-hint" class="composer-hint" role="status"');
    assert.include(appSource, "trapDrawerFocus");
    assert.include(appSource, "setSummary(false)");
    assert.include(appSource, 'event.key === "Escape"');
    assert.include(sessionCss, "env(safe-area-inset-bottom)");
    assert.match(sessionCss, /\[hidden\]\s*\{\s*display: none !important;/u);
    assert.include(sessionCss, "@media (prefers-reduced-motion: reduce)");
    assert.include(sessionCss, ":focus-visible");
    assert.include(sessionCss, "font-size: 16px");
  });
  it("shows live work, folds history, and exposes an explicit return to the tail", () => {
    assert.include(sessionHtml, 'id="transcript-scroller"');
    assert.include(sessionHtml, 'id="new-activity"');
    assert.include(appSource, "newActivity");
    assert.include(sessionCss, ".current-work");
    assert.include(sessionCss, ".earlier-turns");
    assert.match(
      sessionCss,
      /@media \(max-width: 760px\)[\s\S]*?\.current-work \.work-tools \.work-tool:nth-child\(n \+ 3\) \{[\s\S]*?display: none;/u,
    );
  });
});
