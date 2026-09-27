import { Schema } from "effect";
import type { AgentId, AgentSelection, SidecarAgentSelection } from "./agent-selection";

export const AgentIdSchema = Schema.Literals(["pi", "codex", "claude"]);
export const CredentialProviderSchema = Schema.Literals(["openai", "anthropic", "github"]);
export type CredentialProvider = typeof CredentialProviderSchema.Type;
export type ModelCredentialProvider = Exclude<CredentialProvider, "github">;

interface AgentDescriptor {
  readonly label: string;
  /** Model credential this agent requires. GitHub is granted to every agent when present. */
  readonly provider: ModelCredentialProvider;
  readonly runtime: "pi-rpc" | "sidecar";
}

export const agentDescriptors: { readonly [Agent in AgentId]: AgentDescriptor } = {
  pi: { label: "Pi", provider: "openai", runtime: "pi-rpc" },
  codex: { label: "Codex", provider: "openai", runtime: "sidecar" },
  claude: { label: "Claude Code", provider: "anthropic", runtime: "sidecar" },
};

export const agentProvider = (agent: AgentId): ModelCredentialProvider =>
  agentDescriptors[agent].provider;

export const isSidecarSelection = (selection: AgentSelection): selection is SidecarAgentSelection =>
  agentDescriptors[selection.agent].runtime === "sidecar";
