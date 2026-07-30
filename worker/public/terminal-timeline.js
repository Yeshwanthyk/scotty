function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
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
