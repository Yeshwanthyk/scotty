import { Schema } from "effect";

export const CodexSettings = Schema.Struct({
  model: Schema.String,
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
});

export const defaultCodexSettings: typeof CodexSettings.Type = {
  model: "gpt-5.5",
  effort: "medium",
};
