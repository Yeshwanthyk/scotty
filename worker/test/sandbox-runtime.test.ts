import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Fiber, Result } from "effect";
import {
  errorName,
  SandboxRuntime,
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  shellQuote,
  type SandboxExecOptions,
  type SandboxRuntimeCapabilities,
  type SandboxSessionOptions,
} from "../src/sandbox-runtime";

const successResult = (command: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  command,
  duration: 5,
  timestamp: "2026-07-22T00:00:00.000Z",
});

const failedResult = (command: string, stdout: string, stderr: string): ExecResult => ({
  ...successResult(command),
  success: false,
  exitCode: 23,
  stdout,
  stderr,
});

class FakeSandboxRuntimeCapabilities implements SandboxRuntimeCapabilities {
  readonly calls: Array<{ command: string; options?: SandboxExecOptions }> = [];
  result: ExecResult = successResult("true");
  rejection: unknown;

  exec = (command: string, options?: SandboxExecOptions): Promise<ExecResult> => {
    this.calls.push({ command, options });
    if (this.rejection !== undefined) return Promise.reject(this.rejection);
    return Promise.resolve(this.result);
  };

  createSession = (_options: SandboxSessionOptions): Promise<void> =>
    this.rejection === undefined ? Promise.resolve() : Promise.reject(this.rejection);

  deleteSession = (_sessionId: string): Promise<void> =>
    this.rejection === undefined ? Promise.resolve() : Promise.reject(this.rejection);

  mkdir = (): Promise<{ success: true; path: string; message: string }> =>
    Promise.resolve({ success: true, path: "/unused", message: "ok" });

  writeFile = (): Promise<{ success: true; path: string; bytesWritten: number }> =>
    Promise.resolve({ success: true, path: "/unused", bytesWritten: 0 });

  setEnvVars = (): Promise<void> => Promise.resolve();
}

const withRuntime = <A, E>(
  capabilities: SandboxRuntimeCapabilities,
  effect: Effect.Effect<A, E, SandboxRuntime>,
): Effect.Effect<A, E> => Effect.provide(effect, sandboxRuntimeLayer(capabilities));

const execChecked = (command: string, options?: SandboxExecOptions) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.execChecked(command, options));

const exec = (command: string, options?: SandboxExecOptions) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.exec(command, options));

const createSession = (options: SandboxSessionOptions) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.createSession(options));

const deleteSession = (sessionId: string) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.deleteSession(sessionId));

const failure = <A>(result: Result.Result<A, SandboxRuntimeFailure>): SandboxRuntimeFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("SandboxRuntime", () => {
  it.effect("returns nonzero results for callers that branch on command status", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxRuntimeCapabilities();
      const result = failedResult("gh repo view", "", "not found");
      capabilities.result = result;

      const actual = yield* withRuntime(capabilities, exec("gh repo view", { timeout: 60_000 }));

      assert.strictEqual(actual, result);
      assert.deepStrictEqual(capabilities.calls, [
        { command: "gh repo view", options: { timeout: 60_000 } },
      ]);
    }),
  );

  it.effect("captures a successful call and forwards cwd, env, and timeout exactly", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxRuntimeCapabilities();
      const command = "git status --porcelain";
      const options: SandboxExecOptions = {
        cwd: "/workspace/a0b1c2d3e4f5",
        env: { GH_TOKEN: "scotty-github-a0b1c2d3e4f5-token", EMPTY: undefined },
        timeout: 120_000,
      };
      capabilities.result = successResult(command);

      const result = yield* withRuntime(capabilities, execChecked(command, options));

      assert.strictEqual(result, capabilities.result);
      assert.deepStrictEqual(capabilities.calls, [{ command, options }]);
    }),
  );

  it.effect("maps transport rejection to a fixed redacted typed failure", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxRuntimeCapabilities();
      const providerDetail = "provider rejected github_pat_provider-secret";
      const commandSecret = "gh auth token ghp_commandsecret";
      capabilities.rejection = new Error(providerDetail);

      const result = yield* Effect.result(
        withRuntime(
          capabilities,
          execChecked(commandSecret, { env: { GH_TOKEN: providerDetail } }),
        ),
      );
      const error = failure(result);
      const serialized = JSON.stringify(error);

      assert.deepStrictEqual(
        error,
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox command transport failed",
        }),
      );
      assert.ok(!serialized.includes("provider"));
      assert.ok(!serialized.includes("github_pat_"));
      assert.ok(!serialized.includes("ghp_"));
    }),
  );

  it.effect("keeps unchecked transport failures fixed and redacted", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxRuntimeCapabilities();
      capabilities.rejection = new Error("provider leaked github_pat_provider-secret");

      const result = yield* Effect.result(
        withRuntime(capabilities, exec("gh repo view ghp_commandsecret")),
      );

      assert.deepStrictEqual(
        failure(result),
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox command transport failed",
        }),
      );
    }),
  );

  it.effect("maps named-session transport rejections to operation-specific redacted failures", () =>
    Effect.gen(function* () {
      const providerDetail = "provider leaked github_pat_provider-secret";
      for (const [operation, message] of [
        [createSession({ id: "scotty-web" }), "Sandbox session creation transport failed"],
        [deleteSession("scotty-web"), "Sandbox session deletion transport failed"],
      ] as const) {
        const capabilities = new FakeSandboxRuntimeCapabilities();
        capabilities.rejection = new Error(providerDetail);
        const result = yield* Effect.result(withRuntime(capabilities, operation));
        const error = failure(result);

        assert.deepStrictEqual(error, new SandboxRuntimeFailure({ reason: "transport", message }));
        assert.ok(!JSON.stringify(error).includes("provider"));
        assert.ok(!JSON.stringify(error).includes("github_pat_"));
      }
    }),
  );

  it.effect("maps nonzero exit stderr to a redacted typed failure", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxRuntimeCapabilities();
      capabilities.result = failedResult("false", "stdout fallback", "permission denied");

      const result = yield* Effect.result(withRuntime(capabilities, execChecked("false")));

      assert.deepStrictEqual(
        failure(result),
        new SandboxRuntimeFailure({ reason: "nonzero_exit", message: "permission denied" }),
      );
    }),
  );

  it.effect("redacts sentinels and GitHub PATs and truncates failures to 1000 characters", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxRuntimeCapabilities();
      const secretOutput =
        "scotty-codex-session-secret scotty-github-session-secret ghp_patsecret " +
        "github_pat_pat_secret " +
        "x".repeat(1_100);
      capabilities.result = failedResult("false", secretOutput, "");

      const result = yield* Effect.result(withRuntime(capabilities, execChecked("false")));
      const error = failure(result);

      assert.strictEqual(error.message.length, 1_000);
      assert.ok(error.message.startsWith("[sentinel] [sentinel] [credential] [credential] "));
      assert.ok(!error.message.includes("session-secret"));
      assert.ok(!error.message.includes("patsecret"));
      assert.ok(!error.message.includes("pat_secret"));
    }),
  );

  it.effect("does not claim remote process cancellation when interrupted", () =>
    Effect.gen(function* () {
      let resolvePending: (result: ExecResult) => void = () => undefined;
      const pending = new Promise<ExecResult>((resolve) => {
        resolvePending = resolve;
      });
      let remoteSettled = false;
      const calls: Array<{ command: string; options?: SandboxExecOptions }> = [];
      const capabilities: SandboxRuntimeCapabilities = {
        exec: (command, options) => {
          calls.push({ command, options });
          return pending.then((result) => {
            remoteSettled = true;
            return result;
          });
        },
        createSession: () => Promise.resolve(),
        deleteSession: () => Promise.resolve(),
        mkdir: () => Promise.resolve({ success: true, path: "/unused", message: "ok" }),
        writeFile: () => Promise.resolve({ success: true, path: "/unused", bytesWritten: 0 }),
        setEnvVars: () => Promise.resolve(),
      };
      const fiber = yield* withRuntime(capabilities, execChecked("long-running")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(calls, [{ command: "long-running", options: undefined }]);
      assert.strictEqual(remoteSettled, false);

      resolvePending(successResult("long-running"));
      yield* Effect.promise(() => pending);
      assert.strictEqual(remoteSettled, true);
    }),
  );
});

describe("Sandbox runtime redaction helpers", () => {
  it("quotes hostile shell input without changing its value", () => {
    assert.strictEqual(
      shellQuote("'\"; $(touch /tmp/pwned)\nline"),
      "''\\''\"; $(touch /tmp/pwned)\nline'",
    );
  });

  it("preserves error-name behavior without probing provider details", () => {
    const providerError = new Error("credential-shaped provider detail");
    providerError.name = "RPCTransportError";
    assert.strictEqual(errorName(providerError), "RPCTransportError");
    assert.strictEqual(errorName("provider detail"), "UnknownError");
  });
});
