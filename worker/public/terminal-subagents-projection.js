export const SUBAGENTS_WIDGET_KEY = "pi-subagents/activity/v1";
export const SUBAGENTS_PROTOCOL_VERSION = 1;

const limits = {
  maxChildren: 4,
  maxPrompt: 2048,
  maxOutput: 4096,
  maxFailure: 2048,
  maxTranscript: 16,
  maxTranscriptText: 512,
  maxTools: 4,
  maxQueued: 4,
};

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function clean(value) {
  return [...text(value)]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("");
}

function elapsed(now, startedAt) {
  if (!Number.isFinite(startedAt)) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function subagentElapsed(child, now = Date.now()) {
  return elapsed(now, child?.startedAt);
}

export function subagentCount(snapshot) {
  return Array.isArray(snapshot?.children) ? snapshot.children.length : 0;
}

export function subagentCountLabel(count) {
  return `${count} subagent${count === 1 ? "" : "s"} working`;
}

export function subagentModelLabel(child) {
  const model = text(child?.model);
  const effort = text(child?.reasoningEffort);
  return (
    [model, effort ? `effort ${effort}` : ""].filter(Boolean).join(" · ") || "Model unavailable"
  );
}

export function subagentTranscriptTail(child) {
  return (Array.isArray(child?.transcript) ? child.transcript : [])
    .map((item) => {
      if (item.kind === "user") return `Prompt: ${item.text}`;
      if (item.kind === "assistant") return item.text;
      if (item.kind === "thinking") return "";
      if (item.kind === "tool")
        return `[${item.isError ? "Tool failed" : "Tool"}: ${item.name}${item.output ? ` — ${item.output}` : ""}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function selectedSubagent(snapshot, id) {
  const child = (Array.isArray(snapshot?.children) ? snapshot.children : []).find(
    (item) => item.id === id,
  );
  if (child) return child;
  return snapshot?.terminal?.id === id
    ? {
        ...snapshot.terminal,
        backend: "pi",
        prompt: "",
        transcript: [],
        tools: [],
        queued: [],
        startedAt: snapshot.terminal.settledAt,
        lastActivityAt: snapshot.terminal.settledAt,
      }
    : undefined;
}

const exactKeys = (value, keys) =>
  isObject(value) && Object.keys(value).every((key) => keys.includes(key));
const bounded = (value, max) =>
  typeof value === "string" && Array.from(value).length <= max ? clean(value) : undefined;
const validId = (value) => {
  const id = bounded(value, 64);
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) ? id : undefined;
};
const validTranscriptItem = (value) => {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "user" || value.kind === "assistant")
    return (
      exactKeys(value, ["kind", "text"]) &&
      bounded(value.text, limits.maxTranscriptText) !== undefined
    );
  if (value.kind === "thinking")
    return (
      exactKeys(value, ["kind", "text", "redacted"]) &&
      bounded(value.text, limits.maxTranscriptText) !== undefined &&
      (value.redacted === undefined || typeof value.redacted === "boolean")
    );
  return (
    value.kind === "tool" &&
    exactKeys(value, ["kind", "name", "args", "output", "isError"]) &&
    bounded(value.name, 120) !== undefined &&
    (value.args === undefined || bounded(value.args, 512) !== undefined) &&
    (value.output === undefined || bounded(value.output, 512) !== undefined) &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
};
const validChild = (value) =>
  isObject(value) &&
  exactKeys(value, [
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
  ]) &&
  validId(value.id) === value.id &&
  ["pi", "claude", "codex"].includes(value.backend) &&
  value.status === "running" &&
  (value.model === undefined || bounded(value.model, 120) !== undefined) &&
  bounded(value.title, 160) !== undefined &&
  bounded(value.prompt, limits.maxPrompt) !== undefined &&
  bounded(value.output, limits.maxOutput) !== undefined &&
  (value.failure === undefined || bounded(value.failure, limits.maxFailure) !== undefined) &&
  Array.isArray(value.transcript) &&
  value.transcript.length <= limits.maxTranscript &&
  value.transcript.every(validTranscriptItem) &&
  Array.isArray(value.tools) &&
  value.tools.length <= limits.maxTools &&
  value.tools.every(
    (tool) =>
      exactKeys(tool, ["name", "args", "output", "startedAt", "updatedAt", "isError"]) &&
      bounded(tool.name, 120) !== undefined &&
      (tool.args === undefined || bounded(tool.args, 512) !== undefined) &&
      (tool.output === undefined || bounded(tool.output, 512) !== undefined) &&
      Number.isFinite(tool.startedAt) &&
      Number.isFinite(tool.updatedAt) &&
      (tool.isError === undefined || typeof tool.isError === "boolean"),
  ) &&
  Array.isArray(value.queued) &&
  value.queued.length <= limits.maxQueued &&
  value.queued.every(
    (item) =>
      exactKeys(item, ["kind", "text"]) &&
      (item.kind === "steer" || item.kind === "follow-up") &&
      bounded(item.text, 512) !== undefined,
  ) &&
  Number.isFinite(value.startedAt) &&
  Number.isFinite(value.lastActivityAt);
const validTerminal = (value) =>
  isObject(value) &&
  exactKeys(value, ["id", "title", "status", "output", "failure", "settledAt"]) &&
  validId(value.id) === value.id &&
  bounded(value.title, 160) !== undefined &&
  (value.status === "done" || value.status === "error") &&
  bounded(value.output, limits.maxOutput) !== undefined &&
  (value.failure === undefined || bounded(value.failure, limits.maxFailure) !== undefined) &&
  Number.isFinite(value.settledAt);

export function snapshotForWidget(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== "string") return undefined;
    value = value[0];
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (
    !isObject(value) ||
    !exactKeys(value, ["version", "revision", "generatedAt", "children", "terminal"]) ||
    value.version !== SUBAGENTS_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isFinite(value.generatedAt)
  )
    return undefined;
  if (
    !Array.isArray(value.children) ||
    value.children.length > limits.maxChildren ||
    !value.children.every(validChild)
  )
    return undefined;
  if (
    new Set(value.children.map((child) => child.id)).size !== value.children.length ||
    (value.terminal !== undefined && !validTerminal(value.terminal))
  )
    return undefined;
  return value;
}

export function subagentActivityFromWidget(widgetLines) {
  return snapshotForWidget(widgetLines);
}

export function subagentActivityState(snapshot, selectedId) {
  const valid = snapshotForWidget(snapshot);
  return {
    snapshot: valid,
    selectedId: valid && selectedSubagent(valid, selectedId) ? selectedId : undefined,
  };
}

export { limits as SUBAGENTS_LIMITS };
