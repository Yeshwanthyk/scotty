import type { SessionEvent } from "./events.js";
import { fold, initial, type State } from "./fold.js";
import * as claude from "./agents/claude.js";
import * as codex from "./agents/codex.js";
import type { TurnItems } from "./items.js";

// Each agent reads its own events; nothing else here knows their format.
const agents = { codex, claude };

// Codex ends a turn as completed, interrupted or failed; the view has no pending "ended" state.
const turnState = (ended: string | undefined) =>
  ended === undefined
    ? ("streaming" as const)
    : ended === "interrupted"
      ? ("aborted" as const)
      : ended === "failed"
        ? ("failed" as const)
        : ("completed" as const);

const iso = (at: number | undefined) => (at === undefined ? null : new Date(at).toISOString());

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
      agentKind: created?.agentKind ?? "codex",
      createdAt: new Date(created?.at ?? 0).toISOString(),
      activeAt: new Date(state.activeAt || (created?.at ?? 0)).toISOString(),
    },
    // Working while the current turn has a live prompt; `turns` lets a client notice unseen
    // answers.
    progress: {
      working:
        state.phase === "running" &&
        state.requests.some(
          (request) =>
            request.kind === "prompt" &&
            request.turn === state.currentTurn &&
            (request.status === "pending" || request.status === "delivered"),
        ),
      turns: state.turns.length,
      // When an idle running session sleeps, unless someone uses it first.
      sleepsAt: iso(
        state.phase === "running"
          ? state.pending.find((item) => item.op === "idle")?.due
          : undefined,
      ),
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
      stop: state.phase === "stopped" ? (state.stop ?? null) : null,
      failure:
        state.phase === "failed"
          ? {
              code: state.failure?.code ?? "session_failed",
              recovery:
                state.failure?.retryable === true ? ("resume" as const) : ("create" as const),
            }
          : null,
    },
  };
}

export type SessionView = ReturnType<typeof sessionView>;

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

export function conversationView(state: State, events: readonly SessionEvent[]) {
  const answers = new Map<string, string>();
  const items = new Map<string, TurnItems>();
  const started = new Map<string, number>();
  const ended = new Map<string, number>();
  let replay: State = initial;
  for (const event of events) {
    const next = fold(replay, event);
    if (event.kind === "created") started.set(replay.currentTurn, event.at);
    if (event.kind === "prompt.requested" && !started.has(event.turn))
      started.set(event.turn, event.at);
    if (event.kind === "turn.ended" && !ended.has(event.turn)) ended.set(event.turn, event.at);
    if (event.kind === "agent.event" && next.lastN > replay.lastN) {
      const agent = agents[event.agentKind];
      items.set(
        replay.currentTurn,
        agent.step(items.get(replay.currentTurn) ?? { items: [], diff: "" }, event.event),
      );
      const text = agent.text(event.event);
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
        items: items.get(request.turn)?.items ?? [],
        diff: items.get(request.turn)?.diff ?? "",
        startedAt: iso(started.get(request.turn)),
        endedAt: iso(ended.get(request.turn)),
        files: state.files
          .filter((file) => file.turn === request.turn)
          .map(({ turn: _turn, file: id, ...file }) => ({ id, ...file })),
      })),
  };
}
