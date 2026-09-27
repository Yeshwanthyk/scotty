import type { AgentKind, SessionEvent } from "./events.js";
import type { State, Request } from "./fold.js";
import { ackRecorded } from "./ack.js";

type Resend =
  | { readonly req: string; readonly kind: "prompt"; readonly turn: string; readonly text: string }
  | { readonly req: string; readonly kind: "interrupt"; readonly turn: string };

const toResend = (request: Request): Resend =>
  request.kind === "prompt"
    ? { req: request.req, kind: "prompt", turn: request.turn, text: request.text }
    : { req: request.req, kind: "interrupt", turn: request.turn };

export type Command =
  | { readonly kind: "container.start"; readonly gen: number }
  | { readonly kind: "dial"; readonly gen: number; readonly after: number }
  | {
      readonly kind: "start";
      readonly gen: number;
      readonly repo: string;
      readonly base: string;
      readonly branch: string;
      readonly agentKind: typeof AgentKind.Type;
    }
  | {
      readonly kind: "resend";
      readonly gen: number;
      readonly requests: readonly Resend[];
    }
  | { readonly kind: "ack"; readonly gen: number; readonly ack: number }
  | { readonly kind: "prompt"; readonly req: string; readonly turn: string; readonly text: string }
  | { readonly kind: "interrupt"; readonly req: string }
  | { readonly kind: "destroy" }
  | { readonly kind: "save"; readonly gen: number; readonly turn: string; readonly ack: number };

const ackFor = (
  state: State,
  output: { readonly gen: number; readonly n: number },
): Command | undefined =>
  ackRecorded(state, output) ? { kind: "ack", gen: output.gen, ack: output.n } : undefined;

export function command(state: State, event: SessionEvent): Command | undefined {
  if (state.lastSeq !== event.seq) return undefined;
  if (state.phase === "stopped")
    return state.stopSeq === event.seq ? { kind: "destroy" } : undefined;
  if (state.phase === "failed") return undefined;
  switch (event.kind) {
    case "container.start":
      return state.gen === event.gen && state.startSeq === event.seq
        ? { kind: "container.start", gen: event.gen }
        : undefined;
    case "sup.redial":
      return state.gen === event.gen
        ? state.hello
          ? { kind: "dial", gen: event.gen, after: state.lastN }
          : { kind: "container.start", gen: event.gen }
        : undefined;
    case "timeout":
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
          };
    case "workspace.ready": {
      const request = state.requests.find(
        (item) =>
          item.req === `initial:${event.gen}` &&
          item.seq === event.seq &&
          item.status === "pending",
      );
      return state.gen === event.gen && request?.kind === "prompt"
        ? { kind: "prompt", req: request.req, turn: request.turn, text: request.text }
        : ackFor(state, event);
    }
    case "prompt.requested":
      return state.connected &&
        state.requests.some(
          (item) => item.req === event.req && item.seq === event.seq && item.status === "pending",
        )
        ? { kind: "prompt", req: event.req, turn: event.turn, text: event.text }
        : undefined;
    case "interrupt.requested":
      return state.connected &&
        state.requests.some(
          (item) => item.req === event.req && item.seq === event.seq && item.status === "pending",
        )
        ? { kind: "interrupt", req: event.req }
        : undefined;
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
}
