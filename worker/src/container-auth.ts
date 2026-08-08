import { Context, Effect, Layer } from "effect";
import type { SessionRecord } from "./contracts";
import { sha256Hex } from "./digest";
import { piAuthJson, type StoredCredential } from "./egress";
import { SandboxRuntime, SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

export const PI_PACKAGES = [
  "/opt/scotty/pi-packages/sources/pi-tasks",
  "/opt/scotty/pi-packages/sources/pi-subagents",
  "/opt/scotty/pi-packages/sources/pi-workflows",
  "/opt/scotty/pi-packages/sources/pi-background-terminals",
  "/opt/scotty/pi-packages/sources/pi-askuser",
  "/opt/scotty/pi-packages/sources/pi-web-access",
  "/opt/scotty/pi-packages/npm/node_modules/@ogulcancelik/pi-codex-compaction",
  "/opt/scotty/pi-packages/sources/pi-amp-ui",
  "/opt/scotty/pi-packages/sources/scotty-browser-test",
  "/opt/scotty/pi-packages/sources/scotty-hatch",
] as const;

export const PI_SESSION_PORT = 43_117;
export const PI_SESSION_PROCESS_ID = "scotty-pi-session";
export const PI_SESSION_TOKEN_HEADER = "x-scotty-pi-session";

const piSessionTokenPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.pi-agent/scotty-pi-session.token`;

export const piSessionTransportToken = (
  id: SessionRecord["id"],
  credential: StoredCredential,
): Promise<string> => sha256Hex(`scotty-pi-session-v1\0${id}\0${credential.githubToken}`);

const derivePiSessionTransportToken = (
  id: SessionRecord["id"],
  credential: StoredCredential,
): Effect.Effect<string, SandboxRuntimeFailure> =>
  Effect.tryPromise({
    try: () => piSessionTransportToken(id, credential),
    catch: () =>
      new SandboxRuntimeFailure({
        reason: "transport",
        message: "Pi session capability derivation failed",
      }),
  });

const codexConfig = (id: SessionRecord["id"]): string => `model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[features]
plugins = false

[mcp_servers]

[projects.${JSON.stringify(sessionRoot(id))}]
trust_level = "trusted"
`;

const piSettings = (credential: StoredCredential): string =>
  JSON.stringify({
    defaultProvider: credential.providers["openai-codex"] ? "openai-codex" : "openai",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "high",
    steeringMode: "one-at-a-time",
    theme: "dark",
    hideThinkingBlock: false,
    quietStartup: true,
    defaultProjectTrust: "always",
    compaction: {
      enabled: true,
      reserveTokens: 40960,
      keepRecentTokens: 20000,
    },
    packages: PI_PACKAGES,
  });

const piWebSearchConfig = JSON.stringify({
  provider: "openai",
  workflow: "none",
  allowBrowserCookies: false,
});

const gitConfig = (): string => `[credential]
	helper = !f() { echo username=x-access-token; echo password=$GITHUB_SENTINEL; }; f
	useHttpPath = true
`;

export const terminalShellPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.pi-agent/scotty-shell`;

const terminalShell = (id: SessionRecord["id"], credential: StoredCredential): string => {
  const exports = Object.entries(agentEnv(id, credential))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  return `#!/usr/bin/env bash
set -euo pipefail

${exports}

exec /usr/local/bin/scotty-pi-shell
`;
};

export const sandboxAgentsInstructions = `- Read and follow the repository AGENTS.md first; repository instructions override this file.
- Run \`scotty tools list --json\` to inspect the standard sandbox tools.
- Prefer \`rg\`, \`fd\`, and \`ast-grep\` for search. Use \`jq\`, \`yq\`, and \`qsv\` for structured data.
- Use \`uv\` and \`uvx\` for Python. Use the repository's declared JavaScript package manager; use Corepack only when it declares Yarn or pnpm.
- If a required tool is absent or a dependency download is blocked by Scotty policy (including HTTP 520), stop after one bounded retry. Run the focused checks that are available and report the exact unavailable gate. If publication was requested, continue to commit, push, and open the PR so CI can run the locked full gate.
- Don't build a missing toolchain from source, install a third-party embedded toolchain, add temporary module replacements, or bypass the proxy with direct arbitrary-host downloads unless the user explicitly asks.
- Use matching skills under \`$PI_CODING_AGENT_DIR/skills\` or \`$CODEX_HOME/skills\`; read the selected \`SKILL.md\` before acting.
`;

export interface ContainerAuthSeedOptions {
  readonly initialPrompt?: string;
}

interface ContainerAuthShape {
  readonly seed: (
    id: SessionRecord["id"],
    credential: StoredCredential,
    options?: ContainerAuthSeedOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly ensureTerminal: (
    id: SessionRecord["id"],
    credential: StoredCredential,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly ensurePiSession: (
    id: SessionRecord["id"],
    credential: StoredCredential,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly quiescePiSession: (
    id: SessionRecord["id"],
    credential: StoredCredential,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly stopPiSession: () => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly refreshPiAuth: (
    id: SessionRecord["id"],
    credential: StoredCredential,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
}

export class ContainerAuth extends Context.Service<ContainerAuth, ContainerAuthShape>()(
  "scotty/ContainerAuth",
) {}

export const containerAuthLayer: Layer.Layer<ContainerAuth, never, SandboxRuntime> = Layer.effect(
  ContainerAuth,
  Effect.map(SandboxRuntime, (runtime) => {
    const refreshPiAuth = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      credential: StoredCredential,
    ) {
      const piHome = `${sessionRoot(id)}/.pi-agent`;
      const authPath = `${piHome}/auth.json`;
      const settingsPath = `${piHome}/settings.json`;
      yield* runtime.mkdir(piHome, { recursive: true });
      yield* runtime.writeFile(authPath, piAuthJson(credential));
      yield* runtime.writeFile(settingsPath, piSettings(credential));
      yield* runtime.execChecked(`chmod 600 ${shellQuote(authPath)} ${shellQuote(settingsPath)}`);
    });
    const seed = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      credential: StoredCredential,
      options?: ContainerAuthSeedOptions,
    ) {
      const codexHome = `${sessionRoot(id)}/.codex`;
      const piHome = `${sessionRoot(id)}/.pi-agent`;
      const configPath = `${codexHome}/config.toml`;
      const agentsPath = `${codexHome}/AGENTS.md`;
      const skillsPath = `${codexHome}/skills`;
      const piAuthPath = `${piHome}/auth.json`;
      const piSettingsPath = `${piHome}/settings.json`;
      const piAgentsPath = `${piHome}/AGENTS.md`;
      const piSkillsPath = `${piHome}/skills`;
      const piWebSearchPath = `${piHome}/web-search.json`;
      const gitConfigPath = `${piHome}/gitconfig`;
      const shellPath = terminalShellPath(id);
      const promptPath = `${piHome}/initial-prompt`;
      yield* runtime.mkdir(codexHome, { recursive: true });
      yield* runtime.mkdir(piHome, { recursive: true });
      yield* runtime.writeFile(configPath, codexConfig(id));
      yield* runtime.writeFile(agentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(piAuthPath, piAuthJson(credential));
      yield* runtime.writeFile(piSettingsPath, piSettings(credential));
      yield* runtime.writeFile(piAgentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(piWebSearchPath, piWebSearchConfig);
      yield* runtime.writeFile(gitConfigPath, gitConfig());
      yield* runtime.writeFile(shellPath, terminalShell(id, credential));
      if (options?.initialPrompt !== undefined)
        yield* runtime.writeFile(promptPath, options.initialPrompt);
      yield* runtime.execChecked(
        `chmod 700 ${shellQuote(codexHome)} ${shellQuote(piHome)} ${shellQuote(shellPath)} && chmod 600 ${shellQuote(configPath)} ${shellQuote(agentsPath)} ${shellQuote(piAuthPath)} ${shellQuote(piSettingsPath)} ${shellQuote(piAgentsPath)} ${shellQuote(piWebSearchPath)} ${shellQuote(gitConfigPath)} && ln -sfn /opt/scotty/skills ${shellQuote(skillsPath)} && ln -sfn /opt/scotty/skills ${shellQuote(piSkillsPath)}`,
      );
      yield* runtime.setEnvVars(agentEnv(id, credential));
      const root = sessionRoot(id);
      yield* runtime.execChecked(
        `github_identity="$(gh api user)" && git_name="$(printf '%s' "$github_identity" | jq -r '.name // .login')" && git_email="$(printf '%s' "$github_identity" | jq -r 'if (.email // "") != "" then .email else "\\(.id)+\\(.login)@users.noreply.github.com" end')" && git -C ${shellQuote(root)} config user.name "$git_name" && git -C ${shellQuote(root)} config user.email "$git_email"`,
      );
    });
    return ContainerAuth.of({
      seed,
      ensureTerminal: Effect.fnUntraced(function* (id, credential) {
        const existing = yield* runtime.exec(`test -x ${shellQuote(terminalShellPath(id))}`);
        if (existing.success) return;
        yield* seed(id, credential);
      }),
      ensurePiSession: Effect.fnUntraced(function* (id, credential) {
        const existing = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (existing?.status === "starting" || existing?.status === "running") {
          yield* existing.waitForPort(PI_SESSION_PORT, {
            path: "/health",
            status: 200,
            timeout: 30_000,
          });
          return;
        }
        yield* refreshPiAuth(id, credential);
        const transportToken = yield* derivePiSessionTransportToken(id, credential);
        const tokenPath = piSessionTokenPath(id);
        yield* runtime.writeFile(tokenPath, transportToken);
        yield* runtime.execChecked(`chmod 600 ${shellQuote(tokenPath)}`);
        const process = yield* runtime.startProcess("/usr/local/bin/scotty-pi-session", {
          autoCleanup: true,
          cwd: sessionRoot(id),
          env: {
            ...agentEnv(id, credential),
            SCOTTY_PI_SESSION_PORT: String(PI_SESSION_PORT),
            SCOTTY_PI_SESSION_TOKEN_FILE: tokenPath,
            SCOTTY_WORKSPACE: sessionRoot(id),
          },
          processId: PI_SESSION_PROCESS_ID,
        });
        yield* process.waitForPort(PI_SESSION_PORT, {
          path: "/health",
          status: 200,
          timeout: 30_000,
        });
        const healthStatus = yield* runtime.fetchPortStatus("/health", PI_SESSION_PORT, "GET");
        if (healthStatus !== 200)
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Pi session mapped port health check failed",
          });
      }),
      quiescePiSession: Effect.fnUntraced(function* (id, credential) {
        const process = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (
          process === null ||
          process.status === "completed" ||
          process.status === "failed" ||
          process.status === "killed" ||
          process.status === "error"
        )
          return;
        const transportToken = yield* derivePiSessionTransportToken(id, credential);
        const status = yield* runtime.fetchPortStatus("/quiesce", PI_SESSION_PORT, "POST", {
          [PI_SESSION_TOKEN_HEADER]: transportToken,
        });
        if (status !== 200)
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Pi session quiesce failed",
          });
      }),
      stopPiSession: Effect.fnUntraced(function* () {
        const process = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (
          process === null ||
          process.status === "completed" ||
          process.status === "failed" ||
          process.status === "killed" ||
          process.status === "error"
        )
          return;
        yield* process.kill("SIGTERM");
        yield* process.waitForExit(10_000);
      }),
      refreshPiAuth,
    });
  }),
);

export function agentEnv(
  id: SessionRecord["id"],
  credential: StoredCredential,
): Record<string, string> {
  return {
    CODEX_HOME: `${sessionRoot(id)}/.codex`,
    PI_CODING_AGENT_DIR: `${sessionRoot(id)}/.pi-agent`,
    SCOTTY_SESSION_ID: id,
    GIT_CONFIG_GLOBAL: `${sessionRoot(id)}/.pi-agent/gitconfig`,
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
