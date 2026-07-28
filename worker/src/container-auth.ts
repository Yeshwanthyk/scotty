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
- Use \`uv\` and \`uvx\` for Python. Use the repository's declared JavaScript package manager; use Corepack only when it declares Yarn or pnpm.
- If a required tool is absent or a dependency download is blocked by Scotty policy (including HTTP 520), stop after one bounded retry. Run the focused checks that are available and report the exact unavailable gate. If publication was requested, continue to commit, push, and open the PR so CI can run the locked full gate.
- Don't build a missing toolchain from source, install a third-party embedded toolchain, add temporary module replacements, or bypass the proxy with direct arbitrary-host downloads unless the user explicitly asks.
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
        const root = sessionRoot(id);
        yield* runtime.execChecked(
          `github_identity="$(gh api user)" && git_name="$(printf '%s' "$github_identity" | jq -r '.name // .login')" && git_email="$(printf '%s' "$github_identity" | jq -r 'if (.email // "") != "" then .email else "\\(.id)+\\(.login)@users.noreply.github.com" end')" && git -C ${shellQuote(root)} config user.name "$git_name" && git -C ${shellQuote(root)} config user.email "$git_email"`,
        );
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
    NODE_OPTIONS: "--use-system-ca",
    GOTOOLCHAIN: "auto",
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}
