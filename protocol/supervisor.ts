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
// The token is Claude's setup token; it goes only into the Claude process's environment.
const ClaudeAgent = Schema.Struct({
  kind: Schema.Literal("claude"),
  model: Schema.String,
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  token: credentialString,
});
// e2e sessions run an agent's scripted stand-in (container/scripted/): no token.
const ScriptedCodexAgent = Schema.Struct({
  kind: Schema.Literal("codex"),
  scripted: Schema.Literal(true),
  model: tomlString,
});
const ScriptedClaudeAgent = Schema.Struct({
  kind: Schema.Literal("claude"),
  scripted: Schema.Literal(true),
  model: Schema.String,
});
export const AgentConfig = Schema.Union([
  CodexAgent,
  ScriptedCodexAgent,
  ClaudeAgent,
  ScriptedClaudeAgent,
]);
const Kind = Schema.Literals(["codex", "claude"]);
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
    // Preview URL for a port in this session, with `{port}` to fill in.
    hatch: Schema.String,
    // The owner's instructions, appended to Scotty's; skills already PUT to /skill.
    instructions: Schema.String,
    skills: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))),
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
    ms: Schema.Number,
    retried: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("agent_ready"),
    kind: Kind,
    session: Schema.String,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("delivered"), req: Schema.String }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("agent"),
    kind: Kind,
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

// The supervisor protocol this image speaks. container/Dockerfile's `scotty.supervisor` label
// carries the same value, so an image built FROM ours can be checked before a deploy.
export const supervisorVersion = "1";

// A repository baked into the container image, so e2e sessions don't depend on GitHub. GitHub
// owner names cannot contain "_", so no real repository has this name.
export const fixtureRepo = "_scotty/fixture";
