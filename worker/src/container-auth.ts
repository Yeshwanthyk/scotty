import { Context, Effect, Layer } from "effect";
import type { SessionRecord } from "./contracts";
import { sentinelAuthJson, type StoredCredential } from "./egress";
import { SandboxRuntime, type SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

const codexConfig = (id: SessionRecord["id"]): string => `model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[features]
plugins = false

[mcp_servers]

[projects.${JSON.stringify(sessionRoot(id))}]
trust_level = "trusted"
`;

export const sandboxAgentsInstructions = `- Read and follow the repository AGENTS.md first; repository instructions override this file.
- Run \`scotty tools list --json\` to inspect the standard sandbox tools.
- Prefer \`rg\`, \`fd\`, and \`ast-grep\` for search. Use \`jq\`, \`yq\`, and \`qsv\` for structured data.
- Use \`uv\` and \`uvx\` for Python. Use Corepack and the repository's declared JavaScript package manager.
- Use matching skills under \`$CODEX_HOME/skills\`; read the selected \`SKILL.md\` before acting.
`;

interface ContainerAuthShape {
  readonly seed: (
    id: SessionRecord["id"],
    credential: StoredCredential,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
}

export class ContainerAuth extends Context.Service<ContainerAuth, ContainerAuthShape>()(
  "scotty/ContainerAuth",
) {}

export const containerAuthLayer: Layer.Layer<ContainerAuth, never, SandboxRuntime> = Layer.effect(
  ContainerAuth,
  Effect.map(SandboxRuntime, (runtime) =>
    ContainerAuth.of({
      seed: Effect.fnUntraced(function* (id, credential) {
        const codexHome = `${sessionRoot(id)}/.codex`;
        const authPath = `${codexHome}/auth.json`;
        const configPath = `${codexHome}/config.toml`;
        const agentsPath = `${codexHome}/AGENTS.md`;
        const skillsPath = `${codexHome}/skills`;
        yield* runtime.mkdir(codexHome, { recursive: true });
        yield* runtime.writeFile(authPath, sentinelAuthJson(credential));
        yield* runtime.writeFile(configPath, codexConfig(id));
        yield* runtime.writeFile(agentsPath, sandboxAgentsInstructions);
        yield* runtime.execChecked(
          `chmod 700 ${shellQuote(codexHome)} && chmod 600 ${shellQuote(authPath)} ${shellQuote(configPath)} ${shellQuote(agentsPath)} && ln -sfn /opt/scotty/skills ${shellQuote(skillsPath)}`,
        );
        yield* runtime.setEnvVars(agentEnv(id, credential));
      }),
    }),
  ),
);

export function agentEnv(
  id: SessionRecord["id"],
  credential: StoredCredential,
): Record<string, string> {
  return {
    CODEX_HOME: `${sessionRoot(id)}/.codex`,
    OPENAI_API_KEY: credential.codexSentinel,
    GH_TOKEN: credential.githubSentinel,
    GITHUB_SENTINEL: credential.githubSentinel,
    GIT_TERMINAL_PROMPT: "0",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}
