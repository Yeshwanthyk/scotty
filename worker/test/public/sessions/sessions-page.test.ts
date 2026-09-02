import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "vitest";
import {
  deletionActionLabel,
  focusKeyNeedsStableDraft,
  normalizeSessionListItem,
  sessionManagementPresentation,
  sessionPrimaryTiming,
  sessionsRenderSignature,
  sleepingProjectFocusKey,
} from "../../../public/sessions/list.js";
import {
  createRefreshCoordinator,
  createSessionRequested,
  focusedSessionId,
  focusedSessionPath,
  reconcileCleanupProjection,
  reconcileFocusedSession,
  unavailableSessionId,
} from "../../../public/sessions/lifecycle.js";
import sessionListSource from "../../../public/sessions/list.js?raw";
import sessionsHtml from "../../../public/sessions/index.html?raw";
import sessionsScript from "../../../public/sessions/index.js?raw";

const sharedStyles = readFileSync(
  fileURLToPath(new URL("../../../public/shared/styles.css", import.meta.url).href),
  "utf8",
);

describe("sessions page", () => {
  it("normalizes the current session projection shape at the fetch boundary", () => {
    const session = normalizeSessionListItem({
      id: "session-1",
      title: "Accessibility",
      status: "warm",
      provider: "cloudflare",
      repo: "openai/scotty",
      branch: "scotty/session-1",
      createdAt: "2026-08-04T14:00:00.000Z",
      hardCapAt: "2026-08-04T18:00:00.000Z",
      capRemainingSeconds: 5_430,
      failure: { code: "internal", message: "hidden", recoverable: true },
    });
    assert.deepStrictEqual(session, {
      id: "session-1",
      title: "Accessibility",
      status: "warm",
      provider: "cloudflare",
      repo: "openai/scotty",
      branch: "scotty/session-1",
      createdAt: "2026-08-04T14:00:00.000Z",
      hardCapAt: "2026-08-04T18:00:00.000Z",
      capRemainingSeconds: 5_430,
      failure: { code: "internal", message: "hidden", recoverable: true },
    });
    assert.deepStrictEqual(
      normalizeSessionListItem({ id: "legacy-session", status: "paused", provider: "future" }),
      { id: "legacy-session", status: "paused", provider: "future" },
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
    assert.include(sessionsHtml, '<link rel="stylesheet" href="/sessions/styles.css" />');
    assert.include(sessionsHtml, '<script type="module" src="/sessions/index.js"></script>');
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

  it("names both destructive resources in permanent-delete confirmation", () => {
    assert.include(sessionListSource, "This permanently removes the session and its backups.");
    assert.include(sessionListSource, '"Delete permanently", "delete"');
  });

  it("removes a deleted row only after the list projection omits it", () => {
    const reconciled = reconcileCleanupProjection([], ["session-1"]);
    assert.deepStrictEqual(reconciled.completedIds, ["session-1"]);
    assert.deepStrictEqual(reconciled.pendingIds, []);
    assert.include(sessionsScript, "await waitForRefresh()");
    assert.include(sessionsScript, "afterActive: true");
  });

  it("queues a fresh deletion check behind an active sessions poll", async () => {
    const started: string[] = [];
    const releases = new Map<string, (value: boolean) => void>();
    const coordinator = createRefreshCoordinator(
      (options) =>
        new Promise<boolean>((resolve) => {
          const actionId = options.actionId || "passive";
          started.push(actionId);
          releases.set(actionId, resolve);
        }),
    );

    const poll = coordinator.refresh({ actionId: "poll" });
    const verification = coordinator.refresh({ actionId: "delete", afterActive: true });
    assert.deepStrictEqual(started, ["poll"]);

    const releasePoll = releases.get("poll");
    assert.ok(releasePoll);
    releasePoll(true);
    await poll;
    await Promise.resolve();
    assert.deepStrictEqual(started, ["poll", "delete"]);

    const releaseDelete = releases.get("delete");
    assert.ok(releaseDelete);
    releaseDelete(true);
    assert.isTrue(await verification);
  });

  it("keeps stale projected rows visible as deleting", () => {
    const reconciled = reconcileCleanupProjection(
      [{ id: "session-1", status: "warm" }],
      ["session-1"],
    );
    assert.deepInclude(reconciled.sessions[0], { id: "session-1", deleting: true });
    assert.deepStrictEqual(reconciled.pendingIds, ["session-1"]);
    assert.deepStrictEqual(reconciled.completedIds, []);
  });

  it("distinguishes initial deletion from retry cleanup", () => {
    assert.strictEqual(deletionActionLabel("delete", "Delete permanently"), "Deleting…");
    assert.strictEqual(deletionActionLabel("retry-delete", "Retry cleanup"), "Retrying cleanup…");
    assert.include(sessionsScript, 'pendingAction === "retry-delete"');
    assert.include(sessionsScript, "list cleanup is still pending. Retry cleanup.");
  });

  it("focuses the session requested by the conversation management path", () => {
    assert.strictEqual(focusedSessionId("?focus=a0b1c2d3e4f5"), "a0b1c2d3e4f5");
    assert.isUndefined(focusedSessionId("?focus=../../devices"));
    assert.include(sessionListSource, "state.targetSessionId === session.id");
    assert.include(sessionListSource, "target?.focus({ preventScroll: true })");
  });

  it("opens rail sessions directly in the focused management route", () => {
    assert.strictEqual(focusedSessionPath("a0b1c2d3e4f5"), "/sessions?focus=a0b1c2d3e4f5");
    assert.include(
      sessionListSource,
      "compact ? focusedSessionPath(session.id) : `/s/${encodeURIComponent(session.id)}`",
    );
    assert.include(sessionsScript, 'event.target.closest("a[data-manage-session]")');
    assert.include(sessionsScript, "window.history.pushState");
    assert.match(
      sessionsScript,
      /window\.addEventListener\("popstate"[\s\S]*?else void refresh\(\);/u,
    );
    assert.include(sessionsScript, "refreshFocusedSession(targetSessionId).then(() => refresh())");
  });

  it("opens the shared create-session composer from a session workspace", () => {
    assert.isTrue(createSessionRequested("?create=1"));
    assert.isFalse(createSessionRequested("?create=0"));
    assert.include(sessionsScript, "createSessionRequested(window.location.search)");
    assert.include(sessionsHtml, 'id="new-session"');
  });

  it("keeps the rail action as the only create-session entry point", () => {
    assert.strictEqual(sessionsHtml.match(/id="new-session"/gu)?.length, 1);
    assert.notInclude(sessionListSource, '"open-composer"');
    assert.notInclude(sessionListSource, "Start a session");
  });

  it("keeps an authoritative focused session when the list projection is unavailable", () => {
    const focused = { id: "session-1", status: "sleeping", backupId: "backup-1" };
    assert.deepStrictEqual(
      reconcileFocusedSession(
        [
          { id: "session-2", status: "warm" },
          { id: "session-1", status: "warm" },
        ],
        focused,
      ),
      [focused, { id: "session-2", status: "warm" }],
    );
    assert.include(sessionsScript, "await fetch(sessionPath(id)");
    assert.include(sessionsScript, "loaded = true");
  });

  it("keeps a server-confirmed missing session unavailable despite stale list data", () => {
    assert.strictEqual(unavailableSessionId("?unavailable=a0b1c2d3e4f5"), "a0b1c2d3e4f5");
    assert.isUndefined(unavailableSessionId("?unavailable=../../devices"));
    assert.include(sessionListSource, "if (state.missingSessionId)");
    assert.include(
      sessionListSource,
      "renderUnavailableWorkspace(content, state.missingSessionId)",
    );
  });

  it("summarizes the next relevant session event", () => {
    const session = {
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
    assert.strictEqual(sessionPrimaryTiming(session, "sleeping"), "Backup ready");
    assert.strictEqual(sessionPrimaryTiming(session, "stopping"), "Stopping now");
    assert.strictEqual(
      sessionPrimaryTiming(session, "deleting", "delete"),
      "Deleting session and backups",
    );
  });

  it("presents sleeping sessions as safe, resumable workspaces", () => {
    assert.deepStrictEqual(
      sessionManagementPresentation({ status: "sleeping", backupId: "backup-1" }, "sleeping"),
      {
        label: "Sleeping",
        title: "Workspace safely asleep",
        copy: "Your checkpoint is ready. Resume the workspace to continue where you left off.",
      },
    );
    assert.deepStrictEqual(sessionManagementPresentation({ status: "sleeping" }, "sleeping"), {
      label: "Sleeping",
      title: "Workspace asleep",
      copy: "This workspace stopped without a usable checkpoint and cannot be resumed.",
    });
    assert.deepStrictEqual(sessionManagementPresentation({ status: "warm" }, "deleting"), {
      label: "Deleting",
      title: "Removing workspace",
      copy: "Scotty is removing this session and its backups.",
    });
  });

  it("keeps the focused resume action visually primary", () => {
    assert.match(
      sharedStyles,
      /\.sessions-page \.actions \.button-primary \{[\s\S]*?background: var\(--beam\);[\s\S]*?color: #0a0a0a;/u,
    );
  });

  it("recognizes focused rename drafts as stable controls", () => {
    assert.isTrue(focusKeyNeedsStableDraft("rename:session-1"));
    assert.isFalse(focusKeyNeedsStableDraft("details-toggle-details:session-1"));
    assert.isFalse(focusKeyNeedsStableDraft(undefined));
  });

  it("derives a safe stable focus key from repository identity", () => {
    const focusKey = sleepingProjectFocusKey('ExampleUser/scotty"]');

    assert.strictEqual(focusKey, "sleeping-project:exampleuser%2Fscotty%22%5D");
    assert.strictEqual(sleepingProjectFocusKey('exampleuser/SCOTTY"]'), focusKey);
  });

  it("binds sleeping-project summaries to visible-control focus restoration", () => {
    assert.include(
      sessionListSource,
      "sleepingSummary.dataset.focusKey = sleepingProjectFocusKey(group.repo)",
    );
    assert.include(
      sessionListSource,
      "focusRenderedControl([content, ...(repositoryNav ? [repositoryNav] : [])], focusKey)",
    );
    assert.include(sessionListSource, "section.append(sleeping)");
    assert.include(sessionsScript, "if (changed) render()");
  });

  it("keeps passive session renders stable within a minute", () => {
    const now = Date.parse("2026-08-04T14:30:05.000Z");
    const session = {
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
      sessionsRenderSignature([{ ...session, status: "sleeping" }], true, now + 5_000),
      signature,
    );
    assert.notStrictEqual(sessionsRenderSignature([session], true, now + 60_000), signature);
  });

  it("guards passive polling before replacing session nodes", () => {
    assert.include(sessionsScript, "signature === renderedSessionsSignature");
    assert.include(sessionsScript, "preserveUnchanged: options.actionId === undefined");
  });

  it("opens focused recovery surfaces on mobile and explains missing sessions", () => {
    assert.include(sessionListSource, '"mobile-session-open"');
    assert.include(sessionListSource, "Session unavailable");
    assert.include(sessionListSource, "It may have been deleted");
    assert.include(sessionListSource, "Resume & open");
  });
});
