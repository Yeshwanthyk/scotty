import { assert, describe, it } from "@effect/vitest";
import type { BackupOptions, ExecResult, ProcessStatus } from "@cloudflare/sandbox";
import { Effect, Layer, Result } from "effect";
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
  sessionId: "session-backup",
  attempt: "1ed4a6f4-7d9f-46b9-8a07-ef6d9c1dd64c",
  operationNonce: "operation-1",
  runtimeGeneration: "runtime-generation-1",
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

  it.effect("restores an owned source backup into a distinct resume runtime generation", () =>
    Effect.gen(function* () {
      const sourceRuntimeGeneration = "warm-runtime-generation";
      const restored = yield* withProvider(
        Effect.flatMap(BackupLifecycleSandbox, (provider) =>
          provider.restoreCurrentBackup({
            sessionId: attempt.sessionId,
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
    }),
  );

  it.effect(
    "accepts a resolved runtime stop request without requiring immediate stopped state",
    () =>
      Effect.gen(function* () {
        let stateReads = 0;
        const requestedAt = "2026-09-01T00:00:00.000Z";
        const accepted = yield* withProvider(
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
        assert.strictEqual(accepted, requestedAt);
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
