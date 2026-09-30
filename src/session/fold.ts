import { shouldAck } from "./ack.js";
import type { SessionEvent } from "./events.js";
import { deadlines, has, remove, addOnce, reqOp, isOp, requestFromOp } from "./deadlines.js";
import { live, type Request, type State } from "./state.js";
export { initial } from "./state.js";
export type { State, Request } from "./state.js";
export { deadline, deadlines } from "./deadlines.js";
export { invariants } from "./invariants.js";
export type { Violation } from "./invariants.js";

const settle = (
  requests: readonly Request[],
  req: string,
  status: Request["status"],
): readonly Request[] =>
  requests.map((item) =>
    item.req === req && item.status === "pending" ? { ...item, status } : item,
  );
const endAll = (state: State, phase: "stopped" | "failed", at: number): State => ({
  ...state,
  phase,
  // How long a session has slept counts from here; a new generation clears it.
  stoppedAt: phase === "stopped" ? at : undefined,
  stopSeq: state.lastSeq,
  connected: false,
  pending: [],
  requests: state.requests.map((item) =>
    item.status === "pending" ? { ...item, status: "ended" } : item,
  ),
});

// A new generation on a fresh container; pending requests wait for its workspace.
const resume = (state: State, at: number): State => ({
  ...state,
  phase: "provisioning",
  stoppedAt: undefined,
  gen: (state.gen ?? 0) + 1,
  startSeq: state.lastSeq,
  hello: false,
  connected: false,
  ready: false,
  lastN: 0,
  lastAckN: 0,
  lastAckSeq: 0,
  boot: undefined,
  pending: [{ op: "container", due: at + deadlines.container }],
});

const accepts = (state: State, event: { readonly gen: number; readonly n: number }): boolean =>
  state.gen === event.gen && state.connected && live(state) && event.n > state.lastN;
const advance = (state: State, n: number, forceAck = false): State => ({
  ...state,
  lastN: n,
  lastAckN: shouldAck(state, n, forceAck) ? n : state.lastAckN,
  lastAckSeq: shouldAck(state, n, forceAck) ? state.lastSeq : state.lastAckSeq,
});

export function fold(state: State, event: SessionEvent): State {
  if (event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  switch (event.kind) {
    case "created":
      return state.created === undefined ? { ...next, created: event, activeAt: event.at } : next;
    case "container.start":
      if (state.created === undefined || !live(state) || state.gen !== undefined) return next;
      return {
        ...next,
        gen: event.gen,
        startSeq: event.seq,
        pending: addOnce(state.pending, "container", event.at + deadlines.container),
      };
    case "sup.hello":
      if (event.gen !== state.gen || !live(state)) return next;
      if (state.boot !== undefined && state.boot !== event.boot)
        return endAll(
          {
            ...next,
            failure: { code: "supervisor_restarted", retryable: true },
          },
          "failed",
          event.at,
        );
      if (state.connected || (!has(state.pending, "container") && !has(state.pending, "dial")))
        return next;
      return {
        ...advance(next, Math.max(state.lastN, event.n)),
        lastAckN: state.lastAckN,
        lastAckSeq: state.lastAckSeq,
        hello: true,
        connected: true,
        boot: event.boot,
        lastHelloSeq: event.seq,
        pending: state.ready
          ? remove(remove(state.pending, "dial"), "redial")
          : addOnce(
              remove(remove(remove(state.pending, "container"), "dial"), "redial"),
              "workspace",
              event.at + deadlines.workspace,
            ),
      };
    case "workspace.ready": {
      if (!accepts(state, event)) return next;
      const accepted = state.ready
        ? advance(next, event.n)
        : {
            ...advance(next, event.n),
            lastAckN: state.lastAckN,
            lastAckSeq: state.lastAckSeq,
          };
      if (state.ready || state.created === undefined) return accepted;
      if (state.commit !== undefined)
        return {
          ...accepted,
          ready: true,
          phase: "running",
          readySeq: event.seq,
          pending: state.requests.reduce(
            (pending, item) =>
              item.status === "pending"
                ? addOnce(pending, reqOp(item.req), event.at + deadlines[item.kind])
                : pending,
            remove(state.pending, "workspace"),
          ),
        };
      const req = `initial:${event.gen}`;
      return {
        ...accepted,
        ready: true,
        phase: "running",
        readySeq: event.seq,
        commit: event.commit,
        requests: [
          ...state.requests,
          {
            req,
            turn: "0",
            kind: "prompt",
            text: state.created.prompt,
            status: "pending",
            seq: event.seq,
          },
        ],
        // A prompt that arrived while the workspace was being made waits behind the first.
        pending: state.requests.reduce(
          (pending, item) =>
            item.status === "pending"
              ? addOnce(pending, reqOp(item.req), event.at + deadlines[item.kind])
              : pending,
          addOnce(remove(state.pending, "workspace"), reqOp(req), event.at + deadlines.prompt),
        ),
      };
    }
    case "prompt.requested":
    case "interrupt.requested": {
      if (state.requests.some((item) => item.req === event.req)) return next;
      const kind = event.kind === "prompt.requested" ? "prompt" : "interrupt";
      // A prompt to a stopped session resumes it; requests wait for a resumed workspace, or for
      // the first one's, when the session has been created but has no workspace yet.
      const valid =
        event.turn === state.currentTurn &&
        (state.phase === "running" ||
          (state.phase === "provisioning" &&
            (state.commit !== undefined || (state.created !== undefined && kind === "prompt"))) ||
          (state.phase === "stopped" && kind === "prompt"));
      const base = valid && state.phase === "stopped" ? resume(next, event.at) : next;
      const request: Request =
        event.kind === "prompt.requested"
          ? {
              req: event.req,
              turn: event.turn,
              kind: "prompt",
              text: event.text,
              status: valid ? "pending" : "stale",
              seq: event.seq,
            }
          : {
              req: event.req,
              turn: event.turn,
              kind: "interrupt",
              status: valid ? "pending" : "stale",
              seq: event.seq,
            };
      return {
        ...base,
        activeAt: kind === "prompt" ? event.at : state.activeAt,
        requests: [...state.requests, request],
        pending:
          valid && base.ready
            ? addOnce(base.pending, reqOp(event.req), event.at + deadlines[kind])
            : base.pending,
      };
    }
    case "prompt.delivered":
      if (!accepts(state, event)) return next;
      if (!state.requests.some((item) => item.req === event.req && item.status === "pending"))
        return advance(next, event.n);
      return {
        ...advance(next, event.n),
        requests: settle(state.requests, event.req, "delivered"),
        pending: remove(state.pending, reqOp(event.req)),
      };
    case "agent.ready":
      return accepts(state, event)
        ? { ...advance(next, event.n), agentSession: event.session }
        : next;
    case "agent.event":
      return accepts(state, event) ? advance(next, event.n) : next;
    case "sup.error":
      if (!accepts(state, event)) return next;
      // A lone agent exit (crash or OOM) leaves the session resumable, not broken.
      if (event.req === undefined && event.code === "exit")
        return endAll(
          {
            ...advance(next, event.n),
            lastAckN: state.lastAckN,
            lastAckSeq: state.lastAckSeq,
          },
          "stopped",
          event.at,
        );
      // The supervisor reports a failed start once; waiting out the workspace deadline adds nothing.
      if (event.req === undefined && !state.ready)
        return endAll(
          {
            ...advance(next, event.n),
            lastAckN: state.lastAckN,
            lastAckSeq: state.lastAckSeq,
            failure: { code: event.code, retryable: true },
          },
          "failed",
          event.at,
        );
      if (
        event.req === undefined ||
        event.code === "timeout" ||
        !state.requests.some((item) => item.req === event.req && item.status === "pending")
      )
        return advance(next, event.n);
      return {
        ...advance(next, event.n),
        requests: settle(state.requests, event.req, "failed"),
        pending: remove(state.pending, reqOp(event.req)),
      };
    case "turn.ended":
      if (!accepts(state, event)) return next;
      const ended = advance(next, event.n, true);
      if (state.phase !== "running" || event.turn !== state.currentTurn) return ended;
      return {
        ...ended,
        activeAt: event.at,
        currentTurn: String(state.turns.length + 1),
        turns: [
          ...state.turns,
          { turn: event.turn, codexTurn: event.codexTurn, state: event.state },
        ],
        requests: state.requests.map((item) =>
          item.turn === event.turn && item.status === "pending"
            ? { ...item, status: "ended" }
            : item,
        ),
        saveSeq: event.seq,
        pending: addOnce(
          state.pending.filter(
            (item) =>
              item.op !== "save" &&
              !state.requests.some(
                (req) =>
                  req.turn === event.turn && req.status === "pending" && reqOp(req.req) === item.op,
              ),
          ),
          "save",
          event.at + deadlines.save,
        ),
      };
    case "save.done":
    case "save.failed":
      // Only the latest turn's save owns the deadline; an older save's result changes nothing.
      return state.turns.at(-1)?.turn === event.turn
        ? { ...next, pending: remove(state.pending, "save") }
        : next;
    case "socket.closed":
      if (event.gen !== state.gen || !live(state) || !state.connected) return next;
      return {
        ...next,
        connected: false,
        pending: addOnce(
          addOnce(state.pending, "dial", event.at + deadlines.dial),
          "redial",
          event.at + deadlines.redial,
        ),
      };
    case "dial.failed":
      if (event.gen !== state.gen || !live(state) || state.connected) return next;
      return {
        ...next,
        pending: addOnce(
          state.hello ? addOnce(state.pending, "dial", event.at + deadlines.dial) : state.pending,
          "redial",
          event.at + deadlines.redial,
        ),
      };
    case "sup.redial":
      if (event.gen !== state.gen || !live(state)) return next;
      return {
        ...next,
        connected: false,
        pending: state.hello
          ? addOnce(state.pending, "dial", event.at + deadlines.dial)
          : state.pending,
      };
    case "timeout":
      if (
        !isOp(event.op) ||
        !state.pending.some((item) => item.op === event.op && item.due <= event.at)
      )
        return next;
      // The container is gone or unreachable; its saved work can still resume.
      if (event.op === "dial") return endAll(next, "stopped", event.at);
      if (event.op === "container" || event.op === "workspace")
        return endAll(
          {
            ...next,
            failure: { code: `${event.op}_timeout`, retryable: true },
          },
          "failed",
          event.at,
        );
      // A lost save leaves the previous save in place; the session carries on.
      if (event.op === "save") return { ...next, pending: remove(state.pending, "save") };
      if (event.op === "redial")
        return {
          ...next,
          lastRedialSeq: event.seq,
          pending: remove(state.pending, "redial"),
        };
      return {
        ...next,
        requests: settle(state.requests, requestFromOp(event.op), "timed_out"),
        pending: remove(state.pending, event.op),
      };
    case "resume.requested":
      return state.phase === "stopped" ? resume({ ...next, activeAt: event.at }, event.at) : next;
    case "container.stopped":
      return event.gen === state.gen && live(state) ? endAll(next, "stopped", event.at) : next;
    case "failed":
      return endAll(
        {
          ...next,
          activeAt: event.at,
          failure: { code: event.code, retryable: event.retryable },
        },
        "failed",
        event.at,
      );
    case "file.attached": {
      const { seq: _seq, at: _at, src: _src, kind: _kind, ...file } = event;
      return {
        ...next,
        activeAt: event.at,
        files: [...state.files, { ...file, turn: state.currentTurn }],
      };
    }
    case "invariant.violated":
      return next;
  }
}
