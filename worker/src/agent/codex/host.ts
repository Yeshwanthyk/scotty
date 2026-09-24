import { Effect, Predicate } from "effect";
import {
  CODEX_VERSION,
  type CodexNotification,
} from "../../../../protocol/agents/codex/codex-app-server";
import type {
  CanonicalConversationTool,
  CanonicalConversationTurn,
} from "../../../../protocol/session/conversation";
import type { SidecarHost } from "../sidecar/runtime";
import { CodexHostError } from "./errors";
import { writeCodexSavedState } from "./persistence";
import type { startCodexSession } from "./session";

export type CodexSession = Effect.Success<ReturnType<typeof startCodexSession>>;

// Command output and completion can arrive after the turn itself is terminal.
const projectLateCommand = (
  tool: CanonicalConversationTool,
  event: CodexNotification,
): CanonicalConversationTool => {
  if (event.method === "item/commandExecution/outputDelta")
    return { ...tool, output: `${tool.output ?? ""}${event.params.delta}` };
  if (event.method !== "item/completed" || !Predicate.hasProperty(event.params.item, "command"))
    return tool;
  const { status, aggregatedOutput } = event.params.item;
  return {
    ...tool,
    state: status === "declined" ? "cancelled" : status === "inProgress" ? "running" : status,
    ...(aggregatedOutput == null ? {} : { output: aggregatedOutput }),
  };
};
const lateCommandTarget = (event: CodexNotification) => {
  if (event.method === "item/commandExecution/outputDelta")
    return Predicate.hasProperty(event.params, "itemId")
      ? {
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          itemId: event.params.itemId,
        }
      : undefined;
  if (event.method === "item/completed" && event.params.item.type === "commandExecution")
    return Predicate.hasProperty(event.params.item, "id")
      ? {
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          itemId: event.params.item.id,
        }
      : undefined;
  return undefined;
};

/** Adapts one Codex app-server session to the agent-neutral sidecar host contract. */
export const codexSidecarHost = Effect.fnUntraced(function* (session: CodexSession) {
  const { settings, homes } = session.inspect();
  const threadId = settings.thread.id;
  // Session readiness already proved effort equals the launch selection.
  const effort = settings.reasoningEffort;
  if (effort == null) return yield* new CodexHostError({ code: "settings_mismatch" });
  const host: SidecarHost<CodexHostError> = {
    agent: "codex",
    version: CODEX_VERSION,
    threadId,
    settings: { model: settings.model, effort, workspace: settings.cwd },
    inspect: session.inspect,
    prompt: (text, clientUserMessageId, images) =>
      session.prompt(text, clientUserMessageId, images).pipe(
        Effect.map(({ turnId, completed }) => ({
          turnId,
          completed: completed.pipe(
            Effect.map((terminal) => ({
              id: terminal.id,
              status: terminal.status,
              text: terminal.items.map((item) => item.text).join(""),
            })),
          ),
        })),
      ),
    steer: session.steer,
    interrupt: session.interrupt,
    stop: session.stop,
    closed: session.closed,
    settleHistory: (history) => {
      let settled: ReadonlyArray<CanonicalConversationTurn> = history;
      for (const event of session.drainLateCommands()) {
        const target = lateCommandTarget(event);
        if (target === undefined || target.threadId !== threadId) continue;
        settled = settled.map((turn) =>
          turn.id !== target.turnId
            ? turn
            : {
                ...turn,
                tools: turn.tools.map((tool) =>
                  tool.id === target.itemId ? projectLateCommand(tool, event) : tool,
                ),
              },
        );
      }
      return settled;
    },
    releaseEvents: () => {
      session.drainEvents();
    },
    persist: (history) => writeCodexSavedState(homes.cwd, homes.codexHome, history),
  };
  return host;
});
