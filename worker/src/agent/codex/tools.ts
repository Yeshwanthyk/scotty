import { Predicate } from "effect";
import type { CodexNotification } from "../../../../protocol/codex-app-server";
import {
  CONVERSATION_MAX_TOOLS_PER_TURN,
  CONVERSATION_MAX_TOOL_VALUE_BYTES,
  type CanonicalConversationTool,
} from "../../../../protocol/conversation";

export const makeCodexTools = () => {
  const tools = new Map<string, CanonicalConversationTool>();
  let truncated = false;
  let sequence = 0;
  const bound = (value: string) => {
    let text = "",
      size = 0;
    for (const character of value) {
      size += new TextEncoder().encode(character).length;
      if (size > CONVERSATION_MAX_TOOL_VALUE_BYTES) {
        truncated = true;
        break;
      }
      text += character;
    }
    return text;
  };
  const accept = (event: CodexNotification) => {
    sequence++;
    if (event.method === "turn/started") {
      tools.clear();
      truncated = false;
    }
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = event.params.item;
      if (!Predicate.hasProperty(item, "command")) return;
      if (!tools.has(item.id) && tools.size >= CONVERSATION_MAX_TOOLS_PER_TURN) {
        truncated = true;
        return;
      }
      const previous = tools.get(item.id);
      tools.set(item.id, {
        id: item.id,
        label: "Command",
        invocation: bound(item.command),
        state:
          item.status === "inProgress"
            ? "running"
            : item.status === "declined"
              ? "cancelled"
              : item.status,
        ...(item.aggregatedOutput != null
          ? { output: bound(item.aggregatedOutput) }
          : previous?.output !== undefined
            ? { output: previous.output }
            : {}),
      });
    } else if (event.method === "item/commandExecution/outputDelta") {
      const previous = tools.get(event.params.itemId);
      if (previous?.state === "running")
        tools.set(previous.id, {
          ...previous,
          output: bound((previous.output ?? "") + event.params.delta),
        });
    } else if (event.method === "turn/completed") {
      for (const [id, tool] of tools) {
        if (tool.state === "running")
          tools.set(id, {
            ...tool,
            state: event.params.turn.status === "interrupted" ? "cancelled" : "failed",
          });
      }
    }
  };
  return {
    accept,
    snapshot: () => ({ tools: [...tools.values()], toolsTruncated: truncated, sequence }),
  };
};
