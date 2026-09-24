import { Schema } from "effect";

// Claude Code resolves aliases ("opus", "sonnet") and full model IDs itself, so Scotty
// validates shape only instead of pinning a catalog that would go stale between images.
export const ClaudeModelIdentifier = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.[\]_-]*$/u),
  Schema.isMaxLength(128),
);
// Exactly the Agent SDK EffortLevel union pinned by worker/container/claude-server-build.
export const ClaudeReasoningEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export const CLAUDE_AGENT_SDK_VERSION = "0.3.281";
