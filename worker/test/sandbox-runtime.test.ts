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
  type SandboxProcessOptions,
  type SandboxRuntimeCapabilities,
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

const readFile = (path: string, maxBytes: number) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.readFile(path, maxBytes));

const startProcess = (command: string, options?: SandboxProcessOptions) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.startProcess(command, options));

const getProcess = (processId: string) =>
  Effect.flatMap(SandboxRuntime, (runtime) => runtime.getProcess(processId));

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
        env: { GH_TOKEN: `scotty-env-a0b1c2d3e4f5-${"a".repeat(32)}`, EMPTY: undefined },
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

  it.effect("denies access inside the Effect adapter before invoking the Sandbox capability", () =>
    Effect.gen(function* () {
      let calls = 0;
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(new InMemoryFaultInjectableFake()),
        exec: (command) => {
          calls += 1;
          return Promise.resolve(successResult(command));
        },
      };
      const result = yield* Effect.result(
        Effect.provide(
          exec("git status"),
          sandboxRuntimeLayer(capabilities, Effect.fail("runtime access denied")),
        ),
      );

      assert.deepStrictEqual(
        failure(result),
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox command transport failed",
        }),
      );
      assert.strictEqual(calls, 0);
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

  it.effect("reads raw file chunks up to the caller-owned byte limit", () =>
    Effect.gen(function* () {
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        readFileStream: () =>
          Promise.resolve(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 2]));
                controller.enqueue(Uint8Array.from([3, 4]));
                controller.close();
              },
            }),
          ),
      };

      const bytes = yield* withRuntime(capabilities, readFile("/tmp/frame.png", 4));

      assert.deepStrictEqual(bytes, Uint8Array.from([1, 2, 3, 4]));
    }),
  );

  it.effect("fails closed and cancels a file stream that exceeds its byte limit", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        readFileStream: () =>
          Promise.resolve(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 2, 3]));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      };

      const result = yield* Effect.result(
        withRuntime(capabilities, readFile("/tmp/video.webm", 2)),
      );

      assert.deepStrictEqual(
        failure(result),
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox file exceeds its byte limit",
        }),
      );
      assert.isTrue(cancelled);
    }),
  );

  it.effect("redacts sentinels and GitHub PATs and truncates failures to 1000 characters", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = sandboxRuntimeCapabilitiesFake(memory);
      const secretOutput =
        `scotty-codex-session-secret scotty-env-a0b1c2d3e4f5-${"a".repeat(32)} ghp_patsecret ` +
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

  it.effect(
    "wraps process start, readiness, exit wait, kill, and lookup without leaking the SDK",
    () =>
      Effect.gen(function* () {
        const memory = new InMemoryFaultInjectableFake();
        const calls: Array<readonly [string, ...ReadonlyArray<unknown>]> = [];
        const sdkProcess = {
          id: "scotty-agent",
          status: "running" as const,
          kill: (signal?: string) => {
            calls.push(["kill", signal]);
            return Promise.resolve();
          },
          waitForExit: (timeout?: number) => {
            calls.push(["waitForExit", timeout]);
            return Promise.resolve({ exitCode: 0 });
          },
          waitForPort: (port: number, options?: { readonly mode?: "http" | "tcp" }) => {
            calls.push(["waitForPort", port, options]);
            return Promise.resolve();
          },
        };
        const capabilities: SandboxRuntimeCapabilities = {
          ...sandboxRuntimeCapabilitiesFake(memory),
          startProcess: (command, options) => {
            calls.push(["startProcess", command, options]);
            return Promise.resolve(sdkProcess);
          },
          getProcess: (processId) => {
            calls.push(["getProcess", processId]);
            return Promise.resolve(sdkProcess);
          },
        };
        const options = {
          cwd: "/workspace/a0b1c2d3e4f5",
          env: { PRIVATE_AGENT_TOKEN: "private" },
          processId: "scotty-agent",
          autoCleanup: true,
        } as const;

        const process = yield* withRuntime(
          capabilities,
          startProcess("/usr/local/bin/pi -host 127.0.0.1", options),
        );
        yield* process.waitForPort(31_415, { mode: "tcp" });
        assert.strictEqual(yield* process.waitForExit(10_000), 0);
        yield* process.kill("SIGTERM");
        const observed = yield* withRuntime(capabilities, getProcess("scotty-agent"));

        assert.ok(observed);
        assert.strictEqual(observed.id, "scotty-agent");
        assert.strictEqual(observed.status, "running");
        assert.deepStrictEqual(calls, [
          ["startProcess", "/usr/local/bin/pi -host 127.0.0.1", options],
          ["waitForPort", 31_415, { mode: "tcp" }],
          ["waitForExit", 10_000],
          ["kill", "SIGTERM"],
          ["getProcess", "scotty-agent"],
        ]);
      }),
  );

  it.effect("uses fetch-port readiness only for the explicit local host adapter", () =>
    Effect.gen(function* () {
      let nativeWaitCalls = 0;
      const fetchCalls: Array<readonly [string, number, string]> = [];
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        startProcess: () =>
          Promise.resolve({
            id: "scotty-pi-session",
            status: "running",
            kill: () => Promise.resolve(),
            waitForExit: () => Promise.resolve({ exitCode: 0 }),
            waitForPort: () => {
              nativeWaitCalls += 1;
              return Promise.resolve();
            },
          }),
        fetchPort: (path, port, method) => {
          fetchCalls.push([path, port, method]);
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      };
      const program = Effect.gen(function* () {
        const runtime = yield* SandboxRuntime;
        const process = yield* runtime.startProcess("/usr/local/bin/scotty-pi-session");
        yield* process.waitForPort(43_117, {
          mode: "http",
          path: "/health",
          status: 200,
          timeout: 10_000,
        });
      });

      yield* Effect.provide(
        program,
        sandboxRuntimeLayer(capabilities, undefined, { fetchPortReadiness: true }),
      );

      assert.deepStrictEqual(fetchCalls, [["/health", 43_117, "GET"]]);
      assert.strictEqual(nativeWaitCalls, 0);
    }),
  );

  it.effect("maps every process Promise rejection to an operation-specific redacted failure", () =>
    Effect.gen(function* () {
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        startProcess: () =>
          Promise.reject(new Error("provider leaked PRIVATE_AGENT_TOKEN=private")),
        getProcess: () => Promise.reject(new Error("provider leaked PRIVATE_AGENT_TOKEN=private")),
      };

      const startResult = yield* Effect.result(
        withRuntime(capabilities, startProcess("pi private")),
      );
      const lookupResult = yield* Effect.result(
        withRuntime(capabilities, getProcess("scotty-agent")),
      );

      assert.deepStrictEqual(
        failure(startResult),
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox process start transport failed",
        }),
      );
      assert.deepStrictEqual(
        failure(lookupResult),
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox process lookup transport failed",
        }),
      );
      assert.ok(!JSON.stringify([startResult, lookupResult]).includes("private"));
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
