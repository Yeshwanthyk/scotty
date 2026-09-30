import { live, type State } from "./state.js";
import { has, reqOp } from "./deadlines.js";

export type Violation = { readonly code: string; readonly detail: string };
export function invariants(state: State): Violation[] {
  const violations: Violation[] = [];
  const check = (ok: boolean, code: string, detail: string): void => {
    if (!ok) violations.push({ code, detail });
  };
  check(state.lastSeq >= 0, "sequence", "negative event sequence");
  check(state.gen === undefined || state.gen >= 0, "generation", "negative generation");
  check(state.lastN >= 0, "ack", "negative supervisor acknowledgement");
  check(
    state.lastAckN >= 0 && state.lastAckN <= state.lastN,
    "ackProgress",
    "ack exceeds accepted supervisor output",
  );
  check(
    state.lastAckSeq >= 0 && state.lastAckSeq <= state.lastSeq,
    "ackSequence",
    "ack command sequence exceeds log",
  );
  check(
    state.failure === undefined || state.phase === "failed",
    "failure",
    "failure recorded while active",
  );
  check(
    (!has(state.pending, "idle") && !has(state.pending, "stalled")) || state.ready,
    "pace",
    "idle or stalled deadline before the workspace is ready",
  );
  check(
    state.stop === undefined || state.phase === "stopped",
    "stop",
    "stop reason recorded while not stopped",
  );
  check(
    state.currentTurn === String(state.turns.length) &&
      state.turns.every((turn, i) => turn.turn === String(i)),
    "turns",
    "turns must be contiguous",
  );
  check(!state.connected || state.hello, "connection", "connected without hello");
  check(!state.ready || state.hello, "workspace", "workspace ready without hello");
  check(state.phase !== "running" || state.ready, "running", "running without workspace");
  check(
    live(state) || (state.pending.length === 0 && !state.connected),
    "failed",
    "stopped or failed with pending work or connection",
  );
  check(
    new Set(state.requests.map((item) => item.req)).size === state.requests.length,
    "requests",
    "duplicate request id",
  );
  check(
    new Set(state.pending.map((item) => item.op)).size === state.pending.length &&
      state.pending.every((item) => Number.isFinite(item.due)),
    "deadlines",
    "duplicate or invalid deadline",
  );
  check(
    state.requests.every(
      // Before a resumed workspace is ready, pending requests have no deadline yet.
      (item) =>
        item.status === "pending"
          ? has(state.pending, reqOp(item.req)) || !state.ready
          : !has(state.pending, reqOp(item.req)),
    ),
    "pending",
    "request and deadline disagree",
  );
  check(
    state.pending.every(
      (item) =>
        !item.op.startsWith("req:") ||
        state.requests.some((req) => reqOp(req.req) === item.op && req.status === "pending"),
    ),
    "operations",
    "orphan pending operation",
  );
  check(
    has(state.pending, "container") === (state.gen !== undefined && !state.hello && live(state)),
    "container",
    "container deadline does not match startup",
  );
  check(
    has(state.pending, "workspace") === (state.hello && !state.ready && live(state)),
    "workspaceDeadline",
    "workspace deadline does not match readiness",
  );
  check(
    has(state.pending, "dial") === (state.hello && !state.connected && live(state)),
    "dial",
    "dial deadline does not match connection",
  );
  check(
    !has(state.pending, "redial") || (state.gen !== undefined && !state.connected && live(state)),
    "redial",
    "redial without disconnected generation",
  );
  check(
    !has(state.pending, "watch") || (state.gen !== undefined && live(state)),
    "watch",
    "watch without a live generation",
  );
  return violations;
}
