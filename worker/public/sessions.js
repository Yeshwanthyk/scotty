import {
  mergeRepositorySuggestions,
  promptText,
  repositoryName,
  safeSessionPath,
  sessionKeyboardAction,
  sessionTitle,
  submissionIdentity,
  titleText,
} from "/session-form.js";
import { renderSessionsView } from "/session-list.js";

const POLL_INTERVAL = 5000;
const content = document.querySelector("#content");
const sessionAnnouncer = document.querySelector("#session-announcer");
const devicesLink = document.querySelector("#devices");
const devicesMobileLink = document.querySelector("#devices-mobile");
const providersLink = document.querySelector("#providers");
const providersMobileLink = document.querySelector("#providers-mobile");
const summary = document.querySelector("#summary");
const notice = document.querySelector("#notice");
const noticeText = document.querySelector("#notice-text");
const retryButton = document.querySelector("#retry");
const newSessionButton = document.querySelector("#new-session");
const composerRegion = document.querySelector("#new-session-region");
const sessionForm = document.querySelector("#new-session-form");
const titleInput = document.querySelector("#session-title");
const repoInput = document.querySelector("#session-repo");
const capSelect = document.querySelector("#session-cap");
const promptInput = document.querySelector("#session-prompt");
const recentRepositories = document.querySelector("#recent-repositories");
const recentRepos = document.querySelector("#recent-repos");
const composerFeedback = document.querySelector("#composer-feedback");
const cancelSessionButton = document.querySelector("#cancel-session");
const startSessionButton = document.querySelector("#start-session");
const startSessionLabel = document.querySelector("#start-session-label");
const startSessionShortcut = document.querySelector("#start-session-shortcut");
const launchState = document.querySelector("#session-launch-state");
const launchRepository = document.querySelector("#launch-repository");
const launchStatus = document.querySelector("#launch-status");
const launchExecution = document.querySelector("#launch-execution");
const launchLimit = document.querySelector("#launch-limit");
const launchElapsed = document.querySelector("#launch-elapsed");
const cancelLaunchButton = document.querySelector("#cancel-launch");
let sessions = [];
let trackedRepositories = [];
let loaded = false;
let fetching = false;
let creating = false;
let createController;
let createAbortReason;
let launchStartedAt;
let launchTimer;
let launchMessage;
let lastSubmission;
let pollTimer;
const busy = new Map();
const confirmations = new Set();
const expandedSleepingProjects = new Set();
const expandedSessionDetails = new Set();
const rowErrors = new Map();
const suppressedRepositories = new Set();
let renamingId;
let renameDraft = "";

function sessionPath(id, suffix = "") {
  return `/api/sessions/${encodeURIComponent(id)}${suffix}`;
}

function repositoryPath(repo) {
  const [owner, name] = repo.split("/");
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function addText(parent, className, text, tag = "div") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function announce(message) {
  if (!message) return;
  sessionAnnouncer.textContent = "";
  requestAnimationFrame(() => {
    sessionAnnouncer.textContent = message;
  });
}

function focusVisibleControl(selector) {
  const controls = content.querySelectorAll(selector);
  const control = [...controls].find((candidate) => candidate.getClientRects().length > 0);
  control?.focus();
}

function setComposerOpen(open) {
  document.body.classList.toggle("composer-open", open);
  composerRegion.classList.toggle("is-open", open);
  composerRegion.toggleAttribute("inert", !open);
  composerRegion.setAttribute("aria-hidden", open ? "false" : "true");
  newSessionButton.setAttribute("aria-expanded", open ? "true" : "false");
  newSessionButton.textContent = open ? "Close" : "New session";
  newSessionButton.classList.toggle("button-primary", !open);
  if (open) requestAnimationFrame(() => titleInput.focus());
  else newSessionButton.focus();
}

function setComposerFeedback(kind, message, hint) {
  composerFeedback.replaceChildren();
  composerFeedback.className = `composer-feedback${kind ? ` is-${kind}` : ""}`;
  if (!message) return;
  if (kind === "error") addText(composerFeedback, "", message, "strong");
  else composerFeedback.append(document.createTextNode(message));
  if (hint) addText(composerFeedback, "", hint, "span");
}

function setCreating(next) {
  creating = next;
  for (const element of sessionForm.elements) {
    if (element !== cancelSessionButton && element !== cancelLaunchButton) element.disabled = next;
  }
  for (const button of recentRepos.querySelectorAll("button")) button.disabled = next;
  document.body.classList.toggle("is-creating", next);
  sessionForm.classList.toggle("is-creating", next);
  sessionForm.setAttribute("aria-busy", next ? "true" : "false");
  launchState.hidden = !next;
  cancelSessionButton.textContent = next ? "Cancel start" : "Cancel";
  startSessionLabel.textContent = next ? "Starting…" : "Start session";
  startSessionShortcut.hidden = next;
  requestAnimationFrame(() => (next ? launchState : startSessionButton).focus());
  if (!next) {
    clearInterval(launchTimer);
    launchTimer = undefined;
    launchStartedAt = undefined;
    launchMessage = undefined;
  }
}

function updateLaunchState() {
  if (!launchStartedAt) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - launchStartedAt) / 1000));
  launchElapsed.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const message =
    elapsed >= 25
      ? "Your workspace will open automatically as soon as Codex is ready."
      : elapsed >= 8
        ? "Repository setup can take a little while. Scotty is still working."
        : "Opening a secure path to your workspace…";
  if (message !== launchMessage) {
    launchMessage = message;
    launchStatus.textContent = message;
  }
}

function beginLaunchState(repo) {
  launchRepository.textContent = repo;
  launchExecution.textContent = "Cloudflare";
  launchLimit.textContent = capSelect.selectedOptions[0]?.textContent || "4 hours";
  launchStartedAt = Date.now();
  updateLaunchState();
  clearInterval(launchTimer);
  launchTimer = setInterval(updateLaunchState, 1000);
}

function abortCreate(reason) {
  if (!creating || !createController) return;
  createAbortReason = reason;
  createController.abort();
}

function renderRepositorySuggestions() {
  const repositories = mergeRepositorySuggestions(trackedRepositories, [...suppressedRepositories]);
  recentRepos.replaceChildren();
  recentRepositories.hidden = repositories.length === 0;
  for (const repository of repositories.slice(0, 5)) {
    const suggestion = document.createElement("div");
    suggestion.className = "repo-suggestion";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "repo-suggestion-select";
    selectButton.title = repository.defaultBranch
      ? `${repository.repo} · default branch ${repository.defaultBranch}`
      : repository.repo;
    addText(selectButton, "repo-suggestion-name", repository.repo, "span");
    if (repository.defaultBranch)
      addText(selectButton, "repo-suggestion-branch", repository.defaultBranch, "span");
    selectButton.disabled = creating;
    selectButton.addEventListener("click", () => {
      repoInput.value = repository.repo;
      repoInput.setCustomValidity("");
      if (composerFeedback.classList.contains("is-error")) setComposerFeedback();
      promptInput.focus();
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "repo-suggestion-remove";
    removeButton.title = "Remove from recents";
    removeButton.setAttribute("aria-label", `Remove ${repository.repo} from recent repositories`);
    removeButton.textContent = "×";
    removeButton.disabled = creating;
    removeButton.addEventListener("click", () => void forgetRepository(repository));

    suggestion.append(selectButton, removeButton);
    recentRepos.append(suggestion);
  }
}

async function forgetRepository(repository) {
  const identity = repository.repo.toLocaleLowerCase("en-US");
  if (suppressedRepositories.has(identity)) return;
  suppressedRepositories.add(identity);
  renderRepositorySuggestions();

  try {
    const response = await fetch(repositoryPath(repository.repo), {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(
        await errorMessage(response, `Could not remove ${repository.repo} from recents.`),
      );
    const result = await response.json();
    if (result?.repo !== repository.repo || result?.forgotten !== true)
      throw new Error("Scotty returned an unexpected response.");
    trackedRepositories = trackedRepositories.filter(
      (candidate) => repositoryName(candidate?.repo)?.toLocaleLowerCase("en-US") !== identity,
    );
    setComposerFeedback("", `Removed ${repository.repo} from recent repositories.`);
  } catch (error) {
    suppressedRepositories.delete(identity);
    renderRepositorySuggestions();
    setComposerFeedback(
      "error",
      error instanceof Error ? error.message : `Could not remove ${repository.repo} from recents.`,
    );
  }
}

function render(options = {}) {
  return renderSessionsView({
    content,
    summary,
    sessions,
    loaded,
    fetching,
    busy,
    confirmations,
    expandedSleepingProjects,
    expandedSessionDetails,
    rowErrors,
    renamingId,
    renameDraft,
    preserveFocusedDraft: options.preserveFocusedDraft === true,
  });
}

async function errorMessage(response, fallback) {
  try {
    const body = await response.json();
    return body?.error?.message || body?.message || fallback;
  } catch {
    return fallback;
  }
}

async function responseError(response, fallback) {
  try {
    const body = await response.json();
    return {
      message: body?.error?.message || body?.message || fallback,
      hint: body?.error?.hint || body?.hint,
    };
  } catch {
    return { message: fallback };
  }
}

async function refreshRepositories() {
  try {
    const response = await fetch("/api/repos", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const body = await response.json();
    const next = Array.isArray(body) ? body : body?.repos;
    if (Array.isArray(next)) trackedRepositories = next;
  } catch {
    // Repository history is optional; manual owner/repo entry remains available.
  } finally {
    renderRepositorySuggestions();
  }
}

async function createSession() {
  if (creating) return;
  const title = titleText(titleInput.value);
  const repo = repositoryName(repoInput.value);
  const prompt = promptText(promptInput.value);
  titleInput.setCustomValidity(title ? "" : "Give this session a title.");
  repoInput.setCustomValidity(repo ? "" : "Enter a repository as owner/repository.");
  promptInput.setCustomValidity(prompt ? "" : "Tell Codex what to do.");
  if (!sessionForm.reportValidity() || !title || !repo || !prompt) return;

  const payload = {
    title,
    repo,
    prompt,
    provider: "cloudflare",
    hardCapSeconds: Number(capSelect.value),
  };
  lastSubmission = submissionIdentity(lastSubmission, payload, () => crypto.randomUUID());
  setComposerFeedback(
    "pending",
    "Fetching the repository and launching Codex. This can take a moment…",
  );
  beginLaunchState(repo);
  setCreating(true);
  const controller = new AbortController();
  createController = controller;
  createAbortReason = undefined;
  const timeout = setTimeout(() => {
    if (createController !== controller) return;
    createAbortReason = "timeout";
    controller.abort();
  }, 120_000);

  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": lastSubmission.key,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await responseError(response, "The session could not be started.");
      const error = new Error(detail.message);
      error.hint = detail.hint;
      throw error;
    }
    const result = await response.json();
    if (typeof result?.id !== "string") throw new Error("Scotty returned an unexpected response.");
    const path = safeSessionPath(result.url, result.id, window.location.origin);
    if (!path) throw new Error("Scotty returned an unsafe session URL.");
    window.location.assign(path);
  } catch (error) {
    const abortReason = controller.signal.aborted ? createAbortReason : undefined;
    setComposerFeedback(
      "error",
      abortReason === "timeout"
        ? "Scotty is taking longer than expected."
        : abortReason === "cancel"
          ? "Session start canceled."
          : error instanceof Error
            ? error.message
            : "The session could not be started.",
      abortReason
        ? "Your values are preserved. Retry to safely check the same start request."
        : error instanceof Error && typeof error.hint === "string"
          ? error.hint
          : undefined,
    );
  } finally {
    clearTimeout(timeout);
    if (createController === controller) {
      createController = undefined;
      createAbortReason = undefined;
    }
    setCreating(false);
  }
}

async function refresh(options = {}) {
  if (fetching) return;
  const wasLoaded = loaded;
  const previousCount = sessions.length;
  fetching = true;
  content.setAttribute("aria-busy", "true");
  if (!loaded) render();
  try {
    const response = await fetch("/api/sessions", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(await errorMessage(response, "Sessions could not be loaded."));
    const body = await response.json();
    const next = Array.isArray(body) ? body : body?.sessions;
    if (!Array.isArray(next)) throw new Error("Scotty returned an unexpected response.");
    sessions = next.filter(
      (session) => session && typeof session === "object" && typeof session.id === "string",
    );
    loaded = true;
    notice.hidden = true;
    if (!wasLoaded || sessions.length !== previousCount) {
      announce(`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} available.`);
    }
  } catch (error) {
    noticeText.textContent =
      error instanceof Error ? error.message : "Sessions could not be loaded.";
    notice.hidden = false;
    if (options.actionId) rowErrors.set(options.actionId, noticeText.textContent);
  } finally {
    fetching = false;
    renderRepositorySuggestions();
    render({ preserveFocusedDraft: options.actionId === undefined });
  }
}

async function perform(id, action) {
  if (busy.has(id)) return;
  const current = sessions.find((session) => session.id === id);
  const title = current ? sessionTitle(current) : "session";
  busy.set(id, action);
  rowErrors.delete(id);
  announce(
    action === "sleep"
      ? `Stopping ${title}.`
      : action === "resume"
        ? `Resuming ${title}.`
        : `Deleting ${title}.`,
  );
  render();
  const suffix = action === "delete" ? "" : `/${action}`;
  const method = action === "delete" ? "DELETE" : "POST";
  let succeeded = false;
  try {
    const response = await fetch(sessionPath(id, suffix), {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response, `Could not ${action} this session.`));
    }
    const result = await response.json();
    const expectedStatus = action === "delete" ? "gone" : action === "sleep" ? "sleeping" : "warm";
    if (result?.id !== id || result?.status !== expectedStatus)
      throw new Error("Scotty returned an unexpected response.");
    succeeded = true;
    confirmations.delete(id);
    expandedSessionDetails.delete(id);
    if (action === "resume") {
      window.location.assign(`/s/${encodeURIComponent(id)}`);
      return;
    }
    if (action === "delete") sessions = sessions.filter((session) => session.id !== id);
    else
      sessions = sessions.map((session) =>
        session.id === id ? { ...session, ...result } : session,
      );
    announce(action === "delete" ? `${title} deleted.` : `${title} stopped.`);
  } catch (error) {
    rowErrors.set(id, error instanceof Error ? error.message : `Could not ${action} this session.`);
  } finally {
    busy.delete(id);
    if (succeeded) render();
    else await refresh({ actionId: id });
  }
}

async function performRename(id, title) {
  if (busy.has(id)) return;
  busy.set(id, "rename");
  rowErrors.delete(id);
  const activeForm = content.querySelector(`.rename-form[data-id="${CSS.escape(id)}"]`);
  for (const control of activeForm?.elements || []) control.disabled = true;
  announce(`Renaming session to ${title}.`);
  try {
    const response = await fetch(sessionPath(id), {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response, "Could not rename this session."));
    }
    const result = await response.json();
    if (result?.id !== id || result?.title !== title)
      throw new Error("Scotty returned an unexpected response.");
    sessions = sessions.map((session) => (session.id === id ? { ...session, ...result } : session));
    renamingId = undefined;
    renameDraft = "";
    announce(`Session renamed to ${title}.`);
  } catch (error) {
    rowErrors.set(id, error instanceof Error ? error.message : "Could not rename this session.");
  } finally {
    busy.delete(id);
    render();
    if (renamingId === undefined) {
      requestAnimationFrame(() =>
        focusVisibleControl(`[data-action="rename"][data-id="${CSS.escape(id)}"]`),
      );
    }
  }
}

content.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "open-composer") {
    setComposerOpen(true);
  } else if (action === "toggle-details") {
    if (expandedSessionDetails.has(id)) expandedSessionDetails.delete(id);
    else expandedSessionDetails.add(id);
    render();
  } else if (action === "rename") {
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    renamingId = id;
    renameDraft = sessionTitle(session);
    expandedSessionDetails.add(id);
    render();
    requestAnimationFrame(() => {
      const input = content.querySelector(`[data-focus-key="rename:${CSS.escape(id)}"]`);
      input?.focus();
      input?.select();
    });
  } else if (action === "cancel-rename") {
    renamingId = undefined;
    renameDraft = "";
    rowErrors.delete(id);
    render();
    focusVisibleControl(`[data-action="rename"][data-id="${CSS.escape(id)}"]`);
  } else if (action === "confirm-delete") {
    confirmations.add(id);
    render();
    focusVisibleControl(`[data-action="delete"][data-id="${CSS.escape(id)}"]`);
  } else if (action === "cancel-delete") {
    confirmations.delete(id);
    render();
  } else {
    void perform(id, action);
  }
});

content.addEventListener("input", (event) => {
  if (event.target.matches(".rename-input")) renameDraft = event.target.value;
});

content.addEventListener("submit", (event) => {
  const form = event.target.closest(".rename-form");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector(".rename-input");
  const title = titleText(input?.value);
  if (!title) {
    input?.setCustomValidity("Give this session a title of 120 characters or fewer.");
    input?.reportValidity();
    return;
  }
  input.setCustomValidity("");
  renameDraft = title;
  void performRename(form.dataset.id, title);
});

content.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !event.target.matches(".rename-input")) return;
  event.preventDefault();
  renamingId = undefined;
  renameDraft = "";
  render();
  focusVisibleControl(
    `[data-action="rename"][data-id="${CSS.escape(event.target.form?.dataset.id || "")}"]`,
  );
});

content.addEventListener(
  "toggle",
  (event) => {
    const sleeping = event.target.closest(".sleeping-group");
    if (!sleeping?.dataset.repo) return;
    if (sleeping.open) expandedSleepingProjects.add(sleeping.dataset.repo);
    else expandedSleepingProjects.delete(sleeping.dataset.repo);
  },
  true,
);

function schedulePoll() {
  clearInterval(pollTimer);
  if (!document.hidden) pollTimer = setInterval(() => void refresh(), POLL_INTERVAL);
}

document.addEventListener("visibilitychange", () => {
  schedulePoll();
  if (!document.hidden) void refresh();
});
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    (target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable))
  ) {
    return;
  }

  const sessionLinks = [...document.querySelectorAll(".session-row-link")].filter(
    (link) => link.getClientRects().length > 0,
  );
  const action = sessionKeyboardAction(
    event.key,
    sessionLinks.indexOf(document.activeElement),
    sessionLinks.length,
  );
  if (!action) {
    if (/^[1-9]$/u.test(event.key) || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
    }
    return;
  }

  event.preventDefault();
  const sessionLink = sessionLinks[action.index];
  if (action.type === "open") sessionLink.click();
  else sessionLink.focus();
});
retryButton.addEventListener("click", () => void refresh());
newSessionButton.addEventListener("click", () => {
  const open = composerRegion.classList.contains("is-open");
  if (open && creating) abortCreate("cancel");
  setComposerOpen(!open);
});
cancelSessionButton.addEventListener("click", () => {
  if (creating) {
    abortCreate("cancel");
    return;
  }
  setComposerOpen(false);
});
cancelLaunchButton.addEventListener("click", () => abortCreate("cancel"));
sessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createSession();
});
sessionForm.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sessionForm.requestSubmit();
  }
});
sessionForm.addEventListener("input", (event) => {
  if (event.target === titleInput) titleInput.setCustomValidity("");
  if (event.target === repoInput) repoInput.setCustomValidity("");
  if (event.target === promptInput) promptInput.setCustomValidity("");
  if (composerFeedback.classList.contains("is-error")) setComposerFeedback();
});

fetch("/api/auth/me", {
  credentials: "same-origin",
  cache: "no-store",
  headers: { Accept: "application/json" },
})
  .then((response) => (response.ok ? response.json() : undefined))
  .then((me) => {
    const owner = me?.client?.role === "owner";
    devicesLink.hidden = !owner;
    devicesMobileLink.hidden = !owner;
    providersLink.hidden = !owner;
    providersMobileLink.hidden = !owner;
  })
  .catch(() => undefined);

schedulePoll();
void refreshRepositories();
void refresh();
