import { groupSessionsByRepository, sessionDisplayStatus, sessionTitle } from "./form.js";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedFailure(value) {
  if (!isObject(value)) return undefined;
  const failure = {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.recoverable === "boolean" ? { recoverable: value.recoverable } : {}),
    ...(typeof value.stage === "string" ? { stage: value.stage } : {}),
  };
  return Object.keys(failure).length === 0 ? undefined : failure;
}

export function normalizeSessionListItem(value) {
  if (!isObject(value) || typeof value.id !== "string") return undefined;

  const failure = normalizedFailure(value.failure);

  return {
    id: value.id,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.runner === "string" ? { runner: value.runner } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.deleting === "boolean" ? { deleting: value.deleting } : {}),
    ...(typeof value.backupId === "string" ? { backupId: value.backupId } : {}),
    ...(Number.isFinite(value.capRemainingSeconds)
      ? { capRemainingSeconds: value.capRemainingSeconds }
      : {}),
    ...(typeof value.hardCapAt === "string" ? { hardCapAt: value.hardCapAt } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.repo === "string" ? { repo: value.repo } : {}),
    ...(failure === undefined ? {} : { failure }),
  };
}

export function formatSessionDuration(value) {
  const seconds = Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function sessionPrimaryTiming(session, status, pendingAction) {
  if (status === "deleting") {
    if (pendingAction === "delete") return "Deleting session and backups";
    if (pendingAction === "retry-delete") return "Retrying cleanup";
    return "Cleanup retries automatically";
  }
  if (status === "stopping") return "Stopping now";
  if (status === "boot-failed") return "Needs attention";
  if (status === "sleeping") return session?.backupId ? "Backup ready" : "Backup unavailable";
  if (status === "failed") return session?.backupId ? "Backup ready" : "Needs attention";
  return session?.capRemainingSeconds > 0
    ? `Auto-stop in ${formatSessionDuration(session.capRemainingSeconds)}`
    : "Session limit reached";
}

export function sessionManagementPresentation(session, status) {
  if (status === "sleeping")
    return session?.backupId
      ? {
          label: "Sleeping",
          title: "Workspace safely asleep",
          copy: "Your checkpoint is ready. Resume the workspace to continue where you left off.",
        }
      : {
          label: "Sleeping",
          title: "Workspace asleep",
          copy: "This workspace stopped without a usable checkpoint and cannot be resumed.",
        };
  if (status === "failed")
    return session?.backupId
      ? {
          label: "Recovery available",
          title: "Workspace needs attention",
          copy: "A checkpoint is ready. Resume the workspace to recover your session.",
        }
      : {
          label: "Unavailable",
          title: "Workspace could not recover",
          copy: "No usable checkpoint is available for this session.",
        };
  if (status === "stopping")
    return {
      label: "Stopping",
      title: "Preparing your checkpoint",
      copy: "Scotty is saving the workspace before it goes to sleep.",
    };
  if (status === "deleting")
    return {
      label: "Deleting",
      title: "Removing workspace",
      copy: "Scotty is removing this session and its backups.",
    };
  if (status !== "warm" && status !== "booting")
    return {
      label: "Unavailable",
      title: "Workspace state unavailable",
      copy: "Scotty could not determine a usable state for this workspace.",
    };
  return {
    label: status === "booting" ? "Starting" : "Active",
    title: status === "booting" ? "Workspace is starting" : "Workspace is running",
    copy:
      status === "booting"
        ? "Scotty is preparing the runtime and connecting Codex."
        : "Open the session to continue working, or stop it to save a checkpoint.",
  };
}

export function focusKeyNeedsStableDraft(value) {
  return typeof value === "string" && value.startsWith("rename:");
}

export function sleepingProjectFocusKey(repository) {
  return `sleeping-project:${encodeURIComponent(repository.toLocaleLowerCase("en-US"))}`;
}

export function sessionsRenderSignature(sessions, loaded, now = Date.now()) {
  if (!loaded) return "loading";
  const minute = Math.floor(now / 60_000);
  const groups = groupSessionsByRepository(sessions);
  return JSON.stringify([
    minute,
    groups.map((group) => [
      group.repo,
      group.sessions.map((session) => [
        session.id,
        sessionTitle(session),
        session.branch,
        session.provider,
        session.runner,
        session.status,
        Boolean(session.deleting),
        session.backupId,
        Number.isFinite(session.capRemainingSeconds)
          ? Math.floor(session.capRemainingSeconds / 60)
          : null,
        session.hardCapAt,
        session.createdAt,
        typeof session.failure?.message === "string" ? session.failure.message : null,
        typeof session.failure?.stage === "string" ? session.failure.stage : null,
      ]),
    ]),
  ]);
}

function addText(parent, className, text, tag = "div") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

export function deletionActionLabel(pendingAction, fallback) {
  if (pendingAction === "delete") return "Deleting…";
  if (pendingAction === "retry-delete") return "Retrying cleanup…";
  return fallback;
}

function actionButton(state, label, action, id, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button${options.primary ? " button-primary" : ""}`;
  button.dataset.action = action;
  button.dataset.id = id;
  button.dataset.focusKey = `${options.focusPrefix || ""}${action}:${id}`;
  button.disabled = state.busy.has(id);
  const pendingAction = state.busy.get(id);
  button.textContent =
    pendingAction === "sleep" && action === "sleep"
      ? "Stopping…"
      : action === "delete"
        ? deletionActionLabel(pendingAction, label)
        : pendingAction && action !== "confirm-delete"
          ? "Working…"
          : label;
  return button;
}

function appendLifecycleActions(parent, state, session, status, options = {}) {
  const actions = document.createElement("div");
  actions.className = `actions ${options.className || ""}`.trim();
  const focusPrefix = options.focusPrefix || "";

  if (options.includeRename && status !== "deleting") {
    actions.append(
      actionButton(state, "Rename", "rename", session.id, {
        focusPrefix,
      }),
    );
  }
  if (status === "deleting") {
    actions.append(actionButton(state, "Retry cleanup", "delete", session.id, { focusPrefix }));
  } else {
    if (status === "stopping") {
      if (options.includePrimary !== false)
        actions.append(
          actionButton(state, "Stopping…", "sleep", session.id, {
            primary: true,
            focusPrefix,
          }),
        );
    } else if (status === "warm") {
      actions.append(actionButton(state, "Stop", "sleep", session.id, { focusPrefix }));
    } else if (
      options.includePrimary !== false &&
      ((status === "sleeping" && session.backupId) || (status === "failed" && session.backupId))
    ) {
      actions.append(
        actionButton(state, "Resume & open", "resume", session.id, {
          primary: true,
          focusPrefix,
        }),
      );
    }
    if (status !== "stopping") {
      const deleteButton = actionButton(state, "Delete", "confirm-delete", session.id, {
        focusPrefix,
      });
      deleteButton.classList.add("button-danger");
      actions.append(deleteButton);
    }
  }
  parent.append(actions);
}

function appendConfirmation(parent, state, session, status) {
  if (status === "stopping" || !state.confirmations.has(session.id)) return;
  const confirmation = document.createElement("div");
  confirmation.className = "confirmation work-confirmation";
  addText(
    confirmation,
    "confirmation-copy",
    "This permanently removes the session and its backups.",
    "span",
  );
  const confirmButton = actionButton(state, "Delete permanently", "delete", session.id);
  confirmButton.classList.add("button-danger-confirm");
  confirmation.append(confirmButton, actionButton(state, "Cancel", "cancel-delete", session.id));
  parent.append(confirmation);
}

function appendRenameForm(parent, state, session) {
  const form = document.createElement("form");
  form.className = "rename-form work-rename-form";
  form.dataset.id = session.id;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.name = "title";
  input.value = state.renameDraft || sessionTitle(session);
  input.maxLength = 120;
  input.required = true;
  input.setAttribute("aria-label", "Session title");
  input.dataset.focusKey = `rename:${session.id}`;
  const save = document.createElement("button");
  save.className = "button button-quiet rename-action";
  save.type = "submit";
  save.textContent = "Save";
  const cancel = actionButton(state, "Cancel", "cancel-rename", session.id);
  cancel.classList.add("rename-action");
  form.append(input, save, cancel);
  parent.append(form);
}

function sessionIsActive(session) {
  return ["warm", "booting", "stopping"].includes(sessionDisplayStatus(session.status));
}

function sessionAgeLabel(session, now) {
  const timestamp = Date.parse(session.createdAt);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  return seconds < 60 ? "now" : `${formatSessionDuration(seconds)} ago`;
}

function appendRailSession(parent, session, selectedSessionId, now, compact = false) {
  const link = document.createElement("a");
  link.className = `rail-session${compact ? " rail-session-archived" : ""}`;
  link.href = `/s/${encodeURIComponent(session.id)}`;
  link.dataset.selectSession = session.id;
  if (session.id === selectedSessionId) link.setAttribute("aria-current", "page");
  const signal = document.createElement("span");
  signal.className = `rail-session-signal rail-signal-${sessionIsActive(session) ? "active" : "archived"}`;
  signal.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "rail-session-copy";
  addText(copy, "rail-session-title", sessionTitle(session) || "Untitled session", "strong");
  addText(
    copy,
    "rail-session-meta",
    compact ? sessionAgeLabel(session, now) : sessionPrimaryTiming(session, session.status),
    "small",
  );
  link.append(signal, copy);
  parent.append(link);
}

function renderRepositoryRail(parent, groups, state, now) {
  parent.replaceChildren();
  const query = (state.searchQuery || "").trim().toLocaleLowerCase("en-US");
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) => {
        if (!query) return true;
        return [sessionTitle(session), session.repo, session.branch, session.id]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase("en-US").includes(query));
      }),
    }))
    .filter((group) => group.sessions.length > 0);
  if (visibleGroups.length === 0) {
    addText(parent, "rail-empty", query ? "No matching sessions" : "No sessions yet", "p");
    return;
  }
  for (const group of visibleGroups) {
    const section = document.createElement("section");
    section.className = "rail-repository";
    const heading = document.createElement("h2");
    heading.title = group.repo;
    heading.textContent = group.repo;
    section.append(heading);
    const active = document.createElement("div");
    active.className = "rail-session-list";
    const activeSessions = group.sessions.filter(sessionIsActive);
    for (const session of activeSessions)
      appendRailSession(active, session, state.selectedSessionId, now);
    section.append(active);
    const archived = group.sessions.filter((session) => !sessionIsActive(session));
    if (archived.length > 0) {
      const sleeping = document.createElement("details");
      sleeping.className = "rail-archive";
      sleeping.dataset.repo = group.repo;
      sleeping.open = Boolean(state.archiveOpen?.has(group.repo));
      const sleepingSummary = document.createElement("summary");
      sleepingSummary.dataset.focusKey = sleepingProjectFocusKey(group.repo);
      addText(sleepingSummary, "rail-archive-label", "Archived", "span");
      addText(sleepingSummary, "rail-archive-count", String(archived.length), "span");
      sleeping.append(sleepingSummary);
      const list = document.createElement("div");
      list.className = "rail-session-list rail-archive-list";
      const count = state.archiveVisibleCounts?.get(group.repo) || 10;
      for (const session of archived.slice(0, count))
        appendRailSession(list, session, state.selectedSessionId, now, true);
      if (archived.length > count) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "rail-show-more";
        more.dataset.action = "show-more-archive";
        more.dataset.repo = group.repo;
        more.dataset.focusKey = `archive-more:${encodeURIComponent(group.repo)}`;
        more.textContent = `Show ${Math.min(10, archived.length - count)} more`;
        list.append(more);
      }
      sleeping.append(list);
      section.append(sleeping);
    }
    parent.append(section);
  }
}

function focusRenderedControl(hosts, focusKey) {
  if (!focusKey) return;
  const matches = hosts.flatMap((host) => [
    ...host.querySelectorAll(`[data-focus-key="${CSS.escape(focusKey)}"]`),
  ]);
  const control = [...matches].find((candidate) => candidate.getClientRects().length > 0);
  control?.focus();
}

function renderSessionsHome(parent) {
  parent.replaceChildren();
}

function renderManageWorkspace(parent, state, session) {
  parent.replaceChildren();
  const page = document.createElement("section");
  page.className = "workspace-manage-page";
  const back = document.createElement("a");
  back.className = "workspace-manage-back";
  back.href = "/sessions";
  back.textContent = "← All sessions";
  page.append(back);
  addText(page, "workspace-manage-title", sessionTitle(session) || "Untitled session", "h1");
  addText(
    page,
    "workspace-manage-meta",
    `${session.repo || "Unknown repository"} · ${session.branch || session.id}`,
    "p",
  );
  const status = sessionDisplayStatus(session.status, state.busy.get(session.id), session.deleting);
  const presentation = sessionManagementPresentation(session, status);
  const lifecycle = document.createElement("section");
  lifecycle.className = `workspace-manage-state status-${status}`;
  lifecycle.setAttribute("aria-label", `${presentation.label} workspace`);
  addText(lifecycle, "workspace-manage-label", presentation.label, "span");
  addText(lifecycle, "workspace-manage-state-title", presentation.title, "strong");
  addText(lifecycle, "workspace-manage-state-copy", presentation.copy, "p");
  page.append(lifecycle);
  const controls = document.createElement("div");
  controls.className = "workspace-manage-controls";
  if (state.renamingId === session.id) appendRenameForm(controls, state, session);
  else
    appendLifecycleActions(controls, state, session, status, {
      className: "work-actions",
      includeRename: true,
      includePrimary: true,
    });
  appendConfirmation(controls, state, session, status);
  page.append(controls);
  parent.append(page);
}

function renderUnavailableWorkspace(parent, sessionId) {
  parent.replaceChildren();
  const page = document.createElement("section");
  page.className = "workspace-manage-page workspace-unavailable-page";
  const back = document.createElement("a");
  back.className = "workspace-manage-back";
  back.href = "/sessions";
  back.textContent = "← All sessions";
  page.append(back);
  addText(page, "workspace-manage-title", "Session unavailable", "h1");
  addText(
    page,
    "workspace-unavailable-copy",
    "Scotty could not find this session. It may have been deleted, or this link may no longer be valid.",
    "p",
  );
  addText(page, "workspace-unavailable-id", `Session ${sessionId}`, "p");
  const sessionsLink = document.createElement("a");
  sessionsLink.className = "button button-primary";
  sessionsLink.href = "/sessions";
  sessionsLink.textContent = "View all sessions";
  page.append(sessionsLink);
  parent.append(page);
}

function focusTargetSession(content, state) {
  if (!state.focusTargetSession || !state.targetSessionId) return;
  const target = (state.repositoryNav || content).querySelector(
    `[data-select-session="${CSS.escape(state.targetSessionId)}"]`,
  );
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "center" });
  // Legacy focus contract: state.targetSessionId === session.id
}

function renderLoadedWorkspace(content, state) {
  if (state.missingSessionId) {
    renderUnavailableWorkspace(content, state.missingSessionId);
    return;
  }
  const managedSession = state.targetSessionId
    ? state.sessions.find((session) => session.id === state.targetSessionId)
    : undefined;
  if (state.targetSessionId && !managedSession) {
    renderUnavailableWorkspace(content, state.targetSessionId);
    return;
  }
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "state state-empty";
    addText(empty, "", "No cloud workspaces yet", "strong");
    addText(
      empty,
      "state-copy",
      "Start with a repository and tell Codex what outcome you want.",
      "p",
    );
    empty.append(actionButton(state, "Start a session", "open-composer", "", { primary: true }));
    content.append(empty);
    return;
  }
  if (managedSession) renderManageWorkspace(content, state, managedSession);
  else renderSessionsHome(content);
}

export function renderSessionsView(state) {
  const { content, repositoryNav, summary, sessions, loaded, fetching } = state;
  const activeElement = document.activeElement;
  const focusKey =
    activeElement instanceof HTMLElement &&
    (content.contains(activeElement) || repositoryNav?.contains(activeElement))
      ? activeElement.dataset.focusKey
      : undefined;

  content.setAttribute("aria-busy", fetching ? "true" : "false");
  document.body.classList.toggle(
    "mobile-session-open",
    Boolean(state.targetSessionId || state.missingSessionId),
  );
  document.body.classList.toggle("has-no-sessions", loaded && sessions.length === 0);
  const repositoryGroups = loaded ? groupSessionsByRepository(sessions) : [];
  summary.textContent = loaded
    ? `${sessions.length} ${sessions.length === 1 ? "sandbox" : "sandboxes"}${
        repositoryGroups.length > 0
          ? ` across ${repositoryGroups.length} ${
              repositoryGroups.length === 1 ? "project" : "projects"
            }`
          : ""
      }`
    : "Your cloud workspaces";

  if (state.preserveFocusedDraft && focusKeyNeedsStableDraft(focusKey)) {
    return { preservedDraft: true };
  }

  if (repositoryNav) renderRepositoryRail(repositoryNav, repositoryGroups, state, Date.now());
  content.replaceChildren();
  if (!loaded) {
    const loading = document.createElement("div");
    loading.className = "state";
    addText(loading, "", "Loading sessions", "strong");
    addText(loading, "state-copy", "Contacting Scotty…", "p");
    content.append(loading);
    return { preservedDraft: false };
  }

  renderLoadedWorkspace(content, state);
  focusTargetSession(content, state);
  focusRenderedControl([content, ...(repositoryNav ? [repositoryNav] : [])], focusKey);
  return { preservedDraft: false };
}
