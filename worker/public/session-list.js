import { groupSessionsByRepository, sessionDisplayStatus, sessionTitle } from "./session-form.js";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSessionListItem(value) {
  if (!isObject(value) || typeof value.id !== "string") return undefined;

  const failure = isObject(value.failure)
    ? {
        ...(typeof value.failure.code === "string" ? { code: value.failure.code } : {}),
        ...(typeof value.failure.message === "string" ? { message: value.failure.message } : {}),
        ...(typeof value.failure.recoverable === "boolean"
          ? { recoverable: value.failure.recoverable }
          : {}),
      }
    : undefined;

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
    ...(failure === undefined || Object.keys(failure).length === 0 ? {} : { failure }),
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
    return pendingAction === "delete" ? "Retrying cleanup" : "Cleanup retries automatically";
  }
  if (status === "stopping") return "Stopping now";
  if (status === "sleeping") return session?.backupId ? "Backup ready" : "Backup unavailable";
  if (status === "failed") return session?.backupId ? "Backup ready" : "Needs attention";
  return session?.capRemainingSeconds > 0
    ? `Auto-stop in ${formatSessionDuration(session.capRemainingSeconds)}`
    : "Session limit reached";
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

function statusLabel(status) {
  if (status === "stopping") return "Stopping…";
  if (status === "deleting") return "Deleting…";
  return status;
}

function placementLabel(session, status) {
  if (status === "deleting") return "Cleanup in progress";
  if (session.provider === "runner") return session.runner || "Runner";
  if (session.provider === "cloudflare") return "Cloudflare";
  return "Unknown runtime";
}

function createdRecency(session, now) {
  const timestampMs = Date.parse(session.createdAt);
  if (!Number.isFinite(timestampMs)) return { label: "Unknown", title: "" };
  const elapsedSeconds = Math.max(0, Math.floor((now - timestampMs) / 1_000));
  return {
    label: elapsedSeconds < 5 ? "Now" : `${formatSessionDuration(elapsedSeconds)} ago`,
    title: new Date(timestampMs).toLocaleString(),
  };
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
      : pendingAction === "delete" && action === "delete"
        ? "Retrying…"
        : pendingAction && action !== "confirm-delete"
          ? "Working…"
          : label;
  return button;
}

function appendStatusLine(parent, status) {
  const line = document.createElement("div");
  line.className = "status-line";
  const signal = document.createElement("span");
  signal.className = "signal";
  signal.setAttribute("aria-hidden", "true");
  line.append(signal, document.createTextNode(statusLabel(status)));
  parent.append(line);
}

function appendIdentityMetadata(parent, session) {
  const identityMeta = document.createElement("div");
  identityMeta.className = "identity-meta";
  const branch = addText(identityMeta, "branch", session.branch || `scotty/${session.id}`, "span");
  branch.title = session.branch || session.id;
  addText(identityMeta, "identity-separator", "", "span");
  addText(identityMeta, "session-id", `Session ${session.id}`, "span");
  parent.append(identityMeta);
}

function appendTiming(parent, state, session, status, created, className = "session-timing") {
  const timing = document.createElement("dl");
  timing.className = className;
  const createdTiming = document.createElement("div");
  addText(createdTiming, "", "Created", "dt");
  const createdValue = addText(createdTiming, "", created.label, "dd");
  if (created.title) createdValue.title = created.title;

  const capTiming = document.createElement("div");
  addText(
    capTiming,
    "",
    status === "deleting" ? "Cleanup" : status === "sleeping" ? "Backup" : "Auto-stop",
    "dt",
  );
  const capValue = addText(
    capTiming,
    "",
    status === "deleting"
      ? state.busy.get(session.id) === "delete"
        ? "Retrying now"
        : "Retries automatically"
      : status === "sleeping"
        ? session.backupId
          ? "Ready"
          : "Unavailable"
        : session.capRemainingSeconds > 0
          ? `in ${formatSessionDuration(session.capRemainingSeconds)}`
          : "Limit reached",
    "dd",
  );
  if (status !== "sleeping" && status !== "deleting" && typeof session.hardCapAt === "string") {
    capValue.title = new Date(session.hardCapAt).toLocaleString();
  }
  timing.append(createdTiming, capTiming);
  parent.append(timing);
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
      (status === "sleeping" || (status === "failed" && session.backupId))
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

function appendConfirmation(parent, state, session, status, className = "") {
  if (status === "stopping" || !state.confirmations.has(session.id)) return;
  const confirmation = document.createElement("div");
  confirmation.className = `confirmation ${className}`.trim();
  addText(
    confirmation,
    "confirmation-copy",
    "Permanently delete this session and its backups?",
    "span",
  );
  const confirmButton = actionButton(state, "Delete permanently", "delete", session.id, {
    focusPrefix: className ? "mobile-" : "",
  });
  confirmButton.classList.add("button-danger-confirm");
  confirmation.append(
    confirmButton,
    actionButton(state, "Cancel", "cancel-delete", session.id, {
      focusPrefix: className ? "mobile-" : "",
    }),
  );
  parent.append(confirmation);
}

function appendMobileDisclosure(item, state, session, status, created) {
  const expanded = state.expandedSessionDetails.has(session.id);
  const detailId = `session-detail-${encodeURIComponent(session.id)}`;
  const toggle = actionButton(state, "•••", "toggle-details", session.id, {
    focusPrefix: "details-",
  });
  toggle.className = "session-disclosure-toggle";
  toggle.setAttribute(
    "aria-label",
    `${expanded ? "Hide" : "Show"} details for ${sessionTitle(session)}`,
  );
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.setAttribute("aria-controls", detailId);
  item.append(toggle);

  const detail = document.createElement("div");
  detail.className = "mobile-session-detail";
  detail.id = detailId;
  detail.hidden = !expanded;

  const metadata = document.createElement("dl");
  metadata.className = "mobile-session-metadata";
  for (const [label, value] of [
    ["Branch", session.branch || `scotty/${session.id}`],
    ["Runtime", placementLabel(session, status)],
    ["Created", created.label],
    ["Session ID", session.id],
  ]) {
    const entry = document.createElement("div");
    addText(entry, "", label, "dt");
    addText(entry, "", value, "dd");
    metadata.append(entry);
  }
  detail.append(metadata);
  if (status === "failed" && typeof session.failure?.message === "string") {
    addText(detail, "session-failure mobile-session-failure", session.failure.message, "p");
  }
  appendLifecycleActions(detail, state, session, status, {
    className: "mobile-actions",
    focusPrefix: "mobile-",
    includeRename: true,
    includePrimary: false,
  });
  appendConfirmation(detail, state, session, status, "mobile-confirmation");
  item.append(detail);
}

function renderSessionRow(state, session, now) {
  const item = document.createElement("li");
  const pendingAction = state.busy.get(session.id);
  const status = sessionDisplayStatus(session.status, pendingAction, session.deleting);
  item.className = `session status-${status}${
    state.renamingId === session.id ? " is-renaming" : ""
  }${state.expandedSessionDetails.has(session.id) ? " is-expanded" : ""}`;

  if (
    status === "warm" &&
    state.renamingId !== session.id &&
    !state.confirmations.has(session.id)
  ) {
    const rowLink = document.createElement("a");
    rowLink.className = "session-row-link";
    rowLink.href = `/s/${encodeURIComponent(session.id)}`;
    rowLink.dataset.focusKey = `open:${session.id}`;
    rowLink.setAttribute("aria-label", `Open ${sessionTitle(session)}`);
    item.append(rowLink);
  }

  const identity = document.createElement("div");
  identity.className = "session-identity";
  if (state.renamingId === session.id && status !== "deleting") {
    const form = document.createElement("form");
    form.className = "rename-form";
    form.dataset.id = session.id;
    const input = document.createElement("input");
    input.className = "rename-input";
    input.name = "title";
    input.value = state.renameDraft;
    input.maxLength = 120;
    input.required = true;
    input.setAttribute("aria-label", "Session title");
    input.dataset.focusKey = `rename:${session.id}`;
    const save = document.createElement("button");
    save.className = "rename-action";
    save.type = "submit";
    save.textContent = "Save";
    const cancel = actionButton(state, "Cancel", "cancel-rename", session.id);
    cancel.classList.add("rename-action");
    form.append(input, save, cancel);
    identity.append(form);
  } else {
    const titleLine = document.createElement("div");
    titleLine.className = "session-title-line";
    addText(titleLine, "session-title", sessionTitle(session), "h3");
    if (status !== "deleting") {
      const rename = actionButton(state, "✎", "rename", session.id);
      rename.classList.add("rename-button");
      rename.setAttribute("aria-label", `Rename ${sessionTitle(session)}`);
      rename.title = "Rename";
      titleLine.append(rename);
    }
    identity.append(titleLine);
  }

  const glance = document.createElement("div");
  glance.className = "mobile-session-glance";
  const glanceStatus = addText(glance, "mobile-status", statusLabel(status), "span");
  glanceStatus.classList.add(`mobile-status-${status}`);
  addText(glance, "mobile-deadline", sessionPrimaryTiming(session, status, pendingAction), "span");
  identity.append(glance);
  appendIdentityMetadata(identity, session);
  if (status === "failed" && typeof session.failure?.message === "string") {
    addText(identity, "session-failure desktop-session-failure", session.failure.message, "p");
  }
  item.append(identity);

  const sessionState = document.createElement("div");
  sessionState.className = "session-state";
  appendStatusLine(sessionState, status);
  addText(sessionState, "placement", placementLabel(session, status), "span");
  item.append(sessionState);

  const created = createdRecency(session, now);
  appendTiming(item, state, session, status, created);
  appendLifecycleActions(item, state, session, status, { className: "desktop-actions" });
  appendConfirmation(item, state, session, status, "desktop-confirmation");

  const mobilePrimary = document.createElement("div");
  mobilePrimary.className = "mobile-primary-action";
  if (
    status === "warm" &&
    state.renamingId !== session.id &&
    !state.confirmations.has(session.id)
  ) {
    addText(mobilePrimary, "session-open-affordance", "Open ›", "span");
  } else if (status === "sleeping" || (status === "failed" && session.backupId)) {
    const resume = actionButton(state, "Resume", "resume", session.id, {
      primary: true,
      focusPrefix: "mobile-primary-",
    });
    mobilePrimary.append(resume);
  }
  item.append(mobilePrimary);
  appendMobileDisclosure(item, state, session, status, created);

  if (state.rowErrors.has(session.id)) {
    const error = addText(item, "row-error", state.rowErrors.get(session.id));
    error.setAttribute("role", "alert");
  }
  return item;
}

function projectSummary(projectSessions, state) {
  const counts = new Map();
  for (const session of projectSessions) {
    const status = sessionDisplayStatus(
      session.status,
      state.busy.get(session.id),
      session.deleting,
    );
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const parts = [
    `${projectSessions.length} ${projectSessions.length === 1 ? "sandbox" : "sandboxes"}`,
  ];
  for (const status of ["warm", "sleeping", "stopping", "deleting", "failed"]) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
  }
  return parts.join(" · ");
}

function renderSessionList(parent, state, projectSessions, label, now) {
  const list = document.createElement("ul");
  list.className = "session-list";
  list.setAttribute("aria-label", label);
  for (const session of projectSessions) list.append(renderSessionRow(state, session, now));
  parent.append(list);
}

function focusRenderedControl(content, focusKey) {
  if (!focusKey) return;
  const matches = content.querySelectorAll(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  const control = [...matches].find((candidate) => candidate.getClientRects().length > 0);
  control?.focus();
}

export function renderSessionsView(state) {
  const { content, summary, sessions, loaded, fetching } = state;
  const activeElement = document.activeElement;
  const focusKey =
    activeElement instanceof HTMLElement && content.contains(activeElement)
      ? activeElement.dataset.focusKey
      : undefined;

  content.setAttribute("aria-busy", fetching ? "true" : "false");
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

  content.replaceChildren();
  if (!loaded) {
    const loading = document.createElement("div");
    loading.className = "state";
    addText(loading, "", "Loading sessions", "strong");
    addText(loading, "state-copy", "Contacting Scotty…", "p");
    content.append(loading);
    return { preservedDraft: false };
  }

  if (sessions.length === 0) {
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
    return { preservedDraft: false };
  }

  const projects = document.createElement("div");
  projects.className = "project-groups";
  const now = Date.now();
  for (const group of repositoryGroups) {
    const project = document.createElement("section");
    project.className = "project-group";
    const header = document.createElement("header");
    header.className = "project-header";
    const heading = document.createElement("div");
    heading.className = "project-heading";
    addText(heading, "project-name", group.repo, "h2");
    addText(header, "project-summary", projectSummary(group.sessions, state), "span");
    header.prepend(heading);
    project.append(header);

    const activeSessions = group.sessions.filter((session) => session.status !== "sleeping");
    const sleepingSessions = group.sessions.filter((session) => session.status === "sleeping");
    if (activeSessions.length > 0) {
      renderSessionList(project, state, activeSessions, `${group.repo} active sandboxes`, now);
    }
    if (sleepingSessions.length > 0) {
      const sleeping = document.createElement("details");
      sleeping.className = "sleeping-group";
      sleeping.dataset.repo = group.repo;
      sleeping.open = state.expandedSleepingProjects.has(group.repo);
      const sleepingSummary = document.createElement("summary");
      sleepingSummary.dataset.focusKey = sleepingProjectFocusKey(group.repo);
      sleepingSummary.append(
        document.createTextNode(
          `${sleepingSessions.length} sleeping ${
            sleepingSessions.length === 1 ? "sandbox" : "sandboxes"
          }`,
        ),
      );
      sleeping.append(sleepingSummary);
      renderSessionList(sleeping, state, sleepingSessions, `${group.repo} sleeping sandboxes`, now);
      project.append(sleeping);
    }
    projects.append(project);
  }
  content.append(projects);
  focusRenderedControl(content, focusKey);
  return { preservedDraft: false };
}
