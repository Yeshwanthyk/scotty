import { Schema } from "effect";

const sequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const acknowledgement = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const envelope = { gen: sequence, n: sequence };
const identifier = Schema.String.check(Schema.isMaxLength(256));
// TOML basic strings permit escaped controls but never lone UTF-16 surrogates.
const tomlString = Schema.String.check(
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/),
);
const credentialString = tomlString.check(
  Schema.makeFilter((value: string) =>
    Array.from(value).every((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && point > 31 && (point < 127 || point > 159);
    }),
  ),
);
const CodexAgent = Schema.Struct({
  kind: Schema.Literal("codex"),
  model: tomlString,
  effort: tomlString,
  baseUrl: credentialString,
  token: credentialString,
  accountId: credentialString,
});
export const AgentConfig = Schema.Union([CodexAgent]);
// n remains in the DO envelope for callers that number their sends; it is never
// used by the supervisor to deduplicate, order, or acknowledge commands.
export const ToSupervisor = Schema.Union([
  // Oversized frames and invalid reqs receive a req-less protocol error.
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("start"),
    repo: Schema.String,
    base: Schema.String,
    branch: Schema.String,
    agent: AgentConfig,
    git: Schema.Struct({ name: tomlString, email: tomlString }),
    resume: Schema.optionalKey(
      Schema.Struct({
        threadId: identifier,
        commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
      }),
    ),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("prompt"),
    req: identifier,
    turn: identifier,
    text: Schema.String,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("interrupt"), req: identifier }),
  Schema.Struct({ ...envelope, type: Schema.Literal("ack"), ack: acknowledgement }),
]);
export const FromSupervisor = Schema.Union([
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("hello"),
    version: Schema.String,
    boot: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("workspace_ready"),
    base: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("agent_ready"),
    kind: Schema.Literal("codex"),
    session: Schema.String,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("delivered"), req: Schema.String }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("agent"),
    kind: Schema.Literal("codex"),
    event: Schema.Unknown,
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("turn_end"),
    turn: Schema.String,
    codexTurn: Schema.String,
    state: Schema.Union([
      Schema.Literal("completed"),
      Schema.Literal("interrupted"),
      Schema.Literal("failed"),
    ]),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
    req: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("ack"), ack: acknowledgement }),
]);
export type ToSupervisorMessage = Schema.Schema.Type<typeof ToSupervisor>;
export type FromSupervisorMessage = Schema.Schema.Type<typeof FromSupervisor>;
