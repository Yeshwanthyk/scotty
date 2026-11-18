import { sameImages, type PromptImage } from "../../protocol/prompt.js";
import { shouldAck } from "./ack.js";
import type { SessionEvent } from "./events.js";
import { deadlines, has, remove, addOnce, reqOp, requestFromOp, idleWindow } from "./deadlines.js";
import { defaultPlace, defaultSize, type Size } from "../places/place.js";
import { firstReq, live, type Request, type State } from "./state.js";
import { threadGone } from "../../protocol/supervisor.js";
export { initial } from "./state.js";
export type { State, Request } from "./state.js";
export { deadline, deadlines } from "./deadlines.js";
export { invariants } from "./invariants.js";
export type { Violation } from "./invariants.js";

const resumable: (state: State) => boolean = (state) =>
  state.phase === "stopped" || (state.phase === "failed" && state.failure?.retryable === true);

export const resizeConflict: (
  state: State,
  size: typeof Size.Type | undefined,
) => "running" | "failed" | undefined = (state, size) =>
  size === undefined || size === state.size || resumable(state)
    ? undefined
    : state.phase === "failed"
      ? "failed"
      : "running";

const settle: (
  requests: readonly Request[],
  req: string,
  status: Request["status"],
) => readonly Request[] = (requests, req, status) =>
  requests.map((item) =>
    item.req === req && item.status === "pending" ? { ...item, status } : item,
  );
const turnOpen: (state: State) => boolean = (state) =>
  state.requests.some(
    (item) =>
      item.kind === "prompt" &&
      item.turn === state.currentTurn &&
      (item.status === "pending" || item.status === "delivered"),
  );
const stopPlace: (state: State, at: number, removing: boolean) => State = (state, at, removing) => {
  const place = state.place;
  const handle = place?.handle ?? state.gone?.handle;
  if (removing && handle !== undefined)
    return {
      ...state,
      place: undefined,
      gone: { handle, seq: state.lastSeq },
      pending: remove(state.pending, "pause"),
    };
  return place?.status === "live"
    ? {
        ...state,
        place: { ...place, status: "pausing", seq: state.lastSeq },
        pending: [...remove(state.pending, "pause"), { op: "pause", due: at + deadlines.pause }],
      }
    : state;
};

const endAll: (
  state: State,
  at: number,
  phase: "stopped" | "failed",
  stop?: State["stop"],
) => State = (state, at, phase, stop) =>
  stopPlace(
    {
      ...state,
      phase,
      stop: phase === "stopped" ? stop : undefined,
      stopSeq: state.lastSeq,
      connected: false,
      pending: state.pending.filter((item) => item.op === "pause"),
      requests: state.requests.map((item) =>
        item.status === "pending" ? { ...item, status: "ended" } : item,
      ),
      ...(turnOpen(state)
        ? {
            currentTurn: String(state.turns.length + 1),
            turns: [
              ...state.turns,
              { turn: state.currentTurn, codexTurn: "", state: "interrupted" },
            ],
          }
        : {}),
    },
    at,
    stop?.reason === "ended",
  );

const stallReq: (turn: string) => string = (turn) => `stalled:${turn}`;
const stalled: (state: State, turn: string) => boolean = (state, turn) =>
  state.requests.some((item) => item.req === stallReq(turn));
const saved: (state: State, next: State, at: number) => State = (state, next, at) => {
  const turn = state.turns.at(-1)?.turn;
  const settled = { ...next, pending: remove(state.pending, "save") };
  return turn !== undefined && live(state) && stalled(state, turn) && !turnOpen(next)
    ? endAll(settled, at, "stopped", { reason: "stalled" })
    : settled;
};

const wakeable: (state: State) => boolean = (state) =>
  state.place !== undefined || state.commit === undefined || state.saved || !state.lostDisk;

const fitted: (state: State) => State = (state) =>
  state.place !== undefined && state.place.status !== "pausing" && state.place.size !== state.size
    ? { ...state, place: undefined, gone: { handle: state.place.handle, seq: state.lastSeq } }
    : state;

const resume: (state: State, at: number) => State = (state, at) => {
  const sized = fitted(state);
  if (!wakeable(sized))
    return live(sized)
      ? endAll(sized, at, "stopped", { reason: "gone" })
      : { ...sized, phase: "stopped", failure: undefined, stop: { reason: "gone" } };
  const gen = (state.gen ?? 0) + 1;
  return {
    ...sized,
    phase: "provisioning",
    failure: undefined,
    stop: undefined,
    gen,
    startSeq: state.lastSeq,
    hello: false,
    connected: false,
    ready: false,
    prepared: false,
    fromDisk: false,
    lastN: 0,
    lastAckN: 0,
    lastAckSeq: 0,
    boot: undefined,
    timings: { gen, start: at },
    place:
      sized.place?.status === "paused"
        ? { ...sized.place, status: "live", seq: state.lastSeq }
        : sized.place,
    pending: [
      ...sized.pending.filter((item) => item.op === "pause"),
      { op: "container", due: at + deadlines.container },
    ],
  };
};

const placeGone: (state: State, at: number, handle: string) => State = (state, at, handle) => {
  const place = state.place;
  if (place?.handle !== handle) return state;
  const rested = place.status === "paused" || (place.status === "live" && place.gen !== state.gen);
  const after: State = {
    ...state,
    lostDisk: state.lostDisk || rested,
    place: undefined,
    gone: { handle, seq: state.lastSeq },
    pending: remove(state.pending, "pause"),
  };
  return live(after) && !after.hello && !wakeable(after)
    ? endAll(after, at, "stopped", { reason: "gone" })
    : after;
};

const keptDisk: (
  state: State,
  workspace: Extract<SessionEvent, { kind: "sup.hello" }>["workspace"],
) => boolean = (state, workspace) =>
  workspace !== undefined &&
  state.created !== undefined &&
  workspace.branch === state.created.branch &&
  `scotty/${workspace.session}` === state.created.branch &&
  workspace.base === state.commit &&
  workspace.thread === state.agentSession;

const replaced: (state: State, at: number, handle: string) => State = (state, at, handle) => {
  const gone = placeGone(state, at, handle);
  return live(gone) ? resume(gone, at) : gone;
};

const accepts: (state: State, event: { readonly gen: number; readonly n: number }) => boolean = (
  state,
  event,
) => state.gen === event.gen && state.connected && live(state) && event.n > state.lastN;
const advance = (state: State, n: number, forceAck = false) =>
  ({
    ...state,
    lastN: n,
    lastAckN: shouldAck(state, n, forceAck) ? n : state.lastAckN,
    lastAckSeq: shouldAck(state, n, forceAck) ? state.lastSeq : state.lastAckSeq,
  }) satisfies State;

const pace: (before: State, after: State, event: SessionEvent) => State = (
  before,
  after,
  event,
) => {
  if (after === before) return after;
  const ready = live(after) && after.ready;
  const idle = ready && !turnOpen(after) && !has(after.pending, "save");
  const output =
    (event.kind === "agent.event" || event.kind === "prompt.delivered") &&
    after.lastN > before.lastN;
  const paced = idle
    ? addOnce(after.pending, "idle", event.at + idleWindow(after))
    : remove(after.pending, "idle");
  return {
    ...after,
    idleSeq: idle ? after.idleSeq : 0,
    pending: !(ready && turnOpen(after))
      ? remove(paced, "stalled")
      : output
        ? [...remove(paced, "stalled"), { op: "stalled", due: event.at + deadlines.stalled }]
        : addOnce(paced, "stalled", event.at + deadlines.stalled),
  };
};

const timed: (before: State, after: State, event: SessionEvent) => State = (
  before,
  after,
  event,
) => {
  const timings = after.timings;
  if (after === before || timings === undefined || timings.gen !== after.gen) return after;
  const reached = (step: "created" | "hello" | "ready" | "output", now: boolean) =>
    now && timings[step] === undefined ? { [step]: event.at } : {};
  const stamped = {
    ...reached(
      "created",
      event.kind === "place.created" &&
        before.place === undefined &&
        after.place?.status === "live",
    ),
    ...reached("hello", !before.hello && after.hello),
    ...reached("ready", !before.ready && after.ready),
    ...reached("output", event.kind === "agent.event" && after.lastN > before.lastN),
  };
  return Object.keys(stamped).length === 0
    ? after
    : { ...after, timings: { ...timings, ...stamped } };
};

export const fold: (state: State, event: SessionEvent) => State = function fold(state, event) {
  const after = step(state, event);
  return timed(state, pace(state, after, event), event);
};

const step: (state: State, event: SessionEvent) => State = function step(state, event) {
  if (event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  switch (event.kind) {
    case "container.dial.attempt":
    case "container.dial.result":
    case "container.dial.started":
      return next;
    case "created":
      return state.created === undefined
        ? { ...next, created: event, activeAt: event.at, size: event.size ?? defaultSize }
        : next;
    case "container.start":
      if (state.created === undefined || !live(state) || state.gen !== undefined) return next;
      return {
        ...next,
        gen: event.gen,
        startSeq: event.seq,
        timings: { gen: event.gen, start: event.at },
        pending: addOnce(state.pending, "container", event.at + deadlines.container),
      };
    case "place.created": {
      if (state.place !== undefined || state.gen === undefined || event.gen > state.gen)
        return next;
      const created = { ...next, gone: undefined };
      if (live(state) && event.gen === state.gen)
        return {
          ...created,
          place: {
            handle: event.handle,
            gen: event.gen,
            size: state.size,
            status: "live",
            seq: event.seq,
          },
        };
      return {
        ...created,
        place: {
          handle: event.handle,
          gen: event.gen,
          size: state.size,
          status: "pausing",
          seq: event.seq,
        },
        pending: addOnce(state.pending, "pause", event.at + deadlines.pause),
      };
    }
    case "place.paused": {
      const place = state.place;
      if (place?.handle !== event.handle || place.status !== "pausing") return next;
      const paused: State = {
        ...next,
        place: { ...place, status: "paused", seq: event.seq },
        pending: remove(state.pending, "pause"),
      };
      if (!live(state) || state.hello) return paused;
      const sized = fitted(paused);
      return sized.place === undefined
        ? sized
        : { ...sized, place: { ...sized.place, status: "live" } };
    }
    case "place.gone":
      return placeGone(next, event.at, event.handle);
    case "sup.hello": {
      if (event.gen !== state.gen || !live(state)) return next;
      if (state.boot !== undefined && state.boot !== event.boot)
        return endAll(next, event.at, "stopped", { reason: "deploy" });
      if (state.connected || (!has(state.pending, "container") && !has(state.pending, "dial")))
        return next;
      const place = state.place;
      const woken = place !== undefined && place.status === "live" && place.gen !== event.gen;
      if (woken && !keptDisk(state, event.workspace)) return replaced(next, event.at, place.handle);
      return {
        ...advance(next, Math.max(state.lastN, event.n)),
        ...(woken ? { fromDisk: true, place: { ...place, gen: event.gen } } : {}),
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
    }
    case "workspace.prepared":
      return accepts(state, event) ? { ...advance(next, event.n), prepared: true } : next;
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
      const req = firstReq(state.created, event.gen);
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
            turn: state.currentTurn,
            kind: "prompt",
            text: state.created.prompt,
            images: state.created.images ?? [],
            status: "pending",
            seq: event.seq,
          },
        ],
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
      if (state.requests.some((item) => item.req === event.req) || state.created?.req === event.req)
        return next;
      const kind = event.kind === "prompt.requested" ? "prompt" : "interrupt";
      const valid =
        event.turn === state.currentTurn &&
        (state.phase === "running" ||
          (state.phase === "provisioning" &&
            (state.commit !== undefined || (state.created !== undefined && kind === "prompt"))) ||
          (state.phase === "stopped" && kind === "prompt"));
      const base = valid && state.phase === "stopped" ? resume(next, event.at) : next;
      const taken = valid && live(base);
      const request: Request =
        event.kind === "prompt.requested"
          ? {
              req: event.req,
              turn: event.turn,
              kind: "prompt",
              text: event.text,
              images: event.images,
              status: taken ? "pending" : "stale",
              seq: event.seq,
            }
          : {
              req: event.req,
              turn: event.turn,
              kind: "interrupt",
              status: taken ? "pending" : "stale",
              seq: event.seq,
            };
      return {
        ...base,
        activeAt: kind === "prompt" ? event.at : state.activeAt,
        requests: [...state.requests, request],
        pending:
          taken && base.ready
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
      if (event.req === undefined && event.code === "exit")
        return endAll(
          {
            ...advance(next, event.n),
            lastAckN: state.lastAckN,
            lastAckSeq: state.lastAckSeq,
          },
          event.at,
          "stopped",
          { reason: "agent" },
        );
      if (
        event.req === undefined &&
        event.code === threadGone &&
        !state.ready &&
        state.fromDisk &&
        state.place !== undefined
      )
        return replaced(next, event.at, state.place.handle);
      if (event.req === undefined && !state.ready)
        return endAll(
          {
            ...advance(next, event.n),
            lastAckN: state.lastAckN,
            lastAckSeq: state.lastAckSeq,
            failure: { code: event.code, retryable: true },
          },
          event.at,
          "failed",
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
      return state.turns.at(-1)?.turn === event.turn
        ? saved(state, { ...next, saved: next.saved || event.kind === "save.done" }, event.at)
        : event.kind === "save.done"
          ? { ...next, saved: true }
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
      if (!state.pending.some((item) => item.op === event.op && item.due <= event.at)) return next;
      if (event.op === "dial") return endAll(next, event.at, "stopped", { reason: "gone" });
      if (event.op === "container" || event.op === "workspace")
        return endAll(
          {
            ...next,
            failure: { code: `${event.op}_timeout`, retryable: true },
          },
          event.at,
          "failed",
        );
      if (event.op === "watch") return { ...next, pending: remove(state.pending, "watch") };
      if (event.op === "save") return saved(state, next, event.at);
      if (event.op === "pause")
        return state.place?.status === "pausing"
          ? {
              ...next,
              place: { ...state.place, seq: event.seq },
              pending: [
                ...remove(state.pending, "pause"),
                { op: "pause", due: event.at + deadlines.pause },
              ],
            }
          : { ...next, pending: remove(state.pending, "pause") };
      if (event.op === "idle")
        return { ...next, idleSeq: event.seq, pending: remove(state.pending, "idle") };
      if (event.op === "stalled") {
        const req = stallReq(state.currentTurn);
        if (stalled(state, state.currentTurn))
          return endAll(next, event.at, "stopped", { reason: "stalled" });
        return {
          ...next,
          requests: [
            ...state.requests,
            { req, turn: state.currentTurn, kind: "interrupt", status: "pending", seq: event.seq },
          ],
          pending: [
            ...addOnce(
              remove(state.pending, "stalled"),
              reqOp(req),
              event.at + deadlines.interrupt,
            ),
            { op: "stalled", due: event.at + deadlines.interrupt + deadlines.save },
          ],
        };
      }
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
      return resumable(state)
        ? resume({ ...next, activeAt: event.at, size: event.size ?? state.size }, event.at)
        : next;
    case "container.stopped":
      if (event.gen !== state.gen) return next;
      if (!live(state))
        return state.phase === "failed" && (event.reason === "user" || event.reason === "ended")
          ? stopPlace({ ...next, stopSeq: event.seq }, event.at, event.reason === "ended")
          : next;
      return event.reason !== "idle" ||
        (has(state.pending, "idle") &&
          (event.idleSeq === undefined || event.idleSeq === state.idleSeq))
        ? endAll(next, event.at, "stopped", {
            reason: event.reason ?? "gone",
            ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
            ...(event.max === undefined ? {} : { max: event.max }),
          })
        : next;
    case "active":
      return has(state.pending, "idle")
        ? {
            ...next,
            idleSeq: 0,
            pending: [
              ...remove(state.pending, "idle"),
              { op: "idle", due: event.at + idleWindow(state) },
            ],
          }
        : next;
    case "container.watched":
      return event.gen === state.gen && live(state)
        ? {
            ...next,
            pending: [
              ...remove(state.pending, "watch"),
              { op: "watch", due: event.at + deadlines.watch },
            ],
          }
        : next;
    case "failed":
      if (!live(state)) return next;
      return endAll(
        {
          ...next,
          activeAt: event.at,
          failure: { code: event.code, retryable: event.retryable },
        },
        event.at,
        "failed",
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
};

export const startStep: (
  state: State,
  input: {
    readonly req: string;
    readonly repo: string;
    readonly agent: string;
    readonly size?: typeof Size.Type;
    readonly place?: string;
    readonly prompt: string;
    readonly images?: readonly PromptImage[];
  },
) => "create" | "prompt" | "duplicate" | "unavailable" | "conflict" = function startStep(
  state,
  input,
) {
  const created = state.created;
  if (created === undefined) return "create";
  if (created.repo !== input.repo || created.agentKind !== input.agent) return "conflict";
  if (created.req === input.req)
    return created.prompt === input.prompt &&
      sameImages(created.images, input.images) &&
      (input.size === undefined || (created.size ?? defaultSize) === input.size) &&
      (input.place === undefined || (created.place ?? defaultPlace) === input.place)
      ? "duplicate"
      : "conflict";
  const seen = state.requests.find((item) => item.req === input.req);
  if (seen === undefined) return "prompt";
  if (
    seen.kind !== "prompt" ||
    seen.text !== input.prompt ||
    !sameImages(seen.images, input.images)
  )
    return "conflict";
  return seen.status === "pending" || seen.status === "delivered" || seen.status === "ended"
    ? "duplicate"
    : "unavailable";
};
