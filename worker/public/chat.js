import { artifactForTool, renderArtifactCard } from "./artifacts.js";
import { Marked } from "./vendor/marked.esm.js";

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

function appendAssistantDelta(messages, event) {
  let message = messages.at(-1);
  if (!isObject(message) || message.role !== "assistant") {
    message = { role: "assistant", content: [] };
    messages.push(message);
  }
  if (!Array.isArray(message.content)) message.content = [];
  const delta = isObject(event.assistantMessageEvent)
    ? event.assistantMessageEvent
    : isObject(event.delta)
      ? event.delta
      : event;
  const type = firstString(delta.type, event.updateType);
  const index = Number.isSafeInteger(delta.contentIndex)
    ? delta.contentIndex
    : Number.isSafeInteger(delta.content_index)
      ? delta.content_index
      : 0;
  if (index < 0 || index > 500 || index > message.content.length) return;
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

function normalizedTool(raw, status) {
  if (!isObject(raw)) return undefined;
  const id = toolId(raw);
  if (!id) return undefined;
  return {
    ...raw,
    id,
    name: firstString(raw.toolName, raw.name, "tool"),
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

export function projectionFromSnapshot(snapshot) {
  if (
    !isObject(snapshot) ||
    snapshot.version !== 1 ||
    typeof snapshot.epoch !== "string" ||
    !Number.isSafeInteger(snapshot.sessionRevision) ||
    !Number.isSafeInteger(snapshot.baseSequence) ||
    !Number.isSafeInteger(snapshot.sequence) ||
    !Array.isArray(snapshot.messages) ||
    !Array.isArray(snapshot.overlapEvents) ||
    !Array.isArray(snapshot.activeTools) ||
    !Array.isArray(snapshot.pendingUi) ||
    !isObject(snapshot.queue)
  )
    throw new Error("Scotty returned an invalid Pi session snapshot");
  const projection = {
    version: 1,
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

export function applyEvent(projection, envelope) {
  if (!isObject(envelope) || !isObject(envelope.event)) return "ignored";
  if (envelope.epoch !== projection.epoch) return "refresh";
  if (!Number.isSafeInteger(envelope.sequence)) return "ignored";
  if (envelope.sequence <= projection.sequence) return "duplicate";
  if (envelope.sequence !== projection.sequence + 1) return "refresh";
  projection.sequence = envelope.sequence;
  const event = envelope.event;
  const type = event.type;
  if (type === "scotty_replay_gap" || type === "scotty_epoch_changed") return "refresh";
  if (type === "agent_start" || type === "turn_start") projection.active = true;
  if (TERMINAL_EVENTS.has(type)) {
    projection.active = false;
    projection.pendingUi.clear();
  }
  if (type === "message_start" || type === "message_end") {
    if (!claimsSnapshotMessage(projection, event.message))
      upsertMessage(projection.messages, event.message);
  } else if (type === "message_update") {
    if (isObject(event.message)) {
      if (!claimsSnapshotMessage(projection, event.message))
        upsertMessage(projection.messages, event.message);
    } else appendAssistantDelta(projection.messages, event);
  } else if (type === "tool_execution_start" || type === "tool_execution_update") {
    const tool = normalizedTool(event, "running");
    if (tool) projection.tools.set(tool.id, { ...projection.tools.get(tool.id), ...tool });
  } else if (type === "tool_execution_end") {
    const tool = normalizedTool(event, event.error || event.isError ? "error" : "done");
    if (tool) projection.tools.set(tool.id, { ...projection.tools.get(tool.id), ...tool });
  } else if (type === "queue_update") {
    projection.queue = {
      steer: Array.isArray(event.steer)
        ? [...event.steer]
        : Array.isArray(event.steering)
          ? [...event.steering]
          : [],
      followUp: Array.isArray(event.followUp) ? [...event.followUp] : [],
    };
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
  }
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

function markdownFragment(document, source, baseUrl) {
  const fragment = document.createDocumentFragment();
  for (const value of safeMarkdownTree(source, baseUrl))
    appendDescriptor(document, fragment, value);
  return fragment;
}

function renderTool(document, tool, sessionId) {
  const artifact = artifactForTool(tool, sessionId);
  if (artifact) return renderArtifactCard(document, artifact);
  const row = document.createElement("div");
  row.className = `tool-row tool-${tool.status}`;
  const name = document.createElement("strong");
  name.textContent = sanitizeText(tool.name ?? "Tool", 120);
  const status = document.createElement("span");
  status.textContent =
    tool.status === "running" ? "Working" : tool.status === "error" ? "Failed" : "Done";
  row.append(name, status);
  const value = tool.status === "running" ? tool.arguments : (tool.result ?? tool.error);
  if (value !== undefined) {
    const output = document.createElement("pre");
    output.textContent = sanitizeText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      4_000,
    );
    row.append(output);
  }
  return row;
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
      button.textContent = copy;
      controls.append(button);
    }
  } else {
    const form = document.createElement("form");
    form.dataset.uiForm = "";
    const input = document.createElement(request.method === "editor" ? "textarea" : "input");
    input.name = "answer";
    input.placeholder = request.placeholder ?? "Your response…";
    if (request.method === "editor") input.value = request.prefill ?? "";
    const reply = document.createElement("button");
    reply.type = "submit";
    reply.textContent = "Reply";
    form.append(input, reply);
    controls.append(form);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "question-cancel";
  cancel.dataset.uiCancel = "";
  cancel.textContent = "Cancel";
  controls.append(cancel);
  card.append(controls);
  return card;
}

function renderTurn(document, turn, projection, sessionId, baseUrl, working) {
  const article = document.createElement("article");
  article.className = "chat-turn";
  article.dataset.turnKey = turn.key;
  const signature = JSON.stringify([turn, projection.active]);
  article.dataset.signature = signature;
  if (turn.user) {
    const user = document.createElement("div");
    user.className = "user-message";
    const text = contentParts(turn.user).map(partText).filter(Boolean).join("\n");
    user.textContent = text;
    article.append(user);
  }
  const assistant = document.createElement("div");
  assistant.className = "assistant-message";
  const thinking = [];
  for (const message of turn.assistants) {
    for (const part of contentParts(message)) {
      if (part?.type === "thinking") thinking.push(partText(part));
      else if (part?.type === "text" || typeof part === "string")
        assistant.append(markdownFragment(document, partText(part), baseUrl));
    }
  }
  if (assistant.childNodes.length > 0) article.append(assistant);
  if (thinking.length > 0 || turn.tools.length > 0) {
    const details = document.createElement("details");
    details.className = "work-disclosure";
    const summary = document.createElement("summary");
    summary.textContent = working ? "Working" : "Worked";
    details.append(summary);
    for (const value of thinking) {
      const reasoning = document.createElement("p");
      reasoning.className = "reasoning";
      reasoning.textContent = value;
      details.append(reasoning);
    }
    for (const tool of turn.tools) details.append(renderTool(document, tool, sessionId));
    article.append(details);
  }
  return article;
}

export function createChatView({ document, feed, baseUrl }) {
  let renderedSignature = "";
  return {
    render(projection, sessionId) {
      const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
      const focused = document.activeElement?.dataset?.focusKey;
      const selection =
        document.activeElement?.selectionStart === undefined
          ? undefined
          : {
              start: document.activeElement.selectionStart,
              end: document.activeElement.selectionEnd,
            };
      const turns = conversationTurns(projection);
      const signature = JSON.stringify([
        sessionId,
        projection.sequence,
        [...projection.pendingUi.keys()],
        turns.map((turn) => turn.key),
      ]);
      if (signature === renderedSignature) return;
      renderedSignature = signature;
      const existing = new Map(
        [...feed.querySelectorAll("[data-turn-key]")].map((node) => [node.dataset.turnKey, node]),
      );
      const fragment = document.createDocumentFragment();
      for (const [index, turn] of turns.entries()) {
        const candidate = renderTurn(
          document,
          turn,
          projection,
          sessionId,
          baseUrl,
          projection.active && index === turns.length - 1,
        );
        const previous = existing.get(turn.key);
        fragment.append(
          previous?.dataset.signature === candidate.dataset.signature ? previous : candidate,
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
      if (nearBottom) feed.parentElement.scrollTop = feed.parentElement.scrollHeight;
    },
    reset() {
      renderedSignature = "";
    },
  };
}
