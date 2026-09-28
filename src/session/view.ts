import type { SessionEvent } from "./events.js";
import { fold, initial, type State } from "./fold.js";

// Codex ends a turn as completed, interrupted or failed; the view has no pending "ended" state.
const turnState = (ended: string | undefined) =>
  ended === undefined
    ? ("streaming" as const)
    : ended === "interrupted"
      ? ("aborted" as const)
      : ended === "failed"
        ? ("failed" as const)
        : ("completed" as const);

export function sessionView(id: string, state: State) {
  const created = state.created;
  const title = created?.title ?? "Session";
  const branch = created?.branch ?? "main";
  const base = {
    identity: { id },
    display: {
      title,
      repository: created?.repo ?? "",
      branch,
    },
  };
  if (state.phase === "provisioning") {
    return {
      ...base,
      authority: {
        kind: "transitioning" as const,
        action: "create" as const,
        phase: state.hello ? "workspace" : "container",
        mode: "executing" as const,
        startedAt: new Date(created?.at ?? 0).toISOString(),
      },
    };
  }
  return {
    ...base,
    authority: {
      kind: "stable" as const,
      lifecycle: state.phase,
      failure:
        state.phase === "failed"
          ? { code: state.failure?.code ?? "session_failed", recovery: "create" as const }
          : null,
    },
  };
}

export function acceptedAgentEvents(events: readonly SessionEvent[]): SessionEvent[] {
  let replay: State = initial;
  const accepted: SessionEvent[] = [];
  for (const event of events) {
    const next = fold(replay, event);
    if (event.kind === "agent.event" && next.lastN > replay.lastN) accepted.push(event);
    replay = next;
  }
  return accepted;
}

function codexText(event: unknown): { text: string; complete: boolean } | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return undefined;
  const method = Reflect.get(event, "method");
  const params: unknown = Reflect.get(event, "params");
  if (method !== "item/completed" && method !== "item/agentMessage/delta") return undefined;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
  const item: unknown = Reflect.get(params, method === "item/completed" ? "item" : "delta");
  if (typeof item === "string") return { text: item, complete: false };
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const text: unknown = Reflect.get(item, "text");
  return typeof text === "string" ? { text, complete: method === "item/completed" } : undefined;
}

export function conversationView(state: State, events: readonly SessionEvent[]) {
  const answers = new Map<string, string>();
  let replay: State = initial;
  for (const event of events) {
    const next = fold(replay, event);
    if (event.kind === "agent.event" && next.lastN > replay.lastN) {
      const text = event.agentKind === "codex" ? codexText(event.event) : undefined;
      if (text !== undefined)
        answers.set(
          replay.currentTurn,
          text.complete ? text.text : (answers.get(replay.currentTurn) ?? "") + text.text,
        );
    }
    replay = next;
  }
  return {
    version: 1 as const,
    currentTurn: state.currentTurn,
    turns: state.requests
      .filter((request) => request.kind === "prompt")
      .map((request) => ({
        id: request.req,
        state: turnState(state.turns.find((turn) => turn.turn === request.turn)?.state),
        user: request.text,
        assistant: answers.get(request.turn) ?? "",
        files: state.files
          .filter((file) => file.turn === request.turn)
          .map(({ turn: _turn, file: id, ...file }) => ({ id, ...file })),
      })),
  };
}
