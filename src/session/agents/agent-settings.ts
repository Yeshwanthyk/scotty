import { Config, Effect, Schema } from "effect";

// A stage's model and reasoning effort for one agent.
export const AgentSettings = Schema.Struct({
  model: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)),
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
});

export const defaultCodexSettings: typeof AgentSettings.Type = {
  model: "gpt-6.1-sol",
  effort: "medium",
};

export const defaultClaudeSettings: typeof AgentSettings.Type = {
  model: "claude-opus-5-5",
  effort: "medium",
};

export const AgentDefaults = Schema.Struct({
  agent: Schema.Literals(["codex", "claude"]),
  codex: AgentSettings,
  claude: AgentSettings,
});

// Owner choices take precedence over deployment defaults. Only new agent starts read them.
export const stageAgentDefaults = (saved: typeof AgentDefaults.Type | null) =>
  Effect.gen(function* () {
    if (saved !== null) return saved;
    const settings = (kind: "codex" | "claude", fallback: typeof AgentSettings.Type) =>
      Effect.gen(function* () {
        const prefix = kind === "codex" ? "SCOTTY_CODEX" : "SCOTTY_CLAUDE";
        return yield* Schema.decodeUnknownEffect(AgentSettings)({
          model: yield* Config.String(`${prefix}_MODEL`).pipe(Config.withDefault(fallback.model)),
          effort: yield* Config.String(`${prefix}_EFFORT`).pipe(
            Config.withDefault(fallback.effort),
          ),
        });
      });
    return {
      agent: "codex" as const,
      codex: yield* settings("codex", defaultCodexSettings),
      claude: yield* settings("claude", defaultClaudeSettings),
    };
  });
