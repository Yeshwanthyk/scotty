import { createChatView, applyEvent, projectionFromSnapshot, sanitizeText } from "./chat.js";
import { createCloudAgentDirectory } from "./cloud-agents.js";
import { createConsoleTransport, createPiConnection } from "./pi-connection.js";
import { createSummaryView } from "./summary.js";

const byId = (id) => document.getElementById(id);
const sidebar = byId("agent-sidebar");
const backdrop = byId("agent-backdrop");
const openAgentsButton = byId("open-agents");
const closeAgentsButton = byId("close-agents");
const summaryPanel = byId("summary-panel");
const summaryContent = byId("summary-content");
const openSummaryButton = byId("open-summary");
const closeSummaryButton = byId("close-summary");
const agentList = byId("agent-list");
const agentCount = byId("agent-count");
const title = byId("agent-title");
const meta = byId("agent-meta");
const mobileTitle = byId("active-agent-title");
const mobileRepo = byId("active-agent-repo");
const connectionState = byId("connection-state");
const connectionLabel = byId("connection-label");
const transcript = byId("transcript");
const feed = byId("transcript-feed");
const composer = byId("composer");
const composerInput = byId("composer-input");
const composerHint = byId("composer-hint");
const sendButton = byId("send-message");
const stopButton = byId("stop-agent");
const deliveryControls = byId("delivery-controls");
const deliveryMode = byId("delivery-mode");
const recovery = byId("command-recovery");
const recoveryTitle = byId("recovery-title");
const recoveryCopy = byId("recovery-copy");
const discardCommands = byId("discard-commands");
const compactViewport = matchMedia("(max-width: 760px)");
const compactSummary = matchMedia("(max-width: 1180px)");
const memory = new Map();
const pendingUiResponses = new Set();
const deliveredUiResponses = new Set();
const chatView = createChatView({ document, feed, baseUrl: window.location.href });
const summaryView = createSummaryView({
  document,
  root: summaryContent,
  baseUrl: window.location.href,
  fetch: window.fetch.bind(window),
});

let currentSessionId;
let projection;
let renderFrame;
let loadGeneration = 0;
let sidebarOpener;
let summaryOpener;

function sessionIdFromLocation() {
  const match = window.location.pathname.match(/^\/s\/([^/]+)$/u);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function memoryEntry(sessionId) {
  let entry = memory.get(sessionId);
  if (!entry) {
    entry = { draft: "", scrollTop: 0 };
    memory.set(sessionId, entry);
  }
  return entry;
}

function saveBrowserState() {
  if (!currentSessionId) return;
  const entry = memoryEntry(currentSessionId);
  entry.draft = composerInput.value;
  entry.scrollTop = transcript.scrollTop;
}

function setConnection(state, message) {
  const labels = {
    connecting: "Connecting",
    connected: projection?.active ? "Pi working" : "Connected",
    reconnecting: "Reconnecting",
    changed: "Session changed",
    ambiguous: "Outcome unknown",
    unavailable: "Unavailable",
  };
  connectionState.dataset.state = state;
  connectionLabel.textContent = message ?? labels[state] ?? "Unavailable";
}

function updateAgentCopy(agent) {
  const agentTitle = agent?.title ?? currentSessionId ?? "Cloud agent";
  const repository = agent?.repo ?? "Cloud agent";
  const detail = [repository, agent?.branch].filter(Boolean).join(" · ");
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
  const lane = laneState();
  const paused = lane.paused;
  const active = Boolean(projection?.active);
  const queuedFollowUps = Array.isArray(projection?.queue?.followUp)
    ? projection.queue.followUp.length
    : 0;
  const hasDraft = composerInput.value.trim().length > 0;
  recovery.hidden = !paused;
  if (paused) {
    recoveryTitle.textContent =
      paused === "stale" ? "This session changed" : "Command outcome unknown";
    recoveryCopy.textContent =
      "Pending text is held. Discard it and refresh before sending anything else; Scotty will not replay it.";
  }
  deliveryControls.hidden = !active;
  stopButton.hidden = !active;
  stopButton.disabled = Boolean(paused);
  sendButton.disabled = Boolean(paused || !projection || !hasDraft);
  sendButton.textContent = active
    ? deliveryMode.value === "steer"
      ? "Steer"
      : "Follow up"
    : "Send";
  const nextComposerHint = paused
    ? paused === "stale"
      ? "Session changed · commands held"
      : "Outcome unknown · commands held"
    : lane.items.some((item) => item.state === "sending")
      ? "Submitting…"
      : queuedFollowUps === 1
        ? "1 follow-up queued · sends after Pi finishes"
        : queuedFollowUps > 1
          ? `${queuedFollowUps} follow-ups queued · send after Pi finishes`
          : active
            ? "Pi is working"
            : projection
              ? "Pi is ready"
              : "Loading session state…";
  if (composerHint.textContent !== nextComposerHint) {
    composerHint.textContent = nextComposerHint;
  }
}

function autosizeComposer() {
  composerInput.style.height = "0";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 180)}px`;
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
  heading.textContent = "Could not load this conversation";
  const copy = document.createElement("p");
  copy.textContent = error instanceof Error ? error.message : "Try this cloud agent again.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "button button-secondary";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => void loadSession(currentSessionId));
  state.append(heading, copy, retry);
  feed.append(state);
  updateComposer();
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
  directory.setCurrent(sessionId);
  updateAgentCopy(directory.find(sessionId));
  const entry = memoryEntry(sessionId);
  composerInput.value = entry.draft;
  autosizeComposer();
  if (options.history !== false)
    window.history.pushState({ sessionId }, "", `/s/${encodeURIComponent(sessionId)}`);
  setSidebar(false);
  setSummary(false);
  await loadSession(sessionId, { focusComposer: options.focusComposer });
}

function restoreDraft(text) {
  if (!text) return;
  composerInput.value = composerInput.value.trim() ? `${text}\n\n${composerInput.value}` : text;
  memoryEntry(currentSessionId).draft = composerInput.value;
  autosizeComposer();
}

async function submitIntent(intent, label, draft) {
  const authority = {
    sessionId: currentSessionId,
    epoch: projection.epoch,
    expectedSessionRevision: projection.sessionRevision,
  };
  let submission;
  try {
    submission = connection.command(authority, intent, label);
  } catch (error) {
    restoreDraft(draft);
    updateComposer();
    throw error;
  }
  const outcome = await submission.outcome;
  if (outcome.status !== "accepted") {
    restoreDraft(draft);
    setConnection(
      outcome.status === "ambiguous"
        ? "ambiguous"
        : outcome.status === "stale"
          ? "changed"
          : "unavailable",
      outcome.message,
    );
  }
  updateComposer();
  return outcome;
}

async function submitComposer() {
  if (!projection || !currentSessionId) return;
  const draft = composerInput.value;
  const message = draft.trim();
  if (!message) return;
  const intent = projection.active
    ? { type: deliveryMode.value === "steer" ? "steer" : "follow_up", message }
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
  const compact = compactSummary.matches;
  const expanded = compact ? open : true;
  if (open) setSidebar(false);
  summaryPanel.dataset.open = String(expanded);
  summaryPanel.inert = compact && !expanded;
  openSummaryButton.setAttribute("aria-expanded", String(expanded));
  updateBackdrop();
  if (open && compact) {
    summaryOpener = document.activeElement;
    closeSummaryButton.focus({ preventScroll: true });
  } else if (!open && summaryOpener && compact) {
    summaryOpener.focus({ preventScroll: true });
    summaryOpener = undefined;
  }
}

function updateBackdrop() {
  const sidebarOpen = compactViewport.matches && sidebar.dataset.open === "true";
  const summaryOpen = compactSummary.matches && summaryPanel.dataset.open === "true";
  backdrop.hidden = !sidebarOpen && !summaryOpen;
}

function trapDrawerFocus(event) {
  const activeDrawer =
    compactViewport.matches && sidebar.dataset.open === "true"
      ? sidebar
      : compactSummary.matches && summaryPanel.dataset.open === "true"
        ? summaryPanel
        : undefined;
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
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitComposer();
  }
});
deliveryMode.addEventListener("change", updateComposer);
stopButton.addEventListener("click", () => {
  if (projection) void submitIntent({ type: "abort" }, "Stop Pi", "");
});
discardCommands.addEventListener("click", async () => {
  discardCommands.disabled = true;
  try {
    const snapshot = await connection.open(currentSessionId);
    if (snapshot === undefined) return;
    projection = projectionFromSnapshot(snapshot);
    syncDeliveredUiResponses(currentSessionId, projection);
    connection.discard(currentSessionId);
    chatView.reset();
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
closeSummaryButton.addEventListener("click", () => setSummary(false));
backdrop.addEventListener("click", () => {
  setSidebar(false);
  setSummary(false);
});
document.addEventListener("keydown", trapDrawerFocus);
compactViewport.addEventListener("change", () => setSidebar(false));
compactSummary.addEventListener("change", () => setSummary(false));
window.addEventListener("popstate", () => {
  const sessionId = sessionIdFromLocation();
  if (sessionId) void switchSession(sessionId, { history: false });
});
window.addEventListener("beforeunload", () => {
  saveBrowserState();
  directory.dispose();
  connection.close();
  summaryView.reset();
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
});

currentSessionId = sessionIdFromLocation();
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
