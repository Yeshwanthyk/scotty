import { Clock, Context, Effect, Layer, Match, Result, Schema } from "effect";
import { BackupStore, type BackupStoreFailure } from "../../backups/store";
import { ContainerAuth, PI_SESSION_PROCESS_ID } from "../../sandbox/auth";
import {
  sessionRuntimeCredentials,
  type SessionRuntimeCredentials,
} from "../../credentials/managed";
import { SandboxRuntime, type SandboxRuntimeFailure } from "../../sandbox/runtime";
import { sessionRoot } from "../../sandbox/workspace";
import type { DirectoryBackup } from "../../session/contracts";
import type {
  BackupIdentity,
  RuntimeProof,
  StopObservation,
  SupervisorProof,
  TransportProof,
} from "../authority";
import { SessionActorMetadataStore } from "../metadata-store";
import {
  CheckpointProviderFailure,
  CheckpointTransitionProvider,
  type CheckpointProviderContext,
  type CheckpointProviderResult,
} from "./checkpoint";
import {
  ResumeProviderFailure,
  ResumeTransitionProvider,
  type ResumeProviderContext,
  type ResumeProviderResult,
} from "./resume";
import {
  SleepProviderFailure,
  SleepTransitionProvider,
  type SleepProviderContext,
  type SleepProviderResult,
} from "./sleep";

const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const BACKUP_MARKER_MAX_BYTES = 4_096;

const RuntimeStateSchema = Schema.Struct({
  status: Schema.Literals(["running", "healthy", "stopping", "stopped", "stopped_with_code"]),
});
const decodeRuntimeState = Schema.decodeUnknownResult(RuntimeStateSchema, {
  onExcessProperty: "ignore",
});

const BackupAttemptMarkerSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  attempt: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  runtimeGeneration: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});
type BackupAttemptMarker = typeof BackupAttemptMarkerSchema.Type;
const decodeBackupAttemptMarker = Schema.decodeUnknownResult(
  Schema.fromJsonString(BackupAttemptMarkerSchema),
  { onExcessProperty: "error" },
);

export class BackupLifecycleSandboxFailure extends Schema.TaggedError<BackupLifecycleSandboxFailure>()(
  "BackupLifecycleSandboxFailure",
  {
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  },
) {}

export interface BackupLifecycleAttempt {
  readonly sessionId: string;
  readonly attempt: string;
  readonly runtimeGeneration: string;
}

export interface PreparedSandboxBackup {
  readonly handle: DirectoryBackup;
  readonly identity: BackupIdentity;
}

export interface SandboxRuntimeStopCapabilities {
  readonly requestStop: () => Promise<void>;
}

interface SandboxRuntimeStopShape {
  readonly requestStop: () => Effect.Effect<void, BackupLifecycleSandboxFailure>;
}

export class SandboxRuntimeStop extends Context.Service<
  SandboxRuntimeStop,
  SandboxRuntimeStopShape
>()("scotty/SessionActor/SandboxRuntimeStop") {}

export const sandboxRuntimeStopLayer = (
  capabilities: SandboxRuntimeStopCapabilities,
): Layer.Layer<SandboxRuntimeStop> =>
  Layer.succeed(SandboxRuntimeStop)(
    SandboxRuntimeStop.of({
      requestStop: () =>
        Effect.tryPromise({
          try: () => capabilities.requestStop(),
          catch: () =>
            boundaryFailure("unknown_after_admission", "sandbox_runtime_stop_outcome_unknown"),
        }),
    }),
  );

interface BackupLifecycleSandboxShape {
  readonly quiescePi: (
    input: BackupLifecycleAttempt & { readonly credentials: SessionRuntimeCredentials },
  ) => Effect.Effect<void, BackupLifecycleSandboxFailure>;
  readonly syncWorkspace: (
    input: BackupLifecycleAttempt,
  ) => Effect.Effect<void, BackupLifecycleSandboxFailure>;
  readonly prepareBackup: (
    input: BackupLifecycleAttempt,
  ) => Effect.Effect<PreparedSandboxBackup, BackupLifecycleSandboxFailure>;
  readonly confirmBackup: (
    input: BackupLifecycleAttempt & { readonly prepared: BackupIdentity },
  ) => Effect.Effect<BackupIdentity, BackupLifecycleSandboxFailure>;
  readonly restoreCurrentBackup: (
    input: BackupLifecycleAttempt & {
      readonly backup: BackupIdentity;
      readonly ownedBackupIds: ReadonlyArray<string>;
    },
  ) => Effect.Effect<void, BackupLifecycleSandboxFailure>;
  readonly requestRuntimeStop: (
    input: BackupLifecycleAttempt & { readonly requestedAt: string },
  ) => Effect.Effect<string, BackupLifecycleSandboxFailure>;
  readonly observeRuntimeStopped: (
    input: BackupLifecycleAttempt & { readonly requestedAt: string },
  ) => Effect.Effect<StopObservation, BackupLifecycleSandboxFailure>;
  readonly confirmRuntimeReady: (
    input: BackupLifecycleAttempt & { readonly providerRuntimeId: string },
  ) => Effect.Effect<RuntimeProof, BackupLifecycleSandboxFailure>;
  readonly startSupervisor: (
    input: BackupLifecycleAttempt & { readonly credentials: SessionRuntimeCredentials },
  ) => Effect.Effect<string, BackupLifecycleSandboxFailure>;
  readonly confirmSupervisorReady: (
    input: BackupLifecycleAttempt & { readonly runtime: RuntimeProof },
  ) => Effect.Effect<SupervisorProof, BackupLifecycleSandboxFailure>;
  readonly verifyTransport: (
    input: BackupLifecycleAttempt & {
      readonly runtime: RuntimeProof;
      readonly supervisor: SupervisorProof;
    },
  ) => Effect.Effect<TransportProof, BackupLifecycleSandboxFailure>;
}

export class BackupLifecycleSandbox extends Context.Service<
  BackupLifecycleSandbox,
  BackupLifecycleSandboxShape
>()("scotty/SessionActor/BackupLifecycleSandbox") {}

const boundaryFailure = (
  outcome: "rejected_before_admission" | "unknown_after_admission",
  safeResultCode: string,
): BackupLifecycleSandboxFailure => new BackupLifecycleSandboxFailure({ outcome, safeResultCode });

const mapRuntimeFailure = (
  error: SandboxRuntimeFailure,
  safeResultCode: string,
): BackupLifecycleSandboxFailure =>
  boundaryFailure(
    error.reason === "transport" ? "unknown_after_admission" : "rejected_before_admission",
    safeResultCode,
  );

const mapBackupMutationFailure = (
  _error: BackupStoreFailure,
  safeResultCode: string,
): BackupLifecycleSandboxFailure => boundaryFailure("unknown_after_admission", safeResultCode);

const timestamp = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString());

const markerPath = (sessionId: string): string =>
  `${sessionRoot(sessionId)}/.scotty/backup-attempt.json`;

const backupNamePart = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80);

export const sandboxBackupAttemptName = (input: BackupLifecycleAttempt): string =>
  `scotty-${backupNamePart(input.sessionId)}-${backupNamePart(input.attempt)}`;

const terminalProcessStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "killed" || status === "error";

const readAndVerifyMarker = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  expected: {
    readonly sessionId: string;
    readonly attempt?: string;
    readonly runtimeGeneration: string;
  },
) {
  const bytes = yield* runtime
    .readFile(markerPath(expected.sessionId), BACKUP_MARKER_MAX_BYTES)
    .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "backup_marker_unobserved")));
  const decoded = decodeBackupAttemptMarker(new TextDecoder().decode(bytes));
  if (
    Result.isFailure(decoded) ||
    decoded.success.sessionId !== expected.sessionId ||
    (expected.attempt !== undefined && decoded.success.attempt !== expected.attempt) ||
    decoded.success.runtimeGeneration !== expected.runtimeGeneration
  )
    return yield* boundaryFailure("unknown_after_admission", "backup_marker_mismatch");
});

const runtimeReadyProof = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  input: BackupLifecycleAttempt & { readonly providerRuntimeId: string },
) {
  const state = yield* runtime
    .getState()
    .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "runtime_state_unknown")));
  const decoded = decodeRuntimeState(state);
  if (
    Result.isFailure(decoded) ||
    (decoded.success.status !== "running" && decoded.success.status !== "healthy")
  )
    return yield* boundaryFailure("rejected_before_admission", "runtime_not_ready");
  const incarnationId = yield* runtime
    .getContainerIncarnationId()
    .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "runtime_incarnation_unknown")));
  if (incarnationId === null || incarnationId.length === 0)
    return yield* boundaryFailure("unknown_after_admission", "runtime_incarnation_unobserved");
  return {
    providerRuntimeId: input.providerRuntimeId,
    runtimeGeneration: input.runtimeGeneration,
    containerIncarnation: incarnationId,
  } satisfies RuntimeProof;
});

export const backupLifecycleSandboxLayer: Layer.Layer<
  BackupLifecycleSandbox,
  never,
  BackupStore | ContainerAuth | SandboxRuntime | SandboxRuntimeStop
> = Layer.effect(
  BackupLifecycleSandbox,
  Effect.gen(function* () {
    const backups = yield* BackupStore;
    const auth = yield* ContainerAuth;
    const runtime = yield* SandboxRuntime;
    const runtimeStop = yield* SandboxRuntimeStop;

    const observePiStopped = Effect.fnUntraced(function* () {
      const process = yield* runtime
        .getProcess(PI_SESSION_PROCESS_ID)
        .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "pi_stop_observation_unknown")));
      if (process !== null && !terminalProcessStatus(process.status))
        return yield* boundaryFailure("rejected_before_admission", "pi_process_still_running");
    });

    const quiescePi = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & { readonly credentials: SessionRuntimeCredentials },
    ) {
      yield* auth
        .quiescePiSession(input.sessionId, input.credentials)
        .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "pi_quiesce_failed")));
      const stopped = yield* Effect.result(
        auth
          .stopPiSession()
          .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "pi_stop_outcome_unknown"))),
      );
      const observed = yield* Effect.result(observePiStopped());
      if (Result.isSuccess(observed)) return;
      if (Result.isFailure(stopped)) return yield* stopped.failure;
      return yield* observed.failure;
    });

    const syncWorkspace = Effect.fnUntraced(function* (input: BackupLifecycleAttempt) {
      const marker: BackupAttemptMarker = {
        sessionId: input.sessionId,
        attempt: input.attempt,
        runtimeGeneration: input.runtimeGeneration,
      };
      yield* runtime
        .mkdir(`${sessionRoot(input.sessionId)}/.scotty`, { recursive: true })
        .pipe(
          Effect.mapError((error) => mapRuntimeFailure(error, "backup_marker_directory_failed")),
        );
      yield* runtime
        .writeFile(markerPath(input.sessionId), `${JSON.stringify(marker)}\n`)
        .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "backup_marker_write_unknown")));
      yield* runtime
        .execChecked("sync", { timeout: 30_000 })
        .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "workspace_sync_failed")));
    });

    const prepareBackup = Effect.fnUntraced(function* (input: BackupLifecycleAttempt) {
      const preparedAt = yield* timestamp;
      const handle = yield* backups
        .create({
          dir: sessionRoot(input.sessionId),
          name: sandboxBackupAttemptName(input),
          ttl: BACKUP_TTL_SECONDS,
          localBucket: true,
          compression: { format: "zstd" },
        })
        .pipe(
          Effect.mapError((error) =>
            mapBackupMutationFailure(error, "backup_create_outcome_unknown"),
          ),
        );
      return {
        handle,
        identity: {
          backupId: handle.id,
          preparedAt,
          confirmedAt: null,
          sourceRuntimeGeneration: input.runtimeGeneration,
        },
      } satisfies PreparedSandboxBackup;
    });

    const confirmHandle = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt,
      handle: DirectoryBackup,
    ) {
      yield* backups
        .restore(handle)
        .pipe(
          Effect.mapError((error) =>
            mapBackupMutationFailure(error, "backup_confirmation_outcome_unknown"),
          ),
        );
      yield* readAndVerifyMarker(runtime, input);
    });

    const confirmBackup = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & { readonly prepared: BackupIdentity },
    ) {
      if (
        input.prepared.confirmedAt !== null ||
        input.prepared.sourceRuntimeGeneration !== input.runtimeGeneration
      )
        return yield* boundaryFailure("rejected_before_admission", "backup_identity_mismatch");
      yield* confirmHandle(input, {
        id: input.prepared.backupId,
        dir: sessionRoot(input.sessionId),
        localBucket: true,
      });
      return { ...input.prepared, confirmedAt: yield* timestamp } satisfies BackupIdentity;
    });

    const restoreCurrentBackup = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & {
        readonly backup: BackupIdentity;
        readonly ownedBackupIds: ReadonlyArray<string>;
      },
    ) {
      if (
        input.backup.confirmedAt === null ||
        !input.ownedBackupIds.includes(input.backup.backupId)
      )
        return yield* boundaryFailure("rejected_before_admission", "backup_not_current_owned");
      const handle: DirectoryBackup = {
        id: input.backup.backupId,
        dir: sessionRoot(input.sessionId),
        localBucket: true,
      };
      yield* backups
        .restore(handle)
        .pipe(
          Effect.mapError((error) =>
            mapBackupMutationFailure(error, "backup_restore_outcome_unknown"),
          ),
        );
      yield* readAndVerifyMarker(runtime, {
        sessionId: input.sessionId,
        runtimeGeneration: input.backup.sourceRuntimeGeneration,
      });
    });

    const observeRuntimeStopped = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & { readonly requestedAt: string },
    ) {
      const state = yield* runtime
        .getState()
        .pipe(
          Effect.mapError((error) => mapRuntimeFailure(error, "runtime_stop_observation_unknown")),
        );
      const decoded = decodeRuntimeState(state);
      if (
        Result.isFailure(decoded) ||
        (decoded.success.status !== "stopped" && decoded.success.status !== "stopped_with_code")
      )
        return yield* boundaryFailure("unknown_after_admission", "runtime_stop_unobserved");
      return {
        requestedAt: input.requestedAt,
        observedAt: yield* timestamp,
        runtimeGeneration: input.runtimeGeneration,
      } satisfies StopObservation;
    });

    const requestRuntimeStop = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & { readonly requestedAt: string },
    ) {
      const requested = yield* Effect.result(runtimeStop.requestStop());
      if (Result.isSuccess(requested)) return input.requestedAt;
      const observed = yield* Effect.result(observeRuntimeStopped(input));
      if (Result.isSuccess(observed)) return input.requestedAt;
      return yield* requested.failure;
    });

    const startSupervisor = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & { readonly credentials: SessionRuntimeCredentials },
    ) {
      return yield* auth
        .startPiSession(input.sessionId, input.credentials)
        .pipe(
          Effect.mapError((error) => mapRuntimeFailure(error, "supervisor_start_outcome_unknown")),
        );
    });

    const confirmSupervisorReady = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & { readonly runtime: RuntimeProof },
    ) {
      if (input.runtime.runtimeGeneration !== input.runtimeGeneration)
        return yield* boundaryFailure("rejected_before_admission", "runtime_generation_mismatch");
      yield* auth
        .waitForPiSessionReady(input.sessionId)
        .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "supervisor_readiness_unknown")));
      const health = yield* auth
        .readPiSessionHealth(input.sessionId)
        .pipe(Effect.mapError((error) => mapRuntimeFailure(error, "supervisor_health_unknown")));
      return {
        processId: health.processId,
        supervisorEpoch: health.epoch,
        runtimeGeneration: input.runtime.runtimeGeneration,
        containerIncarnation: input.runtime.containerIncarnation,
      } satisfies SupervisorProof;
    });

    const verifyTransport = Effect.fnUntraced(function* (
      input: BackupLifecycleAttempt & {
        readonly runtime: RuntimeProof;
        readonly supervisor: SupervisorProof;
      },
    ) {
      if (
        input.runtime.runtimeGeneration !== input.runtimeGeneration ||
        input.supervisor.runtimeGeneration !== input.runtimeGeneration ||
        input.supervisor.containerIncarnation !== input.runtime.containerIncarnation
      )
        return yield* boundaryFailure(
          "rejected_before_admission",
          "transport_proof_fence_mismatch",
        );
      const snapshot = yield* auth
        .verifyPiSessionSnapshot(input.sessionId, input.supervisor.supervisorEpoch)
        .pipe(
          Effect.mapError((error) => mapRuntimeFailure(error, "transport_verification_unknown")),
        );
      if (snapshot.processId !== input.supervisor.processId)
        return yield* boundaryFailure("rejected_before_admission", "transport_process_mismatch");
      return {
        transportId: `pi:${snapshot.processId}`,
        supervisorEpoch: snapshot.epoch,
        runtimeGeneration: input.runtime.runtimeGeneration,
        containerIncarnation: input.runtime.containerIncarnation,
      } satisfies TransportProof;
    });

    return BackupLifecycleSandbox.of({
      quiescePi,
      syncWorkspace,
      prepareBackup,
      confirmBackup,
      restoreCurrentBackup,
      requestRuntimeStop,
      observeRuntimeStopped,
      confirmRuntimeReady: (input) => runtimeReadyProof(runtime, input),
      startSupervisor,
      confirmSupervisorReady,
      verifyTransport,
    });
  }),
);

const checkpointAttempt = (context: CheckpointProviderContext): BackupLifecycleAttempt => ({
  sessionId: context.authority.session.id,
  attempt: context.transition.attempt,
  runtimeGeneration: context.transition.proof.readiness.runtime.runtimeGeneration,
});

const sleepAttempt = (context: SleepProviderContext): BackupLifecycleAttempt => ({
  sessionId: context.authority.session.id,
  attempt: context.transition.attempt,
  runtimeGeneration: context.transition.proof.readiness.runtime.runtimeGeneration,
});

const resumeAttempt = (
  context: ResumeProviderContext,
  runtimeGeneration: string,
): BackupLifecycleAttempt => ({
  sessionId: context.authority.session.id,
  attempt: context.transition.attempt,
  runtimeGeneration,
});

const resumedRuntimeGeneration = (context: ResumeProviderContext): string =>
  `resume-${context.transition.attempt}`;

const credentialsFor = Effect.fnUntraced(function* (
  metadataStore: SessionActorMetadataStore["Service"],
  authority: CheckpointProviderContext["authority"],
) {
  const metadata = yield* metadataStore
    .read(authority)
    .pipe(
      Effect.mapError(() =>
        boundaryFailure("rejected_before_admission", "lifecycle_metadata_unavailable"),
      ),
    );
  const grants = metadata?.createObservations.credentialGrants?.grants;
  if (grants === undefined)
    return yield* boundaryFailure(
      "rejected_before_admission",
      "lifecycle_credential_grants_unavailable",
    );
  return sessionRuntimeCredentials(grants);
});

const observedProviderFailure = Effect.fnUntraced(function* <F>(
  make: (failure: {
    readonly outcome: BackupLifecycleSandboxFailure["outcome"];
    readonly safeResultCode: string;
    readonly observedAt: string;
  }) => F,
  error: BackupLifecycleSandboxFailure,
) {
  return make({
    outcome: error.outcome,
    safeResultCode: error.safeResultCode,
    observedAt: yield* timestamp,
  });
});

const checkpointFailure = (
  error: BackupLifecycleSandboxFailure,
): Effect.Effect<never, CheckpointProviderFailure> =>
  observedProviderFailure((value) => new CheckpointProviderFailure(value), error).pipe(
    Effect.flatMap(Effect.fail),
  );

const sleepFailure = (
  error: BackupLifecycleSandboxFailure,
): Effect.Effect<never, SleepProviderFailure> =>
  observedProviderFailure((value) => new SleepProviderFailure(value), error).pipe(
    Effect.flatMap(Effect.fail),
  );

const resumeFailure = (
  error: BackupLifecycleSandboxFailure,
): Effect.Effect<never, ResumeProviderFailure> =>
  observedProviderFailure((value) => new ResumeProviderFailure(value), error).pipe(
    Effect.flatMap(Effect.fail),
  );

const providerTimestamp = Effect.fnUntraced(function* () {
  return yield* timestamp;
});

export const checkpointSandboxTransitionProviderLayer: Layer.Layer<
  CheckpointTransitionProvider,
  never,
  BackupLifecycleSandbox | SessionActorMetadataStore
> = Layer.effect(
  CheckpointTransitionProvider,
  Effect.gen(function* () {
    const sandbox = yield* BackupLifecycleSandbox;
    const metadataStore = yield* SessionActorMetadataStore;

    const quiescePi = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      const credentials = yield* credentialsFor(metadataStore, context.authority).pipe(
        Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure),
      );
      yield* sandbox
        .quiescePi({ ...checkpointAttempt(context), credentials })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      const observedAt = yield* providerTimestamp();
      return {
        _tag: "PiQuiesced" as const,
        piStoppedAt: observedAt,
        observedAt,
        resultCode: "checkpoint_pi_quiesced",
      };
    });

    const syncWorkspace = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      yield* sandbox
        .syncWorkspace(checkpointAttempt(context))
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      return {
        _tag: "WorkspaceSynced" as const,
        observedAt: yield* providerTimestamp(),
        resultCode: "checkpoint_workspace_synced",
      };
    });

    const prepareBackup = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      const prepared = yield* sandbox
        .prepareBackup(checkpointAttempt(context))
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      return {
        _tag: "BackupPrepared" as const,
        backup: prepared.identity,
        observedAt: yield* providerTimestamp(),
        resultCode: "checkpoint_backup_prepared",
      };
    });

    const confirmBackup = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      const prepared = context.transition.proof.backup.prepared;
      if (prepared === null)
        return yield* checkpointFailure(
          boundaryFailure("rejected_before_admission", "checkpoint_prepared_backup_missing"),
        );
      const backup = yield* sandbox
        .confirmBackup({ ...checkpointAttempt(context), prepared })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      return {
        _tag: "BackupConfirmed" as const,
        backup,
        observedAt: yield* providerTimestamp(),
        resultCode: "checkpoint_backup_confirmed",
      };
    });

    const restartSupervisor = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      const credentials = yield* credentialsFor(metadataStore, context.authority).pipe(
        Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure),
      );
      yield* sandbox
        .startSupervisor({ ...checkpointAttempt(context), credentials })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      return {
        _tag: "SupervisorRestartRequested" as const,
        observedAt: yield* providerTimestamp(),
        resultCode: "checkpoint_supervisor_restart_requested",
      };
    });

    const confirmTransportReady = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      const attemptInput = checkpointAttempt(context);
      const runtime = context.transition.proof.readiness.runtime;
      const supervisor = yield* sandbox
        .confirmSupervisorReady({ ...attemptInput, runtime })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      const transport = yield* sandbox
        .verifyTransport({ ...attemptInput, runtime, supervisor })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      return {
        _tag: "ReadinessRestored" as const,
        supervisor,
        transport,
        observedAt: yield* providerTimestamp(),
        resultCode: "checkpoint_transport_ready",
      };
    });

    const verifyTransport = Effect.fnUntraced(function* (context: CheckpointProviderContext) {
      const readiness = context.transition.proof.readiness;
      const transport = yield* sandbox
        .verifyTransport({
          ...checkpointAttempt(context),
          runtime: readiness.runtime,
          supervisor: readiness.supervisor,
        })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", checkpointFailure));
      return {
        _tag: "TransportVerified" as const,
        transport,
        observedAt: yield* providerTimestamp(),
        resultCode: "checkpoint_transport_verified",
      };
    });

    const reconcile = Effect.fnUntraced(function* (
      context: CheckpointProviderContext,
    ): Effect.fn.Return<CheckpointProviderResult, CheckpointProviderFailure> {
      return yield* Match.value(context.transition.phase).pipe(
        Match.when("Quiescing", () => quiescePi(context)),
        Match.when("PiStopped", () => syncWorkspace(context)),
        Match.when("Syncing", () =>
          checkpointFailure(
            boundaryFailure("unknown_after_admission", "checkpoint_backup_handle_unobserved"),
          ),
        ),
        Match.when("BackupPrepared", () => confirmBackup(context)),
        Match.when("BackupConfirmed", () => restartSupervisor(context)),
        Match.when("SupervisorRestarting", () => confirmTransportReady(context)),
        Match.when("TransportReady", () => verifyTransport(context)),
        Match.exhaustive,
      );
    });

    return CheckpointTransitionProvider.of({
      quiescePi,
      syncWorkspace,
      prepareBackup,
      confirmBackup,
      restartSupervisor,
      confirmTransportReady,
      verifyTransport,
      reconcile,
    });
  }),
);

export const sleepSandboxTransitionProviderLayer: Layer.Layer<
  SleepTransitionProvider,
  never,
  BackupLifecycleSandbox | SessionActorMetadataStore
> = Layer.effect(
  SleepTransitionProvider,
  Effect.gen(function* () {
    const sandbox = yield* BackupLifecycleSandbox;
    const metadataStore = yield* SessionActorMetadataStore;

    const quiescePi = Effect.fnUntraced(function* (context: SleepProviderContext) {
      const credentials = yield* credentialsFor(metadataStore, context.authority).pipe(
        Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure),
      );
      yield* sandbox
        .quiescePi({ ...sleepAttempt(context), credentials })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      const observedAt = yield* providerTimestamp();
      return {
        _tag: "PiQuiesced" as const,
        piStoppedAt: observedAt,
        observedAt,
        resultCode: "sleep_pi_quiesced",
      };
    });

    const syncWorkspace = Effect.fnUntraced(function* (context: SleepProviderContext) {
      yield* sandbox
        .syncWorkspace(sleepAttempt(context))
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      return {
        _tag: "WorkspaceSynced" as const,
        observedAt: yield* providerTimestamp(),
        resultCode: "sleep_workspace_synced",
      };
    });

    const createConfirmedBackup = Effect.fnUntraced(function* (context: SleepProviderContext) {
      const attemptInput = sleepAttempt(context);
      const prepared = yield* sandbox
        .prepareBackup(attemptInput)
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      const backup = yield* sandbox
        .confirmBackup({ ...attemptInput, prepared: prepared.identity })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      return {
        _tag: "BackupConfirmed" as const,
        backup,
        observedAt: yield* providerTimestamp(),
        resultCode: "sleep_backup_confirmed",
      };
    });

    const requestRuntimeStop = Effect.fnUntraced(function* (context: SleepProviderContext) {
      const requestedAt = yield* providerTimestamp();
      const acceptedAt = yield* sandbox
        .requestRuntimeStop({ ...sleepAttempt(context), requestedAt })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      return {
        _tag: "RuntimeStopRequested" as const,
        requestedAt: acceptedAt,
        observedAt: yield* providerTimestamp(),
        resultCode: "sleep_runtime_stop_requested",
      };
    });

    const observeRuntimeStopped = Effect.fnUntraced(function* (context: SleepProviderContext) {
      const requestedAt = context.transition.proof.stopRequestedAt;
      if (requestedAt === null || requestedAt === undefined)
        return yield* sleepFailure(
          boundaryFailure("rejected_before_admission", "sleep_stop_request_missing"),
        );
      const stop = yield* sandbox
        .observeRuntimeStopped({ ...sleepAttempt(context), requestedAt })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      return {
        _tag: "RuntimeStopped" as const,
        stop,
        observedAt: stop.observedAt,
        resultCode: "sleep_runtime_stopped",
      };
    });

    const confirmRuntimeStopped = Effect.fnUntraced(function* (context: SleepProviderContext) {
      const requested = context.transition.proof.stop;
      if (requested === null)
        return yield* sleepFailure(
          boundaryFailure("rejected_before_admission", "sleep_stop_observation_missing"),
        );
      const stop = yield* sandbox
        .observeRuntimeStopped({ ...sleepAttempt(context), requestedAt: requested.requestedAt })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", sleepFailure));
      return {
        _tag: "RuntimeStopConfirmed" as const,
        stop,
        observedAt: stop.observedAt,
        resultCode: "sleep_runtime_stop_confirmed",
      };
    });

    const reconcile = Effect.fnUntraced(function* (
      context: SleepProviderContext,
    ): Effect.fn.Return<SleepProviderResult, SleepProviderFailure> {
      return yield* Match.value(context.transition.phase).pipe(
        Match.when("Quiescing", () => quiescePi(context)),
        Match.when("PiStopped", () => syncWorkspace(context)),
        Match.when("Syncing", () =>
          sleepFailure(
            boundaryFailure("unknown_after_admission", "sleep_backup_handle_unobserved"),
          ),
        ),
        Match.when("BackupConfirmed", () => requestRuntimeStop(context)),
        Match.when("StopRequested", () => observeRuntimeStopped(context)),
        Match.when("RuntimeStopped", () => confirmRuntimeStopped(context)),
        Match.exhaustive,
      );
    });

    return SleepTransitionProvider.of({
      quiescePi,
      syncWorkspace,
      createConfirmedBackup,
      requestRuntimeStop,
      observeRuntimeStopped,
      confirmRuntimeStopped,
      reconcile,
    });
  }),
);

export const resumeSandboxTransitionProviderLayer: Layer.Layer<
  ResumeTransitionProvider,
  never,
  BackupLifecycleSandbox | SessionActorMetadataStore
> = Layer.effect(
  ResumeTransitionProvider,
  Effect.gen(function* () {
    const sandbox = yield* BackupLifecycleSandbox;
    const metadataStore = yield* SessionActorMetadataStore;

    const restoreCurrentBackup = Effect.fnUntraced(function* (context: ResumeProviderContext) {
      const backup = context.transition.proof.backup;
      yield* sandbox
        .restoreCurrentBackup({
          ...resumeAttempt(context, resumedRuntimeGeneration(context)),
          backup,
          ownedBackupIds: context.transition.proof.ownedBackupIds,
        })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", resumeFailure));
      return {
        _tag: "BackupRestored" as const,
        backupId: backup.backupId,
        observedAt: yield* providerTimestamp(),
        resultCode: "resume_backup_restored",
      };
    });

    const confirmRuntimeReady = Effect.fnUntraced(function* (context: ResumeProviderContext) {
      if (context.authority.session.execution.provider !== "cloudflare")
        return yield* resumeFailure(
          boundaryFailure("rejected_before_admission", "resume_runtime_provider_mismatch"),
        );
      const runtime = yield* sandbox
        .confirmRuntimeReady({
          ...resumeAttempt(context, resumedRuntimeGeneration(context)),
          providerRuntimeId: context.authority.session.execution.runtimeName,
        })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", resumeFailure));
      return {
        _tag: "RuntimeReadyConfirmed" as const,
        runtime,
        observedAt: yield* providerTimestamp(),
        resultCode: "resume_runtime_ready",
      };
    });

    const startSupervisor = Effect.fnUntraced(function* (context: ResumeProviderContext) {
      const credentials = yield* credentialsFor(metadataStore, context.authority).pipe(
        Effect.catchTag("BackupLifecycleSandboxFailure", resumeFailure),
      );
      yield* sandbox
        .startSupervisor({
          ...resumeAttempt(context, resumedRuntimeGeneration(context)),
          credentials,
        })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", resumeFailure));
      return {
        _tag: "SupervisorStartRequested" as const,
        observedAt: yield* providerTimestamp(),
        resultCode: "resume_supervisor_start_requested",
      };
    });

    const confirmSupervisorReady = Effect.fnUntraced(function* (context: ResumeProviderContext) {
      const runtime = context.transition.proof.readiness.runtime;
      if (runtime === null)
        return yield* resumeFailure(
          boundaryFailure("rejected_before_admission", "resume_runtime_proof_missing"),
        );
      const supervisor = yield* sandbox
        .confirmSupervisorReady({ ...resumeAttempt(context, runtime.runtimeGeneration), runtime })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", resumeFailure));
      return {
        _tag: "SupervisorReadyConfirmed" as const,
        supervisor,
        observedAt: yield* providerTimestamp(),
        resultCode: "resume_supervisor_ready",
      };
    });

    const verifyTransport = Effect.fnUntraced(function* (context: ResumeProviderContext) {
      const runtime = context.transition.proof.readiness.runtime;
      const supervisor = context.transition.proof.readiness.supervisor;
      if (runtime === null || supervisor === null)
        return yield* resumeFailure(
          boundaryFailure("rejected_before_admission", "resume_readiness_proof_missing"),
        );
      const transport = yield* sandbox
        .verifyTransport({
          ...resumeAttempt(context, runtime.runtimeGeneration),
          runtime,
          supervisor,
        })
        .pipe(Effect.catchTag("BackupLifecycleSandboxFailure", resumeFailure));
      return {
        _tag: "TransportVerified" as const,
        transport,
        observedAt: yield* providerTimestamp(),
        resultCode: "resume_transport_verified",
      };
    });

    const confirmTransportReady = Effect.fnUntraced(function* (context: ResumeProviderContext) {
      const result = yield* verifyTransport(context);
      return {
        _tag: "TransportReadyConfirmed" as const,
        transport: result.transport,
        observedAt: result.observedAt,
        resultCode: "resume_transport_ready",
      };
    });

    const reconcile = Effect.fnUntraced(function* (
      context: ResumeProviderContext,
    ): Effect.fn.Return<ResumeProviderResult, ResumeProviderFailure> {
      return yield* Match.value(context.transition.phase).pipe(
        Match.when("WatchdogArmed", () => restoreCurrentBackup(context)),
        Match.when("BackupRestoring", () => confirmRuntimeReady(context)),
        Match.when("RuntimeReady", () => startSupervisor(context)),
        Match.when("SupervisorStarting", () => confirmSupervisorReady(context)),
        Match.when("SupervisorReady", () => verifyTransport(context)),
        Match.when("TransportReady", () => confirmTransportReady(context)),
        Match.exhaustive,
      );
    });

    return ResumeTransitionProvider.of({
      restoreCurrentBackup,
      confirmRuntimeReady,
      startSupervisor,
      confirmSupervisorReady,
      verifyTransport,
      confirmTransportReady,
      reconcile,
    });
  }),
);
