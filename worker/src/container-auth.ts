import { Context, Effect, Layer } from "effect";
import type { PiSettings, SandboxToolCommand } from "../../protocol/sandbox-config";
import type { PiSessionTransportToken, SessionRecord } from "./contracts";
import {
  isSessionEnvironmentSnapshot,
  type PersistedSessionEnvironmentSnapshot,
  type SessionEnvironmentSnapshot,
} from "./environment-contracts";
import { environmentNameIsMaterializable, environmentNameIsReserved } from "./environment-policy";
import { SandboxRuntime, SandboxRuntimeFailure, shellQuote } from "./sandbox-runtime";
import { sessionRoot } from "./workspace";

export const PI_PACKAGES = [
  "/opt/scotty/pi-packages/sources/scotty-browser-test",
  "/opt/scotty/pi-packages/sources/scotty-hatch",
] as const;

export const PI_SESSION_PORT = 43_117;
export const PI_SESSION_PROCESS_ID = "scotty-pi-session";
export const PI_SESSION_TOKEN_HEADER = "x-scotty-pi-session";

const piSessionTokenPath = (id: SessionRecord["id"]): string =>
  `/tmp/scotty-pi-session-${id}.token`;

export const mergedSkillsPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.scotty/merged-skills`;

const extraSkillLinkCommand = (target: string, source: string): string =>
  `{ [ ! -e ${shellQuote(target)} ] || [ "$(readlink ${shellQuote(target)})" = ${shellQuote(source)} ]; } && ln -sfn ${shellQuote(source)} ${shellQuote(target)}`;

const piSettings = (
  settings: PiSettings,
  extensionPaths: ReadonlyArray<string>,
  skillPaths: ReadonlyArray<{ readonly path: string }>,
): string =>
  JSON.stringify({
    ...settings,
    defaultProjectTrust: "never",
    packages: [],
    extensions: extensionPaths,
    skills: skillPaths.map((skill) => skill.path),
  });

const buildMergedSkillsCommand = (
  id: SessionRecord["id"],
  skills: ReadonlyArray<{ readonly name: string; readonly path: string }>,
): string => {
  const merged = mergedSkillsPath(id);
  const piSkills = `${sessionRoot(id)}/.pi-agent/skills`;
  const parts = [`mkdir -p ${shellQuote(merged)}`];
  for (const skill of skills) {
    parts.push(extraSkillLinkCommand(`${merged}/${skill.name}`, skill.path));
  }
  parts.push(`ln -sfn ${shellQuote(merged)} ${shellQuote(piSkills)}`);
  return parts.join(" && ");
};

const gitConfig = (): string => `[credential]
	helper = !f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f
	useHttpPath = true
`;

export const terminalShellPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.pi-agent/scotty-shell`;

const terminalShell = (
  id: SessionRecord["id"],
  environment?: PersistedSessionEnvironmentSnapshot,
): string => {
  const exports = Object.entries(agentEnv(id, environment))
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
- Use matching skills under \`$PI_CODING_AGENT_DIR/skills\`; read the selected \`SKILL.md\` before acting.
- Identify the required work before acting.
- Keep a short ordered checklist in progress updates.
- Complete prerequisites before dependents.
- Use subagents only for independent parallel work; the parent owns integration and verification.
- Do not claim that a durable task store exists.
- Use no more than four concurrent subagents.
- Publish concise progress checkpoints only when there is meaningful new evidence: a completed implementation slice, a verification result, or a blocker. Finish with a concise outcome and proof.
- Before changing user-visible behavior, define at most three observable acceptance checks and one reproducible browser flow. Capture that flow before the change, make the smallest complete change, keep Hatch on the finished app, then rerun the same viewport, steps, and assertions with video enabled. Finish only when the checks pass or a concrete blocker is proven.
- In progress and final updates, include each exact \`scotty-evidence:<jobId>\` or \`scotty-hatch:<hatchId>\` reference returned by its structured first-party tool result at most once. The successful tool result must belong to the same conversation as the update; after any new user, steer, or follow-up message, call the relevant status or evidence tool again before publishing its reference. If that tool fails or returns no reference, do not publish one. Never invent, alter, expand, or repeat a reference, and never publish tool URLs, ports, paths, arguments, cookies, credentials, or route values as a substitute.
`;

export interface ContainerAuthSeedOptions {
  readonly initialPrompt?: string;
  readonly pi?: PiSettings;
  readonly extensionPaths?: ReadonlyArray<string>;
  readonly skillPaths?: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly toolCommands?: ReadonlyArray<SandboxToolCommand & { readonly path: string }>;
  readonly bundleRoot?: string;
  readonly environment?: PersistedSessionEnvironmentSnapshot;
}

interface ContainerAuthShape {
  readonly seed: (
    id: SessionRecord["id"],
    options?: ContainerAuthSeedOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly preflight: (
    id: SessionRecord["id"],
    options?: ContainerAuthSeedOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly ensureTerminal: (
    id: SessionRecord["id"],
    environment?: PersistedSessionEnvironmentSnapshot,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly ensurePiSession: (
    id: SessionRecord["id"],
    transportToken: PiSessionTransportToken,
    environment?: PersistedSessionEnvironmentSnapshot,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly quiescePiSession: (
    id: SessionRecord["id"],
    transportToken: PiSessionTransportToken,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly stopPiSession: () => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly refreshEnvironment: (
    id: SessionRecord["id"],
    transportToken: PiSessionTransportToken,
    previous: PersistedSessionEnvironmentSnapshot | undefined,
    next: SessionEnvironmentSnapshot,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
}

export class ContainerAuth extends Context.Service<ContainerAuth, ContainerAuthShape>()(
  "scotty/ContainerAuth",
) {}

export const containerAuthLayer: Layer.Layer<ContainerAuth, never, SandboxRuntime> = Layer.effect(
  ContainerAuth,
  Effect.map(SandboxRuntime, (runtime) => {
    const preflight = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      options?: ContainerAuthSeedOptions,
    ) {
      for (const extensionPath of options?.extensionPaths ?? [])
        yield* runtime.execChecked(`test -f ${shellQuote(extensionPath)}`);
      for (const skill of options?.skillPaths ?? [])
        yield* runtime.execChecked(`test -f ${shellQuote(`${skill.path}/SKILL.md`)}`);
      for (const command of options?.toolCommands ?? []) {
        yield* runtime.execChecked(`test -x ${shellQuote(command.path)}`);
        yield* runtime.execChecked(command.probe.map(shellQuote).join(" "));
      }
    });
    const seed = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      options?: ContainerAuthSeedOptions,
    ) {
      if (options?.pi === undefined)
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Pinned Pi settings are required to seed the Session",
        });
      const extensionPaths = options.extensionPaths ?? [];
      const skillPaths = options.skillPaths ?? [];
      const toolCommands = options.toolCommands ?? [];
      const piHome = `${sessionRoot(id)}/.pi-agent`;
      const piSettingsPath = `${piHome}/settings.json`;
      const piAgentsPath = `${piHome}/AGENTS.md`;
      const gitConfigPath = `${piHome}/gitconfig`;
      const shellPath = terminalShellPath(id);
      const promptPath = `${piHome}/initial-prompt`;
      yield* runtime.mkdir(piHome, { recursive: true });
      yield* runtime.writeFile(piSettingsPath, piSettings(options.pi, extensionPaths, skillPaths));
      yield* runtime.writeFile(piAgentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(gitConfigPath, gitConfig());
      yield* runtime.writeFile(shellPath, terminalShell(id, options?.environment));
      if (options?.initialPrompt !== undefined)
        yield* runtime.writeFile(promptPath, options.initialPrompt);
      yield* runtime.execChecked(
        `chmod 700 ${shellQuote(piHome)} ${shellQuote(shellPath)} && chmod 600 ${shellQuote(piSettingsPath)} ${shellQuote(piAgentsPath)} ${shellQuote(gitConfigPath)} && ${buildMergedSkillsCommand(id, skillPaths)}`,
      );
      for (const command of toolCommands)
        yield* runtime.execChecked(
          `ln -sfn ${shellQuote(command.path)} ${shellQuote(`/usr/local/bin/${command.name}`)}`,
        );
      const env = agentEnv(id, options?.environment);
      yield* runtime.setEnvVars(env);
      const root = sessionRoot(id);
      const ghIdentityCommand = `github_identity="$(gh api user)" && git_name="$(printf '%s' "$github_identity" | jq -r '.name // .login')" && git_email="$(printf '%s' "$github_identity" | jq -r 'if (.email // "") != "" then .email else "\\(.id)+\\(.login)@users.noreply.github.com" end')" && git -C ${shellQuote(root)} config user.name "$git_name" && git -C ${shellQuote(root)} config user.email "$git_email"`;
      const fallbackIdentityCommand = `git -C ${shellQuote(root)} config user.name "Scotty Session" && git -C ${shellQuote(root)} config user.email "scotty-session-${id}@users.noreply.github.com"`;
      yield* runtime
        .execChecked(ghIdentityCommand, { env, timeout: 20_000 })
        .pipe(
          Effect.catch(() =>
            runtime.execChecked(fallbackIdentityCommand, { env, timeout: 10_000 }),
          ),
        );
    });
    return ContainerAuth.of({
      seed,
      preflight,
      ensureTerminal: Effect.fnUntraced(function* (id, environment) {
        const existing = yield* runtime.exec(`test -x ${shellQuote(terminalShellPath(id))}`);
        if (
          existing.success &&
          (environment === undefined || isSessionEnvironmentSnapshot(environment))
        )
          return;
        const piHome = `${sessionRoot(id)}/.pi-agent`;
        const shellPath = terminalShellPath(id);
        yield* runtime.mkdir(piHome, { recursive: true });
        yield* runtime.writeFile(shellPath, terminalShell(id, environment));
        yield* runtime.execChecked(`chmod 700 ${shellQuote(piHome)} ${shellQuote(shellPath)}`);
      }),
      ensurePiSession: Effect.fnUntraced(function* (id, transportToken, environment) {
        const existing = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (existing?.status === "starting" || existing?.status === "running") {
          yield* existing.waitForPort(PI_SESSION_PORT, {
            path: "/health",
            status: 200,
            timeout: 30_000,
          });
          return;
        }
        const tokenPath = piSessionTokenPath(id);
        yield* runtime.writeFile(tokenPath, transportToken);
        yield* runtime.execChecked(`chmod 600 ${shellQuote(tokenPath)}`);
        const process = yield* runtime.startProcess("/usr/local/bin/scotty-pi-session", {
          autoCleanup: true,
          cwd: sessionRoot(id),
          env: {
            ...agentEnv(id, environment),
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
      quiescePiSession: Effect.fnUntraced(function* (id, transportToken) {
        const process = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (
          process === null ||
          process.status === "completed" ||
          process.status === "failed" ||
          process.status === "killed" ||
          process.status === "error"
        )
          return;
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
      refreshEnvironment: Effect.fnUntraced(function* (id, token, previous, next) {
        const process = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (
          process !== null &&
          process.status !== "completed" &&
          process.status !== "failed" &&
          process.status !== "killed" &&
          process.status !== "error"
        ) {
          const status = yield* runtime.fetchPortStatus("/quiesce", PI_SESSION_PORT, "POST", {
            [PI_SESSION_TOKEN_HEADER]: token,
          });
          if (status !== 200)
            return yield* new SandboxRuntimeFailure({
              reason: "nonzero_exit",
              message: "Pi session quiesce failed",
            });
          yield* process.kill("SIGTERM");
          yield* process.waitForExit(10_000);
        }
        const shellPath = terminalShellPath(id);
        yield* runtime.writeFile(shellPath, terminalShell(id, next));
        yield* runtime.execChecked(`chmod 700 ${shellQuote(shellPath)}`);
        const removed = Object.fromEntries(
          Object.keys(previous?.variables ?? {})
            .filter((name) => !(name in next.variables) && !environmentNameIsReserved(name))
            .map((name) => [name, undefined]),
        );
        yield* runtime.setEnvVars({ ...agentEnv(id, next), ...removed });
        const tokenPath = piSessionTokenPath(id);
        yield* runtime.writeFile(tokenPath, token);
        yield* runtime.execChecked(`chmod 600 ${shellQuote(tokenPath)}`);
        const restarted = yield* runtime.startProcess("/usr/local/bin/scotty-pi-session", {
          autoCleanup: true,
          cwd: sessionRoot(id),
          env: {
            ...agentEnv(id, next),
            SCOTTY_PI_SESSION_PORT: String(PI_SESSION_PORT),
            SCOTTY_PI_SESSION_TOKEN_FILE: tokenPath,
            SCOTTY_WORKSPACE: sessionRoot(id),
          },
          processId: PI_SESSION_PROCESS_ID,
        });
        yield* restarted.waitForPort(PI_SESSION_PORT, {
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
    });
  }),
);

export function agentEnv(
  id: SessionRecord["id"],
  environment?: PersistedSessionEnvironmentSnapshot,
): Record<string, string> {
  const safeEnvironment = isSessionEnvironmentSnapshot(environment) ? environment : undefined;
  return {
    ...Object.fromEntries(
      Object.entries(safeEnvironment?.variables ?? {}).filter(([name]) =>
        environmentNameIsMaterializable(name),
      ),
    ),
    PI_CODING_AGENT_DIR: `${sessionRoot(id)}/.pi-agent`,
    SCOTTY_SESSION_ID: id,
    GIT_CONFIG_GLOBAL: `${sessionRoot(id)}/.pi-agent/gitconfig`,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
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
