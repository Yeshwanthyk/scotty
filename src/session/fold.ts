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
const endAll = (state: State, phase: "stopped" | "failed"): State => ({
  ...state,
  phase,
  stopSeq: state.lastSeq,
  connected: false,
  pending: [],
  requests: state.requests.map((item) =>
    item.status === "pending" ? { ...item, status: "ended" } : item,
  ),
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
      return state.created === undefined ? { ...next, created: event } : next;
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
          { ...next, failure: { code: "supervisor_restarted", retryable: true } },
          "failed",
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
        : { ...advance(next, event.n), lastAckN: state.lastAckN, lastAckSeq: state.lastAckSeq };
      if (state.ready || state.created === undefined) return accepted;
      const req = `initial:${event.gen}`;
      return {
        ...accepted,
        ready: true,
        phase: "running",
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
        pending: addOnce(
          remove(state.pending, "workspace"),
          reqOp(req),
          event.at + deadlines.prompt,
        ),
      };
    }
    case "prompt.requested":
    case "interrupt.requested": {
      if (state.requests.some((item) => item.req === event.req)) return next;
      const kind = event.kind === "prompt.requested" ? "prompt" : "interrupt";
      const valid = state.phase === "running" && event.turn === state.currentTurn;
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
        ...next,
        requests: [...state.requests, request],
        pending: valid
          ? addOnce(state.pending, reqOp(event.req), event.at + deadlines[kind])
          : state.pending,
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
          { ...advance(next, event.n), lastAckN: state.lastAckN, lastAckSeq: state.lastAckSeq },
          "stopped",
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
        pending: state.pending.filter(
          (item) =>
            !state.requests.some(
              (req) =>
                req.turn === event.turn && req.status === "pending" && reqOp(req.req) === item.op,
            ),
        ),
      };
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
      if (event.op === "dial") return endAll(next, "stopped");
      if (event.op === "container" || event.op === "workspace")
        return endAll(
          { ...next, failure: { code: `${event.op}_timeout`, retryable: true } },
          "failed",
        );
      if (event.op === "redial")
        return { ...next, lastRedialSeq: event.seq, pending: remove(state.pending, "redial") };
      return {
        ...next,
        requests: settle(state.requests, requestFromOp(event.op), "timed_out"),
        pending: remove(state.pending, event.op),
      };
    case "container.stopped":
      return event.gen === state.gen && live(state) ? endAll(next, "stopped") : next;
    case "failed":
      return endAll(
        { ...next, failure: { code: event.code, retryable: event.retryable } },
        "failed",
      );
    case "invariant.violated":
      return next;
  }
}
