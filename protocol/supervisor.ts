import { PromptImages } from "./prompt.js";
import { Schema } from "effect";

const sequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const acknowledgement = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const envelope = { gen: sequence, n: sequence };
const identifier = Schema.String.check(Schema.isMaxLength(256));
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
const mcp = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/)),
      url: Schema.String.check(
        Schema.isPattern(/^http:\/\/[a-z0-9][a-z0-9-]{0,39}\.internal\/api\/mcp$/),
      ),
    }),
  ),
);
const skillName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const skillsOff = Schema.optionalKey(Schema.Array(skillName));
const style = Schema.optionalKey(skillName);
const CodexAgent = Schema.Struct({
  kind: Schema.Literal("codex"),
  mcp,
  skillsOff,
  model: tomlString,
  effort: tomlString,
  baseUrl: credentialString,
  token: credentialString,
  accountId: credentialString,
});
const ClaudeAgent = Schema.Struct({
  kind: Schema.Literal("claude"),
  mcp,
  skillsOff,
  style,
  model: Schema.String,
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  token: credentialString,
});
const ScriptedCodexAgent = Schema.Struct({
  kind: Schema.Literal("codex"),
  mcp,
  skillsOff,
  scripted: Schema.Literal(true),
  model: tomlString,
});
const ScriptedClaudeAgent = Schema.Struct({
  kind: Schema.Literal("claude"),
  mcp,
  skillsOff,
  style,
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
export const ToSupervisor = Schema.Union([
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("start"),
    repo: Schema.String,
    base: Schema.String,
    branch: Schema.String,
    agent: AgentConfig,
    git: Schema.Struct({ name: tomlString, email: tomlString }),
    hatch: Schema.String,
    instructions: Schema.String,
    skills: Schema.Array(
      Schema.Struct({
        commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
        path: Schema.String.check(
          Schema.isPattern(
            /^(?:(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+)*)?$/,
          ),
        ),
      }),
    ),
    resume: Schema.optionalKey(
      Schema.Struct({
        threadId: identifier,
        commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
      }),
    ),
    tunnel: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("prompt"),
    req: identifier,
    turn: identifier,
    text: Schema.String,
    images: Schema.optionalKey(PromptImages),
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("interrupt"), req: identifier }),
  Schema.Struct({ ...envelope, type: Schema.Literal("ack"), ack: acknowledgement }),
]);
export const Workspace = Schema.Struct({
  session: identifier,
  branch: Schema.String,
  base: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  thread: identifier,
});
export type Workspace = typeof Workspace.Type;
export const StartupTiming = Schema.Struct({
  processOriginEstimate: Schema.Finite,
  listeningAt: Schema.Finite,
  listeningAgeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  helloAgeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const FromSupervisor = Schema.Union([
  Schema.Struct({ ...envelope, type: Schema.Literal("workspace_prepared") }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("hello"),
    version: Schema.String,
    boot: Schema.String,
    workspace: Schema.optionalKey(Workspace),
    startup: Schema.optionalKey(StartupTiming),
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

export const Terminals = Schema.Struct({ open: Schema.Natural });

export const supervisorVersion = "1";

export const threadGone = "thread_gone";

export const supervisorAuthHeader = "x-scotty-auth";

export const fixtureRepo = "_scotty/fixture";
