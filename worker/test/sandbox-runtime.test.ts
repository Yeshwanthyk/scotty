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
import { InMemoryFaultInjectableFake, sandboxRuntimeCapabilitiesFake } from "./support";

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
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      const result = failedResult("gh repo view", "", "not found");
      memory.respond("exec", result);

      const actual = yield* withRuntime(capabilities, exec("gh repo view", { timeout: 60_000 }));

      assert.strictEqual(actual, result);
      assert.deepStrictEqual(memory.calls("exec"), [["gh repo view", { timeout: 60_000 }]]);
    }),
  );

  it.effect("captures a successful call and forwards cwd, env, and timeout exactly", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      const command = "git status --porcelain";
      const options: SandboxExecOptions = {
        cwd: "/workspace/a0b1c2d3e4f5",
        env: { GH_TOKEN: "scotty-github-a0b1c2d3e4f5-token", EMPTY: undefined },
        timeout: 120_000,
      };
      memory.respond("exec", successResult(command));

      const result = yield* withRuntime(capabilities, execChecked(command, options));

      assert.deepStrictEqual(result, successResult(command));
      assert.deepStrictEqual(memory.calls("exec"), [[command, options]]);
    }),
  );

  it.effect("maps transport rejection to a fixed redacted typed failure", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      const providerDetail = "provider rejected github_pat_provider-secret";
      const commandSecret = "gh auth token ghp_commandsecret";
      memory.injectFailure("exec", { error: new Error(providerDetail) });

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
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      memory.injectFailure("exec", {
        error: new Error("provider leaked github_pat_provider-secret"),
      });

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
      for (const [capabilityOperation, operation, message] of [
        [
          "createSession",
          createSession({ id: "scotty-web" }),
          "Sandbox session creation transport failed",
        ],
        ["deleteSession", deleteSession("scotty-web"), "Sandbox session deletion transport failed"],
      ] as const) {
        const memory = new InMemoryFaultInjectableFake();
        const capabilities = sandboxRuntimeCapabilitiesFake(memory);
        memory.injectFailure(capabilityOperation, { error: new Error(providerDetail) });
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
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      memory.respond("exec", failedResult("false", "stdout fallback", "permission denied"));

      const result = yield* Effect.result(withRuntime(capabilities, execChecked("false")));

      assert.deepStrictEqual(
        failure(result),
        new SandboxRuntimeFailure({ reason: "nonzero_exit", message: "permission denied" }),
      );
    }),
  );

  it.effect("redacts sentinels and GitHub PATs and truncates failures to 1000 characters", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      const secretOutput =
        "scotty-codex-session-secret scotty-github-session-secret ghp_patsecret " +
        "github_pat_pat_secret " +
        "x".repeat(1_100);
      memory.respond("exec", failedResult("false", secretOutput, ""));

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
      const memory = new InMemoryFaultInjectableFake();
      memory.handle("exec", () =>
        pending.then((result) => {
          remoteSettled = true;
          return result;
        }),
      );
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      const fiber = yield* withRuntime(capabilities, execChecked("long-running")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(memory.calls("exec"), [["long-running", undefined]]);
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
