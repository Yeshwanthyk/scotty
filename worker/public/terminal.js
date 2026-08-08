import { groupSessionsByRepository, sessionTitle } from "/session-form.js";
import { createCommandLane } from "/terminal-command-lane.js";
import { createComposerDrafts } from "/terminal-draft.js";
import { renderCommandReceipts } from "/terminal-command-view.js";
import { createConsoleClient } from "/terminal-console-client.js";
import { composerText, hasAvailableRuntime } from "/terminal-input.js";
import {
  browserEvidenceAttachment,
  browserEvidenceNoFrameCopy,
  browserEvidenceStatusLabel,
  browserEvidenceSummary,
} from "/terminal-evidence-attachment.js";
import { assistantMarkdownFragment } from "/terminal-markdown.js";
import { evictableSessions, hasBlockingCommands } from "/terminal-session-cache.js";
import { projectSessionSummary } from "/terminal-summary-projection.js";
import {
  createUiResponseTracker,
  markUiResponseDelivered,
  sendUiResponseForProjection,
  uiResponseCardState,
} from "/terminal-ui-response.js";
import {
  applyEvent,
  blankProjection,
  contentParts,
  eventPayload,
  firstArray,
  firstObject,
  firstString,
  messageText,
  projectionFromSnapshot,
} from "/terminal-projection.js";
import { conversationItems } from "/terminal-timeline.js";
import {
  createWorklogView,
  meaningfulWorklogAnnouncement,
  semanticSignature,
} from "/terminal-worklog-view.js";

const CACHE_LIMIT = 6;
const compactViewport = window.matchMedia("(max-width: 780px)");
const summaryCompactViewport = window.matchMedia("(max-width: 1100px)");
const coarsePointer = window.matchMedia("(pointer: coarse)");

const appShell = document.querySelector(".app-shell");
const workspaceList = document.querySelector("#workspace-list");
const currentRepo = document.querySelector("#current-repo");
const currentMeta = document.querySelector("#current-meta");
const pickerTitle = document.querySelector("#picker-title");
const pickerProject = document.querySelector("#picker-project");
const connectionState = document.querySelector("#connection-state");
const connectionLabel = document.querySelector("#connection-label");
const openDrawerButton = document.querySelector("#open-drawer");
const closeDrawerButton = document.querySelector("#close-drawer");
const drawerBackdrop = document.querySelector("#drawer-backdrop");
const workspaceRail = document.querySelector("#workspace-rail");
const sessionWorkspace = document.querySelector("#session-workspace");
const worklog = document.querySelector("#worklog");
const worklogFeed = document.querySelector("#worklog-feed");
const worklogAnnouncer = document.querySelector("#worklog-announcer");
const composer = document.querySelector("#composer");
const composerInput = document.querySelector("#composer-input");
const composerSend = document.querySelector("#composer-send");
const composerStatus = document.querySelector("#composer-status");
const deliveryModeButton = document.querySelector("#delivery-mode");
const deliveryModeLabel = document.querySelector("#delivery-mode-label");
const deliveryMenu = document.querySelector("#delivery-menu");
const runtimeControlsButton = document.querySelector("#runtime-controls");
const runtimeMenu = document.querySelector("#runtime-menu");
const runtimeModelLabel = document.querySelector("#runtime-model-label");
const runtimeThinkingLabel = document.querySelector("#runtime-thinking-label");
const modelSelect = document.querySelector("#model-select");
const thinkingSelect = document.querySelector("#thinking-select");
const stopRunButton = document.querySelector("#stop-run");
const deliveryReceipts = document.querySelector("#delivery-receipts");
const commandRecovery = document.querySelector("#command-recovery");
const commandRecoveryTitle = document.querySelector("#command-recovery-title");
const commandRecoveryCopy = document.querySelector("#command-recovery-copy");
const discardHeldCommandsButton = document.querySelector("#discard-held-commands");
const openActivityButton = document.querySelector("#open-activity");
const closeActivityButton = document.querySelector("#close-activity");
const activityDrawer = document.querySelector("#activity-drawer");
const activityBackdrop = document.querySelector("#activity-backdrop");
const activityContent = document.querySelector("#activity-content");
const activityIndicator = document.querySelector("#activity-indicator");
const openSummaryButton = document.querySelector("#open-summary");
const closeSummaryButton = document.querySelector("#close-summary");
const summarySidebar = document.querySelector("#summary-sidebar");
const summaryBackdrop = document.querySelector("#summary-backdrop");
const summaryContent = document.querySelector("#summary-content");
const toastRegion = document.querySelector("#toast-region");

let currentSessionId = sessionIdFromLocation();
let currentProjection;
let eventSource;
let snapshotController;
let workspaceListSignature;
let sessions = [];
let disposed = false;
let deliveryMode = "follow_up";
let composing = false;
let renderScheduled = false;
let runtimeOptionsSignature;
let renderedSummaryKey;
let summaryRenderVersion = 0;
let compactSurface;
let desktopSummaryOpen = true;
let localCommandItems = [];
const sessionCache = new Map();
const composerDrafts = createComposerDrafts(cacheEntry);
const uiResponses = createUiResponseTracker();
const prefetching = new Map();
const disclosureState = new Map();
const worklogView = createWorklogView(worklogFeed);
const consoleClient = createConsoleClient({
  fetch: window.fetch.bind(window),
  eventSource: (url) => new EventSource(url),
  origin: window.location.origin,
});
const commandLane = createCommandLane({
  send: (sessionId, envelope) => consoleClient.command(sessionId, envelope),
  randomUUID: () => crypto.randomUUID(),
  onChange: (items) => {
    localCommandItems = items;
    if (currentProjection) renderReceipts();
    updateComposer();
  },
});

function sessionIdFromLocation() {
  const match = window.location.pathname.match(/^\/s\/([^/]+)$/u);
  return match ? decodeURIComponent(match[1]) : "";
}

function cacheEntry(sessionId) {
  let entry = sessionCache.get(sessionId);
  if (!entry) {
    entry = {
      projection: blankProjection(),
      draft: "",
      scrollTop: 0,
      touchedAt: Date.now(),
    };
    sessionCache.set(sessionId, entry);
  }
  entry.touchedAt = Date.now();
  trimCache();
  return entry;
}

function trimCache() {
  if (sessionCache.size <= CACHE_LIMIT) return;
  const candidates = evictableSessions(sessionCache.entries(), currentSessionId, (sessionId) => {
    const laneItems = commandLane.state(sessionId).items;
    return hasBlockingCommands(laneItems) || uiResponses.hasPending(sessionId);
  });
  while (sessionCache.size > CACHE_LIMIT && candidates.length > 0) {
    sessionCache.delete(candidates.shift()[0]);
  }
}

function setConnection(state, label) {
  connectionState.dataset.state = state;
  connectionLabel.textContent = label;
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function setWorklogFocusKey(element, key) {
  element.setAttribute("data-worklog-focus-key", key);
  return element;
}

function renderAssistantCopy(text, focusKeyPrefix) {
  const element = document.createElement("div");
  element.className = "message-copy markdown";
  element.append(
    assistantMarkdownFragment(document, text, {
      baseUrl: window.location.href,
      focusKeyPrefix,
    }),
  );
  return element;
}

function announceWorklog(message) {
  if (!message) return;
  worklogAnnouncer.textContent = "";
  requestAnimationFrame(() => {
    worklogAnnouncer.textContent = message;
  });
}

function uniqueWorklogKey(sessionId, key, occurrences) {
  const count = occurrences.get(key) ?? 0;
  occurrences.set(key, count + 1);
  return `${sessionId}:${key}:${count}`;
}

function conversationTools(conversation) {
  return [
    ...conversation.toolIds
      .map((id) => currentProjection.tools.get(id))
      .filter((tool) => tool && !secondaryActivityTool(tool)),
    ...conversation.inlineTools.filter((tool) => !secondaryActivityTool(tool)),
  ];
}

function assistantTurnParts(conversation) {
  const textParts = [];
  const reasoningParts = [];
  for (const message of conversation.assistants) {
    const parts = contentParts(message);
    if (parts.length === 0) {
      const text = messageText(message.text ?? message.message);
      if (text) textParts.push(text);
      continue;
    }
    for (const part of parts) {
      if (typeof part === "string") {
        if (part) textParts.push(part);
        continue;
      }
      const type = firstString(part?.type, "text");
      if (type === "text") {
        const text = messageText(part);
        if (text) textParts.push(text);
      } else if (type === "thinking" || type === "reasoning") {
        const text = messageText(part);
        if (text) reasoningParts.push(text);
      }
    }
  }
  return { textParts, reasoningParts, tools: conversationTools(conversation) };
}

function worklogEntries() {
  const entries = [];
  const occurrences = new Map();
  const { items, claimedToolIds } = conversationItems(currentProjection.messages);
  let lastConversation = items.findLast((item) => item.kind === "conversation");
  for (const tool of currentProjection.tools.values()) {
    if (claimedToolIds.has(tool.id) || secondaryActivityTool(tool)) continue;
    if (!lastConversation) {
      lastConversation = newConversation(undefined, "activity-only");
      items.push(lastConversation);
    }
    addConversationTool(lastConversation, tool.id);
  }
  const lastConversationIndex = items.findLastIndex((item) => item.kind === "conversation");
  for (const [index, item] of items.entries()) {
    if (item.kind === "system") {
      const text = messageText(item.message.content ?? item.message.text ?? item.message.message);
      if (!text) continue;
      entries.push({
        key: uniqueWorklogKey(currentSessionId, `system:${index}`, occurrences),
        signature: semanticSignature(text),
        render: () => renderSystemMessage(item.message),
      });
      continue;
    }
    if (item.user) {
      const delivery = firstString(
        item.user.deliveryMode,
        item.user.delivery_mode,
        item.user.source,
      );
      entries.push({
        key: uniqueWorklogKey(currentSessionId, `user:${item.key}`, occurrences),
        signature: semanticSignature([
          messageText(item.user.content ?? item.user.text ?? item.user.message),
          delivery,
        ]),
        render: () => renderUserMessage(item.user),
      });
    }
    const isLatest = index === lastConversationIndex;
    const parts = assistantTurnParts(item);
    if (
      parts.textParts.length === 0 &&
      parts.reasoningParts.length === 0 &&
      parts.tools.length === 0
    )
      continue;
    entries.push({
      key: uniqueWorklogKey(currentSessionId, `assistant:${item.key}`, occurrences),
      signature: semanticSignature([
        parts.textParts,
        parts.reasoningParts,
        parts.tools,
        Boolean(currentProjection.active && isLatest),
      ]),
      render: () => renderAssistantTurn(item, isLatest, parts),
    });
  }
  for (const request of currentProjection.pendingUi.values()) {
    entries.push({
      key: uniqueWorklogKey(currentSessionId, `request:${request.id}`, occurrences),
      signature: semanticSignature([
        request,
        currentProjection.deliveredUiResponses.has(request.id),
      ]),
      render: () => renderUiRequest(request),
    });
  }
  if (entries.length === 0) {
    entries.push({
      key: uniqueWorklogKey(currentSessionId, "empty", occurrences),
      signature: "empty",
      render: () => {
        const empty = document.createElement("div");
        empty.className = "feed-empty";
        empty.append(textElement("p", "", "This Pi session has no messages yet."));
        return empty;
      },
    });
  }
  return entries;
}

function renderProjection({ restoreScroll = false } = {}) {
  renderScheduled = false;
  if (!currentProjection) return;
  const nearBottom = worklog.scrollHeight - worklog.scrollTop - worklog.clientHeight < 100;
  const entries = worklogEntries();
  worklogView.update(entries);
  worklogFeed.setAttribute("aria-busy", "false");
  renderReceipts();
  renderActivity();
  renderSummary();
  updateComposer();

  const entry = cacheEntry(currentSessionId);
  requestAnimationFrame(() => {
    if (restoreScroll) worklog.scrollTop = entry.scrollTop;
    else if (nearBottom) worklog.scrollTop = worklog.scrollHeight;
  });
}

function summaryReplayLink(evidence) {
  const link = textElement("a", "summary-replay-link", "Replay");
  link.href = evidence.paths.replay;
  link.dataset.summaryFocusKey = `evidence:${evidence.jobId}:replay`;
  return link;
}

function summaryEvidenceMeta(status, assertionCopy) {
  const meta = document.createElement("div");
  meta.className = "summary-evidence-meta";
  const state = document.createElement("span");
  state.className = "summary-evidence-status";
  state.append(
    textElement("i", "summary-evidence-dot", ""),
    document.createTextNode(browserEvidenceStatusLabel(status)),
  );
  meta.append(state, textElement("span", "summary-assertions", assertionCopy));
  return meta;
}

function summaryEvidenceActions(evidence) {
  const actions = document.createElement("div");
  actions.className = "summary-evidence-actions";
  actions.append(summaryReplayLink(evidence));
  return actions;
}

function renderReferencedEvidenceUnavailable(jobId) {
  const card = document.createElement("article");
  card.className = "summary-evidence-card";
  card.dataset.state = "unavailable";
  card.setAttribute("aria-label", `Unavailable evidence ${jobId}`);
  card.append(
    summaryEvidenceMeta(undefined, "Not verified"),
    textElement(
      "p",
      "summary-evidence-message",
      "This reference was not produced by a validated browser test in this conversation.",
    ),
  );
  return card;
}

function renderSummaryEvidenceLoading(evidence, renderVersion, sessionId) {
  const card = document.createElement("article");
  card.className = "summary-evidence-card";
  card.dataset.status = evidence.status;
  card.setAttribute("aria-label", `Browser evidence ${evidence.jobId}`);
  card.append(
    summaryEvidenceMeta(evidence.status, "Loading assertions…"),
    ...(evidence.frameCount === 0
      ? [textElement("p", "summary-evidence-message", browserEvidenceNoFrameCopy(evidence.status))]
      : []),
    summaryEvidenceActions(evidence),
  );
  void loadSummaryEvidence(card, evidence, renderVersion, sessionId);
  return card;
}

function renderSummaryEvidenceFailure(card, evidence, state) {
  const expired = state === "expired";
  card.dataset.state = state;
  delete card.dataset.status;
  card.replaceChildren(
    summaryEvidenceMeta(undefined, expired ? "Expired" : "Unavailable"),
    textElement(
      "p",
      "summary-evidence-message",
      expired
        ? "These screenshots are no longer retained."
        : "The authenticated evidence summary is unavailable right now.",
    ),
    ...(expired ? [] : [summaryEvidenceActions(evidence)]),
  );
}

async function loadSummaryEvidence(card, evidence, renderVersion, sessionId) {
  let summary;
  let failureState = "unavailable";
  try {
    const response = await fetch(evidence.paths.summary, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) failureState = "expired";
    } else {
      summary = browserEvidenceSummary(await response.json(), evidence);
    }
  } catch {
    summary = undefined;
  }
  if (renderVersion !== summaryRenderVersion || sessionId !== currentSessionId) return;
  if (!summary) {
    renderSummaryEvidenceFailure(card, evidence, failureState);
    return;
  }

  card.dataset.status = summary.status;
  delete card.dataset.state;
  const assertionCopy = `${summary.passedAssertions}/${summary.totalAssertions} assertions passed`;
  card.replaceChildren(summaryEvidenceMeta(summary.status, assertionCopy));
  if (summary.frames.length > 0) {
    for (const frame of summary.frames) {
      const path = evidence.paths.frame(frame.frameId);
      if (!path) continue;
      const figure = document.createElement("figure");
      figure.className = "summary-frame";
      const image = document.createElement("img");
      image.src = path;
      image.alt = `Screenshot for step ${frame.stepIndex + 1}: ${frame.stepName}`;
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "same-origin";
      image.addEventListener("error", () => {
        image.remove();
        figure.prepend(
          textElement("p", "summary-evidence-message", "Screenshot expired or unavailable."),
        );
      });
      figure.append(
        image,
        textElement("figcaption", "", `Step ${frame.stepIndex + 1} · ${frame.stepName}`),
      );
      card.append(figure);
    }
  } else {
    card.append(
      textElement("p", "summary-evidence-message", browserEvidenceNoFrameCopy(summary.status)),
    );
  }
  card.append(summaryEvidenceActions(evidence));
}

function summaryEmptyState(title, copy) {
  const empty = document.createElement("div");
  empty.className = "summary-empty";
  empty.append(
    textElement("span", "summary-empty-mark", "S"),
    textElement("strong", "", title),
    textElement("p", "summary-empty-copy", copy),
  );
  return empty;
}

function renderSummary() {
  const projection = projectSessionSummary(
    currentProjection?.messages,
    currentProjection?.tools,
    currentSessionId,
  );
  const renderKey = `${currentSessionId}:${semanticSignature(projection)}`;
  if (renderKey === renderedSummaryKey) return;
  renderedSummaryKey = renderKey;
  const renderVersion = ++summaryRenderVersion;
  const focusedKey = document.activeElement?.closest?.("[data-summary-focus-key]")?.dataset
    .summaryFocusKey;
  summaryContent.setAttribute("aria-busy", "false");

  if (projection.kind === "empty") {
    summaryContent.replaceChildren(
      summaryEmptyState(
        "No update yet",
        "Pi’s latest assistant update and any referenced browser evidence will appear here.",
      ),
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  const updateSection = document.createElement("section");
  updateSection.setAttribute("aria-labelledby", "summary-update-title");
  const updateTitle = textElement("h2", "summary-section-title", "Latest update");
  updateTitle.id = "summary-update-title";
  const update = document.createElement("div");
  update.className = "summary-update markdown";
  update.append(
    assistantMarkdownFragment(document, projection.update, {
      baseUrl: window.location.href,
      focusKeyPrefix: `summary:${currentSessionId}:${projection.conversationKey}`,
    }),
  );
  updateSection.append(updateTitle, update);
  fragment.append(updateSection);

  const evidenceSection = document.createElement("section");
  evidenceSection.className = "summary-evidence-section";
  evidenceSection.setAttribute("aria-labelledby", "summary-evidence-title");
  const evidenceTitle = textElement("h2", "summary-section-title", "Evidence");
  evidenceTitle.id = "summary-evidence-title";
  evidenceSection.append(evidenceTitle);
  if (projection.evidence.length === 0) {
    evidenceSection.append(
      textElement(
        "p",
        "summary-evidence-empty",
        "No browser evidence is referenced in this update.",
      ),
    );
  } else {
    const list = document.createElement("div");
    list.className = "summary-evidence-list";
    for (const evidence of projection.evidence) {
      list.append(
        evidence.kind === "evidence"
          ? renderSummaryEvidenceLoading(evidence, renderVersion, currentSessionId)
          : renderReferencedEvidenceUnavailable(evidence.jobId),
      );
    }
    evidenceSection.append(list);
  }
  fragment.append(evidenceSection);
  summaryContent.replaceChildren(fragment);

  if (focusedKey) {
    const replacement = [...summaryContent.querySelectorAll("[data-summary-focus-key]")].find(
      (candidate) => candidate.dataset.summaryFocusKey === focusedKey,
    );
    replacement?.focus({ preventScroll: true });
  }
}

function renderSummaryUnavailable() {
  renderedSummaryKey = undefined;
  summaryRenderVersion += 1;
  summaryContent.setAttribute("aria-busy", "false");
  summaryContent.replaceChildren(
    summaryEmptyState(
      "Summary unavailable",
      "Scotty could not load the transcript needed to reconstruct this Summary.",
    ),
  );
}

function renderSummaryLoading() {
  renderedSummaryKey = undefined;
  summaryRenderVersion += 1;
  summaryContent.setAttribute("aria-busy", "true");
  const placeholder = document.createElement("div");
  placeholder.className = "summary-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.append(
    textElement("span", "", ""),
    textElement("span", "", ""),
    textElement("span", "", ""),
  );
  summaryContent.replaceChildren(
    placeholder,
    textElement("p", "summary-loading", "Loading Summary…"),
  );
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => renderProjection());
}

function newConversation(user, key) {
  return {
    kind: "conversation",
    key,
    user,
    assistants: [],
    toolIds: [],
    inlineTools: [],
  };
}

function addConversationTool(conversation, id) {
  if (id && !conversation.toolIds.includes(id)) conversation.toolIds.push(id);
}

function renderUserMessage(message) {
  const turn = document.createElement("article");
  turn.className = "worklog-turn user";
  const body = document.createElement("div");
  body.className = "turn-body";
  const text = messageText(message.content ?? message.text ?? message.message);
  if (text) body.append(textElement("div", "message-copy", text));
  const delivery = firstString(message.deliveryMode, message.delivery_mode, message.source);
  if (delivery === "steer" || delivery === "follow_up" || delivery === "queue") {
    body.append(
      textElement("div", "message-meta", delivery === "steer" ? "Steered" : "From queue"),
    );
  }
  turn.append(body);
  return turn;
}

function renderAssistantTurn(conversation, isLatest, parts = assistantTurnParts(conversation)) {
  const { textParts, reasoningParts, tools } = parts;
  if (textParts.length === 0 && reasoningParts.length === 0 && tools.length === 0) return undefined;

  const turn = document.createElement("article");
  turn.className = "worklog-turn assistant";
  turn.append(textElement("div", "speaker-label pi", "PI"));
  const body = document.createElement("div");
  body.className = "turn-body";
  for (const [index, text] of textParts.entries()) {
    body.append(
      renderAssistantCopy(text, `markdown:${currentSessionId}:${conversation.key}:${index}`),
    );
  }
  if (reasoningParts.length > 0 || tools.length > 0) {
    body.append(
      renderActivityFold(
        reasoningParts,
        tools,
        Boolean(currentProjection.active && isLatest),
        conversation.key,
      ),
    );
  }
  turn.append(body);
  return turn;
}

function applyDisclosureState(details, key, defaultOpen = false) {
  const stateKey = `${currentSessionId}:${key}`;
  details.open = disclosureState.has(stateKey) ? disclosureState.get(stateKey) : defaultOpen;
  details.addEventListener("toggle", () => {
    disclosureState.set(stateKey, details.open);
  });
}

function renderActivityFold(reasoningParts, tools, active, conversationKey) {
  const details = document.createElement("details");
  details.className = "turn-activity";
  applyDisclosureState(
    details,
    `activity:${conversationKey}`,
    active && tools.some((tool) => tool.status === "running"),
  );
  const stepCount = tools.length + (reasoningParts.length > 0 ? 1 : 0);
  const summary = document.createElement("summary");
  setWorklogFocusKey(summary, `activity:${conversationKey}`);
  summary.append(
    textElement("span", "activity-caret", "›"),
    textElement("span", "activity-label", active ? "Working" : "Worked"),
    textElement("span", "activity-count", `${stepCount} ${stepCount === 1 ? "step" : "steps"}`),
  );
  const body = document.createElement("div");
  body.className = "turn-activity-body";
  if (reasoningParts.length > 0) {
    const reasoning = document.createElement("details");
    reasoning.className = "thinking";
    applyDisclosureState(reasoning, `reasoning:${conversationKey}`);
    reasoning.append(
      setWorklogFocusKey(textElement("summary", "", "Reasoning"), `reasoning:${conversationKey}`),
    );
    reasoning.append(textElement("div", "thinking-copy", reasoningParts.join("\n\n")));
    body.append(reasoning);
  }
  if (tools.length > 0) {
    const stack = document.createElement("div");
    stack.className = "tool-stack";
    for (const [index, tool] of tools.entries()) {
      stack.append(renderTool(tool, `${conversationKey}:${tool.id ?? index}`));
    }
    body.append(stack);
  }
  details.append(summary, body);
  return details;
}

function renderSystemMessage(message) {
  const text = messageText(message.content ?? message.text ?? message.message);
  if (!text) return undefined;
  const turn = document.createElement("article");
  turn.className = "worklog-turn system";
  turn.append(textElement("div", "speaker-label system", "SYSTEM"));
  const body = document.createElement("div");
  body.className = "turn-body";
  body.append(textElement("div", "message-copy", text));
  turn.append(body);
  return turn;
}

function renderTool(tool, disclosureKey) {
  const details = document.createElement("details");
  details.className = "tool-row";
  const status = tool.error || tool.status === "error" ? "error" : (tool.status ?? "done");
  const evidence = browserEvidenceAttachment(tool, currentSessionId);
  applyDisclosureState(
    details,
    `tool:${disclosureKey}`,
    status === "error" || evidence !== undefined,
  );
  const summary = document.createElement("summary");
  setWorklogFocusKey(summary, `tool:${disclosureKey}`);
  summary.append(
    textElement(
      "i",
      `tool-status ${status === "running" ? "running" : status === "error" ? "error" : ""}`,
      "",
    ),
    textElement("span", "tool-name", firstString(tool.name, tool.toolName, "tool")),
    textElement("span", "tool-summary", toolSummary(tool)),
    textElement(
      "span",
      `tool-result ${status === "running" ? "running" : status === "error" ? "error" : ""}`,
      status === "running" ? "running" : status === "error" ? "failed" : "done",
    ),
  );
  details.append(summary);
  const diff = unifiedDiff(tool);
  if (diff) details.append(renderDiff(tool, diff));
  else {
    const body = textElement("div", "tool-body", toolBody(tool));
    details.append(body);
  }
  if (evidence !== undefined) details.append(renderBrowserEvidenceAttachment(evidence));
  return details;
}

function renderBrowserEvidenceAttachment(evidence) {
  const attachment = document.createElement("section");
  attachment.className = "browser-evidence";
  attachment.setAttribute("aria-label", "Browser test evidence");
  if (evidence.kind !== "evidence") {
    attachment.dataset.state = "unavailable";
    attachment.append(
      textElement("strong", "browser-evidence-title", "Evidence unavailable"),
      textElement(
        "p",
        "browser-evidence-unavailable",
        "This tool result could not be safely matched to this session.",
      ),
    );
    return attachment;
  }

  renderBrowserEvidenceLoading(attachment, evidence);
  void loadBrowserEvidenceSummary(attachment, evidence);
  return attachment;
}

function evidenceHeader(status, passedAssertions, totalAssertions) {
  const header = document.createElement("header");
  header.className = "browser-evidence-header";
  const title = document.createElement("span");
  title.className = "browser-evidence-title";
  title.append(
    textElement("i", "browser-evidence-dot", ""),
    document.createTextNode(browserEvidenceStatusLabel(status)),
  );
  const assertionCopy =
    totalAssertions === undefined
      ? "Loading assertions…"
      : `${passedAssertions}/${totalAssertions} assertions passed`;
  header.append(title, textElement("span", "browser-evidence-assertions", assertionCopy));
  return header;
}

function replayLink(evidence) {
  const link = textElement("a", "browser-evidence-link", "Open Replay");
  link.href = evidence.paths.replay;
  link.setAttribute("data-worklog-focus-key", `evidence:${evidence.jobId}:replay`);
  return link;
}

function renderBrowserEvidenceLoading(attachment, evidence) {
  attachment.dataset.status = evidence.status;
  attachment.replaceChildren(evidenceHeader(evidence.status), replayLink(evidence));
  if (evidence.frameCount === 0)
    attachment.append(
      textElement("p", "browser-evidence-no-frame", browserEvidenceNoFrameCopy(evidence.status)),
    );
}

async function loadBrowserEvidenceSummary(attachment, evidence) {
  let summary;
  try {
    const response = await fetch(evidence.paths.summary, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Evidence summary unavailable");
    summary = browserEvidenceSummary(await response.json(), evidence);
  } catch {
    summary = undefined;
  }
  if (!summary) {
    attachment.dataset.state = "unavailable";
    attachment.replaceChildren(
      textElement("strong", "browser-evidence-title", "Evidence unavailable"),
      textElement(
        "p",
        "browser-evidence-unavailable",
        "The authenticated evidence summary is not available.",
      ),
      replayLink(evidence),
    );
    return;
  }

  attachment.dataset.status = summary.status;
  attachment.replaceChildren(
    evidenceHeader(summary.status, summary.passedAssertions, summary.totalAssertions),
  );
  if (summary.frames.length > 0) {
    const frames = document.createElement("div");
    frames.className = "browser-evidence-frames";
    frames.setAttribute("aria-label", "Verified screenshots");
    for (const frame of summary.frames) {
      const path = evidence.paths.frame(frame.frameId);
      if (!path) continue;
      const image = document.createElement("img");
      image.src = path;
      image.alt = `Screenshot for step ${frame.stepIndex + 1}: ${frame.stepName}`;
      image.loading = "lazy";
      image.decoding = "async";
      frames.append(image);
    }
    attachment.append(frames);
  } else {
    attachment.append(
      textElement("p", "browser-evidence-no-frame", browserEvidenceNoFrameCopy(summary.status)),
    );
  }
  attachment.append(replayLink(evidence));
}

function secondaryActivityTool(tool) {
  const name = String(tool?.name ?? tool?.toolName ?? "").toLowerCase();
  return name.includes("task") || name.includes("subagent") || name.includes("workflow");
}

function toolSummary(tool) {
  const args = firstObject(tool.arguments, tool.args, tool.input);
  return (
    firstString(
      args.path,
      args.file_path,
      args.command,
      args.query,
      args.task,
      args.description,
      tool.summary,
    ) ?? "activity"
  );
}

function toolBody(tool) {
  const value = tool.error ?? tool.result ?? tool.output ?? tool.arguments ?? tool.args;
  if (typeof value === "string") return value;
  const content = firstArray(value?.content);
  if (content.length > 0) return messageText(content);
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function unifiedDiff(tool) {
  const values = [
    tool.diff,
    tool.patch,
    tool.result?.diff,
    tool.result?.patch,
    tool.result?.details?.diff,
    tool.result?.details?.patch,
    tool.output?.diff,
    tool.output?.details?.diff,
    tool.arguments?.diff,
    tool.arguments?.patch,
  ];
  const candidate = values.find(
    (value) => typeof value === "string" && /(^|\n)@@\s+-\d+/u.test(value),
  );
  return candidate;
}

function renderDiff(tool, diff) {
  const body = document.createElement("div");
  body.className = "tool-body edit-tool-body";
  const toolbar = document.createElement("div");
  toolbar.className = "diff-toolbar";
  const path = firstString(
    tool.arguments?.path,
    tool.arguments?.file_path,
    tool.path,
    "Edited file",
  );
  const lines = diff.split("\n");
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const stats = document.createElement("span");
  stats.className = "diff-stats";
  stats.append(
    textElement("span", "diff-added", `+${added}`),
    textElement("span", "diff-removed", `−${removed}`),
  );
  toolbar.append(textElement("strong", "diff-path", path), stats);

  const code = document.createElement("div");
  code.className = "diff-code";
  let oldLine;
  let newLine;
  for (const line of lines) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      code.append(textElement("div", "diff-hunk", line));
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const row = document.createElement("div");
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "";
    row.className = `diff-row ${kind}`;
    const oldNumber = kind === "add" ? "" : (oldLine ?? "");
    const newNumber = kind === "remove" ? "" : (newLine ?? "");
    row.append(
      textElement("span", "diff-line-number", String(oldNumber)),
      textElement("span", "diff-line-number", String(newNumber)),
      textElement("span", "diff-code-line", line),
    );
    code.append(row);
    if (kind !== "add" && oldLine !== undefined) oldLine += 1;
    if (kind !== "remove" && newLine !== undefined) newLine += 1;
  }
  body.append(toolbar, code);
  return body;
}

function syncUiResponseState(sessionId, projection) {
  uiResponses.sync(sessionId, projection.epoch, projection.pendingUi.keys());
  for (const requestId of projection.pendingUi.keys())
    if (uiResponses.isDelivered(sessionId, projection.epoch, requestId))
      projection.deliveredUiResponses.add(requestId);
}

function renderUiRequest(request) {
  const turn = document.createElement("article");
  turn.className = "worklog-turn system";
  turn.append(textElement("div", "speaker-label system", "QUESTION"));
  const body = document.createElement("div");
  body.className = "turn-body";
  body.append(renderAskCard(request));
  turn.append(body);
  return turn;
}

function renderAskCard(request) {
  const card = document.createElement("section");
  card.className = "ask-user-card";
  card.dataset.requestId = request.id;
  const header = document.createElement("header");
  header.className = "ask-user-header";
  const delivered =
    currentProjection.deliveredUiResponses.has(request.id) ||
    uiResponses.isDelivered(currentSessionId, currentProjection.epoch, request.id);
  const sending = uiResponses.isPending(currentSessionId, currentProjection.epoch, request.id);
  const responseState = uiResponseCardState(delivered, sending);
  header.append(
    textElement("span", "", "PI NEEDS YOUR INPUT"),
    textElement("span", "ask-state", responseState.label),
  );
  const body = document.createElement("div");
  body.className = "ask-user-body";
  const title = firstString(request.title, request.context, request.message);
  if (title) body.append(textElement("p", "ask-context", title));
  body.append(
    textElement(
      "p",
      "ask-question",
      firstString(request.question, request.prompt, request.label, "Choose a response"),
    ),
  );
  const options =
    request.method === "confirm"
      ? [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ]
      : firstArray(request.options, request.choices, request.items);
  if (options.length > 0) {
    const optionList = document.createElement("div");
    optionList.className = "ask-options";
    options.forEach((option, index) => {
      const value =
        typeof option === "string"
          ? option
          : firstString(option.value, option.label, option.title, String(index + 1));
      const button = document.createElement("button");
      button.className = "ask-option";
      button.type = "button";
      const optionId =
        typeof option === "object"
          ? (firstString(option.id, option.optionId, option.option_id) ??
            semanticSignature(option.value ?? value))
          : semanticSignature(value);
      setWorklogFocusKey(button, `ask:${request.id}:option:${index}:${optionId}`);
      button.dataset.uiResponse =
        typeof option === "object" ? JSON.stringify(option.value ?? value) : value;
      if (typeof option === "object") button.dataset.uiResponseJson = "";
      button.append(
        textElement("span", "ask-option-marker", String(index + 1)),
        (() => {
          const copy = document.createElement("span");
          copy.className = "ask-option-copy";
          copy.append(textElement("strong", "", value));
          const description = typeof option === "string" ? undefined : option.description;
          if (description) copy.append(textElement("small", "", description));
          return copy;
        })(),
      );
      optionList.append(button);
    });
    body.append(optionList);
  }
  if (request.method !== "confirm") {
    const custom = document.createElement("form");
    custom.className = "ask-custom";
    custom.dataset.uiCustom = "";
    const input = document.createElement(request.method === "editor" ? "textarea" : "input");
    input.name = "answer";
    input.placeholder = options.length > 0 ? "Or write your own answer…" : "Your response…";
    input.setAttribute("aria-label", "Custom response");
    setWorklogFocusKey(input, `ask:${request.id}:custom`);
    if (request.method === "editor") input.value = request.prefill ?? "";
    const send = textElement("button", "send-button", "Reply");
    send.type = "submit";
    setWorklogFocusKey(send, `ask:${request.id}:reply`);
    const cancel = textElement("button", "quiet-button", "Cancel");
    cancel.type = "button";
    cancel.dataset.uiCancel = "";
    setWorklogFocusKey(cancel, `ask:${request.id}:cancel`);
    custom.append(input, cancel, send);
    body.append(custom);
  } else {
    const cancel = textElement("button", "quiet-button ask-cancel", "Cancel");
    cancel.type = "button";
    cancel.dataset.uiCancel = "";
    setWorklogFocusKey(cancel, `ask:${request.id}:cancel`);
    body.append(cancel);
  }
  card.append(header, body);
  if (responseState.disabled)
    for (const control of card.querySelectorAll("button, input, textarea")) control.disabled = true;
  return card;
}

function renderReceipts() {
  renderCommandReceipts(
    document,
    deliveryReceipts,
    currentProjection.queue,
    localCommandItems.filter((item) => item.sessionId === currentSessionId),
  );
}

function activityGroups() {
  const activity = currentProjection.activity;
  const inferred = { tasks: [], subagents: [], workflows: [] };
  for (const tool of currentProjection.tools.values()) {
    const name = String(tool.name ?? "").toLowerCase();
    if (name.includes("subagent")) inferred.subagents.push(tool);
    else if (name.includes("workflow")) inferred.workflows.push(tool);
    else if (name.includes("task")) inferred.tasks.push(tool);
  }
  return [
    ["Tasks", activity.tasks.length ? activity.tasks : inferred.tasks, "T"],
    ["Subagents", activity.subagents.length ? activity.subagents : inferred.subagents, "S"],
    ["Workflows", activity.workflows.length ? activity.workflows : inferred.workflows, "W"],
  ];
}

function renderActivity() {
  const groups = activityGroups();
  const count = groups.reduce((total, [, items]) => total + items.length, 0);
  activityIndicator.hidden = count === 0;
  if (count === 0) {
    activityContent.replaceChildren(
      textElement("p", "activity-empty", "No secondary activity yet."),
    );
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const [label, items, icon] of groups) {
    if (items.length === 0) continue;
    const section = document.createElement("section");
    section.className = "activity-group";
    const heading = document.createElement("h2");
    heading.className = "activity-group-heading";
    heading.append(textElement("span", "", label), textElement("span", "", String(items.length)));
    const list = document.createElement("div");
    list.className = "activity-list";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "activity-item";
      const copy = document.createElement("span");
      copy.className = "activity-copy";
      copy.append(
        textElement(
          "strong",
          "",
          firstString(item.title, item.name, item.task, item.description, label.slice(0, -1)),
        ),
        textElement(
          "span",
          "",
          firstString(item.status, item.summary, item.detail, "Session activity"),
        ),
      );
      row.append(
        textElement("span", "activity-icon", icon),
        copy,
        textElement("span", "activity-time", firstString(item.elapsed, item.duration, "")),
      );
      list.append(row);
    }
    section.append(heading, list);
    fragment.append(section);
  }
  activityContent.replaceChildren(fragment);
}

function modelIdentity(model) {
  const provider = firstString(model?.provider);
  const id = firstString(model?.id, model?.modelId, model?.model_id);
  return provider && id ? JSON.stringify([provider, id]) : "";
}

function modelLabel(model) {
  return firstString(model?.name, model?.label, model?.id, model?.modelId, "Model");
}

function renderRuntimeControls() {
  const models = currentProjection?.capabilities?.models ?? [];
  const thinkingLevels = currentProjection?.capabilities?.thinkingLevels ?? [];
  const currentModel = firstObject(currentProjection?.state?.model);
  const thinkingLevel = firstString(
    currentProjection?.state?.thinkingLevel,
    currentProjection?.state?.thinking_level,
  );
  const visible = hasAvailableRuntime(currentProjection);
  const commandPaused = Boolean(commandLane.state(currentSessionId).paused);
  runtimeControlsButton.hidden = !visible;
  runtimeControlsButton.disabled = commandPaused || !currentProjection?.loaded;
  modelSelect.disabled = commandPaused || models.length === 0;
  thinkingSelect.disabled = commandPaused || thinkingLevels.length === 0;
  modelSelect.closest(".runtime-field").hidden = models.length === 0;
  thinkingSelect.closest(".runtime-field").hidden = thinkingLevels.length === 0;
  runtimeModelLabel.textContent = modelLabel(currentModel);
  runtimeThinkingLabel.textContent = thinkingLevel ?? "Thinking";

  const signature = JSON.stringify([
    models.map((model) => [model.provider, model.id, model.name]),
    thinkingLevels,
  ]);
  if (signature !== runtimeOptionsSignature) {
    modelSelect.replaceChildren();
    const providerGroups = new Map();
    for (const model of models) {
      const provider = firstString(model.provider, "Other");
      let group = providerGroups.get(provider);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = provider;
        providerGroups.set(provider, group);
        modelSelect.append(group);
      }
      const option = document.createElement("option");
      option.value = modelIdentity(model);
      option.textContent = modelLabel(model);
      group.append(option);
    }
    thinkingSelect.replaceChildren();
    for (const level of thinkingLevels) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      thinkingSelect.append(option);
    }
    runtimeOptionsSignature = signature;
  }

  const currentIdentity = modelIdentity(currentModel);
  if (
    currentIdentity &&
    [...modelSelect.options].some((option) => option.value === currentIdentity)
  ) {
    modelSelect.value = currentIdentity;
  }
  if (thinkingLevel && thinkingLevels.includes(thinkingLevel)) {
    thinkingSelect.value = thinkingLevel;
  }
  if (!visible) setRuntimeMenu(false);
}

function updateComposer() {
  const active = Boolean(currentProjection?.active);
  const runtimeAvailable = hasAvailableRuntime(currentProjection);
  const laneState = commandLane.state(currentSessionId);
  deliveryModeButton.hidden = !active;
  stopRunButton.hidden = !active;
  stopRunButton.disabled = Boolean(laneState.paused);
  if (!active) setDeliveryMenu(false);
  const text = composerText(composerInput.value);
  composerSend.disabled = Boolean(
    laneState.paused || !text || !currentProjection?.loaded || !runtimeAvailable,
  );
  composerSend.textContent = active ? (deliveryMode === "steer" ? "Steer" : "Queue") : "Send";
  deliveryModeLabel.textContent = deliveryMode === "steer" ? "Steer" : "Queue";
  composerStatus.textContent = laneState.paused
    ? laneState.paused === "stale"
      ? "Session changed · pending commands are held"
      : "Command outcome unknown · pending commands are held"
    : laneState.items.some((item) => item.state === "sending")
      ? "Submitting…"
      : active
        ? "Pi is active"
        : currentProjection?.loaded
          ? runtimeAvailable
            ? "Pi is ready"
            : "Pi model unavailable"
          : "Loading session state…";
  for (const option of deliveryMenu.querySelectorAll("[data-delivery-mode]")) {
    option.setAttribute("aria-checked", String(option.dataset.deliveryMode === deliveryMode));
  }
  updateCommandRecovery(laneState.paused);
  renderRuntimeControls();
}

function updateCommandRecovery(reason) {
  commandRecovery.hidden = !reason;
  if (!reason) return;
  commandRecoveryTitle.textContent =
    reason === "stale" ? "This session changed" : "This command outcome is unknown";
  commandRecoveryCopy.textContent =
    "Review the held text above. Discard it to refresh this session and continue; it will never be sent or replayed.";
}

function setDeliveryMenu(open) {
  if (open) setRuntimeMenu(false);
  deliveryMenu.classList.toggle("open", open);
  deliveryMenu.setAttribute("aria-hidden", String(!open));
  deliveryMenu.inert = !open;
  deliveryModeButton.setAttribute("aria-expanded", String(open));
}

function setRuntimeMenu(open) {
  if (open) setDeliveryMenu(false);
  runtimeMenu.classList.toggle("open", open);
  runtimeMenu.setAttribute("aria-hidden", String(!open));
  runtimeMenu.inert = !open;
  runtimeControlsButton.setAttribute("aria-expanded", String(open));
}

function autosizeComposer() {
  composerInput.style.height = "0";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 180)}px`;
}

async function fetchSnapshot(sessionId, signal) {
  return consoleClient.snapshot(sessionId, signal);
}

async function loadSnapshot(sessionId, { prefetched = false } = {}) {
  if (!sessionId) throw new Error("This URL does not identify a Scotty session.");
  const controller = new AbortController();
  if (!prefetched) {
    snapshotController?.abort();
    snapshotController = controller;
  }
  const body = await fetchSnapshot(sessionId, controller.signal);
  const projection = projectionFromSnapshot(body);
  syncUiResponseState(sessionId, projection);
  const entry = cacheEntry(sessionId);
  if (entry.projection.epoch === projection.epoch)
    for (const requestId of entry.projection.deliveredUiResponses)
      if (projection.pendingUi.has(requestId)) projection.deliveredUiResponses.add(requestId);
  entry.projection = projection;
  if (sessionId !== currentSessionId) return projection;
  currentProjection = projection;
  renderProjection();
  connectEvents(sessionId);
  return projection;
}

function connectEvents(sessionId) {
  eventSource?.close();
  if (disposed || sessionId !== currentSessionId) return;
  setConnection("connecting", "Connecting");
  const source = consoleClient.events(sessionId, {
    epoch: currentProjection?.epoch,
    sequence: currentProjection?.sequence,
  });
  eventSource = source;
  source.addEventListener("open", () => {
    if (source !== eventSource) return;
    setConnection("connected", currentProjection.active ? "Pi working" : "Connected");
  });
  source.addEventListener("message", (messageEvent) => consumeSseEvent(messageEvent, source));
  for (const type of [
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "queue_update",
    "extension_ui_request",
    "extension_ui_response",
    "state_update",
  ]) {
    source.addEventListener(type, (messageEvent) => consumeSseEvent(messageEvent, source, type));
  }
  source.addEventListener("error", () => {
    if (source !== eventSource) return;
    setConnection("disconnected", "Reconnecting");
  });
}

function consumeSseEvent(messageEvent, source, namedType) {
  if (source !== eventSource) return;
  try {
    const payload = JSON.parse(messageEvent.data);
    if (namedType && !payload.type && !payload.event?.type) payload.type = namedType;
    const wasActive = Boolean(currentProjection.active);
    const result = applyEvent(currentProjection, payload);
    if (result === "epoch-mismatch" || result === "snapshot") {
      source.close();
      loadSnapshot(currentSessionId).catch(showLoadError);
      return;
    }
    const { event } = eventPayload(payload);
    const request = firstObject(event.request, event);
    if (result === "applied") {
      announceWorklog(
        meaningfulWorklogAnnouncement({
          type: event.type,
          method: request.method,
          wasActive,
          isActive: Boolean(currentProjection.active),
        }),
      );
    }
    if (event.type === "extension_ui_request" && event.method === "notify") {
      showToast(firstString(event.message, "Pi sent a notification."));
    } else if (event.type === "extension_ui_request" && event.method === "set_editor_text") {
      composerInput.value = event.text ?? "";
      composerDrafts.set(currentSessionId, composerInput.value);
      autosizeComposer();
    }
    syncUiResponseState(currentSessionId, currentProjection);
    cacheEntry(currentSessionId).projection = currentProjection;
    setConnection("connected", currentProjection.active ? "Pi working" : "Connected");
    scheduleRender();
  } catch {
    showToast("Scotty received an unreadable session event.");
  }
}

function queueCommand(
  intent,
  label,
  { sessionId = currentSessionId, projection = currentProjection } = {},
) {
  if (!projection?.loaded || !projection.epoch || !Number.isSafeInteger(projection.sessionRevision))
    throw new Error("Refresh the session before sending a command.");
  return {
    ...commandLane.enqueue({
      sessionId,
      epoch: projection.epoch,
      expectedSessionRevision: projection.sessionRevision,
      intent,
      label,
    }),
    sessionId,
  };
}

function commandOutcomeMessage(outcome) {
  if (outcome.status === "stale") return "The session changed. Review it and submit again.";
  if (outcome.status === "ambiguous") return "The command outcome is unknown. It was not retried.";
  if (outcome.status === "discarded") return "The held command was discarded without being sent.";
  return outcome.message ?? "Pi did not accept that command.";
}

async function sendCommand(intent, label, authority) {
  const submission = queueCommand(intent, label, authority);
  const { outcome } = submission;
  const result = await outcome;
  if (result.status === "stale" || result.status === "ambiguous")
    refreshAffectedSession(submission.sessionId);
  if (result.status !== "accepted") throw new Error(commandOutcomeMessage(result));
  return result.receipt;
}

function refreshAffectedSession(sessionId) {
  loadSnapshot(sessionId, { prefetched: sessionId !== currentSessionId }).catch((error) => {
    if (sessionId === currentSessionId) showLoadError(error);
  });
}

async function discardHeldCommands() {
  const sessionId = currentSessionId;
  if (!commandLane.state(sessionId).paused) return;
  discardHeldCommandsButton.disabled = true;
  commandRecovery.setAttribute("aria-busy", "true");
  try {
    await loadSnapshot(sessionId);
    if (!commandLane.state(sessionId).paused) return;
    commandLane.discard(sessionId);
    if (sessionId === currentSessionId) {
      showToast("Held commands discarded. This session is ready for a fresh command.");
      composerInput.focus({ preventScroll: true });
    }
  } catch (error) {
    if (sessionId === currentSessionId) showLoadError(error);
  } finally {
    discardHeldCommandsButton.disabled = false;
    commandRecovery.removeAttribute("aria-busy");
    updateComposer();
  }
}

async function submitComposer() {
  const editableDraft = composerInput.value;
  const text = composerText(editableDraft);
  if (!text || !currentProjection?.loaded) return;
  const streamingBehavior = deliveryMode === "steer" ? "steer" : "followUp";
  let submission;
  try {
    submission = queueCommand({ type: "prompt", message: text, streamingBehavior }, text);
    const draftSubmission = composerDrafts.begin(submission.sessionId, editableDraft);
    composerInput.value = "";
    autosizeComposer();
    updateComposer();
    composerInput.focus({ preventScroll: true });
    const outcome = await submission.outcome;
    if (outcome.status !== "accepted") {
      const restored = composerDrafts.settle(draftSubmission, outcome.status);
      if (restored && submission.sessionId === currentSessionId) {
        composerInput.value = cacheEntry(submission.sessionId).draft;
        autosizeComposer();
        updateComposer();
      }
      if (outcome.status === "stale" || outcome.status === "ambiguous")
        refreshAffectedSession(submission.sessionId);
      showToast(commandOutcomeMessage(outcome));
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Pi did not accept that message.");
    composerInput.focus({ preventScroll: true });
  }
}

async function selectModel() {
  const sessionId = currentSessionId;
  const projection = currentProjection;
  const selected = projection.capabilities.models.find(
    (model) => modelIdentity(model) === modelSelect.value,
  );
  if (!selected) return;
  try {
    await sendCommand(
      {
        type: "set_model",
        provider: selected.provider,
        modelId: firstString(selected.id, selected.modelId, selected.model_id),
      },
      `Change model to ${modelLabel(selected)}`,
      { sessionId, projection },
    );
    if (sessionId !== currentSessionId || projection !== currentProjection) {
      refreshAffectedSession(sessionId);
      return;
    }
    projection.state = { ...projection.state, model: selected };
    setRuntimeMenu(false);
    updateComposer();
    runtimeControlsButton.focus({ preventScroll: true });
    loadSnapshot(sessionId).catch(() => {
      showToast("The model changed, but its updated thinking options could not be refreshed.");
    });
  } catch (error) {
    if (sessionId !== currentSessionId || projection !== currentProjection) return;
    renderRuntimeControls();
    showToast(error instanceof Error ? error.message : "Pi could not change models.");
  }
}

async function selectThinkingLevel() {
  const sessionId = currentSessionId;
  const projection = currentProjection;
  const level = thinkingSelect.value;
  if (!level) return;
  try {
    await sendCommand({ type: "set_thinking_level", level }, `Change thinking to ${level}`, {
      sessionId,
      projection,
    });
    if (sessionId !== currentSessionId || projection !== currentProjection) {
      refreshAffectedSession(sessionId);
      return;
    }
    projection.state = {
      ...projection.state,
      thinkingLevel: level,
    };
    setRuntimeMenu(false);
    updateComposer();
    runtimeControlsButton.focus({ preventScroll: true });
  } catch (error) {
    if (sessionId !== currentSessionId || projection !== currentProjection) return;
    renderRuntimeControls();
    showToast(error instanceof Error ? error.message : "Pi could not change thinking level.");
  }
}

async function sendUiResponse(requestId, value, { cancelled = false } = {}) {
  const sessionId = currentSessionId;
  const projection = currentProjection;
  await sendUiResponseForProjection({
    sessionId,
    projection,
    requestId,
    value,
    cancelled,
    sendCommand: (intent, label) => sendCommand(intent, label, { sessionId, projection }),
    hasCurrentRequest: (targetSessionId, targetProjection, targetRequestId) =>
      targetSessionId === currentSessionId &&
      currentProjection.epoch === targetProjection.epoch &&
      currentProjection.pendingUi.has(targetRequestId) &&
      !currentProjection.deliveredUiResponses.has(targetRequestId) &&
      !uiResponses.isDelivered(targetSessionId, targetProjection.epoch, targetRequestId),
    hasCurrentDelivery: (targetSessionId, targetRequestId) =>
      targetSessionId === currentSessionId &&
      (currentProjection.deliveredUiResponses.has(targetRequestId) ||
        uiResponses.isDelivered(targetSessionId, currentProjection.epoch, targetRequestId)),
    markDelivered: (targetSessionId, targetProjection, targetRequestId) => {
      uiResponses.markDelivered(targetSessionId, targetProjection.epoch, targetRequestId);
      markUiResponseDelivered(
        targetProjection,
        cacheEntry(targetSessionId).projection,
        targetRequestId,
      );
    },
    setPendingState: (targetSessionId, targetProjection, targetRequestId, pending) => {
      if (pending) uiResponses.begin(targetSessionId, targetProjection.epoch, targetRequestId);
      else uiResponses.finish(targetSessionId, targetProjection.epoch, targetRequestId);
    },
    setCardPending: () => disableAskCard(requestId),
    setCardDelivered: () =>
      disableAskCard(requestId, "Awaiting Pi continuation · outcome unconfirmed"),
    setCardRetryable: () => enableAskCard(requestId),
    reportError: showToast,
  });
}

function disableAskCard(requestId, message = "Sending…") {
  const card = [...document.querySelectorAll(".ask-user-card")].find(
    (candidate) => candidate.dataset.requestId === requestId,
  );
  for (const control of card?.querySelectorAll("button, input, textarea") ?? [])
    control.disabled = true;
  const state = card?.querySelector(".ask-state");
  if (state) state.textContent = message;
}

function enableAskCard(requestId) {
  const card = [...document.querySelectorAll(".ask-user-card")].find(
    (candidate) => candidate.dataset.requestId === requestId,
  );
  for (const control of card?.querySelectorAll("button, input, textarea") ?? [])
    control.disabled = false;
  const state = card?.querySelector(".ask-state");
  if (state) state.textContent = "Pi paused";
}

function showToast(message) {
  const toast = textElement("div", "toast", message);
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

function showLoadError(error) {
  if (error?.name === "AbortError") return;
  setConnection("disconnected", "Unavailable");
  worklogFeed.setAttribute("aria-busy", "false");
  renderSummaryUnavailable();
  worklogFeed.replaceChildren(
    (() => {
      const empty = document.createElement("div");
      empty.className = "feed-empty";
      empty.append(
        textElement(
          "p",
          "",
          error instanceof Error ? error.message : "Unable to load this Pi session.",
        ),
      );
      return empty;
    })(),
  );
}

function workspaceName(session) {
  return sessionTitle(session);
}

function visibleWorkspaceSignature(groups) {
  return JSON.stringify(
    groups.map((group) => [
      group.repo,
      group.sessions.map((session) => [session.id, workspaceName(session)]),
    ]),
  );
}

function addWorkspaceLink(parent, session) {
  const link = document.createElement("a");
  link.className = "workspace-link";
  link.href = `/s/${encodeURIComponent(session.id)}`;
  link.dataset.sessionId = session.id;
  if (session.id === currentSessionId) link.setAttribute("aria-current", "page");
  const copy = document.createElement("span");
  copy.className = "workspace-copy";
  copy.append(textElement("span", "workspace-name", workspaceName(session)));
  link.append(copy);
  parent.append(link);
}

function addWorkspaceProject(group) {
  const section = document.createElement("section");
  section.className = "workspace-project";
  section.append(textElement("h2", "workspace-project-name", group.repo));
  for (const session of group.sessions) addWorkspaceLink(section, session);
  workspaceList.append(section);
}

function renderWorkspaceList() {
  const warm = sessions.filter((session) => session?.status === "warm");
  const groups = groupSessionsByRepository(warm);
  const signature = visibleWorkspaceSignature(groups);
  if (signature === workspaceListSignature) {
    updateCurrentWorkspace();
    return;
  }
  const focusedSessionId = document.activeElement?.closest?.(".workspace-link")?.dataset.sessionId;
  workspaceList.replaceChildren();
  if (warm.length === 0) {
    workspaceList.append(
      textElement("p", "rail-message", "No open containers. Resume one from Sessions Home."),
    );
  } else {
    for (const group of groups) addWorkspaceProject(group);
  }
  workspaceListSignature = signature;
  updateCurrentWorkspace();
  if (focusedSessionId) {
    const link = [...workspaceList.querySelectorAll(".workspace-link")].find(
      (candidate) => candidate.dataset.sessionId === focusedSessionId,
    );
    link?.focus();
  }
}

function updateCurrentWorkspace() {
  for (const link of workspaceList.querySelectorAll(".workspace-link")) {
    if (link.dataset.sessionId === currentSessionId) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const current = sessions.find((session) => session?.id === currentSessionId);
  if (!current) return;
  const title = workspaceName(current);
  const project = current.repo || "Unknown project";
  const metadata = `${project} · ${current.branch || current.id}`;
  currentRepo.textContent = title;
  currentMeta.textContent = metadata;
  pickerTitle.textContent = title;
  pickerProject.textContent = project;
  document.title = `${title} · Scotty`;
}

async function loadWorkspaces() {
  const response = await fetch("/api/sessions", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load open containers (${response.status})`);
  const body = await response.json();
  let nextSessions = Array.isArray(body) ? body : body?.sessions;
  if (!Array.isArray(nextSessions)) throw new Error("Scotty returned an invalid session list");
  if (!nextSessions.some((session) => session?.id === currentSessionId)) {
    const currentResponse = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (currentResponse.ok) {
      const current = await currentResponse.json();
      if (current?.id === currentSessionId && current.status === "warm") {
        nextSessions = [current, ...nextSessions];
      }
    }
  }
  sessions = nextSessions;
  renderWorkspaceList();
}

function saveCurrentView() {
  if (!currentSessionId) return;
  const entry = cacheEntry(currentSessionId);
  composerDrafts.set(currentSessionId, composerInput.value);
  entry.scrollTop = worklog.scrollTop;
  if (currentProjection) entry.projection = currentProjection;
}

function navigateToSession(sessionId, { push = true } = {}) {
  if (!sessionId || sessionId === currentSessionId) {
    setWorkspaceDrawer(false);
    return;
  }
  saveCurrentView();
  snapshotController?.abort();
  eventSource?.close();
  currentSessionId = sessionId;
  if (push) window.history.pushState({ sessionId }, "", `/s/${encodeURIComponent(sessionId)}`);
  const entry = cacheEntry(sessionId);
  currentProjection = entry.projection;
  renderSummaryLoading();
  composerInput.value = entry.draft;
  autosizeComposer();
  updateCurrentWorkspace();
  setCompactSurface(undefined);
  setActivityDrawer(false);
  if (currentProjection.loaded) {
    renderProjection({ restoreScroll: true });
    setConnection("connecting", "Refreshing");
  } else {
    worklogFeed.setAttribute("aria-busy", "true");
    worklogFeed.replaceChildren(
      (() => {
        const placeholder = document.createElement("div");
        placeholder.className = "feed-placeholder";
        placeholder.append(
          textElement("span", "placeholder-mark", ""),
          textElement("p", "", "Loading this Pi session…"),
        );
        return placeholder;
      })(),
    );
    updateComposer();
  }
  loadSnapshot(sessionId).catch(showLoadError);
}

function prefetchSession(sessionId) {
  if (!sessionId || sessionCache.get(sessionId)?.projection.loaded || prefetching.has(sessionId)) {
    return;
  }
  const promise = loadSnapshot(sessionId, { prefetched: true })
    .catch(() => undefined)
    .finally(() => prefetching.delete(sessionId));
  prefetching.set(sessionId, promise);
}

function focusableElements(container) {
  return [
    ...container.querySelectorAll("a[href], button:not([disabled]), input:not([disabled])"),
  ].filter((element) => element.getClientRects().length > 0);
}

function setActivityDrawer(open, { restoreFocus = true } = {}) {
  const wasOpen = activityDrawer.classList.contains("open");
  if (open && compactSurface) setCompactSurface(undefined, { restoreFocus: false });
  activityDrawer.classList.toggle("open", open);
  activityDrawer.setAttribute("aria-hidden", String(!open));
  activityBackdrop.hidden = !open;
  openActivityButton.setAttribute("aria-expanded", String(open));
  appShell.inert = open;
  if (open) {
    requestAnimationFrame(() => {
      if (activityDrawer.classList.contains("open")) closeActivityButton.focus();
    });
  } else if (wasOpen && restoreFocus) openActivityButton.focus();
}

function setCompactSurface(surface, { restoreFocus = true } = {}) {
  const next =
    surface === "workspace" && compactViewport.matches
      ? "workspace"
      : surface === "summary" && summaryCompactViewport.matches
        ? "summary"
        : undefined;
  const previous = compactSurface;
  if (next && activityDrawer.classList.contains("open")) {
    setActivityDrawer(false, { restoreFocus: false });
  }
  compactSurface = next;
  const workspaceOpen = next === "workspace";
  const summaryOpen = next === "summary";

  document.body.classList.toggle("drawer-open", workspaceOpen);
  drawerBackdrop.hidden = !workspaceOpen;
  openDrawerButton.setAttribute("aria-expanded", String(workspaceOpen));
  if (workspaceOpen) {
    workspaceRail.setAttribute("role", "dialog");
    workspaceRail.setAttribute("aria-modal", "true");
  } else {
    workspaceRail.removeAttribute("role");
    workspaceRail.removeAttribute("aria-modal");
  }

  summarySidebar.classList.toggle("open", summaryOpen);
  summarySidebar.setAttribute("aria-hidden", String(!summaryOpen));
  summaryBackdrop.hidden = !summaryOpen;
  openSummaryButton.setAttribute("aria-expanded", String(summaryOpen));
  if (summaryCompactViewport.matches) {
    summarySidebar.setAttribute("role", "dialog");
    summarySidebar.setAttribute("aria-modal", "true");
  } else {
    summarySidebar.removeAttribute("role");
    summarySidebar.removeAttribute("aria-modal");
  }

  sessionWorkspace.inert = workspaceOpen || summaryOpen;
  workspaceRail.inert = summaryOpen;
  summarySidebar.inert = summaryCompactViewport.matches && !summaryOpen;

  if (workspaceOpen || summaryOpen) {
    requestAnimationFrame(() => {
      if (compactSurface === "workspace") closeDrawerButton.focus();
      else if (compactSurface === "summary") closeSummaryButton.focus();
    });
  } else if (restoreFocus && previous === "workspace") openDrawerButton.focus();
  else if (restoreFocus && previous === "summary") openSummaryButton.focus();
}

function setWorkspaceDrawer(open) {
  if (open) {
    if (compactViewport.matches) setCompactSurface("workspace");
  } else if (compactSurface === "workspace") {
    setCompactSurface(undefined);
  }
}

function setSummaryOpen(open, { restoreFocus = true } = {}) {
  if (summaryCompactViewport.matches) {
    if (open) setCompactSurface("summary", { restoreFocus });
    else if (compactSurface === "summary") setCompactSurface(undefined, { restoreFocus });
    return;
  }
  desktopSummaryOpen = open;
  document.body.classList.toggle("summary-collapsed", !open);
  summarySidebar.classList.remove("open");
  summarySidebar.setAttribute("aria-hidden", String(!open));
  summarySidebar.removeAttribute("role");
  summarySidebar.removeAttribute("aria-modal");
  summarySidebar.inert = !open;
  summaryBackdrop.hidden = true;
  openSummaryButton.setAttribute("aria-expanded", String(open));
  if (!open && restoreFocus) openSummaryButton.focus();
}

function syncSummarySurface() {
  if (summaryCompactViewport.matches) {
    document.body.classList.remove("summary-collapsed");
    setCompactSurface(undefined, { restoreFocus: false });
  } else {
    setCompactSurface(undefined, { restoreFocus: false });
    setSummaryOpen(desktopSummaryOpen, { restoreFocus: false });
  }
}

function trapFocus(event, container) {
  const elements = focusableElements(container);
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

workspaceList.addEventListener("click", (event) => {
  const link = event.target.closest?.(".workspace-link");
  if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigateToSession(link.dataset.sessionId);
});
for (const eventName of ["pointerover", "focusin", "touchstart"]) {
  workspaceList.addEventListener(
    eventName,
    (event) => {
      const link = event.target.closest?.(".workspace-link");
      if (link) prefetchSession(link.dataset.sessionId);
    },
    eventName === "touchstart" ? { passive: true } : undefined,
  );
}

openDrawerButton.addEventListener("click", () => setWorkspaceDrawer(true));
closeDrawerButton.addEventListener("click", () => setWorkspaceDrawer(false));
drawerBackdrop.addEventListener("click", () => setWorkspaceDrawer(false));
openSummaryButton.addEventListener("click", () => {
  const open = summaryCompactViewport.matches ? compactSurface !== "summary" : !desktopSummaryOpen;
  setSummaryOpen(open);
});
closeSummaryButton.addEventListener("click", () => setSummaryOpen(false));
summaryBackdrop.addEventListener("click", () => setSummaryOpen(false));
openActivityButton.addEventListener("click", () => setActivityDrawer(true));
closeActivityButton.addEventListener("click", () => setActivityDrawer(false));
activityBackdrop.addEventListener("click", () => setActivityDrawer(false));

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});
composerInput.addEventListener("compositionstart", () => {
  composing = true;
});
composerInput.addEventListener("compositionend", () => {
  composing = false;
});
composerInput.addEventListener("input", () => {
  composerDrafts.set(currentSessionId, composerInput.value);
  autosizeComposer();
  updateComposer();
});
composerInput.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    !composing &&
    !coarsePointer.matches
  ) {
    event.preventDefault();
    submitComposer();
  }
});
deliveryModeButton.addEventListener("click", () => {
  const open = !deliveryMenu.classList.contains("open");
  setDeliveryMenu(open);
  if (open) deliveryMenu.querySelector('[aria-checked="true"]')?.focus();
});
runtimeControlsButton.addEventListener("click", () => {
  const open = !runtimeMenu.classList.contains("open");
  setRuntimeMenu(open);
  if (open) {
    if (modelSelect.disabled) thinkingSelect.focus();
    else modelSelect.focus();
  }
});
modelSelect.addEventListener("change", selectModel);
thinkingSelect.addEventListener("change", selectThinkingLevel);
discardHeldCommandsButton.addEventListener("click", discardHeldCommands);
deliveryMenu.addEventListener("click", (event) => {
  const option = event.target.closest?.("[data-delivery-mode]");
  if (!option) return;
  deliveryMode = option.dataset.deliveryMode;
  setDeliveryMenu(false);
  updateComposer();
  composerInput.focus({ preventScroll: true });
});
stopRunButton.addEventListener("click", async () => {
  try {
    await sendCommand({ type: "abort" }, "Stop Pi");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Pi could not be stopped.");
  }
});
worklog.addEventListener(
  "scroll",
  () => {
    cacheEntry(currentSessionId).scrollTop = worklog.scrollTop;
  },
  { passive: true },
);
worklogFeed.addEventListener("click", (event) => {
  const cancelButton = event.target.closest?.("[data-ui-cancel]");
  if (cancelButton) {
    const card = cancelButton.closest(".ask-user-card");
    sendUiResponse(card?.dataset.requestId, undefined, { cancelled: true });
    return;
  }
  const responseButton = event.target.closest?.("[data-ui-response]");
  if (!responseButton) return;
  const card = responseButton.closest(".ask-user-card");
  let value = responseButton.dataset.uiResponse;
  if (responseButton.hasAttribute("data-ui-response-json")) value = JSON.parse(value);
  sendUiResponse(card?.dataset.requestId, value);
});
worklogFeed.addEventListener("submit", (event) => {
  const form = event.target.closest?.("[data-ui-custom]");
  if (!form) return;
  event.preventDefault();
  const value = composerText(new FormData(form).get("answer"));
  if (!value) return;
  sendUiResponse(form.closest(".ask-user-card")?.dataset.requestId, value);
});

document.addEventListener("click", (event) => {
  if (
    deliveryMenu.classList.contains("open") &&
    !event.target.closest?.("#delivery-menu") &&
    !event.target.closest?.("#delivery-mode")
  ) {
    setDeliveryMenu(false);
  }
  if (
    runtimeMenu.classList.contains("open") &&
    !event.target.closest?.("#runtime-menu") &&
    !event.target.closest?.("#runtime-controls")
  ) {
    setRuntimeMenu(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (activityDrawer.classList.contains("open")) setActivityDrawer(false);
    else if (compactSurface) setCompactSurface(undefined);
    else if (deliveryMenu.classList.contains("open")) {
      setDeliveryMenu(false);
      deliveryModeButton.focus();
    } else if (runtimeMenu.classList.contains("open")) {
      setRuntimeMenu(false);
      runtimeControlsButton.focus();
    }
  }
  if (event.key === "Tab" && activityDrawer.classList.contains("open")) {
    trapFocus(event, activityDrawer);
  } else if (event.key === "Tab" && compactSurface === "workspace") {
    trapFocus(event, workspaceRail);
  } else if (event.key === "Tab" && compactSurface === "summary") {
    trapFocus(event, summarySidebar);
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    setWorkspaceDrawer(!document.body.classList.contains("drawer-open"));
  }
});
compactViewport.addEventListener("change", (event) => {
  if (!event.matches && compactSurface === "workspace") setWorkspaceDrawer(false);
});
summaryCompactViewport.addEventListener("change", syncSummarySurface);
window.addEventListener("popstate", () => {
  const sessionId = sessionIdFromLocation();
  if (sessionId) navigateToSession(sessionId, { push: false });
});
window.addEventListener("beforeunload", () => {
  disposed = true;
  saveCurrentView();
  snapshotController?.abort();
  eventSource?.close();
});

async function start() {
  syncSummarySurface();
  if (!currentSessionId) {
    showLoadError(new Error("This URL does not identify a Scotty session."));
    return;
  }
  const entry = cacheEntry(currentSessionId);
  currentProjection = entry.projection;
  composerInput.value = entry.draft;
  autosizeComposer();
  updateComposer();
  loadWorkspaces().catch(() => {
    showToast("The workspace list could not be refreshed.");
  });
  await loadSnapshot(currentSessionId).catch(showLoadError);
}

start();
window.setInterval(() => {
  loadWorkspaces().catch(() => {});
}, 15000);
