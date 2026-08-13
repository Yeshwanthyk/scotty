import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { formatRemoteValue, redactRemoteString, redactRemoteValue } from "./redaction.ts";
import {
  decodeJsonObject,
  decodeRemoteAssistantMessage,
  decodeRemoteToolResultMessage,
  decodeRemoteUserMessage,
  type RemoteAssistantContent,
  type RemoteToolArguments,
  type RemoteToolCallContent,
  type RemoteToolResultMessage,
  type RemoteUserMessage,
} from "./schemas.ts";

const MAX_FALLBACK_LENGTH = 2_000;
type PiAssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type PiAssistantContent = PiAssistantMessage["content"][number];
type PiStopReason = PiAssistantMessage["stopReason"];

export interface RemoteToolCall {
  readonly id: string;
  readonly name: string;
  readonly presentationName: string;
  readonly arguments: RemoteToolArguments;
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

const jsonObject = (value: Schema.Json): Schema.JsonObject | undefined => decodeJsonObject(value);

const textFromUserContent = (message: RemoteUserMessage): string | undefined => {
  const value = message.content;
  if (typeof value === "string") return redactRemoteString(value);
  return value.map(({ text }) => redactRemoteString(text)).join("\n\n");
};

const toolCallFromContent = (value: RemoteToolCallContent): RemoteToolCall => {
  const id = redactRemoteString(value.id);
  const name = redactRemoteString(value.name);
  const sanitized = jsonObject(redactRemoteValue(value.arguments)) ?? {};
  return {
    id,
    name,
    presentationName: `${name} (remote)`,
    arguments: sanitized,
  };
};

const assistantContent = (
  values: ReadonlyArray<RemoteAssistantContent>,
): { readonly content: PiAssistantContent[]; readonly tools: RemoteToolCall[] } | undefined => {
  const content: PiAssistantContent[] = [];
  const tools: RemoteToolCall[] = [];
  for (const value of values) {
    if (value.type === "text") {
      content.push({ type: "text", text: redactRemoteString(value.text) });
      continue;
    }
    if (value.type === "thinking") {
      content.push({ type: "thinking", thinking: redactRemoteString(value.thinking) });
      continue;
    }
    if (value.type === "toolCall") {
      const tool = toolCallFromContent(value);
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

const toolResultFromMessage = (value: RemoteToolResultMessage): RemoteToolResult => {
  const text = value.content.map(({ text: value }) => redactRemoteString(value));
  return {
    toolCallId: redactRemoteString(value.toolCallId),
    toolName: redactRemoteString(value.toolName),
    text: text.join("\n"),
    isError: value.isError,
  };
};

export const adaptRemoteMessage = (value: unknown): RemoteTranscriptEntry => {
  const user = decodeRemoteUserMessage(value);
  if (user !== undefined) return { kind: "user", text: textFromUserContent(user) ?? "" };
  const toolResult = decodeRemoteToolResultMessage(value);
  if (toolResult !== undefined)
    return { kind: "tool_result", result: toolResultFromMessage(toolResult) };
  const assistant = decodeRemoteAssistantMessage(value);
  if (assistant === undefined) return fallback(value);

  const adapted = assistantContent(assistant.content);
  if (adapted === undefined) return fallback(value);
  const message: PiAssistantMessage = {
    role: "assistant",
    content: adapted.content,
    api: optionalString(assistant.api) ?? "pi-messages",
    provider: optionalString(assistant.provider) ?? "remote",
    model: optionalString(assistant.model) ?? "remote",
    usage: zeroUsage(),
    stopReason: stopReason(assistant.stopReason),
    timestamp: finiteNumber(assistant.timestamp),
    ...(optionalString(assistant.errorMessage) === undefined
      ? {}
      : { errorMessage: optionalString(assistant.errorMessage) }),
  };
  return { kind: "assistant", message, tools: adapted.tools };
};

export const adaptRemoteTool = (value: {
  readonly id: string;
  readonly name: string;
  readonly arguments?: Schema.Json;
  readonly partialResult?: Schema.Json;
}): RemoteToolCall & { readonly partialText?: string } => {
  const name = redactRemoteString(value.name);
  const sanitized = redactRemoteValue(value.arguments);
  const arguments_ = jsonObject(sanitized) ?? {};
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
