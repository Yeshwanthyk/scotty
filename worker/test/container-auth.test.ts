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
const GH_TOKEN_SENTINEL = `scotty-env-${ID}-${"a".repeat(32)}`;
const ENVIRONMENT = {
  version: 1 as const,
  revision: 1,
  variables: { GH_TOKEN: GH_TOKEN_SENTINEL },
};
const PI_SESSION_TRANSPORT_TOKEN = "c".repeat(64);
const REAL_GITHUB = "honeypot-real-github-token";
const PI_SETTINGS: NonNullable<ContainerAuthSeedOptions["pi"]> = {
  defaultProvider: "openai",
  defaultModel: "gpt-5.6-sol",
  defaultThinkingLevel: "medium",
  theme: "dark",
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

const seedWith = (capabilities: SandboxRuntimeCapabilities, options?: ContainerAuthSeedOptions) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) =>
    auth.seed(ID, { environment: ENVIRONMENT, pi: PI_SETTINGS, ...options }),
  ).pipe(Effect.provide(layer));
};

const preflightWith = (
  capabilities: SandboxRuntimeCapabilities,
  options?: ContainerAuthSeedOptions,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => auth.preflight(ID, options)).pipe(
    Effect.provide(layer),
  );
};

const chmodExecCommand = (calls: ContainerCall[]): string => {
  const exec = calls.find(
    (call): call is Extract<ContainerCall, { operation: "exec" }> =>
      call.operation === "exec" && call.command.includes("chmod 700"),
  );
  assert.ok(exec);
  return exec.command;
};

const ghIdentityExec = (calls: ContainerCall[]) => {
  const exec = calls.find(
    (call): call is Extract<ContainerCall, { operation: "exec" }> =>
      call.operation === "exec" && call.command.includes("gh api user"),
  );
  assert.ok(exec);
  return exec;
};

const fallbackIdentityExec = (calls: ContainerCall[]) => {
  const exec = calls.find(
    (call): call is Extract<ContainerCall, { operation: "exec" }> =>
      call.operation === "exec" && call.command.includes('config user.name "Scotty Session"'),
  );
  assert.ok(exec);
  return exec;
};

const ensureTerminalWith = (capabilities: SandboxRuntimeCapabilities) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => auth.ensureTerminal(ID, ENVIRONMENT)).pipe(
    Effect.provide(layer),
  );
};

const piSessionWith = (
  capabilities: SandboxRuntimeCapabilities,
  operation: "ensure" | "quiesce" | "stop",
  transportToken = PI_SESSION_TRANSPORT_TOKEN,
  environment = ENVIRONMENT,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => {
    if (operation === "ensure") return auth.ensurePiSession(ID, transportToken, environment);
    if (operation === "quiesce") return auth.quiescePiSession(ID, transportToken);
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
    assert.deepStrictEqual(agentEnv(ID, ENVIRONMENT), {
      PI_CODING_AGENT_DIR: `/workspace/${ID}/.pi-agent`,
      SCOTTY_SESSION_ID: ID,
      GIT_CONFIG_GLOBAL: `/workspace/${ID}/.pi-agent/gitconfig`,
      GH_TOKEN: GH_TOKEN_SENTINEL,
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
  it.effect("seeds only pinned Pi configuration and resources", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities);
      assert.deepStrictEqual(
        capabilities.calls.map((call) => call.operation),
        ["mkdir", "writeFile", "writeFile", "writeFile", "writeFile", "exec", "setEnvVars", "exec"],
      );
      const writes = capabilities.calls.filter(
        (call): call is Extract<ContainerCall, { operation: "writeFile" }> =>
          call.operation === "writeFile",
      );
      assert.deepStrictEqual(
        writes.map((write) => write.path),
        [
          `/workspace/${ID}/.pi-agent/settings.json`,
          `/workspace/${ID}/.pi-agent/AGENTS.md`,
          `/workspace/${ID}/.pi-agent/gitconfig`,
          `/workspace/${ID}/.pi-agent/scotty-shell`,
        ],
      );
      assert.deepInclude(JSON.parse(writes[0]?.content ?? ""), {
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-sol",
        theme: "dark",
        packages: [],
      });
      assert.ok(writes[2]?.content.includes("password=$GH_TOKEN"));
      assert.ok(writes[3]?.content.includes(`export SCOTTY_SESSION_ID='${ID}'`));
      assert.ok(
        writes[3]?.content.includes(`export PI_CODING_AGENT_DIR='/workspace/${ID}/.pi-agent'`),
      );
      assert.ok(writes[3]?.content.includes("exec /usr/local/bin/scotty-pi-shell"));
      assert.ok(!writes[3]?.content.includes(REAL_GITHUB));

      const skillsExec = chmodExecCommand(capabilities.calls);
      const merged = mergedSkillsPath(ID);
      assert.include(skillsExec, `mkdir -p '${merged}'`);
      assert.include(skillsExec, `ln -sfn '${merged}' '/workspace/${ID}/.pi-agent/skills'`);
      assert.notInclude(
        skillsExec,
        `ln -sfn /opt/scotty/skills '/workspace/${ID}/.pi-agent/skills'`,
      );

      const expectedEnv = agentEnv(ID, ENVIRONMENT);
      const setEnv = capabilities.calls.find(
        (call): call is Extract<ContainerCall, { operation: "setEnvVars" }> =>
          call.operation === "setEnvVars",
      );
      assert.deepStrictEqual(setEnv?.envVars, expectedEnv);
      const ghExec = ghIdentityExec(capabilities.calls);
      assert.deepStrictEqual(ghExec.options, { env: expectedEnv, timeout: 20_000 });
      assert.notInclude(
        capabilities.calls.filter((call) => call.operation === "exec").map((call) => call.command),
        `config user.name "Scotty Session"`,
      );
    }),
  );

  it.effect("falls back to a deterministic git identity when gh lookup fails", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      capabilities.execFailWhen = (command) => command.includes("gh api user");
      yield* seedWith(capabilities);
      const ghExec = ghIdentityExec(capabilities.calls);
      assert.deepStrictEqual(ghExec.options, {
        env: agentEnv(ID, ENVIRONMENT),
        timeout: 20_000,
      });
      const fallbackExec = fallbackIdentityExec(capabilities.calls);
      assert.deepStrictEqual(fallbackExec.options, {
        env: agentEnv(ID, ENVIRONMENT),
        timeout: 10_000,
      });
      assert.include(
        fallbackExec.command,
        `config user.email "scotty-session-${ID}@users.noreply.github.com"`,
      );
    }),
  );

  it.effect("seeds only pinned extension and Skill paths from the active snapshot", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      const bundleRoot = `/workspace/${ID}/.scotty/sandbox/deadbeef`;
      const options = {
        bundleRoot,
        extensionPaths: [`${bundleRoot}/plugins/custom/index.ts`],
        skillPaths: [{ name: "custom-skill", path: `${bundleRoot}/plugins/custom-skill` }],
      };
      yield* seedWith(capabilities, options);
      yield* preflightWith(capabilities, options);
      const writes = capabilities.calls.filter(
        (call): call is Extract<ContainerCall, { operation: "writeFile" }> =>
          call.operation === "writeFile",
      );
      assert.deepInclude(JSON.parse(writes[0]?.content ?? ""), {
        packages: [],
        extensions: [`${bundleRoot}/plugins/custom/index.ts`],
        skills: [`${bundleRoot}/plugins/custom-skill`],
      });
      const skillsExec = chmodExecCommand(capabilities.calls);
      assert.include(
        skillsExec,
        `ln -sfn '${bundleRoot}/plugins/custom-skill' '/workspace/${ID}/.scotty/merged-skills/custom-skill'`,
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
      const startIndex = capabilities.calls.findIndex((call) => call.operation === "startProcess");
      assert.ok(startIndex >= 0);
      assert.ok(
        !capabilities.calls.some(
          (call) =>
            call.operation === "writeFile" &&
            call.path === `/workspace/${ID}/.pi-agent/settings.json`,
        ),
      );
      assert.ok(
        !capabilities.calls.some(
          (call) => call.operation === "writeFile" && call.path.endsWith("/.pi-agent/auth.json"),
        ),
      );
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
      assert.strictEqual(
        new TextDecoder().decode(capabilities.files.get(`/tmp/scotty-pi-session-${ID}.token`)),
        PI_SESSION_TRANSPORT_TOKEN,
      );
      assert.strictEqual(start?.options?.env?.GH_TOKEN, GH_TOKEN_SENTINEL);
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

  it.effect("uses the supplied environment GH_TOKEN sentinel per session", () =>
    Effect.gen(function* () {
      const first = new ProcessSandboxCapabilities();
      const second = new ProcessSandboxCapabilities();
      const alternateSentinel = `scotty-env-${ID}-${"b".repeat(32)}`;
      const alternateEnvironment = {
        ...ENVIRONMENT,
        variables: { GH_TOKEN: alternateSentinel },
      };

      yield* piSessionWith(first, "ensure", PI_SESSION_TRANSPORT_TOKEN);
      yield* piSessionWith(second, "ensure", PI_SESSION_TRANSPORT_TOKEN, alternateEnvironment);

      const tokenPath = `/tmp/scotty-pi-session-${ID}.token`;
      assert.strictEqual(
        new TextDecoder().decode(first.files.get(tokenPath)),
        PI_SESSION_TRANSPORT_TOKEN,
      );
      assert.strictEqual(
        new TextDecoder().decode(second.files.get(tokenPath)),
        PI_SESSION_TRANSPORT_TOKEN,
      );
      const firstStart = first.calls.find((call) => call.operation === "startProcess");
      const secondStart = second.calls.find((call) => call.operation === "startProcess");
      assert.strictEqual(
        firstStart?.operation === "startProcess" ? firstStart.options?.env?.GH_TOKEN : undefined,
        GH_TOKEN_SENTINEL,
      );
      assert.strictEqual(
        secondStart?.operation === "startProcess" ? secondStart.options?.env?.GH_TOKEN : undefined,
        alternateSentinel,
      );
      assert.notInclude(JSON.stringify(first.calls), REAL_GITHUB);
      assert.notInclude(JSON.stringify(second.calls), REAL_GITHUB);
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
      assert.strictEqual(first.calls.length, 8);
      assert.strictEqual(second.calls.length, 8);
      assert.notStrictEqual(first.calls, second.calls);
      assert.deepStrictEqual(first.calls, second.calls);
    }),
  );

  it.effect("keeps real credential honeypots out of every captured container surface", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities);
      const surfaces = JSON.stringify(capabilities.calls);

      assert.ok(!surfaces.includes(REAL_GITHUB));
      assert.ok(surfaces.includes(GH_TOKEN_SENTINEL));
      assert.ok(surfaces.includes(".scotty"));
    }),
  );
});
