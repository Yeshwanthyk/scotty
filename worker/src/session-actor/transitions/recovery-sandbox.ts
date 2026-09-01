import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { ContainerAuth, PI_SESSION_PROCESS_ID } from "../../sandbox/auth";
import { SandboxRuntime, type SandboxRuntimeFailure } from "../../sandbox/runtime";
import { AuthorityStateSchema, StableStateSchema, type SessionAuthority } from "../authority";
import type { SessionActorInput } from "../input";

const RuntimeStateSchema = Schema.Struct({
  status: Schema.Literals(["running", "healthy", "stopping", "stopped", "stopped_with_code"]),
});
const decodeRuntimeState = Schema.decodeUnknownResult(RuntimeStateSchema, {
  onExcessProperty: "ignore",
});

export type RuntimeLifecycleObservation = Extract<
  SessionActorInput,
  { readonly _tag: "RuntimeLifecycleObserved" }
>;
export type SupervisorUnavailableObservation = Extract<
  SessionActorInput,
  { readonly _tag: "SupervisorUnavailableObserved" }
>;
export type TransportUnavailableObservation = Extract<
  SessionActorInput,
  { readonly _tag: "TransportUnavailableObserved" }
>;

export interface RecoveryRuntimeFence {
  readonly sessionId: string;
  readonly providerRuntimeId: string;
  readonly runtimeGeneration: string;
  readonly correlationId: string;
}

export interface RecoverySupervisorFence extends RecoveryRuntimeFence {
  readonly supervisorEpoch: string;
}

export interface RecoveryTransportFence extends RecoverySupervisorFence {
  readonly transportId: string;
}

export class RecoverySandboxFailure extends Schema.TaggedError<RecoverySandboxFailure>()(
  "RecoverySandboxFailure",
  {
    operation: Schema.Literals([
      "observe_runtime",
      "observe_supervisor",
      "observe_transport",
      "destroy_failed_runtime",
    ]),
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    providerCancellation: Schema.Literal("unsupported"),
  },
) {}

export interface RecoveryRuntimeDestroyCapabilities {
  /**
   * The Sandbox SDK exposes no AbortSignal for destroy. Resolution confirms the SDK's complete
   * teardown path; rejection or interruption of the caller's wait does not prove cancellation.
   */
  readonly destroy: () => Promise<void>;
}

interface RecoveryRuntimeDestroyShape {
  readonly destroy: () => Effect.Effect<void, RecoverySandboxFailure>;
}

export class RecoveryRuntimeDestroy extends Context.Service<
  RecoveryRuntimeDestroy,
  RecoveryRuntimeDestroyShape
>()("scotty/SessionActor/RecoveryRuntimeDestroy") {}

export const recoveryRuntimeDestroyLayer = (
  capabilities: RecoveryRuntimeDestroyCapabilities,
): Layer.Layer<RecoveryRuntimeDestroy> =>
  Layer.succeed(RecoveryRuntimeDestroy)(
    RecoveryRuntimeDestroy.of({
      // A zero-argument thunk is deliberate: the installed Sandbox SDK cannot accept or confirm
      // provider cancellation, even though interrupting this Effect stops the local wait.
      destroy: () =>
        Effect.tryPromise({
          try: () => capabilities.destroy(),
          catch: () =>
            failure(
              "destroy_failed_runtime",
              "unknown_after_admission",
              "runtime_destroy_outcome_unknown",
            ),
        }),
    }),
  );

interface RecoverySandboxShape {
  readonly observeRuntimeStarted: (
    fence: RecoveryRuntimeFence,
  ) => Effect.Effect<RuntimeLifecycleObservation, RecoverySandboxFailure>;
  readonly observeRuntimeStoppedCallback: (
    fence: RecoveryRuntimeFence,
  ) => Effect.Effect<RuntimeLifecycleObservation>;
  readonly observeSupervisorUnavailable: (
    fence: RecoverySupervisorFence,
  ) => Effect.Effect<SupervisorUnavailableObservation, RecoverySandboxFailure>;
  readonly observeTransportUnavailable: (
    fence: RecoveryTransportFence,
  ) => Effect.Effect<TransportUnavailableObservation, RecoverySandboxFailure>;
  readonly destroyFailedRuntime: (
    authority: SessionAuthority,
  ) => Effect.Effect<void, RecoverySandboxFailure>;
}

export class RecoverySandbox extends Context.Service<RecoverySandbox, RecoverySandboxShape>()(
  "scotty/SessionActor/RecoverySandbox",
) {}

const failure = (
  operation: RecoverySandboxFailure["operation"],
  outcome: RecoverySandboxFailure["outcome"],
  safeResultCode: string,
): RecoverySandboxFailure =>
  new RecoverySandboxFailure({
    operation,
    outcome,
    safeResultCode,
    providerCancellation: "unsupported",
  });

const observedAt = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString());

const terminalProcessStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "killed" || status === "error";

const mapReadFailure = (
  operation: "observe_runtime" | "observe_supervisor" | "observe_transport",
  error: SandboxRuntimeFailure,
  unavailableCode: string,
  unknownCode: string,
): RecoverySandboxFailure =>
  error.reason === "transport"
    ? failure(operation, "unknown_after_admission", unknownCode)
    : failure(operation, "rejected_before_admission", unavailableCode);

const supervisorUnavailableInput = (
  fence: RecoverySupervisorFence,
  timestamp: string,
): SupervisorUnavailableObservation => ({
  _tag: "SupervisorUnavailableObserved",
  expectedRuntimeGeneration: fence.runtimeGeneration,
  expectedSupervisorEpoch: fence.supervisorEpoch,
  correlationId: fence.correlationId,
  timestamp,
  resultCode: "supervisor_unavailable_confirmed",
});

const transportUnavailableInput = (
  fence: RecoveryTransportFence,
  timestamp: string,
): TransportUnavailableObservation => ({
  _tag: "TransportUnavailableObserved",
  expectedRuntimeGeneration: fence.runtimeGeneration,
  expectedSupervisorEpoch: fence.supervisorEpoch,
  expectedTransportId: fence.transportId,
  correlationId: fence.correlationId,
  timestamp,
  resultCode: "transport_unavailable_confirmed",
});

export const recoverySandboxLayer: Layer.Layer<
  RecoverySandbox,
  never,
  SandboxRuntime | ContainerAuth | RecoveryRuntimeDestroy
> = Layer.effect(
  RecoverySandbox,
  Effect.gen(function* () {
    const runtime = yield* SandboxRuntime;
    const auth = yield* ContainerAuth;
    const destroy = yield* RecoveryRuntimeDestroy;

    const observeRuntimeStarted = Effect.fnUntraced(function* (fence: RecoveryRuntimeFence) {
      const state = yield* runtime
        .getState()
        .pipe(
          Effect.mapError((error) =>
            mapReadFailure(
              "observe_runtime",
              error,
              "runtime_not_started",
              "runtime_state_unknown",
            ),
          ),
        );
      const decoded = decodeRuntimeState(state);
      if (
        Result.isFailure(decoded) ||
        (decoded.success.status !== "running" && decoded.success.status !== "healthy")
      )
        return yield* failure(
          "observe_runtime",
          Result.isFailure(decoded) ? "unknown_after_admission" : "rejected_before_admission",
          Result.isFailure(decoded) ? "runtime_state_unknown" : "runtime_not_started",
        );
      const placement = yield* runtime
        .getContainerIncarnationId()
        .pipe(
          Effect.mapError((error) =>
            mapReadFailure(
              "observe_runtime",
              error,
              "runtime_incarnation_unavailable",
              "runtime_incarnation_unknown",
            ),
          ),
        );
      if (placement === null || placement.length === 0)
        return yield* failure(
          "observe_runtime",
          "unknown_after_admission",
          "runtime_incarnation_unknown",
        );
      return {
        _tag: "RuntimeLifecycleObserved" as const,
        expectedProviderRuntimeId: fence.providerRuntimeId,
        expectedRuntimeGeneration: fence.runtimeGeneration,
        lifecycle: "started" as const,
        runtime: {
          providerRuntimeId: fence.providerRuntimeId,
          runtimeGeneration: fence.runtimeGeneration,
          containerIncarnation: placement,
        },
        correlationId: fence.correlationId,
        timestamp: yield* observedAt,
        resultCode: "runtime_started_confirmed",
      };
    });

    const observeRuntimeStoppedCallback = Effect.fnUntraced(function* (
      fence: RecoveryRuntimeFence,
    ) {
      return {
        _tag: "RuntimeLifecycleObserved" as const,
        expectedProviderRuntimeId: fence.providerRuntimeId,
        expectedRuntimeGeneration: fence.runtimeGeneration,
        lifecycle: "stopped" as const,
        runtime: null,
        correlationId: fence.correlationId,
        timestamp: yield* observedAt,
        resultCode: "runtime_stopped_callback",
      };
    });

    const observeSupervisorUnavailable = Effect.fnUntraced(function* (
      fence: RecoverySupervisorFence,
    ) {
      const process = yield* runtime
        .getProcess(PI_SESSION_PROCESS_ID)
        .pipe(
          Effect.mapError((error) =>
            mapReadFailure(
              "observe_supervisor",
              error,
              "supervisor_unavailable_confirmed",
              "supervisor_observation_unknown",
            ),
          ),
        );
      if (process === null || terminalProcessStatus(process.status))
        return supervisorUnavailableInput(fence, yield* observedAt);

      const health = yield* Effect.result(auth.readPiSessionHealth(fence.sessionId));
      if (Result.isFailure(health)) {
        if (health.failure.reason === "transport")
          return yield* failure(
            "observe_supervisor",
            "unknown_after_admission",
            "supervisor_observation_unknown",
          );
        return supervisorUnavailableInput(fence, yield* observedAt);
      }
      if (health.success.processId !== process.id || health.success.epoch !== fence.supervisorEpoch)
        return supervisorUnavailableInput(fence, yield* observedAt);
      return yield* failure(
        "observe_supervisor",
        "rejected_before_admission",
        "supervisor_still_available",
      );
    });

    const observeTransportUnavailable = Effect.fnUntraced(function* (
      fence: RecoveryTransportFence,
    ) {
      const snapshot = yield* Effect.result(
        auth.verifyPiSessionSnapshot(fence.sessionId, fence.supervisorEpoch),
      );
      if (Result.isFailure(snapshot)) {
        if (snapshot.failure.reason === "transport")
          return yield* failure(
            "observe_transport",
            "unknown_after_admission",
            "transport_observation_unknown",
          );
        return transportUnavailableInput(fence, yield* observedAt);
      }
      if (
        `pi:${snapshot.success.processId}` !== fence.transportId ||
        snapshot.success.epoch !== fence.supervisorEpoch
      )
        return transportUnavailableInput(fence, yield* observedAt);
      return yield* failure(
        "observe_transport",
        "rejected_before_admission",
        "transport_still_available",
      );
    });

    const destroyFailedRuntime = Effect.fnUntraced(function* (authority: SessionAuthority) {
      if (
        !AuthorityStateSchema.guards.Stable(authority.state) ||
        !StableStateSchema.guards.Failed(authority.state.stable)
      )
        return yield* failure(
          "destroy_failed_runtime",
          "rejected_before_admission",
          "failed_authority_required",
        );
      yield* destroy.destroy();
    });

    return RecoverySandbox.of({
      observeRuntimeStarted,
      observeRuntimeStoppedCallback,
      observeSupervisorUnavailable,
      observeTransportUnavailable,
      destroyFailedRuntime,
    });
  }),
);
