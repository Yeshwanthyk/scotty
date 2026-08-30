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
  it("wires one semantic shell to the five focused native modules", () => {
    assert.include(sessionHtml, '<aside id="agent-sidebar"');
    assert.include(sessionHtml, '<main class="agent-workspace">');
    assert.include(sessionHtml, '<section id="transcript"');
    assert.include(sessionHtml, '<form id="composer"');
    assert.include(sessionHtml, '<script type="module" src="/session/index.js"></script>');
    assert.include(appSource, 'from "./cloud-agents.js"');
    assert.include(appSource, 'from "./pi-connection.js"');
    assert.include(appSource, 'from "./chat.js"');
    assert.notInclude(sessionHtml, "Summary");
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
    assert.notInclude(appSource, "new WebSocket");
    assert.notInclude(appSource, "/rpc/");
  });

  it("uses a modal mobile sidebar, visible focus, safe areas, and reduced motion", () => {
    assert.include(sessionHtml, 'aria-controls="agent-sidebar"');
    assert.match(sessionHtml, /role="status"[\s\S]*?aria-live="polite"/u);
    assert.include(appSource, "trapSidebarFocus");
    assert.include(appSource, 'event.key === "Escape"');
    assert.include(sessionCss, "env(safe-area-inset-bottom)");
    assert.match(sessionCss, /\[hidden\]\s*\{\s*display: none !important;/u);
    assert.include(sessionCss, "@media (prefers-reduced-motion: reduce)");
    assert.include(sessionCss, ":focus-visible");
    assert.include(sessionCss, "font-size: 16px");
  });
});
