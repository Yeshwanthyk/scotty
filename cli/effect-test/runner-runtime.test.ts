import { createHash } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Match, Predicate, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  type IsolatedRuntimeCompute,
  type IsolatedRuntimeExecInput,
  RunnerComputeFailure,
} from "../src/runner-docker";
import {
  decodeRunnerOperationText,
  encodeRunnerOperation,
  type EnsureRuntime,
  type ExecRuntime,
  type InspectRuntime,
  type RemoveRuntime,
  type RunnerOperation,
  type RunnerResponse,
  type StopRuntime,
} from "../../protocol/runner";
import { makeRunnerRuntime, makeRunnerRuntimeWithCompute } from "../src/runner-runtime";

const ensure = (operationId: string, sessionId = "session-a"): EnsureRuntime => ({
  _tag: "EnsureRuntime",
  version: 2,
  operationId,
  sessionId,
});

const inspect = (operationId: string, sessionId = "session-a"): InspectRuntime => ({
  _tag: "InspectRuntime",
  version: 2,
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
    ? { _tag: "ExecRuntime", version: 2, operationId, sessionId, argv }
    : { _tag: "ExecRuntime", version: 2, operationId, sessionId, argv, cwd };

const stop = (operationId: string, sessionId = "session-a"): StopRuntime => ({
  _tag: "StopRuntime",
  version: 2,
  operationId,
  sessionId,
});

const remove = (operationId: string, sessionId = "session-a"): RemoveRuntime => ({
  _tag: "RemoveRuntime",
  version: 2,
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

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const receiptDirectory = (root: string, operation: RunnerOperation): string =>
  `${root}/receipts/session-${hash(operation.sessionId)}/operation-${hash(operation.operationId)}`;

const recoveryFencePath = (root: string, sessionId: string): string =>
  `${root}/recovery/session-${hash(sessionId)}/recovery-required.json`;

describe("runner protocol", () => {
  it.effect("strictly decodes only version 2 operations with their exact fields", () =>
    Effect.gen(function* () {
      const valid = yield* decodeRunnerOperationText(JSON.stringify(ensure("ensure-valid")));
      assert.isTrue(Predicate.isTagged(valid, "EnsureRuntime"));

      const malformed = [
        JSON.stringify({ ...ensure("wrong-version"), version: 1 }),
        JSON.stringify({ ...ensure("excess"), env: { TOKEN: "secret" } }),
        JSON.stringify({ ...ensure("wrong-tag"), _tag: "StartRuntime" }),
        JSON.stringify({ ...ensure("invalid-session"), sessionId: "../outside" }),
        JSON.stringify({ ...ensure("too-long"), operationId: "x".repeat(201) }),
        JSON.stringify({
          _tag: "ExecRuntime",
          version: 2,
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
  it.effect("keeps receipts and cwd validation above the compute seam", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-compute-" });
        const sessionId = "session-compute";
        const workspace = `${root}/sessions/session-${hash(sessionId)}`;
        const phases = new Map<string, "running" | "stopped">();
        const executions: Array<IsolatedRuntimeExecInput> = [];
        const state = (id: string, phase: "absent" | "running" | "stopped") => ({
          phase,
          resourceId: `compute:${id}`,
          workspace: `${root}/sessions/session-${hash(id)}`,
        });
        const compute: IsolatedRuntimeCompute = {
          ensure: (id) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(state(id, "running").workspace, { recursive: true });
              phases.set(id, "running");
              return state(id, "running");
            }),
          inspect: (id) => Effect.succeed(state(id, phases.get(id) ?? "absent")),
          exec: (id, input) => {
            if (phases.get(id) !== "running")
              return Effect.fail(new RunnerComputeFailure({ code: "runtime_not_running" }));
            executions.push(input);
            return input.argv[0] === "fail"
              ? Effect.fail(new RunnerComputeFailure({ code: "process_failed" }))
              : Effect.succeed({ exitCode: 0, stdout: "delegated", stderr: "" });
          },
          stop: (id) =>
            Effect.sync(() => {
              const phase = phases.has(id) ? "stopped" : "absent";
              if (phase === "stopped") phases.set(id, phase);
              return state(id, phase);
            }),
          remove: (id) =>
            Effect.gen(function* () {
              phases.delete(id);
              yield* fs.remove(state(id, "absent").workspace, { recursive: true, force: true });
              return state(id, "absent");
            }),
        };
        const runtime = yield* makeRunnerRuntimeWithCompute(
          { root, childEnvironment: {}, isolation: { type: "process" } },
          compute,
        );

        assertPhase(yield* runtime.handle(ensure("compute-ensure", sessionId)), "running");
        yield* fs.makeDirectory(`${workspace}/nested`);
        const delegated = yield* runtime.handle(
          exec("compute-exec", ["tool", "arg"], "nested", sessionId),
        );
        assert.strictEqual(execResult(delegated).stdout, "delegated");
        assert.deepStrictEqual(executions, [{ argv: ["tool", "arg"], relativeCwd: "nested" }]);

        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-outside-" });
        yield* fs.symlink(outside, `${workspace}/escape`);
        assertFailure(
          yield* runtime.handle(exec("compute-escape", ["must-not-run"], "escape", sessionId)),
          "invalid_cwd",
        );
        assert.strictEqual(executions.length, 1);

        assertFailure(
          yield* runtime.handle(exec("compute-failure", ["fail"], undefined, sessionId)),
          "process_failed",
        );
        assertPhase(yield* runtime.handle(stop("compute-stop", sessionId)), "stopped");
        assertPhase(yield* runtime.handle(remove("compute-remove", sessionId)), "absent");
      }),
    ),
  );

  it.effect("converges lifecycle operations, replays receipts, and confines execution", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-" });
        const runtime = yield* makeRunnerRuntime({
          root,
          childEnvironment: { RUNNER_TEST_ALLOWED: "allowed" },
          isolation: { type: "process" },
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
        assert.deepStrictEqual(replayed, ensured);
        const reorderedReplay = yield* runtime.handle({
          sessionId: "session-a",
          operationId: "ensure-once",
          version: 2,
          _tag: "EnsureRuntime",
        });
        assert.deepStrictEqual(reorderedReplay, ensured);

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
        assertFailure(
          yield* runtime.handle(remove("remove-stubborn-blocked", stubbornSession)),
          "recovery_required",
        );
        assertPhase(yield* runtime.handle(stop("stop-stubborn", stubbornSession)), "stopped");
        assertPhase(yield* runtime.handle(remove("remove-stubborn", stubbornSession)), "absent");
      }),
    ),
  );

  it.effect("replays durable receipts after restart and preserves them across removal", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-receipts-" });
        const runtime = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        yield* runtime.handle(ensure("durable-ensure"));

        const operation = exec("durable-exec", [
          process.execPath,
          "--input-type=module",
          "-e",
          "import { appendFileSync } from 'node:fs'; appendFileSync('launches.txt', 'launched\\n'); process.stdout.write('durable-result')",
        ]);
        const first = yield* runtime.handle(operation);
        assert.strictEqual(execResult(first).stdout, "durable-result");

        const operationReceipts = receiptDirectory(root, operation);
        const startedPath = `${operationReceipts}/started.json`;
        const completedPath = `${operationReceipts}/completed.json`;
        const startedText = yield* fs.readFileString(startedPath);
        assert.isTrue(startedText.includes('"intentSha256"'));
        assert.isFalse(startedText.includes("appendFileSync"));
        assert.strictEqual(Number((yield* fs.stat(operationReceipts)).mode) & 0o777, 0o700);
        assert.strictEqual(Number((yield* fs.stat(startedPath)).mode) & 0o777, 0o600);
        assert.strictEqual(Number((yield* fs.stat(completedPath)).mode) & 0o777, 0o600);

        const restarted = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        assert.deepStrictEqual(yield* restarted.handle(operation), first);
        assertFailure(
          yield* restarted.handle({
            ...operation,
            argv: [process.execPath, "-e", "process.stdout.write('different-intent')"],
          }),
          "idempotency_conflict",
        );
        assert.strictEqual(
          yield* fs.readFileString(
            `${workspaceOf(yield* runtime.handle(inspect("workspace")))}/launches.txt`,
          ),
          "launched\n",
        );

        assertPhase(yield* restarted.handle(remove("durable-remove")), "absent");
        assert.isTrue(yield* fs.exists(startedPath));
        assert.isTrue(yield* fs.exists(completedPath));

        const restartedAfterRemoval = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        assert.deepStrictEqual(yield* restartedAfterRemoval.handle(operation), first);
      }),
    ),
  );

  it.effect("fences interrupted exec recovery until a durable successful stop", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-recovery-" });
        const sessionId = "session-recovery";
        let execCalls = 0;
        let stopShouldFail = true;
        const state = (phase: "running" | "stopped") => ({
          phase,
          resourceId: `compute:${sessionId}`,
          workspace: `${root}/sessions/session-${hash(sessionId)}`,
        });
        const compute: IsolatedRuntimeCompute = {
          ensure: () => Effect.succeed(state("running")),
          inspect: () => Effect.succeed(state("running")),
          exec: () =>
            Effect.sync(() => {
              execCalls++;
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
          stop: () =>
            stopShouldFail
              ? Effect.fail(new RunnerComputeFailure({ code: "process_failed" }))
              : Effect.succeed(state("stopped")),
          remove: () => Effect.succeed(state("stopped")),
        };
        const interrupted = exec(
          "recovery-exec",
          [process.execPath, "-e", "process.stdout.write('must-not-run')"],
          undefined,
          sessionId,
        );
        const interruptedReceipts = receiptDirectory(root, interrupted);
        yield* fs.makeDirectory(`${interruptedReceipts}/started.json.tmp`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${interruptedReceipts}/started.json.tmp/blocker`, "");

        const runtime = yield* makeRunnerRuntimeWithCompute(
          { root, childEnvironment: {}, isolation: { type: "process" } },
          compute,
        );
        assertFailure(yield* runtime.handle(interrupted), "filesystem_failed");
        const fencePath = recoveryFencePath(root, sessionId);
        assert.isTrue(yield* fs.exists(fencePath));
        const originalFence = yield* fs.readFileString(fencePath);
        assert.strictEqual(Number((yield* fs.stat(fencePath)).mode) & 0o777, 0o600);
        assert.strictEqual(
          Number((yield* fs.stat(`${root}/recovery/session-${hash(sessionId)}`)).mode) & 0o777,
          0o700,
        );
        assert.isFalse(yield* fs.exists(`${interruptedReceipts}/started.json`));
        assert.strictEqual(execCalls, 0);

        const restarted = yield* makeRunnerRuntimeWithCompute(
          { root, childEnvironment: {}, isolation: { type: "process" } },
          compute,
        );
        assertFailure(yield* restarted.handle(interrupted), "operation_unknown");
        assertFailure(
          yield* restarted.handle(ensure("recovery-blocked", sessionId)),
          "recovery_required",
        );
        assertFailure(
          yield* restarted.handle(remove("recovery-remove-blocked", sessionId)),
          "recovery_required",
        );
        assertPhase(yield* restarted.handle(inspect("recovery-inspect", sessionId)), "running");

        const failedStop = stop("recovery-stop-failed", sessionId);
        assertFailure(yield* restarted.handle(failedStop), "process_failed");
        assert.isTrue(yield* fs.exists(fencePath));
        assertFailure(yield* restarted.handle(failedStop), "process_failed");

        stopShouldFail = false;
        const incompleteStop = stop("recovery-stop-incomplete", sessionId);
        const incompleteStopReceipts = receiptDirectory(root, incompleteStop);
        yield* fs.makeDirectory(`${incompleteStopReceipts}/completed.json.tmp`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${incompleteStopReceipts}/completed.json.tmp/blocker`, "");
        assertFailure(yield* restarted.handle(incompleteStop), "operation_unknown");
        assert.isTrue(yield* fs.exists(fencePath));

        const completedStop = stop("recovery-stop-completed", sessionId);
        const completedStopResponse = yield* restarted.handle(completedStop);
        assertPhase(completedStopResponse, "stopped");
        assert.isFalse(yield* fs.exists(fencePath));

        const completedStopPath = `${receiptDirectory(root, completedStop)}/completed.json`;
        assert.isTrue(yield* fs.exists(completedStopPath));
        yield* fs.writeFileString(fencePath, originalFence, { mode: 0o600 });
        const restartedAfterCompletedStop = yield* makeRunnerRuntimeWithCompute(
          { root, childEnvironment: {}, isolation: { type: "process" } },
          compute,
        );
        assert.deepStrictEqual(
          yield* restartedAfterCompletedStop.handle(completedStop),
          completedStopResponse,
        );
        assert.isFalse(yield* fs.exists(fencePath));
        assertPhase(
          yield* restartedAfterCompletedStop.handle(ensure("recovery-unblocked", sessionId)),
          "running",
        );

        yield* fs.makeDirectory(`${root}/recovery/session-${hash(sessionId)}`, { recursive: true });
        yield* fs.writeFileString(fencePath, "{corrupt", { mode: 0o600 });
        const corruptRestart = yield* makeRunnerRuntimeWithCompute(
          { root, childEnvironment: {}, isolation: { type: "process" } },
          compute,
        );
        assertFailure(
          yield* corruptRestart.handle(ensure("corrupt-fence-blocked", sessionId)),
          "recovery_required",
        );
        assertPhase(
          yield* corruptRestart.handle(inspect("corrupt-fence-inspect", sessionId)),
          "running",
        );
        assertPhase(yield* corruptRestart.handle(stop("corrupt-fence-stop", sessionId)), "stopped");
        assert.isFalse(yield* fs.exists(fencePath));
      }),
    ),
  );

  it.effect("reconciles only a valid stale fence with its exact completed receipt", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "scotty-runner-recovery-reconcile-",
        });
        const sessionId = "session-reconcile";
        const runtime = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        yield* runtime.handle(ensure("reconcile-ensure", sessionId));
        const operation = exec(
          "reconcile-exec",
          [process.execPath, "-e", "process.stdout.write('completed')"],
          undefined,
          sessionId,
        );
        const response = yield* runtime.handle(operation);
        assert.strictEqual(execResult(response).stdout, "completed");

        const fencePath = recoveryFencePath(root, sessionId);
        yield* fs.makeDirectory(`${root}/recovery/session-${hash(sessionId)}`, {
          recursive: true,
        });
        yield* fs.writeFileString(
          fencePath,
          JSON.stringify({
            version: 1,
            operationId: operation.operationId,
            sessionId,
            status: "recovery_required",
            intentSha256: hash(encodeRunnerOperation(operation)),
          }),
          { mode: 0o600 },
        );

        const restarted = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        assert.deepStrictEqual(yield* restarted.handle(operation), response);
        assert.isFalse(yield* fs.exists(fencePath));

        yield* fs.writeFileString(
          fencePath,
          JSON.stringify({
            version: 1,
            operationId: operation.operationId,
            sessionId: "session-other",
            status: "recovery_required",
            intentSha256: hash(encodeRunnerOperation(operation)),
          }),
          { mode: 0o600 },
        );
        assertFailure(
          yield* restarted.handle(ensure("wrong-session-fence-blocked", sessionId)),
          "recovery_required",
        );
        assertPhase(
          yield* restarted.handle(stop("wrong-session-fence-stop", sessionId)),
          "stopped",
        );
        assert.isFalse(yield* fs.exists(fencePath));

        yield* fs.writeFileString(
          fencePath,
          JSON.stringify({
            version: 1,
            operationId: operation.operationId,
            sessionId,
            status: "recovery_required",
            intentSha256: "0".repeat(64),
          }),
          { mode: 0o600 },
        );
        assertFailure(
          yield* restarted.handle(ensure("mismatched-fence-blocked", sessionId)),
          "recovery_required",
        );
        assert.isTrue(yield* fs.exists(fencePath));
        assertPhase(yield* restarted.handle(stop("mismatched-fence-stop", sessionId)), "stopped");

        yield* fs.writeFileString(
          fencePath,
          JSON.stringify({
            version: 1,
            operationId: operation.operationId,
            sessionId,
            status: "recovery_required",
            intentSha256: hash(encodeRunnerOperation(operation)),
          }),
          { mode: 0o600 },
        );
        yield* fs.remove(`${receiptDirectory(root, operation)}/started.json`);
        assertFailure(
          yield* restarted.handle(ensure("missing-started-fence-blocked", sessionId)),
          "recovery_required",
        );
        assert.isTrue(yield* fs.exists(fencePath));
      }),
    ),
  );

  it.effect("returns unknown for ambiguous or corrupt receipts without rerunning work", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scotty-runner-unknown-" });
        const runtime = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        const ensured = yield* runtime.handle(ensure("unknown-ensure"));
        const workspace = workspaceOf(ensured);
        const ambiguous = exec("ambiguous-exec", [
          process.execPath,
          "-e",
          "const fs = require('node:fs'); fs.appendFileSync('launches.txt', 'launched\\n'); fs.writeFileSync('started', ''); setInterval(() => {}, 1000)",
        ]);
        const running = yield* runtime.handle(ambiguous).pipe(Effect.forkChild);
        let started = false;
        for (let attempt = 0; attempt < 10_000 && !started; attempt++) {
          started = yield* fs.exists(`${workspace}/started`);
          if (!started) yield* Effect.yieldNow;
        }
        assert.isTrue(started);
        yield* Fiber.interrupt(running);

        const restarted = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        assertFailure(
          yield* restarted.handle({
            ...ambiguous,
            argv: [process.execPath, "-e", "process.stdout.write('must-not-run')"],
          }),
          "idempotency_conflict",
        );
        assertFailure(yield* restarted.handle(ambiguous), "operation_unknown");
        assert.strictEqual(yield* fs.readFileString(`${workspace}/launches.txt`), "launched\n");

        const inconsistentOperation = inspect("completed-without-started", "session-inconsistent");
        yield* restarted.handle(inconsistentOperation);
        const inconsistentReceipts = receiptDirectory(root, inconsistentOperation);
        yield* fs.remove(`${inconsistentReceipts}/started.json`);
        const restartedInconsistent = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        assertFailure(
          yield* restartedInconsistent.handle(inconsistentOperation),
          "operation_unknown",
        );

        const completedOperation = inspect("completed-then-corrupt", "session-corrupt");
        const completedRuntime = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        yield* completedRuntime.handle(completedOperation);
        const completedReceipts = receiptDirectory(root, completedOperation);
        yield* fs.writeFileString(`${completedReceipts}/completed.json`, "{corrupt", {
          mode: 0o600,
        });

        const restartedCorrupt = yield* makeRunnerRuntime({
          root,
          childEnvironment: {},
          isolation: { type: "process" },
        });
        assertFailure(yield* restartedCorrupt.handle(completedOperation), "operation_unknown");
      }),
    ),
  );
});
