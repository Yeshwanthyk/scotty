import { runtimeCliMaterializerTestLayer, sessionIdentityPin } from "../runtime-cli/fixtures";
import { assert, describe, it } from "@effect/vitest";
import type { BackupOptions, ExecResult, ProcessStatus } from "@cloudflare/sandbox";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { CODEX_VERSION } from "../../../protocol/agents/codex/codex-app-server";
import { backupStoreLayer, type BackupCapabilities } from "../../src/backups/store";
import { sessionRuntimeCredentials } from "../../src/credentials/managed";
import { ContainerAuth } from "../../src/sandbox/auth";
import {
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  type SandboxRuntimeCapabilities,
} from "../../src/sandbox/runtime";
import type { DirectoryBackup } from "../../src/session/contracts";
import {
  BackupLifecycleSandbox,
  BackupLifecycleSandboxFailure,
  backupLifecycleSandboxLayer,
  sandboxBackupAttemptName,
  sandboxRuntimeStopLayer,
  type BackupLifecycleAttempt,
} from "../../src/session-actor/transitions/backup-lifecycle-sandbox";

const attempt: BackupLifecycleAttempt = {
  configuration: sessionIdentityPin.configuration,
  selection: { agent: "pi" },
  sessionId: "session-backup",
  attempt: "1ed4a6f4-7d9f-46b9-8a07-ef6d9c1dd64c",
  deadlineAt: "2026-09-01T00:05:00.000Z",
  operationNonce: "operation-1",
  runtimeGeneration: "runtime-generation-1",
  transitionFence: { revision: 1, mode: "executing", phase: "RuntimeReady" },
};
const backup: DirectoryBackup = {
  id: attempt.attempt,
  dir: "/workspace/session-backup",
  localBucket: true,
};
const marker = `${JSON.stringify({
  sessionId: attempt.sessionId,
  attempt: attempt.attempt,
  runtimeGeneration: attempt.runtimeGeneration,
})}\n`;

const success = (command: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  command,
  duration: 1,
  timestamp: "2026-09-01T00:00:00.000Z",
});

const stream = (value: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });

const authService = (overrides: Partial<ContainerAuth["Service"]> = {}): ContainerAuth["Service"] =>
  ContainerAuth.of({
    seed: () => Effect.void,
    preflight: () => Effect.void,
    ensureTerminal: () => Effect.void,
    ensurePiSession: () => Effect.void,
    startPiSession: () => Effect.succeed("scotty-pi-session"),
    waitForPiSessionReady: () => Effect.void,
    readPiSessionHealth: () => Effect.succeed({ processId: "scotty-pi-session", epoch: "epoch-1" }),
    verifyPiSessionSnapshot: () =>
      Effect.succeed({ processId: "scotty-pi-session", epoch: "epoch-1" }),
    quiescePiSession: () => Effect.void,
    stopPiSession: () => Effect.void,
    refreshPiAuth: () => Effect.void,
    ...overrides,
  });

const backupCapabilities = (overrides: Partial<BackupCapabilities> = {}): BackupCapabilities => ({
  createBackup: async () => backup,
  restoreBackup: async (value) => ({ success: true, id: value.id, dir: value.dir }),
  deleteBackup: async () => undefined,
  ...overrides,
});

const runtimeCapabilities = (
  overrides: Partial<SandboxRuntimeCapabilities> = {},
): SandboxRuntimeCapabilities => ({
  getState: async () => ({ status: "running" }),
  getContainerIncarnationId: async () => "placement-1",
  exec: async (command) => success(command),
  mkdir: async () => undefined,
  readFileStream: async () => stream(marker),
  writeFile: async () => undefined,
  setEnvVars: async () => undefined,
  getProcess: async () => null,
  ...overrides,
});

const withProvider = <A, E>(
  effect: Effect.Effect<A, E, BackupLifecycleSandbox>,
  options: {
    readonly backups?: BackupCapabilities;
    readonly runtime?: SandboxRuntimeCapabilities;
    readonly auth?: ContainerAuth["Service"];
    readonly requestStop?: () => Promise<void>;
  } = {},
): Effect.Effect<A, E> => {
  const dependencies = Layer.mergeAll(
    runtimeCliMaterializerTestLayer,
    backupStoreLayer(options.backups ?? backupCapabilities()),
    sandboxRuntimeLayer(options.runtime ?? runtimeCapabilities()),
    Layer.succeed(ContainerAuth)(options.auth ?? authService()),
    sandboxRuntimeStopLayer({ requestStop: options.requestStop ?? (async () => undefined) }),
  );
  return Effect.provide(effect, backupLifecycleSandboxLayer.pipe(Layer.provide(dependencies)));
};

const failure = <A>(
  result: Result.Result<A, BackupLifecycleSandboxFailure>,
): BackupLifecycleSandboxFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("BackupLifecycleSandbox", () => {
  it.effect("restores an owned source backup into a distinct resume runtime generation", () =>
    Effect.gen(function* () {
      const sourceRuntimeGeneration = "warm-runtime-generation";
      const restored = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.restoreCurrentBackup({
            ...attempt,
            attempt: "e14136de-111f-4f6b-bf71-7cfbe7794544",
            operationNonce: "resume-operation",
            runtimeGeneration: "resume-runtime-generation",
            backup: {
              backupId: backup.id,
              preparedAt: "2026-09-01T00:00:00.000Z",
              confirmedAt: "2026-09-01T00:00:01.000Z",
              sourceRuntimeGeneration,
            },
            ownedBackupIds: [backup.id],
          }),
        ),
        {
          runtime: runtimeCapabilities({
            readFileStream: async () =>
              stream(
                `${JSON.stringify({
                  sessionId: attempt.sessionId,
                  attempt: "8a650fe2-bc8b-42fc-a163-7df0eb28ae18",
                  runtimeGeneration: sourceRuntimeGeneration,
                })}\n`,
              ),
          }),
        },
      );
      assert.strictEqual(restored, undefined);
    }),
  );

  it.effect("rejects a sweep with less than the minimum budget before exec", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-09-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      let execCalls = 0;
      const result = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          Effect.result(
            provider.sweepWorkspaceWriters({
              ...attempt,
              deadlineAt: new Date(now + 34_999).toISOString(),
            }),
          ),
        ),
        {
          runtime: runtimeCapabilities({
            exec: async (command) => {
              execCalls += 1;
              return success(command);
            },
          }),
        },
      );
      assert.deepStrictEqual(
        failure(result),
        new BackupLifecycleSandboxFailure({
          outcome: "rejected_before_admission",
          safeResultCode: "workspace_writer_sweep_budget_exhausted",
        }),
      );
      assert.strictEqual(execCalls, 0);

      {
        const now = Date.parse("2026-09-01T00:00:00.000Z");
        yield* TestClock.setTime(now);
        let admitted = false;
        const createResult = yield* withProvider(
          Effect.flatMap(BackupLifecycleSandbox, (provider) =>
            Effect.result(
              provider.prepareBackup({
                ...attempt,
                deadlineAt: new Date(now + 10_000).toISOString(),
              }),
            ),
          ),
          {
            backups: backupCapabilities({
              createBackup: async () => {
                admitted = true;
                return backup;
              },
            }),
          },
        );
        assert.isFalse(admitted);
        assert.deepStrictEqual(
          failure(createResult),
          new BackupLifecycleSandboxFailure({
            outcome: "rejected_before_admission",
            safeResultCode: "backup_create_timeout",
          }),
        );

        const invalidResult = yield* withProvider(
          Effect.flatMap(BackupLifecycleSandbox, (provider) =>
            Effect.result(provider.prepareBackup({ ...attempt, deadlineAt: "invalid-date" })),
          ),
          { backups: backupCapabilities({ createBackup: () => Promise.resolve(backup) }) },
        );
        assert.deepStrictEqual(
          failure(invalidResult),
          new BackupLifecycleSandboxFailure({
            outcome: "rejected_before_admission",
            safeResultCode: "backup_create_timeout",
          }),
        );
      }

      {
        const now = Date.parse("2026-09-01T00:00:00.000Z");
        yield* TestClock.setTime(now);
        let admitted = false;
        const restoreResult = yield* withProvider(
          Effect.flatMap(BackupLifecycleSandbox, (provider) =>
            Effect.result(
              provider.restoreCurrentBackup({
                ...attempt,
                deadlineAt: new Date(now + 10_000).toISOString(),
                backup: {
                  backupId: backup.id,
                  preparedAt: attempt.deadlineAt,
                  confirmedAt: attempt.deadlineAt,
                  sourceRuntimeGeneration: attempt.runtimeGeneration,
                },
                ownedBackupIds: [backup.id],
              }),
            ),
          ),
          {
            backups: backupCapabilities({
              restoreBackup: async (value) => {
                admitted = true;
                return { success: true, id: value.id, dir: value.dir };
              },
            }),
          },
        );
        assert.isFalse(admitted);
        assert.deepStrictEqual(
          failure(restoreResult),
          new BackupLifecycleSandboxFailure({
            outcome: "rejected_before_admission",
            safeResultCode: "backup_restore_timeout",
          }),
        );
      }
    }),
  );
  it.effect("classifies surviving writers as unknown after the sweep was admitted", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-09-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      const result = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          Effect.result(
            provider.sweepWorkspaceWriters({
              ...attempt,
              deadlineAt: new Date(now + 90_000).toISOString(),
            }),
          ),
        ),
        {
          runtime: runtimeCapabilities({
            exec: async (command) => ({
              ...success(command),
              stdout: '{"found":1,"killed":0,"survivors":1}\n',
            }),
          }),
        },
      );
      assert.deepStrictEqual(
        failure(result),
        new BackupLifecycleSandboxFailure({
          outcome: "unknown_after_admission",
          safeResultCode: "workspace_writers_survived",
        }),
      );
    }),
  );

  for (const [remaining, expectedTimeout] of [
    [90_000, 15_000],
    [40_000, 10_000],
  ] as const) {
    it.effect(`bounds the writer sweep by the remaining budget (${remaining})`, () =>
      Effect.gen(function* () {
        const now = Date.parse("2026-09-01T00:00:00.000Z");
        yield* TestClock.setTime(now);
        let observedTimeout: number | undefined;
        yield* withProvider(
          Effect.flatMap(BackupLifecycleSandbox, (provider) =>
            provider.sweepWorkspaceWriters({
              ...attempt,
              deadlineAt: new Date(now + remaining).toISOString(),
            }),
          ),
          {
            runtime: runtimeCapabilities({
              exec: async (command, options) => {
                observedTimeout = options?.timeout;
                return { ...success(command), stdout: '{"found":0,"killed":0,"survivors":0}\n' };
              },
            }),
          },
        );
        assert.strictEqual(observedTimeout, expectedTimeout);
      }),
    );
  }

  it.effect("times out a sweep whose sandbox exec never returns", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-09-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      const fiber = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          Effect.result(
            provider.sweepWorkspaceWriters({
              ...attempt,
              deadlineAt: new Date(now + 90_000).toISOString(),
            }),
          ),
        ),
        { runtime: runtimeCapabilities({ exec: () => new Promise(() => undefined) }) },
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(15_999);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(
        failure(yield* Fiber.join(fiber)),
        new BackupLifecycleSandboxFailure({
          outcome: "unknown_after_admission",
          safeResultCode: "workspace_writer_sweep_timeout",
        }),
      );

      {
        const createNow = Date.parse("2026-09-01T00:00:00.000Z");
        yield* TestClock.setTime(createNow);
        const createFiber = yield* withProvider(
          Effect.flatMap(BackupLifecycleSandbox, (provider) =>
            Effect.result(
              provider.prepareBackup({
                ...attempt,
                deadlineAt: new Date(createNow + 90_000).toISOString(),
              }),
            ),
          ),
          { backups: backupCapabilities({ createBackup: () => new Promise(() => {}) }) },
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(59_999);
        assert.isUndefined(createFiber.pollUnsafe());
        yield* TestClock.adjust(1);
        assert.deepStrictEqual(
          failure(yield* Fiber.join(createFiber)),
          new BackupLifecycleSandboxFailure({
            outcome: "unknown_after_admission",
            safeResultCode: "backup_create_timeout",
          }),
        );
      }

      {
        const restoreNow = Date.parse("2026-09-01T00:00:00.000Z");
        yield* TestClock.setTime(restoreNow);
        const restoreFiber = yield* withProvider(
          Effect.flatMap(BackupLifecycleSandbox, (provider) =>
            Effect.result(
              provider.restoreCurrentBackup({
                ...attempt,
                deadlineAt: new Date(restoreNow + 35_000).toISOString(),
                backup: {
                  backupId: backup.id,
                  preparedAt: "2026-09-01T00:00:00.000Z",
                  confirmedAt: "2026-09-01T00:00:01.000Z",
                  sourceRuntimeGeneration: attempt.runtimeGeneration,
                },
                ownedBackupIds: [backup.id],
              }),
            ),
          ),
          { backups: backupCapabilities({ restoreBackup: () => new Promise(() => {}) }) },
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(4_999);
        assert.isUndefined(restoreFiber.pollUnsafe());
        yield* TestClock.adjust(1);
        assert.deepStrictEqual(
          failure(yield* Fiber.join(restoreFiber)),
          new BackupLifecycleSandboxFailure({
            outcome: "unknown_after_admission",
            safeResultCode: "backup_restore_timeout",
          }),
        );
      }
    }),
  );

  it.effect("classifies a decisively exited restored Codex supervisor", () =>
    Effect.gen(function* () {
      const result = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.confirmSupervisorReady({
            ...attempt,
            sessionId: "a0b1c2d3e4f5",
            selection: { agent: "codex", model: "gpt-5.4", effort: "high" },
            sidecar: { token: "a".repeat(64), threadId: "thread-1", initialTurnId: "turn-1" },
            runtime: {
              providerRuntimeId: "a0b1c2d3e4f5",
              runtimeGeneration: attempt.runtimeGeneration,
              containerIncarnation: "incarnation-1",
            },
          }),
        ),
        {
          runtime: runtimeCapabilities({
            fetchPort: () => Promise.reject(new Error("control port closed")),
            getProcess: async () => ({
              id: `scotty-codex-${attempt.runtimeGeneration}`,
              status: "failed",
              kill: async () => {},
              waitForExit: async () => ({ exitCode: 1 }),
              waitForPort: async () => {},
            }),
          }),
        },
      ).pipe(Effect.result);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.outcome, "rejected_before_admission");
      assert.equal(result.failure.safeResultCode, "sidecar_resume_supervisor_exited");
    }),
  );

  it.effect("stops a leftover Pi supervisor before starting its replacement", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const credentials = sessionRuntimeCredentials([]);
      const auth = authService({
        stopPiSession: () =>
          Effect.sync(() => {
            calls.push("stop");
          }),
        startPiSession: () =>
          Effect.sync(() => {
            calls.push("start");
            return "scotty-pi-session";
          }),
      });

      const processId = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.startSupervisor({ ...attempt, credentials }),
        ),
        { auth },
      );

      assert.strictEqual(processId, "scotty-pi-session");
      assert.deepStrictEqual(calls, ["stop", "start"]);
    }),
  );

  it.effect("uses deterministic attempt identity and confirms the exact returned backup", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let options: BackupOptions | undefined;
      const backups = backupCapabilities({
        createBackup: async (value) => {
          calls.push("create");
          options = value;
          return backup;
        },
        restoreBackup: async (value) => {
          calls.push(`restore:${value.id}`);
          return { success: true, id: value.id, dir: value.dir };
        },
      });
      const runtime = runtimeCapabilities({
        mkdir: async () => {
          calls.push("mkdir");
        },
        writeFile: async () => {
          calls.push("marker");
        },
        exec: async (command) => {
          calls.push(command);
          return success(command);
        },
        readFileStream: async () => {
          calls.push("read-marker");
          return stream(marker);
        },
      });

      const confirmed = yield* withProvider(
        Effect.gen(function* () {
          const provider = yield* BackupLifecycleSandbox;
          yield* provider.syncWorkspace(attempt);
          const prepared = yield* provider.prepareBackup(attempt);
          return yield* provider.confirmBackup({ ...attempt, prepared: prepared.identity });
        }),
        { backups, runtime },
      );

      assert.strictEqual(options?.name, sandboxBackupAttemptName(attempt));
      assert.match(attempt.attempt, /^[0-9a-f-]{36}$/u);
      assert.strictEqual(options?.backupId, attempt.attempt);
      assert.deepStrictEqual(calls, [
        "mkdir",
        "marker",
        "sync",
        "create",
        `restore:${backup.id}`,
        "read-marker",
      ]);
      assert.strictEqual(confirmed.backupId, backup.id);
      assert.notStrictEqual(confirmed.confirmedAt, null);
      assert.strictEqual(confirmed.sourceRuntimeGeneration, attempt.runtimeGeneration);
    }),
  );

  it.effect("does not restore a backup that is not current, confirmed, and owned", () =>
    Effect.gen(function* () {
      let restoreCalls = 0;
      const result = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          Effect.result(
            provider.restoreCurrentBackup({
              ...attempt,
              backup: {
                backupId: backup.id,
                preparedAt: "2026-09-01T00:00:00.000Z",
                confirmedAt: "2026-09-01T00:00:01.000Z",
                sourceRuntimeGeneration: attempt.runtimeGeneration,
              },
              ownedBackupIds: [],
            }),
          ),
        ),
        {
          backups: backupCapabilities({
            restoreBackup: async (value) => {
              restoreCalls += 1;
              return { success: true, id: value.id, dir: value.dir };
            },
          }),
        },
      );

      assert.deepStrictEqual(
        failure(result),
        new BackupLifecycleSandboxFailure({
          outcome: "rejected_before_admission",
          safeResultCode: "backup_not_current_owned",
        }),
      );
      assert.strictEqual(restoreCalls, 0);
    }),
  );

  it.effect(
    "observes a lost create reply through the same attempt backup and confirms its marker once",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const providerEffect = Effect.gen(function* () {
          const provider = yield* BackupLifecycleSandbox;
          const uncertain = yield* Effect.result(provider.prepareBackup(attempt));
          assert.ok(Result.isFailure(uncertain));
          const observed = yield* provider.observePreparedBackup(attempt);
          return observed;
        });
        const observed = yield* withProvider(providerEffect, {
          backups: backupCapabilities({
            createBackup: async (options) => {
              assert.equal(options.backupId, attempt.attempt);
              calls.push("create-reply-lost");
              throw new SandboxRuntimeFailure({
                reason: "transport",
                message: "backup reply lost",
              });
            },
            restoreBackup: async (handle) => {
              calls.push(`restore:${handle.id}`);
              return { success: true, id: handle.id, dir: handle.dir };
            },
          }),
          runtime: runtimeCapabilities({
            readFileStream: async () => {
              calls.push("verify-marker");
              return stream(marker);
            },
          }),
        });
        assert.equal(observed.backupId, attempt.attempt);
        assert.notEqual(observed.confirmedAt, null);
        assert.deepStrictEqual(calls, [
          "create-reply-lost",
          `restore:${attempt.attempt}`,
          "verify-marker",
        ]);
      }),
  );

  it.effect("reconciles an ambiguous runtime stop only from observed stopped state", () =>
    Effect.gen(function* () {
      const requestedAt = "2026-09-01T00:00:00.000Z";
      const accepted = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.requestRuntimeStop({
            ...attempt,
            requestedAt,
          }),
        ),
        {
          requestStop: async () => Promise.reject(new Error("lost response")),
          runtime: runtimeCapabilities({ getState: async () => ({ status: "stopped" }) }),
        },
      );
      assert.strictEqual(accepted, requestedAt);

      const unknown = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          Effect.result(
            provider.requestRuntimeStop({
              ...attempt,
              requestedAt,
            }),
          ),
        ),
        {
          requestStop: async () => Promise.reject(new Error("lost response")),
          runtime: runtimeCapabilities({ getState: async () => ({ status: "running" }) }),
        },
      );
      assert.deepStrictEqual(
        failure(unknown),
        new BackupLifecycleSandboxFailure({
          outcome: "unknown_after_admission",
          safeResultCode: "sandbox_runtime_stop_outcome_unknown",
        }),
      );
      let stateReads = 0;
      const resolved = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.requestRuntimeStop({ ...attempt, requestedAt }),
        ),
        {
          runtime: runtimeCapabilities({
            getState: async () => {
              stateReads += 1;
              return { status: "stopping" };
            },
          }),
        },
      );
      assert.strictEqual(resolved, requestedAt);
      assert.strictEqual(stateReads, 0);
    }),
  );

  it.effect("reconciles an ambiguous Pi stop only from process absence", () =>
    Effect.gen(function* () {
      let status: ProcessStatus | null = null;
      const credentials = sessionRuntimeCredentials([]);
      const auth = authService({
        stopPiSession: () =>
          Effect.fail(
            new SandboxRuntimeFailure({
              reason: "transport",
              message: "lost response",
            }),
          ),
      });
      const runtime = runtimeCapabilities({
        getProcess: async () =>
          status === null
            ? null
            : {
                id: "scotty-pi-session",
                status,
                kill: async () => undefined,
                waitForExit: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
                waitForPort: async () => undefined,
              },
      });

      yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.quiescePi({ ...attempt, credentials }),
        ),
        { auth, runtime },
      );

      status = "running";
      const unknown = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          Effect.result(provider.quiescePi({ ...attempt, credentials })),
        ),
        { auth, runtime },
      );
      assert.strictEqual(failure(unknown).safeResultCode, "pi_stop_outcome_unknown");
    }),
  );
});

describe("Codex uses the existing backup lifecycle adapter", () => {
  const codex: BackupLifecycleAttempt = {
    ...attempt,
    sessionId: "a0b1c2d3e4f5",
    selection: { agent: "codex", model: "gpt-5.4", effort: "high" },
    sidecar: { token: "a".repeat(64), threadId: "native-thread", initialTurnId: "first-turn" },
  };
  const snapshot = {
    agent: "codex",
    generation: codex.runtimeGeneration,
    threadId: "native-thread",
    version: CODEX_VERSION,
    settings: {
      model: "gpt-5.4",
      effort: "high",
      workspace: "/workspace/a0b1c2d3e4f5",
    },
    ready: true,
    failure: null,
    cleanup: null,
    prompt: {
      status: "terminal",
      turnId: "second-turn",
      outcome: "completed",
      text: "second answer",
    },
    turns: [
      {
        id: "first-turn",
        state: "completed",
        user: "first prompt",
        assistant: "first answer",
        tools: [],
      },
      {
        id: "second-turn",
        state: "completed",
        user: "second prompt",
        assistant: "second answer",
        tools: [],
      },
    ],
  };
  const runtimeProof = {
    providerRuntimeId: "runtime-1",
    runtimeGeneration: codex.runtimeGeneration,
    containerIncarnation: "placement-1",
  };
  it.effect(
    "saves Codex before workspace backup and carries its authority identity through the backup",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        yield* withProvider(
          Effect.gen(function* () {
            const provider = yield* BackupLifecycleSandbox;
            yield* provider.quiescePi({ ...codex, credentials: sessionRuntimeCredentials([]) });
            yield* provider.syncWorkspace(codex);
            const prepared = yield* provider.prepareBackup(codex);
            assert.deepStrictEqual(prepared.identity.sidecar, {
              threadId: "native-thread",
              initialTurnId: "first-turn",
            });
          }),
          {
            auth: authService({
              quiescePiSession: () => Effect.die("Pi must not run"),
              stopPiSession: () => Effect.die("Pi must not run"),
            }),
            runtime: runtimeCapabilities({
              fetchPort: async (path) => {
                calls.push(path);
                return Response.json({
                  generation: codex.runtimeGeneration,
                  threadId: "native-thread",
                  initialTurnId: "first-turn",
                });
              },
              exec: async (command) => {
                calls.push(command);
                return success(command);
              },
            }),
            backups: backupCapabilities({
              createBackup: async () => {
                calls.push("backup");
                return backup;
              },
            }),
          },
        );
        assert.deepStrictEqual(calls, ["/save", "sync", "backup"]);
      }),
  );
  it.effect(
    "resumes the saved native thread and restores the original transport gate without a prompt",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const credentials = sessionRuntimeCredentials([
          {
            name: "codex",
            kind: "pi-auth",
            versionRef: "version-1",
            handleSlots: [{ provider: "openai-codex", slot: "access" }],
            expires: 10000,
          },
        ]);
        yield* withProvider(
          Effect.gen(function* () {
            const provider = yield* BackupLifecycleSandbox;
            yield* provider.startSupervisor({ ...codex, credentials });
            const supervisor = yield* provider.confirmSupervisorReady({
              ...codex,
              runtime: runtimeProof,
            });
            const transport = yield* provider.verifyTransport({
              ...codex,
              runtime: runtimeProof,
              supervisor,
            });
            assert.equal(supervisor.supervisorEpoch, "native-thread");
            assert.equal(transport.transportId, "first-turn");
          }),
          {
            auth: authService({
              startPiSession: () => Effect.die("Pi must not run"),
              stopPiSession: () => Effect.die("Pi must not run"),
            }),
            runtime: runtimeCapabilities({
              fetchPort: async (path) => {
                calls.push(path);
                return Response.json(snapshot);
              },
              startProcess: async (command) => {
                calls.push("launch");
                assert.include(
                  command,
                  '"restore":{"threadId":"native-thread","initialTurnId":"first-turn"}',
                );
                assert.include(command, '"ephemeral":false');
                assert.include(command, '"resumeThreadId":"native-thread"');
                return {
                  id: `scotty-codex-${codex.runtimeGeneration}`,
                  status: "running",
                  kill: async () => {},
                  waitForExit: async () => ({ exitCode: 0 }),
                  waitForPort: async () => {},
                };
              },
            }),
          },
        );
        assert.deepStrictEqual(calls, ["launch", "/snapshot", "/snapshot"]);
      }),
  );
  it.effect(
    "exits the saved server and reclaims its private root before a same-container restart",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let serverRunning = true;
        let privateRootExists = true;
        const credentials = sessionRuntimeCredentials([
          {
            name: "codex",
            kind: "pi-auth",
            versionRef: "version-1",
            handleSlots: [{ provider: "openai-codex", slot: "access" }],
            expires: 10000,
          },
        ]);
        const runtime = runtimeCapabilities({
          fetchPort: async (path) => {
            calls.push(path);
            assert.equal(path, "/save");
            return Response.json({
              generation: codex.runtimeGeneration,
              threadId: codex.sidecar?.threadId,
              initialTurnId: codex.sidecar?.initialTurnId,
            });
          },
          getProcess: async () =>
            serverRunning
              ? {
                  id: `scotty-codex-${codex.runtimeGeneration}`,
                  status: "running",
                  kill: async () => {
                    calls.push("kill");
                    serverRunning = false;
                  },
                  waitForExit: async () => {
                    calls.push("exit");
                    return { exitCode: 0 };
                  },
                  waitForPort: async () => {},
                }
              : null,
          exec: async (command) => {
            if (command.startsWith("rm -rf --")) {
              privateRootExists = false;
              calls.push("remove");
            } else if (command.startsWith("umask 077 && mkdir")) {
              privateRootExists = true;
              calls.push("mkdir");
            }
            return success(command);
          },
          startProcess: async (command, options) => {
            assert.isTrue(privateRootExists);
            assert.isFalse(serverRunning);
            assert.equal(options?.processId, `scotty-codex-${codex.runtimeGeneration}`);
            assert.include(
              command,
              '"restore":{"threadId":"native-thread","initialTurnId":"first-turn"}',
            );
            assert.include(command, '"resumeThreadId":"native-thread"');
            calls.push("launch");
            serverRunning = true;
            return {
              id: `scotty-codex-${codex.runtimeGeneration}`,
              status: "running",
              kill: async () => {},
              waitForExit: async () => ({ exitCode: 0 }),
              waitForPort: async () => {},
            };
          },
        });
        yield* withProvider(
          Effect.gen(function* () {
            const provider = yield* BackupLifecycleSandbox;
            yield* provider.quiescePi({ ...codex, credentials });
            yield* provider.startSupervisor({
              ...codex,
              transitionFence: { ...codex.transitionFence, phase: "BackupConfirmed" },
              credentials,
            });
          }),
          { runtime },
        );
        assert.deepStrictEqual(calls, ["/save", "kill", "exit", "remove", "mkdir", "launch"]);
      }),
  );
  it.effect("does not restart or reclaim the private root while the saved server is live", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const result = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.startSupervisor({
            ...codex,
            transitionFence: { ...codex.transitionFence, phase: "BackupConfirmed" },
            credentials: sessionRuntimeCredentials([]),
          }),
        ).pipe(Effect.result),
        {
          runtime: runtimeCapabilities({
            fetchPort: async () =>
              Response.json({
                generation: codex.runtimeGeneration,
                threadId: "native-thread",
                initialTurnId: "first-turn",
              }),
            getProcess: async () => ({
              id: `scotty-codex-${codex.runtimeGeneration}`,
              status: "running",
              kill: async () => {},
              waitForExit: async () => ({ exitCode: 0 }),
              waitForPort: async () => {},
            }),
            exec: async (command) => {
              commands.push(command);
              return success(command);
            },
          }),
        },
      );
      assert.equal(failure(result).safeResultCode, "sidecar_server_stop_unobserved");
      assert.deepStrictEqual(commands, []);
    }),
  );
  it.effect("rejects wrong saved identity and missing canonical first-turn proof", () =>
    Effect.gen(function* () {
      const saved = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.quiescePi({ ...codex, credentials: sessionRuntimeCredentials([]) }),
        ).pipe(Effect.result),
        {
          runtime: runtimeCapabilities({
            fetchPort: async () =>
              Response.json({
                generation: codex.runtimeGeneration,
                threadId: "wrong-thread",
                initialTurnId: "first-turn",
              }),
          }),
        },
      );
      assert.equal(failure(saved).safeResultCode, "sidecar_save_outcome_unknown");
      const transport = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.verifyTransport({
            ...codex,
            runtime: runtimeProof,
            supervisor: {
              processId: `scotty-codex-${codex.runtimeGeneration}`,
              supervisorEpoch: "native-thread",
              runtimeGeneration: codex.runtimeGeneration,
              containerIncarnation: "placement-1",
            },
          }),
        ).pipe(Effect.result),
        {
          runtime: runtimeCapabilities({
            fetchPort: async () => Response.json({ ...snapshot, turns: snapshot.turns.slice(1) }),
          }),
        },
      );
      assert.equal(failure(transport).safeResultCode, "sidecar_resume_history_mismatch");
    }),
  );
});
