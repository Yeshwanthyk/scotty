import {
  commandIntentDigest,
  PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER,
  redactCredentialSentinels,
} from "../../protocol/pi-console-shared.mjs";

export { commandIntentDigest };

export const PI_CONSOLE_PROTOCOL_VERSION = 1;
export const PI_CONSOLE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PI_CONSOLE_MAX_COMMAND_BYTES = 8 * 1024 * 1024;
export const PI_CONSOLE_MAX_IMAGES = 4;
export const PI_CONSOLE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PI_CONSOLE_MAX_EVENT_BYTES = 256 * 1024;
export const PI_CONSOLE_MAX_EVENTS = 2_000;
export const PI_CONSOLE_MAX_MESSAGES = 500;
export const PI_CONSOLE_MAX_ACTIVE_TOOLS = 100;
export const PI_CONSOLE_MAX_PENDING_UI = 32;
export const PI_CONSOLE_MAX_STATUSES = 32;
export const PI_CONSOLE_MAX_WIDGETS = 16;
export const PI_CONSOLE_MAX_WIDGET_LINES = 20;
export const PI_CONSOLE_MAX_QUEUE_ITEMS = 100;
export const PI_CONSOLE_MAX_SELECT_OPTIONS = 100;
export { PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER };

const maxStringBytes = 16 * 1024;
const maxDepth = 12;
const maxArrayItems = 500;
const maxObjectKeys = 100;
const maxNodes = 20_000;
const remoteSlashCommands = new Set(["subagents", "workflows"]);
const imageCommandTypes = new Set(["prompt", "steer", "follow_up"]);
const allowedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const maxBase64ImageCharacters = Math.ceil(PI_CONSOLE_MAX_IMAGE_BYTES / 3) * 4;
const commandTypes = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "extension_ui_response",
  "set_model",
  "set_thinking_level",
  "slash_command",
]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const workflowRunIdPattern = /^wf_[0-9a-f]{12}$/u;
export const PI_SUBAGENTS_ACTIVITY_WIDGET_KEY = "pi-subagents/activity/v1";
export const PI_SUBAGENTS_ACTIVITY_PROTOCOL_VERSION = 1;
export const PI_SUBAGENTS_ACTIVITY_LIMITS = Object.freeze({
  maxRunningChildren: 4,
  maxSnapshotBytes: 15 * 1024,
  maxChildIdLength: 64,
  maxTitleLength: 160,
  maxPromptLength: 2048,
  maxOutputLength: 4096,
  maxFailureLength: 2048,
  maxModelLength: 120,
  maxTranscriptItems: 16,
  maxTranscriptTextLength: 512,
  maxToolCount: 4,
  maxToolNameLength: 120,
  maxToolArgsLength: 512,
  maxToolOutputLength: 512,
  maxQueuedItems: 4,
  maxQueuedTextLength: 512,
});

const isBase64Character = (code) =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47;
const isBase64 = (data) => {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index += 1)
    if (!isBase64Character(data.charCodeAt(index))) return false;
  for (let index = contentLength; index < data.length; index += 1)
    if (data.charCodeAt(index) !== 61) return false;
  return true;
};
const decodedBase64Bytes = (data) =>
  (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const validImages = (images) => {
  if (images === undefined) return true;
  if (!Array.isArray(images) || images.length > PI_CONSOLE_MAX_IMAGES) return false;
  let decodedBytes = 0;
  for (const image of images) {
    if (
      !image ||
      typeof image !== "object" ||
      Array.isArray(image) ||
      Object.keys(image).length !== 3 ||
      image.type !== "image" ||
      typeof image.data !== "string" ||
      image.data.length > maxBase64ImageCharacters ||
      !isBase64(image.data) ||
      !allowedImageMimeTypes.has(image.mimeType)
    )
      return false;
    decodedBytes += decodedBase64Bytes(image.data);
    if (decodedBytes > PI_CONSOLE_MAX_IMAGE_BYTES) return false;
  }
  return true;
};

const isBoundedString = (value) =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxStringBytes;
const isIdentifier = (value) => typeof value === "string" && identifierPattern.test(value);

const truncateUtf8 = (value, maxBytes) => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
};

export const sanitizeRemoteString = (value) =>
  truncateUtf8(
    redactCredentialSentinels(
      value
        // oxlint-disable-next-line eslint/no-control-regex -- sanitizer intentionally matches OSC control bytes
        .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
        // oxlint-disable-next-line eslint/no-control-regex -- sanitizer intentionally matches ANSI escape bytes
        .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""),
    )
      .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
      // oxlint-disable-next-line eslint/no-control-regex -- remote projections exclude terminal control bytes
      .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ""),
    maxStringBytes,
  );

const browserTopLevelKeys = ["version", "revision", "generatedAt", "children", "terminal"];
const browserChildKeys = [
  "id",
  "backend",
  "model",
  "reasoningEffort",
  "title",
  "status",
  "prompt",
  "output",
  "failure",
  "transcript",
  "tools",
  "queued",
  "startedAt",
  "lastActivityAt",
  "settledAt",
  "usage",
];
const browserToolKeys = ["name", "args", "output", "startedAt", "updatedAt", "isError"];
const browserTerminalKeys = ["id", "title", "status", "output", "failure", "settledAt"];
const browserOnlyKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const browserClean = (value) => sanitizeRemoteString(value);
const browserText = (value, max) =>
  typeof value === "string" && Array.from(value).length <= max ? browserClean(value) : undefined;
const browserNumber = (value, integer = false) =>
  typeof value === "number" && Number.isFinite(value) && (!integer || Number.isSafeInteger(value))
    ? value
    : undefined;
const browserId = (value) => {
  const id = browserText(value, PI_SUBAGENTS_ACTIVITY_LIMITS.maxChildIdLength);
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) ? id : undefined;
};
const browserOptionalText = (value, max) =>
  value === undefined ? undefined : browserText(value, max);
const browserValidTranscript = (value) => {
  if (
    !browserOnlyKeys(value, ["kind", "text", "redacted", "name", "args", "output", "isError"]) ||
    typeof value.kind !== "string"
  )
    return undefined;
  if (value.kind === "user" || value.kind === "assistant")
    return browserOnlyKeys(value, ["kind", "text"]) &&
      browserText(value.text, PI_SUBAGENTS_ACTIVITY_LIMITS.maxTranscriptTextLength) !== undefined
      ? {
          kind: value.kind,
          text: browserText(value.text, PI_SUBAGENTS_ACTIVITY_LIMITS.maxTranscriptTextLength),
        }
      : undefined;
  if (value.kind === "thinking")
    return browserOnlyKeys(value, ["kind", "text", "redacted"]) &&
      (value.redacted === undefined || typeof value.redacted === "boolean") &&
      browserText(value.text, PI_SUBAGENTS_ACTIVITY_LIMITS.maxTranscriptTextLength) !== undefined
      ? {
          kind: "thinking",
          text: browserText(value.text, PI_SUBAGENTS_ACTIVITY_LIMITS.maxTranscriptTextLength),
          ...(value.redacted === undefined ? {} : { redacted: value.redacted }),
        }
      : undefined;
  if (
    value.kind !== "tool" ||
    !browserOnlyKeys(value, ["kind", "name", "args", "output", "isError"]) ||
    (value.isError !== undefined && typeof value.isError !== "boolean")
  )
    return undefined;
  const name = browserText(value.name, PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolNameLength);
  const args = browserOptionalText(value.args, PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolArgsLength);
  const output = browserOptionalText(
    value.output,
    PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolOutputLength,
  );
  return name === undefined ||
    (value.args !== undefined && args === undefined) ||
    (value.output !== undefined && output === undefined)
    ? undefined
    : {
        kind: "tool",
        name,
        ...(args === undefined ? {} : { args }),
        ...(output === undefined ? {} : { output }),
        ...(value.isError === undefined ? {} : { isError: value.isError }),
      };
};
const browserValidTool = (value) => {
  if (!browserOnlyKeys(value, browserToolKeys)) return undefined;
  const name = browserText(value.name, PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolNameLength);
  const args = browserOptionalText(value.args, PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolArgsLength);
  const output = browserOptionalText(
    value.output,
    PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolOutputLength,
  );
  const startedAt = browserNumber(value.startedAt);
  const updatedAt = browserNumber(value.updatedAt);
  return name === undefined ||
    startedAt === undefined ||
    updatedAt === undefined ||
    (value.args !== undefined && args === undefined) ||
    (value.output !== undefined && output === undefined) ||
    (value.isError !== undefined && typeof value.isError !== "boolean")
    ? undefined
    : {
        name,
        ...(args === undefined ? {} : { args }),
        ...(output === undefined ? {} : { output }),
        startedAt,
        updatedAt,
        ...(value.isError === undefined ? {} : { isError: value.isError }),
      };
};
const browserValidQueued = (value) => {
  if (
    !browserOnlyKeys(value, ["kind", "text"]) ||
    (value.kind !== "steer" && value.kind !== "follow-up")
  )
    return undefined;
  const text = browserText(value.text, PI_SUBAGENTS_ACTIVITY_LIMITS.maxQueuedTextLength);
  return text === undefined ? undefined : { kind: value.kind, text };
};
const browserValidUsage = (value) => {
  if (!browserOnlyKeys(value, ["tokens", "contextWindow"])) return undefined;
  const tokens = value.tokens === undefined ? undefined : browserNumber(value.tokens);
  const contextWindow =
    value.contextWindow === undefined ? undefined : browserNumber(value.contextWindow);
  return (value.tokens !== undefined && (tokens === undefined || tokens < 0)) ||
    (value.contextWindow !== undefined && (contextWindow === undefined || contextWindow < 0))
    ? undefined
    : {
        ...(tokens === undefined ? {} : { tokens }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      };
};
const browserValidChild = (value) => {
  if (
    !browserOnlyKeys(value, browserChildKeys) ||
    browserId(value?.id) !== value?.id ||
    !["pi", "claude", "codex"].includes(value?.backend) ||
    value?.status !== "running"
  )
    return undefined;
  const model = browserOptionalText(value.model, PI_SUBAGENTS_ACTIVITY_LIMITS.maxModelLength);
  const title = browserText(value.title, PI_SUBAGENTS_ACTIVITY_LIMITS.maxTitleLength);
  const prompt = browserText(value.prompt, PI_SUBAGENTS_ACTIVITY_LIMITS.maxPromptLength);
  const output = browserText(value.output, PI_SUBAGENTS_ACTIVITY_LIMITS.maxOutputLength);
  const failure = browserOptionalText(value.failure, PI_SUBAGENTS_ACTIVITY_LIMITS.maxFailureLength);
  const startedAt = browserNumber(value.startedAt);
  const lastActivityAt = browserNumber(value.lastActivityAt);
  const settledAt = value.settledAt === undefined ? undefined : browserNumber(value.settledAt);
  const transcript =
    Array.isArray(value.transcript) &&
    value.transcript.length <= PI_SUBAGENTS_ACTIVITY_LIMITS.maxTranscriptItems
      ? value.transcript.map(browserValidTranscript)
      : undefined;
  const tools =
    Array.isArray(value.tools) && value.tools.length <= PI_SUBAGENTS_ACTIVITY_LIMITS.maxToolCount
      ? value.tools.map(browserValidTool)
      : undefined;
  const queued =
    Array.isArray(value.queued) &&
    value.queued.length <= PI_SUBAGENTS_ACTIVITY_LIMITS.maxQueuedItems
      ? value.queued.map(browserValidQueued)
      : undefined;
  const usage = value.usage === undefined ? undefined : browserValidUsage(value.usage);
  const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (
    (model === undefined && value.model !== undefined) ||
    title === undefined ||
    prompt === undefined ||
    output === undefined ||
    (failure === undefined && value.failure !== undefined) ||
    startedAt === undefined ||
    lastActivityAt === undefined ||
    (settledAt === undefined && value.settledAt !== undefined) ||
    !transcript?.every(Boolean) ||
    !tools?.every(Boolean) ||
    !queued?.every(Boolean) ||
    (usage === undefined && value.usage !== undefined) ||
    (value.reasoningEffort !== undefined && !efforts.includes(value.reasoningEffort))
  )
    return undefined;
  return {
    id: value.id,
    backend: value.backend,
    ...(model === undefined ? {} : { model }),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    title,
    status: "running",
    prompt,
    output,
    ...(failure === undefined ? {} : { failure }),
    transcript,
    tools,
    queued,
    startedAt,
    lastActivityAt,
    ...(settledAt === undefined ? {} : { settledAt }),
    ...(value.usage === undefined ? {} : { usage }),
  };
};
const browserValidTerminal = (value) => {
  if (
    !browserOnlyKeys(value, browserTerminalKeys) ||
    browserId(value?.id) !== value?.id ||
    !["done", "error"].includes(value?.status)
  )
    return undefined;
  const title = browserText(value.title, PI_SUBAGENTS_ACTIVITY_LIMITS.maxTitleLength);
  const output = browserText(value.output, PI_SUBAGENTS_ACTIVITY_LIMITS.maxOutputLength);
  const failure = browserOptionalText(value.failure, PI_SUBAGENTS_ACTIVITY_LIMITS.maxFailureLength);
  const settledAt = browserNumber(value.settledAt);
  return title === undefined ||
    output === undefined ||
    settledAt === undefined ||
    (value.failure !== undefined && failure === undefined)
    ? undefined
    : {
        id: value.id,
        title,
        status: value.status,
        output,
        ...(failure === undefined ? {} : { failure }),
        settledAt,
      };
};
export const canonicalizePiSubagentsActivity = (value) => {
  let parsed = value;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1 || typeof parsed[0] !== "string") return undefined;
    parsed = parsed[0];
  }
  if (typeof parsed === "string") {
    if (Buffer.byteLength(parsed, "utf8") > PI_SUBAGENTS_ACTIVITY_LIMITS.maxSnapshotBytes)
      return undefined;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (
    !browserOnlyKeys(parsed, browserTopLevelKeys) ||
    parsed.version !== PI_SUBAGENTS_ACTIVITY_PROTOCOL_VERSION ||
    browserNumber(parsed.revision, true) === undefined ||
    parsed.revision < 0 ||
    browserNumber(parsed.generatedAt) === undefined ||
    !Array.isArray(parsed.children) ||
    parsed.children.length > PI_SUBAGENTS_ACTIVITY_LIMITS.maxRunningChildren
  )
    return undefined;
  const children = parsed.children.map(browserValidChild);
  const terminal =
    parsed.terminal === undefined ? undefined : browserValidTerminal(parsed.terminal);
  if (
    !children.every(Boolean) ||
    (terminal === undefined && parsed.terminal !== undefined) ||
    new Set(children.map((child) => child.id)).size !== children.length
  )
    return undefined;
  const snapshot = {
    version: 1,
    revision: parsed.revision,
    generatedAt: parsed.generatedAt,
    children,
    ...(terminal === undefined ? {} : { terminal }),
  };
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8") <=
    PI_SUBAGENTS_ACTIVITY_LIMITS.maxSnapshotBytes
    ? snapshot
    : undefined;
};
export const normalizePiSubagentsActivityWidget = (message) => {
  if (!message || message.widgetKey !== PI_SUBAGENTS_ACTIVITY_WIDGET_KEY) return message;
  if (message.widgetLines === null) return { ...message, widgetLines: null };
  const snapshot = canonicalizePiSubagentsActivity(message.widgetLines);
  return snapshot === undefined
    ? undefined
    : { ...message, widgetLines: [JSON.stringify(snapshot)] };
};

const optionalTimeout = (message) => {
  if (message.timeout === undefined) return {};
  return Number.isFinite(message.timeout) ? { timeout: message.timeout } : undefined;
};

export const normalizeExtensionUiEvent = (message) => {
  if (!message || typeof message !== "object" || message.type !== "extension_ui_request")
    return message;
  if (!isIdentifier(message.id)) return undefined;
  const id = sanitizeRemoteString(message.id);
  if (message.method === "select") {
    const timeout = optionalTimeout(message);
    if (
      timeout === undefined ||
      !isBoundedString(message.title) ||
      !Array.isArray(message.options) ||
      message.options.length > PI_CONSOLE_MAX_SELECT_OPTIONS ||
      !message.options.every(isBoundedString)
    )
      return undefined;
    return {
      type: message.type,
      id,
      method: message.method,
      title: sanitizeRemoteString(message.title),
      options: message.options.map(sanitizeRemoteString),
      ...timeout,
    };
  }
  if (message.method === "confirm") {
    const timeout = optionalTimeout(message);
    if (
      timeout === undefined ||
      !isBoundedString(message.title) ||
      !isBoundedString(message.message)
    )
      return undefined;
    return {
      type: message.type,
      id,
      method: message.method,
      title: sanitizeRemoteString(message.title),
      message: sanitizeRemoteString(message.message),
      ...timeout,
    };
  }
  if (message.method === "input") {
    const timeout = optionalTimeout(message);
    if (
      timeout === undefined ||
      !isBoundedString(message.title) ||
      (message.placeholder !== undefined && !isBoundedString(message.placeholder))
    )
      return undefined;
    return {
      type: message.type,
      id,
      method: message.method,
      title: sanitizeRemoteString(message.title),
      ...(message.placeholder === undefined
        ? {}
        : { placeholder: sanitizeRemoteString(message.placeholder) }),
      ...timeout,
    };
  }
  if (message.method === "editor") {
    if (
      !isBoundedString(message.title) ||
      (message.prefill !== undefined && !isBoundedString(message.prefill))
    )
      return undefined;
    return {
      type: message.type,
      id,
      method: message.method,
      title: sanitizeRemoteString(message.title),
      ...(message.prefill === undefined ? {} : { prefill: sanitizeRemoteString(message.prefill) }),
    };
  }
  if (message.method === "notify") {
    if (
      !isBoundedString(message.message) ||
      (message.notifyType !== undefined &&
        message.notifyType !== "info" &&
        message.notifyType !== "warning" &&
        message.notifyType !== "error")
    )
      return undefined;
    return {
      type: message.type,
      id,
      method: message.method,
      message: sanitizeRemoteString(message.message),
      ...(message.notifyType === undefined ? {} : { notifyType: message.notifyType }),
    };
  }
  if (message.method === "setStatus") {
    if (
      !isIdentifier(message.statusKey) ||
      (message.statusText !== undefined &&
        message.statusText !== null &&
        !isBoundedString(message.statusText))
    )
      return undefined;
    return {
      type: message.type,
      id,
      method: message.method,
      statusKey: sanitizeRemoteString(message.statusKey),
      statusText:
        typeof message.statusText === "string" ? sanitizeRemoteString(message.statusText) : null,
    };
  }
  if (message.method === "setWidget") {
    if (
      (message.widgetKey !== PI_SUBAGENTS_ACTIVITY_WIDGET_KEY &&
        !isIdentifier(message.widgetKey)) ||
      (message.widgetLines !== undefined &&
        message.widgetLines !== null &&
        (!Array.isArray(message.widgetLines) ||
          message.widgetLines.length > PI_CONSOLE_MAX_WIDGET_LINES ||
          !message.widgetLines.every(isBoundedString))) ||
      (message.widgetPlacement !== undefined &&
        message.widgetPlacement !== "aboveEditor" &&
        message.widgetPlacement !== "belowEditor")
    )
      return undefined;
    const normalizedWidget = {
      type: message.type,
      id,
      method: message.method,
      widgetKey: sanitizeRemoteString(message.widgetKey),
      widgetLines: Array.isArray(message.widgetLines)
        ? message.widgetLines.map(sanitizeRemoteString)
        : null,
      ...(message.widgetPlacement === undefined
        ? {}
        : { widgetPlacement: message.widgetPlacement }),
    };
    return normalizePiSubagentsActivityWidget(normalizedWidget);
  }
  if (message.method === "setTitle" && isBoundedString(message.title))
    return {
      type: message.type,
      id,
      method: message.method,
      title: sanitizeRemoteString(message.title),
    };
  if (message.method === "set_editor_text" && isBoundedString(message.text))
    return {
      type: message.type,
      id,
      method: message.method,
      text: sanitizeRemoteString(message.text),
    };
  return undefined;
};

export const shouldEmitSseHeartbeat = (headers) =>
  headers[PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER] !== "1";

export const sanitizeRemoteValue = (input) => {
  const budget = { nodes: 0, truncated: false };
  const visit = (value, depth) => {
    budget.nodes += 1;
    if (budget.nodes > maxNodes || depth > maxDepth) {
      budget.truncated = true;
      return null;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const sanitized = sanitizeRemoteString(value);
      if (sanitized !== value) budget.truncated = true;
      return sanitized;
    }
    if (Array.isArray(value)) {
      if (value.length > maxArrayItems) budget.truncated = true;
      return value.slice(0, maxArrayItems).map((item) => visit(item, depth + 1));
    }
    if (typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > maxObjectKeys) budget.truncated = true;
      return Object.fromEntries(
        entries
          .slice(0, maxObjectKeys)
          .map(([key, item]) => [sanitizeRemoteString(key), visit(item, depth + 1)]),
      );
    }
    budget.truncated = true;
    return null;
  };
  return { value: visit(input, 0), truncated: budget.truncated };
};

export const sanitizeRemoteEvent = (event) => {
  const sanitized = sanitizeRemoteValue(event).value;
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= PI_CONSOLE_MAX_EVENT_BYTES)
    return sanitized;
  return {
    type: "scotty_event_truncated",
    originalType:
      event && typeof event === "object" && typeof event.type === "string"
        ? sanitizeRemoteString(event.type)
        : "unknown",
  };
};

const firstString = (...values) => values.find((value) => typeof value === "string");
const boundedId = (value, fallback) => {
  const sanitized = sanitizeRemoteString(typeof value === "string" && value ? value : fallback)
    .replaceAll(/[^A-Za-z0-9_.:-]/gu, "_")
    .slice(0, 200);
  return /^[A-Za-z0-9]/u.test(sanitized) ? sanitized : `id_${sanitized}`.slice(0, 200);
};
const boundedMapSet = (map, key, value, limit) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
};
const queueItems = (value, kind) =>
  (Array.isArray(value) ? value : []).slice(0, PI_CONSOLE_MAX_QUEUE_ITEMS).map((item, index) => ({
    id: `${kind}-${index}`,
    text: sanitizeRemoteString(typeof item === "string" ? item : JSON.stringify(item)),
  }));

export const createPendingUiTracker = ({ schedule, cancel, onExpire, onOverflow }) => {
  const requests = new Map();
  const timers = new Map();
  const delivered = new Set();
  const remove = (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) cancel(timer);
    timers.delete(id);
    requests.delete(id);
    delivered.delete(id);
  };
  return {
    track: (message) => {
      remove(message.id);
      if (requests.size >= PI_CONSOLE_MAX_PENDING_UI) {
        const oldestId = requests.keys().next().value;
        onOverflow(oldestId);
        remove(oldestId);
      }
      requests.set(message.id, sanitizeRemoteValue(message).value);
      if (Number.isFinite(message.timeout) && message.timeout > 0) {
        timers.set(
          message.id,
          schedule(
            () => {
              remove(message.id);
              onExpire(message.id);
            },
            Math.min(message.timeout, 2_147_483_647),
          ),
        );
      }
    },
    remove,
    clear: () => {
      for (const id of requests.keys()) remove(id);
    },
    has: (id) => requests.has(id),
    isDelivered: (id) => delivered.has(id),
    markDelivered: (id) => {
      if (requests.has(id)) delivered.add(id);
    },
    values: () => [...requests.values()],
  };
};

export const createProjectionReducer = () => {
  const activeTools = new Map();
  const statuses = new Map();
  const widgets = new Map();
  let title;
  let queue = { steer: [], followUp: [] };

  const reduce = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      const id = boundedId(firstString(event.toolCallId, event.tool_call_id, event.id), "tool");
      const previous = activeTools.get(id) ?? {};
      const argumentsValue = sanitizeRemoteValue(event.args ?? event.arguments).value;
      const partialResult = sanitizeRemoteValue(event.partialResult ?? event.output).value;
      boundedMapSet(
        activeTools,
        id,
        {
          ...previous,
          id,
          name: sanitizeRemoteString(firstString(event.toolName, event.name) ?? "tool"),
          status: "running",
          ...(argumentsValue === null ? {} : { arguments: argumentsValue }),
          ...(partialResult === null ? {} : { partialResult }),
        },
        PI_CONSOLE_MAX_ACTIVE_TOOLS,
      );
    } else if (event.type === "tool_execution_end") {
      const id = boundedId(firstString(event.toolCallId, event.tool_call_id, event.id), "tool");
      activeTools.delete(id);
    } else if (event.type === "queue_update") {
      queue = {
        steer: queueItems(event.steering ?? event.steer, "steer"),
        followUp: queueItems(event.followUp ?? event.follow_up, "follow-up"),
      };
    } else if (
      event.type === "agent_settled" ||
      event.type === "agent_end" ||
      event.type === "turn_end" ||
      event.type === "agent_abort" ||
      event.type === "agent_aborted" ||
      event.type === "turn_abort" ||
      event.type === "turn_aborted"
    ) {
      activeTools.clear();
      queue = { steer: [], followUp: [] };
    } else if (event.type === "extension_ui_request") {
      if (event.method === "setStatus") {
        const key = boundedId(event.statusKey, "status");
        if (typeof event.statusText === "string")
          boundedMapSet(
            statuses,
            key,
            sanitizeRemoteString(event.statusText),
            PI_CONSOLE_MAX_STATUSES,
          );
        else statuses.delete(key);
      } else if (event.method === "setWidget") {
        const key = boundedId(event.widgetKey, "widget");
        if (Array.isArray(event.widgetLines))
          boundedMapSet(
            widgets,
            key,
            {
              key,
              lines: event.widgetLines
                .filter((line) => typeof line === "string")
                .slice(0, PI_CONSOLE_MAX_WIDGET_LINES)
                .map(sanitizeRemoteString),
              ...(event.widgetPlacement === "aboveEditor" || event.widgetPlacement === "belowEditor"
                ? { placement: event.widgetPlacement }
                : {}),
            },
            PI_CONSOLE_MAX_WIDGETS,
          );
        else widgets.delete(key);
      } else if (event.method === "setTitle") {
        title = sanitizeRemoteString(typeof event.title === "string" ? event.title : "");
      }
    }
  };

  return {
    reduce,
    snapshot: () => ({
      activeTools: [...activeTools.values()],
      queue,
      extensionSurface: {
        statuses: Object.fromEntries(statuses),
        widgets: [...widgets.values()],
        ...(title === undefined ? {} : { title }),
      },
    }),
    clearVolatile: () => {
      activeTools.clear();
      queue = { steer: [], followUp: [] };
    },
  };
};

export const completeSnapshotOverlap = (events, baseSequence, endSequence) => {
  const overlapEvents = events.filter(
    (envelope) => envelope.sequence > baseSequence && envelope.sequence <= endSequence,
  );
  if (endSequence === baseSequence) return [];
  if (
    overlapEvents.length !== endSequence - baseSequence ||
    overlapEvents[0]?.sequence !== baseSequence + 1 ||
    overlapEvents.at(-1)?.sequence !== endSequence ||
    overlapEvents.some((envelope, index) => envelope.sequence !== baseSequence + index + 1)
  )
    return undefined;
  return overlapEvents;
};

const validCommandId = (value) => typeof value === "string" && uuidPattern.test(value);

const validIntent = (command) => {
  if (!commandTypes.has(command.type))
    return {
      ok: false,
      error: command.type === "fold" ? "local_intent_only" : "invalid_command",
    };
  if (!imageCommandTypes.has(command.type) && command.images !== undefined)
    return { ok: false, error: "invalid_command" };
  if (command.type === "prompt") {
    if (
      !isBoundedString(command.message) ||
      !validImages(command.images) ||
      (command.streamingBehavior !== undefined &&
        command.streamingBehavior !== "steer" &&
        command.streamingBehavior !== "followUp")
    )
      return { ok: false, error: "invalid_command" };
    if (command.message.trimStart().startsWith("/"))
      return { ok: false, error: "slash_prompt_requires_intent" };
  } else if (command.type === "steer" || command.type === "follow_up") {
    if (!isBoundedString(command.message) || !validImages(command.images))
      return { ok: false, error: "invalid_command" };
  } else if (command.type === "extension_ui_response") {
    if (
      !isIdentifier(command.id) ||
      !(
        isBoundedString(command.value) ||
        typeof command.confirmed === "boolean" ||
        command.cancelled === true
      )
    )
      return { ok: false, error: "invalid_command" };
  } else if (command.type === "set_model") {
    if (
      !isBoundedString(command.provider) ||
      !command.provider ||
      !isBoundedString(command.modelId) ||
      !command.modelId
    )
      return { ok: false, error: "invalid_command" };
  } else if (command.type === "set_thinking_level") {
    if (!isIdentifier(command.level)) return { ok: false, error: "invalid_command" };
  } else if (command.type === "slash_command") {
    if (
      !remoteSlashCommands.has(command.name) ||
      (command.name === "subagents" && command.arguments !== undefined) ||
      (command.name === "workflows" &&
        command.arguments !== undefined &&
        (typeof command.arguments !== "string" || !workflowRunIdPattern.test(command.arguments)))
    )
      return { ok: false, error: "invalid_command" };
  }
  return { ok: true };
};

export const normalizeCommand = (body, currentEpoch) => {
  if (
    body?.version !== PI_CONSOLE_PROTOCOL_VERSION ||
    !Number.isSafeInteger(body?.expectedSessionRevision) ||
    body.expectedSessionRevision < 0
  )
    return { ok: false, error: "invalid_command" };
  const command = body?.intent;
  const commandId = body?.commandId;
  if (!validCommandId(commandId) || !command || typeof command !== "object")
    return { ok: false, error: "invalid_command" };
  if (body.epoch !== currentEpoch) return { ok: false, error: "scotty_epoch_changed" };
  const validation = validIntent(command);
  if (!validation.ok) return validation;
  if (command.type === "slash_command") {
    const argumentsText = command.arguments?.trim();
    const translated = {
      type: "prompt",
      message: `/${command.name}${argumentsText ? ` ${argumentsText}` : ""}`,
    };
    return {
      ok: true,
      commandId,
      command: translated,
      intent: command,
    };
  }
  return { ok: true, commandId, command, intent: command };
};

export const filterRemoteCommands = (commands) => {
  const filtered = new Map();
  for (const command of Array.isArray(commands) ? commands : []) {
    if (
      !command ||
      typeof command !== "object" ||
      command.source !== "extension" ||
      !remoteSlashCommands.has(command.name) ||
      filtered.has(command.name)
    )
      continue;
    filtered.set(command.name, {
      name: command.name,
      ...(typeof command.description === "string"
        ? { description: sanitizeRemoteString(command.description) }
        : {}),
      source: "extension",
    });
  }
  return [...filtered.values()];
};
