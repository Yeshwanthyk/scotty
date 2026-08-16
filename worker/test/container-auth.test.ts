import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Result } from "effect";
import {
  agentEnv,
  ContainerAuth,
  containerAuthLayer,
  mergedSkillsPath,
  PI_PACKAGES,
  PI_SESSION_PORT,
  PI_SESSION_PROCESS_ID,
  sandboxAgentsInstructions,
  terminalShellPath,
  type ContainerAuthSeedOptions,
} from "../src/container-auth";
import { piAuthJson, type StoredCredential } from "../src/egress";
import {
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  type SandboxExecOptions,
  type SandboxProcessCapabilities,
  type SandboxProcessOptions,
  type SandboxRuntimeCapabilities,
  type SandboxWriteContent,
} from "../src/sandbox-runtime";
import { sessionRoot } from "../src/workspace";

const ID = "a0b1c2d3e4f5";
const PI_SENTINEL = `scotty-pi-${ID}-sentinel`;
const GITHUB_SENTINEL = `scotty-github-${ID}-sentinel`;
const REAL_ACCESS = "honeypot-real-codex-access";
const REAL_REFRESH = "honeypot-real-codex-refresh";
const REAL_GITHUB = "honeypot-real-github-token";
const REAL_ACCOUNT = "honeypot-real-account";
const REAL_API_KEY = "honeypot-real-api-key";

const credential: StoredCredential = {
  providers: {
    "openai-codex": {
      credential: {
        type: "oauth",
        access: REAL_ACCESS,
        refresh: REAL_REFRESH,
        expires: 0,
        accountId: REAL_ACCOUNT,
        idToken: "honeypot-real-id-token",
      },
      sentinel: PI_SENTINEL,
    },
  },
  githubToken: REAL_GITHUB,
  githubSentinel: GITHUB_SENTINEL,
  updatedAt: "2026-07-22T01:02:03.000Z",
};

const apiKeyCredential: StoredCredential = {
  ...credential,
  providers: {
    openai: {
      credential: { type: "api_key", key: REAL_API_KEY },
      sentinel: PI_SENTINEL,
    },
  },
};

type ContainerCall =
  | { readonly operation: "mkdir"; readonly path: string; readonly recursive?: boolean }
  | { readonly operation: "writeFile"; readonly path: string; readonly content: string }
  | { readonly operation: "exec"; readonly command: string; readonly options?: SandboxExecOptions }
  | {
      readonly operation: "setEnvVars";
      readonly envVars: Record<string, string | undefined>;
    }
  | {
      readonly operation: "startProcess";
      readonly command: string;
      readonly options?: SandboxProcessOptions;
    }
  | { readonly operation: "getProcess"; readonly processId: string }
  | { readonly operation: "killProcess"; readonly signal?: string }
  | { readonly operation: "waitForPort"; readonly port: number }
  | {
      readonly operation: "fetchPort";
      readonly path: string;
      readonly port: number;
      readonly method: "GET" | "POST";
      readonly headers?: Readonly<Record<string, string>>;
    };

const byteStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const normalizeWriteContent = (content: SandboxWriteContent): string => {
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return "[stream]";
};

class CapturingSandboxCapabilities implements SandboxRuntimeCapabilities {
  readonly calls: ContainerCall[] = [];
  readonly files = new Map<string, Uint8Array>();
  reject?: ContainerCall["operation"];
  terminalShellMissing = false;
  execFailWhen?: (command: string) => boolean;

  exec = (command: string, options?: SandboxExecOptions): Promise<ExecResult> => {
    this.calls.push({ operation: "exec", command, options });
    if (this.reject === "exec") return Promise.reject("provider exec secret");
    if (this.execFailWhen?.(command))
      return Promise.resolve({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "collision",
        command,
        duration: 1,
        timestamp: "2026-07-22T01:02:03.000Z",
      });
    if (this.terminalShellMissing && command.startsWith("test -x "))
      return Promise.resolve({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        command,
        duration: 1,
        timestamp: "2026-07-22T01:02:03.000Z",
      });
    return Promise.resolve({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      command,
      duration: 1,
      timestamp: "2026-07-22T01:02:03.000Z",
    });
  };

  readFileStream = (path: string): Promise<ReadableStream<Uint8Array>> => {
    const bytes = this.files.get(path);
    if (bytes === undefined) return Promise.reject(new Error(`missing file ${path}`));
    return Promise.resolve(byteStream(bytes));
  };

  mkdir = (path: string, options?: { readonly recursive?: boolean }): Promise<unknown> => {
    this.calls.push({ operation: "mkdir", path, recursive: options?.recursive });
    if (this.reject === "mkdir") return Promise.reject("provider mkdir secret");
    return Promise.resolve({ success: true, path });
  };

  writeFile = (path: string, content: SandboxWriteContent): Promise<unknown> => {
    const stored = normalizeWriteContent(content);
    this.calls.push({ operation: "writeFile", path, content: stored });
    this.files.set(path, new TextEncoder().encode(stored));
    if (this.reject === "writeFile") return Promise.reject("provider write secret");
    return Promise.resolve({ success: true, path, bytesWritten: stored.length });
  };

  setEnvVars = (envVars: Record<string, string | undefined>): Promise<void> => {
    this.calls.push({ operation: "setEnvVars", envVars });
    if (this.reject === "setEnvVars") return Promise.reject("provider env secret");
    return Promise.resolve();
  };
}

class ProcessSandboxCapabilities extends CapturingSandboxCapabilities {
  process: SandboxProcessCapabilities | null = null;
  fetchPortResponseStatus = 200;

  private makeProcess(): SandboxProcessCapabilities {
    return {
      id: PI_SESSION_PROCESS_ID,
      status: "running",
      kill: (signal?: string) => {
        this.calls.push({ operation: "killProcess", signal });
        this.process = null;
        return Promise.resolve();
      },
      waitForExit: () => Promise.resolve({ exitCode: 0 }),
      waitForPort: (readyPort: number) => {
        this.calls.push({ operation: "waitForPort", port: readyPort });
        return Promise.resolve();
      },
    };
  }

  startProcess = (
    command: string,
    options?: SandboxProcessOptions,
  ): Promise<SandboxProcessCapabilities> => {
    this.calls.push({ operation: "startProcess", command, options });
    this.process = this.makeProcess();
    return Promise.resolve(this.process);
  };

  getProcess = (processId: string): Promise<SandboxProcessCapabilities | null> => {
    this.calls.push({ operation: "getProcess", processId });
    return Promise.resolve(this.process);
  };

  fetchPort = (
    path: string,
    requestPort: number,
    method: "GET" | "POST",
    headers?: Readonly<Record<string, string>>,
  ) => {
    this.calls.push({ operation: "fetchPort", path, port: requestPort, method, headers });
    return Promise.resolve(new Response(null, { status: this.fetchPortResponseStatus }));
  };
}

const seedWith = (
  capabilities: SandboxRuntimeCapabilities,
  storedCredential: StoredCredential = credential,
  options?: ContainerAuthSeedOptions,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => auth.seed(ID, storedCredential, options)).pipe(
    Effect.provide(layer),
  );
};

const preflightWith = (
  capabilities: SandboxRuntimeCapabilities,
  storedCredential: StoredCredential = credential,
  options?: ContainerAuthSeedOptions,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) =>
    auth.preflight(ID, storedCredential, options),
  ).pipe(Effect.provide(layer));
};

const chmodExecCommand = (calls: ContainerCall[]): string => {
  const exec = calls.find(
    (call): call is Extract<ContainerCall, { operation: "exec" }> =>
      call.operation === "exec" && call.command.includes("chmod 700"),
  );
  assert.ok(exec);
  return exec.command;
};

const ensureTerminalWith = (
  capabilities: SandboxRuntimeCapabilities,
  storedCredential: StoredCredential = credential,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => auth.ensureTerminal(ID, storedCredential)).pipe(
    Effect.provide(layer),
  );
};

const piSessionWith = (
  capabilities: SandboxRuntimeCapabilities,
  operation: "ensure" | "quiesce" | "stop",
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => {
    if (operation === "ensure") return auth.ensurePiSession(ID, credential);
    if (operation === "quiesce") return auth.quiescePiSession(ID, credential);
    return auth.stopPiSession();
  }).pipe(Effect.provide(layer));
};

const failed = <A>(result: Result.Result<A, SandboxRuntimeFailure>): SandboxRuntimeFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("container auth values", () => {
  it("uses only immutable image-local Pi packages at sandbox startup", () => {
    assert.deepStrictEqual(PI_PACKAGES, [
      "/opt/scotty/pi-packages/sources/pi-subagents",
      "/opt/scotty/pi-packages/sources/pi-workflows",
      "/opt/scotty/pi-packages/sources/pi-background-terminals",
      "/opt/scotty/pi-packages/sources/pi-askuser",
      "/opt/scotty/pi-packages/sources/pi-web-access",
      "/opt/scotty/pi-packages/npm/node_modules/@ogulcancelik/pi-codex-compaction",
      "/opt/scotty/pi-packages/sources/pi-amp-ui",
      "/opt/scotty/pi-packages/sources/scotty-browser-test",
      "/opt/scotty/pi-packages/sources/scotty-hatch",
    ]);
    for (const source of PI_PACKAGES) {
      assert.ok(source.startsWith("/opt/scotty/pi-packages/"));
      assert.ok(!source.startsWith("git:"));
      assert.ok(!source.startsWith("npm:"));
      assert.ok(!source.includes("://"));
    }
  });

  it("constructs the exact session path and agent environment", () => {
    assert.strictEqual(sessionRoot(ID), `/workspace/${ID}`);
    assert.strictEqual(terminalShellPath(ID), `/workspace/${ID}/.pi-agent/scotty-shell`);
    assert.deepStrictEqual(agentEnv(ID, credential), {
      CODEX_HOME: `/workspace/${ID}/.codex`,
      PI_CODING_AGENT_DIR: `/workspace/${ID}/.pi-agent`,
      SCOTTY_SESSION_ID: ID,
      GIT_CONFIG_GLOBAL: `/workspace/${ID}/.pi-agent/gitconfig`,
      GH_TOKEN: GITHUB_SENTINEL,
      GITHUB_SENTINEL,
      GIT_TERMINAL_PROMPT: "0",
      NODE_OPTIONS: "--use-system-ca",
      GOTOOLCHAIN: "auto",
      GOPROXY: "https://proxy.golang.org",
      GOSUMDB: "sum.golang.org",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
  });

  it("does not impose a bundled browser or frontend screenshot gate", () => {
    assert.ok(!sandboxAgentsInstructions.includes("before/after screenshots"));
    assert.ok(!sandboxAgentsInstructions.includes("screenshot blocker"));
    assert.ok(!sandboxAgentsInstructions.includes("agent-browser"));
  });

  it("teaches concise meaningful checkpoints and exact deduplicated Scotty references", () => {
    assert.include(sandboxAgentsInstructions, "meaningful new evidence");
    assert.include(sandboxAgentsInstructions, "a completed implementation slice");
    assert.include(sandboxAgentsInstructions, "a verification result");
    assert.include(sandboxAgentsInstructions, "a blocker");
    assert.include(sandboxAgentsInstructions, "scotty-evidence:<jobId>");
    assert.include(sandboxAgentsInstructions, "scotty-hatch:<hatchId>");
    assert.include(sandboxAgentsInstructions, "at most once");
    assert.include(sandboxAgentsInstructions, "same conversation as the update");
    assert.include(sandboxAgentsInstructions, "call the relevant status or evidence tool again");
    assert.include(sandboxAgentsInstructions, "If that tool fails or returns no reference");
    assert.include(sandboxAgentsInstructions, "Never invent, alter, expand, or repeat");
    assert.include(sandboxAgentsInstructions, "Identify the required work before acting.");
    assert.include(
      sandboxAgentsInstructions,
      "Keep a short ordered checklist in progress updates.",
    );
    assert.include(sandboxAgentsInstructions, "Complete prerequisites before dependents.");
    assert.include(
      sandboxAgentsInstructions,
      "Use subagents only for independent parallel work; the parent owns integration and verification.",
    );
    assert.include(sandboxAgentsInstructions, "Do not claim that a durable task store exists.");
    assert.include(sandboxAgentsInstructions, "Use no more than four concurrent subagents.");
  });
});

describe("ContainerAuth", () => {
  it.effect("seeds exact paths, contents, modes, environment, and ordering", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities);
      assert.deepStrictEqual(
        capabilities.calls.map((call) => call.operation),
        [
          "mkdir",
          "mkdir",
          "writeFile",
          "writeFile",
          "writeFile",
          "writeFile",
          "writeFile",
          "writeFile",
          "writeFile",
          "writeFile",
          "exec",
          "setEnvVars",
          "exec",
        ],
      );
      const writes = capabilities.calls.filter(
        (call): call is Extract<ContainerCall, { operation: "writeFile" }> =>
          call.operation === "writeFile",
      );
      assert.deepStrictEqual(
        writes.map((write) => write.path),
        [
          `/workspace/${ID}/.codex/config.toml`,
          `/workspace/${ID}/.codex/AGENTS.md`,
          `/workspace/${ID}/.pi-agent/auth.json`,
          `/workspace/${ID}/.pi-agent/settings.json`,
          `/workspace/${ID}/.pi-agent/AGENTS.md`,
          `/workspace/${ID}/.pi-agent/web-search.json`,
          `/workspace/${ID}/.pi-agent/gitconfig`,
          `/workspace/${ID}/.pi-agent/scotty-shell`,
        ],
      );
      assert.deepStrictEqual(
        JSON.parse(writes[2]?.content ?? ""),
        JSON.parse(piAuthJson(credential)),
      );
      assert.deepInclude(JSON.parse(writes[3]?.content ?? ""), {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
        theme: "dark",
        packages: [...PI_PACKAGES],
      });
      assert.deepStrictEqual(JSON.parse(writes[5]?.content ?? ""), {
        provider: "openai",
        workflow: "none",
        allowBrowserCookies: false,
      });
      assert.ok(writes[6]?.content.includes("password=$GITHUB_SENTINEL"));
      assert.ok(writes[7]?.content.includes(`export SCOTTY_SESSION_ID='${ID}'`));
      assert.ok(
        writes[7]?.content.includes(`export PI_CODING_AGENT_DIR='/workspace/${ID}/.pi-agent'`),
      );
      assert.ok(writes[7]?.content.includes("exec /usr/local/bin/scotty-pi-shell"));
      for (const secret of [REAL_ACCESS, REAL_REFRESH, REAL_GITHUB, REAL_ACCOUNT, REAL_API_KEY])
        assert.ok(!writes[7]?.content.includes(secret));

      const skillsExec = chmodExecCommand(capabilities.calls);
      const merged = mergedSkillsPath(ID);
      assert.include(skillsExec, `mkdir -p '${merged}'`);
      assert.include(skillsExec, `ln -sfn /opt/scotty/skills/* '${merged}/'`);
      assert.include(skillsExec, `ln -sfn '${merged}' '/workspace/${ID}/.codex/skills'`);
      assert.include(skillsExec, `ln -sfn '${merged}' '/workspace/${ID}/.pi-agent/skills'`);
      assert.notInclude(skillsExec, `ln -sfn /opt/scotty/skills '/workspace/${ID}/.codex/skills'`);
      assert.notInclude(
        skillsExec,
        `ln -sfn /opt/scotty/skills '/workspace/${ID}/.pi-agent/skills'`,
      );
    }),
  );

  it.effect("seeds merged skills and additive Pi packages from installation extras", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      yield* seedWith(capabilities, credential, {
        bundleRoot,
        extraSkills: [{ name: "custom-skill" }],
        extraPackages: [{ name: "custom-package" }, { name: "@scope/custom-package" }],
      });
      const writes = capabilities.calls.filter(
        (call): call is Extract<ContainerCall, { operation: "writeFile" }> =>
          call.operation === "writeFile",
      );
      assert.deepInclude(JSON.parse(writes[3]?.content ?? ""), {
        packages: [
          ...PI_PACKAGES,
          `${bundleRoot}/pi-packages/custom-package`,
          `${bundleRoot}/pi-packages/@scope/custom-package`,
        ],
      });
      const skillsExec = chmodExecCommand(capabilities.calls);
      assert.include(
        skillsExec,
        `ln -sfn '${bundleRoot}/skills/custom-skill' '/workspace/${ID}/.scotty/merged-skills/custom-skill'`,
      );
    }),
  );

  it.effect("replays extra skill links when the target already points at the bundle skill", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      const options = {
        bundleRoot,
        extraSkills: [{ name: "custom-skill" }],
      };
      yield* seedWith(capabilities, credential, options);
      yield* seedWith(capabilities, credential, options);
      const skillsExec = chmodExecCommand(capabilities.calls);
      const target = `${mergedSkillsPath(ID)}/custom-skill`;
      const source = `${bundleRoot}/skills/custom-skill`;
      assert.include(
        skillsExec,
        `{ [ ! -e '${target}' ] || [ "$(readlink '${target}')" = '${source}' ]; } && ln -sfn '${source}' '${target}'`,
      );
      assert.notInclude(skillsExec, `test ! -e '${target}'`);
    }),
  );

  it.effect("fails closed when an extra skill collides with a merged entry", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      const merged = mergedSkillsPath(ID);
      const collisionCommand = `readlink '${merged}/impeccable'`;
      capabilities.execFailWhen = (command) => command.includes(collisionCommand);
      const error = failed(
        yield* Effect.result(
          seedWith(capabilities, credential, {
            bundleRoot,
            extraSkills: [{ name: "impeccable" }],
          }),
        ),
      );
      assert.deepStrictEqual(error.reason, "nonzero_exit");
      assert.include(chmodExecCommand(capabilities.calls), collisionCommand);
    }),
  );

  it.effect("preflight accepts settings written by seed", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      const options = {
        bundleRoot,
        extraSkills: [{ name: "custom-skill" }],
        extraPackages: [{ name: "@scope/custom-package" }],
      };
      yield* seedWith(capabilities, credential, options);
      yield* preflightWith(capabilities, credential, options);
    }),
  );

  it.effect("preserves seeded extra Pi packages when ensurePiSession refreshes auth", () =>
    Effect.gen(function* () {
      const capabilities = new ProcessSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      yield* seedWith(capabilities, credential, {
        bundleRoot,
        extraPackages: [{ name: "custom-package" }],
      });
      yield* piSessionWith(capabilities, "ensure");
      const settingsWrites = capabilities.calls.filter(
        (call): call is Extract<ContainerCall, { operation: "writeFile" }> =>
          call.operation === "writeFile" &&
          call.path === `/workspace/${ID}/.pi-agent/settings.json`,
      );
      const lastSettingsWrite = settingsWrites.at(-1);
      assert.ok(lastSettingsWrite);
      assert.deepInclude(JSON.parse(lastSettingsWrite.content), {
        packages: [...PI_PACKAGES, `${bundleRoot}/pi-packages/custom-package`],
      });
    }),
  );

  it.effect("preflight rejects an extra package path outside the bundle root", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      const settingsPath = `/workspace/${ID}/.pi-agent/settings.json`;
      capabilities.files.set(
        settingsPath,
        new TextEncoder().encode(
          JSON.stringify({
            packages: [...PI_PACKAGES, `${bundleRoot}/pi-packages/custom-package`],
          }),
        ),
      );
      const error = failed(
        yield* Effect.result(
          preflightWith(capabilities, credential, {
            bundleRoot,
            extraPackages: [{ name: "../outside" }],
          }),
        ),
      );
      assert.deepStrictEqual(
        error,
        new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sandbox extra package path is outside the bundle root",
        }),
      );
      assert.ok(
        !capabilities.calls.some(
          (call) => call.operation === "exec" && call.command.includes("../outside"),
        ),
      );
    }),
  );

  it.effect("maps every capability rejection to a fixed typed redacted failure", () =>
    Effect.gen(function* () {
      for (const [operation, message] of [
        ["mkdir", "Sandbox directory transport failed"],
        ["writeFile", "Sandbox file transport failed"],
        ["exec", "Sandbox command transport failed"],
        ["setEnvVars", "Sandbox environment transport failed"],
      ] as const) {
        const capabilities = new CapturingSandboxCapabilities();
        capabilities.reject = operation;
        const error = failed(yield* Effect.result(seedWith(capabilities)));
        assert.deepStrictEqual(error, new SandboxRuntimeFailure({ reason: "transport", message }));
        assert.ok(!JSON.stringify(error).includes("provider"));
        assert.strictEqual(capabilities.calls.at(-1)?.operation, operation);
      }
    }),
  );

  it.effect("reuses an executable terminal wrapper and repairs a missing one", () =>
    Effect.gen(function* () {
      const existing = new CapturingSandboxCapabilities();
      yield* ensureTerminalWith(existing);
      assert.deepStrictEqual(
        existing.calls.map((call) => call.operation),
        ["exec"],
      );
      assert.strictEqual(
        (existing.calls[0] as Extract<ContainerCall, { operation: "exec" }>).command,
        `test -x '${terminalShellPath(ID)}'`,
      );

      const missing = new CapturingSandboxCapabilities();
      missing.terminalShellMissing = true;
      yield* ensureTerminalWith(missing);
      assert.deepStrictEqual(
        missing.calls.slice(0, 2).map((call) => call.operation),
        ["exec", "mkdir"],
      );
      assert.ok(
        missing.calls.some(
          (call) =>
            call.operation === "writeFile" &&
            call.path === terminalShellPath(ID) &&
            call.content.includes(`export SCOTTY_SESSION_ID='${ID}'`),
        ),
      );
    }),
  );

  it.effect("starts one ready Pi RPC session, reuses it, and stops it cleanly", () =>
    Effect.gen(function* () {
      const capabilities = new ProcessSandboxCapabilities();
      yield* piSessionWith(capabilities, "ensure");
      const authWriteIndex = capabilities.calls.findIndex(
        (call) =>
          call.operation === "writeFile" && call.path === `/workspace/${ID}/.pi-agent/auth.json`,
      );
      const settingsWriteIndex = capabilities.calls.findIndex(
        (call) =>
          call.operation === "writeFile" &&
          call.path === `/workspace/${ID}/.pi-agent/settings.json`,
      );
      const authModeIndex = capabilities.calls.findIndex(
        (call) =>
          call.operation === "exec" &&
          call.command.includes(`chmod 600 '/workspace/${ID}/.pi-agent/auth.json'`),
      );
      const startIndex = capabilities.calls.findIndex((call) => call.operation === "startProcess");
      assert.ok(authWriteIndex >= 0);
      assert.ok(settingsWriteIndex > authWriteIndex);
      assert.ok(authModeIndex > settingsWriteIndex);
      assert.ok(startIndex > authModeIndex);
      const start = capabilities.calls.find(
        (call): call is Extract<ContainerCall, { operation: "startProcess" }> =>
          call.operation === "startProcess",
      );
      assert.strictEqual(start?.command, "/usr/local/bin/scotty-pi-session");
      assert.deepInclude(start?.options, {
        autoCleanup: true,
        cwd: `/workspace/${ID}`,
        processId: PI_SESSION_PROCESS_ID,
      });
      assert.strictEqual(start?.options?.env?.SCOTTY_PI_SESSION_PORT, String(PI_SESSION_PORT));
      assert.ok(start?.options?.env?.SCOTTY_PI_SESSION_TOKEN_FILE?.endsWith(".token"));
      assert.strictEqual(start?.options?.env?.GH_TOKEN, GITHUB_SENTINEL);
      assert.ok(!JSON.stringify(start).includes(REAL_GITHUB));
      assert.ok(
        capabilities.calls.some(
          (call) => call.operation === "waitForPort" && call.port === PI_SESSION_PORT,
        ),
      );
      assert.ok(
        capabilities.calls.some(
          (call) =>
            call.operation === "fetchPort" &&
            call.path === "/health" &&
            call.port === PI_SESSION_PORT &&
            call.method === "GET",
        ),
      );

      const startCount = capabilities.calls.filter(
        (call) => call.operation === "startProcess",
      ).length;
      yield* piSessionWith(capabilities, "ensure");
      assert.strictEqual(
        capabilities.calls.filter((call) => call.operation === "startProcess").length,
        startCount,
      );

      yield* piSessionWith(capabilities, "quiesce");
      assert.ok(
        capabilities.calls.some(
          (call) =>
            call.operation === "fetchPort" &&
            call.path === "/quiesce" &&
            call.port === PI_SESSION_PORT &&
            call.method === "POST" &&
            typeof call.headers?.["x-scotty-pi-session"] === "string",
        ),
      );

      yield* piSessionWith(capabilities, "stop");
      assert.ok(
        capabilities.calls.some(
          (call) => call.operation === "killProcess" && call.signal === "SIGTERM",
        ),
      );
      assert.strictEqual(capabilities.process, null);
    }),
  );

  it.effect("rejects a Pi session whose mapped port is unreachable", () =>
    Effect.gen(function* () {
      const capabilities = new ProcessSandboxCapabilities();
      capabilities.fetchPortResponseStatus = 503;

      const error = failed(yield* Effect.result(piSessionWith(capabilities, "ensure")));

      assert.deepStrictEqual(
        error,
        new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Pi session mapped port health check failed",
        }),
      );
      assert.ok(
        capabilities.calls.some(
          (call) =>
            call.operation === "fetchPort" &&
            call.path === "/health" &&
            call.port === PI_SESSION_PORT,
        ),
      );
    }),
  );

  it.effect("reconstructs the service without retaining runtime capability state", () =>
    Effect.gen(function* () {
      const first = new CapturingSandboxCapabilities();
      const second = new CapturingSandboxCapabilities();
      yield* seedWith(first);
      yield* seedWith(second);
      assert.strictEqual(first.calls.length, 13);
      assert.strictEqual(second.calls.length, 13);
      assert.notStrictEqual(first.calls, second.calls);
      assert.deepStrictEqual(first.calls, second.calls);
    }),
  );

  it.effect("keeps real credential honeypots out of every captured container surface", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities);
      const surfaces = JSON.stringify(capabilities.calls);

      for (const secret of [
        REAL_ACCESS,
        REAL_REFRESH,
        REAL_GITHUB,
        REAL_ACCOUNT,
        "honeypot-real-id-token",
      ]) {
        assert.ok(!surfaces.includes(secret));
      }
      assert.ok(surfaces.includes(PI_SENTINEL));
      assert.ok(surfaces.includes(GITHUB_SENTINEL));
      assert.ok(surfaces.includes(".scotty"));
    }),
  );

  it.effect("replaces API-key seed material in Pi auth JSON", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities, apiKeyCredential);
      const surfaces = JSON.stringify(capabilities.calls);

      assert.ok(!surfaces.includes(REAL_API_KEY));
      assert.deepStrictEqual(JSON.parse(piAuthJson(apiKeyCredential)), {
        openai: {
          type: "api_key",
          key: PI_SENTINEL,
        },
      });
      assert.deepStrictEqual(agentEnv(ID, apiKeyCredential), {
        CODEX_HOME: `/workspace/${ID}/.codex`,
        PI_CODING_AGENT_DIR: `/workspace/${ID}/.pi-agent`,
        SCOTTY_SESSION_ID: ID,
        GIT_CONFIG_GLOBAL: `/workspace/${ID}/.pi-agent/gitconfig`,
        GH_TOKEN: GITHUB_SENTINEL,
        GITHUB_SENTINEL,
        GIT_TERMINAL_PROMPT: "0",
        NODE_OPTIONS: "--use-system-ca",
        GOTOOLCHAIN: "auto",
        GOPROXY: "https://proxy.golang.org",
        GOSUMDB: "sum.golang.org",
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      });
    }),
  );
});
