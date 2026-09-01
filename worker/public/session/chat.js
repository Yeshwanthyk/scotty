import { artifactForTool, renderArtifactCard } from "./artifacts.js";
import { Marked } from "../vendor/marked.esm.js";

const markdown = new Marked({ breaks: false, gfm: true, pedantic: false });
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const TERMINAL_EVENTS = new Set([
  "agent_end",
  "agent_settled",
  "agent_abort",
  "agent_aborted",
  "turn_end",
  "turn_abort",
  "turn_aborted",
  "scotty_process_exit",
]);
const UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const VISIBLE_TURN_COUNT = 3;
const HISTORY_BATCH_COUNT = 10;
const DESKTOP_TOOL_LIMIT = 3;
const THINKING_LIMIT = 600;
const TOOL_OUTPUT_LIMIT = 1_200;
const EARLIER_PREVIEW_LIMIT = 220;

const semanticToolLabel = (name) => {
  const normalized = String(name ?? "").toLowerCase();
  if (/hatch/u.test(normalized)) return "Starting Hatch";
  if (/browser|playwright|evidence/u.test(normalized)) return "Testing in browser";
  if (/apply_patch|edit|write|replace/u.test(normalized)) return "Editing files";
  if (/bash|shell|exec|command|terminal/u.test(normalized)) return "Running command";
  if (/subagent|spawn_agent|wait_agent|agent/u.test(normalized)) return "Coordinating agents";
  if (/read|search|find|grep|glob|list/u.test(normalized)) return "Reading project";
  return "Using tool";
};

const compactText = (value, maximum) => {
  const text = sanitizeText(value, maximum + 1)
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
};

const jsonText = (value) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const firstString = (...values) =>
  values.find((value) => typeof value === "string" && value.length > 0);
const messageId = (message) => firstString(message?.id, message?.messageId, message?.message_id);
const toolId = (tool) => firstString(tool?.toolCallId, tool?.tool_call_id, tool?.id, tool?.callId);

export function sanitizeText(value, maximum = 16 * 1024) {
  return (
    String(value ?? "")
      // oxlint-disable-next-line eslint/no-control-regex -- remote transcript text must remain inert
      .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
      // oxlint-disable-next-line eslint/no-control-regex -- remote transcript text must remain inert
      .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replaceAll(/scotty-managed:\/\/[^\s"'<>]+/gu, "[managed-handle]")
      .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
      // oxlint-disable-next-line eslint/no-control-regex -- preserve multiline text while removing unsafe controls
      .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
      .slice(0, maximum)
  );
}

function contentParts(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function partText(part) {
  if (typeof part === "string") return sanitizeText(part);
  return sanitizeText(part?.text ?? part?.thinking ?? part?.content ?? "");
}

function upsertMessage(messages, message) {
  if (!isObject(message)) return;
  const id = messageId(message);
  const index = id ? messages.findIndex((candidate) => messageId(candidate) === id) : -1;
  if (index >= 0) messages[index] = message;
  else if (!id && message.role === "assistant" && messages.at(-1)?.role === "assistant")
    messages[messages.length - 1] = message;
  else messages.push(message);
}

function finalizeMessage(messages, message) {
  if (!isObject(message)) return;
  if (!messageId(message) && messages.at(-1)?.role === message.role)
    messages[messages.length - 1] = message;
  else upsertMessage(messages, message);
}

function assistantDelta(event) {
  if (isObject(event.assistantMessageEvent)) return event.assistantMessageEvent;
  if (isObject(event.delta)) return event.delta;
  return event;
}

function assistantContentIndex(delta) {
  if (Number.isSafeInteger(delta.contentIndex)) return delta.contentIndex;
  if (Number.isSafeInteger(delta.content_index)) return delta.content_index;
  return 0;
}

function applyAssistantContentDelta(message, delta, type, index) {
  if (type === "toolcall_start" || type === "toolcall_delta") return;
  if (type === "toolcall_end") {
    if (isObject(delta.toolCall)) message.content[index] = delta.toolCall;
    return;
  }
  const thinking = type?.startsWith("thinking_") ?? false;
  const field = thinking ? "thinking" : "text";
  const contentType = thinking ? "thinking" : "text";
  if (type?.endsWith("_start")) {
    message.content[index] = { type: contentType, [field]: "" };
    return;
  }
  const value = sanitizeText(delta.delta ?? delta.text ?? delta.content ?? "");
  if (type?.endsWith("_end")) {
    message.content[index] = { type: contentType, [field]: value };
    return;
  }
  const previous = isObject(message.content[index]) ? message.content[index] : {};
  message.content[index] = {
    ...previous,
    type: contentType,
    [field]: sanitizeText(`${previous[field] ?? ""}${value}`),
  };
}

function appendAssistantDelta(messages, event) {
  let message = messages.at(-1);
  if (!isObject(message) || message.role !== "assistant") {
    message = { role: "assistant", content: [] };
    messages.push(message);
  }
  if (!Array.isArray(message.content)) message.content = [];
  const delta = assistantDelta(event);
  const type = firstString(delta.type, event.updateType);
  const index = assistantContentIndex(delta);
  if (index < 0 || index > 500 || index > message.content.length) return;
  applyAssistantContentDelta(message, delta, type, index);
}

function normalizedTool(raw, status) {
  if (!isObject(raw)) return undefined;
  const id = toolId(raw);
  if (!id) return undefined;
  const name = firstString(raw.toolName, raw.name);
  return {
    ...raw,
    id,
    ...(name ? { name } : {}),
    arguments: raw.arguments ?? raw.args,
    result: raw.result ?? raw.partialResult ?? raw.output,
    status,
  };
}

function hydrateMessageTools(projection) {
  for (const message of projection.messages) {
    for (const part of contentParts(message)) {
      if (!["toolCall", "tool_call", "tool-call"].includes(part?.type)) continue;
      const tool = normalizedTool(part, "running");
      if (tool) projection.tools.set(tool.id, { ...projection.tools.get(tool.id), ...tool });
    }
    if (!["toolResult", "tool_result", "tool"].includes(message?.role)) continue;
    const tool = normalizedTool(
      { ...message, result: message.content ?? message.result },
      message.isError || message.error ? "error" : "done",
    );
    if (tool) projection.tools.set(tool.id, { ...projection.tools.get(tool.id), ...tool });
  }
}

function validSnapshot(snapshot) {
  return (
    isObject(snapshot) &&
    typeof snapshot.epoch === "string" &&
    Number.isSafeInteger(snapshot.sessionRevision) &&
    Number.isSafeInteger(snapshot.baseSequence) &&
    Number.isSafeInteger(snapshot.sequence) &&
    Array.isArray(snapshot.messages) &&
    Array.isArray(snapshot.overlapEvents) &&
    Array.isArray(snapshot.activeTools) &&
    Array.isArray(snapshot.pendingUi) &&
    isObject(snapshot.queue)
  );
}

export function projectionFromSnapshot(snapshot) {
  if (!validSnapshot(snapshot)) throw new Error("Scotty returned an invalid Pi session snapshot");
  const projection = {
    epoch: snapshot.epoch,
    sessionRevision: snapshot.sessionRevision,
    sequence: snapshot.baseSequence,
    state: isObject(snapshot.state) ? { ...snapshot.state } : {},
    messages: snapshot.messages.filter(isObject).map((message) => ({ ...message })),
    tools: new Map(),
    pendingUi: new Map(),
    queue: {
      steer: Array.isArray(snapshot.queue.steer) ? [...snapshot.queue.steer] : [],
      followUp: Array.isArray(snapshot.queue.followUp) ? [...snapshot.queue.followUp] : [],
    },
    active: Boolean(snapshot.state?.isStreaming),
    overlapMessages: new Map(),
  };
  for (const message of projection.messages) {
    const signature = JSON.stringify(message);
    projection.overlapMessages.set(signature, (projection.overlapMessages.get(signature) ?? 0) + 1);
  }
  for (const raw of snapshot.activeTools) {
    const tool = normalizedTool(raw, "running");
    if (tool) projection.tools.set(tool.id, tool);
  }
  hydrateMessageTools(projection);
  for (const request of snapshot.pendingUi)
    if (isObject(request) && typeof request.id === "string" && UI_METHODS.has(request.method))
      projection.pendingUi.set(request.id, { ...request });
  for (const envelope of [...snapshot.overlapEvents].sort((a, b) => a.sequence - b.sequence)) {
    const result = applyEvent(projection, envelope);
    if (result === "refresh") throw new Error("Scotty returned a discontinuous snapshot");
  }
  if (projection.sequence !== snapshot.sequence)
    throw new Error("Scotty returned an incomplete snapshot overlap");
  projection.overlapMessages.clear();
  return projection;
}

function claimsSnapshotMessage(projection, message) {
  if (!isObject(message) || !projection.overlapMessages) return false;
  const signature = JSON.stringify(message);
  const count = projection.overlapMessages.get(signature) ?? 0;
  if (count === 0) return false;
  if (count === 1) projection.overlapMessages.delete(signature);
  else projection.overlapMessages.set(signature, count - 1);
  return true;
}

function admitEvent(projection, envelope) {
  if (!isObject(envelope) || !isObject(envelope.event)) return "ignored";
  if (envelope.epoch !== projection.epoch) return "refresh";
  if (!Number.isSafeInteger(envelope.sequence)) return "ignored";
  if (envelope.sequence <= projection.sequence) return "duplicate";
  if (envelope.sequence !== projection.sequence + 1) return "refresh";
  return envelope.event;
}

function settleTerminalEvent(projection) {
  projection.active = false;
  projection.pendingUi.clear();
  projection.queue = { steer: [], followUp: [] };
  for (const tool of projection.tools.values()) if (tool.status === "running") tool.status = "done";
}

function applyMessageEvent(projection, event) {
  if (event.type === "message_start" || event.type === "message_end") {
    if (!claimsSnapshotMessage(projection, event.message)) {
      if (event.type === "message_end") finalizeMessage(projection.messages, event.message);
      else upsertMessage(projection.messages, event.message);
    }
    return;
  }
  if (isObject(event.message)) {
    if (!claimsSnapshotMessage(projection, event.message))
      upsertMessage(projection.messages, event.message);
  } else appendAssistantDelta(projection.messages, event);
}

function applyToolEvent(projection, event) {
  const status =
    event.type === "tool_execution_end" && (event.error || event.isError)
      ? "error"
      : event.type === "tool_execution_end"
        ? "done"
        : "running";
  const tool = normalizedTool(event, status);
  if (tool) projection.tools.set(tool.id, { ...projection.tools.get(tool.id), ...tool });
}

function applyQueueEvent(projection, event) {
  projection.queue = {
    steer: Array.isArray(event.steer)
      ? [...event.steer]
      : Array.isArray(event.steering)
        ? [...event.steering]
        : [],
    followUp: Array.isArray(event.followUp) ? [...event.followUp] : [],
  };
}

function applyEventPayload(projection, event) {
  const type = event.type;
  if (["message_start", "message_end", "message_update"].includes(type)) {
    applyMessageEvent(projection, event);
  } else if (
    ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)
  ) {
    applyToolEvent(projection, event);
  } else if (type === "queue_update") {
    applyQueueEvent(projection, event);
  } else if (
    type === "extension_ui_request" &&
    UI_METHODS.has(event.method) &&
    typeof event.id === "string"
  ) {
    projection.pendingUi.set(event.id, { ...event });
  } else if (
    ["extension_ui_response", "extension_ui_cancelled", "extension_ui_closed"].includes(type)
  ) {
    if (typeof event.id === "string") projection.pendingUi.delete(event.id);
  } else if (type === "state_update" && isObject(event.state)) {
    projection.state = { ...projection.state, ...event.state };
    if (event.state.isStreaming === true) projection.active = true;
  }
}

export function applyEvent(projection, envelope) {
  const admitted = admitEvent(projection, envelope);
  if (typeof admitted === "string") return admitted;
  projection.sequence = envelope.sequence;
  const event = admitted;
  const type = event.type;
  if (type === "scotty_replay_gap" || type === "scotty_epoch_changed") return "refresh";
  if (type === "agent_start" || type === "turn_start") projection.active = true;
  if (TERMINAL_EVENTS.has(type)) settleTerminalEvent(projection);
  applyEventPayload(projection, event);
  return "applied";
}

export function conversationTurns(projection) {
  const turns = [];
  let current;
  const ensure = () => {
    if (!current) {
      current = { key: `assistant-${turns.length}`, assistants: [], tools: [] };
      turns.push(current);
    }
    return current;
  };
  for (const message of projection.messages) {
    if (message.role === "user") {
      current = {
        key: messageId(message) ?? `turn-${turns.length}`,
        user: message,
        assistants: [],
        tools: [],
      };
      turns.push(current);
    } else if (message.role === "assistant") {
      const turn = ensure();
      turn.assistants.push(message);
      for (const part of contentParts(message)) {
        if (!["toolCall", "tool_call", "tool-call"].includes(part?.type)) continue;
        const id = toolId(part);
        const tool = id ? projection.tools.get(id) : normalizedTool(part, "running");
        if (tool && !turn.tools.some((candidate) => candidate.id === tool.id))
          turn.tools.push(tool);
      }
    } else if (["toolResult", "tool_result", "tool"].includes(message.role)) {
      const turn = ensure();
      const id = toolId(message);
      const tool = id ? projection.tools.get(id) : normalizedTool(message, "done");
      if (tool && !turn.tools.some((candidate) => candidate.id === tool.id)) turn.tools.push(tool);
    } else current = undefined;
  }
  if (projection.active) {
    const turn = ensure();
    for (const tool of projection.tools.values())
      if (tool.status === "running" && !turn.tools.some((candidate) => candidate.id === tool.id))
        turn.tools.push(tool);
  }
  return turns;
}

function turnPreviewText(turn) {
  const user = turn.user ? contentParts(turn.user).map(partText).filter(Boolean).join(" ") : "";
  const assistant = turn.assistants
    .flatMap(contentParts)
    .filter((part) => typeof part === "string" || part?.type === "text")
    .map(partText)
    .filter(Boolean)
    .join(" ");
  return compactText(user || assistant || "Conversation turn", 110);
}

export function conversationPresentation(turns, visibleCount = VISIBLE_TURN_COUNT) {
  const boundary = Math.max(0, turns.length - visibleCount);
  const earlier = turns.slice(0, boundary);
  const visible = turns.slice(boundary);
  const preview = compactText(
    earlier.slice(-2).map(turnPreviewText).filter(Boolean).join(" · "),
    EARLIER_PREVIEW_LIMIT,
  );
  return { earlier, visible, preview };
}

function boundedTools(tools, maximum) {
  if (maximum === 0) return [];
  const running = tools.filter((tool) => tool.status === "running").slice(-maximum);
  const remaining = Math.max(0, maximum - running.length);
  const recent =
    remaining === 0 ? [] : tools.filter((tool) => tool.status !== "running").slice(-remaining);
  return [...running, ...recent];
}

export function currentWorkPresentation(turn, projection, maximumTools = DESKTOP_TOOL_LIMIT) {
  const thinking = turn.assistants
    .flatMap(contentParts)
    .filter((part) => part?.type === "thinking")
    .map(partText)
    .filter(Boolean)
    .at(-1);
  const tools = boundedTools(turn.tools, Math.max(0, maximumTools));
  const waiting = projection.pendingUi.size > 0;
  const failedTools = turn.tools.filter((tool) => tool.status === "error").length;
  const state = waiting
    ? "waiting"
    : projection.active
      ? "running"
      : failedTools > 0
        ? "failed"
        : "done";
  const labels = { waiting: "Waiting", running: "Running", failed: "Failed", done: "Done" };
  return {
    state,
    label: labels[state],
    thinking: thinking ? compactText(thinking, THINKING_LIMIT) : "",
    tools,
    totalTools: turn.tools.length,
    failedTools,
  };
}

export function isNearBottom(scroller, threshold = 100) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < threshold;
}

function descriptor(tag, children = [], attributes = {}) {
  return { tag, attributes, children: children.flat(Infinity) };
}

function tokenText(token) {
  return typeof token?.text === "string"
    ? token.text
    : typeof token?.raw === "string"
      ? token.raw
      : "";
}

function safeLink(href, title, baseUrl) {
  if (typeof href !== "string") return undefined;
  const compact = Array.from(href)
    .filter((character) => {
      const point = character.codePointAt(0);
      return point > 0x20 && (point < 0x7f || point > 0x9f);
    })
    .join("");
  const normalized = compact.replace(/&(?:colon|#(?:0*58|x0*3a));/giu, ":");
  const scheme = normalized.match(/^([a-z][a-z\d+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme && !SAFE_PROTOCOLS.has(`${scheme}:`)) return undefined;
  try {
    const base = new URL(baseUrl, "https://scotty.invalid/");
    const destination = new URL(href, base);
    if (!SAFE_PROTOCOLS.has(destination.protocol)) return undefined;
    const attributes = { href };
    if (title) attributes.title = title;
    if (["http:", "https:"].includes(destination.protocol) && destination.origin !== base.origin) {
      attributes.target = "_blank";
      attributes.rel = "noopener noreferrer";
    }
    return attributes;
  } catch {
    return undefined;
  }
}

function inlineNodes(tokens, baseUrl) {
  return (tokens ?? []).flatMap((token) => {
    if (token.type === "text" || token.type === "escape") return sanitizeText(tokenText(token));
    if (token.type === "strong") return descriptor("strong", inlineNodes(token.tokens, baseUrl));
    if (token.type === "em") return descriptor("em", inlineNodes(token.tokens, baseUrl));
    if (token.type === "del") return descriptor("del", inlineNodes(token.tokens, baseUrl));
    if (token.type === "codespan") return descriptor("code", [sanitizeText(tokenText(token))]);
    if (token.type === "br") return descriptor("br");
    if (token.type === "link") {
      const attributes = safeLink(token.href, token.title, baseUrl);
      return attributes
        ? descriptor("a", inlineNodes(token.tokens, baseUrl), attributes)
        : descriptor("span", inlineNodes(token.tokens, baseUrl), {
            class: "markdown-link-blocked",
          });
    }
    if (token.type === "html" || token.type === "image")
      return descriptor("span", [sanitizeText(token.raw ?? tokenText(token))], {
        class: "markdown-raw",
      });
    return Array.isArray(token.tokens)
      ? inlineNodes(token.tokens, baseUrl)
      : sanitizeText(token.raw ?? tokenText(token));
  });
}

function blockNodes(tokens, baseUrl, tight = false) {
  return (tokens ?? []).flatMap((token) => {
    if (token.type === "space" || token.type === "def") return [];
    if (token.type === "heading")
      return descriptor(
        `h${Math.min(6, Math.max(1, token.depth))}`,
        inlineNodes(token.tokens, baseUrl),
      );
    if (token.type === "paragraph") return descriptor("p", inlineNodes(token.tokens, baseUrl));
    if (token.type === "text")
      return tight
        ? inlineNodes(token.tokens, baseUrl)
        : descriptor("p", inlineNodes(token.tokens, baseUrl));
    if (token.type === "blockquote")
      return descriptor("blockquote", blockNodes(token.tokens, baseUrl));
    if (token.type === "code")
      return descriptor("pre", [descriptor("code", [sanitizeText(tokenText(token))])]);
    if (token.type === "hr") return descriptor("hr");
    if (token.type === "list")
      return descriptor(
        token.ordered ? "ol" : "ul",
        token.items.map((item) => descriptor("li", blockNodes(item.tokens, baseUrl, !item.loose))),
        token.ordered && token.start !== 1 ? { start: String(token.start) } : {},
      );
    if (token.type === "html")
      return descriptor("p", [sanitizeText(token.raw ?? tokenText(token))], {
        class: "markdown-raw",
      });
    return Array.isArray(token.tokens)
      ? blockNodes(token.tokens, baseUrl, tight)
      : descriptor("p", [sanitizeText(token.raw ?? tokenText(token))], { class: "markdown-raw" });
  });
}

export function safeMarkdownTree(source, baseUrl = "https://scotty.invalid/") {
  return typeof source === "string" && source.length > 0
    ? blockNodes(markdown.lexer(source), baseUrl)
    : [];
}

function appendDescriptor(document, parent, value) {
  if (typeof value === "string") return parent.append(document.createTextNode(value));
  const child = document.createElement(value.tag);
  for (const [name, attribute] of Object.entries(value.attributes))
    child.setAttribute(name, attribute);
  for (const nested of value.children) appendDescriptor(document, child, nested);
  parent.append(child);
}

export function renderSafeMarkdown(document, source, baseUrl) {
  const fragment = document.createDocumentFragment();
  for (const value of safeMarkdownTree(source, baseUrl))
    appendDescriptor(document, fragment, value);
  return fragment;
}

export function toolOutputText(tool) {
  const value = tool.status === "running" ? tool.arguments : (tool.result ?? tool.error);
  return value === undefined ? "" : compactText(jsonText(value), TOOL_OUTPUT_LIMIT);
}

function renderTool(document, tool, sessionId) {
  const artifact = artifactForTool(tool, sessionId);
  const row = artifact ? renderArtifactCard(document, artifact) : document.createElement("details");
  row.classList.add("work-tool");
  row.dataset.toolId = tool.id;
  row.dataset.signature = JSON.stringify(tool);
  if (artifact) return row;
  row.classList.add("tool-row", `tool-${tool.status}`);
  const summary = document.createElement("summary");
  const identity = document.createElement("span");
  identity.className = "tool-identity";
  const name = document.createElement("strong");
  name.textContent = semanticToolLabel(tool.name);
  const invocation = document.createElement("code");
  invocation.textContent = sanitizeText(tool.name ?? "tool", 120);
  identity.append(name, invocation);
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent =
    tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Done";
  summary.append(identity, status);
  row.append(summary);
  const outputText = toolOutputText(tool);
  if (outputText) {
    const output = document.createElement("pre");
    output.textContent = outputText;
    row.append(output);
  }
  return row;
}

function toolForPart(part, tools) {
  const id = toolId(part);
  return id ? tools.get(id) : normalizedTool(part, "running");
}

function renderToolActivity(document, tools, sessionId, working) {
  const activity = document.createElement("details");
  activity.className = "tool-activity";
  activity.dataset.activityState = working ? "running" : "settled";
  activity.open = working;
  activity.dataset.activityKey = tools.map((tool) => tool.id).join(",");
  const latestTool = tools.at(-1);
  const summary = document.createElement("summary");
  summary.className = "tool-activity-summary";
  const title = document.createElement("strong");
  title.textContent = working ? `${semanticToolLabel(latestTool.name)}…` : "Actions";
  const meta = document.createElement("span");
  meta.className = "tool-activity-count";
  meta.setAttribute("aria-live", "polite");
  meta.textContent = `${tools.length} ${tools.length === 1 ? "action" : "actions"}`;
  summary.append(title, meta);
  const body = document.createElement("div");
  body.className = "tool-activity-body";
  for (const tool of tools) body.append(renderTool(document, tool, sessionId));
  activity.append(summary, body);
  return activity;
}

function renderToolRun(document, thoughts, tools, sessionId, working) {
  const run = document.createElement("div");
  run.className = "tool-run";
  if (thoughts.length > 0) {
    const thinking = document.createElement("p");
    thinking.className = "thinking-line";
    thinking.textContent = compactText(thoughts.join(" · "), THINKING_LIMIT);
    run.append(thinking);
  }
  if (tools.length > 0) run.append(renderToolActivity(document, tools, sessionId, working));
  return run;
}

function renderQuestion(document, request) {
  const card = document.createElement("section");
  card.className = "question-card";
  card.dataset.requestId = request.id;
  const label = document.createElement("span");
  label.className = "question-label";
  label.textContent = "Pi needs your input";
  const title = document.createElement("h3");
  title.textContent = sanitizeText(request.title, 500);
  card.append(label, title);
  const controls = document.createElement("div");
  controls.className = "question-controls";
  if (request.method === "select") {
    for (const option of request.options ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "question-option";
      button.dataset.uiValue = String(option);
      button.dataset.focusKey = `question:${request.id}:option:${String(option)}`;
      button.textContent = sanitizeText(option, 500);
      controls.append(button);
    }
  } else if (request.method === "confirm") {
    for (const [copy, confirmed] of [
      ["Yes", "true"],
      ["No", "false"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "question-option";
      button.dataset.uiConfirmed = confirmed;
      button.dataset.focusKey = `question:${request.id}:confirm:${confirmed}`;
      button.textContent = copy;
      controls.append(button);
    }
  } else {
    const form = document.createElement("form");
    form.dataset.uiForm = "";
    const input = document.createElement(request.method === "editor" ? "textarea" : "input");
    input.name = "answer";
    input.dataset.focusKey = `question:${request.id}:answer`;
    input.placeholder = request.placeholder ?? "Your response…";
    if (request.method === "editor") input.value = request.prefill ?? "";
    const reply = document.createElement("button");
    reply.type = "submit";
    reply.dataset.focusKey = `question:${request.id}:reply`;
    reply.textContent = "Reply";
    form.append(input, reply);
    controls.append(form);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "question-cancel";
  cancel.dataset.uiCancel = "";
  cancel.dataset.focusKey = `question:${request.id}:cancel`;
  cancel.textContent = "Cancel";
  controls.append(cancel);
  card.append(controls);
  if (request.delivered)
    for (const control of card.querySelectorAll("button, input, textarea")) control.disabled = true;
  return card;
}

function renderTurn(document, turn, projection, sessionId, baseUrl, working) {
  const article = document.createElement("article");
  article.className = "chat-turn";
  article.dataset.turnKey = turn.key;
  article.dataset.signature = JSON.stringify([turn, working, projection.pendingUi.size]);
  if (turn.user) {
    const user = document.createElement("div");
    user.className = "user-message";
    user.textContent = contentParts(turn.user).map(partText).filter(Boolean).join("\n");
    article.append(user);
  }
  const tools = new Map(
    turn.tools.map((tool) => [
      tool.id,
      !projection.active && tool.status === "running" ? { ...tool, status: "done" } : tool,
    ]),
  );
  const renderedTools = new Set();
  let hasActivity = false;
  let runThoughts = [];
  let runTools = [];
  const flushToolRun = () => {
    if (runThoughts.length === 0 && runTools.length === 0) return;
    article.append(renderToolRun(document, runThoughts, runTools, sessionId, working));
    runThoughts = [];
    runTools = [];
    hasActivity = true;
  };
  const appendUnrenderedTools = () => {
    // The turn list is already bounded at the conversation level. Keep every
    // call inside a loaded turn so its call/result remains auditable and in
    // chronological order; only the compact row body is collapsed by default.
    const unrendered = [...tools.values()].filter((candidate) => !renderedTools.has(candidate.id));
    for (const tool of unrendered) {
      runTools.push(tool);
      renderedTools.add(tool.id);
    }
  };
  for (const message of turn.assistants) {
    for (const part of contentParts(message)) {
      if (part?.type === "thinking") {
        const text = partText(part);
        if (text) runThoughts.push(text);
      } else if (["toolCall", "tool_call", "tool-call"].includes(part?.type)) {
        const tool = toolForPart(part, tools);
        if (tool) {
          runTools.push(tool);
          renderedTools.add(tool.id);
        }
      } else if (part?.type === "text" || typeof part === "string") {
        const text = partText(part);
        if (!text) continue;
        flushToolRun();
        const assistant = document.createElement("div");
        assistant.className = "assistant-message";
        assistant.append(renderSafeMarkdown(document, text, baseUrl));
        article.append(assistant);
      }
    }
  }
  appendUnrenderedTools();
  flushToolRun();
  if (working && !hasActivity) {
    const progress = document.createElement("p");
    progress.className = "turn-progress";
    progress.textContent = projection.pendingUi.size > 0 ? "Waiting for your reply…" : "Thinking…";
    article.append(progress);
  }
  return article;
}

function preserveKeyedState(previous, candidate) {
  if (!previous) return candidate;
  const previousTools = new Map(
    [...previous.querySelectorAll("[data-tool-id]")].map((node) => [node.dataset.toolId, node]),
  );
  for (const next of candidate.querySelectorAll("[data-tool-id]")) {
    const before = previousTools.get(next.dataset.toolId);
    if (before?.dataset.signature === next.dataset.signature) next.replaceWith(before);
  }
  const previousActivities = [...previous.querySelectorAll(".tool-activity")];
  const previousActivitiesByKey = new Map(
    previousActivities.map((activity) => [activity.dataset.activityKey, activity]),
  );
  const nextActivities = [...candidate.querySelectorAll(".tool-activity")];
  for (const [index, next] of nextActivities.entries()) {
    const before =
      previousActivitiesByKey.get(next.dataset.activityKey) ?? previousActivities[index];
    if (before) next.open = before.open;
  }
  return candidate;
}

function renderEarlierTurns(
  document,
  presentation,
  projection,
  sessionId,
  baseUrl,
  existing,
  visibleHistoryCount,
  onShowMore,
) {
  const section = document.createElement("section");
  section.className = "earlier-turns";
  section.dataset.earlierTurns = "";
  const loaded = visibleHistoryCount > 0 ? presentation.earlier.slice(-visibleHistoryCount) : [];
  const remaining = presentation.earlier.length - loaded.length;
  section.dataset.signature = JSON.stringify([loaded.map((turn) => turn.key), remaining]);
  const header = document.createElement("div");
  header.className = "earlier-turns-header";
  const label = document.createElement("span");
  label.textContent = `${presentation.earlier.length} earlier ${presentation.earlier.length === 1 ? "turn" : "turns"}`;
  header.append(label);
  if (remaining > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "show-more-turns";
    more.dataset.focusKey = "show-more-turns";
    more.textContent = `Show ${Math.min(HISTORY_BATCH_COUNT, remaining)} more`;
    more.addEventListener("click", onShowMore);
    header.append(more);
  }
  const preview = document.createElement("span");
  preview.className = "earlier-turns-preview";
  preview.textContent = presentation.preview;
  section.append(header);
  if (loaded.length === 0 && preview.textContent) section.append(preview);
  for (const turn of loaded) {
    const candidate = renderTurn(document, turn, projection, sessionId, baseUrl, false);
    const previous = existing.get(turn.key);
    section.append(
      previous?.dataset.signature === candidate.dataset.signature
        ? previous
        : preserveKeyedState(previous, candidate),
    );
  }
  return section;
}

function captureScrollAnchor(feed, scroller) {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const node = [...feed.querySelectorAll("[data-turn-key]")].find((candidate) => {
    if (candidate.getClientRects().length === 0) return false;
    return candidate.getBoundingClientRect().bottom > scrollerTop;
  });
  return node
    ? { key: node.dataset.turnKey, offset: node.getBoundingClientRect().top - scrollerTop }
    : undefined;
}

function restoreScrollAnchor(feed, scroller, anchor) {
  if (!anchor) return false;
  const node = [...feed.querySelectorAll("[data-turn-key]")].find(
    (candidate) => candidate.dataset.turnKey === anchor.key,
  );
  if (!node || node.getClientRects().length === 0) return false;
  const nextOffset = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += nextOffset - anchor.offset;
  return true;
}

function appendEarlierTurns(
  fragment,
  {
    document,
    presentation,
    projection,
    sessionId,
    baseUrl,
    existing,
    visibleHistoryCount,
    onShowMore,
  },
) {
  if (presentation.earlier.length === 0) return;
  const earlier = renderEarlierTurns(
    document,
    presentation,
    projection,
    sessionId,
    baseUrl,
    existing,
    visibleHistoryCount,
    onShowMore,
  );
  fragment.append(earlier);
}

export function createChatView({ document, feed, scroller, newActivity, baseUrl }) {
  let renderedSignature = "";
  let historySessionId;
  let visibleHistoryCount = 0;
  let latestProjection;
  let latestSessionId;
  scroller.addEventListener(
    "scroll",
    () => {
      if (isNearBottom(scroller)) newActivity.hidden = true;
    },
    { passive: true },
  );
  newActivity.addEventListener("click", () => {
    scroller.scrollTop = scroller.scrollHeight;
    newActivity.hidden = true;
    scroller.focus({ preventScroll: true });
  });
  const view = {
    render(projection, sessionId) {
      latestProjection = projection;
      latestSessionId = sessionId;
      if (historySessionId !== sessionId) {
        historySessionId = sessionId;
        visibleHistoryCount = 0;
      }
      const followTail = isNearBottom(scroller);
      const previousScrollTop = scroller.scrollTop;
      const scrollAnchor = followTail ? undefined : captureScrollAnchor(feed, scroller);
      const focused = document.activeElement?.dataset?.focusKey;
      const selection =
        document.activeElement?.selectionStart === undefined
          ? undefined
          : {
              start: document.activeElement.selectionStart,
              end: document.activeElement.selectionEnd,
            };
      const turns = conversationTurns(projection);
      const presentation = conversationPresentation(turns);
      const signature = JSON.stringify([
        sessionId,
        projection.sequence,
        [...projection.pendingUi.keys()],
        turns.map((turn) => turn.key),
        visibleHistoryCount,
      ]);
      if (signature === renderedSignature) return;
      renderedSignature = signature;
      const existing = new Map(
        [...feed.querySelectorAll("[data-turn-key]")].map((node) => [node.dataset.turnKey, node]),
      );
      const fragment = document.createDocumentFragment();
      appendEarlierTurns(fragment, {
        document,
        presentation,
        projection,
        sessionId,
        baseUrl,
        existing,
        visibleHistoryCount,
        onShowMore: () => {
          visibleHistoryCount += HISTORY_BATCH_COUNT;
          renderedSignature = "";
          view.render(latestProjection, latestSessionId);
        },
      });
      for (const [index, turn] of presentation.visible.entries()) {
        const working = projection.active && index === presentation.visible.length - 1;
        const candidate = renderTurn(document, turn, projection, sessionId, baseUrl, working);
        const previous = existing.get(turn.key);
        fragment.append(
          previous?.dataset.signature === candidate.dataset.signature
            ? previous
            : preserveKeyedState(previous, candidate),
        );
      }
      for (const request of projection.pendingUi.values())
        fragment.append(renderQuestion(document, request));
      feed.replaceChildren(fragment);
      feed.removeAttribute("aria-busy");
      if (focused) {
        const target = [...feed.querySelectorAll("[data-focus-key]")].find(
          (node) => node.dataset.focusKey === focused,
        );
        if (target) {
          target.focus({ preventScroll: true });
          if (selection && typeof target.setSelectionRange === "function")
            target.setSelectionRange(selection.start, selection.end);
        }
      }
      if (followTail) {
        scroller.scrollTop = scroller.scrollHeight;
        newActivity.hidden = true;
      } else {
        if (!restoreScrollAnchor(feed, scroller, scrollAnchor))
          scroller.scrollTop = previousScrollTop;
        newActivity.hidden = false;
      }
    },
    reset() {
      renderedSignature = "";
      historySessionId = undefined;
      visibleHistoryCount = 0;
      newActivity.hidden = true;
    },
  };
  return view;
}
