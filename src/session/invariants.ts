import type { State } from "./state.js";
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
    state.currentTurn === String(state.turns.length) &&
      state.turns.every((turn, i) => turn.turn === String(i)),
    "turns",
    "turns must be contiguous",
  );
  check(!state.connected || state.hello, "connection", "connected without hello");
  check(!state.ready || state.hello, "workspace", "workspace ready without hello");
  check(state.phase !== "running" || state.ready, "running", "running without workspace");
  check(
    state.phase !== "failed" || (state.pending.length === 0 && !state.connected),
    "failed",
    "failed with pending work or connection",
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
      (item) => (item.status === "pending") === has(state.pending, reqOp(item.req)),
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
    has(state.pending, "container") ===
      (state.gen !== undefined && !state.hello && state.phase !== "failed"),
    "container",
    "container deadline does not match startup",
  );
  check(
    has(state.pending, "workspace") === (state.hello && !state.ready && state.phase !== "failed"),
    "workspaceDeadline",
    "workspace deadline does not match readiness",
  );
  check(
    has(state.pending, "dial") === (state.hello && !state.connected && state.phase !== "failed"),
    "dial",
    "dial deadline does not match connection",
  );
  check(
    !has(state.pending, "redial") ||
      (state.gen !== undefined && !state.connected && state.phase !== "failed"),
    "redial",
    "redial without disconnected generation",
  );
  return violations;
}
