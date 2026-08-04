import { assert, describe, it } from "vitest";
import { focusKeyNeedsStableDraft, sessionPrimaryTiming } from "../public/session-list.js";
import sessionListSource from "../public/session-list.js?raw";
import sessionsHtml from "../public/sessions.html?raw";
import sessionsScript from "../public/sessions.js?raw";

describe("sessions page", () => {
  it("keeps browser session creation Cloudflare-only", () => {
    assert.notInclude(sessionsHtml, "session-provider");
    assert.notInclude(sessionsScript, "/api/runners");
    assert.notInclude(sessionsScript, 'provider: "runner"');
    assert.include(sessionsScript, 'provider: "cloudflare"');
  });

  it("uses a semantic shell with focused page assets", () => {
    assert.notInclude(sessionsHtml, "<style>");
    assert.notInclude(sessionsHtml, '<script type="module">');
    assert.include(sessionsHtml, '<link rel="stylesheet" href="/sessions.css" />');
    assert.include(sessionsHtml, '<script type="module" src="/sessions.js"></script>');
  });

  it("announces concise updates outside the frequently refreshed list", () => {
    const contentTag = sessionsHtml.match(/<div id="content"[^>]*>/u)?.[0];
    assert.ok(contentTag);
    assert.notInclude(contentTag, "aria-live");
    assert.match(
      sessionsHtml,
      /id="session-announcer"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u,
    );
    assert.include(sessionsScript, "preserveFocusedDraft: options.actionId === undefined");
  });

  it("renders phone disclosure as an explicit, labelled control", () => {
    assert.include(sessionListSource, 'toggle.className = "session-disclosure-toggle"');
    assert.include(sessionListSource, 'toggle.setAttribute("aria-expanded"');
    assert.include(sessionListSource, 'toggle.setAttribute("aria-controls"');
    assert.include(sessionListSource, 'detail.className = "mobile-session-detail"');
  });

  it("summarizes the next relevant session event", () => {
    const session = {
      id: "session-1",
      capRemainingSeconds: 5_430,
      backupId: "backup-1",
    };
    assert.strictEqual(sessionPrimaryTiming(session, "warm"), "Auto-stop in 1h 30m");
    assert.strictEqual(sessionPrimaryTiming(session, "sleeping"), "Backup ready");
    assert.strictEqual(sessionPrimaryTiming(session, "stopping"), "Stopping now");
    assert.strictEqual(sessionPrimaryTiming(session, "deleting", "delete"), "Retrying cleanup");
  });

  it("recognizes focused rename drafts as stable controls", () => {
    assert.isTrue(focusKeyNeedsStableDraft("rename:session-1"));
    assert.isFalse(focusKeyNeedsStableDraft("details-toggle-details:session-1"));
    assert.isFalse(focusKeyNeedsStableDraft(undefined));
  });
});
