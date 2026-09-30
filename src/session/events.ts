import { Schema } from "effect";

const envelope = { seq: Schema.Natural, at: Schema.Finite, src: Schema.String };
const fromSupervisor = {
  ...envelope,
  gen: Schema.Natural,
  n: Schema.Natural.check(Schema.isGreaterThan(0)),
};
export const AgentKind = Schema.Literals(["codex", "claude"]);
const ClientReq = Schema.String.check(Schema.isPattern(/^(?!initial:)/));
// Why a container stopped: the owner stopped it, it slept (idle) or was stopped for making no
// progress (stalled), it exited on its own (crashed with an exit code, or exited cleanly), a
// deploy replaced it, or it was found gone without a recorded exit.
export const StopReason = Schema.Literals([
  "user",
  "idle",
  "stalled",
  "crashed",
  "exited",
  "deploy",
  "gone",
]);
const TimeoutOp = Schema.Union([
  Schema.Literals(["container", "workspace", "dial", "redial", "save", "watch", "idle", "stalled"]),
  Schema.String.check(Schema.isPattern(/^req:/)),
]);

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
    image: Schema.String,
    // Runs the agent's scripted stand-in instead of the agent; only e2e asks for it.
    scripted: Schema.optionalKey(Schema.Literal(true)),
    // Milliseconds of idleness before the session sleeps, when shorter than the default.
    idleAfter: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
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
  Schema.Struct({
    ...envelope,
    kind: Schema.Literal("container.stopped"),
    gen: Schema.Natural,
    // Absent in logs written before stops recorded a reason.
    reason: Schema.optionalKey(StopReason),
    exitCode: Schema.optionalKey(Schema.Int),
  }),
  // The Session DO watches the running container for this generation until its watch deadline.
  Schema.Struct({ ...envelope, kind: Schema.Literal("container.watched"), gen: Schema.Natural }),
  Schema.Struct({ ...envelope, kind: Schema.Literal("resume.requested") }),
  // The owner used the session's terminal or a preview; it pushes back the idle deadline.
  Schema.Struct({ ...envelope, kind: Schema.Literal("active") }),
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
