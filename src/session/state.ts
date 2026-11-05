import type { SessionEvent, StopReason } from "./events.js";
import type { Pending } from "./deadlines.js";
import { defaultSize, type Size } from "../places/place.js";

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
// The session's machine at its place; the fold keeps one handle at most. `gen` is the generation
// it last ran: the one that created it, or the latest whose hello showed the disk kept. `live`
// is running or being woken; `pausing` waits for the place's answer; `paused` rests. `seq` is the
// event that last changed it.
export type PlaceRecord = {
  readonly handle: string;
  readonly gen: number;
  readonly size: typeof Size.Type;
  readonly status: "live" | "pausing" | "paused";
  readonly seq: number;
};
// When this generation's start reached each step, from its events' `at`.
export type Timings = {
  readonly gen: number;
  readonly start: number;
  readonly created?: number;
  readonly hello?: number;
  readonly ready?: number;
  readonly output?: number;
};
type Turn = { readonly turn: string; readonly codexTurn: string; readonly state: string };

export type State = {
  readonly phase: "provisioning" | "running" | "stopped" | "failed";
  readonly lastSeq: number;
  // When the owner or the agent last did something worth sorting by: a prompt, a turn's end.
  readonly activeAt: number;
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
  // Why the session last stopped; `agent` is the agent exiting in a running container.
  readonly stop:
    | {
        readonly reason: typeof StopReason.Type | "agent";
        readonly exitCode?: number;
        readonly max?: number;
      }
    | undefined;
  readonly lastHelloSeq: number;
  readonly lastRedialSeq: number;
  // The idle timeout the Session DO is checking; 0 once a prompt, turn or use overtakes it.
  readonly idleSeq: number;
  readonly currentTurn: string;
  readonly turns: readonly Turn[];
  readonly requests: readonly Request[];
  readonly files: readonly (AttachedFile & { readonly turn: string })[];
  readonly pending: readonly Pending[];
  readonly created: Extract<SessionEvent, { kind: "created" }> | undefined;
  // The size every start uses: the created one, until a resume names another.
  readonly size: typeof Size.Type;
  readonly place: PlaceRecord | undefined;
  // A handle to remove before the next create: its place answered gone, or the session ended.
  // `seq` is the event that set it.
  readonly gone: { readonly handle: string; readonly seq: number } | undefined;
  // A save of this session reached R2.
  readonly saved: boolean;
  // This generation's machine kept the session's disk, and its hello said so.
  readonly fromDisk: boolean;
  readonly timings: Timings | undefined;
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
  stop: undefined,
  lastHelloSeq: 0,
  lastRedialSeq: 0,
  idleSeq: 0,
  currentTurn: "0",
  turns: [],
  requests: [],
  files: [],
  pending: [],
  created: undefined,
  size: defaultSize,
  place: undefined,
  gone: undefined,
  saved: false,
  fromDisk: false,
  timings: undefined,
};
