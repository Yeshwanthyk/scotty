import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { Clock, Data, Effect, Layer, Option, Predicate, Result, Schedule } from "effect";
import { Agent, agentLayer } from "./agent";
import { pauseAgentCommand, resumeAgentCommand } from "./agent-runtime";
import { BackupStore, backupStoreLayer } from "./backup-store";
import type { Bindings } from "./bindings";
import { agentEnv, ContainerAuth, containerAuthLayer } from "./container-auth";
import {
  CredentialVault,
  credentialVaultLayer,
  durableObjectCredentialVaultStorage,
} from "./credential-vault";
import {
  conflict,
  isRecord,
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
  type TerminalAttachmentLease,
} from "./contracts";
import type { CreateIdempotencyMetadata } from "./create-idempotency";
import {
  ALLOWED_HOSTS,
  CODEX_SENTINEL_PREFIX,
  GITHUB_SENTINEL_PREFIX,
  denyOutbound,
  makeOutboundByHost,
  type CredentialPatch,
  type CredentialRefreshLease,
  type StoredCredential,
} from "./egress";
import {
  durableObjectSessionRecordStorage,
  SessionStore,
  sessionStoreLayer,
} from "./session-store";
import {
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsTerminalAttachment,
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
import {
  durableObjectTerminalAttachmentStorage,
  TerminalAttachments,
  TERMINAL_ATTACHMENT_TTL_MS,
  terminalAttachmentCleanupBestEffort,
  terminalAttachmentsLayer,
  type TerminalAttachmentReleaseCondition,
} from "./terminal-attachments";
import { sessionRoot, Workspace, workspaceLayer } from "./workspace";

const TERMINAL_ATTACHMENT_RETRY_SECONDS = 2;
const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const HARD_CAP_GRACE_MS = 30_000;
const ABANDONED_OPERATION_MS = 5 * 60_000;
const MANAGED_STOP_RETRY_SECONDS = 2;
const DESTROY_DEADLINE_MS = 30_000;
const DESTROY_RETRY_SECONDS = 35;

type SandboxServices =
  | Agent
  | BackupStore
  | ContainerAuth
  | CredentialVault
  | RolloutDiscovery
  | SandboxRuntime
  | SessionProjection
  | SessionStore
  | TerminalAttachments
  | Workspace;

interface HardCapPayload {
  hardCapAt: string;
}

interface ManagedStopPayload {
  nonce: string;
  armedAt: string;
}

interface TerminalAttachmentPayload {
  sessionId: string;
  condition?:
    | { kind: "always" }
    | { kind: "observedAt"; value: string }
    | { kind: "staleBefore"; value: string };
}

interface TerminalAttachmentExpiryPayload {
  sessionId: string;
  observedAt: string;
}

interface VaporizeRetryPayload {
  id: string;
  nonce: string;
}

export interface SandboxEffectOptions {
  readonly clock?: Clock.Clock;
}

class ManagedStopArmedError extends Data.TaggedError("ManagedStopArmedError")<{
  readonly cause: unknown;
}> {}

class SessionShutdownPending extends Data.TaggedError("SessionShutdownPending")<{}> {}

const hostEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => cause,
  });

export class Sandbox extends BaseSandbox<Bindings> {
  override sleepAfter = "60m";
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [...ALLOWED_HOSTS];
  private readonly layer: Layer.Layer<SandboxServices>;
  private readonly clock: Clock.Clock | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Bindings, options: SandboxEffectOptions = {}) {
    super(ctx, env);
    this.clock = options.clock;

    const runtime = sandboxRuntimeLayer({
      exec: async (command, options) => {
        await this.assertRuntimeAccess();
        return this.exec(command, options);
      },
      createSession: async (options) => {
        await this.assertRuntimeAccess();
        return this.createSession(options);
      },
      deleteSession: async (sessionId) => {
        await this.assertRuntimeAccess();
        return this.deleteSession(sessionId);
      },
      mkdir: async (path, options) => {
        await this.assertRuntimeAccess();
        return this.mkdir(path, options);
      },
      writeFile: async (path, content) => {
        await this.assertRuntimeAccess();
        return this.writeFile(path, content);
      },
      setEnvVars: async (envVars) => {
        await this.assertRuntimeAccess();
        return this.setEnvVars(envVars);
      },
    });
    const vault = credentialVaultLayer(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning CredentialVault adapter
      durableObjectCredentialVaultStorage(ctx.storage),
      env.GH_TOKEN,
    );
    const agentDependencies = Layer.merge(runtime, vault);
    const backup = backupStoreLayer({
      createBackup: async (options) => {
        await this.assertRuntimeAccess();
        return this.createBackup(options);
      },
      restoreBackup: async (backup) => {
        await this.assertRuntimeAccess();
        return this.restoreBackup(backup);
      },
      listObjects: (prefix, cursor) =>
        env.BACKUP_BUCKET.list({ prefix, cursor }).then((page) => ({
          keys: page.objects.map((object) => object.key),
          cursor: page.truncated ? page.cursor : undefined,
        })),
      deleteObjects: (keys) => env.BACKUP_BUCKET.delete([...keys]),
    });

    this.layer = Layer.mergeAll(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning SessionStore adapter
      sessionStoreLayer(durableObjectSessionRecordStorage(ctx.storage)),
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning TerminalAttachments adapter
      terminalAttachmentsLayer(durableObjectTerminalAttachmentStorage(ctx.storage)),
      sessionProjectionLayer(kvSessionProjectionStorage(env.SESSIONS)),
      backup,
      agentDependencies,
      rolloutDiscoveryLayer.pipe(Layer.provide(runtime)),
      workspaceLayer.pipe(Layer.provide(runtime)),
      containerAuthLayer.pipe(Layer.provide(runtime)),
      agentLayer(env.SCOTTY_FAKE_AGENT === "1").pipe(Layer.provide(agentDependencies)),
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

  private readonly terminalAttachmentAllowedProgram = Effect.fnUntraced(function* (
    record: SessionRecord | undefined,
  ) {
    if (sessionAllowsTerminalAttachment(record)) return record;
    if (!record) return yield* notFound("unknown");
    if (record.status !== "warm")
      return yield* wrongState(
        record.status,
        "attach",
        record.status === "sleeping" ? "Resume the session before attaching" : undefined,
      );
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    if (record.operation)
      return yield* conflict(`Session is already running ${record.operation.kind}`);
    return yield* conflict("Session is not accepting terminal attachments");
  });

  private readonly assertRuntimeAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.readRecordProgram();
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    return record;
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

  private readonly createScottySessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    input: CreateSessionInput,
    id: string,
    idempotency?: CreateIdempotencyMetadata,
  ) {
    const vault = yield* CredentialVault;
    const workspace = yield* Workspace;
    const containerAuth = yield* ContainerAuth;
    const agent = yield* Agent;
    const store = yield* SessionStore;
    const now = yield* Clock.currentTimeMillis;
    const nowIso = new Date(now).toISOString();
    const nonce = crypto.randomUUID();
    const initial: SessionRecord = {
      version: 1,
      id,
      status: "booting",
      operation: { kind: "create", nonce, startedAt: nowIso },
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
    if (Result.isFailure(inspected)) {
      if (Predicate.isTagged(inspected.failure, "InitialSessionStorageFailure"))
        return yield* Effect.fail(inspected.failure.cause);
      return yield* inspected.failure;
    }
    const decisionBeforeSchedule = inspected.success;
    if (decisionBeforeSchedule.kind === "replay")
      return toSessionView(toProjection(decisionBeforeSchedule.record, new Date(now)), now);

    const hardCapSchedule = yield* Effect.result(
      hostEffect(() =>
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
    if (Result.isFailure(committed)) {
      if (Predicate.isTagged(committed.failure, "InitialSessionStorageFailure"))
        return yield* Effect.fail(committed.failure.cause);
      return yield* committed.failure;
    }
    const decision = committed.success;
    if (decision.kind === "replay") {
      const replayNow = yield* Clock.currentTimeMillis;
      return toSessionView(toProjection(decision.record, new Date(replayNow)), replayNow);
    }
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
      Effect.gen({ self: this }, function* () {
        const credential = yield* vault.seed({
          codexAuthJson: this.env.CODEX_AUTH_JSON,
          codexSentinel: `${CODEX_SENTINEL_PREFIX}${id}-${randomToken(12)}`,
          githubSentinel: `${GITHUB_SENTINEL_PREFIX}${id}-${randomToken(12)}`,
        });
        const worktree = yield* workspace.prepare(initial, credential.githubSentinel);
        yield* containerAuth.seed(initial.id, credential);
        yield* agent.launch(initial.id, { kind: "start", prompt: input.prompt });
        const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const ready = yield* this.updateForOperationProgram(nonce, (record) => ({
          ...record,
          status: "warm",
          operation: null,
          repoExistsAtCreate: worktree.repoExists,
          defaultBranch: worktree.defaultBranch,
          updatedAt,
        }));
        yield* hostEffect(() => this.schedule(5, "captureThreadId"));
        return ready;
      }),
    );
    if (Result.isFailure(setup)) {
      const failed = yield* this.failOperationProgram(
        nonce,
        "create_failed",
        "Session setup failed",
        false,
      );
      yield* this.destroyFailedRuntimeProgram(failed.id);
      return yield* this.upstreamError("Session setup failed", setup.failure, failed.id);
    }
    const completedAt = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(setup.success, new Date(completedAt)), completedAt);
  });

  private readonly getScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(record, new Date(now)), now);
  });

  private readonly resumeScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const backups = yield* BackupStore;
    const vault = yield* CredentialVault;
    const containerAuth = yield* ContainerAuth;
    const agent = yield* Agent;
    const terminalAttachments = yield* TerminalAttachments;
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
        yield* hostEffect(() => this.scheduleHardCap(hardCapAt));
        yield* backups.restore(backup);
        yield* terminalAttachments.clear;
        const credential = yield* vault.require;
        yield* containerAuth.seed(record.id, credential);
        yield* agent.launch(record.id, { kind: "resume", threadId: record.codexThreadId });
        const readyAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const ready = yield* this.updateForOperationProgram(operation.nonce, (current) => ({
          ...current,
          status: "warm",
          operation: null,
          failure: undefined,
          hardCapAt,
          updatedAt: readyAt,
        }));
        yield* hostEffect(() => this.schedule(5, "captureThreadId"));
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
    yield* hostEffect(() => this.schedule(DESTROY_RETRY_SECONDS, "retryVaporizeSession", payload));
  });

  private readonly continueVaporizeSessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: VaporizeRetryPayload,
  ) {
    const backups = yield* BackupStore;
    const vault = yield* CredentialVault;
    const terminalAttachments = yield* TerminalAttachments;
    const current = yield* this.readRecordProgram();
    if (!current) return yield* notFound(payload.id);
    if (current.status === "gone") {
      yield* removeSessionProjection(current.id);
      yield* Effect.sync(() => this.cancelAllSessionSchedules());
      return { id: current.id, status: "gone" as const };
    }
    if (current.operation?.kind !== "vaporize" || current.operation.nonce !== payload.nonce)
      return yield* conflict("Session vaporize lease changed");

    yield* Effect.sync(() => this.cancelVaporizeConflictingSchedules());
    yield* terminalAttachments.clear;
    const destroyed = yield* Effect.raceFirst(
      hostEffect(() => this.destroy()).pipe(Effect.as(true)),
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
    const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const gone = yield* this.updateForOperationProgram(payload.nonce, (record) => ({
      ...record,
      status: "gone",
      operation: null,
      backup: undefined,
      ownedBackupIds: [],
      backupExpiresAt: undefined,
      codexThreadId: undefined,
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
      const repaired = yield* Effect.result(
        Effect.gen({ self: this }, function* () {
          yield* removeSessionProjection(existing.id);
          yield* Effect.sync(() => this.cancelAllSessionSchedules());
          return { id: existing.id, status: "gone" as const };
        }),
      );
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

  private readonly prepareDownArchiveProgram = Effect.fnUntraced(function* (this: Sandbox) {
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
    yield* Effect.sync(() => this.deleteSchedules("retryHardCapDestroy"));
    const destroyed = yield* Effect.result(
      Effect.raceFirst(
        hostEffect(() => this.destroy()).pipe(Effect.as(true)),
        Effect.sleep(DESTROY_DEADLINE_MS).pipe(Effect.as(false)),
      ),
    );
    if (Result.isSuccess(destroyed) && destroyed.success) return;
    yield* hostEffect(() => this.schedule(DESTROY_RETRY_SECONDS, "retryHardCapDestroy", sessionId));
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

  private readonly captureThreadIdProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: { attempt?: number } = {},
  ) {
    const discovery = yield* RolloutDiscovery;
    const store = yield* SessionStore;
    const record = yield* this.readRecordProgram();
    if (!sessionAllowsRuntimeAccess(record) || record.status !== "warm" || record.operation) return;
    const threadIdOption = yield* discovery.discoverThreadId(record.id);
    if (Option.isNone(threadIdOption)) {
      const attempt = payload.attempt ?? 0;
      if (attempt < 11)
        yield* hostEffect(() => this.schedule(5, "captureThreadId", { attempt: attempt + 1 }));
      return;
    }
    const updated = yield* store.captureThreadId(threadIdOption.value);
    if (Option.isSome(updated)) yield* this.projectProgram(updated.value);
  });

  private readonly enforceHardCapProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: HardCapPayload,
  ) {
    const record = yield* this.readRecordProgram();
    if (!record || record.status === "gone" || record.status === "sleeping") return;
    if (payload.hardCapAt !== record.hardCapAt) return;
    if (record.operation) {
      if (record.operation.kind === "vaporize") return;
      const operationAge =
        (yield* Clock.currentTimeMillis) - Date.parse(record.operation.startedAt);
      if (operationAge < HARD_CAP_GRACE_MS) {
        yield* hostEffect(() => this.schedule(5, "enforceHardCap", payload));
        return;
      }
      yield* this.markHardCapFailureProgram(
        record,
        "A session operation exceeded the hard-cap grace period",
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
    const stopped = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.checkpointProgram(operation.nonce, false, false);
        yield* this.stopAfterCheckpointProgram(operation.nonce);
      }),
    );
    if (Result.isSuccess(stopped)) return;
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
    const terminalAttachments = yield* TerminalAttachments;
    const next = yield* store.recordRuntimeStop;
    if (Option.isSome(next)) {
      yield* terminalAttachments.clear;
      yield* this.projectProgram(next.value);
    }
  });

  private readonly finalizeManagedStopProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: ManagedStopPayload,
  ) {
    const runtime = yield* SandboxRuntime;
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
        yield* hostEffect(() =>
          this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
        );
        return;
      }
      yield* hostEffect(() =>
        this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
      );
      const rollbackClaimed = yield* store.claimManagedStopRollback(payload.nonce);
      if (!rollbackClaimed) return;
      const resumed = yield* Effect.result(
        runtime.execChecked(resumeAgentCommand(), { timeout: 10_000 }),
      );
      if (Result.isSuccess(resumed)) {
        yield* this.releaseOperationIfHeldProgram(payload.nonce);
        return;
      }
      const rollbackAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* this.updateForOperationProgram(payload.nonce, (current) => ({
        ...current,
        operation: current.operation && {
          kind: current.operation.kind,
          nonce: current.operation.nonce,
          startedAt: current.operation.startedAt,
          checkpointedBackupId: current.operation.checkpointedBackupId,
        },
        updatedAt: rollbackAt,
      })).pipe(Effect.ignore);
      return;
    }
    if (!(yield* this.isManagedStopPendingProgram(payload.nonce))) return;
    yield* hostEffect(() =>
      this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload),
    );
    const stopped = yield* Effect.result(hostEffect(() => this.stop()));
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
    return this.#run(this.createScottySessionProgram(input, id, idempotency));
  }

  async getScottySession(): Promise<SessionView> {
    return this.#run(this.getScottySessionProgram());
  }

  async prepareTerminalAttachment(clientId: string): Promise<string> {
    const record = await this.requireRecord();
    await this.#run(this.terminalAttachmentAllowedProgram(record));
    const sessionId = `scotty-web-${clientId}`;
    const credential = await this.requireCredential();
    await this.reconcileExpiredTerminalAttachments();
    const creating = await this.#run(
      Effect.flatMap(TerminalAttachments, (attachments) => attachments.begin(sessionId)),
    );
    const prepared = await this.#run(
      Effect.gen({ self: this }, function* () {
        yield* hostEffect(() =>
          this.schedule(TERMINAL_ATTACHMENT_TTL_MS / 1000, "expireTerminalAttachment", {
            sessionId,
            observedAt: creating.lastSeenAt,
          } satisfies TerminalAttachmentExpiryPayload),
        );
        yield* this.terminalAttachmentAllowedProgram(yield* this.readRecordProgram());
        yield* hostEffect(() =>
          this.createSession({
            id: sessionId,
            cwd: sessionRoot(record.id),
            env: agentEnv(record.id, credential),
          }),
        );
        const attachments = yield* TerminalAttachments;
        const activated = yield* attachments.activate(sessionId);
        if (activated?.status !== "active")
          return yield* conflict("Terminal attachment was released during creation");
        return sessionId;
      }).pipe(Effect.result),
    );
    if (Result.isSuccess(prepared)) return prepared.success;
    await this.requestTerminalAttachmentRelease(sessionId);
    return this.#run(Effect.fail(prepared.failure));
  }

  async releaseTerminalAttachment(clientId: string): Promise<void> {
    await this.requestTerminalAttachmentRelease(`scotty-web-${clientId}`);
  }

  async touchTerminalAttachment(clientId: string): Promise<void> {
    const record = await this.#run(this.readRecordProgram());
    if (!sessionAllowsRuntimeAccess(record)) return;
    const sessionId = `scotty-web-${clientId}`;
    const touched = await this.#run(
      Effect.flatMap(TerminalAttachments, (attachments) => attachments.touch(sessionId)),
    );
    if (!touched) return;
    await this.schedule(TERMINAL_ATTACHMENT_TTL_MS / 1000, "expireTerminalAttachment", {
      sessionId,
      observedAt: touched.lastSeenAt,
    } satisfies TerminalAttachmentExpiryPayload);
  }

  async expireTerminalAttachment(payload: TerminalAttachmentExpiryPayload): Promise<void> {
    const record = await this.#run(this.readRecordProgram());
    if (!sessionAllowsRuntimeAccess(record)) return;
    await this.requestTerminalAttachmentRelease(payload.sessionId, {
      kind: "observedAt",
      value: payload.observedAt,
    });
  }

  async finalizeTerminalAttachment(payload: TerminalAttachmentPayload): Promise<void> {
    const record = await this.#run(this.readRecordProgram());
    if (!sessionAllowsRuntimeAccess(record)) return;
    const attachment = await this.#run(
      Effect.flatMap(TerminalAttachments, (attachments) =>
        attachments.finalizeRelease(payload.sessionId, payload.condition),
      ),
    );
    if (!attachment) return;
    await this.schedule(TERMINAL_ATTACHMENT_RETRY_SECONDS, "finalizeTerminalAttachment", {
      sessionId: payload.sessionId,
      condition: { kind: "always" },
    } satisfies TerminalAttachmentPayload);
    await this.finishTerminalAttachmentRelease(attachment);
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
    return this.readFileStream(path);
  }

  async vaporizeScottySession(): Promise<{ id: string; status: "gone" }> {
    return this.#run(this.vaporizeScottySessionProgram());
  }

  async retryVaporizeSession(payload: VaporizeRetryPayload): Promise<void> {
    return this.#run(this.retryVaporizeSessionProgram(payload));
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

  async captureThreadId(payload: { attempt?: number } = {}): Promise<void> {
    return this.#run(this.captureThreadIdProgram(payload));
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

  private async requireCredential(): Promise<StoredCredential> {
    return this.#run(Effect.flatMap(CredentialVault, (vault) => vault.require));
  }
  private readonly checkpointProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    resumeAgent: boolean,
    releaseLease = resumeAgent,
  ) {
    const record = yield* this.requireRecordProgram();
    const runtime = yield* SandboxRuntime;
    const backups = yield* BackupStore;
    const root = sessionRoot(record.id);
    let paused = false;
    let checkpointSucceeded = false;

    const outcome = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* runtime.execChecked(pauseAgentCommand(), { timeout: 10_000 });
        paused = true;
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
          operation: releaseLease
            ? null
            : current.operation && {
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
        checkpointSucceeded = true;
        return updated;
      }),
    );

    if (paused && (resumeAgent || !checkpointSucceeded)) {
      yield* runtime.exec(resumeAgentCommand(), { timeout: 10_000 }).pipe(Effect.ignore);
    }
    return yield* Result.match(outcome, {
      onFailure: Effect.fail,
      onSuccess: Effect.succeed,
    });
  });

  private readonly stopAfterCheckpointProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
  ) {
    const armedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const payload = { nonce, armedAt } satisfies ManagedStopPayload;
    yield* hostEffect(() =>
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
        yield* hostEffect(() => this.releaseAllTerminalAttachments());
        yield* hostEffect(() => this.stop());
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
      const stoppedAgain = yield* hostEffect(() => this.stop()).pipe(
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
    const operation = yield* this.acquireOperationProgram("snapshot", ["warm"]);
    const result = yield* Effect.result(this.checkpointProgram(operation.nonce, true));
    if (Result.isFailure(result)) {
      yield* this.releaseOperationProgram(operation.nonce);
      return yield* this.upstreamError("Snapshot failed", result.failure);
    }
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(result.success, new Date(now)), now);
  });

  private readonly sleepScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const operation = yield* this.acquireOperationProgram("snapshot", ["warm"]);
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* this.checkpointProgram(operation.nonce, false, false);
        return yield* this.stopAfterCheckpointProgram(operation.nonce);
      }),
    );
    if (Result.isFailure(result)) {
      const pending = yield* this.isManagedStopPendingProgram(operation.nonce);
      if (!Predicate.isTagged(result.failure, "ManagedStopArmedError") && !pending)
        yield* this.releaseOperationIfHeldProgram(operation.nonce);
      return yield* this.upstreamError("Session stop failed", result.failure);
    }
    const now = yield* Clock.currentTimeMillis;
    return toSessionView(toProjection(result.success, new Date(now)), now);
  });

  private async releaseAllTerminalAttachments(): Promise<void> {
    const attachments = await this.#run(
      Effect.flatMap(TerminalAttachments, (service) => service.read),
    );
    await Promise.all(
      attachments.map((attachment) => this.requestTerminalAttachmentRelease(attachment.sessionId)),
    );
  }

  private async removeTerminalAttachment(sessionId: string): Promise<void> {
    await this.#run(
      Effect.flatMap(TerminalAttachments, (attachments) => attachments.remove(sessionId)),
    );
  }

  private async finishTerminalAttachmentRelease(
    attachment: TerminalAttachmentLease,
  ): Promise<void> {
    const lifecycle = await this.#run(this.readRecordProgram());
    if (!sessionAllowsRuntimeAccess(lifecycle)) return;
    let settled = attachment;
    if (!settled.createSettled) {
      const record = await this.requireRecord();
      if (record.status !== "warm" || !sessionAllowsRuntimeAccess(record)) {
        await this.removeTerminalAttachment(settled.sessionId);
        return;
      }
      const credential = await this.requireCredential();
      const beforeCreate = await this.#run(this.readRecordProgram());
      if (!sessionAllowsRuntimeAccess(beforeCreate)) return;
      const created = await this.#run(
        Effect.result(
          hostEffect(() =>
            this.createSession({
              id: settled.sessionId,
              cwd: sessionRoot(record.id),
              env: agentEnv(record.id, credential),
            }),
          ),
        ),
      );
      if (
        Result.isFailure(created) &&
        (!isRecord(created.failure) || created.failure.code !== "SESSION_ALREADY_EXISTS")
      )
        return;
      const updated = await this.#run(
        Effect.flatMap(TerminalAttachments, (attachments) =>
          attachments.settleCreate(settled.sessionId),
        ),
      );
      if (!updated) return;
      settled = updated;
    }
    await this.#run(
      terminalAttachmentCleanupBestEffort(
        settled.sessionId,
        Effect.gen({ self: this }, function* () {
          const attachments = yield* TerminalAttachments;
          const beforeList = yield* this.readRecordProgram();
          if (!sessionAllowsRuntimeAccess(beforeList)) return;
          const { sessions } = yield* hostEffect(() => this.client.utils.listSessions());
          if (!sessions.includes(settled.sessionId)) {
            yield* attachments.remove(settled.sessionId);
            return;
          }
          const beforeDelete = yield* this.readRecordProgram();
          if (!sessionAllowsRuntimeAccess(beforeDelete)) return;
          yield* hostEffect(() => this.deleteSession(settled.sessionId));
          yield* attachments.remove(settled.sessionId);
        }),
      ),
    );
  }

  private async requestTerminalAttachmentRelease(
    sessionId: string,
    condition: TerminalAttachmentReleaseCondition = { kind: "always" },
  ): Promise<void> {
    const record = await this.#run(this.readRecordProgram());
    if (!sessionAllowsRuntimeAccess(record)) return;
    await this.schedule(TERMINAL_ATTACHMENT_RETRY_SECONDS, "finalizeTerminalAttachment", {
      sessionId,
      condition,
    } satisfies TerminalAttachmentPayload);
    const updated = await this.#run(
      Effect.flatMap(TerminalAttachments, (attachments) =>
        attachments.requestRelease(sessionId, condition),
      ),
    );
    if (updated) await this.finishTerminalAttachmentRelease(updated);
  }

  private async reconcileExpiredTerminalAttachments(): Promise<void> {
    const record = await this.#run(this.readRecordProgram());
    if (!sessionAllowsRuntimeAccess(record)) return;
    const now = await this.#run(Clock.currentTimeMillis);
    const cutoff = now - TERMINAL_ATTACHMENT_TTL_MS;
    const attachments = await this.#run(
      Effect.flatMap(TerminalAttachments, (service) => service.expired),
    );
    for (const attachment of attachments) {
      await this.requestTerminalAttachmentRelease(attachment.sessionId, {
        kind: "staleBefore",
        value: new Date(cutoff).toISOString(),
      });
    }
  }

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
