import { Schema } from "effect";

// A stage's model and reasoning effort for one agent.
export const AgentSettings = Schema.Struct({
  model: Schema.String,
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
});

export const defaultCodexSettings: typeof AgentSettings.Type = {
  model: "gpt-5.5",
  effort: "medium",
};

export const defaultClaudeSettings: typeof AgentSettings.Type = {
  model: "claude-opus-5-5",
  effort: "medium",
};
