import type { SessionEvent } from "./events.js";

export const deadlines = {
  container: 120_000,
  workspace: 120_000,
  dial: 30_000,
  redial: 2_000,
  prompt: 30_000,
  interrupt: 30_000,
} as const;

type Op = "container" | "workspace" | "dial" | "redial" | `req:${string}`;
const reqOp = (req: string): `req:${string}` => `req:${req}`;
const isOp = (value: string): value is Op =>
  ["container", "workspace", "dial", "redial"].includes(value) || value.startsWith("req:");
const requestFromOp = (op: `req:${string}`): string => op.slice(4);
type Pending = { readonly op: Op; readonly due: number };
type RequestBase = {
  readonly req: string;
  readonly turn: string;
  readonly status: "pending" | "delivered" | "stale" | "timed_out" | "ended";
  readonly seq: number;
};
export type Request =
  | (RequestBase & { readonly kind: "prompt"; readonly text: string })
  | (RequestBase & { readonly kind: "interrupt" });
type Turn = { readonly turn: string; readonly state: string };

export type State = {
  readonly phase: "provisioning" | "running" | "failed";
  readonly lastSeq: number;
  readonly gen: number | undefined;
  readonly startSeq: number;
  readonly hello: boolean;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly lastN: number;
  readonly lastHelloSeq: number;
  readonly lastRedialSeq: number;
  readonly currentTurn: string;
  readonly turns: readonly Turn[];
  readonly requests: readonly Request[];
  readonly pending: readonly Pending[];
  readonly created: Extract<SessionEvent, { kind: "created" }> | undefined;
};

export const initial: State = {
  phase: "provisioning",
  lastSeq: 0,
  gen: undefined,
  startSeq: 0,
  hello: false,
  connected: false,
  ready: false,
  lastN: 0,
  lastHelloSeq: 0,
  lastRedialSeq: 0,
  currentTurn: "0",
  turns: [],
  requests: [],
  pending: [],
  created: undefined,
};

const has = (pending: readonly Pending[], op: Op): boolean =>
  pending.some((item) => item.op === op);
const remove = (pending: readonly Pending[], op: Op): readonly Pending[] =>
  pending.filter((item) => item.op !== op);
const addOnce = (pending: readonly Pending[], op: Op, due: number): readonly Pending[] =>
  has(pending, op) ? pending : [...pending, { op, due }];
const settle = (
  requests: readonly Request[],
  req: string,
  status: Request["status"],
): readonly Request[] =>
  requests.map((item) =>
    item.req === req && item.status === "pending" ? { ...item, status } : item,
  );
const failAll = (state: State): State => ({
  ...state,
  phase: "failed",
  connected: false,
  pending: [],
  requests: state.requests.map((item) =>
    item.status === "pending" ? { ...item, status: "ended" } : item,
  ),
});

export function fold(state: State, event: SessionEvent): State {
  if (event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  switch (event.kind) {
    case "created":
      return state.created === undefined ? { ...next, created: event } : next;
    case "container.start":
      if (state.created === undefined || state.phase === "failed" || state.gen !== undefined)
        return next;
      return {
        ...next,
        gen: event.gen,
        startSeq: event.seq,
        pending: addOnce(state.pending, "container", event.at + deadlines.container),
      };
    case "sup.hello":
      if (
        event.gen !== state.gen ||
        state.phase === "failed" ||
        state.connected ||
        (!has(state.pending, "container") && !has(state.pending, "dial"))
      )
        return next;
      return {
        ...next,
        hello: true,
        connected: true,
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
      if (
        event.gen !== state.gen ||
        !state.hello ||
        !state.connected ||
        state.phase === "failed" ||
        state.ready ||
        state.created === undefined
      )
        return next;
      const req = `initial:${event.gen}`;
      return {
        ...next,
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
      if (!state.requests.some((item) => item.req === event.req && item.status === "pending"))
        return next;
      return {
        ...next,
        requests: settle(state.requests, event.req, "delivered"),
        pending: remove(state.pending, reqOp(event.req)),
      };
    case "agent.event":
      return event.gen === state.gen && state.connected && event.n > state.lastN
        ? { ...next, lastN: event.n }
        : next;
    case "turn.ended":
      if (event.gen !== state.gen || state.phase !== "running" || event.turn !== state.currentTurn)
        return next;
      return {
        ...next,
        currentTurn: String(state.turns.length + 1),
        turns: [...state.turns, { turn: event.turn, state: event.state }],
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
      if (event.gen !== state.gen || state.phase === "failed" || !state.connected) return next;
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
      if (event.gen !== state.gen || state.phase === "failed" || state.connected) return next;
      return {
        ...next,
        pending: addOnce(
          state.hello ? addOnce(state.pending, "dial", event.at + deadlines.dial) : state.pending,
          "redial",
          event.at + deadlines.redial,
        ),
      };
    case "sup.redial":
      if (event.gen !== state.gen || state.phase === "failed") return next;
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
      if (event.op === "container" || event.op === "workspace" || event.op === "dial")
        return failAll(next);
      if (event.op === "redial")
        return { ...next, lastRedialSeq: event.seq, pending: remove(state.pending, "redial") };
      return {
        ...next,
        requests: settle(state.requests, requestFromOp(event.op), "timed_out"),
        pending: remove(state.pending, event.op),
      };
    case "failed":
      return failAll(next);
    case "invariant.violated":
      return next;
  }
}

export function deadline(state: State): number | undefined {
  return state.pending.reduce<number | undefined>(
    (earliest, item) => (earliest === undefined ? item.due : Math.min(earliest, item.due)),
    undefined,
  );
}

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
