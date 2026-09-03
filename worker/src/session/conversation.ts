import {
  CanonicalConversationSnapshotSchema,
  CONVERSATION_MAX_ID_BYTES,
  CONVERSATION_MAX_TEXT_BYTES,
  CONVERSATION_MAX_TOOL_VALUE_BYTES,
  CONVERSATION_MAX_TOOLS_PER_TURN,
  CONVERSATION_MAX_TURNS,
  CONVERSATION_WIRE_VERSION,
  type CanonicalConversationSnapshot,
  type CanonicalConversationTool,
  type CanonicalConversationTurn,
} from "../../../protocol/conversation";
import {
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PI_CONSOLE_PROXY_PREFIX,
  PiConsoleSnapshotSchema,
  type PiConsoleSnapshot,
} from "../../../protocol/pi-console";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import { readBoundedJson } from "../shared/bounded-http";

const decodePiConsoleSnapshot = Schema.decodeUnknownOption(PiConsoleSnapshotSchema, {
  onExcessProperty: "error",
});

const MAX_DISPLAY_JSON_DEPTH = 5;
const MAX_DISPLAY_JSON_NODES = 128;
const MAX_DISPLAY_JSON_ITEMS = 20;
const MAX_DISPLAY_JSON_KEYS = 20;
const MAX_TOOL_NAME_BYTES = 120;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

interface DisplayBudget {
  nodes: number;
  truncated: boolean;
}

interface ToolRecord {
  readonly id: string;
  name: string;
  status: "completed" | "running" | "failed" | "cancelled";
  arguments?: JsonValue;
  output?: JsonValue;
}

interface TurnBuilder {
  readonly id: string;
  user: string;
  assistantParts: string[];
  toolIds: string[];
  timestamps: number[];
}

interface FoldedProjection {
  readonly epoch: string;
  readonly baseSequence: number;
  sequence: number;
  active: boolean;
  terminalToolState: "completed" | "cancelled";
  readonly messages: JsonObject[];
  readonly tools: Map<string, ToolRecord>;
  readonly overlapMessages: Map<string, number>;
  valuesTruncated: boolean;
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringProperty = (value: JsonObject, key: string): string | undefined => {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
};

const numberProperty = (value: JsonObject, key: string): number | undefined => {
  const property = value[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
};

const booleanProperty = (value: JsonObject, key: string): boolean | undefined => {
  const property = value[key];
  return typeof property === "boolean" ? property : undefined;
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (utf8ByteLength(value) <= maximumBytes) return value;
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maximumBytes) end -= 1;
  return value.slice(0, end);
};

const sanitizeText = (value: string, maximumBytes: number, budget: DisplayBudget): string => {
  const sanitized = value
    // oxlint-disable-next-line eslint/no-control-regex -- display projection removes terminal controls
    .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    // oxlint-disable-next-line eslint/no-control-regex -- display projection removes ANSI controls
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll(/scotty-managed:\/\/[^\s"'<>]+/gu, "[managed-handle]")
    .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
    // oxlint-disable-next-line eslint/no-control-regex -- preserve transcript whitespace, remove unsafe controls
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  const bounded = truncateUtf8(sanitized, maximumBytes);
  if (bounded !== sanitized) budget.truncated = true;
  return bounded;
};

const boundedJsonValue = (value: JsonValue, budget: DisplayBudget, depth = 0): JsonValue => {
  budget.nodes += 1;
  if (budget.nodes > MAX_DISPLAY_JSON_NODES || depth > MAX_DISPLAY_JSON_DEPTH) {
    budget.truncated = true;
    return "[truncated]";
  }
  if (typeof value === "string")
    return sanitizeText(value, CONVERSATION_MAX_TOOL_VALUE_BYTES, budget);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const values = value
      .slice(0, MAX_DISPLAY_JSON_ITEMS)
      .map((item) => boundedJsonValue(item, budget, depth + 1));
    if (value.length > MAX_DISPLAY_JSON_ITEMS) budget.truncated = true;
    return values;
  }
  const entries = Object.entries(value).slice(0, MAX_DISPLAY_JSON_KEYS);
  if (Object.keys(value).length > MAX_DISPLAY_JSON_KEYS) budget.truncated = true;
  return Object.fromEntries(
    entries.map(([key, item]) => [
      sanitizeText(key, CONVERSATION_MAX_TOOL_VALUE_BYTES, budget),
      boundedJsonValue(item, budget, depth + 1),
    ]),
  );
};

const jsonText = (value: JsonValue | undefined, budget: DisplayBudget): string | undefined => {
  if (value === undefined) return undefined;
  const bounded = boundedJsonValue(value, budget);
  const encoded = JSON.stringify(bounded);
  if (encoded === undefined) {
    budget.truncated = true;
    return undefined;
  }
  return truncateUtf8(encoded, CONVERSATION_MAX_TOOL_VALUE_BYTES);
};

const stableIdentifier = (
  value: string | undefined,
  fallback: string,
  budget: DisplayBudget,
): string => {
  const sanitized = sanitizeText(value ?? fallback, CONVERSATION_MAX_ID_BYTES, budget).trim();
  return sanitized.length === 0 ? fallback : sanitized;
};

const messageId = (message: JsonObject): string | undefined =>
  stringProperty(message, "id") ??
  stringProperty(message, "messageId") ??
  stringProperty(message, "message_id");

const toolId = (value: JsonObject): string | undefined =>
  stringProperty(value, "toolCallId") ??
  stringProperty(value, "tool_call_id") ??
  stringProperty(value, "id") ??
  stringProperty(value, "callId");

const roleOf = (message: JsonObject): string | undefined => stringProperty(message, "role");

const contentParts = (message: JsonObject): ReadonlyArray<JsonValue> => {
  const content = message.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [content];
  return [];
};

const partText = (part: JsonValue, budget: DisplayBudget): string => {
  if (typeof part === "string") return sanitizeText(part, CONVERSATION_MAX_TEXT_BYTES, budget);
  if (!isJsonObject(part)) return "";
  const text = stringProperty(part, "text") ?? stringProperty(part, "content");
  return text === undefined ? "" : sanitizeText(text, CONVERSATION_MAX_TEXT_BYTES, budget);
};

const messageText = (message: JsonObject, budget: DisplayBudget): string =>
  contentParts(message)
    .map((part) => partText(part, budget))
    .filter((part) => part.length > 0)
    .join("\n");

const timestampOf = (value: JsonObject): number | undefined => {
  const numeric =
    numberProperty(value, "timestamp") ??
    numberProperty(value, "createdAt") ??
    numberProperty(value, "startedAt") ??
    numberProperty(value, "endedAt");
  if (numeric !== undefined) {
    if (numeric < 100_000_000_000) return numeric * 1_000;
    return numeric;
  }
  for (const key of ["timestamp", "createdAt", "startedAt", "endedAt"]) {
    const text = stringProperty(value, key);
    if (text === undefined) continue;
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const signatureOf = (value: JsonObject): string => JSON.stringify(value);

const upsertMessage = (messages: JsonObject[], message: JsonObject): void => {
  const id = messageId(message);
  const index =
    id === undefined ? -1 : messages.findIndex((candidate) => messageId(candidate) === id);
  if (index >= 0) {
    messages[index] = message;
    return;
  }
  if (
    id === undefined &&
    roleOf(message) === "assistant" &&
    roleOf(messages.at(-1) ?? {}) === "assistant"
  ) {
    messages[messages.length - 1] = message;
    return;
  }
  messages.push(message);
};

const finalizeMessage = (messages: JsonObject[], message: JsonObject): void => {
  if (messageId(message) === undefined && roleOf(messages.at(-1) ?? {}) === roleOf(message)) {
    messages[messages.length - 1] = message;
    return;
  }
  upsertMessage(messages, message);
};

const assistantDelta = (event: JsonObject): JsonObject => {
  const nested = event.assistantMessageEvent;
  if (isJsonObject(nested)) return nested;
  const delta = event.delta;
  if (isJsonObject(delta)) return delta;
  return event;
};

const assistantContentIndex = (delta: JsonObject): number => {
  const index = numberProperty(delta, "contentIndex") ?? numberProperty(delta, "content_index");
  return index !== undefined && Number.isSafeInteger(index) ? index : 0;
};

const applyAssistantContent = (
  content: JsonValue[],
  delta: JsonObject,
  event: JsonObject,
  budget: DisplayBudget,
): void => {
  const type = stringProperty(delta, "type") ?? stringProperty(event, "updateType");
  const index = assistantContentIndex(delta);
  if (index < 0 || index > 500 || index > content.length) return;
  if (type === "toolcall_start" || type === "toolcall_delta") return;
  if (type === "toolcall_end") {
    const toolCall = delta.toolCall;
    if (isJsonObject(toolCall)) content[index] = toolCall;
    return;
  }
  const thinking = type?.startsWith("thinking_") ?? false;
  const field = thinking ? "thinking" : "text";
  const contentType = thinking ? "thinking" : "text";
  if (type?.endsWith("_start")) {
    content[index] = { type: contentType, [field]: "" };
    return;
  }
  const previous = isJsonObject(content[index]) ? content[index] : {};
  const previousText = stringProperty(previous, field) ?? "";
  const nextText =
    stringProperty(delta, "delta") ??
    stringProperty(delta, "text") ??
    stringProperty(delta, "content") ??
    "";
  const text = sanitizeText(`${previousText}${nextText}`, CONVERSATION_MAX_TEXT_BYTES, budget);
  content[index] = { ...previous, type: contentType, [field]: text };
};

const applyAssistantDelta = (
  messages: JsonObject[],
  event: JsonObject,
  budget: DisplayBudget,
): void => {
  let message = messages.at(-1);
  if (message === undefined || roleOf(message) !== "assistant") {
    message = { role: "assistant", content: [] };
    messages.push(message);
  }
  const content = message.content;
  const mutableContent: JsonValue[] = Array.isArray(content) ? [...content] : [];
  const delta = assistantDelta(event);
  applyAssistantContent(mutableContent, delta, event, budget);
  messages[messages.length - 1] = { ...message, content: mutableContent };
};

const toolName = (value: JsonObject): string =>
  stringProperty(value, "toolName") ?? stringProperty(value, "name") ?? "tool";

const ensureTool = (
  projection: FoldedProjection,
  value: JsonObject,
  fallbackId: string,
  status: ToolRecord["status"],
): ToolRecord | undefined => {
  const rawId = toolId(value) ?? fallbackId;
  const id = stableIdentifier(rawId, fallbackId, { nodes: 0, truncated: false });
  const previous = projection.tools.get(id);
  const tool: ToolRecord = previous ?? {
    id,
    name: toolName(value),
    status,
  };
  tool.name =
    toolName(value) === "tool" && previous !== undefined ? previous.name : toolName(value);
  tool.status = status;
  if (value.arguments !== undefined) tool.arguments = value.arguments;
  else if (value.args !== undefined) tool.arguments = value.args;
  if (value.partialResult !== undefined) tool.output = value.partialResult;
  else if (value.result !== undefined) tool.output = value.result;
  else if (value.output !== undefined) tool.output = value.output;
  else if (isToolResultMessage(value) && value.content !== undefined) tool.output = value.content;
  projection.tools.set(id, tool);
  return tool;
};

const isToolCallPart = (part: JsonValue): part is JsonObject =>
  isJsonObject(part) &&
  ["toolCall", "tool_call", "tool-call"].includes(stringProperty(part, "type") ?? "");

const isToolResultMessage = (message: JsonObject): boolean =>
  ["toolResult", "tool_result", "tool"].includes(roleOf(message) ?? "");

const hydrateToolsFromMessage = (
  projection: FoldedProjection,
  message: JsonObject,
  messageIndex: number,
): void => {
  for (const part of contentParts(message))
    if (isToolCallPart(part)) ensureTool(projection, part, `tool-${messageIndex}`, "running");
  if (isToolResultMessage(message)) {
    const failed = booleanProperty(message, "isError") === true || message.error !== undefined;
    ensureTool(projection, message, `tool-${messageIndex}`, failed ? "failed" : "completed");
  }
};

const claimsSnapshotMessage = (projection: FoldedProjection, message: JsonObject): boolean => {
  const signature = signatureOf(message);
  const count = projection.overlapMessages.get(signature) ?? 0;
  if (count === 0) return false;
  if (count === 1) projection.overlapMessages.delete(signature);
  else projection.overlapMessages.set(signature, count - 1);
  return true;
};

const applyMessageEvent = (
  projection: FoldedProjection,
  event: JsonObject,
  budget: DisplayBudget,
): void => {
  const type = stringProperty(event, "type");
  const message = event.message;
  if ((type === "message_start" || type === "message_end") && isJsonObject(message)) {
    if (!claimsSnapshotMessage(projection, message)) {
      if (type === "message_end") finalizeMessage(projection.messages, message);
      else upsertMessage(projection.messages, message);
    }
    return;
  }
  if (type === "message_update") {
    if (isJsonObject(message)) upsertMessage(projection.messages, message);
    else applyAssistantDelta(projection.messages, event, budget);
  }
};

const applyToolEvent = (projection: FoldedProjection, event: JsonObject): void => {
  const type = stringProperty(event, "type");
  const failed = booleanProperty(event, "isError") === true || event.error !== undefined;
  const status = type === "tool_execution_end" ? (failed ? "failed" : "completed") : "running";
  ensureTool(projection, event, `tool-${projection.tools.size + 1}`, status);
};

const terminalEvent = (type: string | undefined): boolean =>
  [
    "agent_end",
    "agent_settled",
    "agent_abort",
    "agent_aborted",
    "turn_end",
    "turn_abort",
    "turn_aborted",
    "scotty_process_exit",
  ].includes(type ?? "");

const terminalToolState = (type: string | undefined): "completed" | "cancelled" =>
  type === "agent_abort" ||
  type === "agent_aborted" ||
  type === "turn_abort" ||
  type === "turn_aborted"
    ? "cancelled"
    : "completed";

const settleTools = (projection: FoldedProjection, status: "completed" | "cancelled"): void => {
  projection.terminalToolState = status;
  for (const tool of projection.tools.values()) if (tool.status === "running") tool.status = status;
};

const applyEventPayload = (
  projection: FoldedProjection,
  event: JsonObject,
  budget: DisplayBudget,
): void => {
  const type = stringProperty(event, "type");
  if (["message_start", "message_end", "message_update"].includes(type ?? "")) {
    applyMessageEvent(projection, event, budget);
    return;
  }
  if (
    ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type ?? "")
  ) {
    applyToolEvent(projection, event);
    return;
  }
  if (type === "state_update" && isJsonObject(event.state))
    if (booleanProperty(event.state, "isStreaming") === true) projection.active = true;
};

const admissibleSequence = (
  projection: FoldedProjection,
  envelope: JsonObject,
): number | undefined => {
  const epoch = stringProperty(envelope, "epoch");
  const sequence = numberProperty(envelope, "sequence");
  if (epoch !== projection.epoch || sequence === undefined || !Number.isSafeInteger(sequence))
    return undefined;
  if (sequence <= projection.sequence) return projection.sequence;
  return sequence === projection.sequence + 1 ? sequence : undefined;
};

const applyEvent = (
  projection: FoldedProjection,
  envelope: JsonObject,
  budget: DisplayBudget,
): boolean => {
  const sequence = admissibleSequence(projection, envelope);
  const event = envelope.event;
  if (sequence === undefined) return false;
  if (sequence === projection.sequence) return true;
  if (!isJsonObject(event)) return false;
  projection.sequence = sequence;
  const type = stringProperty(event, "type");
  if (type === "scotty_replay_gap" || type === "scotty_epoch_changed") return false;
  if (type === "agent_start" || type === "turn_start") projection.active = true;
  if (terminalEvent(type)) {
    projection.active = false;
    settleTools(projection, terminalToolState(type));
  }
  applyEventPayload(projection, event, budget);
  return true;
};

const toolDisplay = (
  tool: ToolRecord,
  active: boolean,
  budget: DisplayBudget,
): CanonicalConversationTool => {
  const name = sanitizeText(tool.name, MAX_TOOL_NAME_BYTES, budget);
  const invocationArgs = jsonText(tool.arguments, budget);
  const output = jsonText(tool.output, budget);
  const invocation = truncateUtf8(
    invocationArgs === undefined ? name : `${name}(${invocationArgs})`,
    CONVERSATION_MAX_TOOL_VALUE_BYTES,
  );
  if (
    invocationArgs !== undefined &&
    utf8ByteLength(invocation) < utf8ByteLength(`${name}(${invocationArgs})`)
  )
    budget.truncated = true;
  return {
    id: stableIdentifier(tool.id, "tool", budget),
    state: active && tool.status === "running" ? "running" : tool.status,
    label: semanticToolLabel(name),
    invocation,
    ...(output === undefined ? {} : { output }),
  };
};

const semanticToolLabel = (name: string): string => {
  const normalized = name.toLowerCase();
  if (/hatch/u.test(normalized)) return "Starting Hatch";
  if (/browser|playwright|evidence/u.test(normalized)) return "Testing in browser";
  if (/apply_patch|edit|write|replace/u.test(normalized)) return "Editing files";
  if (/bash|shell|exec|command|terminal/u.test(normalized)) return "Running command";
  if (/subagent|spawn_agent|wait_agent|agent/u.test(normalized)) return "Coordinating agents";
  if (/read|search|find|grep|glob|list/u.test(normalized)) return "Reading project";
  return "Using tool";
};

const turnTimestamp = (message: JsonObject): number | undefined => timestampOf(message);

const turnIdFor = (message: JsonObject, index: number, budget: DisplayBudget): string =>
  stableIdentifier(messageId(message), `turn-${index + 1}`, budget);

const turnFromBuilder = (
  builder: TurnBuilder,
  tools: Map<string, ToolRecord>,
  active: boolean,
  isLast: boolean,
  budget: DisplayBudget,
): CanonicalConversationTurn => {
  const turnTools = builder.toolIds
    .map((id) => tools.get(id))
    .filter(Predicate.isNotUndefined)
    .slice(0, CONVERSATION_MAX_TOOLS_PER_TURN)
    .map((tool) => toolDisplay(tool, active && isLast, budget));
  const failed = turnTools.filter((tool) => tool.state === "failed").length;
  const running = turnTools.filter((tool) => tool.state === "running").length;
  const assistant = sanitizeText(
    builder.assistantParts.join("\n"),
    CONVERSATION_MAX_TEXT_BYTES,
    budget,
  );
  const elapsedSeconds =
    builder.timestamps.length >= 2
      ? Math.floor((Math.max(...builder.timestamps) - Math.min(...builder.timestamps)) / 1_000)
      : undefined;
  const turn: CanonicalConversationTurn = {
    id: builder.id,
    state: active && isLast ? "streaming" : "completed",
    user: sanitizeText(builder.user, CONVERSATION_MAX_TEXT_BYTES, budget),
    assistant,
    tools: turnTools,
    ...(turnTools.length === 0
      ? {}
      : {
          activitySummary:
            running > 0
              ? `${running} ${running === 1 ? "action" : "actions"} in progress`
              : failed > 0
                ? `${failed} ${failed === 1 ? "action" : "actions"} failed`
                : `${turnTools.length} ${turnTools.length === 1 ? "action" : "actions"}`,
        }),
    ...(elapsedSeconds !== undefined && elapsedSeconds >= 0 && elapsedSeconds <= 7 * 24 * 60 * 60
      ? { elapsedSeconds }
      : {}),
  };
  return turn;
};

const buildTurns = (
  projection: FoldedProjection,
  budget: DisplayBudget,
): ReadonlyArray<CanonicalConversationTurn> => {
  const builders: TurnBuilder[] = [];
  let current: TurnBuilder | undefined;
  const ensureCurrent = (message: JsonObject, index: number): TurnBuilder => {
    if (current !== undefined) return current;
    current = {
      id: turnIdFor(message, index, budget),
      user: "",
      assistantParts: [],
      toolIds: [],
      timestamps: [],
    };
    builders.push(current);
    return current;
  };
  const addTool = (builder: TurnBuilder, value: JsonObject, index: number): void => {
    const id = toolId(value) ?? `tool-${index + 1}`;
    const known = [...projection.tools.keys()].find((candidate) => candidate === id);
    if (known !== undefined && !builder.toolIds.includes(known)) builder.toolIds.push(known);
  };

  projection.messages.forEach((message, index) => {
    const role = roleOf(message);
    if (role === "user") {
      current = {
        id: turnIdFor(message, builders.length, budget),
        user: messageText(message, budget),
        assistantParts: [],
        toolIds: [],
        timestamps: [],
      };
      const timestamp = turnTimestamp(message);
      if (timestamp !== undefined) current.timestamps.push(timestamp);
      builders.push(current);
      return;
    }
    if (role === "assistant") {
      const turn = ensureCurrent(message, index);
      const timestamp = turnTimestamp(message);
      if (timestamp !== undefined) turn.timestamps.push(timestamp);
      for (const part of contentParts(message)) {
        if (isToolCallPart(part)) addTool(turn, part, index);
        else {
          const type = isJsonObject(part) ? stringProperty(part, "type") : undefined;
          if (type === "text" || typeof part === "string") {
            const text = partText(part, budget);
            if (text.length > 0) turn.assistantParts.push(text);
          }
        }
      }
      return;
    }
    if (isToolResultMessage(message)) {
      const turn = ensureCurrent(message, index);
      addTool(turn, message, index);
      const timestamp = turnTimestamp(message);
      if (timestamp !== undefined) turn.timestamps.push(timestamp);
      return;
    }
    current = undefined;
  });

  const referencedTools = new Set(builders.flatMap((builder) => builder.toolIds));
  const lastBuilder = builders.at(-1);
  if (lastBuilder !== undefined) {
    for (const tool of projection.tools.values()) {
      if (referencedTools.has(tool.id)) continue;
      lastBuilder.toolIds.push(tool.id);
      referencedTools.add(tool.id);
    }
  }
  if (projection.active) {
    const turn = ensureCurrent({}, builders.length);
    for (const tool of projection.tools.values())
      if (tool.status === "running" && !turn.toolIds.includes(tool.id)) turn.toolIds.push(tool.id);
  }
  return builders.map((builder, index) =>
    turnFromBuilder(
      builder,
      projection.tools,
      projection.active,
      index === builders.length - 1,
      budget,
    ),
  );
};

const projectionFromSnapshot = (snapshot: PiConsoleSnapshot): FoldedProjection => {
  const messages = snapshot.messages.filter(isJsonObject).map((message) => ({ ...message }));
  const overlapMessages = new Map<string, number>();
  for (const message of messages) {
    const signature = signatureOf(message);
    overlapMessages.set(signature, (overlapMessages.get(signature) ?? 0) + 1);
  }
  const projection: FoldedProjection = {
    epoch: snapshot.epoch,
    baseSequence: snapshot.baseSequence,
    sequence: snapshot.baseSequence,
    active: isJsonObject(snapshot.state) && booleanProperty(snapshot.state, "isStreaming") === true,
    terminalToolState: "completed",
    messages,
    tools: new Map(),
    overlapMessages,
    valuesTruncated: snapshot.truncated.values,
  };
  snapshot.activeTools.forEach((tool, index) => {
    const value: JsonObject = { ...tool };
    ensureTool(projection, value, `tool-${index + 1}`, "running");
  });
  messages.forEach((message, index) => hydrateToolsFromMessage(projection, message, index));
  return projection;
};

export const canonicalConversationSnapshotFromPi = (
  snapshot: PiConsoleSnapshot,
): CanonicalConversationSnapshot | undefined => {
  const budget: DisplayBudget = { nodes: 0, truncated: false };
  const projection = projectionFromSnapshot(snapshot);
  const events = snapshot.overlapEvents
    .slice()
    .sort((left, right) => left.sequence - right.sequence);
  for (const envelope of events) {
    if (!applyEvent(projection, envelope, budget)) return undefined;
  }
  if (projection.sequence !== snapshot.sequence) return undefined;
  if (!projection.active)
    for (const tool of projection.tools.values())
      if (tool.status === "running") tool.status = projection.terminalToolState;
  let turns = [...buildTurns(projection, budget)];
  const turnsTruncated = snapshot.truncated.messages || turns.length > CONVERSATION_MAX_TURNS;
  if (turns.length > CONVERSATION_MAX_TURNS) turns = turns.slice(-CONVERSATION_MAX_TURNS);
  return {
    version: CONVERSATION_WIRE_VERSION,
    transport: {
      epoch: snapshot.epoch,
      baseSequence: snapshot.baseSequence,
      sequence: snapshot.sequence,
      sessionRevision: snapshot.sessionRevision,
    },
    turns,
    truncated: {
      turns: turnsTruncated,
      values: projection.valuesTruncated || budget.truncated,
    },
  };
};

const unavailableConversation = (): Response =>
  Response.json(
    {
      error: {
        code: "upstream",
        message: "Conversation snapshot is unavailable",
        hint: "Retry after the warm session's Pi supervisor is available.",
      },
    },
    { status: 502, headers: { "cache-control": "private, no-store" } },
  );

const wrongStateConversation = (): Response =>
  Response.json(
    {
      error: {
        code: "wrong_state",
        message: "Conversation history is unavailable while the session is not warm",
        hint: "Resume the session before opening live conversation content.",
      },
    },
    { status: 409, headers: { "cache-control": "private, no-store" } },
  );

export interface ConversationSnapshotTarget {
  readonly fetch: (request: Request) => Promise<Response>;
}

export async function inspectCanonicalConversation(
  target: ConversationSnapshotTarget,
): Promise<Response> {
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Hono must settle the native Sandbox fetch before constructing its Response
  const responseResult = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        target.fetch(
          new Request(`http://localhost${PI_CONSOLE_PROXY_PREFIX}/snapshot`, {
            headers: { accept: "application/json" },
          }),
        ),
      catch: () => undefined,
    }).pipe(Effect.result),
  );
  if (Result.isFailure(responseResult)) return unavailableConversation();
  const response = responseResult.success;
  if (response.status === 409) return wrongStateConversation();
  if (response.status !== 200) return unavailableConversation();
  const body = await readBoundedJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
  if (Option.isNone(body)) return unavailableConversation();
  const snapshot = decodePiConsoleSnapshot(body.value);
  if (Option.isNone(snapshot)) return unavailableConversation();
  const canonical = canonicalConversationSnapshotFromPi(snapshot.value);
  if (canonical === undefined) return unavailableConversation();
  return Response.json(canonical, {
    headers: { "cache-control": "private, no-store" },
  });
}

export const canonicalConversationSnapshotSchema = CanonicalConversationSnapshotSchema;
