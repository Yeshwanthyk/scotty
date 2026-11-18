import type { PromptImage } from "../../protocol/prompt.js";
import type { AgentKind, SessionEvent } from "./events.js";
import type { State, Request } from "./fold.js";
import { ackRecorded } from "./ack.js";
import { firstReq, live } from "./state.js";

type Resend =
  | {
      readonly req: string;
      readonly kind: "prompt";
      readonly turn: string;
      readonly text: string;
      readonly images?: readonly PromptImage[];
    }
  | { readonly req: string; readonly kind: "interrupt"; readonly turn: string };

const toResend: (request: Request) => Resend = (request) =>
  request.kind === "prompt"
    ? {
        req: request.req,
        kind: "prompt",
        turn: request.turn,
        text: request.text,
        images: request.images ?? [],
      }
    : { req: request.req, kind: "interrupt", turn: request.turn };

export type Command =
  | { readonly kind: "create"; readonly gen: number; readonly remove?: string }
  | { readonly kind: "resume"; readonly gen: number; readonly handle: string }
  | { readonly kind: "connect"; readonly gen: number }
  | { readonly kind: "pause"; readonly handle: string }
  | { readonly kind: "remove"; readonly handle: string }
  | { readonly kind: "release" }
  | { readonly kind: "check"; readonly handle: string }
  | { readonly kind: "discard"; readonly handle: string }
  | { readonly kind: "dial"; readonly gen: number; readonly after: number }
  | {
      readonly kind: "start";
      readonly gen: number;
      readonly repo: string;
      readonly base: string;
      readonly branch: string;
      readonly agentKind: typeof AgentKind.Type;
      readonly scripted?: true;
      readonly resume?: { readonly threadId: string; readonly commit: string };
      readonly fromDisk?: true;
    }
  | {
      readonly kind: "resend";
      readonly gen: number;
      readonly requests: readonly Resend[];
    }
  | { readonly kind: "ack"; readonly gen: number; readonly ack: number }
  | {
      readonly kind: "prompt";
      readonly req: string;
      readonly turn: string;
      readonly text: string;
      readonly images?: readonly PromptImage[];
    }
  | { readonly kind: "interrupt"; readonly req: string }
  | { readonly kind: "watch"; readonly gen: number }
  | { readonly kind: "idle"; readonly gen: number; readonly seq: number }
  | { readonly kind: "save"; readonly gen: number; readonly turn: string; readonly ack: number };

const ackFor: (
  state: State,
  output: { readonly gen: number; readonly n: number },
) => Command | undefined = (state, output) =>
  ackRecorded(state, output) ? { kind: "ack", gen: output.gen, ack: output.n } : undefined;

const wake: (state: State, gen: number) => Command | undefined = (state, gen) => {
  const place = state.place;
  if (place === undefined)
    return {
      kind: "create",
      gen,
      ...(state.gone === undefined ? {} : { remove: state.gone.handle }),
    };
  if (place.status === "pausing") return undefined;
  return place.status === "live" && place.gen === gen
    ? { kind: "connect", gen }
    : { kind: "resume", gen, handle: place.handle };
};

const stopping: (state: State, seq: number) => Command = (state, seq) => {
  if (state.place?.status === "pausing" && state.place.seq === seq)
    return { kind: "pause", handle: state.place.handle };
  return state.gone?.seq === seq
    ? { kind: "remove", handle: state.gone.handle }
    : { kind: "release" };
};

export const command: (state: State, event: SessionEvent) => Command | undefined = function command(
  state,
  event,
) {
  if (state.lastSeq !== event.seq) return undefined;
  if (!live(state) && state.stopSeq === event.seq) return stopping(state, event.seq);
  switch (event.kind) {
    case "place.created":
      if (state.place?.handle !== event.handle) return { kind: "discard", handle: event.handle };
      return state.place.status === "pausing" && state.place.seq === event.seq
        ? { kind: "pause", handle: event.handle }
        : undefined;
    case "place.paused":
    case "place.gone":
      return live(state) &&
        state.gen !== undefined &&
        !state.hello &&
        (state.place?.seq === event.seq || state.gone?.seq === event.seq)
        ? wake(state, state.gen)
        : undefined;
    case "timeout":
      if (event.op === "pause")
        return state.place?.status === "pausing" && state.place.seq === event.seq
          ? { kind: "check", handle: state.place.handle }
          : undefined;
  }
  if (!live(state)) return undefined;
  if (state.gen !== undefined && state.startSeq === event.seq) return wake(state, state.gen);
  switch (event.kind) {
    case "sup.redial":
      return state.gen === event.gen
        ? state.hello
          ? { kind: "dial", gen: event.gen, after: state.lastN }
          : wake(state, event.gen)
        : undefined;
    case "timeout":
      if (event.op === "watch" && state.gen !== undefined) return { kind: "watch", gen: state.gen };
      if (event.op === "idle")
        return state.gen !== undefined && state.idleSeq === event.seq
          ? { kind: "idle", gen: state.gen, seq: event.seq }
          : undefined;
      if (event.op === "stalled") {
        const stall = state.requests.find(
          (item) =>
            item.seq === event.seq && item.kind === "interrupt" && item.status === "pending",
        );
        return stall !== undefined && state.ready && state.connected
          ? { kind: "interrupt", req: stall.req }
          : undefined;
      }
      return event.op === "redial" &&
        state.gen !== undefined &&
        !state.connected &&
        state.lastRedialSeq === event.seq
        ? { kind: "dial", gen: state.gen, after: state.lastN }
        : undefined;
    case "sup.hello":
      if (state.gen !== event.gen || !state.connected || state.lastHelloSeq !== event.seq)
        return undefined;
      if (state.ready)
        return {
          kind: "resend",
          gen: event.gen,
          requests: state.requests.filter((item) => item.status === "pending").map(toResend),
        };
      return state.created === undefined
        ? undefined
        : {
            kind: "start",
            gen: event.gen,
            repo: state.created.repo,
            base: state.created.baseBranch,
            branch: state.created.branch,
            agentKind: state.created.agentKind,
            ...(state.created.scripted === true ? { scripted: true } : {}),
            ...(state.agentSession !== undefined && state.commit !== undefined
              ? { resume: { threadId: state.agentSession, commit: state.commit } }
              : {}),
            ...(state.fromDisk ? { fromDisk: true } : {}),
          };
    case "workspace.ready": {
      const request = state.requests.find(
        (item) =>
          state.created !== undefined &&
          item.req === firstReq(state.created, event.gen) &&
          item.seq === event.seq &&
          item.status === "pending",
      );
      const waiting = state.requests.filter((item) => item.status === "pending");
      if (state.gen === event.gen && request?.kind === "prompt")
        return waiting.length > 1
          ? {
              kind: "resend",
              gen: event.gen,
              requests: [request, ...waiting.filter((item) => item !== request)].map(toResend),
            }
          : {
              kind: "prompt",
              req: request.req,
              turn: request.turn,
              text: request.text,
              images: request.images ?? [],
            };
      return state.gen === event.gen && state.readySeq === event.seq && waiting.length > 0
        ? { kind: "resend", gen: event.gen, requests: waiting.map(toResend) }
        : ackFor(state, event);
    }
    case "prompt.requested":
      return state.ready &&
        state.connected &&
        state.requests.some(
          (item) => item.req === event.req && item.seq === event.seq && item.status === "pending",
        )
        ? {
            kind: "prompt",
            req: event.req,
            turn: event.turn,
            text: event.text,
            images: event.images,
          }
        : undefined;
    case "interrupt.requested":
      return state.ready &&
        state.connected &&
        state.requests.some(
          (item) => item.req === event.req && item.seq === event.seq && item.status === "pending",
        )
        ? { kind: "interrupt", req: event.req }
        : undefined;
    case "workspace.prepared":
    case "agent.ready":
    case "agent.event":
    case "prompt.delivered":
    case "sup.error":
      return ackFor(state, event);
    case "turn.ended":
      return state.saveSeq === event.seq && ackRecorded(state, event)
        ? { kind: "save", gen: event.gen, turn: event.turn, ack: event.n }
        : ackFor(state, event);
    default:
      return undefined;
  }
};
