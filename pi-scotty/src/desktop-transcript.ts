import { formatRemoteValue, redactRemoteLine, redactRemoteString } from "./redaction.ts";

const MAX_TRANSCRIPT_ITEMS = 2_000;
const MAX_MESSAGE_PARTS = 128;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_DETAIL_LENGTH = 1_024;
const MAX_RESULT_LENGTH = 2_000;

type DesktopToolStatus = "pending" | "running" | "completed" | "failed";

export type DesktopTranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
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
  | { readonly kind: "fallback"; readonly id: string; readonly text: string };

export interface DesktopActiveTool {
  readonly id: string;
  readonly name: string;
  readonly arguments?: unknown;
  readonly partialResult?: unknown;
}

type MutableToolItem = Extract<DesktopTranscriptItem, { readonly kind: "tool" }> & {
  status: DesktopToolStatus;
  result: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bounded = (value: string, maxLength: number): string =>
  redactRemoteString(value).slice(0, maxLength);

const identifier = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? bounded(value, 4_096) : fallback;

const messageIdentifier = (message: Record<string, unknown>, index: number): string =>
  identifier(message.id ?? message.messageId ?? message.message_id, `message-${index}`);

const textContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return bounded(value, MAX_TEXT_LENGTH);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value.slice(0, MAX_MESSAGE_PARTS)) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return undefined;
    parts.push(bounded(part.text, MAX_TEXT_LENGTH));
  }
  return parts.join("\n\n").slice(0, MAX_TEXT_LENGTH);
};

const firstString = (value: unknown, keys: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0)
      return redactRemoteLine(candidate).slice(0, MAX_DETAIL_LENGTH);
    if (Array.isArray(candidate)) {
      const joined = candidate
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .trim();
      if (joined.length > 0) return redactRemoteLine(joined).slice(0, MAX_DETAIL_LENGTH);
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
  if (normalized.includes("task") || normalized.includes("subagent"))
    return {
      summary: "Ran subagent",
      detail: firstString(arguments_, ["name", "subject"]) ?? null,
    };
  const fallback =
    arguments_ === undefined
      ? null
      : redactRemoteLine(formatRemoteValue(arguments_, MAX_DETAIL_LENGTH));
  return { summary: bounded(name, 256), detail: fallback };
};

const toolResultText = (value: unknown): string | undefined => {
  if (typeof value === "string") return bounded(value, MAX_RESULT_LENGTH);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value.slice(0, MAX_MESSAGE_PARTS)) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    parts.push(bounded(part.text, MAX_RESULT_LENGTH));
  }
  const result = parts.join("\n").slice(0, MAX_RESULT_LENGTH);
  return result.length > 0 ? result : undefined;
};

const fallbackItem = (id: string, value: unknown): DesktopTranscriptItem => ({
  kind: "fallback",
  id,
  text: formatRemoteValue(value, MAX_RESULT_LENGTH),
});

export const projectDesktopTranscript = (
  messages: ReadonlyArray<unknown>,
  activeTools: ReadonlyArray<DesktopActiveTool>,
): ReadonlyArray<DesktopTranscriptItem> => {
  const items: DesktopTranscriptItem[] = [];
  const tools = new Map<string, MutableToolItem>();

  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || typeof message.role !== "string") {
      items.push(fallbackItem(`message-${messageIndex}`, message));
      return;
    }
    const baseId = messageIdentifier(message, messageIndex);
    if (message.role === "user") {
      const text = textContent(message.content);
      items.push(
        text === undefined ? fallbackItem(baseId, message) : { kind: "user", id: baseId, text },
      );
      return;
    }
    if (message.role === "toolResult") {
      const toolCallId = identifier(message.toolCallId, `${baseId}-tool`);
      const name = identifier(message.toolName, "tool");
      const result =
        toolResultText(message.content) ?? formatRemoteValue(message.content, MAX_RESULT_LENGTH);
      const existing = tools.get(toolCallId);
      if (existing !== undefined) {
        existing.status = message.isError === true ? "failed" : "completed";
        existing.result = result;
      } else {
        const presentation = toolPresentation(name, undefined);
        const item: MutableToolItem = {
          kind: "tool",
          id: toolCallId,
          name,
          ...presentation,
          status: message.isError === true ? "failed" : "completed",
          result,
        };
        tools.set(toolCallId, item);
        items.push(item);
      }
      return;
    }
    if (message.role !== "assistant") {
      items.push(fallbackItem(baseId, message));
      return;
    }

    if (typeof message.content === "string") {
      const text = bounded(message.content, MAX_TEXT_LENGTH);
      if (text.length > 0) items.push({ kind: "assistant", id: `${baseId}-text-0`, text });
    } else if (Array.isArray(message.content)) {
      message.content.slice(0, MAX_MESSAGE_PARTS).forEach((part, partIndex) => {
        const partId = `${baseId}-part-${partIndex}`;
        if (!isRecord(part) || typeof part.type !== "string") {
          items.push(fallbackItem(partId, part));
          return;
        }
        if (part.type === "text" && typeof part.text === "string") {
          const text = bounded(part.text, MAX_TEXT_LENGTH);
          if (text.length > 0) items.push({ kind: "assistant", id: partId, text });
          return;
        }
        if (part.type === "thinking" && typeof part.thinking === "string") {
          const text = bounded(part.thinking, MAX_TEXT_LENGTH);
          if (text.length > 0) items.push({ kind: "thinking", id: partId, text });
          return;
        }
        if (
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          const id = identifier(part.id, partId);
          const name = bounded(part.name, 256);
          const item: MutableToolItem = {
            kind: "tool",
            id,
            name,
            ...toolPresentation(name, part.arguments),
            status: "pending",
            result: null,
          };
          tools.set(id, item);
          items.push(item);
          return;
        }
        items.push(fallbackItem(partId, part));
      });
    } else if (message.content !== undefined) items.push(fallbackItem(baseId, message.content));

    if (typeof message.errorMessage === "string" && message.errorMessage.length > 0)
      items.push({
        kind: "error",
        id: `${baseId}-error`,
        message: bounded(message.errorMessage, MAX_RESULT_LENGTH),
      });
    else if (message.stopReason === "aborted")
      items.push({ kind: "fallback", id: `${baseId}-aborted`, text: "Response aborted" });
  });

  for (const active of activeTools) {
    const id = identifier(active.id, "active-tool");
    const name = identifier(active.name, "tool");
    const result =
      active.partialResult === undefined || active.partialResult === null
        ? null
        : formatRemoteValue(active.partialResult, MAX_RESULT_LENGTH);
    const existing = tools.get(id);
    if (existing !== undefined) {
      existing.status = "running";
      existing.result = result;
    } else {
      const item: MutableToolItem = {
        kind: "tool",
        id,
        name,
        ...toolPresentation(name, active.arguments),
        status: "running",
        result,
      };
      tools.set(id, item);
      items.push(item);
    }
  }

  return items.slice(-MAX_TRANSCRIPT_ITEMS);
};
