import { Schema } from "effect";
import { PlaceKind } from "../places/place.js";

const envelope = { seq: Schema.Natural, at: Schema.Finite, src: Schema.String };
const fromSupervisor = {
  ...envelope,
  gen: Schema.Natural,
  n: Schema.Natural.check(Schema.isGreaterThan(0)),
};
export const AgentKind = Schema.Literals(["codex", "claude"]);
const ClientReq = Schema.String.check(Schema.isPattern(/^(?!initial:)/));
const TimeoutOp = Schema.Union([
  Schema.Literals(["container", "workspace", "dial", "redial", "save"]),
  Schema.String.check(Schema.isPattern(/^req:/)),
]);

// What started a session, when it was not a person in the UI or CLI without a key.
export const Origin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("hook"),
    connection: Schema.String,
    delivery: Schema.String,
    key: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("api"), key: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    automation: Schema.String,
    run: Schema.String,
    key: Schema.optionalKey(Schema.String),
  }),
]);
export type Origin = typeof Origin.Type;

export const SessionEvent = Schema.Union([
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("created"),
    agentKind: AgentKind,
    repo: Schema.String,
    baseBranch: Schema.String,
    branch: Schema.String,
    title: Schema.String,
    prompt: Schema.String,
    // The first prompt's request id, so a retried create is known as one. Absent in logs
    // written before creators named it: those used `initial:<gen>`.
    req: Schema.optionalKey(ClientReq),
    image: Schema.String,
    // Absent in logs written before places: those ran on Cloudflare.
    place: Schema.optionalKey(PlaceKind),
    // Runs the agent's scripted stand-in instead of the agent; only e2e asks for it.
    scripted: Schema.optionalKey(Schema.Literal(true)),
    origin: Schema.optionalKey(Origin),
  }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("container.start"), gen: Schema.Natural }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("sup.hello"),
    version: Schema.String,
    boot: Schema.String,
  }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("workspace.ready"),
    base: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
    // Absent in logs written before the supervisor reported them.
    ms: Schema.optionalKey(Schema.Number),
    retried: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("agent.ready"),
    agentKind: AgentKind,
    session: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("prompt.requested"),
    req: ClientReq,
    turn: Schema.String,
    text: Schema.String,
    images: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("prompt.delivered"),
    req: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("interrupt.requested"),
    req: ClientReq,
    turn: Schema.String,
  }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("agent.event"),
    agentKind: AgentKind,
    event: Schema.Json,
  }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("turn.ended"),
    turn: Schema.String,
    codexTurn: Schema.String,
    state: Schema.String,
  }),
  Schema.Struct({
    ...fromSupervisor,
    kind: Schema.Literal("sup.error"),
    code: Schema.String,
    message: Schema.String,
    req: Schema.optionalKey(Schema.String),
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
  Schema.Struct({ ...envelope, kind: Schema.Literal("container.stopped"), gen: Schema.Natural }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("resume.requested") }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("save.done"), turn: Schema.String }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("save.failed"),
    turn: Schema.String,
    code: Schema.String,
  }),
  // The bytes are already in R2 at files/<session>/<file> when this is written.
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("file.attached"),
    file: Schema.String,
    name: Schema.String,
    type: Schema.String,
    size: Schema.Natural,
    caption: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("invariant.violated"),
    code: Schema.String,
    detail: Schema.String,
  }),
]);
export type SessionEvent = typeof SessionEvent.Type;
export const decodeSessionEvent = Schema.decodeUnknownSync(SessionEvent);
