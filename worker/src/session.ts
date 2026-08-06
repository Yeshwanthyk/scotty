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
} from "effect";
import { BackupStore, backupStoreLayer } from "./backup-store";
import type { Bindings } from "./bindings";
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
  conflict,
  decodeContainerSessionRequest,
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
} from "./session-store";
import {
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsRuntimeAccess,
  VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS,
} from "./session-lifecycle";
import { errorName, SandboxRuntime, sandboxRuntimeLayer, shellQuote } from "./sandbox-runtime";
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
  | BackupStore
  | ContainerAuth
  | CredentialVault
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

export interface PassivePiConsoleRelay {
  readonly fetch: (input: {
    readonly sessionId: SessionRecord["id"];
    readonly request: Request;
  }) => Promise<Response>;
}

export interface SandboxEffectOptions {
  readonly clock?: Clock.Clock;
  readonly passivePiConsoleRelay?: PassivePiConsoleRelay;
}

class ManagedStopArmedError extends Data.TaggedError("ManagedStopArmedError")<{
  readonly cause: unknown;
}> {}

class SessionShutdownPending extends Data.TaggedError("SessionShutdownPending")<{}> {}

class SessionCreateUncertain extends Data.TaggedError("SessionCreateUncertain")<{
  readonly cause: unknown;
}> {}

class PiRuntimeStopFailure extends Data.TaggedError("PiRuntimeStopFailure")<{
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

type HostOperation = "destroy" | "schedule" | "stop";

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

const hostEffect = <A>(
  operation: HostOperation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, HostOperationFailure> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new HostOperationFailure({ operation, cause }),
  });

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

export class Sandbox extends BaseSandbox<Bindings> {
  override sleepAfter = "60m";
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [...ALLOWED_HOSTS];
  private readonly layer: Layer.Layer<SandboxServices>;
  private readonly clock: Clock.Clock | undefined;
  private readonly passivePiConsoleRelay: PassivePiConsoleRelay;
  private readonly rawContainer: DurableObjectState["container"];
  private readonly sessionControlGate: SessionControlGate;
  // This only coalesces work inside one live DO instance. Durable createPhase remains authoritative
  // after eviction or a crash.
  private createInFlight: InFlightCreate | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Bindings, options: SandboxEffectOptions = {}) {
    super(ctx, env);
    this.clock = options.clock;
    this.rawContainer = ctx.container;
    this.passivePiConsoleRelay = options.passivePiConsoleRelay ?? {
      fetch: (input) => this.fetchNativePassivePiConsole(input),
    };
    this.sessionControlGate = makeSessionControlGate();

    const store = sessionStoreLayer(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning SessionStore adapter
      durableObjectSessionRecordStorage(ctx.storage, this.sessionControlGate),
    );
    const runtimeAccess = this.assertRuntimeAccessProgram().pipe(
      Effect.asVoid,
      Effect.provide(store),
    );
    const runtime = sandboxRuntimeLayer(
      {
        exec: (command, execOptions) => this.exec(command, execOptions),
        mkdir: (path, mkdirOptions) => this.mkdir(path, mkdirOptions),
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

    this.layer = Layer.mergeAll(
      store,
      sessionProjectionLayer(kvSessionProjectionStorage(env.SESSIONS)),
      backup,
      runtimeAndVault,
      rolloutDiscoveryLayer.pipe(Layer.provide(runtime)),
      workspaceLayer.pipe(Layer.provide(runtime)),
      containerAuthLayer.pipe(Layer.provide(runtime)),
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
        yield* containerAuth.ensurePiSession(record.id, credential);
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
    const destroyed =
      current.execution.provider === "runner"
        ? yield* this.removeRunnerRuntimeProgram(current, `vaporize-${payload.nonce}`).pipe(
            Effect.as(true),
          )
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

    for (const backupId of new Set(current.ownedBackupIds)) yield* backups.delete(backupId);
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
    const existing = yield* this.readRecordProgram();
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
    if (record.execution.provider === "cloudflare") {
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
  ) {
    const record = yield* this.readRecordProgram();
    if (record?.execution.provider === "runner") {
      yield* this.removeRunnerRuntimeProgram(record, `failed-cleanup-${sessionId}`);
      return;
    }
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
      yield* Effect.sync(() =>
        console.error("Vaporize reconciliation failed", {
          sessionId: payload.id,
          error: errorName(continued.failure),
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

  override async fetch(request: Request): Promise<Response> {
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

  override async onStop(): Promise<void> {
    await super.onStop();
    return this.#run(this.onStopProgram());
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
            .pipe(Effect.mapError((cause) => new PiRuntimeStopFailure({ cause })));
        }
        yield* containerAuth
          .stopPiSession()
          .pipe(Effect.mapError((cause) => new PiRuntimeStopFailure({ cause })));
        yield* Effect.tryPromise({
          try: () => this.deleteSession(record.id),
          catch: (cause) => new PiRuntimeStopFailure({ cause }),
        });
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
        restore: Effect.gen(function* () {
          const credential = yield* vault.require;
          yield* containerAuth.ensurePiSession(record.id, credential);
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
    console.error(message, { sessionId, error: errorName(error) });
    return new ScottyError("upstream", message, {
      httpStatus: 502,
      exitCode: 1,
      hint: "Inspect Worker observability for the redacted upstream failure",
    });
  }
}

Sandbox.outboundByHost = makeOutboundByHost(fetch);
Sandbox.outbound = denyOutbound;

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
