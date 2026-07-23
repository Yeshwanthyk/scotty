import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import { Agent, type AgentLaunch, agentLayer } from "../src/agent";
import { launchAgentRuntimeCommand, resetAgentRuntimeCommand } from "../src/agent-runtime";
import { agentEnv } from "../src/container-auth";
import {
  credentialVaultLayer,
  type CredentialVaultStorage,
  type CredentialVaultTransaction,
} from "../src/credential-vault";
import type { StoredCredential } from "../src/egress";
import {
  sandboxRuntimeLayer,
  shellQuote,
  type SandboxExecOptions,
  type SandboxRuntimeCapabilities,
  type SandboxSessionOptions,
} from "../src/sandbox-runtime";

const ID = "a0b1c2d3e4f5";
const CODEX_SENTINEL = `scotty-codex-${ID}-sentinel`;
const GITHUB_SENTINEL = `scotty-github-${ID}-sentinel`;
const HONEYPOTS = {
  access: "honeypot-real-codex-access",
  refresh: "honeypot-real-codex-refresh",
  github: "honeypot-real-github-token",
  account: "honeypot-real-account",
} as const;

const credential: StoredCredential = {
  codex: {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "honeypot-real-id-token",
      access_token: HONEYPOTS.access,
      refresh_token: HONEYPOTS.refresh,
      account_id: HONEYPOTS.account,
    },
    account_id: null,
    last_refresh: "2026-07-22T01:02:03.000Z",
  },
  githubToken: HONEYPOTS.github,
  codexSentinel: CODEX_SENTINEL,
  githubSentinel: GITHUB_SENTINEL,
  updatedAt: "2026-07-22T01:02:03.000Z",
};

type AgentCall =
  | { readonly operation: "exec"; readonly command: string; readonly options?: SandboxExecOptions }
  | { readonly operation: "deleteSession"; readonly sessionId: string }
  | { readonly operation: "createSession"; readonly options: SandboxSessionOptions };

class CapturingAgentCapabilities implements SandboxRuntimeCapabilities {
  readonly calls: AgentCall[] = [];
  reject?: AgentCall["operation"];

  exec = (command: string, options?: SandboxExecOptions): Promise<ExecResult> => {
    this.calls.push({ operation: "exec", command, options });
    if (this.reject === "exec") return Promise.reject("provider command honeypot-secret");
    return Promise.resolve(success(command));
  };

  createSession = (options: SandboxSessionOptions): Promise<void> => {
    this.calls.push({ operation: "createSession", options });
    if (this.reject === "createSession") return Promise.reject("provider create honeypot-secret");
    return Promise.resolve();
  };

  deleteSession = (sessionId: string): Promise<void> => {
    this.calls.push({ operation: "deleteSession", sessionId });
    if (this.reject === "deleteSession") return Promise.reject("provider delete honeypot-secret");
    return Promise.resolve();
  };

  mkdir = (): Promise<void> => Promise.resolve();
  writeFile = (): Promise<void> => Promise.resolve();
  setEnvVars = (): Promise<void> => Promise.resolve();
}

class StoredCredentialStorage implements CredentialVaultStorage {
  constructor(private value: StoredCredential = credential) {}

  transaction = <A>(
    operation: (transaction: CredentialVaultTransaction) => Promise<A>,
  ): Promise<A> =>
    operation({
      get: () => Promise.resolve(this.value),
      put: (next) => {
        this.value = next;
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    });
}

const success = (command: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  command,
  duration: 1,
  timestamp: "2026-07-22T01:02:03.000Z",
});

const launchWith = (
  capabilities: SandboxRuntimeCapabilities,
  launch: AgentLaunch,
  fakeAgent = false,
) => {
  const dependencies = Layer.merge(
    sandboxRuntimeLayer(capabilities),
    credentialVaultLayer(new StoredCredentialStorage(), HONEYPOTS.github),
  );
  const layer = agentLayer(fakeAgent).pipe(Layer.provide(dependencies));
  return Effect.flatMap(Agent, (agent) => agent.launch(ID, launch)).pipe(Effect.provide(layer));
};

const expectedCalls = (agentCommand: string): AgentCall[] => {
  const env = agentEnv(ID, credential);
  return [
    {
      operation: "exec",
      command: resetAgentRuntimeCommand(),
      options: { env, timeout: 10_000 },
    },
    {
      operation: "exec",
      command: launchAgentRuntimeCommand(`/workspace/${ID}`, agentCommand),
      options: { env, timeout: 30_000 },
    },
  ];
};

describe("Agent", () => {
  it.effect("launches fake, initial, resume-ID, and resume-last commands exactly", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [AgentLaunch, boolean, string]> = [
        [
          { kind: "start", prompt: "ignored by fake" },
          true,
          `printf '\\033[1;36mScotty fake agent ready\\033[0m\\n'; exec bash`,
        ],
        [
          { kind: "start", prompt: "fix tests" },
          false,
          "exec codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox 'fix tests'",
        ],
        [
          { kind: "resume", threadId: "thread-123" },
          false,
          "exec codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume 'thread-123'",
        ],
        [
          { kind: "resume" },
          false,
          "exec codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume --last",
        ],
      ];

      for (const [launch, fakeAgent, command] of cases) {
        const capabilities = new CapturingAgentCapabilities();
        yield* launchWith(capabilities, launch, fakeAgent);
        assert.deepStrictEqual(capabilities.calls, expectedCalls(command));
      }
    }),
  );

  it.effect("quotes hostile prompts and captured thread IDs through both shell levels", () =>
    Effect.gen(function* () {
      const hostilePrompt = `'; touch /tmp/prompt-pwned; printf '`;
      const hostileThread = `'; touch /tmp/thread-pwned; printf '`;
      for (const [launch, command] of [
        [
          { kind: "start", prompt: hostilePrompt },
          `exec codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox ${shellQuote(hostilePrompt)}`,
        ],
        [
          { kind: "resume", threadId: hostileThread },
          `exec codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume ${shellQuote(hostileThread)}`,
        ],
      ] satisfies ReadonlyArray<readonly [AgentLaunch, string]>) {
        const capabilities = new CapturingAgentCapabilities();
        yield* launchWith(capabilities, launch);
        assert.deepStrictEqual(capabilities.calls, expectedCalls(command));
      }
    }),
  );

  it.effect("reconstructs the service without retaining capability state", () =>
    Effect.gen(function* () {
      const first = new CapturingAgentCapabilities();
      const second = new CapturingAgentCapabilities();
      yield* launchWith(first, { kind: "resume", threadId: "thread-123" });
      yield* launchWith(second, { kind: "resume", threadId: "thread-123" });
      assert.notStrictEqual(first.calls, second.calls);
      assert.deepStrictEqual(first.calls, second.calls);
    }),
  );

  it.effect("keeps real credential honeypots out of commands, env, and session options", () =>
    Effect.gen(function* () {
      const capabilities = new CapturingAgentCapabilities();
      yield* launchWith(capabilities, { kind: "start", prompt: "safe prompt" });
      const surfaces = JSON.stringify(capabilities.calls);

      for (const secret of [...Object.values(HONEYPOTS), "honeypot-real-id-token"]) {
        assert.ok(!surfaces.includes(secret));
      }
      assert.ok(surfaces.includes(CODEX_SENTINEL));
      assert.ok(surfaces.includes(GITHUB_SENTINEL));
    }),
  );
});
