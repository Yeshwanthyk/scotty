import { Schema } from "effect";

export const CodexModelIdentifier = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
  Schema.isMaxLength(128),
);
export const CodexReasoningEffort = Schema.Literals([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const CodexModelCapability = Schema.Struct({
  slug: CodexModelIdentifier,
  efforts: Schema.NonEmptyArray(CodexReasoningEffort),
  toolMode: Schema.NullOr(Schema.Literal("code_mode_only")),
});

// Exact minimal projection of rust-v0.153.4 models-manager/models.json at commit
// 3d2ee51ca2d5db578f328aa75e20aa22c0197c9a. Regenerate by projecting each model's
// slug, supported_reasoning_levels[].effort, and tool_type ("code_mode" maps to
// "code_mode_only"), then compare the result with this catalog. The complete Linux
// package installed by worker/container/Dockerfile is independently SHA-256 pinned.
export const codexModelCapabilities: ReadonlyArray<typeof CodexModelCapability.Type> = [
  {
    slug: "gpt-6-astra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    toolMode: "code_mode_only",
  },
  {
    slug: "gpt-5.6-sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    toolMode: "code_mode_only",
  },
  {
    slug: "gpt-5.6-terra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    toolMode: "code_mode_only",
  },
  {
    slug: "gpt-5.6-luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    toolMode: "code_mode_only",
  },
  {
    slug: "gpt-daybreak-blue-latest",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    toolMode: "code_mode_only",
  },
  {
    slug: "gpt-daybreak-red-latest",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    toolMode: "code_mode_only",
  },
  { slug: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"], toolMode: null },
  { slug: "gpt-5.4", efforts: ["low", "medium", "high", "xhigh"], toolMode: null },
  { slug: "gpt-5.4-mini", efforts: ["low", "medium", "high", "xhigh"], toolMode: null },
  { slug: "gpt-5.2", efforts: ["low", "medium", "high", "xhigh"], toolMode: null },
  {
    slug: "codex-auto-review",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    toolMode: "code_mode_only",
  },
];
export const codexModelCapability = (model: string) =>
  codexModelCapabilities.find((capability) => capability.slug === model);
export const supportsCodexModelSelection = (selection: {
  readonly model: string;
  readonly effort: typeof CodexReasoningEffort.Type;
}) => codexModelCapability(selection.model)?.efforts.includes(selection.effort) === true;
