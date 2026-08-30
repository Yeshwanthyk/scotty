import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import {
  githubManagedHandle,
  piAuthJson,
  type SessionRuntimeCredentials,
} from "../credentials/managed";
import type { SessionRecord } from "../session/contracts";
import { sha256Hex } from "../shared/digest";
import {
  PiPackageNameSchema,
  SandboxBundleItemNameSchema,
  SkillNameSchema,
  type SandboxBundleItemKind,
} from "./config-contracts";
import { SandboxRuntime, SandboxRuntimeFailure, shellQuote } from "./runtime";
import { sessionRoot } from "./workspace";

export { piAuthJson } from "../credentials/managed";

export const PI_PACKAGES = [
  "/opt/scotty/pi-packages/sources/scotty-browser-test",
  "/opt/scotty/pi-packages/sources/scotty-hatch",
] as const;

export const PI_SESSION_PORT = 43_117;
export const PI_SESSION_PROCESS_ID = "scotty-pi-session";
export const PI_SESSION_TOKEN_HEADER = "x-scotty-pi-session";

const piSessionTokenPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.pi-agent/scotty-pi-session.token`;

export const piSessionTransportToken = (id: SessionRecord["id"]): Promise<string> =>
  sha256Hex(`scotty-pi-session\0${id}`);

const derivePiSessionTransportToken = (
  id: SessionRecord["id"],
): Effect.Effect<string, SandboxRuntimeFailure> =>
  Effect.tryPromise({
    try: () => piSessionTransportToken(id),
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

const bundleItemPath = (bundleRoot: string, kind: SandboxBundleItemKind, name: string): string => {
  if (kind === "skill") return extraSkillSourcePath(bundleRoot, name);
  if (kind === "package") return extraPackagePath(bundleRoot, name);
  return `${bundleRoot}/${kind}s/${name}`;
};

const decodeSkillName = Schema.decodeUnknownOption(SkillNameSchema);
const decodePiPackageName = Schema.decodeUnknownOption(PiPackageNameSchema);
const decodeBundleItemName = Schema.decodeUnknownOption(SandboxBundleItemNameSchema);

const pathUnderRoot = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const extraSkillLinkCommand = (target: string, source: string): string =>
  `{ [ ! -e ${shellQuote(target)} ] || [ "$(readlink ${shellQuote(target)})" = ${shellQuote(source)} ]; } && ln -sfn ${shellQuote(source)} ${shellQuote(target)}`;

const resolveSeedExtras = (
  options?: ContainerAuthSeedOptions,
): Effect.Effect<
  {
    readonly skills: ReadonlyArray<{ readonly name: string }>;
    readonly extraPackagePaths: ReadonlyArray<string>;
    readonly extensionPaths: ReadonlyArray<string>;
    readonly toolPaths: ReadonlyArray<string>;
    readonly bundleRoot: string | undefined;
  },
  SandboxRuntimeFailure
> =>
  Effect.gen(function* () {
    const items = options?.items ?? [];
    const bundleRoot = options?.bundleRoot;
    if (items.length === 0)
      return {
        skills: [],
        extraPackagePaths: [],
        extensionPaths: [],
        toolPaths: [],
        bundleRoot,
      };
    if (bundleRoot === undefined)
      return yield* new SandboxRuntimeFailure({
        reason: "nonzero_exit",
        message: "Sandbox bundle root is required when extras are configured",
      });
    const configuredNames = new Set<string>();
    const skills: Array<{ readonly name: string }> = [];
    const extraPackagePaths: string[] = [];
    const extensionPaths: string[] = [];
    const toolPaths: string[] = [];
    for (const item of items) {
      const key = `${item.kind}\0${item.name}`;
      if (configuredNames.has(key))
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox configured bundle items must be unique",
        });
      configuredNames.add(key);
      const validName =
        item.kind === "skill"
          ? decodeSkillName(item.name)
          : item.kind === "package"
            ? decodePiPackageName(item.name)
            : decodeBundleItemName(item.name);
      const itemPath = bundleItemPath(bundleRoot, item.kind, item.name);
      if (
        Option.isNone(validName) ||
        !pathUnderRoot(bundleRoot, itemPath) ||
        itemPath.includes(".staging-")
      )
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox bundle item path is outside the bundle root",
        });
      if (item.kind === "skill") skills.push({ name: item.name });
      else if (item.kind === "package") extraPackagePaths.push(itemPath);
      else if (item.kind === "extension") extensionPaths.push(itemPath);
      else toolPaths.push(itemPath);
    }
    if (toolPaths.length > 0) toolPaths.unshift(`${bundleRoot}/tools`);
    return { skills, extraPackagePaths, extensionPaths, toolPaths, bundleRoot };
  });

const PiSettingsResourcesSchema = Schema.Struct({
  packages: Schema.optional(Schema.Array(Schema.String)),
  extensions: Schema.optional(Schema.Array(Schema.String)),
});
const decodePiSettingsResources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiSettingsResourcesSchema),
  { onExcessProperty: "ignore" },
);

const piSettingsParseFailure = (): SandboxRuntimeFailure =>
  new SandboxRuntimeFailure({
    reason: "nonzero_exit",
    message: "Sandbox Pi settings could not be parsed",
  });

const existingExtraResources = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  settingsPath: string,
) {
  const settingsBytes = yield* runtime
    .readFile(settingsPath, 65_536)
    .pipe(Effect.catchTag("SandboxRuntimeFailure", () => Effect.succeed(undefined)));
  if (settingsBytes === undefined)
    return {
      packagePaths: [] as ReadonlyArray<string>,
      extensionPaths: [] as ReadonlyArray<string>,
    };
  const decoded = yield* Effect.result(
    decodePiSettingsResources(new TextDecoder().decode(settingsBytes)),
  );
  if (Result.isFailure(decoded))
    return {
      packagePaths: [] as ReadonlyArray<string>,
      extensionPaths: [] as ReadonlyArray<string>,
    };
  const packages = decoded.success.packages ?? [];
  const extensionPaths = decoded.success.extensions ?? [];
  if (packages.length < PI_PACKAGES.length)
    return { packagePaths: [] as ReadonlyArray<string>, extensionPaths };
  for (let index = 0; index < PI_PACKAGES.length; index += 1) {
    if (packages[index] !== PI_PACKAGES[index])
      return { packagePaths: [] as ReadonlyArray<string>, extensionPaths };
  }
  return { packagePaths: packages.slice(PI_PACKAGES.length), extensionPaths };
});

const piSettings = (
  credentials: SessionRuntimeCredentials,
  extraPackagePaths: ReadonlyArray<string> = [],
  extensionPaths: ReadonlyArray<string> = [],
): string =>
  JSON.stringify({
    defaultProvider: credentials.piProviders.includes("openai-codex") ? "openai-codex" : "openai",
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
    extensions: extensionPaths,
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
    `for skill in /opt/scotty/skills/*; do [ -e "$skill" ] || continue; ln -sfn "$skill" ${shellQuote(`${merged}/`)}; done`,
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

const gitConfig = (): string => `[credential]
\thelper = !f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f
\tuseHttpPath = true
`;

export const terminalShellPath = (id: SessionRecord["id"]): string =>
  `${sessionRoot(id)}/.pi-agent/scotty-shell`;

const terminalShell = (
  id: SessionRecord["id"],
  credentials: SessionRuntimeCredentials,
  toolPaths: ReadonlyArray<string> = [],
): string => {
  const env = {
    ...agentEnv(id, credentials),
    ...(toolPaths.length === 0
      ? {}
      : { PATH: `${toolPaths.join(":")}:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin` }),
  };
  const exports = Object.entries(env)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  return `#!/usr/bin/env bash
set -euo pipefail

${exports}

exec /usr/local/bin/scotty-pi-shell
`;
};

export const sandboxAgentsInstructions = `- Read and follow the repository AGENTS.md first; repository instructions override this file.
- Inspect the standard sandbox tool inventory with \`jq . /opt/scotty/toolsets/standard.json\`.
- Prefer \`rg\`, \`fd\`, and \`ast-grep\` for search. Use \`jq\`, \`yq\`, and \`qsv\` for structured data.
- Use \`uv\` and \`uvx\` for Python. Use the repository's declared JavaScript package manager; use Corepack only when it declares Yarn or pnpm.
- If a required tool is absent or a dependency download is blocked by Scotty policy (including HTTP 520), stop after one bounded retry. Run the focused checks that are available and report the exact unavailable gate. If publication was requested, continue to commit, push, and open the PR so CI can run the locked full gate.
- Don't build a missing toolchain from source, install a third-party embedded toolchain, add temporary module replacements, or bypass the proxy with direct arbitrary-host downloads unless the user explicitly asks.
- Use matching skills under \`$PI_CODING_AGENT_DIR/skills\` or \`$CODEX_HOME/skills\`; read the selected \`SKILL.md\` before acting.
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
  readonly items?: ReadonlyArray<{
    readonly kind: SandboxBundleItemKind;
    readonly name: string;
  }>;
  readonly bundleRoot?: string;
}

interface ContainerAuthShape {
  readonly seed: (
    id: SessionRecord["id"],
    credentials: SessionRuntimeCredentials,
    options?: ContainerAuthSeedOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly preflight: (
    id: SessionRecord["id"],
    credentials: SessionRuntimeCredentials,
    options?: ContainerAuthSeedOptions,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly ensureTerminal: (
    id: SessionRecord["id"],
    credentials: SessionRuntimeCredentials,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly ensurePiSession: (
    id: SessionRecord["id"],
    credentials: SessionRuntimeCredentials,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly quiescePiSession: (
    id: SessionRecord["id"],
    credentials: SessionRuntimeCredentials,
  ) => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly stopPiSession: () => Effect.Effect<void, SandboxRuntimeFailure>;
  readonly refreshPiAuth: (
    id: SessionRecord["id"],
    credentials: SessionRuntimeCredentials,
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
      credentials: SessionRuntimeCredentials,
    ) {
      const piHome = `${sessionRoot(id)}/.pi-agent`;
      const authPath = `${piHome}/auth.json`;
      const settingsPath = `${piHome}/settings.json`;
      yield* runtime.mkdir(piHome, { recursive: true });
      yield* runtime.writeFile(authPath, piAuthJson(credentials));
      const resources = yield* existingExtraResources(runtime, settingsPath);
      yield* runtime.writeFile(
        settingsPath,
        piSettings(credentials, resources.packagePaths, resources.extensionPaths),
      );
      yield* runtime.execChecked(`chmod 600 ${shellQuote(authPath)} ${shellQuote(settingsPath)}`);
    });
    const preflight = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      _credentials: SessionRuntimeCredentials,
      options?: ContainerAuthSeedOptions,
    ) {
      const { skills, extraPackagePaths, extensionPaths, toolPaths, bundleRoot } =
        yield* resolveSeedExtras(options);
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
      for (const path of [...extensionPaths, ...toolPaths])
        yield* runtime.execChecked(`test -e ${shellQuote(path)}`);
      const merged = mergedSkillsPath(id);
      for (const skill of skills) {
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
      const settings = yield* decodePiSettingsResources(
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
      if (JSON.stringify(settings.extensions ?? []) !== JSON.stringify(extensionPaths))
        return yield* new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox Pi settings extensions do not match the configured bundle",
        });
    });
    const seed = Effect.fnUntraced(function* (
      id: SessionRecord["id"],
      credentials: SessionRuntimeCredentials,
      options?: ContainerAuthSeedOptions,
    ) {
      const { skills, extraPackagePaths, extensionPaths, toolPaths } =
        yield* resolveSeedExtras(options);
      const codexHome = `${sessionRoot(id)}/.codex`;
      const piHome = `${sessionRoot(id)}/.pi-agent`;
      const configPath = `${codexHome}/config.toml`;
      const agentsPath = `${codexHome}/AGENTS.md`;
      const piAuthPath = `${piHome}/auth.json`;
      const piSettingsPath = `${piHome}/settings.json`;
      const piAgentsPath = `${piHome}/AGENTS.md`;
      const gitConfigPath = `${piHome}/gitconfig`;
      const shellPath = terminalShellPath(id);
      const promptPath = `${piHome}/initial-prompt`;
      yield* runtime.mkdir(codexHome, { recursive: true });
      yield* runtime.mkdir(piHome, { recursive: true });
      yield* runtime.writeFile(configPath, codexConfig(id));
      yield* runtime.writeFile(agentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(piAuthPath, piAuthJson(credentials));
      yield* runtime.writeFile(
        piSettingsPath,
        piSettings(credentials, extraPackagePaths, extensionPaths),
      );
      yield* runtime.writeFile(piAgentsPath, sandboxAgentsInstructions);
      yield* runtime.writeFile(gitConfigPath, gitConfig());
      yield* runtime.writeFile(shellPath, terminalShell(id, credentials, toolPaths));
      if (options?.initialPrompt !== undefined)
        yield* runtime.writeFile(promptPath, options.initialPrompt);
      yield* runtime.execChecked(
        `chmod 700 ${shellQuote(codexHome)} ${shellQuote(piHome)} ${shellQuote(shellPath)} && chmod 600 ${shellQuote(configPath)} ${shellQuote(agentsPath)} ${shellQuote(piAuthPath)} ${shellQuote(piSettingsPath)} ${shellQuote(piAgentsPath)} ${shellQuote(gitConfigPath)} && ${buildMergedSkillsCommand(id, skills, options?.bundleRoot)}`,
      );
      const env = {
        ...agentEnv(id, credentials),
        ...(toolPaths.length === 0
          ? {}
          : { PATH: `${toolPaths.join(":")}:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin` }),
      };
      yield* runtime.setEnvVars(env);
      const root = sessionRoot(id);
      yield* runtime.execChecked(
        `git -C ${shellQuote(root)} config user.name "Scotty Session" && git -C ${shellQuote(root)} config user.email "scotty-session-${id}@users.noreply.github.com"`,
        { env, timeout: 10_000 },
      );
    });
    return ContainerAuth.of({
      seed,
      preflight,
      ensureTerminal: Effect.fnUntraced(function* (id, credentials) {
        const existing = yield* runtime.exec(`test -x ${shellQuote(terminalShellPath(id))}`);
        if (existing.success) return;
        yield* seed(id, credentials);
      }),
      ensurePiSession: Effect.fnUntraced(function* (id, credentials) {
        const existing = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (existing?.status === "starting" || existing?.status === "running") {
          yield* existing.waitForPort(PI_SESSION_PORT, {
            path: "/health",
            status: 200,
            timeout: 30_000,
          });
          return;
        }
        yield* refreshPiAuth(id, credentials);
        const transportToken = yield* derivePiSessionTransportToken(id);
        const tokenPath = piSessionTokenPath(id);
        yield* runtime.writeFile(tokenPath, transportToken);
        yield* runtime.execChecked(`chmod 600 ${shellQuote(tokenPath)}`);
        const process = yield* runtime.startProcess("/usr/local/bin/scotty-pi-session", {
          autoCleanup: true,
          cwd: sessionRoot(id),
          env: {
            ...agentEnv(id, credentials),
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
      quiescePiSession: Effect.fnUntraced(function* (id, _credentials) {
        const process = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (
          process === null ||
          process.status === "completed" ||
          process.status === "failed" ||
          process.status === "killed" ||
          process.status === "error"
        )
          return;
        const transportToken = yield* derivePiSessionTransportToken(id);
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
  credentials: SessionRuntimeCredentials,
): Record<string, string> {
  const github = githubManagedHandle(credentials.grants);
  return {
    CODEX_HOME: `${sessionRoot(id)}/.codex`,
    PI_CODING_AGENT_DIR: `${sessionRoot(id)}/.pi-agent`,
    SCOTTY_SESSION_ID: id,
    GIT_CONFIG_GLOBAL: `${sessionRoot(id)}/.pi-agent/gitconfig`,
    ...(github === undefined ? {} : { GH_TOKEN: github }),
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
