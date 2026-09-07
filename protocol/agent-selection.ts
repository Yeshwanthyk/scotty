import { Schema } from "effect";
import {
  CodexModelIdentifier,
  CodexReasoningEffort,
  supportsCodexModelSelection,
} from "./codex-model-capabilities";

export const CodexAgentSelectionSchema = Schema.Struct({
  agent: Schema.Literal("codex"),
  model: CodexModelIdentifier,
  effort: CodexReasoningEffort,
}).check(
  Schema.makeFilter(supportsCodexModelSelection, {
    expected: "a supported explicit Codex model and effort",
  }),
);
export const PiModelSettingSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\s\p{Cc}]+$/u),
);
export const PiReasoningEffortSchema = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const PiAgentSelectionSchema = Schema.Struct({
  agent: Schema.Literal("pi"),
  modelProvider: Schema.optionalKey(PiModelSettingSchema),
  model: Schema.optionalKey(PiModelSettingSchema),
  effort: Schema.optionalKey(PiReasoningEffortSchema),
});
export const AgentSelectionSchema = Schema.Union([
  PiAgentSelectionSchema,
  CodexAgentSelectionSchema,
]);
export type PiAgentSelection = typeof PiAgentSelectionSchema.Type;
export type AgentSelection = typeof AgentSelectionSchema.Type;
export const decodeAgentSelection = Schema.decodeUnknownResult(AgentSelectionSchema, {
  onExcessProperty: "error",
});
