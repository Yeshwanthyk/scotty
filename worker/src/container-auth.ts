import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import type { SessionRecord } from "./contracts";
import { sha256Hex } from "./digest";
import { piAuthJson, type StoredCredential } from "./egress";
import { PiPackageNameSchema, SkillNameSchema } from "./sandbox-config-contracts";
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

export const mergedSkillsPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.scotty/merged-skills`;

const extraPackagePath = (bundleRoot: string, name: string): string =>
  `${bundleRoot}/pi-packages/${name}`;

const extraSkillSourcePath = (bundleRoot: string, name: string): string =>
  `${bundleRoot}/skills/${name}`;

const decodeSkillName = Schema.decodeUnknownOption(SkillNameSchema);
const decodePiPackageName = Schema.decodeUnknownOption(PiPackageNameSchema);

const pathUnderRoot = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const extraSkillLinkCommand = (target: string, source: string): string =>
  `{ [ ! -e ${shellQuote(target)} ] || [ "$(readlink ${shellQuote(target)})" = ${shellQuote(source)} ]; } && ln -sfn ${shellQuote(source)} ${shellQuote(target)}`;

const resolveSeedExtras = (
  options?: ContainerAuthSeedOptions,
): Effect.Effect<
  {
    readonly extraSkills: ReadonlyArray<{ readonly name: string }>;
    readonly extraPackagePaths: ReadonlyArray<string>;
    readonly bundleRoot: string | undefined;
  },
  SandboxRuntimeFailure
> =>
  Effect.gen(function* () {
    const extraSkills = options?.extraSkills ?? [];
    const extraPackages = options?.extraPackages ?? [];
    const bundleRoot = options?.bundleRoot;
    if (extraSkills.length === 0 && extraPackages.length === 0)
      return { extraSkills, extraPackagePaths: [], bundleRoot };
    if (bundleRoot === undefined)
      return yield* new SandboxRuntimeFailure({
        reason: "nonzero_exit",
        message: "Sandbox bundle root is required when extras are configured",
      });
    for (const skill of extraSkills) {
      if (Option.isNone(decodeSkillName(skill.name)))
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox extra skill name is invalid",
        });
    }
    const extraPackagePaths: string[] = [];
    for (const pkg of extraPackages) {
      const packagePath = extraPackagePath(bundleRoot, pkg.name);
      if (
        Option.isNone(decodePiPackageName(pkg.name)) ||
        !pathUnderRoot(bundleRoot, packagePath) ||
        packagePath.includes(".staging-")
      )
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox extra package path is outside the bundle root",
        });
      extraPackagePaths.push(packagePath);
    }
    return { extraSkills, extraPackagePaths, bundleRoot };
  });

const PiSettingsPackagesSchema = Schema.Struct({
  packages: Schema.optional(Schema.Array(Schema.String)),
});
const decodePiSettingsPackages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiSettingsPackagesSchema),
  { onExcessProperty: "ignore" },
);

const piSettingsParseFailure = (): SandboxRuntimeFailure =>
  new SandboxRuntimeFailure({
    reason: "nonzero_exit",
    message: "Sandbox Pi settings could not be parsed",
  });

const existingExtraPackagePaths = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  settingsPath: string,
) {
  const settingsBytes = yield* runtime
    .readFile(settingsPath, 65_536)
    .pipe(Effect.catchTag("SandboxRuntimeFailure", () => Effect.succeed(undefined)));
  if (settingsBytes === undefined) return [] as ReadonlyArray<string>;
  const decoded = yield* Effect.result(
    decodePiSettingsPackages(new TextDecoder().decode(settingsBytes)),
  );
  if (Result.isFailure(decoded)) return [] as ReadonlyArray<string>;
  const packages = decoded.success.packages ?? [];
  if (packages.length < PI_PACKAGES.length) return [] as ReadonlyArray<string>;
  for (let index = 0; index < PI_PACKAGES.length; index += 1) {
    if (packages[index] !== PI_PACKAGES[index]) return [] as ReadonlyArray<string>;
  }
  return packages.slice(PI_PACKAGES.length);
});

const piSettings = (
  credential: StoredCredential,
  extraPackagePaths: ReadonlyArray<string> = [],
): string =>
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
    packages: [...PI_PACKAGES, ...extraPackagePaths],
  });

const buildMergedSkillsCommand = (
  id: SessionRecord["id"],
  extraSkills: ReadonlyArray<{ readonly name: string }>,
  bundleRoot: string | undefined,
): string => {
  const merged = mergedSkillsPath(id);
  const codexSkills = `${sessionRoot(id)}/.codex/skills`;
  const piSkills = `${sessionRoot(id)}/.pi-agent/skills`;
  const parts = [
    `mkdir -p ${shellQuote(merged)}`,
    `ln -sfn /opt/scotty/skills/* ${shellQuote(`${merged}/`)}`,
  ];
  for (const skill of extraSkills) {
    parts.push(
      extraSkillLinkCommand(
        `${merged}/${skill.name}`,
        extraSkillSourcePath(bundleRoot!, skill.name),
      ),
    );
  }
  parts.push(`ln -sfn ${shellQuote(merged)} ${shellQuote(codexSkills)}`);
  parts.push(`ln -sfn ${shellQuote(merged)} ${shellQuote(piSkills)}`);
  return parts.join(" && ");
};

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
- Publish concise progress checkpoints only when there is meaningful new evidence: a completed implementation slice, a verification result, or a blocker. Finish with a concise outcome and proof.
- Before changing user-visible behavior, define at most three observable acceptance checks and one reproducible browser flow. Capture that flow before the change, make the smallest complete change, keep Hatch on the finished app, then rerun the same viewport, steps, and assertions with video enabled. Finish only when the checks pass or a concrete blocker is proven.
- In progress and final updates, include each exact \`scotty-evidence:<jobId>\` or \`scotty-hatch:<hatchId>\` reference returned by its structured first-party tool result at most once. The successful tool result must belong to the same conversation as the update; after any new user, steer, or follow-up message, call the relevant status or evidence tool again before publishing its reference. If that tool fails or returns no reference, do not publish one. Never invent, alter, expand, or repeat a reference, and never publish tool URLs, ports, paths, arguments, cookies, credentials, or route values as a substitute.
`;

export interface ContainerAuthSeedOptions {
  readonly initialPrompt?: string;
  readonly extraSkills?: ReadonlyArray<{ readonly name: string }>;
  readonly extraPackages?: ReadonlyArray<{ readonly name: string }>;
  readonly bundleRoot?: string;
}

interface ContainerAuthShape {
  readonly seed: (
    id: SessionRecord["id"],
    credential: StoredCredential,
    options?: ContainerAuthSeedOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly preflight: (
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
      const extraPackagePaths = yield* existingExtraPackagePaths(runtime, settingsPath);
      yield* runtime.writeFile(settingsPath, piSettings(credential, extraPackagePaths));
      yield* runtime.execChecked(`chmod 600 ${shellQuote(authPath)} ${shellQuote(settingsPath)}`);
    });
    const preflight = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      _credential: StoredCredential,
      options?: ContainerAuthSeedOptions,
    ) {
      const { extraSkills, extraPackagePaths, bundleRoot } = yield* resolveSeedExtras(options);
      for (const packagePath of PI_PACKAGES)
        yield* runtime.execChecked(`test -d ${shellQuote(packagePath)}`);
      for (const packagePath of extraPackagePaths) {
        if (
          bundleRoot === undefined ||
          !pathUnderRoot(bundleRoot, packagePath) ||
          packagePath.includes(".staging-")
        )
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Sandbox extra package path is outside the bundle root",
          });
        yield* runtime.execChecked(`test -d ${shellQuote(packagePath)}`);
      }
      const merged = mergedSkillsPath(id);
      for (const skill of extraSkills) {
        if (Option.isNone(decodeSkillName(skill.name)))
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Sandbox extra skill name is invalid",
          });
        const skillPath = `${merged}/${skill.name}`;
        if (skillPath.includes(".staging-"))
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Sandbox configured path references a staging directory",
          });
        yield* runtime.execChecked(`test -e ${shellQuote(skillPath)}`);
      }
      const settingsBytes = yield* runtime.readFile(
        `${sessionRoot(id)}/.pi-agent/settings.json`,
        65_536,
      );
      const settings = yield* decodePiSettingsPackages(
        new TextDecoder().decode(settingsBytes),
      ).pipe(Effect.mapError(() => piSettingsParseFailure()));
      const packages = settings.packages ?? [];
      if (packages.length !== PI_PACKAGES.length + extraPackagePaths.length)
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox Pi settings packages do not match the configured bundle",
        });
      for (let index = 0; index < PI_PACKAGES.length; index += 1) {
        if (packages[index] !== PI_PACKAGES[index])
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Sandbox Pi settings packages do not start with built-in packages",
          });
      }
      for (let index = 0; index < extraPackagePaths.length; index += 1) {
        const packagePath = extraPackagePaths[index]!;
        if (packages[PI_PACKAGES.length + index] !== packagePath)
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Sandbox Pi settings packages do not match the configured bundle",
          });
        if (packagePath.includes(".staging-"))
          return yield* new SandboxRuntimeFailure({
            reason: "nonzero_exit",
            message: "Sandbox configured path references a staging directory",
          });
      }
    });
    const seed = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      credential: StoredCredential,
      options?: ContainerAuthSeedOptions,
    ) {
      const { extraSkills, extraPackagePaths } = yield* resolveSeedExtras(options);
      const codexHome = `${sessionRoot(id)}/.codex`;
      const piHome = `${sessionRoot(id)}/.pi-agent`;
      const configPath = `${codexHome}/config.toml`;
      const agentsPath = `${codexHome}/AGENTS.md`;
      const piAuthPath = `${piHome}/auth.json`;
      const piSettingsPath = `${piHome}/settings.json`;
      const piAgentsPath = `${piHome}/AGENTS.md`;
      const piWebSearchPath = `${piHome}/web-search.json`;
      const gitConfigPath = `${piHome}/gitconfig`;
      const shellPath = terminalShellPath(id);
      const promptPath = `${piHome}/initial-prompt`;
      yield* runtime.mkdir(codexHome, { recursive: true });
      yield* runtime.mkdir(piHome, { recursive: true });
      yield* runtime.writeFile(configPath, codexConfig(id));
      yield* runtime.writeFile(agentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(piAuthPath, piAuthJson(credential));
      yield* runtime.writeFile(piSettingsPath, piSettings(credential, extraPackagePaths));
      yield* runtime.writeFile(piAgentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(piWebSearchPath, piWebSearchConfig);
      yield* runtime.writeFile(gitConfigPath, gitConfig());
      yield* runtime.writeFile(shellPath, terminalShell(id, credential));
      if (options?.initialPrompt !== undefined)
        yield* runtime.writeFile(promptPath, options.initialPrompt);
      yield* runtime.execChecked(
        `chmod 700 ${shellQuote(codexHome)} ${shellQuote(piHome)} ${shellQuote(shellPath)} && chmod 600 ${shellQuote(configPath)} ${shellQuote(agentsPath)} ${shellQuote(piAuthPath)} ${shellQuote(piSettingsPath)} ${shellQuote(piAgentsPath)} ${shellQuote(piWebSearchPath)} ${shellQuote(gitConfigPath)} && ${buildMergedSkillsCommand(id, extraSkills, options?.bundleRoot)}`,
      );
      yield* runtime.setEnvVars(agentEnv(id, credential));
      const root = sessionRoot(id);
      yield* runtime.execChecked(
        `github_identity="$(gh api user)" && git_name="$(printf '%s' "$github_identity" | jq -r '.name // .login')" && git_email="$(printf '%s' "$github_identity" | jq -r 'if (.email // "") != "" then .email else "\\(.id)+\\(.login)@users.noreply.github.com" end')" && git -C ${shellQuote(root)} config user.name "$git_name" && git -C ${shellQuote(root)} config user.email "$git_email"`,
      );
    });
    return ContainerAuth.of({
      seed,
      preflight,
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
