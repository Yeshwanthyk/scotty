import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Match, Predicate, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  decodeRunnerOperationText,
  type EnsureRuntime,
  type ExecRuntime,
  type InspectRuntime,
  type RemoveRuntime,
  type RunnerResponse,
  type StopRuntime,
} from "../src/runner-protocol";
import { makeRunnerRuntime } from "../src/runner-runtime";

const ensure = (operationId: string, sessionId = "session-a"): EnsureRuntime => ({
  _tag: "EnsureRuntime",
  version: 1,
  operationId,
  sessionId,
});

const inspect = (operationId: string, sessionId = "session-a"): InspectRuntime => ({
  _tag: "InspectRuntime",
  version: 1,
  operationId,
  sessionId,
});

const exec = (
  operationId: string,
  argv: ExecRuntime["argv"],
  cwd?: string,
  sessionId = "session-a",
): ExecRuntime =>
  cwd === undefined
    ? { _tag: "ExecRuntime", version: 1, operationId, sessionId, argv }
    : { _tag: "ExecRuntime", version: 1, operationId, sessionId, argv, cwd };

const stop = (operationId: string, sessionId = "session-a"): StopRuntime => ({
  _tag: "StopRuntime",
  version: 1,
  operationId,
  sessionId,
});

const remove = (operationId: string, sessionId = "session-a"): RemoveRuntime => ({
  _tag: "RemoveRuntime",
  version: 1,
  operationId,
  sessionId,
});

const assertFailure = (response: RunnerResponse, code: string): void => {
  const actual = Match.value(response).pipe(
    Match.tagsExhaustive({
      RunnerFailure: (failure) => failure.code,
      RunnerSuccess: () => assert.fail("expected runner failure"),
    }),
  );
  assert.strictEqual(actual, code);
};

const assertPhase = (response: RunnerResponse, phase: string): void => {
  const actual = Match.value(response).pipe(
    Match.tagsExhaustive({
      RunnerFailure: () => assert.fail("expected runner success"),
      RunnerSuccess: ({ result }) =>
        Match.value(result).pipe(
          Match.tagsExhaustive({
            ExecRuntimeResult: () => assert.fail("expected lifecycle result"),
            EnsureRuntimeResult: (state) => state.phase,
            InspectRuntimeResult: (state) => state.phase,
            StopRuntimeResult: (state) => state.phase,
            RemoveRuntimeResult: (state) => state.phase,
          }),
        ),
    }),
  );
  assert.strictEqual(actual, phase);
};

const execResult = (response: RunnerResponse) =>
  Match.value(response).pipe(
    Match.tagsExhaustive({
      RunnerFailure: () => assert.fail("expected exec success"),
      RunnerSuccess: ({ result }) =>
        Match.value(result).pipe(
          Match.tagsExhaustive({
            ExecRuntimeResult: (exec) => exec,
            EnsureRuntimeResult: () => assert.fail("expected exec result"),
            InspectRuntimeResult: () => assert.fail("expected exec result"),
            StopRuntimeResult: () => assert.fail("expected exec result"),
            RemoveRuntimeResult: () => assert.fail("expected exec result"),
          }),
        ),
    }),
  );

const workspaceOf = (response: RunnerResponse): string =>
  Match.value(response).pipe(
    Match.tagsExhaustive({
      RunnerFailure: () => assert.fail("expected lifecycle success"),
      RunnerSuccess: ({ result }) =>
        Match.value(result).pipe(
          Match.tagsExhaustive({
            ExecRuntimeResult: () => assert.fail("expected lifecycle result"),
            EnsureRuntimeResult: (state) => state.workspace,
            InspectRuntimeResult: (state) => state.workspace,
            StopRuntimeResult: (state) => state.workspace,
            RemoveRuntimeResult: (state) => state.workspace,
          }),
        ),
    }),
  );

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("runner protocol", () => {
  it.effect("strictly decodes only version 1 operations with their exact fields", () =>
    Effect.gen(function* () {
      const valid = yield* decodeRunnerOperationText(JSON.stringify(ensure("ensure-valid")));
      assert.isTrue(Predicate.isTagged(valid, "EnsureRuntime"));

      const malformed = [
        JSON.stringify({ ...ensure("wrong-version"), version: 2 }),
        JSON.stringify({ ...ensure("excess"), env: { TOKEN: "secret" } }),
        JSON.stringify({ ...ensure("wrong-tag"), _tag: "StartRuntime" }),
        JSON.stringify({ ...ensure("invalid-session"), sessionId: "../outside" }),
        JSON.stringify({ ...ensure("too-long"), operationId: "x".repeat(201) }),
        JSON.stringify({
          _tag: "ExecRuntime",
          version: 1,
          operationId: "empty-argv",
          sessionId: "session-a",
          argv: [],
        }),
      ];
      for (const text of malformed) {
        const result = yield* Effect.result(decodeRunnerOperationText(text));
        assert.isTrue(Result.isFailure(result));
      }
    }),
  );
});

describe("RunnerRuntime", () => {
  it.effect("converges lifecycle operations, replays receipts, and confines execution", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-" });
        const runtime = yield* makeRunnerRuntime({
          root,
          childEnvironment: { RUNNER_TEST_ALLOWED: "allowed" },
        });

        assertPhase(yield* runtime.handle(inspect("inspect-absent")), "absent");
        assertFailure(
          yield* runtime.handle(exec("exec-absent", [process.execPath, "-e", ""])),
          "runtime_not_running",
        );

        const ensureOperation = ensure("ensure-once");
        const ensured = yield* runtime.handle(ensureOperation);
        assertPhase(ensured, "running");
        const replayed = yield* runtime.handle(ensureOperation);
        assert.strictEqual(replayed, ensured);
        const reorderedReplay = yield* runtime.handle({
          sessionId: "session-a",
          operationId: "ensure-once",
          version: 1,
          _tag: "EnsureRuntime",
        });
        assert.strictEqual(reorderedReplay, ensured);

        assertFailure(yield* runtime.handle(inspect("ensure-once")), "idempotency_conflict");
        assertFailure(
          yield* runtime.handle(exec("absolute-cwd", [process.execPath, "-e", ""], root)),
          "invalid_cwd",
        );
        assertFailure(
          yield* runtime.handle(exec("escaping-cwd", [process.execPath, "-e", ""], "../outside")),
          "invalid_cwd",
        );

        const childEnvironment = yield* runtime.handle(
          exec("child-environment", [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify([process.env.RUNNER_TEST_ALLOWED, process.env.SCOTTY_RUNNER_TOKEN ?? null]))",
          ]),
        );
        assert.strictEqual(execResult(childEnvironment).stdout, '["allowed",null]');

        const writeMarker = yield* runtime.handle(
          exec("write-marker", [
            process.execPath,
            "--input-type=module",
            "-e",
            "import { writeFileSync } from 'node:fs'; writeFileSync('marker.txt', 'marker-data')",
          ]),
        );
        assert.strictEqual(execResult(writeMarker).exitCode, 0);

        assertPhase(yield* runtime.handle(stop("stop")), "stopped");
        assertPhase(yield* runtime.handle(inspect("inspect-stopped")), "stopped");
        assertFailure(
          yield* runtime.handle(exec("exec-stopped", [process.execPath, "-e", ""])),
          "runtime_not_running",
        );

        assertPhase(yield* runtime.handle(ensure("ensure-again")), "running");
        const readMarker = yield* runtime.handle(
          exec("read-marker", [
            process.execPath,
            "--input-type=module",
            "-e",
            "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('marker.txt', 'utf8'))",
          ]),
        );
        const readResult = execResult(readMarker);
        assert.strictEqual(readResult.exitCode, 0);
        assert.strictEqual(readResult.stdout, "marker-data");
        assert.strictEqual(readResult.stderr, "");

        const boundedOutput = yield* runtime.handle(
          exec("bounded-output", [
            process.execPath,
            "-e",
            "process.stdout.write('x'.repeat(70 * 1024)); process.stderr.write('y'.repeat(70 * 1024))",
          ]),
        );
        assert.strictEqual(execResult(boundedOutput).stdout.length, 64 * 1024);
        assert.strictEqual(execResult(boundedOutput).stderr.length, 64 * 1024);
        assertPhase(yield* runtime.handle(inspect("inspect-running")), "running");

        const workspace = workspaceOf(ensured);
        const outside = `${root}/outside.txt`;
        yield* fs.writeFileString(outside, "preserve");
        assert.isTrue(yield* fs.exists(workspace));

        assertPhase(yield* runtime.handle(remove("remove")), "absent");
        assert.isFalse(yield* fs.exists(workspace));
        assert.isTrue(yield* fs.exists(outside));
        assertPhase(yield* runtime.handle(remove("remove-again")), "absent");
        assertPhase(yield* runtime.handle(inspect("inspect-removed")), "absent");

        const drainingSession = "session-draining";
        const drainingWorkspace = workspaceOf(
          yield* runtime.handle(ensure("ensure-draining", drainingSession)),
        );
        const drainingExec = yield* runtime
          .handle(
            exec(
              "exec-draining",
              [
                process.execPath,
                "-e",
                "const fs = require('node:fs'); fs.writeFileSync('started', ''); while (!fs.existsSync('release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)",
              ],
              undefined,
              drainingSession,
            ),
          )
          .pipe(Effect.forkChild);
        const startedPath = `${drainingWorkspace}/started`;
        let drainingStarted = false;
        for (let attempt = 0; attempt < 10_000 && !drainingStarted; attempt++) {
          drainingStarted = yield* fs.exists(startedPath);
          if (!drainingStarted) yield* Effect.yieldNow;
        }
        assert.isTrue(drainingStarted);
        const drainingStop = yield* runtime
          .handle(stop("stop-draining", drainingSession))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.isUndefined(drainingStop.pollUnsafe());
        assertPhase(
          yield* runtime.handle(ensure("ensure-independent", "session-independent")),
          "running",
        );
        yield* fs.writeFileString(`${drainingWorkspace}/release`, "");
        assert.strictEqual(execResult(yield* Fiber.join(drainingExec)).exitCode, 0);
        assertPhase(yield* Fiber.join(drainingStop), "stopped");
        assertPhase(yield* runtime.handle(remove("remove-draining", drainingSession)), "absent");
        assertPhase(
          yield* runtime.handle(remove("remove-independent", "session-independent")),
          "absent",
        );

        const stubbornSession = "session-stubborn";
        const stubbornWorkspace = workspaceOf(
          yield* runtime.handle(ensure("ensure-stubborn", stubbornSession)),
        );
        const stubbornFiber = yield* runtime
          .handle(
            exec(
              "exec-stubborn",
              [
                process.execPath,
                "-e",
                "const fs = require('node:fs'); fs.writeFileSync('pid.txt', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
              ],
              undefined,
              stubbornSession,
            ),
          )
          .pipe(Effect.forkChild);
        const pidPath = `${stubbornWorkspace}/pid.txt`;
        let started = false;
        for (let attempt = 0; attempt < 10_000 && !started; attempt++) {
          started = yield* fs.exists(pidPath);
          if (!started) yield* Effect.yieldNow;
        }
        assert.isTrue(started);
        const pid = Number(yield* fs.readFileString(pidPath));
        const interruptFiber = yield* Fiber.interrupt(stubbornFiber).pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(interruptFiber);
        const processProbe = Result.try({
          try: () => process.kill(pid, 0),
          catch: () => false,
        });
        const processAlive = Result.isSuccess(processProbe) ? processProbe.success : false;
        assert.isFalse(processAlive);
        assertPhase(yield* runtime.handle(remove("remove-stubborn", stubbornSession)), "absent");
      }),
    ),
  );
});
