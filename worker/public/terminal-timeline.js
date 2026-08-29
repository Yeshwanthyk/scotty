function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function firstObject(...values) {
  return (
    values.find((value) => value !== null && typeof value === "object" && !Array.isArray(value)) ??
    {}
  );
}

function numberValue(...values) {
  return values.find((value) => Number.isFinite(value));
}

function contentParts(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function toolId(tool) {
  return firstString(tool?.toolCallId, tool?.tool_call_id, tool?.id, tool?.callId);
}

function messageId(message) {
  return firstString(message?.id, message?.messageId, message?.message_id);
}

export function replaceTimelineMessage(messages, message) {
  const id = messageId(message);
  const index = id ? messages.findIndex((candidate) => messageId(candidate) === id) : -1;
  if (index >= 0) {
    messages[index] = message;
    return;
  }
  const last = messages.at(-1);
  if (!id && last?.role === message.role && message.role === "assistant") {
    messages[messages.length - 1] = message;
  } else {
    messages.push(message);
  }
}

const redactAssembledString = (value) =>
  value
    // oxlint-disable-next-line eslint/no-control-regex -- streamed remote content must remain terminal-safe after assembly
    .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    // oxlint-disable-next-line eslint/no-control-regex -- streamed remote content must remain terminal-safe after assembly
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll(/scotty-managed:\/\/[^\s"'<>]+/gu, "[managed-handle]")
    .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
    // oxlint-disable-next-line eslint/no-control-regex -- streamed remote content excludes terminal control bytes
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .slice(0, 16 * 1024);

export function appendAssistantMessageDelta(messages, event) {
  let message = messages.at(-1);
  if (!message || message.role !== "assistant") {
    message = { role: "assistant", content: [] };
    messages.push(message);
  }
  if (!Array.isArray(message.content)) message.content = [];
  const deltaEvent = firstObject(event.assistantMessageEvent, event.delta, event.update, event);
  const type = firstString(deltaEvent.type, event.updateType);
  const index = numberValue(deltaEvent.contentIndex, deltaEvent.content_index) ?? 0;
  if (!Number.isInteger(index) || index < 0 || index > 500 || index > message.content.length)
    return;

  if (type === "toolcall_start" || type === "toolcall_delta") return;
  if (type === "toolcall_end") {
    const toolCall = firstObject(deltaEvent.toolCall);
    if (Object.keys(toolCall).length > 0) message.content[index] = toolCall;
    return;
  }

  const thinking = type?.startsWith("thinking_") ?? false;
  const contentType = thinking ? "thinking" : "text";
  const field = thinking ? "thinking" : "text";
  if (type?.endsWith("_start")) {
    message.content[index] = { type: contentType, [field]: "" };
    return;
  }
  const value = firstString(deltaEvent.delta, deltaEvent.text, deltaEvent.content) ?? "";
  if (type?.endsWith("_end")) {
    message.content[index] = { type: contentType, [field]: redactAssembledString(value) };
    return;
  }
  const part = firstObject(message.content[index], { type: contentType });
  const previous = firstString(part[field], "") ?? "";
  message.content[index] = {
    ...part,
    type: contentType,
    [field]: redactAssembledString(`${previous}${value}`),
  };
}

function messageRole(message) {
  const role = firstString(message?.role, message?.type, "system");
  if (role === "toolResult" || role === "tool_result" || role === "tool") return "tool";
  if (role === "assistant" || role === "user") return role;
  return "system";
}

function newConversation(user, key) {
  return {
    kind: "conversation",
    key,
    user,
    assistants: [],
    toolIds: [],
    inlineTools: [],
  };
}

function addTool(conversation, id) {
  if (id && !conversation.toolIds.includes(id)) conversation.toolIds.push(id);
}

export function conversationItems(messages) {
  const items = [];
  const claimedToolIds = new Set();
  let conversation;
  const ensureConversation = () => {
    if (!conversation) {
      conversation = newConversation(undefined, `assistant-${items.length}`);
      items.push(conversation);
    }
    return conversation;
  };

  for (const message of messages) {
    const role = messageRole(message);
    if (role === "user") {
      conversation = newConversation(message, messageId(message) ?? `turn-${items.length}`);
      items.push(conversation);
      continue;
    }
    if (role === "assistant") {
      const current = ensureConversation();
      current.assistants.push(message);
      for (const part of contentParts(message)) {
        const type = firstString(part?.type, "");
        if (!["toolCall", "tool_call", "tool-call"].includes(type)) continue;
        const id = toolId(part);
        if (id) {
          claimedToolIds.add(id);
          addTool(current, id);
        } else {
          current.inlineTools.push({
            ...part,
            name: firstString(part.name, part.toolName, "tool"),
            arguments: part.arguments ?? part.args,
            status: "running",
          });
        }
      }
      continue;
    }
    if (role === "tool") {
      const id = toolId(message);
      if (id && claimedToolIds.has(id)) continue;
      const current = ensureConversation();
      if (id) {
        claimedToolIds.add(id);
        addTool(current, id);
      } else {
        current.inlineTools.push({
          ...message,
          name: firstString(message.toolName, message.name, "tool"),
          result: message.content ?? message.result,
          status: message.isError || message.error ? "error" : "done",
        });
      }
      continue;
    }
    conversation = undefined;
    items.push({ kind: "system", message });
  }
  return { items, claimedToolIds };
}
