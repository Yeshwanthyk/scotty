import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { formatRemoteValue, redactRemoteString, redactRemoteValue } from "./redaction.ts";

const MAX_FALLBACK_LENGTH = 2_000;
type PiAssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type PiAssistantContent = PiAssistantMessage["content"][number];
type PiStopReason = PiAssistantMessage["stopReason"];

export interface RemoteToolCall {
  readonly id: string;
  readonly name: string;
  readonly presentationName: string;
  readonly arguments: Record<string, unknown>;
}

export interface RemoteToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
  readonly isError: boolean;
}

export type RemoteTranscriptEntry =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly message: PiAssistantMessage;
      readonly tools: ReadonlyArray<RemoteToolCall>;
    }
  | { readonly kind: "tool_result"; readonly result: RemoteToolResult }
  | { readonly kind: "fallback"; readonly text: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? redactRemoteString(value) : undefined;

const stopReason = (value: unknown): PiStopReason => {
  if (
    value === "pending" ||
    value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
  )
    return value;
  return "stop";
};

const fallback = (value: unknown): RemoteTranscriptEntry => ({
  kind: "fallback",
  text: formatRemoteValue(value, MAX_FALLBACK_LENGTH),
});

const textFromUserContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return redactRemoteString(value);
  if (!Array.isArray(value)) return undefined;
  const text: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string")
      return undefined;
    text.push(redactRemoteString(block.text));
  }
  return text.join("\n\n");
};

const toolCallFromContent = (value: Record<string, unknown>): RemoteToolCall | undefined => {
  if (typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.arguments))
    return undefined;
  const id = redactRemoteString(value.id);
  const name = redactRemoteString(value.name);
  const sanitized = redactRemoteValue(value.arguments);
  if (!isRecord(sanitized)) return undefined;
  return {
    id,
    name,
    presentationName: `${name} (remote)`,
    arguments: sanitized,
  };
};

const assistantContent = (
  values: ReadonlyArray<unknown>,
): { readonly content: PiAssistantContent[]; readonly tools: RemoteToolCall[] } | undefined => {
  const content: PiAssistantContent[] = [];
  const tools: RemoteToolCall[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    if (value.type === "text" && typeof value.text === "string") {
      content.push({ type: "text", text: redactRemoteString(value.text) });
      continue;
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      content.push({ type: "thinking", thinking: redactRemoteString(value.thinking) });
      continue;
    }
    if (value.type === "toolCall") {
      const tool = toolCallFromContent(value);
      if (tool === undefined) return undefined;
      tools.push(tool);
      content.push({
        type: "toolCall",
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      });
      continue;
    }
    return undefined;
  }
  return { content, tools };
};

const zeroUsage = (): PiAssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const toolResultFromMessage = (value: Record<string, unknown>): RemoteToolResult | undefined => {
  if (
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.isError !== "boolean" ||
    !Array.isArray(value.content)
  )
    return undefined;
  const text: string[] = [];
  for (const block of value.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string")
      return undefined;
    text.push(redactRemoteString(block.text));
  }
  return {
    toolCallId: redactRemoteString(value.toolCallId),
    toolName: redactRemoteString(value.toolName),
    text: text.join("\n"),
    isError: value.isError,
  };
};

export const adaptRemoteMessage = (value: unknown): RemoteTranscriptEntry => {
  if (!isRecord(value) || typeof value.role !== "string") return fallback(value);
  if (value.role === "user") {
    const text = textFromUserContent(value.content);
    return text === undefined ? fallback(value) : { kind: "user", text };
  }
  if (value.role === "toolResult") {
    const result = toolResultFromMessage(value);
    return result === undefined ? fallback(value) : { kind: "tool_result", result };
  }
  if (value.role !== "assistant" || !Array.isArray(value.content)) return fallback(value);

  const adapted = assistantContent(value.content);
  if (adapted === undefined) return fallback(value);
  const message: PiAssistantMessage = {
    role: "assistant",
    content: adapted.content,
    api: optionalString(value.api) ?? "pi-messages",
    provider: optionalString(value.provider) ?? "remote",
    model: optionalString(value.model) ?? "remote",
    usage: zeroUsage(),
    stopReason: stopReason(value.stopReason),
    timestamp: finiteNumber(value.timestamp),
    ...(optionalString(value.errorMessage) === undefined
      ? {}
      : { errorMessage: optionalString(value.errorMessage) }),
  };
  return { kind: "assistant", message, tools: adapted.tools };
};

export const adaptRemoteTool = (value: {
  readonly id: string;
  readonly name: string;
  readonly arguments?: unknown;
  readonly partialResult?: unknown;
}): RemoteToolCall & { readonly partialText?: string } => {
  const name = redactRemoteString(value.name);
  const sanitized = redactRemoteValue(value.arguments);
  const arguments_ = isRecord(sanitized) ? sanitized : {};
  return {
    id: redactRemoteString(value.id),
    name,
    presentationName: `${name} (remote)`,
    arguments: arguments_,
    ...(value.partialResult === undefined
      ? {}
      : { partialText: formatRemoteValue(value.partialResult, MAX_FALLBACK_LENGTH) }),
  };
};
