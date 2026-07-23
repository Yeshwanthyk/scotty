import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Result } from "effect";
import { agentEnv, ContainerAuth, containerAuthLayer } from "../src/container-auth";
import { sentinelAuthJson, type StoredCredential } from "../src/egress";
import {
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  type SandboxExecOptions,
  type SandboxRuntimeCapabilities,
  type SandboxSessionOptions,
} from "../src/sandbox-runtime";
import { sessionRoot } from "../src/workspace";

const ID = "a0b1c2d3e4f5";
const CODEX_SENTINEL = `scotty-codex-${ID}-sentinel`;
const GITHUB_SENTINEL = `scotty-github-${ID}-sentinel`;
const REAL_ACCESS = "honeypot-real-codex-access";
const REAL_REFRESH = "honeypot-real-codex-refresh";
const REAL_GITHUB = "honeypot-real-github-token";
const REAL_ACCOUNT = "honeypot-real-account";
const REAL_API_KEY = "honeypot-real-api-key";

const credential: StoredCredential = {
  codex: {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "honeypot-real-id-token",
      access_token: REAL_ACCESS,
      refresh_token: REAL_REFRESH,
      account_id: REAL_ACCOUNT,
    },
    account_id: null,
    last_refresh: "2026-07-22T01:02:03.000Z",
  },
  githubToken: REAL_GITHUB,
  codexSentinel: CODEX_SENTINEL,
  githubSentinel: GITHUB_SENTINEL,
  updatedAt: "2026-07-22T01:02:03.000Z",
};

const apiKeyCredential: StoredCredential = {
  ...credential,
  codex: {
    ...credential.codex,
    OPENAI_API_KEY: REAL_API_KEY,
    tokens: undefined,
  },
};

type ContainerCall =
  | { readonly operation: "mkdir"; readonly path: string; readonly recursive?: boolean }
  | { readonly operation: "writeFile"; readonly path: string; readonly content: string }
  | { readonly operation: "exec"; readonly command: string; readonly options?: SandboxExecOptions }
  | {
      readonly operation: "setEnvVars";
      readonly envVars: Record<string, string | undefined>;
    };

class CapturingSandboxCapabilities implements SandboxRuntimeCapabilities {
  readonly calls: ContainerCall[] = [];
  reject?: ContainerCall["operation"];

  exec = (command: string, options?: SandboxExecOptions): Promise<ExecResult> => {
    this.calls.push({ operation: "exec", command, options });
    if (this.reject === "exec") return Promise.reject("provider exec secret");
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

  createSession = (_options: SandboxSessionOptions): Promise<void> => Promise.resolve();

  deleteSession = (_sessionId: string): Promise<void> => Promise.resolve();

  mkdir = (path: string, options?: { readonly recursive?: boolean }): Promise<unknown> => {
    this.calls.push({ operation: "mkdir", path, recursive: options?.recursive });
    if (this.reject === "mkdir") return Promise.reject("provider mkdir secret");
    return Promise.resolve({ success: true, path });
  };

  writeFile = (path: string, content: string): Promise<unknown> => {
    this.calls.push({ operation: "writeFile", path, content });
    if (this.reject === "writeFile") return Promise.reject("provider write secret");
    return Promise.resolve({ success: true, path, bytesWritten: content.length });
  };

  setEnvVars = (envVars: Record<string, string | undefined>): Promise<void> => {
    this.calls.push({ operation: "setEnvVars", envVars });
    if (this.reject === "setEnvVars") return Promise.reject("provider env secret");
    return Promise.resolve();
  };
}

const seedWith = (
  capabilities: SandboxRuntimeCapabilities,
  storedCredential: StoredCredential = credential,
) => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = containerAuthLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.flatMap(ContainerAuth, (auth) => auth.seed(ID, storedCredential)).pipe(
    Effect.provide(layer),
  );
};

const failed = <A>(result: Result.Result<A, SandboxRuntimeFailure>): SandboxRuntimeFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("container auth values", () => {
  it("constructs the exact session path and agent environment", () => {
    assert.strictEqual(sessionRoot(ID), `/workspace/${ID}`);
    assert.deepStrictEqual(agentEnv(ID, credential), {
      CODEX_HOME: `/workspace/${ID}/.codex`,
      OPENAI_API_KEY: CODEX_SENTINEL,
      GH_TOKEN: GITHUB_SENTINEL,
      GITHUB_SENTINEL,
      GIT_TERMINAL_PROMPT: "0",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
  });
});

describe("ContainerAuth", () => {
  it.effect("seeds exact paths, contents, modes, environment, and ordering", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities);
      const expectedAuth = sentinelAuthJson(credential);

      assert.deepStrictEqual(capabilities.calls, [
        {
          operation: "mkdir",
          path: `/workspace/${ID}/.codex`,
          recursive: true,
        },
        {
          operation: "writeFile",
          path: `/workspace/${ID}/.codex/auth.json`,
          content: expectedAuth,
        },
        {
          operation: "writeFile",
          path: `/workspace/${ID}/.codex/config.toml`,
          content: `[features]
plugins = false

[mcp_servers]

[projects."/workspace/${ID}"]
trust_level = "trusted"
`,
        },
        {
          operation: "exec",
          command: `chmod 700 '/workspace/${ID}/.codex' && chmod 600 '/workspace/${ID}/.codex/auth.json' '/workspace/${ID}/.codex/config.toml'`,
          options: undefined,
        },
        {
          operation: "setEnvVars",
          envVars: agentEnv(ID, credential),
        },
      ]);

      assert.deepStrictEqual(JSON.parse(expectedAuth), {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token:
            "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoic2NvdHR5LXNlbnRpbmVsIiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJ1bmtub3duIn19.scotty",
          access_token: CODEX_SENTINEL,
          refresh_token: CODEX_SENTINEL,
          account_id: CODEX_SENTINEL,
        },
        last_refresh: "2026-07-22T01:02:03.000Z",
      });
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

  it.effect("reconstructs the service without retaining runtime capability state", () =>
    Effect.gen(function* () {
      const first = new CapturingSandboxCapabilities();
      const second = new CapturingSandboxCapabilities();
      yield* seedWith(first);
      yield* seedWith(second);
      assert.strictEqual(first.calls.length, 5);
      assert.strictEqual(second.calls.length, 5);
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
      assert.ok(surfaces.includes(CODEX_SENTINEL));
      assert.ok(surfaces.includes(GITHUB_SENTINEL));
      assert.ok(surfaces.includes(".scotty"));
    }),
  );

  it.effect("replaces API-key seed material in both auth JSON and environment", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingSandboxCapabilities();
      yield* seedWith(capabilities, apiKeyCredential);
      const surfaces = JSON.stringify(capabilities.calls);

      assert.ok(!surfaces.includes(REAL_API_KEY));
      assert.deepStrictEqual(JSON.parse(sentinelAuthJson(apiKeyCredential)), {
        auth_mode: "apikey",
        OPENAI_API_KEY: CODEX_SENTINEL,
        tokens: null,
        last_refresh: "2026-07-22T01:02:03.000Z",
      });
      assert.deepStrictEqual(agentEnv(ID, apiKeyCredential), {
        CODEX_HOME: `/workspace/${ID}/.codex`,
        OPENAI_API_KEY: CODEX_SENTINEL,
        GH_TOKEN: GITHUB_SENTINEL,
        GITHUB_SENTINEL,
        GIT_TERMINAL_PROMPT: "0",
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      });
    }),
  );
});
