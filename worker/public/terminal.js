import { groupSessionsByRepository, sessionTitle } from "/session-form.js";
import { composerText, hasAvailableRuntime } from "/terminal-input.js";
import { assistantMarkdownFragment } from "/terminal-markdown.js";
import {
  createMessageProjectionState,
  finishMessageSnapshot,
  projectMessageEvent,
} from "/terminal-message-projection.js";
import { conversationItems, appendAssistantMessageDelta } from "/terminal-timeline.js";

const CACHE_LIMIT = 6;
const compactViewport = window.matchMedia("(max-width: 780px)");
const coarsePointer = window.matchMedia("(pointer: coarse)");

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
const openActivityButton = document.querySelector("#open-activity");
const closeActivityButton = document.querySelector("#close-activity");
const activityDrawer = document.querySelector("#activity-drawer");
const activityBackdrop = document.querySelector("#activity-backdrop");
const activityContent = document.querySelector("#activity-content");
const activityIndicator = document.querySelector("#activity-indicator");
const toastRegion = document.querySelector("#toast-region");

let currentSessionId = sessionIdFromLocation();
let currentProjection;
let eventSource;
let snapshotController;
let workspaceListSignature;
let sessions = [];
let disposed = false;
let deliveryMode = "follow_up";
let commandPending = false;
let composing = false;
let renderScheduled = false;
let runtimeOptionsSignature;
const sessionCache = new Map();
const prefetching = new Map();
const disclosureState = new Map();

function sessionIdFromLocation() {
  const match = window.location.pathname.match(/^\/s\/([^/]+)$/u);
  return match ? decodeURIComponent(match[1]) : "";
}

function blankProjection() {
  return {
    epoch: undefined,
    sequence: 0,
    messages: [],
    messageProjection: createMessageProjectionState(),
    tools: new Map(),
    pendingUi: new Map(),
    deliveredUiResponses: new Set(),
    queue: { steer: [], followUp: [] },
    active: false,
    state: {},
    capabilities: { models: [], thinkingLevels: [] },
    activity: { tasks: [], subagents: [], workflows: [] },
    loaded: false,
  };
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
  const candidates = [...sessionCache.entries()]
    .filter(([id]) => id !== currentSessionId)
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
  while (sessionCache.size > CACHE_LIMIT && candidates.length > 0) {
    sessionCache.delete(candidates.shift()[0]);
  }
}

function rpcUrl(sessionId, operation) {
  return `/s/${encodeURIComponent(sessionId)}/rpc/${operation}`;
}

function setConnection(state, label) {
  connectionState.dataset.state = state;
  connectionLabel.textContent = label;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstArray(...values) {
  return values.find(Array.isArray) ?? [];
}

function firstObject(...values) {
  return values.find(isObject) ?? {};
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function numberValue(...values) {
  return values.find((value) => Number.isFinite(value));
}

function normalizeQueue(value) {
  const queue = firstObject(value);
  return {
    steer: firstArray(queue.steer, queue.steering, queue.pendingSteer).map(normalizeQueueItem),
    followUp: firstArray(
      queue.followUp,
      queue.follow_up,
      queue.followUps,
      queue.follow_ups,
      queue.queued,
    ).map(normalizeQueueItem),
  };
}

function normalizeQueueItem(value, index) {
  if (typeof value === "string") return { id: `${index}:${value}`, text: value };
  return {
    id: firstString(value?.id, value?.requestId, value?.commandId) ?? String(index),
    text: messageText(value?.message ?? value?.text ?? value?.content),
  };
}

function unwrapSnapshot(body) {
  const outer = firstObject(body);
  const snapshot = firstObject(outer.snapshot, outer.projection, outer.data, outer);
  return { outer, snapshot };
}

function projectionFromSnapshot(body) {
  const { outer, snapshot } = unwrapSnapshot(body);
  const state = firstObject(snapshot.state, outer.state);
  const projection = blankProjection();
  projection.epoch = firstString(outer.epoch, snapshot.epoch);
  const snapshotSequence =
    numberValue(outer.sequence, snapshot.sequence, outer.seq, snapshot.seq) ?? 0;
  projection.messages = firstArray(
    snapshot.messages,
    snapshot.entries,
    state.messages,
    outer.messages,
  ).filter(isObject);
  projection.messageProjection = createMessageProjectionState(projection.messages, true);
  projection.active = Boolean(
    state.active ??
    state.isActive ??
    state.isStreaming ??
    snapshot.active ??
    snapshot.running ??
    outer.active,
  );
  projection.state = state;
  const capabilities = firstObject(snapshot.capabilities, state.capabilities, outer.capabilities);
  projection.capabilities = {
    models: firstArray(capabilities.models).filter(isObject),
    thinkingLevels: firstArray(
      capabilities.thinkingLevels,
      capabilities.thinking_levels,
      capabilities.levels,
    ).filter((level) => typeof level === "string"),
  };
  projection.queue = normalizeQueue(
    firstObject(snapshot.queue, state.queue, snapshot.queues, state.queues),
  );
  projection.activity = {
    tasks: firstArray(snapshot.tasks, state.tasks, snapshot.activity?.tasks),
    subagents: firstArray(snapshot.subagents, state.subagents, snapshot.activity?.subagents),
    workflows: firstArray(snapshot.workflows, state.workflows, snapshot.activity?.workflows),
  };
  const tools = firstArray(snapshot.tools, snapshot.toolCalls, state.tools);
  for (const tool of tools) upsertTool(projection, tool);
  hydrateToolsFromMessages(projection);
  const pendingUi = firstArray(
    snapshot.pendingUi,
    snapshot.pending_ui,
    state.pendingUi,
    state.pending_ui,
    snapshot.uiRequests,
  );
  for (const request of pendingUi) upsertUiRequest(projection, request);
  const snapshotEvents = firstArray(outer.events, snapshot.events).sort(
    (left, right) => (left?.sequence ?? 0) - (right?.sequence ?? 0),
  );
  if (snapshotEvents.length > 0) {
    projection.sequence = Math.max(0, (snapshotEvents[0]?.sequence ?? 1) - 1);
    for (const event of snapshotEvents) applyEvent(projection, event);
  }
  finishMessageSnapshot(projection.messageProjection);
  projection.sequence = Math.max(projection.sequence, snapshotSequence);
  projection.loaded = true;
  return projection;
}

function hydrateToolsFromMessages(projection) {
  for (const message of projection.messages) {
    for (const part of contentParts(message)) {
      const type = part?.type;
      if (type === "toolCall" || type === "tool_call" || type === "tool-call") {
        upsertTool(projection, part, "running");
      }
    }
    const role = message?.role;
    if (role === "toolResult" || role === "tool_result" || role === "tool") {
      upsertTool(
        projection,
        {
          ...message,
          result: message.content ?? message.result,
          error: message.isError ? (message.content ?? true) : message.error,
        },
        message.isError || message.error ? "error" : "done",
      );
    }
  }
}

function toolId(tool) {
  return firstString(tool?.toolCallId, tool?.tool_call_id, tool?.id, tool?.callId);
}

function upsertTool(projection, rawTool, phase) {
  if (!isObject(rawTool)) return;
  const id = toolId(rawTool);
  if (!id) return;
  const previous = projection.tools.get(id) ?? {};
  projection.tools.set(id, {
    ...previous,
    ...rawTool,
    id,
    name: firstString(rawTool.toolName, rawTool.tool_name, rawTool.name, previous.name, "tool"),
    arguments: rawTool.arguments ?? rawTool.args ?? rawTool.input ?? previous.arguments,
    result:
      rawTool.result ??
      rawTool.partialResult ??
      rawTool.output ??
      rawTool.content ??
      previous.result,
    error: rawTool.error ?? previous.error,
    status:
      phase ??
      rawTool.status ??
      previous.status ??
      (rawTool.error ? "error" : rawTool.result === undefined ? "running" : "done"),
  });
}

function uiRequestId(request) {
  return firstString(request?.requestId, request?.request_id, request?.id);
}

function upsertUiRequest(projection, request) {
  if (!isObject(request)) return;
  if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
  const id = uiRequestId(request);
  if (!id) return;
  projection.pendingUi.set(id, { ...request, id });
}

function applyExtensionSurface(projection, request) {
  const method = request.method;
  if (method === "setWidget") {
    const key = String(request.widgetKey ?? "").toLowerCase();
    const group = key.includes("subagent")
      ? "subagents"
      : key.includes("workflow")
        ? "workflows"
        : key.includes("task")
          ? "tasks"
          : undefined;
    if (group)
      projection.activity[group] = Array.isArray(request.widgetLines)
        ? request.widgetLines.map((line, index) => ({
            id: `${request.widgetKey}:${index}`,
            title: messageText(line),
            status: "active",
          }))
        : [];
  } else if (method === "setStatus") {
    const statuses = { ...firstObject(projection.state.extensionStatus) };
    if (typeof request.statusText === "string") statuses[request.statusKey] = request.statusText;
    else delete statuses[request.statusKey];
    projection.state = {
      ...projection.state,
      extensionStatus: statuses,
    };
  } else if (method === "setTitle" && request.title) {
    projection.state = { ...projection.state, extensionTitle: request.title };
  } else if (method === "set_editor_text") {
    projection.state = { ...projection.state, editorText: request.text ?? "" };
  }
}

function eventPayload(payload) {
  const outer = firstObject(payload);
  const event = firstObject(outer.event, outer.data, outer);
  return { outer, event };
}

function applyEvent(projection, payload) {
  const { outer, event } = eventPayload(payload);
  const epoch = firstString(outer.epoch, event.epoch);
  const sequence = numberValue(outer.sequence, event.sequence, outer.seq, event.seq);
  if (epoch && projection.epoch && epoch !== projection.epoch) return "epoch-mismatch";
  if (sequence !== undefined && sequence <= projection.sequence) return "duplicate";
  if (epoch) projection.epoch = epoch;
  if (sequence !== undefined) projection.sequence = sequence;

  const type = firstString(event.type, event.event);
  if (!type) return "ignored";

  if (
    type === "snapshot" ||
    type === "projection" ||
    type === "scotty_replay_gap" ||
    type === "scotty_epoch_changed"
  )
    return "snapshot";
  if (type === "agent_start" || type === "turn_start") projection.active = true;
  if (
    type === "agent_end" ||
    type === "agent_settled" ||
    type === "turn_end" ||
    type === "agent_abort" ||
    type === "agent_aborted" ||
    type === "turn_abort" ||
    type === "turn_aborted" ||
    type === "scotty_process_exit"
  ) {
    projection.active = false;
    projection.pendingUi.clear();
    projection.deliveredUiResponses.clear();
  }

  if (type === "message_start" || type === "message_end") {
    const message = firstObject(event.message, event.data);
    if (Object.keys(message).length > 0)
      projectMessageEvent(projection.messages, projection.messageProjection, type, message);
  } else if (type === "message_update") {
    const message = firstObject(event.message);
    if (Object.keys(message).length > 0)
      projectMessageEvent(projection.messages, projection.messageProjection, type, message);
    else applyMessageDelta(projection, event);
  } else if (type === "tool_execution_start") {
    upsertTool(projection, event, "running");
  } else if (type === "tool_execution_update") {
    upsertTool(projection, event, "running");
  } else if (type === "tool_execution_end") {
    upsertTool(projection, event, event.error || event.isError ? "error" : "done");
  } else if (type === "queue_update") {
    projection.queue = normalizeQueue(firstObject(event.queue, event));
  } else if (type === "extension_ui_request") {
    const request = firstObject(event.request, event);
    if (["select", "confirm", "input", "editor"].includes(request.method))
      upsertUiRequest(projection, request);
    else applyExtensionSurface(projection, request);
  } else if (
    type === "extension_ui_response" ||
    type === "extension_ui_cancelled" ||
    type === "extension_ui_closed"
  ) {
    const id = uiRequestId(firstObject(event.request, event));
    if (id) {
      projection.pendingUi.delete(id);
      projection.deliveredUiResponses.delete(id);
    }
  } else if (type === "state" || type === "state_update") {
    projection.state = { ...projection.state, ...firstObject(event.state, event) };
  } else if (type === "scotty_process_exit") {
    projection.active = false;
    projection.state = { ...projection.state, processExited: true };
  }
  return "applied";
}

function applyMessageDelta(projection, event) {
  appendAssistantMessageDelta(projection.messages, event);
}

function messageText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        return firstString(item?.text, item?.content, item?.thinking, "");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isObject(value)) return firstString(value.text, value.content, value.message, "") ?? "";
  return "";
}

function contentParts(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderAssistantCopy(text) {
  const element = document.createElement("div");
  element.className = "message-copy markdown";
  element.append(
    assistantMarkdownFragment(document, text, {
      baseUrl: window.location.href,
    }),
  );
  return element;
}

function renderProjection({ restoreScroll = false } = {}) {
  renderScheduled = false;
  if (!currentProjection) return;
  const nearBottom = worklog.scrollHeight - worklog.scrollTop - worklog.clientHeight < 100;
  const fragment = document.createDocumentFragment();
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
      const turn = renderSystemMessage(item.message);
      if (turn) fragment.append(turn);
      continue;
    }
    if (item.user) fragment.append(renderUserMessage(item.user));
    const assistantTurn = renderAssistantTurn(item, index === lastConversationIndex);
    if (assistantTurn) fragment.append(assistantTurn);
  }
  for (const request of currentProjection.pendingUi.values()) {
    fragment.append(renderUiRequest(request));
  }

  if (fragment.childNodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "feed-empty";
    empty.append(textElement("p", "", "This Pi session has no messages yet."));
    fragment.append(empty);
  }
  worklogFeed.replaceChildren(fragment);
  worklogFeed.setAttribute("aria-busy", "false");
  renderReceipts();
  renderActivity();
  updateComposer();

  const entry = cacheEntry(currentSessionId);
  requestAnimationFrame(() => {
    if (restoreScroll) worklog.scrollTop = entry.scrollTop;
    else if (nearBottom) worklog.scrollTop = worklog.scrollHeight;
  });
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

function renderAssistantTurn(conversation, isLatest) {
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

  const tools = [
    ...conversation.toolIds
      .map((id) => currentProjection.tools.get(id))
      .filter((tool) => tool && !secondaryActivityTool(tool)),
    ...conversation.inlineTools.filter((tool) => !secondaryActivityTool(tool)),
  ];
  if (textParts.length === 0 && reasoningParts.length === 0 && tools.length === 0) return undefined;

  const turn = document.createElement("article");
  turn.className = "worklog-turn assistant";
  turn.append(textElement("div", "speaker-label pi", "PI"));
  const body = document.createElement("div");
  body.className = "turn-body";
  for (const text of textParts) body.append(renderAssistantCopy(text));
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
    reasoning.append(textElement("summary", "", "Reasoning"));
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
  applyDisclosureState(details, `tool:${disclosureKey}`, status === "error");
  const summary = document.createElement("summary");
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
  return details;
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
  const delivered = currentProjection.deliveredUiResponses.has(request.id);
  header.append(
    textElement("span", "", "PI NEEDS YOUR INPUT"),
    textElement(
      "span",
      "ask-state",
      delivered ? "Awaiting Pi continuation · outcome unconfirmed" : "Pi paused",
    ),
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
    if (request.method === "editor") input.value = request.prefill ?? "";
    const send = textElement("button", "send-button", "Reply");
    send.type = "submit";
    const cancel = textElement("button", "quiet-button", "Cancel");
    cancel.type = "button";
    cancel.dataset.uiCancel = "";
    custom.append(input, cancel, send);
    body.append(custom);
  } else {
    const cancel = textElement("button", "quiet-button ask-cancel", "Cancel");
    cancel.type = "button";
    cancel.dataset.uiCancel = "";
    body.append(cancel);
  }
  card.append(header, body);
  if (delivered)
    for (const control of card.querySelectorAll("button, input, textarea")) control.disabled = true;
  return card;
}

function renderReceipts() {
  const fragment = document.createDocumentFragment();
  for (const [kind, items] of [
    ["steer", currentProjection.queue.steer],
    ["follow_up", currentProjection.queue.followUp],
  ]) {
    items.forEach((item, index) => {
      const receipt = document.createElement("div");
      receipt.className = `receipt ${kind === "steer" ? "steer" : ""}`;
      receipt.append(
        textElement("strong", "", kind === "steer" ? "Steering next" : `Queued ${index + 1}`),
        textElement("span", "", item.text),
      );
      fragment.append(receipt);
    });
  }
  deliveryReceipts.replaceChildren(fragment);
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
  runtimeControlsButton.hidden = !visible;
  runtimeControlsButton.disabled = commandPending || !currentProjection?.loaded;
  modelSelect.disabled = commandPending || models.length === 0;
  thinkingSelect.disabled = commandPending || thinkingLevels.length === 0;
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
  deliveryModeButton.hidden = !active;
  stopRunButton.hidden = !active;
  if (!active) setDeliveryMenu(false);
  const text = composerText(composerInput.value);
  composerSend.disabled =
    commandPending || !text || !currentProjection?.loaded || !runtimeAvailable;
  composerSend.textContent = active ? (deliveryMode === "steer" ? "Steer" : "Queue") : "Send";
  deliveryModeLabel.textContent = deliveryMode === "steer" ? "Steer" : "Queue";
  composerStatus.textContent = commandPending
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
  renderRuntimeControls();
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
  const response = await fetch(rpcUrl(sessionId, "snapshot"), {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`Could not load Pi session (${response.status})`);
  return response.json();
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
  const url = new URL(rpcUrl(sessionId, "events"), window.location.origin);
  if (currentProjection?.epoch) url.searchParams.set("epoch", currentProjection.epoch);
  if (currentProjection?.sequence)
    url.searchParams.set("since", String(currentProjection.sequence));
  setConnection("connecting", "Connecting");
  const source = new EventSource(url);
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
    const result = applyEvent(currentProjection, payload);
    if (result === "epoch-mismatch" || result === "snapshot") {
      source.close();
      loadSnapshot(currentSessionId).catch(showLoadError);
      return;
    }
    const { event } = eventPayload(payload);
    if (event.type === "extension_ui_request" && event.method === "notify") {
      showToast(firstString(event.message, "Pi sent a notification."));
    } else if (event.type === "extension_ui_request" && event.method === "set_editor_text") {
      composerInput.value = event.text ?? "";
      cacheEntry(currentSessionId).draft = composerInput.value;
      autosizeComposer();
    }
    cacheEntry(currentSessionId).projection = currentProjection;
    setConnection("connected", currentProjection.active ? "Pi working" : "Connected");
    scheduleRender();
  } catch {
    showToast("Scotty received an unreadable session event.");
  }
}

async function sendCommand(command) {
  if (commandPending) return undefined;
  commandPending = true;
  updateComposer();
  const commandId = crypto.randomUUID();
  try {
    const response = await fetch(rpcUrl(currentSessionId, "command"), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ commandId, command }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        firstString(
          body.message,
          body.error?.message,
          typeof body.error === "string" ? body.error : undefined,
          body.response?.error?.message,
          typeof body.response?.error === "string" ? body.response.error : undefined,
          `Command failed (${response.status})`,
        ),
      );
    }
    return body;
  } finally {
    commandPending = false;
    updateComposer();
  }
}

async function submitComposer() {
  const text = composerText(composerInput.value);
  if (!text || !currentProjection?.loaded) return;
  const streamingBehavior = deliveryMode === "steer" ? "steer" : "followUp";
  try {
    await sendCommand({ type: "prompt", message: text, streamingBehavior });
    composerInput.value = "";
    cacheEntry(currentSessionId).draft = "";
    autosizeComposer();
    updateComposer();
    composerInput.focus({ preventScroll: true });
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Pi did not accept that message.");
    composerInput.focus({ preventScroll: true });
  }
}

async function selectModel() {
  const selected = currentProjection.capabilities.models.find(
    (model) => modelIdentity(model) === modelSelect.value,
  );
  if (!selected) return;
  try {
    await sendCommand({
      type: "set_model",
      provider: selected.provider,
      modelId: firstString(selected.id, selected.modelId, selected.model_id),
    });
    currentProjection.state = { ...currentProjection.state, model: selected };
    setRuntimeMenu(false);
    updateComposer();
    runtimeControlsButton.focus({ preventScroll: true });
    loadSnapshot(currentSessionId).catch(() => {
      showToast("The model changed, but its updated thinking options could not be refreshed.");
    });
  } catch (error) {
    renderRuntimeControls();
    showToast(error instanceof Error ? error.message : "Pi could not change models.");
  }
}

async function selectThinkingLevel() {
  const level = thinkingSelect.value;
  if (!level) return;
  try {
    await sendCommand({ type: "set_thinking_level", level });
    currentProjection.state = {
      ...currentProjection.state,
      thinkingLevel: level,
    };
    setRuntimeMenu(false);
    updateComposer();
    runtimeControlsButton.focus({ preventScroll: true });
  } catch (error) {
    renderRuntimeControls();
    showToast(error instanceof Error ? error.message : "Pi could not change thinking level.");
  }
}

async function sendUiResponse(requestId, value, { cancelled = false } = {}) {
  const request = currentProjection.pendingUi.get(requestId);
  if (!request) return;
  disableAskCard(requestId);
  try {
    const command = cancelled
      ? { type: "extension_ui_response", id: requestId, cancelled: true }
      : request.method === "confirm"
        ? { type: "extension_ui_response", id: requestId, confirmed: Boolean(value) }
        : { type: "extension_ui_response", id: requestId, value: String(value) };
    await sendCommand(command);
    currentProjection.deliveredUiResponses.add(requestId);
    disableAskCard(requestId, "Awaiting Pi continuation · outcome unconfirmed");
  } catch (error) {
    enableAskCard(requestId);
    showToast(error instanceof Error ? error.message : "Pi did not accept that response.");
  }
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
  entry.draft = composerInput.value;
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
  composerInput.value = entry.draft;
  autosizeComposer();
  updateCurrentWorkspace();
  setWorkspaceDrawer(false);
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

function setWorkspaceDrawer(open) {
  const wasOpen = document.body.classList.contains("drawer-open");
  const isOpen = compactViewport.matches && open;
  document.body.classList.toggle("drawer-open", isOpen);
  drawerBackdrop.hidden = !isOpen;
  openDrawerButton.setAttribute("aria-expanded", String(isOpen));
  workspaceRail.toggleAttribute("role", isOpen);
  if (isOpen) {
    workspaceRail.setAttribute("role", "dialog");
    workspaceRail.setAttribute("aria-modal", "true");
  } else {
    workspaceRail.removeAttribute("role");
    workspaceRail.removeAttribute("aria-modal");
  }
  sessionWorkspace.inert = isOpen;
  if (isOpen) closeDrawerButton.focus();
  else if (wasOpen && compactViewport.matches) openDrawerButton.focus();
}

function setActivityDrawer(open) {
  activityDrawer.classList.toggle("open", open);
  activityDrawer.setAttribute("aria-hidden", String(!open));
  activityBackdrop.hidden = !open;
  openActivityButton.setAttribute("aria-expanded", String(open));
  document.querySelector(".app-shell").inert = open;
  if (open) closeActivityButton.focus();
  else if (document.activeElement === closeActivityButton) openActivityButton.focus();
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
  cacheEntry(currentSessionId).draft = composerInput.value;
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
    await sendCommand({ type: "abort" });
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
    else if (document.body.classList.contains("drawer-open")) setWorkspaceDrawer(false);
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
  } else if (event.key === "Tab" && document.body.classList.contains("drawer-open")) {
    trapFocus(event, workspaceRail);
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    setWorkspaceDrawer(!document.body.classList.contains("drawer-open"));
  }
});
compactViewport.addEventListener("change", (event) => {
  if (!event.matches) setWorkspaceDrawer(false);
});
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
