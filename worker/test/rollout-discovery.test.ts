import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Option, Result } from "effect";
import { RolloutDiscovery, rolloutDiscoveryLayer } from "../src/rollout-discovery";
import {
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  type SandboxExecOptions,
  type SandboxRuntimeCapabilities,
  type SandboxSessionOptions,
} from "../src/sandbox-runtime";

const ID = "a0b1c2d3e4f5";
const CODEX_HOME = `/workspace/${ID}/.codex`;
const SESSIONS_DIR = `${CODEX_HOME}/sessions`;
const EXPECTED_COMMAND = `find '${SESSIONS_DIR}' -type f -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-`;
const EXPECTED_OPTIONS: SandboxExecOptions = { timeout: 15_000 };

const successResult = (command: string, stdout: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout,
  stderr: "",
  command,
  duration: 5,
  timestamp: "2026-07-22T00:00:00.000Z",
});

const failedResult = (command: string, stdout: string, stderr: string): ExecResult => ({
  success: false,
  exitCode: 1,
  stdout,
  stderr,
  command,
  duration: 5,
  timestamp: "2026-07-22T00:00:00.000Z",
});

class FakeSandboxCapabilities implements SandboxRuntimeCapabilities {
  readonly calls: Array<{ command: string; options?: SandboxExecOptions }> = [];
  result: ExecResult = successResult("find", "");
  rejection: unknown;

  exec = (command: string, options?: SandboxExecOptions): Promise<ExecResult> => {
    this.calls.push({ command, options });
    if (this.rejection !== undefined) return Promise.reject(this.rejection);
    return Promise.resolve(this.result);
  };

  createSession = (_options: SandboxSessionOptions): Promise<void> => Promise.resolve();

  deleteSession = (_sessionId: string): Promise<void> => Promise.resolve();

  mkdir = (): Promise<unknown> => Promise.resolve({ success: true, path: "/unused" });

  writeFile = (): Promise<unknown> => Promise.resolve({ success: true, path: "/unused" });

  setEnvVars = (): Promise<void> => Promise.resolve();
}

const withDiscovery = <A, E>(
  capabilities: SandboxRuntimeCapabilities,
  effect: Effect.Effect<A, E, RolloutDiscovery>,
): Effect.Effect<A, E> => {
  const runtimeLayer = sandboxRuntimeLayer(capabilities);
  const layer = rolloutDiscoveryLayer.pipe(Layer.provide(runtimeLayer));
  return Effect.provide(effect, layer);
};

const findNewestRollout = (id: string) =>
  Effect.flatMap(RolloutDiscovery, (discovery) => discovery.findNewestRollout(id));

const discoverThreadId = (id: string) =>
  Effect.flatMap(RolloutDiscovery, (discovery) => discovery.discoverThreadId(id));

const failure = <A>(result: Result.Result<A, SandboxRuntimeFailure>): SandboxRuntimeFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("RolloutDiscovery", () => {
  it.effect("issues the exact find command with 15s timeout and no env or cwd", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = successResult(
        "find",
        `/workspace/${ID}/.codex/sessions/2026/07/22/rollout-abc.jsonl`,
      );

      yield* withDiscovery(capabilities, findNewestRollout(ID));

      assert.deepStrictEqual(capabilities.calls, [
        { command: EXPECTED_COMMAND, options: EXPECTED_OPTIONS },
      ]);
    }),
  );

  it.effect("returns the newest rollout path from stdout when files exist", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      const path = `${SESSIONS_DIR}/2026/07/22/rollout-abc.jsonl`;
      capabilities.result = successResult("find", `${path}\n`);

      const result = yield* withDiscovery(capabilities, findNewestRollout(ID));

      assert.deepStrictEqual(result, Option.some(path));
    }),
  );

  it.effect("returns none when the sessions directory has no files (empty stdout)", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = successResult("find", "");

      const result = yield* withDiscovery(capabilities, findNewestRollout(ID));

      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("returns none when the sessions directory is missing (nonzero exit)", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = failedResult("find", "", "find: No such file or directory");

      const result = yield* withDiscovery(capabilities, findNewestRollout(ID));

      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("returns none when stdout is only whitespace", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = successResult("find", "   \n  \n");

      const result = yield* withDiscovery(capabilities, findNewestRollout(ID));

      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("maps transport rejection to a fixed redacted typed failure", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.rejection = new Error("provider leaked ghp_transport_secret");

      const result = yield* Effect.result(withDiscovery(capabilities, findNewestRollout(ID)));
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
      assert.ok(!serialized.includes("ghp_"));
      assert.ok(!serialized.includes("transport_secret"));
    }),
  );

  it.effect("keeps transport failures fixed and redacted for discoverThreadId", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.rejection = new Error("provider leaked ghp_discover_secret");

      const result = yield* Effect.result(withDiscovery(capabilities, discoverThreadId(ID)));

      assert.deepStrictEqual(
        failure(result),
        new SandboxRuntimeFailure({
          reason: "transport",
          message: "Sandbox command transport failed",
        }),
      );
    }),
  );

  it.effect("extracts a valid UUID from the rollout filename", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      const uuid = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";
      capabilities.result = successResult(
        "find",
        `${SESSIONS_DIR}/2026/07/22/rollout-${uuid}.jsonl\n`,
      );

      const result = yield* withDiscovery(capabilities, discoverThreadId(ID));

      assert.deepStrictEqual(result, Option.some(uuid));
    }),
  );

  it.effect("returns none when the rollout filename has no UUID", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = successResult(
        "find",
        `${SESSIONS_DIR}/2026/07/22/rollout-no-uuid-here.jsonl\n`,
      );

      const result = yield* withDiscovery(capabilities, discoverThreadId(ID));

      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("returns none for discoverThreadId when no rollout exists", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = successResult("find", "");

      const result = yield* withDiscovery(capabilities, discoverThreadId(ID));

      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("returns none for discoverThreadId when the command exits nonzero", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.result = failedResult("find", "", "No such file or directory");

      const result = yield* withDiscovery(capabilities, discoverThreadId(ID));

      assert.deepStrictEqual(result, Option.none());
    }),
  );

  it.effect("reconstructs the service without retaining capability state", () =>
    Effect.gen(function* () {
      const first = new FakeSandboxCapabilities();
      const second = new FakeSandboxCapabilities();
      const path = `${SESSIONS_DIR}/2026/07/22/rollout-test.jsonl`;
      first.result = successResult("find", path);
      second.result = successResult("find", path);

      yield* withDiscovery(first, findNewestRollout(ID));
      yield* withDiscovery(second, findNewestRollout(ID));

      assert.strictEqual(first.calls.length, 1);
      assert.strictEqual(second.calls.length, 1);
      assert.notStrictEqual(first.calls, second.calls);
      assert.deepStrictEqual(first.calls, second.calls);
    }),
  );

  it.effect("does not leak session paths or provider details in failure messages", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      capabilities.rejection = new Error(`path=${SESSIONS_DIR} provider_detail_leak`);

      const result = yield* Effect.result(withDiscovery(capabilities, findNewestRollout(ID)));
      const serialized = JSON.stringify(failure(result));

      assert.ok(!serialized.includes(SESSIONS_DIR));
      assert.ok(!serialized.includes("provider_detail_leak"));
      assert.ok(!serialized.includes(ID));
    }),
  );

  it.effect("keeps credential honeypots out of every captured container surface", () =>
    Effect.gen(function* () {
      const capabilities = new FakeSandboxCapabilities();
      const secretPath = `${SESSIONS_DIR}/ghp_credential_leak.jsonl`;
      capabilities.result = successResult("find", secretPath);

      yield* withDiscovery(capabilities, findNewestRollout(ID));

      const surfaces = JSON.stringify(capabilities.calls);
      assert.ok(!surfaces.includes("ghp_"));
      assert.ok(!surfaces.includes("credential_leak"));
    }),
  );
});
