import { assert, describe, it } from "vitest";
import {
  focusKeyNeedsStableDraft,
  normalizeSessionListItem,
  sessionPrimaryTiming,
  sessionsRenderSignature,
} from "../public/session-list.js";
import sessionListSource from "../public/session-list.js?raw";
import sessionsHtml from "../public/sessions.html?raw";
import sessionsScript from "../public/sessions.js?raw";

describe("sessions page", () => {
  it("normalizes the current session projection shape at the fetch boundary", () => {
    const operationResult = {
      kind: "create",
      stage: "setup",
      progress: "completed",
      lastProvenEffect: "session_created",
      retainedState: "session",
      ambiguity: "none",
      safeRetry: "none",
      humanAction: "inspect",
      outcome: { status: "failed", failure: { code: "create_failed", message: "hidden" } },
      recoveryAction: "vaporize",
      startedAt: "2026-08-04T14:00:00.000Z",
      updatedAt: "2026-08-04T14:00:01.000Z",
    } as const;
    const session = normalizeSessionListItem({
      version: 1,
      revision: 7,
      id: "session-1",
      title: "Accessibility",
      status: "warm",
      provider: "cloudflare",
      repo: "openai/scotty",
      branch: "scotty/session-1",
      createdAt: "2026-08-04T14:00:00.000Z",
      hardCapAt: "2026-08-04T18:00:00.000Z",
      capRemainingSeconds: 5_430,
      operationResult,
    });
    assert.deepStrictEqual(session, {
      revision: 7,
      id: "session-1",
      title: "Accessibility",
      status: "warm",
      provider: "cloudflare",
      repo: "openai/scotty",
      branch: "scotty/session-1",
      createdAt: "2026-08-04T14:00:00.000Z",
      hardCapAt: "2026-08-04T18:00:00.000Z",
      capRemainingSeconds: 5_430,
      operationResult,
    });
    assert.deepStrictEqual(
      normalizeSessionListItem({
        revision: 8,
        id: "stopped-session",
        status: "stopped",
        provider: "future",
      }),
      { revision: 8, id: "stopped-session", status: "stopped", provider: "future" },
    );
    assert.isUndefined(
      normalizeSessionListItem({ revision: 8, id: "legacy-session", status: "paused" }),
    );
    assert.isUndefined(normalizeSessionListItem({ status: "warm" }));
  });

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
      revision: 1,
      id: "session-1",
      title: "Session one",
      branch: "scotty/session-1",
      provider: "cloudflare" as const,
      status: "warm" as const,
      repo: "openai/scotty",
      createdAt: "2026-08-04T14:00:00.000Z",
      hardCapAt: "2026-08-04T18:00:00.000Z",
      capRemainingSeconds: 5_430,
      backupId: "backup-1",
    };
    assert.strictEqual(sessionPrimaryTiming(session, "warm"), "Auto-stop in 1h 30m");
    assert.strictEqual(sessionPrimaryTiming(session, "stopped"), "Backup ready");
    assert.strictEqual(sessionPrimaryTiming(session, "stopping"), "Stopping now");
    assert.strictEqual(sessionPrimaryTiming(session, "deleting", "delete"), "Retrying cleanup");
  });

  it("recognizes focused rename drafts as stable controls", () => {
    assert.isTrue(focusKeyNeedsStableDraft("rename:session-1"));
    assert.isFalse(focusKeyNeedsStableDraft("details-toggle-details:session-1"));
    assert.isFalse(focusKeyNeedsStableDraft(undefined));
  });

  it("keeps passive session renders stable within a minute", () => {
    const now = Date.parse("2026-08-04T14:30:05.000Z");
    const session = {
      revision: 1,
      id: "session-1",
      repo: "openai/scotty",
      title: "Accessibility",
      status: "warm" as const,
      provider: "cloudflare" as const,
      branch: "scotty/session-1",
      createdAt: "2026-08-04T14:00:00.000Z",
      hardCapAt: "2026-08-04T18:00:00.000Z",
      capRemainingSeconds: 5_430,
    };
    const signature = sessionsRenderSignature([session], true, now);

    assert.strictEqual(
      sessionsRenderSignature([{ ...session, capRemainingSeconds: 5_425 }], true, now + 5_000),
      signature,
    );
    assert.notStrictEqual(
      sessionsRenderSignature([{ ...session, status: "stopped" }], true, now + 5_000),
      signature,
    );
    assert.notStrictEqual(sessionsRenderSignature([session], true, now + 60_000), signature);
  });

  it("guards passive polling before replacing session nodes", () => {
    assert.include(sessionsScript, "signature === renderedSessionsSignature");
    assert.include(sessionsScript, "preserveUnchanged: options.actionId === undefined");
  });
});
