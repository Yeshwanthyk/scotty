import { createChatView, applyEvent, projectionFromSnapshot, sanitizeText } from "./chat.js";
import {
  composerPresentation,
  createSessionMemory,
  currentActivity,
  reconcileDelivery,
  reconcileAcceptedDelivery,
  queuePresentation,
  renderComposerQueue,
  renderComposerPresentation,
  selectedDeliveryMode,
  shouldSubmitComposerKey,
} from "./composer.js";
import { createCloudAgentDirectory } from "./cloud-agents.js";
import { createConsoleTransport, createPiConnection } from "./pi-connection.js";
import { createSummaryView } from "./summary.js";
import { createChangesViewer } from "./changes.js";

const byId = (id) => document.getElementById(id);
const appShell = document.querySelector(".app-shell") ?? document.body;
const sidebar = byId("agent-sidebar");
const backdrop = byId("agent-backdrop");
const openAgentsButton = byId("open-agents");
const closeAgentsButton = byId("close-agents");
const summaryPanel = byId("summary-panel");
const summaryContent = byId("summary-content");
const openSummaryButton = byId("open-summary");
const closeSummaryButton = byId("close-summary");
const openTerminalButton = byId("open-terminal");
const terminalRoot = byId("terminal-drawer");
const terminalSurface = byId("terminal-surface");
const terminalState = byId("terminal-state");
const terminalStateLabel = byId("terminal-state-label");
const closeTerminalButton = byId("close-terminal");
const restartTerminalButton = byId("restart-terminal");
const terminalResizer = byId("terminal-resizer");
const manageSessionLink = byId("manage-session");
const agentList = byId("agent-list");
const agentCount = byId("agent-count");
const agentFilter = byId("agent-filter");
const title = byId("agent-title");
const meta = byId("agent-meta");
const mobileTitle = byId("active-agent-title");
const mobileRepo = byId("active-agent-repo");
const mobileConnectionState = byId("mobile-connection-state");
const connectionState = byId("connection-state");
const connectionLabel = byId("connection-label");
const transcript = byId("transcript-scroller");
const feed = byId("transcript-feed");
const newActivity = byId("new-activity");
const composer = byId("composer");
const composerInput = byId("composer-input");
const composerHint = byId("composer-hint");
const composerQueue = byId("composer-queue");
const sendButton = byId("send-message");
const stopButton = byId("stop-agent");
const deliveryControls = byId("delivery-controls");
const deliveryMode = byId("delivery-mode");
const recovery = byId("command-recovery");
const discardCommands = byId("discard-commands");
const compactViewport = matchMedia("(max-width: 760px)");
const sessionMemory = createSessionMemory();
const pendingUiResponses = new Set();
const deliveredUiResponses = new Set();
const chatView = createChatView({
  document,
  feed,
  scroller: transcript,
  newActivity,
  baseUrl: window.location.href,
});
const summaryView = createSummaryView({
  document,
  root: summaryContent,
  baseUrl: window.location.href,
  fetch: window.fetch.bind(window),
});
const changesViewer = createChangesViewer({
  document,
  fetch: window.fetch.bind(window),
  headerActions: document.querySelector(".agent-header-actions"),
  surfaceHost: appShell,
  onBeforeOpen: () => {
    setSummary(false);
    terminalDrawer?.close();
  },
});

let currentSessionId;
let projection;
let renderFrame;
let loadGeneration = 0;
let sidebarOpener;
let summaryOpener;
let terminalDrawer;

async function openTerminal() {
  if (!currentSessionId || openTerminalButton.disabled) return;
  openTerminalButton.disabled = true;
  try {
    if (!terminalDrawer) {
      const { createTerminalDrawer } = await import("./terminal.js");
      terminalDrawer = createTerminalDrawer({
        root: terminalRoot,
        surface: terminalSurface,
        status: terminalState,
        statusLabel: terminalStateLabel,
        closeButton: closeTerminalButton,
        restartButton: restartTerminalButton,
        resizer: terminalResizer,
        workspace: document.querySelector(".agent-workspace"),
        fetch: window.fetch.bind(window),
        origin: window.location.origin,
        onOpenChange: (open) => openTerminalButton.setAttribute("aria-expanded", String(open)),
      });
    }
    setSidebar(false);
    setSummary(false);
    changesViewer.close();
    terminalDrawer.open(currentSessionId, openTerminalButton);
  } finally {
    openTerminalButton.disabled = false;
  }
}

function sessionIdFromLocation() {
  const match = window.location.pathname.match(/^\/s\/([^/]+)$/u);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function updateManageSessionLink(sessionId) {
  manageSessionLink.href = sessionId
    ? `/sessions?focus=${encodeURIComponent(sessionId)}`
    : "/sessions";
}

const memoryEntry = (sessionId) => sessionMemory.entry(sessionId);

function saveBrowserState() {
  if (!currentSessionId) return;
  const entry = memoryEntry(currentSessionId);
  entry.draft = composerInput.value;
  entry.scrollTop = transcript.scrollTop;
}

function setConnection(state, message) {
  const activity = currentActivity(projection);
  const labels = {
    connecting: "Connecting",
    connected: activity ? `Pi working · ${activity}` : "Connected",
    reconnecting: "Reconnecting",
    changed: "Session changed",
    ambiguous: "Outcome unknown",
    unavailable: "Unavailable",
  };
  connectionState.dataset.state = state;
  mobileConnectionState.dataset.state = state;
  mobileConnectionState.setAttribute("aria-label", message ?? labels[state] ?? "Unavailable");
  connectionLabel.textContent = message ?? labels[state] ?? "Unavailable";
}

function updateAgentCopy(agent) {
  const agentTitle = agent?.title ?? currentSessionId ?? "Cloud agent";
  const repository = agent?.repo ?? "Cloud agent";
  const project = repository.split("/").at(-1) || repository;
  const branch = agent?.branch?.replace(/^scotty\//u, "");
  const detail = [project, branch].filter(Boolean).join(" · ");
  title.textContent = agentTitle;
  meta.textContent = detail;
  mobileTitle.textContent = agentTitle;
  mobileRepo.textContent = repository;
  document.title = `${agentTitle} · Scotty`;
}

function laneState() {
  return currentSessionId ? connection.laneState(currentSessionId) : { items: [] };
}

function updateComposer() {
  const entry = currentSessionId ? memoryEntry(currentSessionId) : undefined;
  renderComposerPresentation(
    { recovery, deliveryControls, stopButton, sendButton, hint: composerHint },
    composerPresentation({
      projection,
      lane: laneState(),
      draft: composerInput.value,
      delivery: entry?.delivery,
      deliveryMode: selectedDeliveryMode(deliveryMode),
    }),
  );
  renderComposerQueue(composerQueue, queuePresentation(projection));
}

function autosizeComposer() {
  composerInput.style.height = "0";
  const maximum = compactViewport.matches ? 128 : 160;
  const height = Math.min(composerInput.scrollHeight, maximum);
  composerInput.style.height = `${height}px`;
  composerInput.style.overflowY = composerInput.scrollHeight > maximum ? "auto" : "hidden";
}

function scheduleRender() {
  if (renderFrame !== undefined) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = undefined;
    if (projection && currentSessionId) {
      chatView.render(projection, currentSessionId);
      summaryView.render(projection, currentSessionId);
    }
    setConnection("connected");
    updateComposer();
  });
}

function uiResponseKey(sessionId, epoch, requestId) {
  return `${sessionId}:${epoch}:${requestId}`;
}

function syncDeliveredUiResponses(sessionId, nextProjection) {
  for (const [requestId, request] of nextProjection.pendingUi) {
    if (deliveredUiResponses.has(uiResponseKey(sessionId, nextProjection.epoch, requestId)))
      request.delivered = true;
  }
}

function showLoadError(error) {
  const recoverableRuntime = error?.status === 502 || error?.status === 503;
  setConnection(
    "unavailable",
    error instanceof Error ? error.message : "This cloud agent is unavailable",
  );
  feed.removeAttribute("aria-busy");
  summaryView.reset();
  feed.replaceChildren();
  const state = document.createElement("div");
  state.className = "conversation-state";
  const heading = document.createElement("strong");
  heading.textContent = recoverableRuntime
    ? "This agent runtime stopped"
    : "Could not load this conversation";
  const copy = document.createElement("p");
  copy.textContent = recoverableRuntime
    ? "Scotty can restart the runtime and reconnect from a fresh snapshot. Pending commands will not be replayed."
    : error instanceof Error
      ? error.message
      : "Try this cloud agent again.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "button button-secondary";
  retry.textContent = recoverableRuntime ? "Recover runtime" : "Retry";
  retry.addEventListener("click", () => {
    if (recoverableRuntime) void recoverRuntime(currentSessionId, retry);
    else void loadSession(currentSessionId);
  });
  state.append(heading, copy, retry);
  feed.append(state);
  updateComposer();
}

async function recoverRuntime(sessionId, button) {
  if (!sessionId) return;
  button.disabled = true;
  button.textContent = "Recovering…";
  setConnection("connecting", "Recovering agent runtime…");
  try {
    await transport.prepare(sessionId);
    if (currentSessionId === sessionId) await loadSession(sessionId);
  } catch (error) {
    if (currentSessionId === sessionId) showLoadError(error);
  }
}

const transport = createConsoleTransport({
  fetch: window.fetch.bind(window),
  eventSource: (url) => new EventSource(url),
  origin: window.location.origin,
});

const connection = createPiConnection({
  transport,
  randomUUID: () => crypto.randomUUID(),
  onState: setConnection,
  onLaneChange: updateComposer,
  onEvent: (envelope) => {
    if (!projection) return;
    const result = applyEvent(projection, envelope);
    if (result === "refresh") {
      setConnection("changed");
      void loadSession(currentSessionId);
      return;
    }
    if (result !== "applied") return;
    const event = envelope?.event;
    const entry = memoryEntry(currentSessionId);
    entry.delivery = reconcileDelivery(entry.delivery, projection, event);
    if (event?.type === "extension_ui_request" && event.method === "set_editor_text") {
      composerInput.value = sanitizeText(event.text);
      memoryEntry(currentSessionId).draft = composerInput.value;
      autosizeComposer();
    }
    scheduleRender();
  },
});

const directory = createCloudAgentDirectory({
  document,
  target: agentList,
  count: agentCount,
  filter: agentFilter,
  fetch: window.fetch.bind(window),
  onSelect: (sessionId) => void switchSession(sessionId),
  onChange: () => updateAgentCopy(directory.find(currentSessionId)),
});

async function loadSession(sessionId, options = {}) {
  if (!sessionId) return showLoadError(new Error("This URL does not identify a Scotty session"));
  const generation = ++loadGeneration;
  projection = undefined;
  chatView.reset();
  summaryView.reset();
  feed.setAttribute("aria-busy", "true");
  updateComposer();
  try {
    const snapshot = await connection.open(sessionId);
    if (generation !== loadGeneration || currentSessionId !== sessionId || snapshot === undefined)
      return;
    projection = projectionFromSnapshot(snapshot);
    syncDeliveredUiResponses(sessionId, projection);
    const entry = memoryEntry(sessionId);
    entry.delivery = reconcileDelivery(entry.delivery, projection);
    if (entry.delivery?.status === "stale")
      entry.delivery = { ...entry.delivery, detail: "refreshed" };
    scheduleRender();
    requestAnimationFrame(() => {
      transcript.scrollTop = memoryEntry(sessionId).scrollTop;
      if (options.focusComposer) composerInput.focus({ preventScroll: true });
    });
  } catch (error) {
    if (generation === loadGeneration && currentSessionId === sessionId) showLoadError(error);
  }
}

async function switchSession(sessionId, options = {}) {
  if (!sessionId || sessionId === currentSessionId) {
    setSidebar(false);
    return;
  }
  saveBrowserState();
  currentSessionId = sessionId;
  updateManageSessionLink(sessionId);
  directory.setCurrent(sessionId);
  updateAgentCopy(directory.find(sessionId));
  const entry = memoryEntry(sessionId);
  composerInput.value = entry.draft;
  autosizeComposer();
  if (options.history !== false)
    window.history.pushState({ sessionId }, "", `/s/${encodeURIComponent(sessionId)}`);
  setSidebar(false);
  setSummary(false);
  terminalDrawer?.setSessionId(sessionId);
  changesViewer.setSessionId(sessionId);
  await loadSession(sessionId, { focusComposer: options.focusComposer });
}

function restoreDraft(sessionId, text) {
  if (!text) return;
  const entry = sessionMemory.restoreDraft(sessionId, text);
  if (currentSessionId !== sessionId) return;
  composerInput.value = entry.draft;
  autosizeComposer();
}

async function submitIntent(intent, label, draft) {
  const sessionId = currentSessionId;
  const entry = memoryEntry(sessionId);
  const authority = {
    sessionId,
    epoch: projection.epoch,
    expectedSessionRevision: projection.sessionRevision,
  };
  if (draft) entry.delivery = { kind: intent.type, message: draft.trim(), status: "submitting" };
  let submission;
  try {
    submission = connection.command(authority, intent, label);
  } catch (error) {
    restoreDraft(sessionId, draft);
    if (draft)
      entry.delivery = {
        kind: intent.type,
        message: draft.trim(),
        status: "failed",
        detail: error instanceof Error ? error.message : "Pi did not accept that message",
      };
    updateComposer();
    throw error;
  }
  const outcome = await submission.outcome;
  if (outcome.status === "accepted") {
    if (draft)
      entry.delivery = reconcileAcceptedDelivery(
        entry.delivery,
        { kind: intent.type, message: draft.trim(), status: "accepted" },
        currentSessionId === sessionId ? projection : undefined,
      );
  } else {
    restoreDraft(sessionId, draft);
    if (draft)
      entry.delivery = {
        kind: intent.type,
        message: draft.trim(),
        status:
          outcome.status === "stale"
            ? "stale"
            : outcome.status === "ambiguous"
              ? "ambiguous"
              : "failed",
        ...(outcome.message ? { detail: outcome.message } : {}),
      };
    if (currentSessionId === sessionId)
      setConnection(
        outcome.status === "ambiguous"
          ? "ambiguous"
          : outcome.status === "stale"
            ? "changed"
            : "unavailable",
        outcome.message,
      );
    if (outcome.status === "stale") {
      connection.discard(sessionId);
      if (currentSessionId === sessionId) await loadSession(sessionId, { focusComposer: true });
    }
  }
  updateComposer();
  return outcome;
}

async function submitComposer() {
  if (!projection || !currentSessionId || sendButton.disabled) return;
  const draft = composerInput.value;
  const message = draft.trim();
  if (!message) return;
  const intent = projection.active
    ? { type: selectedDeliveryMode(deliveryMode), message }
    : { type: "prompt", message };
  composerInput.value = "";
  memoryEntry(currentSessionId).draft = "";
  autosizeComposer();
  updateComposer();
  composerInput.focus({ preventScroll: true });
  try {
    await submitIntent(intent, message, draft);
  } catch (error) {
    setConnection(
      "unavailable",
      error instanceof Error ? error.message : "Pi did not accept that message",
    );
  }
}

async function respondToQuestion(card, intent) {
  const requestId = card.dataset.requestId;
  if (!projection?.pendingUi.has(requestId) || pendingUiResponses.has(requestId)) return;
  pendingUiResponses.add(requestId);
  for (const control of card.querySelectorAll("button, input, textarea")) control.disabled = true;
  try {
    const outcome = await submitIntent(
      { type: "extension_ui_response", id: requestId, ...intent },
      `Reply to ${requestId}`,
      "",
    );
    if (outcome.status === "accepted") {
      deliveredUiResponses.add(uiResponseKey(currentSessionId, projection.epoch, requestId));
      const request = projection.pendingUi.get(requestId);
      if (request) request.delivered = true;
      scheduleRender();
    } else
      for (const control of card.querySelectorAll("button, input, textarea"))
        control.disabled = false;
  } finally {
    pendingUiResponses.delete(requestId);
  }
}

function setSidebar(open) {
  const compact = compactViewport.matches;
  if (open) setSummary(false);
  sidebar.dataset.open = String(open);
  updateBackdrop();
  openAgentsButton.setAttribute("aria-expanded", String(open));
  if (compact) sidebar.inert = !open;
  else sidebar.inert = false;
  if (open) {
    sidebarOpener = document.activeElement;
    const selected = sidebar.querySelector('[aria-current="page"]');
    (selected ?? closeAgentsButton).focus({ preventScroll: true });
  } else if (sidebarOpener && compact) {
    sidebarOpener.focus({ preventScroll: true });
    sidebarOpener = undefined;
  }
}

function setSummary(open) {
  if (open) {
    setSidebar(false);
    changesViewer.close();
    terminalDrawer?.close();
  }
  summaryPanel.dataset.open = String(open);
  summaryPanel.inert = !open;
  openSummaryButton.setAttribute("aria-expanded", String(open));
  updateBackdrop();
  if (open) {
    summaryOpener = document.activeElement;
    closeSummaryButton.focus({ preventScroll: true });
  } else if (summaryOpener) {
    summaryOpener.focus({ preventScroll: true });
    summaryOpener = undefined;
  }
}

function updateBackdrop() {
  const sidebarOpen = compactViewport.matches && sidebar.dataset.open === "true";
  const summaryOpen = compactViewport.matches && summaryPanel.dataset.open === "true";
  backdrop.hidden = !sidebarOpen && !summaryOpen;
}

function trapDrawerFocus(event) {
  const activeDrawer =
    compactViewport.matches && sidebar.dataset.open === "true"
      ? sidebar
      : compactViewport.matches && summaryPanel.dataset.open === "true"
        ? summaryPanel
        : undefined;
  if (event.key === "Escape" && summaryPanel.dataset.open === "true" && !activeDrawer) {
    event.preventDefault();
    setSummary(false);
    return;
  }
  if (event.key === "Escape" && activeDrawer) {
    event.preventDefault();
    if (activeDrawer === sidebar) setSidebar(false);
    else setSummary(false);
    return;
  }
  if (event.key !== "Tab" || !activeDrawer) return;
  const controls = [
    ...activeDrawer.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitComposer();
});
composerInput.addEventListener("input", () => {
  memoryEntry(currentSessionId).draft = composerInput.value;
  autosizeComposer();
  updateComposer();
});
composerInput.addEventListener("keydown", (event) => {
  if (shouldSubmitComposerKey(event)) {
    event.preventDefault();
    void submitComposer();
  }
});
deliveryMode.addEventListener("change", updateComposer);
stopButton.addEventListener("click", () => {
  if (projection) void submitIntent({ type: "abort" }, "Stop Pi", "");
});
discardCommands.addEventListener("click", async () => {
  const sessionId = currentSessionId;
  discardCommands.disabled = true;
  try {
    const snapshot = await connection.open(sessionId);
    if (snapshot === undefined || currentSessionId !== sessionId) return;
    projection = projectionFromSnapshot(snapshot);
    syncDeliveredUiResponses(sessionId, projection);
    connection.discard(sessionId);
    chatView.reset();
    summaryView.reset();
    scheduleRender();
    composerInput.focus({ preventScroll: true });
  } catch (error) {
    showLoadError(error);
  } finally {
    discardCommands.disabled = false;
  }
});
feed.addEventListener("click", (event) => {
  const card = event.target.closest?.("[data-request-id]");
  if (!card) return;
  const value = event.target.closest?.("[data-ui-value]")?.dataset.uiValue;
  const confirmed = event.target.closest?.("[data-ui-confirmed]")?.dataset.uiConfirmed;
  const cancelled = event.target.closest?.("[data-ui-cancel]");
  if (value !== undefined) void respondToQuestion(card, { value });
  else if (confirmed !== undefined)
    void respondToQuestion(card, { confirmed: confirmed === "true" });
  else if (cancelled) void respondToQuestion(card, { cancelled: true });
});
feed.addEventListener("submit", (event) => {
  const form = event.target.closest?.("[data-ui-form]");
  const card = form?.closest?.("[data-request-id]");
  if (!form || !card) return;
  event.preventDefault();
  const value = new FormData(form).get("answer");
  if (typeof value === "string") void respondToQuestion(card, { value });
});
openAgentsButton.addEventListener("click", () => setSidebar(true));
closeAgentsButton.addEventListener("click", () => setSidebar(false));
openSummaryButton.addEventListener("click", () => setSummary(true));
openTerminalButton.addEventListener("click", () => void openTerminal());
closeSummaryButton.addEventListener("click", () => setSummary(false));
backdrop.addEventListener("click", () => {
  setSidebar(false);
  setSummary(false);
});
document.addEventListener("keydown", trapDrawerFocus);
compactViewport.addEventListener("change", () => {
  setSidebar(false);
  autosizeComposer();
});
window.addEventListener("popstate", () => {
  const sessionId = sessionIdFromLocation();
  if (sessionId) void switchSession(sessionId, { history: false });
});
window.addEventListener("beforeunload", () => {
  saveBrowserState();
  directory.dispose();
  connection.close();
  summaryView.reset();
  terminalDrawer?.dispose();
  changesViewer.dispose();
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
});

currentSessionId = sessionIdFromLocation();
changesViewer.setSessionId(currentSessionId);
updateManageSessionLink(currentSessionId);
directory.setCurrent(currentSessionId);
setSidebar(false);
setSummary(false);
composerInput.value = currentSessionId ? memoryEntry(currentSessionId).draft : "";
autosizeComposer();
void directory.refresh().catch((error) => {
  agentList.textContent =
    error instanceof Error ? error.message : "Cloud agents could not be loaded";
});
void loadSession(currentSessionId);
