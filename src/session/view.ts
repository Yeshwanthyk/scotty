import type { SessionEvent } from "./events.js";
import { fold, initial, type State } from "./fold.js";
import * as claude from "./agents/claude.js";
import * as codex from "./agents/codex.js";
import type { TurnItems } from "./items.js";
import { defaultPlace } from "../places/place.js";

const agents = { codex, claude };

const turnState = (ended: string | undefined) =>
  ended === undefined
    ? ("streaming" as const)
    : ended === "interrupted"
      ? ("aborted" as const)
      : ended === "failed"
        ? ("failed" as const)
        : ("completed" as const);

const promptPreview = (prompt: string) => prompt.trim().slice(0, 300);

export function turnOutcome(state: State, req?: string) {
  const request = state.requests.find(
    (item) => item.kind === "prompt" && (req === undefined || item.req === req),
  );
  const ended = state.turns.find((turn) => turn.turn === request?.turn)?.state;
  if (ended !== undefined) return turnState(ended);
  if (
    state.phase === "failed" ||
    request?.status === "failed" ||
    request?.status === "stale" ||
    request?.status === "timed_out"
  )
    return "failed" as const;
  return state.phase === "stopped" ? ("stopped" as const) : ("working" as const);
}

const iso = (at: number | undefined) => (at === undefined ? null : new Date(at).toISOString());

const startTimings = (state: State) => {
  const timings = state.timings;
  if (timings === undefined) return null;
  const since = (at: number | undefined) => (at === undefined ? null : at - timings.start);
  return {
    gen: timings.gen,
    at: new Date(timings.start).toISOString(),
    created: since(timings.created),
    hello: since(timings.hello),
    ready: since(timings.ready),
    output: since(timings.output),
  };
};

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
      prompt: promptPreview(created?.prompt ?? ""),
      agentKind: created?.agentKind ?? "codex",
      origin: created?.origin ?? null,
      place: created?.place ?? defaultPlace,
      size: state.size,
      createdAt: new Date(created?.at ?? 0).toISOString(),
      activeAt: new Date(state.activeAt || (created?.at ?? 0)).toISOString(),
    },
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
      sleepsAt: iso(
        state.phase === "running"
          ? state.pending.find((item) => item.op === "idle")?.due
          : undefined,
      ),
    },
    start: startTimings(state),
  };
  if (state.phase === "provisioning") {
    return {
      ...base,
      authority: {
        kind: "transitioning" as const,
        action: "create" as const,
        phase: state.prepared ? "agent" : state.hello ? "workspace" : "container",
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

export const acceptedAgentEvents: (events: readonly SessionEvent[]) => SessionEvent[] =
  function acceptedAgentEvents(events) {
    let replay: State = initial;
    const accepted: SessionEvent[] = [];
    for (const event of events) {
      const next = fold(replay, event);
      if (event.kind === "agent.event" && next.lastN > replay.lastN) accepted.push(event);
      replay = next;
    }
    return accepted;
  };

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
        images: request.images ?? [],
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
