import { Sandbox as BaseSandbox, streamFile } from "@cloudflare/sandbox";
import {
  decodePiConsoleCommandV1Promise,
  decodePiConsoleRelaySnapshotV1,
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER,
  PI_CONSOLE_PROTOCOL_VERSION,
  PI_CONSOLE_PROXY_PREFIX,
  type PiConsoleCommandV1,
  type PiConsoleStaleCommandV1,
  type PiConsoleUnavailableV1,
} from "../../protocol/pi-console";
import { RUNNER_PROTOCOL_VERSION, type RunnerOperation } from "../../protocol/runner";
import { piProviderMetadata } from "../../protocol/pi-auth";
import {
  type Cause,
  Clock,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schedule,
  Schema,
} from "effect";
import { BackupStore, backupStoreLayer } from "./backup-store";
import { ArtifactStore, artifactStoreLayer, r2ArtifactStoreCapabilities } from "./artifact-store";
import {
  ContainerEvidenceRecorder,
  containerEvidenceRecorderLayer,
} from "./container-evidence-recorder";
import { EvidenceStore, evidenceStoreLayer } from "./evidence-store";
import {
  HatchStore,
  durableObjectHatchStateStorage,
  hatchStoreLayer,
  type HatchCleanupAuthority,
  type HatchWebSocketAuthorization,
} from "./hatch-store";
import {
  EVIDENCE_JOB_TIMEOUT_MILLIS,
  EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER,
  EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  EvidenceArtifactError,
  EvidenceStateError,
  decodeBrowserEvidenceJobEffect,
  decodeCompleteEvidenceStepPublication,
  decodeCompleteEvidenceVideoPublication,
  decodeEvidenceIdentifier,
  decodeEvidencePreviewAdmission,
  decodeEvidencePreviewIngressBytes,
  decodeEvidencePreviewRequestId,
  publicEvidenceSummaryProjection,
  type BrowserEvidenceJobV2,
  type BrowserEvidenceResultV2,
  type EvidenceActiveJobV2,
  type EvidenceArtifactV2,
  type EvidenceJobSummaryV2,
  type EvidencePreviewAdmissionV2,
  type EvidencePreviewPermitAdmissionV2,
  type EvidenceStepResult,
  type EvidenceTerminalStatus,
  type ExposedEvidencePreviewV2,
  type PublicEvidenceJobSummaryV2,
} from "./evidence-contracts";
import type { Bindings } from "./bindings";
import {
  HATCH_MAX_CONCURRENT_SOCKETS,
  HATCH_MAX_WEBSOCKET_AGGREGATE_BYTES,
  HATCH_MAX_WEBSOCKET_MESSAGE_BYTES,
  HATCH_MAX_WEBSOCKET_MESSAGES,
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER,
  HATCH_PRIVATE_WEBSOCKET_HEADER,
  HATCH_RESERVED_RESPONSE_BYTES,
  HATCH_WEBSOCKET_ABSOLUTE_MILLIS,
  HATCH_WEBSOCKET_ADMISSION_MILLIS,
  HATCH_WEBSOCKET_IDLE_MILLIS,
  HatchStateError,
  decodeEnsureHatchInput,
  decodeHatchBrowserClientId,
  decodeHatchCookieDigest,
  decodeHatchCleanupRetry,
  decodeHatchHostRoute,
  decodeHatchIngressBytes,
  decodeHatchRequestAdmission,
  decodeHatchRequestId,
  decodeHatchWebSocketAdmission,
  decodeHatchWebSocketId,
  hatchOrigin,
  publicHatchStatusProjection,
  type HatchCleanupRetryV1,
  type HatchCleanupTarget,
  type HatchHostRouteV1,
  type HatchRecordV1,
  type HatchRequestPermitV1,
  type HatchRestoreDescriptorV1,
  type HatchRouteAuthorizationV1,
  type HatchWebSocketPermitV1,
  type IssuedHatchPermitV1,
  type PublicHatchStatusV1,
} from "./hatch-contracts";
import { sha256Hex } from "./digest";
import {
  EvidenceWorkflowControl,
  EvidenceWorkflowControlError,
  runEvidenceWorkflow,
} from "./evidence-workflow";
import {
  ContainerAuth,
  containerAuthLayer,
  PI_SESSION_PORT,
  PI_SESSION_PROCESS_ID,
  PI_SESSION_TOKEN_HEADER,
  piSessionTransportToken,
} from "./container-auth";
import {
  CredentialVault,
  credentialVaultLayer,
  durableObjectCredentialVaultStorage,
} from "./credential-vault";
import { readBoundedUtf8Body } from "./bounded-http";
import {
  badRequest,
  conflict,
  decodeContainerSessionRequest,
  hasCommittedManagedStop,
  decodeJsonValue,
  notFound,
  ScottyError,
  toProjection,
  toSessionView,
  wrongState,
  type CreateSessionInput,
  type DownArchive,
  type DownManifest,
  type OperationKind,
  type SessionRecord,
  type SessionStatus,
  type SessionView,
} from "./contracts";
import type { CreateIdempotencyMetadata } from "./create-idempotency";
import {
  ALLOWED_HOSTS,
  GITHUB_SENTINEL_PREFIX,
  PI_SENTINEL_PREFIX,
  denyOutbound,
  makeOutboundByHost,
  type CredentialPatch,
  type CredentialRefreshLease,
  type StoredCredential,
} from "./egress";
import { inspectPassiveSession, scottyErrorResponse, steerPassiveSession } from "./passive-session";
import {
  durableObjectSessionRecordStorage,
  makeSessionControlGate,
  SessionStore,
  sessionStoreLayer,
  type SessionControlAuthority,
  type SessionControlGate,
  type SessionRecordStorage,
} from "./session-store";
import {
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsRuntimeAccess,
  VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS,
} from "./session-lifecycle";
import {
  errorName,
  SandboxRuntime,
  SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  shellQuote,
} from "./sandbox-runtime";
import {
  kvSessionProjectionStorage,
  projectSessionBestEffort,
  removeSessionProjection,
  SessionProjection,
  sessionProjectionLayer,
} from "./session-projection";
import { RolloutDiscovery, rolloutDiscoveryLayer } from "./rollout-discovery";
import { sessionRoot, Workspace, workspaceLayer } from "./workspace";

const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const HARD_CAP_GRACE_MS = 30_000;
const ABANDONED_OPERATION_MS = 5 * 60_000;
const MANAGED_STOP_RETRY_SECONDS = 2;
const DESTROY_DEADLINE_MS = 30_000;
const DESTROY_RETRY_SECONDS = 35;
const PASSIVE_PI_CONSOLE_MAX_HEADER_BYTES = 8 * 1024;
const PASSIVE_PI_CONSOLE_REQUEST_HEADERS = ["accept", "content-type", "last-event-id"] as const;
const EVIDENCE_PREVIEW_BASE_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EVIDENCE_CLEANUP_RETRY_SECONDS = 5;
const EVIDENCE_PREVIEW_HOST_TIMEOUT_MILLIS = 5_000;
const SANDBOX_PREVIEW_PROXY_HEADER = "x-sandbox-preview-proxy";
const SANDBOX_PREVIEW_PORT_HEADER = "x-sandbox-preview-port";
const SANDBOX_PREVIEW_TOKEN_HEADER = "x-sandbox-preview-token";
const SANDBOX_PREVIEW_SANDBOX_ID_HEADER = "x-sandbox-preview-sandbox-id";
const PREVIEW_PORT_PATTERN = /^(?:[1-9][0-9]{3,4})$/u;

const deniedEvidencePreviewResponse = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });

const copyBoundedPassivePiConsoleHeaders = (source: Headers): Headers => {
  const headers = new Headers();
  const encoder = new TextEncoder();
  for (const name of PASSIVE_PI_CONSOLE_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && encoder.encode(value).byteLength <= PASSIVE_PI_CONSOLE_MAX_HEADER_BYTES)
      headers.set(name, value);
  }
  return headers;
};

export const decodeSandboxFileStream = (
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
  const chunks = streamFile(source);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(typeof next.value === "string" ? encoder.encode(next.value) : next.value);
    },
    async cancel() {
      // oxlint-disable-next-line scotty/no-error-constructor -- boundary: ReadableStream cancellation interrupts the Cloudflare SDK async generator with a native Error
      await chunks.throw(new Error("Beam-down response stream canceled")).then(
        () => undefined,
        () => undefined,
      );
    },
  });
};

type SandboxServices =
  | ArtifactStore
  | BackupStore
  | ContainerEvidenceRecorder
  | ContainerAuth
  | CredentialVault
  | EvidenceStore
  | HatchStore
  | RolloutDiscovery
  | SandboxRuntime
  | SessionProjection
  | SessionStore
  | Workspace;

interface HardCapPayload {
  hardCapAt: string;
}

interface ManagedStopPayload {
  nonce: string;
  armedAt: string;
}

interface VaporizeRetryPayload {
  id: string;
  nonce: string;
}

interface EvidenceDeadlinePayload {
  readonly nonce: string;
  readonly deadlineAt: string;
}

const EvidenceRetentionPayloadSchema = Schema.Struct({ expiresAt: Schema.String });
type EvidenceRetentionPayload = typeof EvidenceRetentionPayloadSchema.Type;
const decodeEvidenceRetentionPayload = Schema.decodeUnknownOption(EvidenceRetentionPayloadSchema, {
  onExcessProperty: "error",
});

export interface PassivePiConsoleRelay {
  readonly fetch: (input: {
    readonly sessionId: SessionRecord["id"];
    readonly request: Request;
  }) => Promise<Response>;
}

export interface SandboxEffectOptions {
  readonly clock?: Clock.Clock;
  readonly containerEvidenceRecorder?: ContainerEvidenceRecorder["Service"];
  readonly evidencePreviewHostTimeoutMillis?: number;
  readonly passivePiConsoleRelay?: PassivePiConsoleRelay;
  readonly previewRequestForwarder?: (request: Request) => Promise<Response>;
  readonly hatchRequestForwarder?: (request: Request) => Promise<Response>;
}

export const SANDBOX_TEST_ACCEPT_EVIDENCE = Symbol("scotty.test.acceptEvidence");
export const SANDBOX_TEST_EXPOSE_EVIDENCE = Symbol("scotty.test.exposeEvidence");
export const SANDBOX_TEST_COMPLETE_EVIDENCE_STEP = Symbol("scotty.test.completeEvidenceStep");
export const SANDBOX_TEST_FINALIZE_EVIDENCE = Symbol("scotty.test.finalizeEvidence");

class ManagedStopArmedError extends Data.TaggedError("ManagedStopArmedError")<{
  readonly cause: unknown;
}> {}

class SessionShutdownPending extends Data.TaggedError("SessionShutdownPending")<{}> {}

class SessionCreateUncertain extends Data.TaggedError("SessionCreateUncertain")<{
  readonly cause: unknown;
}> {}

class PiRuntimeStopFailure extends Data.TaggedError("PiRuntimeStopFailure")<{
  readonly stage: "quiesce" | "process";
  readonly cause: unknown;
}> {}

export interface CheckpointExitClassification {
  readonly failed: boolean;
  readonly hasDefect: boolean;
  readonly hasTypedFailure: boolean;
  readonly wasInterrupted: boolean;
}

export class CheckpointRuntimeUnavailable extends Data.TaggedError("CheckpointRuntimeUnavailable")<{
  readonly checkpoint: CheckpointExitClassification;
  readonly checkpointCause: Cause.Cause<unknown> | undefined;
  readonly relaunchCause: unknown;
}> {}

type HostOperation = "destroy" | "expose" | "schedule" | "stop" | "unexpose";

class HostOperationFailure extends Data.TaggedError("HostOperationFailure")<{
  readonly operation: HostOperation;
  readonly cause: unknown;
}> {}

interface InFlightCreate {
  readonly id: string;
  readonly keyDigest: string | undefined;
  readonly inputDigest: string | undefined;
  readonly promise: Promise<SessionView>;
}

interface InFlightPreviewRequest {
  readonly operationNonce: string;
  readonly controller: AbortController;
}

const hostEffect = <A>(
  operation: HostOperation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, HostOperationFailure> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new HostOperationFailure({ operation, cause }),
  });

interface BoundedHostPromise<A> {
  readonly result: Promise<A>;
  readonly reconciliation: Promise<void>;
}

interface InFlightPreviewExposure {
  readonly reconciliation: Promise<void>;
  background: Promise<void> | undefined;
}

const boundedHostPromise = <A>(
  evaluate: () => Promise<A>,
  timeoutMillis: number,
  signal?: AbortSignal,
): BoundedHostPromise<A> => {
  let resolveReconciliation = (): void => undefined;
  const reconciliation = new Promise<void>((resolve) => {
    resolveReconciliation = resolve;
  });
  const result = new Promise<A>((resolve, reject) => {
    let waiting = true;
    const finishWaiting = (): void => {
      waiting = false;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const stopWaiting = (cause: unknown): void => {
      if (!waiting) return;
      finishWaiting();
      // oxlint-disable-next-line scotty/no-promise-reject -- boundary: native Sandbox timeout or abort must settle before Effect can reconcile the late host mutation
      reject(cause);
    };
    const abort = (): void => stopWaiting("interrupted");
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Sandbox preview mutations need a real host timeout and late reconciliation outside Effect interruption
    const timeout = setTimeout(() => stopWaiting("timeout"), timeoutMillis);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void Promise.resolve()
      .then(evaluate)
      .then(
        (value) => {
          if (waiting) {
            finishWaiting();
            resolve(value);
            resolveReconciliation();
            return;
          }
          resolveReconciliation();
        },
        (cause) => {
          if (waiting) {
            finishWaiting();
            // oxlint-disable-next-line scotty/no-promise-reject -- boundary: the native Sandbox rejection is forwarded once into the surrounding Effect.tryPromise adapter
            reject(cause);
          }
          resolveReconciliation();
        },
      );
  });
  return { result, reconciliation };
};

const boundedHostResult = <A>(evaluate: () => Promise<A>, timeoutMillis: number): Promise<A> =>
  boundedHostPromise(evaluate, timeoutMillis).result;

interface HatchWebSocketMessage {
  readonly data: string | ArrayBuffer;
  readonly bytes: number;
}

const normalizeHatchWebSocketMessage = async (
  value: unknown,
): Promise<HatchWebSocketMessage | undefined> => {
  if (typeof value === "string")
    return { data: value, bytes: new TextEncoder().encode(value).byteLength };
  if (value instanceof ArrayBuffer) return { data: value, bytes: value.byteLength };
  if (value instanceof Blob) {
    if (value.size > HATCH_MAX_WEBSOCKET_MESSAGE_BYTES) return undefined;
    const data = await value.arrayBuffer();
    return { data, bytes: data.byteLength };
  }
  return undefined;
};

const decodeEvidenceArtifactError = Schema.decodeUnknownOption(EvidenceArtifactError);
const decodeEvidenceStateError = Schema.decodeUnknownOption(EvidenceStateError);

const evidenceControlFailureCode = (error: unknown) => {
  const artifactError = decodeEvidenceArtifactError(error);
  if (Option.isSome(artifactError)) {
    if (artifactError.value.reason === "invalid_png") return "artifact_invalid" as const;
    if (artifactError.value.reason === "over_budget") return "artifact_over_budget" as const;
    return "artifact_put_unknown" as const;
  }
  const stateError = decodeEvidenceStateError(error);
  if (Option.isSome(stateError) && stateError.value.reason === "over_budget")
    return "artifact_over_budget" as const;
  return "interrupted" as const;
};

const reportEvidenceControlFailure = (operation: string, error: unknown): void => {
  const artifactError = decodeEvidenceArtifactError(error);
  console.error("Evidence control failed", {
    operation,
    error: errorName(error),
    ...(Option.isNone(artifactError)
      ? {}
      : {
          artifactOperation: artifactError.value.operation,
          artifactReason: artifactError.value.reason,
        }),
  });
};

const classifyCheckpointExit = <A, E>(exit: Exit.Exit<A, E>): CheckpointExitClassification => ({
  failed: Exit.isFailure(exit),
  hasDefect: Exit.hasDies(exit),
  hasTypedFailure: Exit.hasFails(exit),
  wasInterrupted: Exit.hasInterrupts(exit),
});

export const withCheckpointRuntimeRestore = <A, E, R, RestoreE, RestoreR>(
  checkpoint: Effect.Effect<A, E, R>,
  options: {
    readonly restore: Effect.Effect<void, RestoreE, RestoreR>;
    readonly resumeRuntime: boolean;
    readonly stopAttempted: () => boolean;
  },
): Effect.Effect<A, E | CheckpointRuntimeUnavailable, R | RestoreR> =>
  checkpoint.pipe(
    Effect.onExit((exit) =>
      options.stopAttempted() && (options.resumeRuntime || Exit.isFailure(exit))
        ? options.restore.pipe(
            Effect.mapError(
              (relaunchCause) =>
                new CheckpointRuntimeUnavailable({
                  checkpoint: classifyCheckpointExit(exit),
                  checkpointCause: Exit.isFailure(exit) ? exit.cause : undefined,
                  relaunchCause,
                }),
            ),
          )
        : Effect.void,
    ),
  );

interface PendingHatchRestore {
  readonly hatch: HatchRecordV1;
  readonly operationNonce: string;
  readonly runtimeEpoch: string;
}

interface PendingHatchWebSocket {
  readonly authorization: HatchWebSocketAuthorization;
  readonly expiresAtMillis: number;
}

interface TrackedHatchWebSocket {
  readonly authorization: HatchWebSocketAuthorization;
  readonly close: (code: number, reason: string) => void;
}

export class Sandbox extends BaseSandbox<Bindings> {
  override sleepAfter = "60m";
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [...ALLOWED_HOSTS];
  private readonly layer: Layer.Layer<SandboxServices>;
  private readonly clock: Clock.Clock | undefined;
  private readonly passivePiConsoleRelay: PassivePiConsoleRelay;
  private readonly previewRequestForwarder: (request: Request) => Promise<Response>;
  private readonly hatchRequestForwarder: (request: Request) => Promise<Response>;
  private readonly rawContainer: DurableObjectState["container"];
  private readonly sessionControlGate: SessionControlGate;
  private readonly authoritativeStorage: SessionRecordStorage;
  private readonly evidenceEnabled: boolean;
  private readonly evidencePreviewHostTimeoutMillis: number;
  private readonly previewBase: string | undefined;
  // This only coalesces work inside one live DO instance. Durable createPhase remains authoritative
  // after eviction or a crash.
  private createInFlight: InFlightCreate | undefined;
  private readonly previewExposureReconciliations = new Map<string, InFlightPreviewExposure>();
  private readonly previewRequests = new Map<string, InFlightPreviewRequest>();
  private readonly hatchRequests = new Map<string, AbortController>();
  private readonly hatchWebSocketAdmissions = new Map<string, PendingHatchWebSocket>();
  private readonly hatchWebSockets = new Map<string, TrackedHatchWebSocket>();

  constructor(ctx: DurableObjectState<{}>, env: Bindings, options: SandboxEffectOptions = {}) {
    super(ctx, env);
    this.clock = options.clock;
    this.rawContainer = ctx.container;
    this.evidenceEnabled = env.SCOTTY_EVIDENCE_ENABLED === "true";
    this.evidencePreviewHostTimeoutMillis =
      options.evidencePreviewHostTimeoutMillis ?? EVIDENCE_PREVIEW_HOST_TIMEOUT_MILLIS;
    this.previewBase =
      env.SCOTTY_PREVIEW_BASE !== undefined &&
      EVIDENCE_PREVIEW_BASE_PATTERN.test(env.SCOTTY_PREVIEW_BASE)
        ? env.SCOTTY_PREVIEW_BASE
        : undefined;
    this.passivePiConsoleRelay = options.passivePiConsoleRelay ?? {
      fetch: (input) => this.fetchNativePassivePiConsole(input),
    };
    this.previewRequestForwarder =
      options.previewRequestForwarder ?? ((request) => this.forwardSandboxPreviewRequest(request));
    this.hatchRequestForwarder =
      options.hatchRequestForwarder ?? ((request) => this.forwardSandboxPreviewRequest(request));
    this.sessionControlGate = makeSessionControlGate();

    const authoritativeStorage = durableObjectSessionRecordStorage(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning authoritative state adapters
      ctx.storage,
      this.sessionControlGate,
    );
    this.authoritativeStorage = authoritativeStorage;
    const store = sessionStoreLayer(authoritativeStorage);
    const evidence = evidenceStoreLayer(authoritativeStorage);
    const hatch = hatchStoreLayer(
      durableObjectHatchStateStorage(
        // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning Hatch authority adapter
        ctx.storage,
        this.sessionControlGate,
      ),
    );
    const artifacts = artifactStoreLayer(r2ArtifactStoreCapabilities(env.ARTIFACT_BUCKET));
    const runtimeAccess = this.assertRuntimeAccessProgram().pipe(
      Effect.asVoid,
      Effect.provide(store),
    );
    const runtime = sandboxRuntimeLayer(
      {
        exec: (command, execOptions) => this.exec(command, execOptions),
        mkdir: (path, mkdirOptions) => this.mkdir(path, mkdirOptions),
        readFileStream: (path) =>
          this.readFile(path, { encoding: "none" }).then((result) => result.content),
        writeFile: (path, content) => this.writeFile(path, content),
        setEnvVars: (envVars) => this.setEnvVars(envVars),
        startProcess: (command, processOptions) => this.startProcess(command, processOptions),
        getProcess: (processId) => this.getProcess(processId),
        fetchPort: (path, port, method, headers) =>
          this.containerFetch(
            new Request(`http://127.0.0.1:${port}${path}`, { method, headers }),
            port,
          ),
      },
      runtimeAccess,
      { fetchPortReadiness: env.SCOTTY_LOCAL_E2E === "1" },
    );
    const vault = credentialVaultLayer(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning CredentialVault adapter
      durableObjectCredentialVaultStorage(ctx.storage),
      env.GH_TOKEN,
    );
    const runtimeAndVault = Layer.merge(runtime, vault);
    const backup = backupStoreLayer(
      {
        createBackup: (backupOptions) => this.createBackup(backupOptions),
        restoreBackup: (directoryBackup) => this.restoreBackup(directoryBackup),
        listObjects: (prefix, cursor) =>
          env.BACKUP_BUCKET.list({ prefix, cursor }).then((page) => ({
            keys: page.objects.map((object) => object.key),
            cursor: page.truncated ? page.cursor : undefined,
          })),
        deleteObjects: (keys) => env.BACKUP_BUCKET.delete([...keys]),
      },
      runtimeAccess,
    );
    const evidenceRecorder =
      options.containerEvidenceRecorder === undefined
        ? containerEvidenceRecorderLayer.pipe(Layer.provide(runtime))
        : Layer.succeed(ContainerEvidenceRecorder)(options.containerEvidenceRecorder);

    this.layer = Layer.mergeAll(
      store,
      evidence,
      hatch,
      artifacts,
      sessionProjectionLayer(kvSessionProjectionStorage(env.SESSIONS)),
      backup,
      runtimeAndVault,
      rolloutDiscoveryLayer.pipe(Layer.provide(runtime)),
      workspaceLayer.pipe(Layer.provide(runtime)),
      containerAuthLayer.pipe(Layer.provide(runtime)),
      evidenceRecorder,
    );
  }

  private readonly requireRecordProgram = Effect.fnUntraced(function* () {
    const store = yield* SessionStore;
    return yield* store.requireRecord;
  });

  private readonly readRecordProgram = Effect.fnUntraced(function* () {
    const store = yield* SessionStore;
    return Option.getOrUndefined(yield* store.read);
  });

  private readonly deleteRuntimeEpochProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const deleteRuntimeEpoch = this.authoritativeStorage.deleteRuntimeEpoch;
    if (deleteRuntimeEpoch === undefined)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    yield* Effect.tryPromise({
      try: deleteRuntimeEpoch,
      catch: () => new EvidenceStateError({ reason: "storage" }),
    });
  });

  private readonly putRuntimeEpochProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    runtimeEpoch: string,
  ) {
    const putRuntimeEpoch = this.authoritativeStorage.putRuntimeEpoch;
    if (putRuntimeEpoch === undefined)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    yield* Effect.tryPromise({
      try: () => putRuntimeEpoch(runtimeEpoch),
      catch: () => new EvidenceStateError({ reason: "storage" }),
    });
  });

  private readonly currentRuntimeEpochProgram = Effect.fnUntraced(function* (this: Sandbox) {
    if (this.rawContainer?.running !== true)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const getRuntimeEpoch = this.authoritativeStorage.getRuntimeEpoch;
    if (getRuntimeEpoch === undefined)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const stored = yield* Effect.tryPromise({
      try: getRuntimeEpoch,
      catch: () => new EvidenceStateError({ reason: "storage" }),
    });
    const decoded = decodeEvidenceIdentifier(stored);
    if (Option.isNone(decoded))
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    return decoded.value;
  });

  private readonly healthCheckAndExposeHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    hatch: HatchRecordV1,
    operationNonce: string,
    runtimeEpoch: string,
  ) {
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch routing is unavailable",
      });
    const runtime = yield* SandboxRuntime;
    const healthStatus = yield* runtime.fetchPortStatus(
      hatch.service.healthPath,
      hatch.service.port,
      "GET",
    );
    if (healthStatus < 200 || healthStatus > 399)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch service health check failed",
      });
    const exposed = yield* hostEffect("expose", () =>
      this.exposePort(hatch.service.port, {
        hostname: previewBase,
        token: hatch.routeNonce,
        name: `hatch-${hatch.hatchId}`,
      }),
    );
    const expectedOrigin = hatchOrigin(
      { sessionId: hatch.sessionId, port: hatch.service.port, routeNonce: hatch.routeNonce },
      previewBase,
    );
    const exposedOrigin = yield* Effect.try({
      try: () => new URL(exposed.url).origin,
      catch: () =>
        new HatchStateError({ reason: "invalid_state", message: "Hatch exposure is invalid" }),
    });
    if (exposedOrigin !== expectedOrigin)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch exposure host did not match authority",
      });
    const store = yield* HatchStore;
    return yield* store.publishRunning(
      operationNonce,
      hatch.hatchId,
      hatch.generation,
      runtimeEpoch,
    );
  });

  private readonly prepareHatchRestoreProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    operationNonce: string,
  ) {
    const store = yield* HatchStore;
    const state = yield* store.read;
    if (state.primary === undefined || state.primary.desiredStatus !== "open") return undefined;
    const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
    const hatch = yield* store.beginRestore({ operationNonce, runtimeEpoch });
    return hatch === undefined ? undefined : { hatch, operationNonce, runtimeEpoch };
  });

  private readonly completeHatchRestoreProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    pending: PendingHatchRestore,
  ) {
    const restored = yield* Effect.result(
      this.healthCheckAndExposeHatchProgram(
        pending.hatch,
        pending.operationNonce,
        pending.runtimeEpoch,
      ),
    );
    if (Result.isSuccess(restored)) return;
    yield* this.cleanupHatchProgram(
      pending.operationNonce,
      "failed",
      false,
      "restore_operation",
    ).pipe(Effect.ignore);
    return yield* restored.failure;
  });

  private readonly restorePiAndHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    operationNonce: string,
    restorePi: Effect.Effect<void, SandboxRuntimeFailure>,
  ) {
    const pending = yield* this.prepareHatchRestoreProgram(operationNonce);
    const restored = yield* Effect.result(
      restorePi.pipe(
        Effect.andThen(
          pending === undefined ? Effect.void : this.completeHatchRestoreProgram(pending),
        ),
      ),
    );
    if (Result.isSuccess(restored)) return;
    if (pending !== undefined)
      yield* this.cleanupHatchProgram(operationNonce, "failed", false, "restore_operation").pipe(
        Effect.ignore,
      );
    return yield* Effect.fail(restored.failure);
  });

  private readonly ensureScottyHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const decoded = decodeEnsureHatchInput(value);
    if (Option.isNone(decoded)) return yield* badRequest("Hatch configuration is invalid");
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* wrongState("warm", "hatch", "Hatch routing is not configured");
    const initial = yield* this.requireRecordProgram();
    if (
      initial.status !== "warm" ||
      initial.execution.provider !== "cloudflare" ||
      this.rawContainer?.running !== true
    )
      return yield* wrongState(initial.status, "hatch", "Hatch requires a warm Cloudflare runtime");
    const expectedRoot = `${sessionRoot(initial.id)}/`;
    if (
      decoded.value.service.workingDirectory !== sessionRoot(initial.id) &&
      !decoded.value.service.workingDirectory.startsWith(expectedRoot)
    )
      return yield* badRequest("Hatch working directory must belong to this session");
    const evidenceState = yield* Effect.flatMap(EvidenceStore, (store) => store.read);
    if (
      evidenceState.activeJob?.port === decoded.value.service.port &&
      (evidenceState.activeJob.exposure === "active" ||
        evidenceState.activeJob.exposure === "unexpose_pending")
    )
      return yield* conflict("Hatch cannot expose the active evidence service port");
    const operation = yield* this.acquireOperationProgram("hatch", ["warm"]);
    let cleanupRequired = false;
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
        const hatch = yield* HatchStore;
        const beginning = yield* hatch.beginEnsure({
          sessionId: initial.id,
          operationNonce: operation.nonce,
          hatchId: `hatch-${randomToken(8)}`,
          routeNonce: `h${randomToken(7)}`,
          runtimeEpoch,
          service: decoded.value.service,
        });
        if (!beginning.needsExposure)
          return publicHatchStatusProjection({ version: 1, primary: beginning.hatch });
        cleanupRequired = true;
        const running = yield* this.healthCheckAndExposeHatchProgram(
          beginning.hatch,
          operation.nonce,
          runtimeEpoch,
        );
        return publicHatchStatusProjection({ version: 1, primary: running });
      }),
    );
    if (Result.isFailure(result) && cleanupRequired) {
      const cleanup = yield* Effect.result(
        this.cleanupHatchProgram(operation.nonce, "failed", false, "operation"),
      );
      if (Result.isFailure(cleanup))
        yield* hostEffect("schedule", () =>
          this.schedule(5, "retryHatchCleanup", {
            operationNonce: operation.nonce,
            target: "failed",
            closeDesired: false,
          } satisfies HatchCleanupRetryV1),
        );
    }
    yield* this.releaseOperationIfHeldProgram(operation.nonce);
    if (Result.isFailure(result)) return yield* this.hatchControlError(result.failure);
    return result.success;
  });

  private readonly hatchControlError = (failure: unknown): ScottyError => {
    if (isHatchStateError(failure)) {
      const { reason } = failure;
      if (reason === "conflict" || reason === "lease_changed")
        return conflict("Hatch state changed during the operation");
      if (reason === "invalid_state" || reason === "runtime_changed")
        return wrongState("warm", "hatch", "Hatch is unavailable for the current runtime");
    }
    return this.upstreamError("Hatch operation failed", failure);
  };

  private closeTrackedHatchWebSockets(code: number, reason: string): void {
    this.hatchWebSocketAdmissions.clear();
    for (const socket of this.hatchWebSockets.values()) socket.close(code, reason);
    this.hatchWebSockets.clear();
  }

  private readonly cleanupHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    operationNonce: string,
    target: HatchCleanupTarget,
    closeDesired: boolean,
    authority: HatchCleanupAuthority,
  ) {
    const hatch = yield* HatchStore;
    const currentResult = yield* Effect.result(hatch.read);
    if (Result.isFailure(currentResult)) {
      if (target === "gone" && authority === "operation") {
        yield* hatch.clearUnreadableAfterVaporize(operationNonce);
        return true;
      }
      return yield* currentResult.failure;
    }
    const current = currentResult.success;
    if (current.primary === undefined) return false;
    const pending = yield* hatch.beginCleanup(operationNonce, target, closeDesired, authority);
    if (pending === undefined) return false;
    yield* Effect.sync(() => {
      this.closeTrackedHatchWebSockets(1001, "Hatch authority revoked");
      for (const controller of this.hatchRequests.values()) controller.abort();
      this.hatchRequests.clear();
    });
    if (pending.exposure === "unexpose_pending" && this.rawContainer?.running === true)
      yield* hostEffect("unexpose", () => this.unexposePort(pending.service.port));
    yield* hatch.completeCleanup(operationNonce, target);
    return true;
  });

  private readonly closeScottyHatchProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm") return yield* wrongState(record.status, "hatch");
    const operation = yield* this.acquireOperationProgram("hatch", ["warm"]);
    const closed = yield* Effect.result(
      this.cleanupHatchProgram(operation.nonce, "stopped", true, "operation"),
    );
    const scheduled = Result.isFailure(closed)
      ? yield* Effect.result(
          hostEffect("schedule", () =>
            this.schedule(5, "retryHatchCleanup", {
              operationNonce: operation.nonce,
              target: "stopped",
              closeDesired: true,
            } satisfies HatchCleanupRetryV1),
          ),
        )
      : Result.succeed(undefined);
    yield* this.releaseOperationIfHeldProgram(operation.nonce);
    if (Result.isFailure(scheduled))
      return yield* this.upstreamError("Hatch cleanup retry scheduling failed", scheduled.failure);
    if (Result.isFailure(closed)) return yield* this.hatchControlError(closed.failure);
    return yield* Effect.flatMap(HatchStore, (store) => store.publicStatus);
  });

  private readonly retryHatchCleanupProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: HatchCleanupRetryV1,
  ) {
    const state = yield* Effect.flatMap(HatchStore, (store) => store.read);
    if (
      state.primary?.cleanup?.operationNonce !== payload.operationNonce ||
      state.primary.cleanup.target !== payload.target
    )
      return;
    const cleaned = yield* Effect.result(
      this.cleanupHatchProgram(
        payload.operationNonce,
        payload.target,
        payload.closeDesired,
        "scheduled",
      ),
    );
    if (Result.isFailure(cleaned))
      yield* hostEffect("schedule", () => this.schedule(5, "retryHatchCleanup", payload));
  });

  private readonly acceptDecodedScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    job: BrowserEvidenceJobV2,
  ) {
    if (!this.evidenceEnabled)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm" || record.execution.provider !== "cloudflare")
      return yield* wrongState(
        record.status,
        "evidence",
        "Evidence requires a warm Cloudflare session",
      );
    if (this.rawContainer?.running !== true)
      return yield* wrongState(record.status, "evidence", "The Sandbox runtime is not running");
    const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
    const now = yield* Clock.currentTimeMillis;
    const deadlineMillis = Math.min(
      now + EVIDENCE_JOB_TIMEOUT_MILLIS,
      Date.parse(record.hardCapAt),
    );
    if (!Number.isFinite(deadlineMillis) || deadlineMillis <= now)
      return yield* wrongState(record.status, "evidence", "The session hard cap has elapsed");
    const deadlineAt = new Date(deadlineMillis).toISOString();
    const hatchState = yield* Effect.flatMap(HatchStore, (store) => store.read);
    if (
      hatchState.primary?.service.port === job.port &&
      (hatchState.primary.exposure === "active" ||
        hatchState.primary.exposure === "unexpose_pending")
    )
      return yield* conflict("Evidence cannot expose the active Hatch service port");
    const operationNonce = randomToken(12);
    const flowHash = yield* Effect.tryPromise({
      try: () => sha256Hex(JSON.stringify({ viewport: job.viewport, steps: job.steps })),
      catch: () => new EvidenceStateError({ reason: "storage" }),
    });
    const evidence = yield* EvidenceStore;
    const capacityDeletes = yield* evidence.prepareJobCapacity;
    if (capacityDeletes.length > 0) {
      yield* this.armEvidenceRetentionFailClosedProgram();
      yield* this.deleteEvidenceArtifactsProgram(capacityDeletes);
      yield* this.armEvidenceRetentionFailClosedProgram();
    }
    const accepted = yield* evidence.accept({
      jobId: `job-${randomToken(8)}`,
      operationNonce,
      runtimeEpoch,
      routeNonce: randomToken(8),
      deadlineAt,
      flowHash,
      job,
    });
    const scheduled = yield* Effect.result(
      hostEffect("schedule", () =>
        this.schedule(new Date(deadlineAt), "expireEvidenceJob", {
          nonce: operationNonce,
          deadlineAt,
        } satisfies EvidenceDeadlinePayload),
      ),
    );
    if (Result.isSuccess(scheduled)) return accepted;
    yield* evidence.interrupt(operationNonce, "interrupted");
    return yield* this.upstreamError("Evidence deadline scheduling failed", scheduled.failure);
  });

  private readonly acceptScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const job = yield* decodeBrowserEvidenceJobEffect(value).pipe(
      Effect.mapError(() => badRequest("Evidence job is invalid")),
    );
    return yield* this.acceptDecodedScottyEvidenceJobProgram(job);
  });

  private abortPreviewRequests(operationNonce: string): void {
    for (const [requestId, request] of this.previewRequests) {
      if (request.operationNonce !== operationNonce) continue;
      request.controller.abort();
      this.previewRequests.delete(requestId);
    }
  }

  private readonly reconcileLateEvidenceExposureProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    port: number,
    deadlineAt: string,
  ) {
    const evidence = yield* EvidenceStore;
    const reconciled = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* hostEffect("unexpose", () =>
          boundedHostResult(() => this.unexposePort(port), this.evidencePreviewHostTimeoutMillis),
        );
        yield* evidence.closePreview(nonce);
      }),
    );
    if (Result.isSuccess(reconciled)) return;
    const scheduled = yield* Effect.result(
      hostEffect("schedule", () =>
        this.schedule(EVIDENCE_CLEANUP_RETRY_SECONDS, "expireEvidenceJob", {
          nonce,
          deadlineAt,
        } satisfies EvidenceDeadlinePayload),
      ),
    );
    yield* Effect.sync(() =>
      console.error("Late evidence exposure cleanup remains authoritative and pending", {
        error: errorName(reconciled.failure),
        retryScheduled: Result.isSuccess(scheduled),
      }),
    );
  });

  private startLateEvidenceExposureReconciliation(
    nonce: string,
    exposure: InFlightPreviewExposure,
    port: number,
    deadlineAt: string,
  ): void {
    if (exposure.background !== undefined) return;
    const background = exposure.reconciliation.then(() =>
      this.#run(this.reconcileLateEvidenceExposureProgram(nonce, port, deadlineAt)),
    );
    exposure.background = background;
    this.ctx.waitUntil(background);
    const forget = (): void => {
      if (this.previewExposureReconciliations.get(nonce) === exposure)
        this.previewExposureReconciliations.delete(nonce);
    };
    void background.then(forget, forget);
  }

  private readonly cleanupEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    interruptionReason?: "deadline" | "interrupted",
  ) {
    const evidence = yield* EvidenceStore;
    const revoked = yield* evidence.revokePreview(nonce, interruptionReason);
    yield* Effect.sync(() => this.abortPreviewRequests(nonce));
    const exposure = this.previewExposureReconciliations.get(nonce);
    if (exposure !== undefined) {
      yield* Effect.sync(() =>
        this.startLateEvidenceExposureReconciliation(
          nonce,
          exposure,
          revoked.port,
          revoked.deadlineAt,
        ),
      );
      return yield* new HostOperationFailure({
        operation: "expose",
        cause: "reconciliation_pending",
      });
    }
    if (revoked.exposure === "unexpose_pending") {
      yield* hostEffect("unexpose", () =>
        boundedHostResult(
          () => this.unexposePort(revoked.port),
          this.evidencePreviewHostTimeoutMillis,
        ),
      );
      return yield* evidence.closePreview(nonce);
    }
    return revoked;
  });

  private readonly exposeScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
  ) {
    if (Option.isNone(decodeEvidenceIdentifier(nonce)))
      return yield* badRequest("Evidence operation nonce is invalid");
    if (!this.evidenceEnabled)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const active = state.activeJob;
    if (active?.operationNonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    if (this.rawContainer?.running !== true)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
    if (runtimeEpoch !== active.runtimeEpoch)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const record = yield* this.requireRecordProgram();
    const canonicalOrigin = `https://${active.port}-${record.id}-${active.routeNonce}.${previewBase}`;
    yield* evidence.beginPreviewExposure(nonce, {
      runtimeEpoch,
      runtimeRunning: this.rawContainer?.running === true,
    });
    const cookieSecret = randomToken(32);
    const cookieDigest = yield* Effect.tryPromise({
      try: () => sha256Hex(cookieSecret),
      catch: () => new EvidenceStateError({ reason: "preview_unavailable" }),
    });
    const nowMillis = yield* Clock.currentTimeMillis;
    const remainingMillis = Date.parse(active.deadlineAt) - nowMillis;
    const exposureTimeoutMillis = Math.max(
      0,
      Math.min(this.evidencePreviewHostTimeoutMillis, remainingMillis),
    );
    let pendingExposure: InFlightPreviewExposure | undefined;
    const exposed = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) => {
          const bounded = boundedHostPromise(
            () =>
              this.exposePort(active.port, {
                hostname: previewBase,
                token: active.routeNonce,
                name: `evidence-${active.jobId}`,
              }),
            exposureTimeoutMillis,
            signal,
          );
          pendingExposure = { reconciliation: bounded.reconciliation, background: undefined };
          this.previewExposureReconciliations.set(nonce, pendingExposure);
          return bounded.result;
        },
        catch: (cause) => new HostOperationFailure({ operation: "expose", cause }),
      }),
    );
    if (Result.isFailure(exposed)) {
      yield* Effect.result(this.cleanupEvidencePreviewProgram(nonce, "interrupted"));
      return yield* Effect.fail(exposed.failure);
    }
    if (
      pendingExposure !== undefined &&
      this.previewExposureReconciliations.get(nonce) === pendingExposure
    )
      this.previewExposureReconciliations.delete(nonce);
    const exposedOrigin = yield* Effect.result(
      Effect.try({
        try: () => new URL(exposed.success.url).origin,
        catch: () => new EvidenceStateError({ reason: "preview_unavailable" }),
      }),
    );
    const published =
      Result.isSuccess(exposedOrigin) && exposedOrigin.success === canonicalOrigin
        ? yield* Effect.result(
            evidence.publishPreviewExposure(nonce, {
              runtimeEpoch,
              cookieDigest,
              runtimeRunning: this.rawContainer?.running === true,
            }),
          )
        : Result.fail(new EvidenceStateError({ reason: "preview_unavailable" }));
    if (Result.isFailure(published)) {
      yield* Effect.result(this.cleanupEvidencePreviewProgram(nonce, "interrupted"));
      return yield* published.failure;
    }
    return {
      origin: canonicalOrigin,
      cookieSecret,
      expiresAt: published.success.deadlineAt,
    } satisfies ExposedEvidencePreviewV2;
  });

  private readonly admitScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const decoded = decodeEvidencePreviewAdmission(value);
    if (!this.evidenceEnabled || Option.isNone(decoded) || this.rawContainer?.running !== true)
      return undefined;
    const runtimeEpoch = yield* Effect.result(this.currentRuntimeEpochProgram());
    if (Result.isFailure(runtimeEpoch)) return undefined;
    const cookieDigest = yield* Effect.result(
      Effect.tryPromise({
        try: () => sha256Hex(decoded.value.cookieSecret),
        catch: () => new EvidenceStateError({ reason: "preview_unavailable" }),
      }),
    );
    if (Result.isFailure(cookieDigest)) return undefined;
    return yield* Effect.flatMap(EvidenceStore, (store) =>
      store.admitPreview({
        requestId: randomToken(16),
        sessionId: decoded.value.sessionId,
        port: decoded.value.port,
        routeNonce: decoded.value.routeNonce,
        runtimeEpoch: runtimeEpoch.success,
        cookieDigest: cookieDigest.success,
        ingressBytes: decoded.value.ingressBytes,
        runtimeRunning: this.rawContainer?.running === true,
      }),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
  });

  private readonly adjustScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
    ingressBytes: number,
  ) {
    const evidence = yield* EvidenceStore;
    return yield* evidence.adjustPreview(requestId, ingressBytes);
  });

  private readonly claimScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    requestId: string,
    route: { readonly sessionId: string; readonly port: number; readonly routeNonce: string },
  ) {
    const runtimeEpoch = yield* Effect.result(this.currentRuntimeEpochProgram());
    if (Result.isFailure(runtimeEpoch)) return undefined;
    return yield* Effect.flatMap(EvidenceStore, (store) =>
      store.claimPreview({
        requestId,
        ...route,
        runtimeEpoch: runtimeEpoch.success,
        runtimeRunning: this.rawContainer?.running === true,
      }),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
  });

  private readonly settleScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
    responseBytes: number,
  ) {
    const evidence = yield* EvidenceStore;
    yield* evidence.settlePreview(requestId, responseBytes);
  });

  private readonly cancelScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
  ) {
    const evidence = yield* EvidenceStore;
    yield* evidence.cancelPreview(requestId);
  });

  private readonly expireScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
  ) {
    const evidence = yield* EvidenceStore;
    yield* evidence.expirePreview(requestId);
  });

  private readonly expireEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: EvidenceDeadlinePayload,
  ) {
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    if (
      state.activeJob?.operationNonce !== payload.nonce ||
      state.activeJob.deadlineAt !== payload.deadlineAt
    )
      return;
    const cleaned = yield* Effect.result(
      this.cleanupEvidencePreviewProgram(payload.nonce, "deadline"),
    );
    if (Result.isFailure(cleaned)) {
      yield* hostEffect("schedule", () =>
        this.schedule(EVIDENCE_CLEANUP_RETRY_SECONDS, "expireEvidenceJob", payload),
      );
      return;
    }
    yield* evidence.interrupt(payload.nonce, "deadline");
  });

  private readonly deleteEvidenceArtifactsProgram = Effect.fnUntraced(function* (
    artifacts: ReadonlyArray<EvidenceArtifactV2>,
  ) {
    const evidence = yield* EvidenceStore;
    const artifactStore = yield* ArtifactStore;
    for (const artifact of artifacts) {
      yield* artifactStore.deleteArtifact(artifact);
      yield* evidence.confirmDelete(artifact.objectKey);
    }
  });

  private readonly reconcileEvidenceDeletesProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    yield* this.deleteEvidenceArtifactsProgram(
      state.artifacts.filter((artifact) => artifact.status === "delete_pending"),
    );
  });

  private readonly scheduleEvidenceRetentionAtProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    expiresAt: string,
  ) {
    const scheduled = yield* Effect.result(
      hostEffect("schedule", () =>
        this.schedule(new Date(expiresAt), "expireRetainedEvidence", {
          expiresAt,
        } satisfies EvidenceRetentionPayload),
      ),
    );
    if (Result.isSuccess(scheduled)) return;
    const inserted = yield* this.hasScheduledEvidenceRetentionAtProgram(expiresAt);
    if (!inserted) return yield* scheduled.failure;
  });

  private readonly nextEvidenceRetentionAtProgram = Effect.fnUntraced(function* (
    promoting?: EvidenceArtifactV2,
  ) {
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const nowMillis = yield* Clock.currentTimeMillis;
    const needsRetry = state.artifacts.some(
      (artifact) =>
        artifact.objectKey !== promoting?.objectKey &&
        (artifact.status === "delete_pending" || Date.parse(artifact.expiresAt) <= nowMillis),
    );
    const activeDeadlineMillis = Date.parse(state.activeJob?.deadlineAt ?? "");
    const nextAtMillis = needsRetry
      ? Number.isFinite(activeDeadlineMillis) && activeDeadlineMillis > nowMillis
        ? activeDeadlineMillis
        : nowMillis + EVIDENCE_CLEANUP_RETRY_SECONDS * 1_000
      : Math.min(
          ...state.artifacts
            .filter((artifact) => artifact.status === "available")
            .map((artifact) => Date.parse(artifact.expiresAt)),
          ...(promoting === undefined ? [] : [Date.parse(promoting.expiresAt)]),
        );
    return Number.isFinite(nextAtMillis) ? new Date(nextAtMillis).toISOString() : undefined;
  });

  private readonly armEvidenceRetentionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    promoting?: EvidenceArtifactV2,
  ) {
    const expiresAt = yield* this.nextEvidenceRetentionAtProgram(promoting);
    if (expiresAt === undefined || (yield* this.hasScheduledEvidenceRetentionProgram())) return;
    yield* this.scheduleEvidenceRetentionAtProgram(expiresAt);
  });

  private readonly armFutureEvidenceRetentionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const expiresAt = yield* this.nextEvidenceRetentionAtProgram();
    if (expiresAt === undefined) return;
    const nowMillis = yield* Clock.currentTimeMillis;
    if (yield* this.hasScheduledEvidenceRetentionProgram(nowMillis)) return;
    yield* this.scheduleEvidenceRetentionAtProgram(expiresAt);
  });

  private readonly hasScheduledEvidenceRetentionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    afterMillis?: number,
  ) {
    const schedules = yield* Effect.tryPromise({
      try: () => this.listSchedules<EvidenceRetentionPayload>("expireRetainedEvidence"),
      catch: (cause) => new HostOperationFailure({ operation: "schedule", cause }),
    });
    return schedules.some(
      (schedule) => afterMillis === undefined || schedule.time * 1_000 > afterMillis,
    );
  });

  private readonly hasScheduledEvidenceRetentionAtProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    expiresAt: string,
  ) {
    const schedules = yield* Effect.tryPromise({
      try: () => this.listSchedules<EvidenceRetentionPayload>("expireRetainedEvidence"),
      catch: (cause) => new HostOperationFailure({ operation: "schedule", cause }),
    });
    const expectedTime = Math.floor(Date.parse(expiresAt) / 1_000);
    return schedules.some((schedule) => schedule.time === expectedTime);
  });

  private readonly armEvidenceRetentionFailClosedProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const firstAttempt = yield* Effect.result(this.armEvidenceRetentionProgram());
      if (Result.isSuccess(firstAttempt)) return;
      yield* Effect.sync(() => reportEvidenceControlFailure("retention", firstAttempt.failure));
      yield* Effect.sleep("1 second");
      yield* this.armEvidenceRetentionProgram().pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second") }),
      );
    },
  );

  private readonly armFutureEvidenceRetentionFailClosedProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const firstAttempt = yield* Effect.result(this.armFutureEvidenceRetentionProgram());
      if (Result.isSuccess(firstAttempt)) return;
      yield* Effect.sync(() =>
        reportEvidenceControlFailure("future_retention", firstAttempt.failure),
      );
      yield* Effect.sleep("1 second");
      yield* this.armFutureEvidenceRetentionProgram().pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second") }),
      );
    },
  );

  private readonly expireRetainedEvidenceProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: unknown,
  ) {
    const decoded = decodeEvidenceRetentionPayload(payload);
    if (Option.isNone(decoded) || !Number.isFinite(Date.parse(decoded.value.expiresAt))) return;
    const evidence = yield* EvidenceStore;
    // The pinned Container host deletes the executing row after this callback returns. Insert its
    // sole future successor first; interruption before insertion leaves the current alarm retryable.
    yield* this.armFutureEvidenceRetentionFailClosedProgram();
    const reconciled = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* evidence.prepareExpiredDeletes;
        yield* this.reconcileEvidenceDeletesProgram();
      }),
    );
    if (Result.isFailure(reconciled))
      yield* Effect.sync(() =>
        console.error("Evidence retention reconciliation remains authoritative and pending", {
          error: errorName(reconciled.failure),
        }),
      );
  });

  private readonly completeScottyEvidenceStepProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    value: unknown,
  ) {
    if (Option.isNone(decodeEvidenceIdentifier(nonce)))
      return yield* badRequest("Evidence operation nonce is invalid");
    const input = yield* decodeCompleteEvidenceStepPublication(value).pipe(
      Effect.mapError(() => badRequest("Evidence step publication is invalid")),
    );
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const active = state.activeJob;
    if (active?.operationNonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const record = yield* this.requireRecordProgram();
    if (record.operation?.kind !== "evidence" || record.operation.nonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const frame = input.frame;
    const failedAssertion = input.assertions.some((assertion) => !assertion.passed);
    const artifactStore = yield* ArtifactStore;
    const frameInput =
      frame === undefined
        ? undefined
        : {
            sessionId: record.id,
            jobId: active.jobId,
            frameId: frame.frameId,
            bytes: frame.bytes,
            capturedAt: frame.capturedAt,
            offsetMillis: frame.offsetMillis,
          };
    const preparedResult =
      frameInput === undefined
        ? Result.succeed(undefined)
        : yield* Effect.result(artifactStore.prepareFrame(frameInput));
    if (Result.isFailure(preparedResult) && !failedAssertion) return yield* preparedResult.failure;
    const prepared = Result.isSuccess(preparedResult) ? preparedResult.success : undefined;
    let artifact: EvidenceArtifactV2 | undefined;
    let artifactFailure: EvidenceArtifactError | undefined = Result.isFailure(preparedResult)
      ? preparedResult.failure
      : undefined;
    if (prepared !== undefined) {
      yield* evidence.prepareArtifactUpload(nonce, input.index, prepared.artifact);
      const pendingRetention = yield* Effect.result(
        this.armEvidenceRetentionProgram().pipe(
          Effect.mapError(
            (cause) =>
              new EvidenceArtifactError({ operation: "put", reason: "put_unknown", cause }),
          ),
        ),
      );
      if (Result.isFailure(pendingRetention)) {
        artifactFailure = pendingRetention.failure;
      } else {
        const written = yield* Effect.result(artifactStore.writeFrame(prepared));
        if (Result.isFailure(written)) {
          artifactFailure = written.failure;
        } else {
          const availableRetention = yield* Effect.result(
            this.armEvidenceRetentionProgram(written.success).pipe(
              Effect.mapError(
                (cause) =>
                  new EvidenceArtifactError({ operation: "put", reason: "put_unknown", cause }),
              ),
            ),
          );
          if (Result.isFailure(availableRetention)) artifactFailure = availableRetention.failure;
          else artifact = written.success;
        }
      }
    }
    if (artifactFailure !== undefined && prepared !== undefined) {
      const pending = yield* evidence.requestVerifiedDelete(prepared.artifact, "abandoned");
      if (pending !== undefined) {
        const deleted = yield* Effect.result(this.deleteEvidenceArtifactsProgram([pending]));
        if (Result.isFailure(deleted))
          yield* Effect.sync(() =>
            console.error("Unpublished evidence frame deletion remains authoritative and pending", {
              jobId: active.jobId,
              frameId: pending.frameId,
              error: errorName(deleted.failure),
            }),
          );
      }
      yield* this.armEvidenceRetentionFailClosedProgram();
    }
    if (artifactFailure !== undefined && !failedAssertion) return yield* artifactFailure;
    const publication = {
      index: input.index,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      offsetMillis: input.offsetMillis,
      assertions: input.assertions,
    };
    const completed = yield* Effect.result(
      evidence.completeStep(nonce, {
        ...publication,
        ...(artifact === undefined ? {} : { artifact }),
      }),
    );
    if (Result.isSuccess(completed)) return completed.success;
    if (artifact !== undefined) {
      const pending = yield* evidence.requestVerifiedDelete(artifact, "abandoned");
      if (pending !== undefined) {
        const deleted = yield* Effect.result(this.deleteEvidenceArtifactsProgram([pending]));
        if (Result.isFailure(deleted))
          yield* Effect.sync(() =>
            console.error("Failed evidence frame deletion remains authoritative and pending", {
              jobId: active.jobId,
              frameId: artifact.frameId,
              error: errorName(deleted.failure),
            }),
          );
      }
      yield* this.armEvidenceRetentionFailClosedProgram();
      if (failedAssertion) return yield* evidence.completeStep(nonce, publication);
    }
    return yield* completed.failure;
  });

  private readonly completeScottyEvidenceVideoProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    value: unknown,
  ) {
    if (Option.isNone(decodeEvidenceIdentifier(nonce)))
      return yield* badRequest("Evidence operation nonce is invalid");
    const input = yield* decodeCompleteEvidenceVideoPublication(value).pipe(
      Effect.mapError(() => badRequest("Evidence video publication is invalid")),
    );
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const active = state.activeJob;
    if (active?.operationNonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const record = yield* this.requireRecordProgram();
    if (record.operation?.kind !== "evidence" || record.operation.nonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const artifactStore = yield* ArtifactStore;
    const prepared = yield* artifactStore.prepareVideo({
      sessionId: record.id,
      jobId: active.jobId,
      artifactId: input.artifactId,
      bytes: input.bytes,
      capturedAt: input.capturedAt,
      offsetMillis: input.offsetMillis,
    });
    yield* evidence.prepareVideoUpload(nonce, prepared.artifact);
    const published = yield* Effect.result(
      this.armEvidenceRetentionProgram().pipe(
        Effect.andThen(artifactStore.writeArtifact(prepared)),
        Effect.tap((artifact) => this.armEvidenceRetentionProgram(artifact)),
        Effect.flatMap((artifact) => evidence.completeVideo(nonce, { artifact })),
      ),
    );
    if (Result.isSuccess(published)) return published.success;
    const pending = yield* evidence.requestVerifiedDelete(prepared.artifact, "abandoned");
    if (pending !== undefined) {
      const deleted = yield* Effect.result(this.deleteEvidenceArtifactsProgram([pending]));
      if (Result.isFailure(deleted))
        yield* Effect.sync(() =>
          console.error("Unpublished evidence video deletion remains authoritative and pending", {
            jobId: active.jobId,
            error: errorName(deleted.failure),
          }),
        );
    }
    yield* this.armEvidenceRetentionFailClosedProgram();
    return yield* published.failure;
  });

  private readonly finalizeScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    status: EvidenceTerminalStatus,
  ) {
    const evidence = yield* EvidenceStore;
    yield* this.cleanupEvidencePreviewProgram(nonce);
    const summary = yield* evidence.finalize(nonce, status);
    const reconciled = yield* Effect.result(this.reconcileEvidenceDeletesProgram());
    if (Result.isFailure(reconciled))
      yield* Effect.sync(() =>
        console.error("Evidence artifact reconciliation remains pending", {
          jobId: summary.jobId,
          error: errorName(reconciled.failure),
        }),
      );
    yield* this.armEvidenceRetentionFailClosedProgram();
    return summary;
  });

  private evidenceWorkflowControl(): EvidenceWorkflowControl["Service"] {
    return EvidenceWorkflowControl.of({
      expose: (active) =>
        this.exposeScottyEvidencePreviewProgram(active.operationNonce).pipe(
          Effect.mapError(
            (error) =>
              new EvidenceWorkflowControlError({
                operation: "expose",
                failureCode: Predicate.isTagged(error, "HostOperationFailure")
                  ? "interrupted"
                  : "unsupported",
              }),
          ),
          Effect.provide(this.layer),
        ),
      markRunning: (active) =>
        Effect.flatMap(EvidenceStore, (store) =>
          store.setPhase(active.operationNonce, "running"),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new EvidenceWorkflowControlError({
                operation: "mark_running",
                failureCode: "interrupted",
              }),
          ),
          Effect.provide(this.layer),
        ),
      completeStep: (active, input) =>
        this.completeScottyEvidenceStepProgram(active.operationNonce, input).pipe(
          Effect.asVoid,
          Effect.tapError((error) =>
            Effect.sync(() => reportEvidenceControlFailure("complete_step", error)),
          ),
          Effect.mapError(
            (error) =>
              new EvidenceWorkflowControlError({
                operation: "complete_step",
                failureCode: evidenceControlFailureCode(error),
              }),
          ),
          Effect.provide(this.layer),
        ),
      completeVideo: (active, input) =>
        this.completeScottyEvidenceVideoProgram(active.operationNonce, input).pipe(
          Effect.asVoid,
          Effect.tapError((error) =>
            Effect.sync(() => reportEvidenceControlFailure("complete_video", error)),
          ),
          Effect.mapError(
            (error) =>
              new EvidenceWorkflowControlError({
                operation: "complete_video",
                failureCode: evidenceControlFailureCode(error),
              }),
          ),
          Effect.provide(this.layer),
        ),
      recordFailure: (active, failure, diagnostic) =>
        Effect.flatMap(EvidenceStore, (store) =>
          store.recordFailure(active.operationNonce, failure, diagnostic),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new EvidenceWorkflowControlError({
                operation: "record_failure",
                failureCode: failure.code,
              }),
          ),
          Effect.provide(this.layer),
        ),
      finalize: (active, status) =>
        this.finalizeScottyEvidenceJobProgram(active.operationNonce, status).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => reportEvidenceControlFailure("finalize", error)),
          ),
          Effect.mapError(
            () =>
              new EvidenceWorkflowControlError({
                operation: "finalize",
                failureCode: "interrupted",
              }),
          ),
          Effect.provide(this.layer),
        ),
    });
  }

  private readonly runScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const job = yield* decodeBrowserEvidenceJobEffect(value).pipe(
      Effect.mapError(() => badRequest("Evidence job is invalid")),
    );
    const active = yield* this.acceptDecodedScottyEvidenceJobProgram(job);
    const record = yield* this.requireRecordProgram();
    return yield* runEvidenceWorkflow({
      active,
      job,
      summaryUrl: `/s/${record.id}/evidence/${active.jobId}`,
    }).pipe(Effect.provideService(EvidenceWorkflowControl, this.evidenceWorkflowControl()));
  });

  private readonly assertRuntimeAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.readRecordProgram();
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    return record;
  });

  private readonly preparePiSessionAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm")
      return yield* wrongState(
        record.status,
        "access",
        record.status === "sleeping"
          ? "Resume the session from Home before opening the worklog"
          : undefined,
      );
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    if (record.operation)
      return yield* conflict(`Session is already running ${record.operation.kind}`);
    if (record.execution.provider !== "cloudflare")
      return yield* wrongState(record.status, "access", "This session uses the runner runtime");
    const vault = yield* CredentialVault;
    const containerAuth = yield* ContainerAuth;
    const credential = yield* vault.require;
    yield* containerAuth.ensurePiSession(record.id, credential);
  });

  private readonly projectProgram = Effect.fnUntraced(function* (record: SessionRecord) {
    yield* projectSessionBestEffort(record);
  });

  private readonly updateForOperationProgram = Effect.fnUntraced(function* (
    nonce: string,
    update: (record: SessionRecord) => SessionRecord,
  ) {
    const store = yield* SessionStore;
    const next = yield* store.updateForOperation(nonce, update);
    yield* projectSessionBestEffort(next);
    return next;
  });

  private readonly releaseOperationProgram = Effect.fnUntraced(function* (nonce: string) {
    const store = yield* SessionStore;
    const next = yield* store.releaseOperation(nonce);
    yield* projectSessionBestEffort(next);
    return next;
  });

  private readonly releaseOperationIfHeldProgram = Effect.fnUntraced(function* (nonce: string) {
    const store = yield* SessionStore;
    const next = yield* store.releaseOperationIfHeld(nonce);
    if (next) yield* projectSessionBestEffort(next);
  });

  private readonly failOperationProgram = Effect.fnUntraced(function* (
    nonce: string,
    code: string,
    message: string,
    recoverable: boolean,
  ) {
    const store = yield* SessionStore;
    const next = yield* store.failOperation(nonce, code, message, recoverable);
    yield* projectSessionBestEffort(next);
    return next;
  });

  private readonly acquireOperationProgram = Effect.fnUntraced(function* (
    kind: OperationKind,
    allowed: SessionStatus[],
    replaceOperationOlderThanMs?: number,
  ) {
    const store = yield* SessionStore;
    return yield* store.acquireOperation(
      kind,
      allowed,
      crypto.randomUUID(),
      replaceOperationOlderThanMs,
    );
  });

  private readonly isManagedStopPendingProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
  ) {
    const record = yield* this.readRecordProgram();
    return (
      (record?.status === "warm" || record?.status === "booting") &&
      record.operation?.nonce === nonce &&
      Boolean(record.operation.stopRequestedAt)
    );
  });

  private readonly prepareCloudflarePiCreateProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    prompt: string,
    nonce: string,
    startedAt: string,
  ) {
    const vault = yield* CredentialVault;
    const workspace = yield* Workspace;
    const credential = yield* vault.seed({
      piAuthJson: this.env.PI_AUTH_JSON,
      providerSentinelSeed: `${PI_SENTINEL_PREFIX}${record.id}-${randomToken(12)}`,
      githubSentinel: `${GITHUB_SENTINEL_PREFIX}${record.id}-${randomToken(12)}`,
    });
    const worktree = yield* workspace.prepare(record, credential.githubSentinel);
    yield* this.updateForOperationProgram(nonce, (current) => ({
      ...current,
      operation: {
        kind: "create",
        nonce,
        startedAt,
        createPhase: "runtime",
      },
      repoExistsAtCreate: worktree.repoExists,
      defaultBranch: worktree.defaultBranch,
    })).pipe(Effect.mapError((cause) => new SessionCreateUncertain({ cause })));
    return yield* this.continueCloudflarePiCreateProgram(record, prompt, nonce);
  });

  private readonly continueCloudflarePiCreateProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    prompt: string,
    nonce: string,
  ) {
    const vault = yield* CredentialVault;
    const containerAuth = yield* ContainerAuth;
    const piPhase = Effect.gen({ self: this }, function* () {
      const credential = yield* vault.require;
      yield* containerAuth.seed(record.id, credential, { initialPrompt: prompt });
      yield* containerAuth.ensurePiSession(record.id, credential);
      const readyAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* this.updateForOperationProgram(nonce, (current) => ({
        ...current,
        status: "warm",
        operation: null,
        codexThreadId: `pi-${record.id}`,
        agentState: "working",
        lastAgentEventAt: readyAt,
        failure: undefined,
        updatedAt: readyAt,
      }));
    });
    return yield* piPhase.pipe(
      Effect.mapError((failure) => new SessionCreateUncertain({ cause: failure })),
    );
  });

  private readonly failCreateSetupProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    id: string,
    nonce: string,
    failure: unknown,
  ) {
    const ambiguousError = (): ScottyError =>
      new ScottyError("upstream", "Pi session creation is ambiguous", {
        httpStatus: 502,
        exitCode: 4,
        hint: `The runtime was preserved. Retry session ${id} with the same idempotency key.`,
      });
    if (Predicate.isTagged(failure, "SessionCreateUncertain")) {
      yield* Effect.result(
        this.updateForOperationProgram(nonce, (record) => ({
          ...record,
          failure: {
            code: "create_ambiguous",
            message: "Pi session creation is ambiguous",
            recoverable: true,
          },
        })),
      );
      return yield* ambiguousError();
    }
    const failed = yield* this.failOperationProgram(
      nonce,
      "create_failed",
      "Session setup failed",
      false,
    );
    yield* this.destroyFailedRuntimeProgram(failed.id);
    return yield* this.upstreamError("Session setup failed", failure, failed.id);
  });

  private readonly finishCreateReconciliationProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    id: string,
    nonce: string,
    reconciled: Result.Result<SessionRecord, unknown>,
  ) {
    if (Result.isFailure(reconciled))
      return yield* this.failCreateSetupProgram(id, nonce, reconciled.failure);
    const completedAt = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(reconciled.success, new Date(completedAt)), completedAt);
  });

  private readonly replayCreateProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    prompt: string,
  ) {
    if (record.status === "booting" && record.operation?.kind === "create") {
      const operation = record.operation;
      if (record.execution.provider === "runner")
        return yield* wrongState(
          record.status,
          "create",
          "Runner-backed sessions require a native Pi transport and cannot be created yet",
        );
      if (operation.createPhase === "setup") {
        const reconciled = yield* Effect.result(
          this.prepareCloudflarePiCreateProgram(
            record,
            prompt,
            operation.nonce,
            operation.startedAt,
          ),
        );
        return yield* this.finishCreateReconciliationProgram(
          record.id,
          operation.nonce,
          reconciled,
        );
      }
      if (operation.createPhase === "runtime") {
        const reconciled = yield* Effect.result(
          this.continueCloudflarePiCreateProgram(record, prompt, operation.nonce),
        );
        return yield* this.finishCreateReconciliationProgram(
          record.id,
          operation.nonce,
          reconciled,
        );
      }
      return yield* new ScottyError("internal", "Authoritative create phase is invalid", {
        httpStatus: 500,
        exitCode: 1,
      });
    }
    const replayNow = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(record, new Date(replayNow)), replayNow);
  });

  private readonly dispatchRunnerProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    operation: RunnerOperation,
  ) {
    if (record.execution.provider !== "runner")
      return yield* new ScottyError("internal", "Runner binding is unavailable", {
        httpStatus: 500,
        exitCode: 1,
      });
    const execution = record.execution;
    return yield* Effect.tryPromise({
      try: () => this.env.RUNNERS.getByName(execution.runner).dispatch(operation),
      catch: (cause) => this.upstreamError("Runner dispatch failed", cause, record.id),
    });
  });

  private readonly removeRunnerRuntimeProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    operationId: string,
  ) {
    if (record.execution.provider !== "runner") return;
    const result = yield* this.dispatchRunnerProgram(record, {
      _tag: "RemoveRuntime",
      version: RUNNER_PROTOCOL_VERSION,
      operationId,
      sessionId: record.id,
    });
    const response = result.ok ? result.response : undefined;
    if (
      !Predicate.isTagged("RunnerSuccess")(response) ||
      !Predicate.isTagged("RemoveRuntimeResult")(response.result) ||
      response.result.phase !== "absent" ||
      response.result.resourceId !== record.execution.runtimeId
    )
      return yield* this.upstreamError("Runner cleanup failed", result, record.id);
  });

  private readonly createScottySessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    input: CreateSessionInput,
    id: string,
    idempotency?: CreateIdempotencyMetadata,
  ) {
    if (input.provider === "runner")
      return yield* new ScottyError(
        "bad_request",
        "Runner-backed sessions require a native Pi transport and cannot be created yet",
        { httpStatus: 400, exitCode: 2 },
      );
    const store = yield* SessionStore;
    const now = yield* Clock.currentTimeMillis;
    const nowIso = new Date(now).toISOString();
    const nonce = crypto.randomUUID();
    const initial: SessionRecord = {
      version: 1,
      id,
      title: input.title,
      status: "booting",
      operation: { kind: "create", nonce, startedAt: nowIso, createPhase: "setup" },
      execution: { provider: "cloudflare" },
      provider: "cloudflare",
      repo: input.repo,
      repoExistsAtCreate: true,
      defaultBranch: "dev",
      branch: `scotty/${id}`,
      createdAt: nowIso,
      updatedAt: nowIso,
      hardCapAt: new Date(now + input.hardCapSeconds * 1_000).toISOString(),
      hardCapDurationSeconds: input.hardCapSeconds,
      ownedBackupIds: [],
    };

    const inspected = yield* Effect.result(store.inspectInitial(initial, idempotency));
    if (Result.isFailure(inspected)) return yield* inspected.failure;
    const decisionBeforeSchedule = inspected.success;
    if (decisionBeforeSchedule.kind === "replay")
      return yield* this.replayCreateProgram(decisionBeforeSchedule.record, input.prompt);

    const hardCapSchedule = yield* Effect.result(
      hostEffect("schedule", () =>
        this.schedule(new Date(initial.hardCapAt), "enforceHardCap", {
          hardCapAt: initial.hardCapAt,
        } satisfies HardCapPayload),
      ),
    );
    const recordToCommit: SessionRecord = Result.isFailure(hardCapSchedule)
      ? {
          ...initial,
          status: "failed",
          operation: null,
          failure: {
            code: "create_failed",
            message: "Session setup failed",
            recoverable: false,
          },
        }
      : initial;

    const committed = yield* Effect.result(store.createInitial(recordToCommit, idempotency));
    if (Result.isFailure(committed)) return yield* committed.failure;
    const decision = committed.success;
    if (decision.kind === "replay")
      return yield* this.replayCreateProgram(decision.record, input.prompt);
    yield* this.projectProgram(recordToCommit);

    if (Result.isFailure(hardCapSchedule)) {
      yield* this.destroyFailedRuntimeProgram(recordToCommit.id);
      return yield* this.upstreamError(
        "Session setup failed",
        hardCapSchedule.failure,
        recordToCommit.id,
      );
    }

    const setup = yield* Effect.result(
      this.prepareCloudflarePiCreateProgram(initial, input.prompt, nonce, nowIso),
    );
    if (Result.isFailure(setup))
      return yield* this.failCreateSetupProgram(initial.id, nonce, setup.failure);
    const completedAt = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(setup.success, new Date(completedAt)), completedAt);
  });

  private readonly getScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(record, new Date(now)), now);
  });

  private readonly reseedPiAuthProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm")
      return yield* wrongState(record.status, "reseed auth", "Only warm sessions can be reseeded");
    if (record.execution.provider !== "cloudflare")
      return yield* wrongState(
        record.status,
        "reseed auth",
        "Runner credentials are managed by the runner host",
      );
    if (record.operation)
      return yield* conflict(`Session is already running ${record.operation.kind}`);
    const vault = yield* CredentialVault;
    const containerAuth = yield* ContainerAuth;
    const currentCredential = yield* vault.require;
    yield* containerAuth.quiescePiSession(record.id, currentCredential);
    const credential = yield* vault.reseed({
      piAuthJson: this.env.PI_AUTH_JSON,
      providerSentinelSeed: `${PI_SENTINEL_PREFIX}${record.id}-${randomToken(12)}`,
    });
    yield* containerAuth.refreshPiAuth(record.id, credential);
    yield* containerAuth.stopPiSession();
    yield* containerAuth.ensurePiSession(record.id, credential);
    return {
      id: record.id,
      updatedAt: credential.updatedAt,
      providers: piProviderMetadata(
        Object.fromEntries(
          Object.entries(credential.providers).map(([providerId, provider]) => [
            providerId,
            provider.credential,
          ]),
        ),
      ),
    };
  });

  private readonly renameScottySessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    title: string,
  ) {
    const store = yield* SessionStore;
    const record = yield* store.rename(title);
    yield* this.projectProgram(record);
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(record, new Date(now)), now);
  });

  private readonly resumeRunnerSessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const authoritative = yield* this.requireRecordProgram();
    return yield* wrongState(
      authoritative.status,
      "resume",
      "Runner-backed sessions require a native Pi transport and cannot be resumed yet",
    );
  });

  private readonly stopRunnerIntoSleepingProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    nonce: string,
    operationId: string,
    retryWhileRunning: boolean,
  ) {
    if (record.execution.provider !== "runner")
      return yield* new ScottyError("internal", "Runner binding is unavailable", {
        httpStatus: 500,
        exitCode: 1,
      });
    const runtimeId = record.execution.runtimeId;
    const stopped = yield* Effect.result(
      this.dispatchRunnerProgram(record, {
        _tag: "StopRuntime",
        version: RUNNER_PROTOCOL_VERSION,
        operationId,
        sessionId: record.id,
      }),
    );
    const stopDispatch = Result.isSuccess(stopped) ? stopped.success : undefined;
    const stopResponse = stopDispatch?.ok ? stopDispatch.response : undefined;
    let phase =
      Predicate.isTagged("RunnerSuccess")(stopResponse) &&
      Predicate.isTagged("StopRuntimeResult")(stopResponse.result) &&
      stopResponse.result.resourceId === runtimeId
        ? stopResponse.result.phase
        : undefined;

    if (phase !== "stopped") {
      const inspected = yield* Effect.result(
        this.dispatchRunnerProgram(record, {
          _tag: "InspectRuntime",
          version: RUNNER_PROTOCOL_VERSION,
          operationId: `${operationId}-inspect`,
          sessionId: record.id,
        }),
      );
      const inspectDispatch = Result.isSuccess(inspected) ? inspected.success : undefined;
      const inspectResponse = inspectDispatch?.ok ? inspectDispatch.response : undefined;
      if (
        Predicate.isTagged("RunnerSuccess")(inspectResponse) &&
        Predicate.isTagged("InspectRuntimeResult")(inspectResponse.result) &&
        inspectResponse.result.resourceId === runtimeId
      )
        phase = inspectResponse.result.phase;

      if (phase !== "stopped") {
        if (phase === "absent") {
          yield* this.failOperationProgram(
            nonce,
            "runner_runtime_absent",
            "Runner runtime is absent",
            true,
          );
        } else {
          if (phase === "running" && !retryWhileRunning) {
            yield* this.releaseOperationIfHeldProgram(nonce);
          } else {
            yield* hostEffect("schedule", () =>
              this.schedule(5, "enforceHardCap", { hardCapAt: record.hardCapAt }),
            );
          }
        }
        return yield* this.upstreamError(
          "Session stop failed",
          Result.isFailure(stopped) ? stopped.failure : stopDispatch,
          record.id,
        );
      }
    }

    const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const sleeping = yield* this.updateForOperationProgram(nonce, (current) => ({
      ...current,
      status: "sleeping",
      operation: null,
      failure: undefined,
      updatedAt,
    }));
    yield* Effect.sync(() => this.deleteSchedules("enforceHardCap"));
    return sleeping;
  });

  private readonly resumeScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const authoritative = yield* this.requireRecordProgram();
    if (authoritative.execution.provider === "runner")
      return yield* this.resumeRunnerSessionProgram();
    const backups = yield* BackupStore;
    const vault = yield* CredentialVault;
    const containerAuth = yield* ContainerAuth;
    const operation = yield* this.acquireOperationProgram("resume", ["sleeping", "failed"]);
    let record = yield* this.requireRecordProgram();
    const backup = record.backup?.current;
    if (!backup) {
      yield* this.releaseOperationProgram(operation.nonce);
      return yield* wrongState(record.status, "resume", "No successful backup is available");
    }

    const bootingAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    record = yield* this.updateForOperationProgram(operation.nonce, (current) => ({
      ...current,
      status: "booting",
      failure: undefined,
      updatedAt: bootingAt,
    }));

    const restored = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        const hardCapAt = new Date(
          (yield* Clock.currentTimeMillis) + record.hardCapDurationSeconds * 1_000,
        ).toISOString();
        const hardCapUpdatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        record = yield* this.updateForOperationProgram(operation.nonce, (current) => ({
          ...current,
          hardCapAt,
          updatedAt: hardCapUpdatedAt,
        }));
        yield* hostEffect("schedule", () => this.scheduleHardCap(hardCapAt));
        yield* backups.restore(backup);
        const credential = yield* vault.require;
        yield* containerAuth.seed(record.id, credential);
        yield* this.restorePiAndHatchProgram(
          operation.nonce,
          containerAuth.ensurePiSession(record.id, credential),
        );
        const readyAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const ready = yield* this.updateForOperationProgram(operation.nonce, (current) => ({
          ...current,
          status: "warm",
          operation: null,
          agentState: "waiting",
          lastAgentEventAt: readyAt,
          failure: undefined,
          hardCapAt,
          updatedAt: readyAt,
        }));
        return ready;
      }),
    );
    if (Result.isFailure(restored)) {
      yield* this.failOperationProgram(
        operation.nonce,
        "resume_failed",
        "Session restore failed",
        true,
      );
      yield* this.destroyFailedRuntimeProgram(record.id);
      return yield* this.upstreamError("Session restore failed", restored.failure);
    }
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(restored.success, new Date(now)), now);
  });

  private readonly armVaporizeRetryProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: VaporizeRetryPayload,
  ) {
    yield* Effect.sync(() => this.deleteSchedules("retryVaporizeSession"));
    yield* hostEffect("schedule", () =>
      this.schedule(DESTROY_RETRY_SECONDS, "retryVaporizeSession", payload),
    );
  });

  private readonly continueVaporizeSessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: VaporizeRetryPayload,
  ) {
    const backups = yield* BackupStore;
    const vault = yield* CredentialVault;
    const store = yield* SessionStore;
    const current = yield* this.readRecordProgram();
    if (!current) return yield* notFound(payload.id);
    if (current.status === "gone") return yield* this.repairGoneSessionProgram(current);
    if (current.operation?.kind !== "vaporize" || current.operation.nonce !== payload.nonce)
      return yield* conflict("Session vaporize lease changed");

    yield* projectSessionBestEffort(current);
    yield* Effect.sync(() => this.cancelVaporizeConflictingSchedules());
    const hatchCleanup = yield* Effect.result(
      this.cleanupHatchProgram(payload.nonce, "gone", true, "operation"),
    );
    if (Result.isFailure(hatchCleanup)) {
      yield* this.armVaporizeRetryProgram(payload);
      return yield* hatchCleanup.failure;
    }
    const destroyed =
      current.execution.provider === "runner"
        ? yield* this.removeRunnerRuntimeProgram(current, `vaporize-${payload.nonce}`).pipe(
            Effect.as(true),
          )
        : this.rawContainer?.running !== true
          ? true
          : yield* Effect.raceFirst(
              hostEffect("destroy", () => this.destroy()).pipe(Effect.as(true)),
              Effect.sleep(DESTROY_DEADLINE_MS).pipe(Effect.as(false)),
            );
    if (!destroyed) {
      yield* this.armVaporizeRetryProgram(payload);
      yield* Effect.sync(() => this.ctx.abort(`Sandbox destroy exceeded ${DESTROY_DEADLINE_MS}ms`));
      return yield* new ScottyError("upstream", "Sandbox destruction timed out", {
        httpStatus: 502,
        exitCode: 1,
      });
    }
    if (hatchCleanup.success)
      yield* Effect.flatMap(HatchStore, (hatch) => hatch.clearAfterVaporize(payload.nonce));

    for (const backupId of new Set(current.ownedBackupIds)) yield* backups.delete(backupId);
    const evidence = yield* EvidenceStore;
    const evidenceState = yield* evidence.read;
    const hasEvidenceAuthority =
      evidenceState.activeJob !== undefined ||
      evidenceState.jobs.length > 0 ||
      evidenceState.artifacts.length > 0 ||
      evidenceState.pendingDeletes.length > 0;
    if (hasEvidenceAuthority) {
      const pending = yield* evidence.prepareVaporizeDeletes(payload.nonce);
      yield* this.deleteEvidenceArtifactsProgram(pending);
      yield* evidence.clearForVaporize(payload.nonce);
    }
    yield* vault.delete;
    yield* store.clearCreateIdempotency;
    const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const gone = yield* this.updateForOperationProgram(payload.nonce, (record) => ({
      ...record,
      status: "gone",
      operation: null,
      backup: undefined,
      ownedBackupIds: [],
      backupExpiresAt: undefined,
      codexThreadId: undefined,
      agentState: undefined,
      lastAgentEventAt: undefined,
      failure: undefined,
      updatedAt,
    }));
    yield* removeSessionProjection(gone.id);
    yield* Effect.sync(() => this.cancelAllSessionSchedules());
    return { id: gone.id, status: "gone" as const };
  });

  private readonly vaporizeScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    let existing = yield* this.readRecordProgram();
    if (!existing) return yield* notFound("unknown");
    if (existing.status === "gone") {
      const repaired = yield* Effect.result(this.repairGoneSessionProgram(existing));
      if (Result.isSuccess(repaired)) return repaired.success;
      yield* this.armVaporizeRetryProgram({ id: existing.id, nonce: "gone" });
      return yield* this.upstreamError(
        "Vaporize projection repair failed",
        repaired.failure,
        existing.id,
      );
    }
    if (existing.operation?.kind === "evidence") {
      const evidence = yield* EvidenceStore;
      yield* this.cleanupEvidencePreviewProgram(existing.operation.nonce, "interrupted");
      yield* evidence.interrupt(existing.operation.nonce, "interrupted");
      existing = yield* this.requireRecordProgram();
    }
    const operation =
      existing.operation?.kind === "vaporize"
        ? existing.operation
        : yield* this.acquireOperationProgram(
            "vaporize",
            ["booting", "warm", "sleeping", "failed"],
            ABANDONED_OPERATION_MS,
          );
    const payload = { id: existing.id, nonce: operation.nonce } satisfies VaporizeRetryPayload;
    const armed = yield* Effect.result(this.armVaporizeRetryProgram(payload));
    if (Result.isFailure(armed)) {
      yield* this.releaseOperationIfHeldProgram(operation.nonce);
      return yield* this.upstreamError(
        "Vaporize retry scheduling failed",
        armed.failure,
        existing.id,
      );
    }
    const vaporized = yield* Effect.result(this.continueVaporizeSessionProgram(payload));
    if (Result.isFailure(vaporized))
      return yield* this.upstreamError("Vaporize failed", vaporized.failure);
    return vaporized.success;
  });

  private readonly repairGoneSessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
  ) {
    const vault = yield* CredentialVault;
    const store = yield* SessionStore;
    if (record.execution.provider === "cloudflare" && this.rawContainer?.running === true) {
      const destroyed = yield* Effect.raceFirst(
        hostEffect("destroy", () => this.destroy()).pipe(Effect.as(true)),
        Effect.sleep(DESTROY_DEADLINE_MS).pipe(Effect.as(false)),
      );
      if (!destroyed)
        return yield* new ScottyError("upstream", "Sandbox destruction timed out", {
          httpStatus: 502,
          exitCode: 1,
        });
    }
    yield* vault.delete;
    yield* store.clearCreateIdempotency;
    yield* removeSessionProjection(record.id);
    yield* Effect.sync(() => this.cancelAllSessionSchedules());
    return { id: record.id, status: "gone" as const };
  });

  private readonly prepareDownArchiveProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const authoritative = yield* this.requireRecordProgram();
    if (authoritative.execution.provider === "runner")
      return yield* wrongState(
        authoritative.status,
        "beam down",
        "Runner lifecycle is not supported yet",
      );
    const runtime = yield* SandboxRuntime;
    const discovery = yield* RolloutDiscovery;
    const operation = yield* this.acquireOperationProgram("down", ["warm"]);
    const record = yield* this.requireRecordProgram();
    const root = sessionRoot(record.id);
    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        const sha = (yield* runtime.execChecked(
          `git -C ${shellQuote(root)} rev-parse HEAD`,
        )).stdout.trim();
        const rollout = Option.getOrElse(yield* discovery.findNewestRollout(record.id), () => {
          return undefined;
        });
        const manifest: DownManifest = {
          version: 1,
          id: record.id,
          repo: record.repo,
          branch: record.branch,
          sha,
          codexThreadId: record.codexThreadId,
          rolloutFile: rollout ? basename(rollout) : undefined,
        };
        const manifestPath = `/tmp/metadata.json`;
        const archivePath = `/tmp/scotty-${record.id}.tar`;
        yield* runtime.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const members = [`-C /tmp ${shellQuote(basename(manifestPath))}`];
        if (rollout)
          members.push(`-C ${shellQuote(dirname(rollout))} ${shellQuote(basename(rollout))}`);
        yield* runtime.execChecked(`tar -cf ${shellQuote(archivePath)} ${members.join(" ")}`);
        return { path: archivePath, filename: `scotty-${record.id}.tar`, manifest };
      }),
    );
    yield* this.releaseOperationProgram(operation.nonce);
    if (Result.isFailure(prepared))
      return yield* this.upstreamError("Beam-down archive failed", prepared.failure);
    return prepared.success;
  });

  private readonly markHardCapFailureProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    record: SessionRecord,
    message: string,
  ) {
    const store = yield* SessionStore;
    const failedOption = yield* store.markHardCapFailure(record, message);
    if (Option.isNone(failedOption)) return;
    const failed = failedOption.value;
    yield* this.projectProgram(failed);
    yield* this.destroyFailedRuntimeProgram(failed.id);
  });

  private readonly destroyFailedRuntimeProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    sessionId: string,
    hatchAuthority: "failed_runtime" | "hard_cap" = "failed_runtime",
  ) {
    const record = yield* this.readRecordProgram();
    if (record?.execution.provider === "runner") {
      yield* this.removeRunnerRuntimeProgram(record, `failed-cleanup-${sessionId}`);
      return;
    }
    const hatchCleanupNonce = `hardcap-${randomToken(8)}`;
    const hatchTarget = hatchAuthority === "failed_runtime" ? "failed" : "stopped";
    const hatchCleanup = yield* Effect.result(
      this.cleanupHatchProgram(hatchCleanupNonce, hatchTarget, false, hatchAuthority),
    );
    if (Result.isFailure(hatchCleanup))
      yield* hostEffect("schedule", () =>
        this.schedule(5, "retryHatchCleanup", {
          operationNonce: hatchCleanupNonce,
          target: hatchTarget,
          closeDesired: false,
        } satisfies HatchCleanupRetryV1),
      );
    yield* Effect.sync(() => this.deleteSchedules("retryHardCapDestroy"));
    const destroyed = yield* Effect.result(
      Effect.raceFirst(
        hostEffect("destroy", () => this.destroy()).pipe(Effect.as(true)),
        Effect.sleep(DESTROY_DEADLINE_MS).pipe(Effect.as(false)),
      ),
    );
    if (Result.isSuccess(destroyed) && destroyed.success) return;
    yield* hostEffect("schedule", () =>
      this.schedule(DESTROY_RETRY_SECONDS, "retryHardCapDestroy", sessionId),
    );
    yield* Effect.sync(() => this.ctx.abort(`Sandbox destroy did not complete for ${sessionId}`));
  });

  private readonly retryVaporizeSessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: VaporizeRetryPayload,
  ) {
    const record = yield* this.readRecordProgram();
    if (!record || record.id !== payload.id) return;
    if (record.status !== "gone" && record.operation?.nonce !== payload.nonce) return;
    const armed = yield* Effect.result(this.armVaporizeRetryProgram(payload));
    if (Result.isFailure(armed)) {
      const released = yield* Effect.result(this.releaseOperationIfHeldProgram(payload.nonce));
      if (Result.isFailure(released)) {
        yield* Effect.sync(() =>
          console.error("Vaporize schedule failure lease release failed", {
            sessionId: payload.id,
            error: errorName(released.failure),
          }),
        );
      }
      yield* Effect.sync(() =>
        console.error("Vaporize retry scheduling failed", {
          sessionId: payload.id,
          error: errorName(armed.failure),
        }),
      );
      return;
    }
    const continued = yield* Effect.result(this.continueVaporizeSessionProgram(payload));
    if (Result.isFailure(continued)) {
      const stateError = decodeEvidenceStateError(continued.failure);
      yield* Effect.sync(() =>
        console.error("Vaporize reconciliation failed", {
          sessionId: payload.id,
          error: errorName(continued.failure),
          ...(Option.isSome(stateError) ? { evidenceStateReason: stateError.value.reason } : {}),
        }),
      );
    }
  });

  private readonly enforceHardCapProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: HardCapPayload,
  ) {
    const record = yield* this.readRecordProgram();
    if (!record || record.status === "gone" || record.status === "sleeping") return;
    if (payload.hardCapAt !== record.hardCapAt) return;
    if (
      record.execution.provider === "runner" &&
      (record.operation?.kind === "snapshot" || record.operation?.kind === "resume")
    ) {
      const stopped = yield* Effect.result(
        this.stopRunnerIntoSleepingProgram(
          record,
          record.operation.nonce,
          `hard-cap-${record.operation.nonce}`,
          true,
        ),
      );
      if (Result.isFailure(stopped))
        yield* Effect.sync(() =>
          console.error("Runner hard-cap stop failed", {
            sessionId: record.id,
            error: errorName(stopped.failure),
          }),
        );
      return;
    }
    if (record.operation) {
      if (record.operation.kind === "vaporize") return;
      if (record.operation.kind === "evidence") {
        const evidence = yield* EvidenceStore;
        const cleaned = yield* Effect.result(
          this.cleanupEvidencePreviewProgram(record.operation.nonce, "deadline"),
        );
        if (Result.isFailure(cleaned)) {
          const rescheduled = yield* Effect.result(
            hostEffect("schedule", () =>
              this.schedule(EVIDENCE_CLEANUP_RETRY_SECONDS, "enforceHardCap", payload),
            ),
          );
          const destroyed = yield* Effect.result(
            this.destroyFailedRuntimeProgram(record.id, "hard_cap"),
          );
          if (Result.isFailure(destroyed)) return yield* destroyed.failure;
          if (Result.isFailure(rescheduled)) return yield* rescheduled.failure;
          return;
        }
        const interrupted = yield* Effect.result(
          evidence.interrupt(record.operation.nonce, "deadline"),
        );
        if (Result.isFailure(interrupted)) {
          yield* Effect.sync(() =>
            console.error("Evidence hard-cap interruption failed", {
              sessionId: record.id,
              error: errorName(interrupted.failure),
            }),
          );
          return;
        }
      } else {
        const operationAge =
          (yield* Clock.currentTimeMillis) - Date.parse(record.operation.startedAt);
        if (operationAge < HARD_CAP_GRACE_MS) {
          yield* hostEffect("schedule", () => this.schedule(5, "enforceHardCap", payload));
          return;
        }
        yield* this.markHardCapFailureProgram(
          record,
          "A session operation exceeded the hard-cap grace period",
        );
        return;
      }
    }

    if (record.execution.provider === "runner") {
      const acquired = yield* Effect.result(
        this.acquireOperationProgram("snapshot", ["warm", "booting"]),
      );
      if (Result.isFailure(acquired)) return;
      const stopped = yield* Effect.result(
        this.stopRunnerIntoSleepingProgram(
          record,
          acquired.success.nonce,
          `hard-cap-${acquired.success.nonce}`,
          true,
        ),
      );
      if (Result.isFailure(stopped))
        yield* Effect.sync(() =>
          console.error("Runner hard-cap stop failed", {
            sessionId: record.id,
            error: errorName(stopped.failure),
          }),
        );
      return;
    }

    const operationResult = yield* Effect.result(
      this.acquireOperationProgram("snapshot", ["warm", "booting"]),
    );
    if (Result.isFailure(operationResult)) {
      const current = yield* this.readRecordProgram();
      if (current)
        yield* this.markHardCapFailureProgram(current, "Hard-cap checkpoint or shutdown failed");
      return;
    }
    const operation = operationResult.success;
    const stopped = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.checkpointProgram(operation.nonce, false, false);
        yield* this.stopAfterCheckpointProgram(operation.nonce);
      }),
    );
    if (Result.isSuccess(stopped)) return;
    const pending = yield* this.isManagedStopPendingProgram(operation.nonce);
    if (Predicate.isTagged(stopped.failure, "ManagedStopArmedError") || pending) return;
    const current = yield* this.readRecordProgram();
    if (current)
      yield* this.markHardCapFailureProgram(current, "Hard-cap checkpoint or shutdown failed");
  });

  private readonly onActivityExpiredProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.readRecordProgram();
    if (!record || record.status !== "warm" || record.operation) return;
    const acquired = yield* Effect.result(this.acquireOperationProgram("snapshot", ["warm"]));
    if (Result.isFailure(acquired)) {
      yield* Effect.sync(() =>
        console.error("Managed idle checkpoint failed", {
          sessionId: record.id,
          error: errorName(acquired.failure),
        }),
      );
      return;
    }
    const operation = acquired.success;
    if (record.execution.provider === "runner") {
      const stopped = yield* Effect.result(
        this.stopRunnerIntoSleepingProgram(
          record,
          operation.nonce,
          `idle-${operation.nonce}`,
          true,
        ),
      );
      if (Result.isFailure(stopped))
        yield* Effect.sync(() =>
          console.error("Runner idle stop failed", {
            sessionId: record.id,
            error: errorName(stopped.failure),
          }),
        );
      return;
    }
    const stopped = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.checkpointProgram(operation.nonce, false, false);
        yield* this.stopAfterCheckpointProgram(operation.nonce);
      }),
    );
    if (Result.isSuccess(stopped)) return;
    if (Predicate.isTagged(stopped.failure, "CheckpointRuntimeUnavailable")) {
      yield* Effect.sync(() =>
        console.error("Managed idle checkpoint failed", {
          sessionId: record.id,
          error: errorName(stopped.failure),
        }),
      );
      return;
    }
    const pending = yield* this.isManagedStopPendingProgram(operation.nonce);
    if (!Predicate.isTagged(stopped.failure, "ManagedStopArmedError") && !pending)
      yield* this.releaseOperationIfHeldProgram(operation.nonce);
    yield* Effect.sync(() =>
      console.error("Managed idle checkpoint failed", {
        sessionId: record.id,
        error: errorName(stopped.failure),
      }),
    );
  });

  private readonly interruptEvidenceForRuntimeStopProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const evidence = yield* EvidenceStore;
      const state = yield* evidence.read;
      const active = state.activeJob;
      if (active === undefined) return;
      yield* this.cleanupEvidencePreviewProgram(active.operationNonce, "interrupted");
      yield* evidence.interrupt(active.operationNonce, "interrupted");
    },
  );

  private readonly onStopProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const store = yield* SessionStore;
    const next = yield* store.recordRuntimeStop;
    if (Option.isSome(next)) {
      yield* this.projectProgram(next.value);
    }
  });

  private readonly finalizeManagedStopProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: ManagedStopPayload,
  ) {
    const store = yield* SessionStore;
    const record = yield* this.readRecordProgram();
    if (!sessionAllowsRuntimeAccess(record)) return;
    if (
      record.operation?.nonce === payload.nonce &&
      record.operation.checkpointedBackupId === record.backup?.current.id &&
      !record.operation.stopRequestedAt
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (now - Date.parse(payload.armedAt) < 30_000) {
        yield* hostEffect("schedule", () =>
          this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
        );
        return;
      }
      yield* hostEffect("schedule", () =>
        this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
      );
      const rollbackClaimed = yield* store.claimManagedStopRollback(payload.nonce);
      if (!rollbackClaimed) return;
      yield* this.releaseOperationIfHeldProgram(payload.nonce);
      return;
    }
    if (!(yield* this.isManagedStopPendingProgram(payload.nonce))) return;
    yield* hostEffect("schedule", () =>
      this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
    );
    const stopped = yield* Effect.result(hostEffect("stop", () => this.stop()));
    if (Result.isFailure(stopped)) {
      yield* Effect.sync(() =>
        console.error("Managed stop reconciliation failed", {
          error: errorName(stopped.failure),
        }),
      );
    }
  });

  private readonly retryHardCapDestroyProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    sessionId: string,
  ) {
    const record = yield* this.readRecordProgram();
    if (
      !record ||
      record.id !== sessionId ||
      record.status !== "failed" ||
      record.operation?.kind === "vaporize"
    )
      return;
    yield* this.destroyFailedRuntimeProgram(sessionId);
  });

  private readonly previewForwardingRoute = (
    request: Request,
  ):
    | {
        readonly requestId: string;
        readonly sessionId: string;
        readonly port: number;
        readonly routeNonce: string;
      }
    | undefined => {
    const requestId = request.headers.get(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      requestId === null ||
      Option.isNone(decodeEvidencePreviewRequestId(requestId)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      !/^[0-9a-f]{12}$/u.test(sessionId) ||
      routeNonce === null ||
      !/^[a-z0-9_]{16}$/u.test(routeNonce)
    )
      return undefined;
    const port = Number(portValue);
    return Number.isSafeInteger(port) ? { requestId, sessionId, port, routeNonce } : undefined;
  };

  private async settlePreviewForward(requestId: string, responseBytes: number): Promise<void> {
    this.previewRequests.delete(requestId);
    return this.#run(this.settleScottyEvidencePreviewProgram(requestId, responseBytes));
  }

  private async expirePreviewForward(requestId: string): Promise<void> {
    this.previewRequests.delete(requestId);
    return this.#run(this.expireScottyEvidencePreviewProgram(requestId));
  }

  private async previewResponseStream(
    requestId: string,
    response: Response,
    abortController: AbortController,
    settle: (responseBytes: number) => Promise<void>,
  ): Promise<Response> {
    const body = response.body;
    if (body === null) {
      await settle(0);
      const headers = new Headers(response.headers);
      headers.set(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER, requestId);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const reader = body.getReader();
    let responseBytes = 0;
    let terminal = false;
    let consumerCancel = false;
    const finish = async (bytes: number): Promise<void> => {
      if (terminal) return;
      terminal = true;
      await settle(bytes);
    };
    let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abort = (): void => {
      if (terminal || consumerCancel) return;
      void reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      void finish(responseBytes).then(
        () => outputController?.error(new DOMException("Preview request ended", "AbortError")),
        (cause) => outputController?.error(cause),
      );
    };
    abortController.signal.addEventListener("abort", abort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
      },
      async pull(controller) {
        const next = await reader.read().then(
          (value) => ({ ok: true as const, value }),
          (cause) => ({ ok: false as const, cause }),
        );
        if (terminal) return;
        if (!next.ok) {
          await finish(responseBytes);
          controller.error(next.cause);
          return;
        }
        if (next.value.done) {
          await finish(responseBytes);
          controller.close();
          return;
        }
        const nextBytes = responseBytes + next.value.value.byteLength;
        if (nextBytes > EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES) {
          await reader.cancel().then(
            () => undefined,
            () => undefined,
          );
          await finish(EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES);
          controller.error(
            new DOMException("Preview response exceeded its limit", "QuotaExceededError"),
          );
          return;
        }
        responseBytes = nextBytes;
        controller.enqueue(next.value.value);
      },
      async cancel(reason) {
        consumerCancel = true;
        abortController.abort();
        await reader.cancel(reason).then(
          () => undefined,
          () => undefined,
        );
        await finish(responseBytes);
      },
    });
    if (abortController.signal.aborted) abort();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER, requestId);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private forwardSandboxPreviewRequest(request: Request): Promise<Response> {
    return super.fetch(request);
  }

  private async fetchEvidencePreviewRequest(request: Request): Promise<Response> {
    const isSdkPreviewRequest = request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) === "1";
    const privateRequestId = request.headers.get(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
    if (privateRequestId === null)
      return isSdkPreviewRequest ? deniedEvidencePreviewResponse() : super.fetch(request);
    const route = this.previewForwardingRoute(request);
    const hasForbiddenTransportHeader = [...request.headers].some(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized === "upgrade" ||
        normalized === "connection" ||
        normalized.startsWith("sec-websocket-")
      );
    });
    if (
      route === undefined ||
      request.method.toUpperCase() === "CONNECT" ||
      request.method.toUpperCase() === "TRACE" ||
      hasForbiddenTransportHeader
    ) {
      if (Option.isSome(decodeEvidencePreviewRequestId(privateRequestId)))
        await this.cancelScottyEvidencePreviewRequest(privateRequestId);
      return deniedEvidencePreviewResponse();
    }
    const claimed = await this.#run(this.claimScottyEvidencePreviewProgram(route.requestId, route));
    if (claimed === undefined) {
      await this.cancelScottyEvidencePreviewRequest(route.requestId);
      return deniedEvidencePreviewResponse();
    }
    const abortController = new AbortController();
    this.previewRequests.set(route.requestId, {
      operationNonce: claimed.operationNonce,
      controller: abortController,
    });
    const headers = new Headers(request.headers);
    headers.delete(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
    const forwarded = new Request(request, { headers, signal: abortController.signal });
    const nowMillis = await this.#run(Clock.currentTimeMillis);
    const remainingMillis = Math.max(0, Date.parse(claimed.expiresAt) - nowMillis);
    let expired = false;
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: the native Sandbox.fetch/ReadableStream host callback requires a real-time abort through response completion
    const timeout = setTimeout(() => {
      expired = true;
      abortController.abort();
    }, remainingMillis);
    request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    let settled = false;
    const settle = async (responseBytes: number): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await (expired
        ? this.expirePreviewForward(route.requestId)
        : this.settlePreviewForward(route.requestId, responseBytes));
    };
    const abortResult = new Promise<{ readonly kind: "aborted" }>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
        once: true,
      });
    });
    const upstream = this.previewRequestForwarder(forwarded).then(
      (response) => ({ kind: "response" as const, response }),
      () => ({ kind: "error" as const }),
    );
    const result = await Promise.race([upstream, abortResult]);
    if (result.kind !== "response") {
      abortController.abort();
      void upstream.then((late) => {
        if (late.kind === "response") {
          late.response.webSocket?.close(1001, "Preview request ended");
          void late.response.body?.cancel().then(
            () => undefined,
            () => undefined,
          );
        }
      });
      await settle(0);
      return deniedEvidencePreviewResponse();
    }
    if (abortController.signal.aborted) {
      await result.response.body?.cancel().then(
        () => undefined,
        () => undefined,
      );
      await settle(0);
      return deniedEvidencePreviewResponse();
    }
    if (result.response.webSocket !== null && result.response.webSocket !== undefined) {
      result.response.webSocket.close(1008, "WebSocket previews are disabled");
      await settle(0);
      return deniedEvidencePreviewResponse();
    }
    return this.previewResponseStream(route.requestId, result.response, abortController, settle);
  }

  async createScottySession(
    input: CreateSessionInput,
    id: string,
    idempotency?: CreateIdempotencyMetadata,
  ): Promise<SessionView> {
    const inFlight = this.createInFlight;
    if (inFlight !== undefined) {
      if (
        idempotency !== undefined &&
        inFlight.id === id &&
        inFlight.keyDigest === idempotency.keyDigest &&
        inFlight.inputDigest === idempotency.inputDigest
      )
        return inFlight.promise;
      const afterCurrent = (): Promise<SessionView> =>
        this.createScottySession(input, id, idempotency);
      return inFlight.promise.then(afterCurrent, afterCurrent);
    }

    const promise = this.#run(this.createScottySessionProgram(input, id, idempotency));
    const flight: InFlightCreate = {
      id,
      keyDigest: idempotency?.keyDigest,
      inputDigest: idempotency?.inputDigest,
      promise,
    };
    this.createInFlight = flight;
    const clear = (): void => {
      if (this.createInFlight === flight) this.createInFlight = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async getScottySession(): Promise<SessionView> {
    return this.#run(this.getScottySessionProgram());
  }

  private readonly requireHealthyHatchServiceProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    authorization: HatchRouteAuthorizationV1,
  ) {
    const store = yield* HatchStore;
    const state = yield* store.read;
    const hatch = state.primary;
    if (
      hatch === undefined ||
      hatch.hatchId !== authorization.hatchId ||
      hatch.generation !== authorization.generation ||
      hatch.runtimeEpoch !== authorization.runtimeEpoch
    )
      return false;
    const runtime = yield* SandboxRuntime;
    const health = yield* Effect.result(
      runtime.fetchPortStatus(hatch.service.healthPath, hatch.service.port, "GET"),
    );
    if (Result.isSuccess(health) && health.success >= 200 && health.success <= 399) return true;
    const operationNonce = `health-${randomToken(8)}`;
    const cleaned = yield* Effect.result(
      this.cleanupHatchProgram(operationNonce, "unhealthy", false, "health_check"),
    );
    if (Result.isFailure(cleaned))
      yield* hostEffect("schedule", () =>
        this.schedule(5, "retryHatchCleanup", {
          operationNonce,
          target: "unhealthy",
          closeDesired: false,
        } satisfies HatchCleanupRetryV1),
      ).pipe(Effect.ignore);
    return false;
  });

  async getScottyHatchStatus(): Promise<PublicHatchStatusV1> {
    return this.#run(
      Effect.gen({ self: this }, function* () {
        yield* this.requireRecordProgram();
        const store = yield* HatchStore;
        const status = yield* store.publicStatus;
        if (
          status.status === "configured" &&
          status.observedStatus === "running" &&
          status.exposure === "active" &&
          this.rawContainer?.running === true
        ) {
          const route = yield* Effect.result(store.activeRoute);
          if (Result.isSuccess(route)) yield* this.requireHealthyHatchServiceProgram(route.success);
          return yield* store.publicStatus;
        }
        return status;
      }),
    );
  }

  async getScottyHatchRestoreDescriptor(): Promise<HatchRestoreDescriptorV1 | undefined> {
    if (this.rawContainer?.running !== true) return undefined;
    return this.#run(Effect.flatMap(HatchStore, (store) => store.restoreDescriptor));
  }

  async ensureScottyHatch(value: unknown): Promise<PublicHatchStatusV1> {
    return this.#run(this.ensureScottyHatchProgram(value));
  }

  async closeScottyHatch(): Promise<PublicHatchStatusV1> {
    return this.#run(this.closeScottyHatchProgram());
  }

  async getScottyHatchOpenRoute(): Promise<HatchRouteAuthorizationV1 | undefined> {
    if (this.rawContainer?.running !== true) return undefined;
    return this.#run(
      Effect.flatMap(HatchStore, (store) => store.activeRoute).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    );
  }

  async getScottyHatchRoute(value: unknown): Promise<HatchRouteAuthorizationV1 | undefined> {
    const decoded = decodeHatchHostRoute(value);
    if (Option.isNone(decoded) || this.rawContainer?.running !== true) return undefined;
    const route = await this.#run(
      Effect.result(Effect.flatMap(HatchStore, (store) => store.activeRoute)),
    );
    if (
      Result.isFailure(route) ||
      route.success.sessionId !== decoded.value.sessionId ||
      route.success.port !== decoded.value.port ||
      route.success.routeNonce !== decoded.value.routeNonce
    )
      return undefined;
    return route.success;
  }

  async issueScottyHatchPermit(
    routeValue: unknown,
    browserClientIdValue: unknown,
    cookieDigestValue: unknown,
  ): Promise<IssuedHatchPermitV1 | undefined> {
    const route = decodeHatchHostRoute(routeValue);
    const browserClientId = decodeHatchBrowserClientId(browserClientIdValue);
    const cookieDigest = decodeHatchCookieDigest(cookieDigestValue);
    if (
      Option.isNone(route) ||
      Option.isNone(browserClientId) ||
      Option.isNone(cookieDigest) ||
      this.rawContainer?.running !== true
    )
      return undefined;
    const active = await this.getScottyHatchRoute(route.value);
    if (active === undefined) return undefined;
    return this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.issuePermit(route.value, browserClientId.value, cookieDigest.value),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
  }

  async admitScottyHatchRequest(value: unknown): Promise<HatchRequestPermitV1 | undefined> {
    const decoded = decodeHatchRequestAdmission(value);
    if (Option.isNone(decoded) || this.rawContainer?.running !== true) return undefined;
    const routeValue = {
      sessionId: decoded.value.sessionId,
      port: decoded.value.port,
      routeNonce: decoded.value.routeNonce,
    } satisfies HatchHostRouteV1;
    const route = await this.getScottyHatchRoute(routeValue);
    if (route === undefined) return undefined;
    const runtimeEpoch = await this.#run(Effect.result(this.currentRuntimeEpochProgram()));
    if (Result.isFailure(runtimeEpoch) || runtimeEpoch.success !== route.runtimeEpoch)
      return undefined;
    const cookieDigest = await sha256Hex(decoded.value.cookieSecret).then(
      (digest) => digest,
      () => undefined,
    );
    if (cookieDigest === undefined) return undefined;
    return this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.admitRequest({
          requestId: randomToken(16),
          sessionId: decoded.value.sessionId,
          port: decoded.value.port,
          routeNonce: decoded.value.routeNonce,
          runtimeEpoch: runtimeEpoch.success,
          cookieDigest,
          ingressBytes: decoded.value.ingressBytes,
        }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
  }

  async adjustScottyHatchRequest(requestId: string, ingressBytes: number): Promise<boolean> {
    if (
      Option.isNone(decodeHatchRequestId(requestId)) ||
      Option.isNone(decodeHatchIngressBytes(ingressBytes))
    )
      return false;
    return this.#run(
      Effect.flatMap(HatchStore, (store) => store.adjustRequest(requestId, ingressBytes)).pipe(
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
  }

  async cancelScottyHatchRequest(requestId: string): Promise<void> {
    if (Option.isNone(decodeHatchRequestId(requestId))) return;
    this.hatchRequests.get(requestId)?.abort();
    return this.#run(
      Effect.flatMap(HatchStore, (store) => store.cancelRequest(requestId)).pipe(Effect.ignore),
    );
  }

  async admitScottyHatchWebSocket(value: unknown): Promise<HatchWebSocketPermitV1 | undefined> {
    const decoded = decodeHatchWebSocketAdmission(value);
    const previewBase = this.previewBase;
    if (Option.isNone(decoded) || previewBase === undefined || this.rawContainer?.running !== true)
      return undefined;
    const expectedOrigin = hatchOrigin(decoded.value, previewBase);
    if (
      decoded.value.host !== new URL(expectedOrigin).hostname ||
      decoded.value.origin !== expectedOrigin
    )
      return undefined;
    const routeValue = {
      sessionId: decoded.value.sessionId,
      port: decoded.value.port,
      routeNonce: decoded.value.routeNonce,
    } satisfies HatchHostRouteV1;
    const active = await this.getScottyHatchRoute(routeValue);
    if (active === undefined) return undefined;
    const cookieDigest = await sha256Hex(decoded.value.cookieSecret).then(
      (digest) => digest,
      () => undefined,
    );
    if (cookieDigest === undefined) return undefined;
    const authorization = await this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.authorizeWebSocket(decoded.value, cookieDigest),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
    if (authorization === undefined) return undefined;
    const now = await this.#run(Clock.currentTimeMillis);
    for (const [socketId, admission] of this.hatchWebSocketAdmissions) {
      if (admission.expiresAtMillis <= now) this.hatchWebSocketAdmissions.delete(socketId);
    }
    if (
      this.hatchWebSocketAdmissions.size + this.hatchWebSockets.size >=
      HATCH_MAX_CONCURRENT_SOCKETS
    )
      return undefined;
    const socketId = randomToken(16);
    const expiresAtMillis = Math.min(
      Date.parse(authorization.expiresAt),
      now + HATCH_WEBSOCKET_ADMISSION_MILLIS,
    );
    if (expiresAtMillis <= now) return undefined;
    this.hatchWebSocketAdmissions.set(socketId, { authorization, expiresAtMillis });
    return {
      socketId,
      generation: authorization.generation,
      runtimeEpoch: authorization.runtimeEpoch,
      expiresAt: new Date(expiresAtMillis).toISOString(),
    };
  }

  async cancelScottyHatchWebSocket(socketId: string): Promise<void> {
    if (Option.isNone(decodeHatchWebSocketId(socketId))) return;
    this.hatchWebSocketAdmissions.delete(socketId);
    const tracked = this.hatchWebSockets.get(socketId);
    if (tracked !== undefined) tracked.close(1008, "Hatch WebSocket canceled");
  }

  async retryHatchCleanup(value: unknown): Promise<void> {
    const payload = decodeHatchCleanupRetry(value);
    if (Option.isNone(payload) || payload.value.target === "gone") return;
    return this.#run(this.retryHatchCleanupProgram(payload.value));
  }

  async [SANDBOX_TEST_ACCEPT_EVIDENCE](value: unknown): Promise<EvidenceActiveJobV2> {
    return this.#run(this.acceptScottyEvidenceJobProgram(value));
  }

  async runScottyEvidenceJob(value: unknown): Promise<BrowserEvidenceResultV2> {
    return this.#run(this.runScottyEvidenceJobProgram(value));
  }

  async [SANDBOX_TEST_EXPOSE_EVIDENCE](nonce: string): Promise<ExposedEvidencePreviewV2> {
    return this.#run(this.exposeScottyEvidencePreviewProgram(nonce));
  }

  async admitScottyEvidencePreview(
    input: EvidencePreviewAdmissionV2,
  ): Promise<EvidencePreviewPermitAdmissionV2 | undefined> {
    return this.#run(this.admitScottyEvidencePreviewProgram(input));
  }

  async adjustScottyEvidencePreviewRequest(
    requestId: string,
    ingressBytes: number,
  ): Promise<boolean> {
    if (
      Option.isNone(decodeEvidencePreviewRequestId(requestId)) ||
      Option.isNone(decodeEvidencePreviewIngressBytes(ingressBytes))
    )
      return false;
    return this.#run(this.adjustScottyEvidencePreviewProgram(requestId, ingressBytes));
  }

  async cancelScottyEvidencePreviewRequest(requestId: string): Promise<void> {
    if (Option.isNone(decodeEvidencePreviewRequestId(requestId))) return;
    this.previewRequests.get(requestId)?.controller.abort();
    return this.#run(this.cancelScottyEvidencePreviewProgram(requestId));
  }

  async expireScottyEvidencePreviewRequest(requestId: string): Promise<void> {
    if (Option.isNone(decodeEvidencePreviewRequestId(requestId))) return;
    this.previewRequests.get(requestId)?.controller.abort();
    return this.#run(this.expireScottyEvidencePreviewProgram(requestId));
  }

  async [SANDBOX_TEST_COMPLETE_EVIDENCE_STEP](
    nonce: string,
    input: unknown,
  ): Promise<EvidenceStepResult> {
    return this.#run(this.completeScottyEvidenceStepProgram(nonce, input));
  }

  async [SANDBOX_TEST_FINALIZE_EVIDENCE](
    nonce: string,
    status: EvidenceTerminalStatus,
  ): Promise<EvidenceJobSummaryV2> {
    return this.#run(this.finalizeScottyEvidenceJobProgram(nonce, status));
  }

  async listScottyEvidence(): Promise<ReadonlyArray<PublicEvidenceJobSummaryV2>> {
    return this.#run(
      Effect.map(
        Effect.flatMap(EvidenceStore, (store) => store.list),
        (jobs) => jobs.map(publicEvidenceSummaryProjection),
      ),
    );
  }

  async getScottyEvidence(jobId: string): Promise<PublicEvidenceJobSummaryV2> {
    return this.#run(
      Effect.map(
        Effect.flatMap(EvidenceStore, (store) => store.getJob(jobId)),
        publicEvidenceSummaryProjection,
      ),
    );
  }

  async getScottyEvidenceArtifact(jobId: string, frameId: string): Promise<EvidenceArtifactV2> {
    return this.#run(Effect.flatMap(EvidenceStore, (store) => store.getArtifact(jobId, frameId)));
  }

  async expireEvidenceJob(payload: EvidenceDeadlinePayload): Promise<void> {
    return this.#run(this.expireEvidenceJobProgram(payload));
  }

  async expireRetainedEvidence(payload: unknown): Promise<void> {
    return this.#run(this.expireRetainedEvidenceProgram(payload));
  }

  async reseedPiAuth() {
    return this.#run(this.reseedPiAuthProgram());
  }

  async preparePiSessionAccess(): Promise<void> {
    return this.#run(this.preparePiSessionAccessProgram());
  }

  private readonly passiveConsoleUnavailable = (
    reason: PiConsoleUnavailableV1["reason"],
    status: 409 | 503,
  ): Response =>
    Response.json(
      {
        version: PI_CONSOLE_PROTOCOL_VERSION,
        status: "unavailable",
        reason,
        retryable: false,
      } satisfies PiConsoleUnavailableV1,
      { status, headers: { "cache-control": "no-store" } },
    );

  private readonly readSessionControlAuthority = () =>
    this.#run(
      Effect.result(SessionStore.pipe(Effect.flatMap((store) => store.readControlAuthority))),
    );

  private readonly readPassiveConsoleAuthority = async (): Promise<
    SessionControlAuthority | Response
  > => {
    const read = await this.readSessionControlAuthority();
    if (Result.isFailure(read))
      return this.passiveConsoleUnavailable("session_authority_unavailable", 503);
    return read.success;
  };

  async containerSessionRequest(input: unknown): Promise<Response> {
    const decoded = decodeContainerSessionRequest(input);
    if (Option.isNone(decoded))
      return scottyErrorResponse(
        new ScottyError("bad_request", "Container session request is invalid", {
          httpStatus: 400,
          exitCode: 2,
        }),
      );

    return this.sessionControlGate.run(async () => {
      const sourceAuthority = await this.readSessionControlAuthority();
      if (Result.isFailure(sourceAuthority))
        return scottyErrorResponse(
          new ScottyError("internal", "Source session authority is unavailable", {
            httpStatus: 500,
            exitCode: 1,
          }),
        );
      const source = sourceAuthority.success.record;
      if (source.status !== "warm" || source.operation !== null)
        return scottyErrorResponse(
          new ScottyError("wrong_state", "Source session is not available for orchestration", {
            httpStatus: 409,
            exitCode: 5,
            hint: "The source session must be warm with no active lifecycle operation.",
          }),
        );
      if (source.provider !== "cloudflare" || source.execution.provider !== "cloudflare")
        return scottyErrorResponse(
          new ScottyError("wrong_state", "Source session provider cannot orchestrate sessions", {
            httpStatus: 409,
            exitCode: 5,
          }),
        );
      if (decoded.value.targetId === source.id)
        return scottyErrorResponse(
          new ScottyError("auth", "Container session access denied", {
            httpStatus: 401,
            exitCode: 4,
          }),
        );

      const target = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(decoded.value.targetId));
      const targetSession = await Promise.resolve()
        .then(() => target.getScottySession())
        .then(Result.succeed, () => Result.fail(undefined));
      if (Result.isFailure(targetSession))
        return scottyErrorResponse(notFound(decoded.value.targetId));
      if (targetSession.success.repo !== source.repo)
        return scottyErrorResponse(
          new ScottyError("auth", "Container session access denied", {
            httpStatus: 401,
            exitCode: 4,
          }),
        );

      return decoded.value.action === "inspect"
        ? inspectPassiveSession(target)
        : steerPassiveSession(target, decoded.value.targetId, decoded.value.message);
    });
  }

  private readonly validatePassiveConsoleAuthority = (
    authority: SessionControlAuthority,
  ): Response | undefined => {
    const { record } = authority;
    if (record.status !== "warm") return this.passiveConsoleUnavailable("session_not_warm", 409);
    if (record.operation) return this.passiveConsoleUnavailable("session_operation_active", 409);
    if (record.execution.provider !== "cloudflare")
      return this.passiveConsoleUnavailable("provider_unsupported", 409);
    return undefined;
  };

  private readonly stalePassiveConsoleCommand = (
    command: PiConsoleCommandV1,
    sessionRevision: number,
  ): Response =>
    Response.json(
      {
        version: PI_CONSOLE_PROTOCOL_VERSION,
        status: "stale",
        expectedSessionRevision: command.expectedSessionRevision,
        sessionRevision,
        retryable: false,
      } satisfies PiConsoleStaleCommandV1,
      { status: 409, headers: { "cache-control": "no-store" } },
    );

  private async fetchNativePassivePiConsole(input: {
    readonly sessionId: SessionRecord["id"];
    readonly request: Request;
  }): Promise<Response> {
    const container = this.rawContainer;
    if (container === undefined || !container.running)
      return this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503);

    const credential = await this.#run(
      Effect.result(CredentialVault.pipe(Effect.flatMap((vault) => vault.require))),
    );
    if (Result.isFailure(credential))
      return this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503);
    const transportToken = await piSessionTransportToken(input.sessionId, credential.success).then(
      (value) => Result.succeed(value),
      () => Result.fail(undefined),
    );
    if (Result.isFailure(transportToken))
      return this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503);

    const incomingUrl = new URL(input.request.url);
    const action = incomingUrl.pathname.slice(PI_CONSOLE_PROXY_PREFIX.length + 1);
    const targetUrl = new URL(`http://127.0.0.1:${PI_SESSION_PORT}/${action}`);
    targetUrl.search = incomingUrl.search;
    const headers = copyBoundedPassivePiConsoleHeaders(input.request.headers);
    headers.set(PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER, "1");
    headers.set(PI_SESSION_TOKEN_HEADER, transportToken.success);
    const body = input.request.method === "POST" ? await input.request.arrayBuffer() : undefined;
    const relayRequest = new Request(targetUrl, {
      method: input.request.method,
      headers,
      body,
      signal: input.request.signal,
    });

    return Promise.resolve()
      .then(() => container.getTcpPort(PI_SESSION_PORT).fetch(relayRequest))
      .then(
        (response) => {
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete(PI_SESSION_TOKEN_HEADER);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        },
        () => this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503),
      );
  }

  private async fetchPassivePiConsole(request: Request, action: string): Promise<Response> {
    let command: PiConsoleCommandV1 | undefined;
    if (action === "command") {
      const text = await readBoundedUtf8Body(request, PI_CONSOLE_MAX_COMMAND_BYTES);
      if (text === undefined) return Response.json({ error: "command_too_large" }, { status: 413 });
      const json = decodeJsonValue(text);
      if (Option.isNone(json)) return Response.json({ error: "invalid_command" }, { status: 400 });
      const decoded = await decodePiConsoleCommandV1Promise(json.value).then(
        (value) => Result.succeed(value),
        () => Result.fail(undefined),
      );
      if (Result.isFailure(decoded))
        return Response.json({ error: "invalid_command" }, { status: 400 });
      command = decoded.success;
    }

    const relayWithCurrentAuthority = async (): Promise<Response> => {
      const authority = await this.readPassiveConsoleAuthority();
      if (authority instanceof Response) return authority;
      if (command && command.expectedSessionRevision !== authority.revision)
        return this.stalePassiveConsoleCommand(command, authority.revision);
      const unavailable = this.validatePassiveConsoleAuthority(authority);
      if (unavailable) return unavailable;
      const relay = this.passivePiConsoleRelay;
      const relayHeaders = copyBoundedPassivePiConsoleHeaders(request.headers);
      if (command) relayHeaders.set("content-type", "application/json");
      const relayRequest = new Request(request.url, {
        method: request.method,
        headers: relayHeaders,
        body: command ? JSON.stringify(command) : undefined,
        signal: request.signal,
      });
      const response = await relay.fetch({
        sessionId: authority.record.id,
        request: relayRequest,
      });
      if (action !== "snapshot" || response.status !== 200) return response;

      const text = await readBoundedUtf8Body(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
      if (text === undefined)
        return Response.json({ error: "response_too_large" }, { status: 502 });
      const json = decodeJsonValue(text);
      if (Option.isNone(json)) return Response.json({ error: "invalid_snapshot" }, { status: 502 });
      const decoded = await decodePiConsoleRelaySnapshotV1(json.value).then(
        (value) => Result.succeed(value),
        () => Result.fail(undefined),
      );
      if (Result.isFailure(decoded))
        return Response.json({ error: "invalid_snapshot" }, { status: 502 });
      return Response.json(
        { ...decoded.success, sessionRevision: authority.revision },
        { headers: { "cache-control": "no-store" } },
      );
    };

    return command === undefined
      ? relayWithCurrentAuthority()
      : this.sessionControlGate.run(relayWithCurrentAuthority);
  }

  private readonly hatchWebSocketForwardingRoute = (
    request: Request,
  ): (HatchHostRouteV1 & { readonly socketId: string }) | undefined => {
    const socketId = request.headers.get(HATCH_PRIVATE_WEBSOCKET_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      socketId === null ||
      Option.isNone(decodeHatchWebSocketId(socketId)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      routeNonce === null
    )
      return undefined;
    const decoded = decodeHatchHostRoute({ sessionId, port: Number(portValue), routeNonce });
    return Option.isSome(decoded) ? { ...decoded.value, socketId } : undefined;
  };

  private bridgeHatchWebSocket(
    socketId: string,
    response: Response,
    authorization: HatchWebSocketAuthorization,
    nowMillis: number,
  ): Response | undefined {
    const upstream = response.webSocket;
    if (response.status !== 101 || upstream === null || upstream === undefined) return undefined;
    const [client, server] = Object.values(new WebSocketPair());
    let closed = false;
    let messageCount = 0;
    let aggregateBytes = 0;
    let idleTimer: ReturnType<typeof setTimeout>;
    let absoluteTimer: ReturnType<typeof setTimeout>;
    let messageTail = Promise.resolve();
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      if (this.hatchWebSockets.get(socketId)?.close === close)
        this.hatchWebSockets.delete(socketId);
      server.close(code, reason);
      upstream.close(code, reason);
    };
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket idle enforcement cannot be driven by Effect Clock callbacks
      idleTimer = setTimeout(
        () => close(1008, "Hatch WebSocket idle limit"),
        HATCH_WEBSOCKET_IDLE_MILLIS,
      );
    };
    const forward = (event: MessageEvent, destination: WebSocket): void => {
      messageTail = messageTail.then(async () => {
        if (closed) return;
        const message = await normalizeHatchWebSocketMessage(event.data);
        if (message === undefined || message.bytes > HATCH_MAX_WEBSOCKET_MESSAGE_BYTES) {
          close(1009, "Hatch WebSocket message limit");
          return;
        }
        messageCount += 1;
        aggregateBytes += message.bytes;
        if (
          messageCount > HATCH_MAX_WEBSOCKET_MESSAGES ||
          aggregateBytes > HATCH_MAX_WEBSOCKET_AGGREGATE_BYTES
        ) {
          close(1008, "Hatch WebSocket traffic limit");
          return;
        }
        resetIdle();
        destination.send(message.data);
      });
      void messageTail.then(
        () => undefined,
        () => close(1011, "Hatch WebSocket forwarding failed"),
      );
    };
    upstream.accept();
    server.accept();
    server.addEventListener("message", (event) => forward(event, upstream));
    upstream.addEventListener("message", (event) => forward(event, server));
    server.addEventListener("close", (event) => {
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      close(code, event.reason);
    });
    upstream.addEventListener("close", (event) => {
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      close(code, event.reason);
    });
    server.addEventListener("error", () => close(1011, "Hatch client socket error"));
    upstream.addEventListener("error", () => close(1011, "Hatch service socket error"));
    const absoluteExpiresAt = Math.min(
      Date.parse(authorization.expiresAt),
      nowMillis + HATCH_WEBSOCKET_ABSOLUTE_MILLIS,
    );
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket idle enforcement cannot be driven by Effect Clock callbacks
    idleTimer = setTimeout(
      () => close(1008, "Hatch WebSocket idle limit"),
      HATCH_WEBSOCKET_IDLE_MILLIS,
    );
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket authority uses the fixed persisted permit deadline
    absoluteTimer = setTimeout(
      () => close(1008, "Hatch WebSocket duration limit"),
      Math.max(0, absoluteExpiresAt - nowMillis),
    );
    this.hatchWebSockets.set(socketId, { authorization, close });
    const headers = new Headers(response.headers);
    headers.set(HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER, socketId);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private readonly hatchForwardingRoute = (
    request: Request,
  ): (HatchHostRouteV1 & { readonly requestId: string }) | undefined => {
    const requestId = request.headers.get(HATCH_PRIVATE_REQUEST_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      requestId === null ||
      Option.isNone(decodeHatchRequestId(requestId)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      routeNonce === null
    )
      return undefined;
    const decoded = decodeHatchHostRoute({ sessionId, port: Number(portValue), routeNonce });
    return Option.isSome(decoded) ? { ...decoded.value, requestId } : undefined;
  };

  private async hatchResponseStream(
    requestId: string,
    response: Response,
    abortController: AbortController,
    timeout: ReturnType<typeof setTimeout>,
  ): Promise<Response> {
    const settle = async (responseBytes: number): Promise<void> => {
      this.hatchRequests.delete(requestId);
      await this.#run(
        Effect.flatMap(HatchStore, (store) => store.settleRequest(requestId, responseBytes)).pipe(
          Effect.ignore,
        ),
      );
    };
    if (response.body === null) {
      clearTimeout(timeout);
      await settle(0);
      const headers = new Headers(response.headers);
      headers.set(HATCH_PRIVATE_CLAIMED_HEADER, requestId);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const reader = response.body.getReader();
    let bytes = 0;
    let terminal = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = async (): Promise<void> => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      abortController.signal.removeEventListener("abort", abortStream);
      await settle(bytes);
    };
    const abortStream = (): void => {
      if (terminal) return;
      void finish().then(() =>
        reader.cancel().then(
          () => streamController?.error(new DOMException("Hatch request expired", "TimeoutError")),
          () => streamController?.error(new DOMException("Hatch request expired", "TimeoutError")),
        ),
      );
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        const next = await reader.read().then(
          (value) => ({ ok: true as const, value }),
          (cause) => ({ ok: false as const, cause }),
        );
        if (terminal) return;
        if (!next.ok) {
          await finish();
          controller.error(next.cause);
          return;
        }
        if (next.value.done) {
          await finish();
          controller.close();
          return;
        }
        const nextBytes = bytes + next.value.value.byteLength;
        if (nextBytes > HATCH_RESERVED_RESPONSE_BYTES) {
          await reader.cancel();
          bytes = HATCH_RESERVED_RESPONSE_BYTES;
          await finish();
          controller.error(
            new DOMException("Hatch response exceeded its limit", "QuotaExceededError"),
          );
          return;
        }
        bytes = nextBytes;
        controller.enqueue(next.value.value);
      },
      async cancel(reason) {
        abortController.signal.removeEventListener("abort", abortStream);
        abortController.abort();
        await reader.cancel(reason).then(
          () => undefined,
          () => undefined,
        );
        await finish();
      },
    });
    abortController.signal.addEventListener("abort", abortStream, { once: true });
    if (abortController.signal.aborted) abortStream();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set(HATCH_PRIVATE_CLAIMED_HEADER, requestId);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async fetchHatchWebSocket(request: Request): Promise<Response> {
    const route = this.hatchWebSocketForwardingRoute(request);
    if (
      route === undefined ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers
        .get("connection")
        ?.split(",")
        .some((token) => token.trim().toLowerCase() === "upgrade") !== true
    )
      return deniedEvidencePreviewResponse();
    const pending = this.hatchWebSocketAdmissions.get(route.socketId);
    this.hatchWebSocketAdmissions.delete(route.socketId);
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket upgrade admission has a fixed host deadline
    const nowMillis = Date.now();
    if (
      pending === undefined ||
      pending.expiresAtMillis <= nowMillis ||
      pending.authorization.sessionId !== route.sessionId ||
      pending.authorization.port !== route.port ||
      pending.authorization.routeNonce !== route.routeNonce
    )
      return deniedEvidencePreviewResponse();
    const routeValue = {
      sessionId: route.sessionId,
      port: route.port,
      routeNonce: route.routeNonce,
    } satisfies HatchHostRouteV1;
    const current = await this.getScottyHatchRoute(routeValue);
    if (
      current === undefined ||
      current.hatchId !== pending.authorization.hatchId ||
      current.generation !== pending.authorization.generation ||
      current.runtimeEpoch !== pending.authorization.runtimeEpoch
    )
      return deniedEvidencePreviewResponse();
    const headers = new Headers(request.headers);
    headers.delete(HATCH_PRIVATE_WEBSOCKET_HEADER);
    const response = await this.hatchRequestForwarder(new Request(request, { headers })).then(
      (value) => value,
      () => undefined,
    );
    if (response === undefined) return deniedEvidencePreviewResponse();
    const after = await this.getScottyHatchRoute(routeValue);
    if (
      after === undefined ||
      after.hatchId !== pending.authorization.hatchId ||
      after.generation !== pending.authorization.generation ||
      after.runtimeEpoch !== pending.authorization.runtimeEpoch
    ) {
      response.webSocket?.close(1008, "Stale Hatch WebSocket upgrade");
      await response.body?.cancel();
      return deniedEvidencePreviewResponse();
    }
    const bridged = this.bridgeHatchWebSocket(
      route.socketId,
      response,
      pending.authorization,
      nowMillis,
    );
    if (bridged !== undefined) return bridged;
    await response.body?.cancel();
    return deniedEvidencePreviewResponse();
  }

  private async fetchHatchRequest(request: Request): Promise<Response> {
    const route = this.hatchForwardingRoute(request);
    if (route === undefined || request.method === "CONNECT" || request.method === "TRACE")
      return deniedEvidencePreviewResponse();
    const runtimeEpoch = await this.#run(Effect.result(this.currentRuntimeEpochProgram()));
    if (Result.isFailure(runtimeEpoch)) return deniedEvidencePreviewResponse();
    const claimed = await this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.claimRequest({ ...route, runtimeEpoch: runtimeEpoch.success }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
    if (claimed === undefined) return deniedEvidencePreviewResponse();
    const abortController = new AbortController();
    this.hatchRequests.set(route.requestId, abortController);
    const headers = new Headers(request.headers);
    headers.delete(HATCH_PRIVATE_REQUEST_HEADER);
    const forwarded = new Request(request, { headers, signal: abortController.signal });
    const remainingMillis = Math.max(
      0,
      Date.parse(claimed.expiresAt) - (await this.#run(Clock.currentTimeMillis)),
    );
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Sandbox fetch streaming is fenced by the persisted Hatch request deadline
    const timeout = setTimeout(() => abortController.abort(), remainingMillis);
    const result = await Promise.race([
      this.hatchRequestForwarder(forwarded).then(
        (response) => ({ kind: "response" as const, response }),
        () => ({ kind: "error" as const }),
      ),
      new Promise<{ readonly kind: "aborted" }>((resolve) =>
        abortController.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
          once: true,
        }),
      ),
    ]);
    if (result.kind !== "response" || abortController.signal.aborted) {
      clearTimeout(timeout);
      await this.cancelScottyHatchRequest(route.requestId);
      if (result.kind === "response") await result.response.body?.cancel();
      return deniedEvidencePreviewResponse();
    }
    if (result.response.webSocket !== null && result.response.webSocket !== undefined) {
      clearTimeout(timeout);
      result.response.webSocket.close(1008, "Hatch WebSockets are disabled");
      await this.cancelScottyHatchRequest(route.requestId);
      return deniedEvidencePreviewResponse();
    }
    return this.hatchResponseStream(route.requestId, result.response, abortController, timeout);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.has(HATCH_PRIVATE_WEBSOCKET_HEADER))
      return this.fetchHatchWebSocket(request);
    if (request.headers.has(HATCH_PRIVATE_REQUEST_HEADER)) return this.fetchHatchRequest(request);
    if (
      request.headers.has(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER) ||
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) === "1"
    )
      return this.fetchEvidencePreviewRequest(request);
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname.startsWith(`${PI_CONSOLE_PROXY_PREFIX}/`)) {
      const action = incomingUrl.pathname.slice(PI_CONSOLE_PROXY_PREFIX.length + 1);
      const expectedMethod =
        action === "snapshot" || action === "events"
          ? "GET"
          : action === "command"
            ? "POST"
            : undefined;
      if (expectedMethod === undefined)
        return Response.json({ error: "not_found" }, { status: 404 });
      if (request.method !== expectedMethod)
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      return this.fetchPassivePiConsole(request, action);
    }
    return super.fetch(request);
  }

  async snapshotScottySession(): Promise<SessionView> {
    return this.#run(this.snapshotScottySessionProgram());
  }

  async sleepScottySession(): Promise<SessionView> {
    return this.#run(this.sleepScottySessionProgram());
  }

  async resumeScottySession(): Promise<SessionView> {
    return this.#run(this.resumeScottySessionProgram());
  }

  async prepareDownArchive(): Promise<DownArchive> {
    return this.#run(this.prepareDownArchiveProgram());
  }

  async readScottyArchiveStream(path: string) {
    await this.assertRuntimeAccess();
    return decodeSandboxFileStream(await this.readFileStream(path));
  }

  async vaporizeScottySession(): Promise<{ id: string; status: "gone" }> {
    return this.#run(this.vaporizeScottySessionProgram());
  }

  async retryVaporizeSession(payload: VaporizeRetryPayload): Promise<void> {
    return this.#run(this.retryVaporizeSessionProgram(payload));
  }

  async renameScottySession(title: string): Promise<SessionView> {
    return this.#run(this.renameScottySessionProgram(title));
  }

  async readCredentialForProxy(sentinel: string): Promise<StoredCredential | null> {
    return this.#run(Effect.flatMap(CredentialVault, (vault) => vault.readForProxy(sentinel)));
  }

  async beginCredentialRefresh(sentinel: string): Promise<CredentialRefreshLease | null> {
    return this.#run(
      Effect.flatMap(CredentialVault, (vault) => vault.beginRefresh(sentinel, crypto.randomUUID())),
    );
  }

  async persistRotatedCredential(
    sentinel: string,
    patch: CredentialPatch,
    nonce: string,
  ): Promise<void> {
    await this.#run(
      Effect.flatMap(CredentialVault, (vault) => vault.persistRotation(sentinel, patch, nonce)),
    );
  }

  async cancelCredentialRefresh(sentinel: string, nonce: string): Promise<void> {
    await this.#run(
      Effect.flatMap(CredentialVault, (vault) => vault.cancelRefresh(sentinel, nonce)),
    );
  }

  async enforceHardCap(payload: HardCapPayload): Promise<void> {
    return this.#run(this.enforceHardCapProgram(payload));
  }

  override async onActivityExpired(): Promise<void> {
    return this.#run(this.onActivityExpiredProgram());
  }

  override async onStart(): Promise<void> {
    const runtimeEpochEnabled = this.evidenceEnabled || this.previewBase !== undefined;
    if (!runtimeEpochEnabled) return super.onStart();
    if (this.evidenceEnabled) {
      const staleEvidence = await this.#run(
        Effect.result(this.interruptEvidenceForRuntimeStopProgram()),
      );
      if (Result.isFailure(staleEvidence)) return this.#run(Effect.fail(staleEvidence.failure));
    }
    if (this.previewBase !== undefined) {
      const beforeStart = await this.#run(this.readRecordProgram());
      const managedRestore =
        beforeStart !== undefined &&
        (beforeStart.status === "sleeping" ||
          beforeStart.operation?.kind === "snapshot" ||
          beforeStart.operation?.kind === "resume");
      const target = managedRestore ? "sleeping" : "failed";
      const hatchNonce = `start-${randomToken(8)}`;
      const staleHatch = await this.#run(
        Effect.result(this.cleanupHatchProgram(hatchNonce, target, false, "runtime_start")),
      );
      if (Result.isFailure(staleHatch)) {
        await this.schedule(5, "retryHatchCleanup", {
          operationNonce: hatchNonce,
          target,
          closeDesired: false,
        } satisfies HatchCleanupRetryV1).then(
          () => undefined,
          () => undefined,
        );
        await this.#run(Effect.result(this.deleteRuntimeEpochProgram()));
        return this.#run(Effect.fail(staleHatch.failure));
      }
    }
    await super.onStart();
    const runtimeEpoch = randomToken(16);
    const stored = await this.#run(Effect.result(this.putRuntimeEpochProgram(runtimeEpoch)));
    if (Result.isFailure(stored)) {
      await this.#run(Effect.result(this.deleteRuntimeEpochProgram()));
      return this.#run(Effect.fail(stored.failure));
    }
  }

  override async onStop(): Promise<void> {
    const runtimeEpochEnabled = this.evidenceEnabled || this.previewBase !== undefined;
    const beforeStop = await this.#run(this.readRecordProgram());
    const managedStop = beforeStop !== undefined && hasCommittedManagedStop(beforeStop);
    const hatchNonce = `stop-${randomToken(8)}`;
    const hatchCleanup = await this.#run(
      Effect.result(
        this.cleanupHatchProgram(
          hatchNonce,
          managedStop ? "sleeping" : "failed",
          false,
          "runtime_stop",
        ),
      ),
    );
    if (Result.isFailure(hatchCleanup)) {
      console.error("Hatch runtime-stop cleanup remains pending", {
        error: errorName(hatchCleanup.failure),
      });
      await this.schedule(5, "retryHatchCleanup", {
        operationNonce: hatchNonce,
        target: managedStop ? "sleeping" : "failed",
        closeDesired: false,
      } satisfies HatchCleanupRetryV1).then(
        () => undefined,
        () => undefined,
      );
    }
    const evidenceCleanup = this.evidenceEnabled
      ? await this.#run(Effect.result(this.interruptEvidenceForRuntimeStopProgram()))
      : Result.succeed(undefined);
    if (Result.isFailure(evidenceCleanup))
      console.error("Evidence runtime-stop cleanup remains pending", {
        error: errorName(evidenceCleanup.failure),
      });
    const deletedEpoch = runtimeEpochEnabled
      ? await this.#run(Effect.result(this.deleteRuntimeEpochProgram()))
      : Result.succeed(undefined);
    if (Result.isFailure(deletedEpoch))
      console.error("Runtime epoch cleanup failed", { error: errorName(deletedEpoch.failure) });
    await super.onStop();
    await this.#run(this.onStopProgram());
    if (Result.isFailure(hatchCleanup)) return this.#run(Effect.fail(hatchCleanup.failure));
    if (Result.isFailure(evidenceCleanup)) return this.#run(Effect.fail(evidenceCleanup.failure));
    if (Result.isFailure(deletedEpoch)) return this.#run(Effect.fail(deletedEpoch.failure));
  }

  async finalizeManagedStop(payload: ManagedStopPayload): Promise<void> {
    return this.#run(this.finalizeManagedStopProgram(payload));
  }

  private readonly checkpointProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    resumeRuntime: boolean,
    releaseLease = resumeRuntime,
  ) {
    const record = yield* this.requireRecordProgram();
    const hatchCleanup = yield* Effect.result(
      this.cleanupHatchProgram(nonce, "sleeping", false, "operation"),
    );
    if (Result.isFailure(hatchCleanup)) {
      yield* hostEffect("schedule", () =>
        this.schedule(5, "retryHatchCleanup", {
          operationNonce: nonce,
          target: "sleeping",
          closeDesired: false,
        } satisfies HatchCleanupRetryV1),
      );
      return yield* hatchCleanup.failure;
    }
    const runtime = yield* SandboxRuntime;
    const backups = yield* BackupStore;
    const vault = yield* CredentialVault;
    const containerAuth = yield* ContainerAuth;
    const root = sessionRoot(record.id);
    let runtimeStopAttempted = false;

    const checkpoint = withCheckpointRuntimeRestore(
      Effect.gen({ self: this }, function* () {
        runtimeStopAttempted = true;
        const piProcess = yield* runtime.getProcess(PI_SESSION_PROCESS_ID);
        if (
          piProcess !== null &&
          piProcess.status !== "completed" &&
          piProcess.status !== "failed" &&
          piProcess.status !== "killed" &&
          piProcess.status !== "error"
        ) {
          const credential = yield* vault.require;
          yield* containerAuth
            .quiescePiSession(record.id, credential)
            .pipe(
              Effect.mapError((cause) => new PiRuntimeStopFailure({ stage: "quiesce", cause })),
            );
        }
        yield* containerAuth
          .stopPiSession()
          .pipe(Effect.mapError((cause) => new PiRuntimeStopFailure({ stage: "process", cause })));
        yield* runtime.execChecked("sync", { timeout: 30_000 });
        const now = yield* Clock.currentTimeMillis;
        const backup = yield* backups.create({
          dir: root,
          name: `scotty-${record.id}-${now}`,
          ttl: BACKUP_TTL_SECONDS,
          localBucket: true,
          compression: { format: "zstd" },
        });
        const priorPrevious = record.backup?.previous;
        const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const backupExpiresAt = new Date(
          (yield* Clock.currentTimeMillis) + BACKUP_TTL_SECONDS * 1_000,
        ).toISOString();
        const updated = yield* this.updateForOperationProgram(nonce, (current) => ({
          ...current,
          operation: current.operation && {
            ...current.operation,
            checkpointedBackupId: backup.id,
          },
          backup: { current: backup, previous: current.backup?.current },
          ownedBackupIds: [...new Set([...current.ownedBackupIds, backup.id])],
          backupExpiresAt,
          failure: undefined,
          updatedAt,
        }));
        if (priorPrevious) yield* backups.delete(priorPrevious.id).pipe(Effect.ignore);
        return updated;
      }),
      {
        restore: Effect.gen({ self: this }, function* () {
          const credential = yield* vault.require;
          yield* this.restorePiAndHatchProgram(
            nonce,
            containerAuth.ensurePiSession(record.id, credential),
          );
        }),
        resumeRuntime,
        stopAttempted: () => runtimeStopAttempted,
      },
    );
    const outcome = yield* Effect.result(checkpoint);

    if (
      Result.isFailure(outcome) &&
      Predicate.isTagged(outcome.failure, "CheckpointRuntimeUnavailable")
    ) {
      yield* Effect.gen({ self: this }, function* () {
        const current = yield* this.requireRecordProgram();
        if (current.operation?.nonce !== nonce) return;
        yield* this.failOperationProgram(
          nonce,
          "checkpoint_runtime_unavailable",
          "Pi session failed to recover after checkpoint",
          Boolean(current.backup?.current),
        );
      }).pipe(Effect.ignore);
      return yield* Effect.fail(outcome.failure);
    }
    const updated = yield* Result.match(outcome, {
      onFailure: Effect.fail,
      onSuccess: Effect.succeed,
    });
    return releaseLease ? yield* this.releaseOperationProgram(nonce) : updated;
  });

  private readonly stopAfterCheckpointProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
  ) {
    const armedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const payload = { nonce, armedAt } satisfies ManagedStopPayload;
    yield* hostEffect("schedule", () =>
      this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
    );

    const beforeStop = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.requireRecordProgram();
        if (current.operation?.stopRollbackAt)
          return yield* conflict("Managed stop rollback started");
        const stopRequestedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* this.updateForOperationProgram(nonce, (record) => ({
          ...record,
          operation: record.operation && {
            ...record.operation,
            stopRequestedAt,
          },
          updatedAt: stopRequestedAt,
        }));
        yield* hostEffect("stop", () => this.stop());
      }),
    );
    if (Result.isFailure(beforeStop)) {
      const current = yield* this.requireRecordProgram();
      if (current.status === "sleeping") return current;
      return yield* new ManagedStopArmedError({ cause: beforeStop.failure });
    }

    const observeStopped = Effect.gen({ self: this }, function* () {
      const stopped = yield* this.requireRecordProgram();
      if (stopped.status === "sleeping") return stopped;
      if (stopped.status === "failed") return yield* wrongState(stopped.status, "stop");
      const stoppedAgain = yield* hostEffect("stop", () => this.stop()).pipe(
        Effect.mapError((cause) => new ManagedStopArmedError({ cause })),
      );
      void stoppedAgain;
      return yield* new SessionShutdownPending();
    });

    return yield* observeStopped.pipe(
      Effect.retry({ times: 19, schedule: Schedule.spaced("250 millis") }),
      Effect.catchTag(
        "SessionShutdownPending",
        () =>
          new ScottyError("upstream", "Session shutdown is still completing", {
            httpStatus: 502,
            exitCode: 4,
          }),
      ),
    );
  });

  private readonly snapshotScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const authoritative = yield* this.requireRecordProgram();
    if (authoritative.execution.provider === "runner")
      return yield* wrongState(
        authoritative.status,
        "snapshot",
        "Runner lifecycle is not supported yet",
      );
    const operation = yield* this.acquireOperationProgram("snapshot", ["warm"]);
    const result = yield* Effect.result(this.checkpointProgram(operation.nonce, true));
    if (Result.isFailure(result)) {
      if (!Predicate.isTagged(result.failure, "CheckpointRuntimeUnavailable"))
        yield* this.releaseOperationProgram(operation.nonce);
      return yield* this.upstreamError("Snapshot failed", result.failure);
    }
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(result.success, new Date(now)), now);
  });

  private readonly sleepScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const authoritative = yield* this.requireRecordProgram();
    if (authoritative.execution.provider === "runner") {
      const operation =
        authoritative.operation?.kind === "snapshot"
          ? authoritative.operation
          : yield* this.acquireOperationProgram("snapshot", ["warm"]);
      const sleeping = yield* this.stopRunnerIntoSleepingProgram(
        authoritative,
        operation.nonce,
        `sleep-${operation.nonce}`,
        false,
      );
      const now = yield* Clock.currentTimeMillis;
      return toSessionView(toProjection(sleeping, new Date(now)), now);
    }
    const operation = yield* this.acquireOperationProgram("snapshot", ["warm"]);
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.checkpointProgram(operation.nonce, false, false);
        return yield* this.stopAfterCheckpointProgram(operation.nonce);
      }),
    );
    if (Result.isFailure(result)) {
      if (Predicate.isTagged(result.failure, "CheckpointRuntimeUnavailable"))
        return yield* this.upstreamError("Session stop failed", result.failure);
      const pending = yield* this.isManagedStopPendingProgram(operation.nonce);
      if (!Predicate.isTagged(result.failure, "ManagedStopArmedError") && !pending)
        yield* this.releaseOperationIfHeldProgram(operation.nonce);
      return yield* this.upstreamError("Session stop failed", result.failure);
    }
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(result.success, new Date(now)), now);
  });

  private async scheduleHardCap(hardCapAt: string): Promise<void> {
    this.deleteSchedules("enforceHardCap");
    await this.schedule(new Date(hardCapAt), "enforceHardCap", {
      hardCapAt,
    } satisfies HardCapPayload);
  }

  private cancelVaporizeConflictingSchedules(): void {
    for (const callback of VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS) {
      this.deleteSchedules(callback);
    }
  }

  private cancelAllSessionSchedules(): void {
    for (const callback of SESSION_SCHEDULE_CALLBACKS) {
      this.deleteSchedules(callback);
    }
  }

  async retryHardCapDestroy(sessionId: string): Promise<void> {
    return this.#run(this.retryHardCapDestroyProgram(sessionId));
  }

  private async requireRecord(): Promise<SessionRecord> {
    return this.#run(Effect.flatMap(SessionStore, (store) => store.requireRecord));
  }

  private async assertRuntimeAccess(): Promise<SessionRecord> {
    return this.#run(this.assertRuntimeAccessProgram());
  }

  async #run<A, E>(operation: Effect.Effect<A, E, SandboxServices>): Promise<A> {
    const provided =
      this.clock === undefined
        ? operation.pipe(Effect.provide(this.layer))
        : operation.pipe(
            Effect.provide(this.layer),
            Effect.provideService(Clock.Clock, this.clock),
          );
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Sandbox Durable Object methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(provided.pipe(Effect.result));
    return Result.match(result, {
      onFailure: (error) => {
        // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Effect failure must reject the Promise required by the Sandbox Durable Object host
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private upstreamError(message: string, error: unknown, sessionId?: string): ScottyError {
    const stateError = decodeEvidenceStateError(error);
    console.error(message, {
      sessionId,
      error: errorName(error),
      ...(Option.isSome(stateError) ? { evidenceStateReason: stateError.value.reason } : {}),
      stage: piRuntimeStopStage(error),
      cause: nestedSandboxRuntimeFailure(error),
    });
    return new ScottyError("upstream", message, {
      httpStatus: 502,
      exitCode: 1,
      hint: "Inspect Worker observability for the redacted upstream failure",
    });
  }
}

Sandbox.outboundByHost = makeOutboundByHost(fetch);
Sandbox.outbound = denyOutbound;

function isHatchStateError(error: unknown): error is HatchStateError {
  return Predicate.isTagged("HatchStateError")(error);
}

function piRuntimeStopStage(error: unknown): string | undefined {
  if (!Predicate.isTagged("PiRuntimeStopFailure")(error)) return undefined;
  const stage = Reflect.get(error, "stage");
  return typeof stage === "string" ? stage : undefined;
}

function nestedSandboxRuntimeFailure(
  error: unknown,
): { readonly reason: string; readonly message: string } | undefined {
  if (!Predicate.isTagged("PiRuntimeStopFailure")(error)) return undefined;
  const cause = Reflect.get(error, "cause");
  if (!Predicate.isTagged("SandboxRuntimeFailure")(cause)) return undefined;
  const reason = Reflect.get(cause, "reason");
  const message = Reflect.get(cause, "message");
  return typeof reason === "string" && typeof message === "string"
    ? { reason, message }
    : undefined;
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
