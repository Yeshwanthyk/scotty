import { Predicate } from "effect";
import type { CodexNotification } from "../../../../protocol/codex-app-server";
import {
  CONVERSATION_MAX_TOOLS_PER_TURN,
  CONVERSATION_MAX_TOOL_VALUE_BYTES,
  type CanonicalConversationTool,
} from "../../../../protocol/conversation";

type CommandItemEvent = Extract<CodexNotification, { method: "item/started" | "item/completed" }>;
type CommandOutputEvent = Extract<
  CodexNotification,
  { method: "item/commandExecution/outputDelta" }
>;
type TurnCompletedEvent = Extract<CodexNotification, { method: "turn/completed" }>;

export const makeCodexTools = () => {
  const tools = new Map<string, CanonicalConversationTool>();
  // Completion aggregates are a fallback. Once a stream delta is accepted,
  // preserve its order instead of guessing how it overlaps the aggregate.
  const outputDeltas = new Set<string>();
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
  const acceptItem = (event: CommandItemEvent) => {
    const item = event.params.item;
    if (!Predicate.hasProperty(item, "command")) return;
    if (!tools.has(item.id) && tools.size >= CONVERSATION_MAX_TOOLS_PER_TURN) {
      truncated = true;
      return;
    }
    const previous = tools.get(item.id);
    const hasOutputDeltas = outputDeltas.has(item.id);
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
      ...(item.aggregatedOutput != null && !hasOutputDeltas
        ? { output: bound(item.aggregatedOutput) }
        : previous?.output !== undefined
          ? { output: previous.output }
          : {}),
    });
  };
  const acceptOutputDelta = (event: CommandOutputEvent) => {
    const previous = tools.get(event.params.itemId);
    const hadOutputDeltas = outputDeltas.has(event.params.itemId);
    if (previous?.state !== "running") return;
    outputDeltas.add(event.params.itemId);
    tools.set(previous.id, {
      ...previous,
      output: bound(
        (hadOutputDeltas && previous.output !== undefined ? previous.output : "") +
          event.params.delta,
      ),
    });
  };
  const acceptTurnCompleted = (event: TurnCompletedEvent) => {
    for (const [id, tool] of tools) {
      if (tool.state === "running")
        tools.set(id, {
          ...tool,
          state: event.params.turn.status === "interrupted" ? "cancelled" : "failed",
        });
    }
  };
  const accept = (event: CodexNotification) => {
    sequence++;
    if (event.method === "turn/started") {
      tools.clear();
      outputDeltas.clear();
      truncated = false;
    } else if (event.method === "item/started" || event.method === "item/completed") {
      acceptItem(event);
    } else if (event.method === "item/commandExecution/outputDelta") {
      acceptOutputDelta(event);
    } else if (event.method === "turn/completed") {
      acceptTurnCompleted(event);
    }
  };
  return {
    accept,
    snapshot: () => ({ tools: [...tools.values()], toolsTruncated: truncated, sequence }),
  };
};
