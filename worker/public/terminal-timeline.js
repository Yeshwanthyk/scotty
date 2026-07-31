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
  const delta = firstString(deltaEvent.delta, deltaEvent.text, deltaEvent.content) ?? "";
  const contentType = type?.includes("thinking") ? "thinking" : "text";
  while (message.content.length <= index) message.content.push({ type: contentType, text: "" });
  const part = firstObject(message.content[index], { type: contentType });
  message.content[index] = {
    ...part,
    type: firstString(part.type, contentType),
    text: `${firstString(part.text, part.thinking, "") ?? ""}${delta}`,
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
