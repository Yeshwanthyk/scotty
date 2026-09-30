import type { SessionEvent } from "./events.js";
import type { Pending } from "./deadlines.js";

type RequestBase = {
  readonly req: string;
  readonly turn: string;
  readonly status: "pending" | "delivered" | "failed" | "stale" | "timed_out" | "ended";
  readonly seq: number;
};
export type Request =
  | (RequestBase & { readonly kind: "prompt"; readonly text: string })
  | (RequestBase & { readonly kind: "interrupt" });
type AttachedFile = Omit<
  Extract<SessionEvent, { kind: "file.attached" }>,
  "seq" | "at" | "src" | "kind"
>;
type Turn = { readonly turn: string; readonly codexTurn: string; readonly state: string };

export type State = {
  readonly phase: "provisioning" | "running" | "stopped" | "failed";
  readonly lastSeq: number;
  // When the owner or the agent last did something worth sorting by: a prompt, a turn's end.
  readonly activeAt: number;
  // When the session last went to sleep; undefined while it is up or failed.
  readonly stoppedAt: number | undefined;
  readonly gen: number | undefined;
  readonly startSeq: number;
  readonly stopSeq: number;
  readonly saveSeq: number;
  readonly readySeq: number;
  // The base commit from the first workspace; set means later generations resume.
  readonly commit: string | undefined;
  readonly hello: boolean;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly lastN: number;
  readonly lastAckN: number;
  readonly lastAckSeq: number;
  readonly boot: string | undefined;
  readonly agentSession: string | undefined;
  readonly failure: { readonly code: string; readonly retryable: boolean } | undefined;
  readonly lastHelloSeq: number;
  readonly lastRedialSeq: number;
  readonly currentTurn: string;
  readonly turns: readonly Turn[];
  readonly requests: readonly Request[];
  readonly files: readonly (AttachedFile & { readonly turn: string })[];
  readonly pending: readonly Pending[];
  readonly created: Extract<SessionEvent, { kind: "created" }> | undefined;
};

// The request id the first prompt goes in under once the first workspace is ready.
export const firstReq = (
  created: Extract<SessionEvent, { kind: "created" }>,
  gen: number,
): string => created.req ?? `initial:${gen}`;

// Stopped and failed sessions hold no connection, deadline or pending request.
export const live = (state: State): boolean =>
  state.phase !== "failed" && state.phase !== "stopped";

export const initial: State = {
  phase: "provisioning",
  lastSeq: 0,
  activeAt: 0,
  stoppedAt: undefined,
  gen: undefined,
  startSeq: 0,
  stopSeq: 0,
  saveSeq: 0,
  readySeq: 0,
  commit: undefined,
  hello: false,
  connected: false,
  ready: false,
  lastN: 0,
  lastAckN: 0,
  lastAckSeq: 0,
  boot: undefined,
  agentSession: undefined,
  failure: undefined,
  lastHelloSeq: 0,
  lastRedialSeq: 0,
  currentTurn: "0",
  turns: [],
  requests: [],
  files: [],
  pending: [],
  created: undefined,
};
