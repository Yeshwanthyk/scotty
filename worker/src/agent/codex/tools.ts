import { Predicate } from "effect";
import { toolDisplayText } from "../../../../protocol/tool-display-text";
import type { CodexNotification } from "../../../../protocol/codex-app-server";
import type { CanonicalConversationTool } from "../../../../protocol/conversation";

type CommandItemEvent = Extract<CodexNotification, { method: "item/started" | "item/completed" }>;
type CommandOutputEvent = Extract<
  CodexNotification,
  { method: "item/commandExecution/outputDelta" }
>;
type TurnCompletedEvent = Extract<CodexNotification, { method: "turn/completed" }>;
type DynamicToolItemEvent = Extract<
  CodexNotification,
  { method: "item/started" | "item/completed" }
>;

export const makeCodexTools = () => {
  const tools = new Map<string, CanonicalConversationTool>();
  const commandItems = new Set<string>();
  // Completion aggregates are a fallback. Once a stream delta is accepted,
  // preserve its order instead of guessing how it overlaps the aggregate.
  const outputDeltas = new Set<string>();
  let sequence = 0;
  const acceptItem = (event: CommandItemEvent) => {
    const item = event.params.item;
    if (!Predicate.hasProperty(item, "command")) return;
    commandItems.add(item.id);
    const previous = tools.get(item.id);
    const hasOutputDeltas = outputDeltas.has(item.id);
    tools.set(item.id, {
      id: item.id,
      label: "Command",
      invocation: item.command,
      state:
        item.status === "inProgress"
          ? "running"
          : item.status === "declined"
            ? "cancelled"
            : item.status,
      ...(item.aggregatedOutput != null && !hasOutputDeltas
        ? { output: item.aggregatedOutput }
        : previous?.output !== undefined
          ? { output: previous.output }
          : {}),
    });
  };
  const acceptDynamicItem = (event: DynamicToolItemEvent) => {
    const item = event.params.item;
    if (
      item.type !== "dynamicToolCall" ||
      !Predicate.hasProperty(item, "id") ||
      !Predicate.hasProperty(item, "tool") ||
      !Predicate.hasProperty(item, "status")
    )
      return;
    const previous = tools.get(item.id);
    const label =
      item.tool === "scotty_hatch"
        ? "Hatch"
        : item.tool === "scotty_browser_test"
          ? "Browser evidence"
          : "Tool";
    tools.set(item.id, {
      id: item.id,
      label: previous?.label ?? label,
      invocation: label,
      state: item.status === "inProgress" ? "running" : item.status,
      ...(previous?.output === undefined ? {} : { output: previous.output }),
    });
  };
  const acceptDynamicResult = (callId: string, text: string) => {
    const previous = tools.get(callId);
    if (previous === undefined) return;
    tools.set(callId, { ...previous, output: text });
  };
  const acceptDynamicCall = (callId: string, input: unknown) => {
    const previous = tools.get(callId);
    const label = toolDisplayText(input);
    if (previous?.state !== "running" || label === undefined || label === previous.label) return;
    tools.set(callId, { ...previous, label });
    sequence++;
  };
  const acceptOutputDelta = (event: CommandOutputEvent) => {
    const previous = tools.get(event.params.itemId);
    const hadOutputDeltas = outputDeltas.has(event.params.itemId);
    if (previous?.state !== "running") return;
    outputDeltas.add(event.params.itemId);
    tools.set(previous.id, {
      ...previous,
      output:
        (hadOutputDeltas && previous.output !== undefined ? previous.output : "") +
        event.params.delta,
    });
  };
  const acceptTurnCompleted = (event: TurnCompletedEvent) => {
    for (const [id, tool] of tools) {
      if (
        tool.state === "running" &&
        !(event.params.turn.status === "completed" && commandItems.has(id))
      )
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
      commandItems.clear();
      outputDeltas.clear();
    } else if (event.method === "item/started" || event.method === "item/completed") {
      acceptItem(event);
      acceptDynamicItem(event);
    } else if (event.method === "item/commandExecution/outputDelta") {
      acceptOutputDelta(event);
    } else if (event.method === "turn/completed") {
      acceptTurnCompleted(event);
    }
  };
  return {
    accept,
    acceptDynamicCall,
    acceptDynamicResult,
    snapshot: () => ({ tools: [...tools.values()], toolsTruncated: false, sequence }),
  };
};
