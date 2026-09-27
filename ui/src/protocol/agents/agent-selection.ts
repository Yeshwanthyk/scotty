import { Schema } from "effect";
import {
  CodexModelIdentifier,
  CodexReasoningEffort,
  supportsCodexModelSelection,
} from "./codex/codex-model-capabilities";
import { ClaudeModelIdentifier, ClaudeReasoningEffort } from "./claude/claude-model-capabilities";

export const CodexAgentSelectionSchema = Schema.Struct({
  agent: Schema.Literal("codex"),
  model: CodexModelIdentifier,
  effort: CodexReasoningEffort,
}).check(
  Schema.makeFilter(supportsCodexModelSelection, {
    expected: "a supported explicit Codex model and effort",
  }),
);
export const ClaudeAgentSelectionSchema = Schema.Struct({
  agent: Schema.Literal("claude"),
  model: ClaudeModelIdentifier,
  effort: ClaudeReasoningEffort,
});
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
/** Agents whose runtime is a Scotty sidecar speaking the generation-fenced control protocol. */
export const SidecarAgentSelectionSchema = Schema.Union([
  CodexAgentSelectionSchema,
  ClaudeAgentSelectionSchema,
]);
export const AgentSelectionSchema = Schema.Union([
  PiAgentSelectionSchema,
  ...SidecarAgentSelectionSchema.members,
]);
export type PiAgentSelection = typeof PiAgentSelectionSchema.Type;
export type CodexAgentSelection = typeof CodexAgentSelectionSchema.Type;
export type ClaudeAgentSelection = typeof ClaudeAgentSelectionSchema.Type;
export type AgentSelection = typeof AgentSelectionSchema.Type;
export type AgentId = AgentSelection["agent"];
export type SidecarAgentSelection = typeof SidecarAgentSelectionSchema.Type;
export const decodeAgentSelection = Schema.decodeUnknownResult(AgentSelectionSchema, {
  onExcessProperty: "error",
});
