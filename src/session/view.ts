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

// A session's first prompt as shown to searches: long pastes are cut.
const promptPreview = (prompt: string) => prompt.trim().slice(0, 300);

// A search text is at most this many characters once trimmed.
export const maxSearch = 200;

// Case-insensitive substring over what the owner remembers a session by: title, repository,
// branch, the whole first prompt, and the key and connection or automation of its origin.
export function sessionMatches(state: State, query: string) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const created = state.created;
  if (created === undefined) return false;
  const origin = created.origin;
  const fields = [
    created.title,
    created.repo,
    created.branch,
    created.prompt,
    origin === undefined ? "" : (origin.key ?? ""),
    origin?.kind === "hook"
      ? origin.connection
      : origin?.kind === "automation"
        ? origin.automation
        : "",
  ];
  return fields.some((field) => field.toLowerCase().includes(needle));
}

// How the turn a prompt went into ended: the first prompt's when `req` is absent. A prompt the
// session refused counts as failed; a turn cut short by a stop, as stopped.
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
      stoppedAt: state.stoppedAt === undefined ? null : new Date(state.stoppedAt).toISOString(),
      place: created?.place ?? ("cloudflare" as const),
      createdAt: new Date(created?.at ?? 0).toISOString(),
      activeAt: new Date(state.activeAt || (created?.at ?? 0)).toISOString(),
    },
    // Working while the current turn has a prompt; `turns` lets a client notice unseen answers.
    progress: {
      working:
        state.phase === "running" &&
        state.requests.some(
          (request) => request.kind === "prompt" && request.turn === state.currentTurn,
        ),
      turns: state.turns.length,
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

const iso = (at: number | undefined) => (at === undefined ? null : new Date(at).toISOString());

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
