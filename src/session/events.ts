import { Schema } from "effect";

const envelope = { seq: Schema.Natural, at: Schema.Finite, src: Schema.String };
export const AgentKind = Schema.Literals(["codex"]);
const ClientReq = Schema.String.check(Schema.isPattern(/^(?!initial:)/));
const TimeoutOp = Schema.Union([
  Schema.Literals(["container", "workspace", "dial", "redial"]),
  Schema.String.check(Schema.isPattern(/^req:/)),
]);

export const SessionEvent = Schema.Union([
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("created"),
    agentKind: AgentKind,
    repo: Schema.String,
    baseBranch: Schema.String,
    title: Schema.String,
    prompt: Schema.String,
    image: Schema.String,
  }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("container.start"), gen: Schema.Natural }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("sup.hello"),
    gen: Schema.Natural,
    version: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("workspace.ready"),
    gen: Schema.Natural,
    branch: Schema.String,
    commit: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("prompt.requested"),
    req: ClientReq,
    turn: Schema.String,
    text: Schema.String,
    images: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("prompt.delivered"), req: Schema.String }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("interrupt.requested"),
    req: ClientReq,
    turn: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("agent.event"),
    agentKind: AgentKind,
    gen: Schema.Natural,
    n: Schema.Natural,
    event: Schema.Json,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("turn.ended"),
    gen: Schema.Natural,
    turn: Schema.String,
    state: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("failed"),
    phase: Schema.String,
    code: Schema.String,
    retryable: Schema.Boolean,
  }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("timeout"), op: TimeoutOp }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("socket.closed"), gen: Schema.Natural }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("dial.failed"), gen: Schema.Natural }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("sup.redial"), gen: Schema.Natural }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("invariant.violated"),
    code: Schema.String,
    detail: Schema.String,
  }),
]);
export type SessionEvent = typeof SessionEvent.Type;
export const decodeSessionEvent = Schema.decodeUnknownSync(SessionEvent);
