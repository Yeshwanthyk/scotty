import { Context, Effect, Layer } from "effect";
import type { SessionRecord } from "./contracts";
import { sentinelAuthJson, type StoredCredential } from "./egress";
import { SandboxRuntime, type SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

const CODEX_CONFIG = `[projects."/tmp"]
trust_level = "trusted"
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
        yield* runtime.mkdir(codexHome, { recursive: true });
        yield* runtime.writeFile(authPath, sentinelAuthJson(credential));
        yield* runtime.writeFile(configPath, CODEX_CONFIG);
        yield* runtime.execChecked(
          `chmod 700 ${shellQuote(codexHome)} && chmod 600 ${shellQuote(authPath)} ${shellQuote(configPath)}`,
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
