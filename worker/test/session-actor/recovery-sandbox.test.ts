import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Fiber, Layer, Predicate, Result } from "effect";
import { ContainerAuth } from "../../src/sandbox/auth";
import {
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  type SandboxRuntimeCapabilities,
} from "../../src/sandbox/runtime";
import type { SessionAuthority } from "../../src/session-actor/authority";
import {
  RecoveryRuntimeDestroy,
  RecoverySandbox,
  RecoverySandboxFailure,
  recoveryRuntimeDestroyLayer,
  recoverySandboxLayer,
  type RecoveryRuntimeDestroyCapabilities,
} from "../../src/session-actor/transitions/recovery-sandbox";

const T0 = "2026-09-01T00:00:00.000Z";
const DEADLINE = "2026-09-01T04:00:00.000Z";

const success = (command: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  command,
  duration: 1,
  timestamp: T0,
});

const runtimeCapabilities = (
  overrides: Partial<SandboxRuntimeCapabilities> = {},
): SandboxRuntimeCapabilities => ({
  getState: async () => ({ status: "running" }),
  getContainerIncarnationId: async () => "placement-2",
  exec: async (command) => success(command),
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  setEnvVars: async () => undefined,
  getProcess: async () => ({
    id: "scotty-pi-session",
    status: "running",
    kill: async () => undefined,
    waitForExit: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    waitForPort: async () => undefined,
  }),
  ...overrides,
});

const authService = (overrides: Partial<ContainerAuth["Service"]> = {}): ContainerAuth["Service"] =>
  ContainerAuth.of({
    seed: () => Effect.void,
    preflight: () => Effect.void,
    ensureTerminal: () => Effect.void,
    ensurePiSession: () => Effect.void,
    startPiSession: () => Effect.succeed("scotty-pi-session"),
    waitForPiSessionReady: () => Effect.void,
    readPiSessionHealth: () =>
      Effect.succeed({ processId: "scotty-pi-session", epoch: "supervisor-1" }),
    verifyPiSessionSnapshot: () =>
      Effect.succeed({ processId: "scotty-pi-session", epoch: "supervisor-1" }),
    quiescePiSession: () => Effect.void,
    stopPiSession: () => Effect.void,
    refreshPiAuth: () => Effect.void,
    ...overrides,
  });

const destroyCapabilities = (
  overrides: Partial<RecoveryRuntimeDestroyCapabilities> = {},
): RecoveryRuntimeDestroyCapabilities => ({
  destroy: async () => undefined,
  ...overrides,
});

const withRecovery = <A, E>(
  effect: Effect.Effect<A, E, RecoverySandbox>,
  options: {
    readonly runtime?: SandboxRuntimeCapabilities;
    readonly auth?: ContainerAuth["Service"];
    readonly destroy?: RecoveryRuntimeDestroyCapabilities;
  } = {},
): Effect.Effect<A, E> => {
  const dependencies = Layer.mergeAll(
    sandboxRuntimeLayer(options.runtime ?? runtimeCapabilities()),
    Layer.succeed(ContainerAuth)(options.auth ?? authService()),
    recoveryRuntimeDestroyLayer(options.destroy ?? destroyCapabilities()),
  );
  return Effect.provide(effect, recoverySandboxLayer.pipe(Layer.provide(dependencies)));
};

const runtimeFence = {
  sessionId: "session-recovery",
  providerRuntimeId: "provider-runtime-1",
  runtimeGeneration: "runtime-generation-1",
  correlationId: "correlation-1",
};

const transportFence = {
  ...runtimeFence,
  supervisorEpoch: "supervisor-1",
  transportId: "pi:scotty-pi-session",
};

const failedAuthority = (): SessionAuthority => ({
  session: {
    id: runtimeFence.sessionId,
    title: "Recovery test",
    repository: "owner/repository",
    execution: { provider: "cloudflare", runtimeName: runtimeFence.providerRuntimeId },
    createdAt: T0,
  },
  hardCap: { durationSeconds: 14_400, deadlineAt: DEADLINE, generation: "hard-cap-1" },
  revision: 4,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Failed",
      code: "runtime_stopped",
      actionable: false,
      origin: "Warm",
      lastStable: "Warm",
      backup: null,
      ownedBackupIds: [],
      wakeSource: null,
    },
  },
});

const getFailure = <A>(result: Result.Result<A, RecoverySandboxFailure>) => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("RecoverySandbox", () => {
  it.effect("turns a decisive runtime start observation into a fenced actor input", () =>
    Effect.gen(function* () {
      const input = yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) => recovery.observeRuntimeStarted(runtimeFence)),
      );

      assert.ok(Predicate.isTagged(input, "RuntimeLifecycleObserved"));
      assert.strictEqual(input.lifecycle, "started");
      assert.strictEqual(input.expectedRuntimeGeneration, runtimeFence.runtimeGeneration);
      assert.deepStrictEqual(input.runtime, {
        providerRuntimeId: runtimeFence.providerRuntimeId,
        runtimeGeneration: runtimeFence.runtimeGeneration,
        containerIncarnation: "placement-2",
      });
    }),
  );

  it.effect(
    "accepts the native onStop callback as a stopped fact without guessing runtime state",
    () =>
      Effect.gen(function* () {
        let stateReads = 0;
        const input = yield* withRecovery(
          Effect.flatMap(RecoverySandbox, (recovery) =>
            recovery.observeRuntimeStoppedCallback(runtimeFence),
          ),
          {
            runtime: runtimeCapabilities({
              getState: async () => {
                stateReads += 1;
                return { status: "running" };
              },
            }),
          },
        );

        assert.strictEqual(input.lifecycle, "stopped");
        assert.strictEqual(input.runtime, null);
        assert.strictEqual(stateReads, 0);
      }),
  );

  it.effect("reports supervisor absence only from a decisive process or health observation", () =>
    Effect.gen(function* () {
      const missing = yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) =>
          recovery.observeSupervisorUnavailable(transportFence),
        ),
        { runtime: runtimeCapabilities({ getProcess: async () => null }) },
      );
      assert.ok(Predicate.isTagged(missing, "SupervisorUnavailableObserved"));

      const unknown = yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) =>
          Effect.result(recovery.observeSupervisorUnavailable(transportFence)),
        ),
        {
          auth: authService({
            readPiSessionHealth: () =>
              Effect.fail(
                new SandboxRuntimeFailure({ reason: "transport", message: "lost response" }),
              ),
          }),
        },
      );
      assert.deepStrictEqual(
        getFailure(unknown),
        new RecoverySandboxFailure({
          operation: "observe_supervisor",
          outcome: "unknown_after_admission",
          safeResultCode: "supervisor_observation_unknown",
          providerCancellation: "unsupported",
        }),
      );
    }),
  );

  it.effect("does not claim transport loss from an unknown transport response", () =>
    Effect.gen(function* () {
      const confirmed = yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) =>
          recovery.observeTransportUnavailable(transportFence),
        ),
        {
          auth: authService({
            verifyPiSessionSnapshot: () =>
              Effect.fail(
                new SandboxRuntimeFailure({ reason: "nonzero_exit", message: "not ready" }),
              ),
          }),
        },
      );
      assert.ok(Predicate.isTagged(confirmed, "TransportUnavailableObserved"));

      const unknown = yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) =>
          Effect.result(recovery.observeTransportUnavailable(transportFence)),
        ),
        {
          auth: authService({
            verifyPiSessionSnapshot: () =>
              Effect.fail(
                new SandboxRuntimeFailure({ reason: "transport", message: "lost response" }),
              ),
          }),
        },
      );
      assert.strictEqual(getFailure(unknown).outcome, "unknown_after_admission");
    }),
  );

  it.effect("gates destructive cleanup on committed Failed authority", () =>
    Effect.gen(function* () {
      let destroyCalls = 0;
      const authority = failedAuthority();
      const warm: SessionAuthority = {
        ...authority,
        state: {
          _tag: "Stable",
          stable: {
            _tag: "Warm",
            readiness: {
              runtime: {
                providerRuntimeId: runtimeFence.providerRuntimeId,
                runtimeGeneration: runtimeFence.runtimeGeneration,
                containerIncarnation: "placement-1",
              },
              supervisor: {
                processId: "scotty-pi-session",
                supervisorEpoch: transportFence.supervisorEpoch,
                runtimeGeneration: runtimeFence.runtimeGeneration,
                containerIncarnation: "placement-1",
              },
              transport: {
                transportId: transportFence.transportId,
                supervisorEpoch: transportFence.supervisorEpoch,
                runtimeGeneration: runtimeFence.runtimeGeneration,
                containerIncarnation: "placement-1",
              },
            },
            backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
            activity: null,
          },
        },
      };
      const destroy = destroyCapabilities({
        destroy: async () => {
          destroyCalls += 1;
        },
      });

      const rejected = yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) =>
          Effect.result(recovery.destroyFailedRuntime(warm)),
        ),
        { destroy },
      );
      assert.strictEqual(getFailure(rejected).safeResultCode, "failed_authority_required");
      assert.strictEqual(destroyCalls, 0);

      yield* withRecovery(
        Effect.flatMap(RecoverySandbox, (recovery) => recovery.destroyFailedRuntime(authority)),
        { destroy },
      );
      assert.strictEqual(destroyCalls, 1);
    }),
  );

  it.effect("does not translate interruption into provider cancellation or success", () =>
    Effect.gen(function* () {
      let started = false;
      let resolveDestroy = (): void => undefined;
      const pending = new Promise<void>((resolve) => {
        resolveDestroy = resolve;
      });
      const layer = recoveryRuntimeDestroyLayer({
        destroy: () => {
          started = true;
          return pending;
        },
      });
      const fiber = yield* Effect.flatMap(RecoveryRuntimeDestroy, (destroy) =>
        destroy.destroy(),
      ).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      while (!started) yield* Effect.yieldNow;
      const interrupted = yield* Fiber.interrupt(fiber);
      assert.strictEqual(interrupted, undefined);
      assert.strictEqual(started, true);
      resolveDestroy();
    }),
  );
});
