import {
  formatRemoteValue,
  redactRemoteLine,
  redactRemoteString,
  truncateRemoteString,
} from "./redaction.ts";

const MAX_TRANSCRIPT_ITEMS = 2_000;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_PARTS = 128;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_DETAIL_LENGTH = 1_024;
const MAX_RESULT_LENGTH = 2_000;

const encoder = new TextEncoder();

type DesktopToolStatus = "pending" | "running" | "completed" | "failed";
type DesktopNoticeTone = "info" | "warning";

export type DesktopTranscriptItem =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly imageCount: number;
    }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | { readonly kind: "thinking"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly summary: string;
      readonly detail: string | null;
      readonly status: DesktopToolStatus;
      readonly result: string | null;
    }
  | { readonly kind: "error"; readonly id: string; readonly message: string }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly title: string;
      readonly message: string;
      readonly tone: DesktopNoticeTone;
    }
  | { readonly kind: "fallback"; readonly id: string; readonly text: string };

export interface DesktopTranscriptProjection {
  readonly items: ReadonlyArray<DesktopTranscriptItem>;
  readonly truncated: boolean;
}

export interface DesktopActiveTool {
  readonly id: string;
  readonly name: string;
  readonly arguments?: unknown;
  readonly partialResult?: unknown;
}

type MutableToolItem = {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  detail: string | null;
  status: DesktopToolStatus;
  result: string | null;
};

interface StoredItem {
  item: DesktopTranscriptItem;
  bytes: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bounded = (value: string, maxLength: number): string =>
  truncateRemoteString(redactRemoteString(value), maxLength);

const identifier = (value: unknown, fallback: string, maxLength = 256): string =>
  typeof value === "string" && value.length > 0 ? bounded(value, maxLength) : fallback;

const messageIdentifier = (message: Record<string, unknown>, index: number): string => {
  const explicit = message.id ?? message.messageId ?? message.message_id;
  if (typeof explicit === "string" && explicit.length > 0) return identifier(explicit, "message");
  const role = identifier(message.role, "event", 32);
  const timestamp = message.timestamp;
  return typeof timestamp === "string" ||
    (typeof timestamp === "number" && Number.isFinite(timestamp))
    ? `message-${role}-${String(timestamp)}`
    : `message-${role}-${index}`;
};

const textParts = (
  value: unknown,
): { readonly text: string | undefined; readonly images: number; readonly truncated: boolean } => {
  if (typeof value === "string")
    return {
      text: bounded(value, MAX_TEXT_LENGTH),
      images: 0,
      truncated: value.length > MAX_TEXT_LENGTH,
    };
  if (!Array.isArray(value)) return { text: undefined, images: 0, truncated: false };
  const text: string[] = [];
  let images = 0;
  for (const part of value.slice(0, MAX_MESSAGE_PARTS)) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string")
      text.push(bounded(part.text, MAX_TEXT_LENGTH));
    else if (part.type === "image") images += 1;
  }
  const joined = truncateRemoteString(text.join("\n\n"), MAX_TEXT_LENGTH);
  return {
    text: joined.length > 0 ? joined : undefined,
    images,
    truncated:
      value.length > MAX_MESSAGE_PARTS || text.some((part) => part.length >= MAX_TEXT_LENGTH),
  };
};

const firstString = (value: unknown, keys: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0)
      return truncateRemoteString(redactRemoteLine(candidate), MAX_DETAIL_LENGTH);
    if (Array.isArray(candidate)) {
      const joined = candidate
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .trim();
      if (joined.length > 0)
        return truncateRemoteString(redactRemoteLine(joined), MAX_DETAIL_LENGTH);
    }
  }
  return undefined;
};

const toolPresentation = (
  name: string,
  arguments_: unknown,
): { readonly summary: string; readonly detail: string | null } => {
  const normalized = name.toLowerCase();
  const command = firstString(arguments_, ["command", "cmd", "script"]);
  const path = firstString(arguments_, ["path", "filePath", "filename", "oldPath", "newPath"]);
  const query = firstString(arguments_, ["query", "pattern", "searchTerm"]);
  const url = firstString(arguments_, ["url"]);
  if (/^(bash|exec|shell|run|terminal)$/u.test(normalized) || normalized.includes("command"))
    return { summary: "Ran command", detail: command ?? null };
  if (normalized === "read" || normalized.includes("read_file"))
    return { summary: "Read file", detail: path ?? null };
  if (/^(edit|write|apply_patch|patch)$/u.test(normalized) || normalized.includes("file_change"))
    return { summary: "Changed file", detail: path ?? null };
  if (normalized === "grep" || normalized === "find" || normalized === "search")
    return { summary: "Searched files", detail: query ?? path ?? null };
  if (normalized.includes("web_search")) return { summary: "Searched web", detail: query ?? null };
  if (normalized.includes("fetch")) return { summary: "Fetched content", detail: url ?? null };
  if (normalized === "subagent_spawn" || normalized === "subagents")
    return {
      summary: "Ran subagent",
      detail: firstString(arguments_, ["name", "subject"]) ?? null,
    };
  if (normalized === "workflow") return { summary: "Ran workflow", detail: null };
  if (normalized === "taskcreate")
    return { summary: "Created task", detail: firstString(arguments_, ["subject"]) ?? null };
  if (normalized === "taskupdate")
    return {
      summary: "Updated task",
      detail: firstString(arguments_, ["taskId", "subject"]) ?? null,
    };
  if (normalized === "tasklist") return { summary: "Listed tasks", detail: null };
  if (normalized === "taskget")
    return { summary: "Read task", detail: firstString(arguments_, ["taskId"]) ?? null };
  const fallback =
    arguments_ === undefined
      ? null
      : redactRemoteLine(formatRemoteValue(arguments_, MAX_DETAIL_LENGTH));
  return { summary: bounded(name, 256), detail: fallback };
};

const itemBytes = (item: DesktopTranscriptItem): number =>
  encoder.encode(JSON.stringify(item)).byteLength;

export const projectDesktopTranscript = (
  messages: ReadonlyArray<unknown>,
  activeTools: ReadonlyArray<DesktopActiveTool>,
): DesktopTranscriptProjection => {
  const stored: StoredItem[] = [];
  const tools = new Map<string, StoredItem>();
  let start = 0;
  let bytes = 0;
  let truncated = false;

  const trim = (): void => {
    while (stored.length - start > MAX_TRANSCRIPT_ITEMS || bytes > MAX_TRANSCRIPT_BYTES) {
      const removed = stored[start];
      start += 1;
      truncated = true;
      if (removed === undefined) continue;
      bytes -= removed.bytes;
      if (removed.item.kind === "tool" && tools.get(removed.item.id) === removed)
        tools.delete(removed.item.id);
    }
    if (start >= 1_024 && start * 2 >= stored.length) {
      stored.splice(0, start);
      start = 0;
    }
  };

  const append = (item: DesktopTranscriptItem): StoredItem => {
    const entry = { item, bytes: itemBytes(item) };
    stored.push(entry);
    bytes += entry.bytes;
    trim();
    return entry;
  };

  const appendTool = (tool: MutableToolItem): StoredItem => {
    const entry = append(tool);
    tools.set(tool.id, entry);
    return entry;
  };

  const updateTool = (entry: StoredItem, update: (tool: MutableToolItem) => void): void => {
    if (entry.item.kind !== "tool") return;
    bytes -= entry.bytes;
    update(entry.item);
    entry.bytes = itemBytes(entry.item);
    bytes += entry.bytes;
    trim();
  };

  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || typeof message.role !== "string") {
      append({
        kind: "fallback",
        id: `message-event-${messageIndex}`,
        text: "Unsupported remote message",
      });
      return;
    }
    const baseId = messageIdentifier(message, messageIndex);

    if (message.role === "user") {
      const content = textParts(message.content);
      truncated ||= content.truncated;
      append({
        kind: "user",
        id: baseId,
        text: content.text ?? (content.images > 0 ? "" : "[Empty message]"),
        imageCount: content.images,
      });
      return;
    }

    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") {
        append({ kind: "fallback", id: baseId, text: "Unsupported tool result" });
        return;
      }
      const toolCallId = identifier(message.toolCallId, `${baseId}-tool`);
      const name = identifier(message.toolName, "tool");
      const content = textParts(message.content);
      truncated ||= content.truncated;
      const result = content.text ?? (content.images > 0 ? "[Image result omitted]" : null);
      const existing = tools.get(toolCallId);
      if (existing !== undefined)
        updateTool(existing, (tool) => {
          tool.status = message.isError === true ? "failed" : "completed";
          tool.result = result;
        });
      else
        appendTool({
          kind: "tool",
          id: toolCallId,
          name,
          ...toolPresentation(name, undefined),
          status: message.isError === true ? "failed" : "completed",
          result,
        });
      return;
    }

    if (message.role === "bashExecution") {
      const command = identifier(message.command, "shell command", MAX_DETAIL_LENGTH);
      const output =
        typeof message.output === "string" ? bounded(message.output, MAX_RESULT_LENGTH) : null;
      const failed = typeof message.exitCode === "number" && message.exitCode !== 0;
      appendTool({
        kind: "tool",
        id: baseId,
        name: "bash",
        summary: message.cancelled === true ? "Cancelled command" : "Ran command",
        detail: command,
        status: failed ? "failed" : "completed",
        result: output,
      });
      return;
    }

    if (message.role === "branchSummary" || message.role === "compactionSummary") {
      append({
        kind: "notice",
        id: baseId,
        title: message.role === "branchSummary" ? "Branch summary" : "History compacted",
        message:
          typeof message.summary === "string"
            ? bounded(message.summary, MAX_TEXT_LENGTH)
            : "Summary unavailable",
        tone: "info",
      });
      return;
    }

    if (message.role === "custom") {
      if (message.display !== true) return;
      const content = textParts(message.content);
      truncated ||= content.truncated;
      append({
        kind: "notice",
        id: baseId,
        title: identifier(message.customType, "Extension", 128),
        message:
          content.text ?? (content.images > 0 ? "[Image content omitted]" : "Extension update"),
        tone: "info",
      });
      return;
    }

    if (message.role !== "assistant") {
      append({
        kind: "fallback",
        id: baseId,
        text: `Unsupported ${bounded(message.role, 32)} message`,
      });
      return;
    }

    if (Array.isArray(message.content)) {
      if (message.content.length > MAX_MESSAGE_PARTS) truncated = true;
      message.content.slice(0, MAX_MESSAGE_PARTS).forEach((part, partIndex) => {
        const partId = `${baseId}-part-${partIndex}`;
        if (!isRecord(part) || typeof part.type !== "string") {
          append({ kind: "fallback", id: partId, text: "Unsupported assistant content" });
          return;
        }
        if (part.type === "text" && typeof part.text === "string") {
          const text = bounded(part.text, MAX_TEXT_LENGTH);
          if (text.length > 0) append({ kind: "assistant", id: partId, text });
          if (part.text.length > MAX_TEXT_LENGTH) truncated = true;
          return;
        }
        if (part.type === "thinking" && typeof part.thinking === "string") {
          const text = bounded(part.thinking, MAX_TEXT_LENGTH);
          if (text.length > 0) append({ kind: "thinking", id: partId, text });
          if (part.thinking.length > MAX_TEXT_LENGTH) truncated = true;
          return;
        }
        if (
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          const id = identifier(part.id, partId);
          const name = identifier(part.name, "tool");
          appendTool({
            kind: "tool",
            id,
            name,
            ...toolPresentation(name, part.arguments),
            status: "pending",
            result: null,
          });
          return;
        }
        append({
          kind: "fallback",
          id: partId,
          text: `Unsupported ${bounded(part.type, 64)} content`,
        });
      });
    } else if (typeof message.content === "string" && message.content.length > 0)
      append({
        kind: "assistant",
        id: `${baseId}-text`,
        text: bounded(message.content, MAX_TEXT_LENGTH),
      });

    const error =
      typeof message.errorMessage === "string" && message.errorMessage.length > 0
        ? bounded(message.errorMessage, MAX_RESULT_LENGTH)
        : message.stopReason === "error"
          ? "Unknown provider error"
          : undefined;
    const duplicateToolFailure =
      error !== undefined &&
      [...tools.values()]
        .slice(-5)
        .some(
          (entry) =>
            entry.item.kind === "tool" &&
            entry.item.status === "failed" &&
            entry.item.result === error,
        );
    if (error !== undefined && !duplicateToolFailure)
      append({ kind: "error", id: `${baseId}-error`, message: error });
    else if (message.stopReason === "length")
      append({
        kind: "notice",
        id: `${baseId}-length`,
        title: "Response incomplete",
        message: "The model reached its output token limit.",
        tone: "warning",
      });
    else if (message.stopReason === "aborted")
      append({
        kind: "notice",
        id: `${baseId}-aborted`,
        title: "Response stopped",
        message: "The request was aborted.",
        tone: "info",
      });
  });

  for (const active of activeTools) {
    const id = identifier(active.id, "active-tool");
    const name = identifier(active.name, "tool");
    const result =
      active.partialResult === undefined || active.partialResult === null
        ? null
        : formatRemoteValue(active.partialResult, MAX_RESULT_LENGTH);
    const existing = tools.get(id);
    if (existing !== undefined)
      updateTool(existing, (tool) => {
        tool.status = "running";
        tool.result = result;
      });
    else
      appendTool({
        kind: "tool",
        id,
        name,
        ...toolPresentation(name, active.arguments),
        status: "running",
        result,
      });
  }

  return {
    items: stored.slice(start).map((entry) => entry.item),
    truncated,
  };
};
