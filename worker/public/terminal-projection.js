import {
  createMessageProjectionState,
  finishMessageSnapshot,
  projectMessageEvent,
} from "./terminal-message-projection.js";
import { appendAssistantMessageDelta } from "./terminal-timeline.js";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function firstArray(...values) {
  return values.find(Array.isArray) ?? [];
}

export function firstObject(...values) {
  return values.find(isObject) ?? {};
}

export function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function numberValue(...values) {
  return values.find((value) => Number.isFinite(value));
}

export function messageText(value) {
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

export function contentParts(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

export function blankProjection() {
  return {
    epoch: undefined,
    sessionRevision: undefined,
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

export function projectionFromSnapshot(body) {
  const { outer, snapshot } = unwrapSnapshot(body);
  const state = firstObject(snapshot.state, outer.state);
  const projection = blankProjection();
  projection.epoch = firstString(outer.epoch, snapshot.epoch);
  projection.sessionRevision = numberValue(outer.sessionRevision, snapshot.sessionRevision);
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
  const extensionSurface = firstObject(snapshot.extensionSurface, outer.extensionSurface);
  projection.state = {
    ...state,
    extensionStatus: firstObject(extensionSurface.statuses),
    ...(typeof extensionSurface.title === "string"
      ? { extensionTitle: extensionSurface.title }
      : {}),
  };
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
  const tools = firstArray(snapshot.activeTools, snapshot.tools, snapshot.toolCalls, state.tools);
  for (const tool of tools) upsertTool(projection, tool);
  hydrateToolsFromMessages(projection);
  for (const widget of firstArray(extensionSurface.widgets))
    applyExtensionSurface(projection, {
      method: "setWidget",
      widgetKey: widget?.key,
      widgetLines: widget?.lines,
    });
  const pendingUi = firstArray(
    snapshot.pendingUi,
    snapshot.pending_ui,
    state.pendingUi,
    state.pending_ui,
    snapshot.uiRequests,
  );
  for (const request of pendingUi) upsertUiRequest(projection, request);
  const snapshotEvents = firstArray(outer.overlapEvents, snapshot.overlapEvents).sort(
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
      if (type === "toolCall" || type === "tool_call" || type === "tool-call")
        upsertTool(projection, part, "running");
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
    projection.state = { ...projection.state, extensionStatus: statuses };
  } else if (method === "setTitle" && request.title) {
    projection.state = { ...projection.state, extensionTitle: request.title };
  } else if (method === "set_editor_text") {
    projection.state = { ...projection.state, editorText: request.text ?? "" };
  }
}

export function eventPayload(payload) {
  const outer = firstObject(payload);
  const event = firstObject(outer.event, outer.data, outer);
  return { outer, event };
}

export function applyEvent(projection, payload) {
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
    else appendAssistantMessageDelta(projection.messages, event);
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
