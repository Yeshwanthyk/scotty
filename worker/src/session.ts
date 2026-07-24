import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { Agent, type AgentLaunch, agentLayer } from "./agent";
import { pauseAgentCommand, resumeAgentCommand } from "./agent-runtime";
import { BackupStore, type BackupStoreFailure, backupStoreLayer } from "./backup-store";
import type { Bindings } from "./bindings";
import { agentEnv, ContainerAuth, containerAuthLayer } from "./container-auth";
import {
  CredentialVault,
  type CredentialVaultFailure,
  credentialVaultLayer,
  durableObjectCredentialVaultStorage,
} from "./credential-vault";
import {
  conflict,
  hasCommittedManagedStop,
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
  type PrInput,
  type PrResult,
  type SessionRecord,
  type SessionStatus,
  type SessionView,
} from "./contracts";
import {
  decideIdempotentCreate,
  decodeCreateIdempotencyMetadata,
  type CreateIdempotencyMetadata,
} from "./create-idempotency";
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
  hardCapObservationIsCurrent,
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsTerminalAttachment,
  sessionAllowsRuntimeAccess,
  VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS,
} from "./session-lifecycle";
import {
  errorName,
  SandboxRuntime,
  type SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  shellQuote,
} from "./sandbox-runtime";
import {
  kvSessionProjectionStorage,
  projectSessionBestEffort,
  removeSessionProjection,
  sessionProjectionLayer,
} from "./session-projection";
import { RolloutDiscovery, rolloutDiscoveryLayer } from "./rollout-discovery";
import { type PreparedWorkspace, sessionRoot, Workspace, workspaceLayer } from "./workspace";

const RECORD_KEY = "scotty:session";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const TERMINAL_ATTACHMENTS_KEY = "scotty:terminal-attachments";
const MAX_TERMINAL_ATTACHMENTS = 8;
const TERMINAL_ATTACHMENT_TTL_MS = 45_000;
const TERMINAL_ATTACHMENT_RETRY_SECONDS = 2;
const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const HARD_CAP_GRACE_MS = 30_000;
const ABANDONED_OPERATION_MS = 5 * 60_000;
const MANAGED_STOP_RETRY_SECONDS = 2;
const DESTROY_DEADLINE_MS = 30_000;
const DESTROY_RETRY_SECONDS = 35;

const TerminalAttachmentLeaseSchema = Schema.Struct({
  sessionId: Schema.String,
  status: Schema.Literals(["creating", "active", "releasing"]),
  lastSeenAt: Schema.String,
  createSettled: Schema.Boolean,
});
const TerminalAttachmentLeasesSchema = Schema.Array(TerminalAttachmentLeaseSchema);
const decodeTerminalAttachmentLeases = Schema.decodeUnknownOption(TerminalAttachmentLeasesSchema);
type TerminalAttachmentLease = typeof TerminalAttachmentLeaseSchema.Type;

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

class ManagedStopArmedError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Managed stop reconciliation is armed");
    this.name = "ManagedStopArmedError";
    this.cause = cause;
  }
}

export class Sandbox extends BaseSandbox<Bindings> {
  override sleepAfter = "60m";
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [...ALLOWED_HOSTS];

  async createScottySession(
    input: CreateSessionInput,
    id: string,
    idempotency?: CreateIdempotencyMetadata,
  ): Promise<SessionView> {
    const now = new Date();
    const nonce = crypto.randomUUID();
    const branch = `scotty/${id}`;
    const initial: SessionRecord = {
      version: 1,
      id,
      status: "booting",
      operation: { kind: "create", nonce, startedAt: now.toISOString() },
      repo: input.repo,
      repoExistsAtCreate: true,
      defaultBranch: "dev",
      branch,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      hardCapAt: new Date(now.getTime() + input.hardCapSeconds * 1000).toISOString(),
      hardCapDurationSeconds: input.hardCapSeconds,
      ownedBackupIds: [],
    };

    let replay: SessionRecord | undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<SessionRecord>(RECORD_KEY);
      const storedIdempotency = decodeCreateIdempotencyMetadata(
        await transaction.get<unknown>(CREATE_IDEMPOTENCY_KEY),
      );
      const decision = decideIdempotentCreate(existing, storedIdempotency, idempotency);
      if (decision.kind === "conflict") throw conflict(`Session ${id} already exists`);
      if (decision.kind === "replay") {
        replay = decision.record;
        return;
      }
      if (idempotency) await transaction.put(CREATE_IDEMPOTENCY_KEY, idempotency);
      else await transaction.delete(CREATE_IDEMPOTENCY_KEY);
      await transaction.put(RECORD_KEY, initial);
    });
    if (replay) return toSessionView(toProjection(replay, new Date()), Date.now());
    await this.project(initial);

    try {
      await this.scheduleHardCap(initial.hardCapAt);
      const credential = await this.seedCredential(id);
      const worktree = await this.prepareWorkspace(initial, credential.githubSentinel);
      await this.seedContainerAuth(initial, credential);
      await this.runAgent({ kind: "start", prompt: input.prompt }, initial.id);

      const ready = await this.updateForOperation(nonce, (record) => ({
        ...record,
        status: "warm",
        operation: null,
        repoExistsAtCreate: worktree.repoExists,
        defaultBranch: worktree.defaultBranch,
        updatedAt: new Date().toISOString(),
      }));
      await this.schedule(5, "captureThreadId");
      return toSessionView(toProjection(ready, new Date()), Date.now());
    } catch (error) {
      const failed = await this.failOperation(
        nonce,
        "create_failed",
        "Session setup failed",
        false,
      );
      await this.destroyFailedRuntime(failed.id);
      throw this.upstreamError("Session setup failed", error, failed.id);
    }
  }

  async getScottySession(): Promise<SessionView> {
    const record = await this.requireRecord();
    return toSessionView(toProjection(record, new Date()), Date.now());
  }

  async prepareTerminalAttachment(clientId: string): Promise<string> {
    const record = await this.requireRecord();
    this.assertTerminalAttachmentAllowed(record);
    const sessionId = `scotty-web-${clientId}`;
    const credential = await this.requireCredential();
    await this.reconcileExpiredTerminalAttachments();
    const now = new Date().toISOString();
    await this.schedule(TERMINAL_ATTACHMENT_TTL_MS / 1000, "expireTerminalAttachment", {
      sessionId,
      observedAt: now,
    } satisfies TerminalAttachmentExpiryPayload);
    await this.ctx.storage.transaction(async (transaction) => {
      this.assertTerminalAttachmentAllowed(await transaction.get<SessionRecord>(RECORD_KEY));
      const attachments = this.decodeTerminalAttachments(
        await transaction.get<unknown>(TERMINAL_ATTACHMENTS_KEY),
      );
      if (attachments.some((attachment) => attachment.sessionId === sessionId))
        throw conflict("Terminal attachment already exists");
      if (attachments.length >= MAX_TERMINAL_ATTACHMENTS)
        throw conflict("Too many terminal attachments");
      await transaction.put(TERMINAL_ATTACHMENTS_KEY, [
        ...attachments,
        {
          sessionId,
          status: "creating",
          lastSeenAt: now,
          createSettled: false,
        } satisfies TerminalAttachmentLease,
      ]);
    });
    try {
      this.assertTerminalAttachmentAllowed(await this.ctx.storage.get<SessionRecord>(RECORD_KEY));
      await this.createSession({
        id: sessionId,
        cwd: sessionRoot(record.id),
        env: agentEnv(record.id, credential),
      });
      const activated = await this.updateTerminalAttachment(sessionId, (attachment) => ({
        ...attachment,
        status: attachment.status === "creating" ? "active" : attachment.status,
        lastSeenAt: now,
        createSettled: true,
      }));
      if (activated?.status !== "active")
        throw conflict("Terminal attachment was released during creation");
      return sessionId;
    } catch (error) {
      await this.requestTerminalAttachmentRelease(sessionId);
      throw error;
    }
  }

  async releaseTerminalAttachment(clientId: string): Promise<void> {
    await this.requestTerminalAttachmentRelease(`scotty-web-${clientId}`);
  }

  async touchTerminalAttachment(clientId: string): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record)) return;
    const sessionId = `scotty-web-${clientId}`;
    const observedAt = new Date().toISOString();
    await this.schedule(TERMINAL_ATTACHMENT_TTL_MS / 1000, "expireTerminalAttachment", {
      sessionId,
      observedAt,
    } satisfies TerminalAttachmentExpiryPayload);
    await this.updateTerminalAttachment(sessionId, (attachment) => ({
      ...attachment,
      lastSeenAt: observedAt,
    }));
  }

  async expireTerminalAttachment(payload: TerminalAttachmentExpiryPayload): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record)) return;
    await this.requestTerminalAttachmentRelease(payload.sessionId, {
      kind: "observedAt",
      value: payload.observedAt,
    });
  }

  async finalizeTerminalAttachment(payload: TerminalAttachmentPayload): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record)) return;
    const attachment = await this.updateTerminalAttachment(
      payload.sessionId,
      (current) => ({ ...current, status: "releasing" }),
      (current) =>
        current.status === "releasing" ||
        this.terminalReleaseConditionMatches(current, payload.condition),
    );
    if (!attachment) return;
    await this.schedule(TERMINAL_ATTACHMENT_RETRY_SECONDS, "finalizeTerminalAttachment", {
      sessionId: payload.sessionId,
      condition: { kind: "always" },
    } satisfies TerminalAttachmentPayload);
    await this.finishTerminalAttachmentRelease(attachment);
  }

  async snapshotScottySession(): Promise<SessionView> {
    const operation = await this.acquireOperation("snapshot", ["warm"]);
    try {
      const record = await this.checkpoint(operation.nonce, true);
      return toSessionView(toProjection(record, new Date()), Date.now());
    } catch (error) {
      await this.releaseOperation(operation.nonce);
      throw this.upstreamError("Snapshot failed", error);
    }
  }

  async sleepScottySession(): Promise<SessionView> {
    const operation = await this.acquireOperation("snapshot", ["warm"]);
    try {
      await this.checkpoint(operation.nonce, false, false);
      const record = await this.stopAfterCheckpoint(operation.nonce);
      return toSessionView(toProjection(record, new Date()), Date.now());
    } catch (error) {
      if (
        !(error instanceof ManagedStopArmedError) &&
        !(await this.isManagedStopPending(operation.nonce))
      )
        await this.releaseOperationIfHeld(operation.nonce);
      throw this.upstreamError("Session stop failed", error);
    }
  }

  async resumeScottySession(): Promise<SessionView> {
    const operation = await this.acquireOperation("resume", ["sleeping", "failed"]);
    let record = await this.requireRecord();
    const backup = record.backup?.current;
    if (!backup) {
      await this.releaseOperation(operation.nonce);
      throw wrongState(record.status, "resume", "No successful backup is available");
    }

    record = await this.updateForOperation(operation.nonce, (current) => ({
      ...current,
      status: "booting",
      failure: undefined,
      updatedAt: new Date().toISOString(),
    }));

    try {
      const hardCapAt = new Date(Date.now() + record.hardCapDurationSeconds * 1000).toISOString();
      record = await this.updateForOperation(operation.nonce, (current) => ({
        ...current,
        hardCapAt,
        updatedAt: new Date().toISOString(),
      }));
      await this.scheduleHardCap(hardCapAt);
      await this.runBackupStore(Effect.flatMap(BackupStore, (store) => store.restore(backup)));
      await this.ctx.storage.delete(TERMINAL_ATTACHMENTS_KEY);
      const credential = await this.requireCredential();
      await this.seedContainerAuth(record, credential);
      await this.runAgent({ kind: "resume", threadId: record.codexThreadId }, record.id);
      const ready = await this.updateForOperation(operation.nonce, (current) => ({
        ...current,
        status: "warm",
        operation: null,
        failure: undefined,
        hardCapAt,
        updatedAt: new Date().toISOString(),
      }));
      await this.schedule(5, "captureThreadId");
      return toSessionView(toProjection(ready, new Date()), Date.now());
    } catch (error) {
      await this.failOperation(operation.nonce, "resume_failed", "Session restore failed", true);
      await this.destroyFailedRuntime(record.id);
      throw this.upstreamError("Session restore failed", error);
    }
  }

  async publishScottySession(input: PrInput): Promise<PrResult> {
    const operation = await this.acquireOperation("pr", ["warm"]);
    const record = await this.requireRecord();
    const credential = await this.requireCredential();
    const env = agentEnv(record.id, credential);
    const root = sessionRoot(record.id);
    const repoUrl = `https://github.com/${record.repo}.git`;

    try {
      const title = input.title ?? `Scotty session ${record.id}`;
      const dirty = await this.execChecked(`git -C ${shellQuote(root)} status --porcelain`);
      if (dirty.stdout.trim()) {
        await this.execChecked(
          `git -C ${shellQuote(root)} -c user.name=Scotty -c user.email=scotty@users.noreply.github.com add -A && git -C ${shellQuote(root)} -c user.name=Scotty -c user.email=scotty@users.noreply.github.com commit -m ${shellQuote(title)}`,
          { env, timeout: 120_000 },
        );
      }
      if (!record.repoExistsAtCreate) {
        await this.execChecked(`gh repo create ${shellQuote(record.repo)} --private`, {
          env,
          timeout: 120_000,
        });
        await this.execChecked(
          `git -C ${shellQuote(root)} remote set-url origin ${shellQuote(repoUrl)}`,
          { env },
        );
      }

      await this.execChecked(
        `git -C ${shellQuote(root)} push -u origin ${shellQuote(record.branch)}`,
        { env, timeout: 180_000 },
      );
      const branchUrl = `https://github.com/${record.repo}/tree/${record.branch}`;
      let result: PrResult;
      if (!record.repoExistsAtCreate) {
        result = { branchUrl, created: false };
      } else {
        const bodyPath = `/tmp/scotty-pr-${record.id}.md`;
        await this.writeFile(bodyPath, `Automated changes from Scotty session \`${record.id}\`.\n`);
        const created = await this.execChecked(
          `gh pr create --repo ${shellQuote(record.repo)} --base ${shellQuote(record.defaultBranch)} --head ${shellQuote(record.branch)} --title ${shellQuote(title)} --body-file ${shellQuote(bodyPath)}`,
          { env, timeout: 120_000 },
        );
        const prUrl = created.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/u)?.[0];
        // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native Sandbox command callback preserves its existing Promise rejection contract until Chunk 6
        if (!prUrl) throw new Error("gh did not return a pull request URL");
        result = { prUrl, branchUrl, created: true };
      }
      await this.releaseOperation(operation.nonce);
      return result;
    } catch (error) {
      await this.releaseOperation(operation.nonce);
      throw this.upstreamError("Publishing failed", error);
    }
  }

  async prepareDownArchive(): Promise<DownArchive> {
    const operation = await this.acquireOperation("down", ["warm"]);
    const record = await this.requireRecord();
    const root = sessionRoot(record.id);

    try {
      const sha = (
        await this.execChecked(`git -C ${shellQuote(root)} rev-parse HEAD`)
      ).stdout.trim();
      const rollout = Option.getOrElse(
        await this.runRolloutDiscovery(
          Effect.flatMap(RolloutDiscovery, (discovery) => discovery.findNewestRollout(record.id)),
        ),
        () => undefined,
      );
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
      await this.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const members = [`-C /tmp ${shellQuote(basename(manifestPath))}`];
      if (rollout)
        members.push(`-C ${shellQuote(dirname(rollout))} ${shellQuote(basename(rollout))}`);
      await this.execChecked(`tar -cf ${shellQuote(archivePath)} ${members.join(" ")}`);
      await this.releaseOperation(operation.nonce);
      return { path: archivePath, filename: `scotty-${record.id}.tar`, manifest };
    } catch (error) {
      await this.releaseOperation(operation.nonce);
      throw this.upstreamError("Beam-down archive failed", error);
    }
  }

  async readScottyArchiveStream(path: string) {
    await this.assertRuntimeAccess();
    return this.readFileStream(path);
  }

  async vaporizeScottySession(): Promise<{ id: string; status: "gone" }> {
    const existing = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!existing) throw notFound("unknown");
    if (existing.status === "gone") {
      try {
        await this.removeProjection(existing.id);
        this.cancelAllSessionSchedules();
        return { id: existing.id, status: "gone" };
      } catch (error) {
        await this.armVaporizeRetry({ id: existing.id, nonce: "gone" });
        throw this.upstreamError("Vaporize projection repair failed", error, existing.id);
      }
    }
    const operation =
      existing.operation?.kind === "vaporize"
        ? existing.operation
        : await this.acquireOperation(
            "vaporize",
            ["booting", "warm", "sleeping", "failed"],
            ABANDONED_OPERATION_MS,
          );
    const payload = { id: existing.id, nonce: operation.nonce } satisfies VaporizeRetryPayload;
    await this.armVaporizeRetry(payload);

    try {
      return await this.continueVaporizeSession(payload);
    } catch (error) {
      throw this.upstreamError("Vaporize failed", error);
    }
  }

  async retryVaporizeSession(payload: VaporizeRetryPayload): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!record || record.id !== payload.id) return;
    if (record.status !== "gone" && record.operation?.nonce !== payload.nonce) return;

    await this.armVaporizeRetry(payload);
    try {
      await this.continueVaporizeSession(payload);
    } catch (error) {
      console.error("Vaporize reconciliation failed", {
        sessionId: payload.id,
        error: errorName(error),
      });
    }
  }

  async readCredentialForProxy(sentinel: string): Promise<StoredCredential | null> {
    return this.runCredentialVault(
      Effect.flatMap(CredentialVault, (vault) => vault.readForProxy(sentinel)),
    );
  }

  async beginCredentialRefresh(sentinel: string): Promise<CredentialRefreshLease | null> {
    return this.runCredentialVault(
      Effect.flatMap(CredentialVault, (vault) => vault.beginRefresh(sentinel, crypto.randomUUID())),
    );
  }

  async persistRotatedCredential(
    sentinel: string,
    patch: CredentialPatch,
    nonce: string,
  ): Promise<void> {
    await this.runCredentialVault(
      Effect.flatMap(CredentialVault, (vault) => vault.persistRotation(sentinel, patch, nonce)),
    );
  }

  async cancelCredentialRefresh(sentinel: string, nonce: string): Promise<void> {
    await this.runCredentialVault(
      Effect.flatMap(CredentialVault, (vault) => vault.cancelRefresh(sentinel, nonce)),
    );
  }

  async captureThreadId(payload: { attempt?: number } = {}): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record) || record.status !== "warm" || record.operation) return;
    const threadIdOption = await this.runRolloutDiscovery(
      Effect.flatMap(RolloutDiscovery, (discovery) => discovery.discoverThreadId(record.id)),
    );
    if (Option.isNone(threadIdOption)) {
      const attempt = payload.attempt ?? 0;
      if (attempt < 11) await this.schedule(5, "captureThreadId", { attempt: attempt + 1 });
      return;
    }
    const threadId = threadIdOption.value;
    let updated: SessionRecord | undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionRecord>(RECORD_KEY);
      if (
        !sessionAllowsRuntimeAccess(current) ||
        current.status !== "warm" ||
        current.operation ||
        current.codexThreadId === threadId
      )
        return;
      updated = { ...current, codexThreadId: threadId, updatedAt: new Date().toISOString() };
      await transaction.put(RECORD_KEY, updated);
    });
    if (updated) await this.project(updated);
  }

  async enforceHardCap(payload: HardCapPayload): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!record || record.status === "gone" || record.status === "sleeping") return;
    if (payload.hardCapAt !== record.hardCapAt) return;

    if (record.operation) {
      if (record.operation.kind === "vaporize") return;
      const operationAge = Date.now() - Date.parse(record.operation.startedAt);
      if (operationAge < HARD_CAP_GRACE_MS) {
        await this.schedule(5, "enforceHardCap", payload);
        return;
      }
      await this.markHardCapFailure(
        record,
        "A session operation exceeded the hard-cap grace period",
      );
      return;
    }

    let operation: SessionRecord["operation"] = null;
    try {
      operation = await this.acquireOperation("snapshot", ["warm", "booting"]);
      await this.checkpoint(operation.nonce, false, false);
      await this.stopAfterCheckpoint(operation.nonce);
    } catch (error) {
      if (
        operation &&
        (error instanceof ManagedStopArmedError ||
          (await this.isManagedStopPending(operation.nonce)))
      )
        return;
      const current = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
      if (current) await this.markHardCapFailure(current, "Hard-cap checkpoint or shutdown failed");
    }
  }

  override async onActivityExpired(): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!record || record.status !== "warm" || record.operation) return;
    let operation: NonNullable<SessionRecord["operation"]> | undefined;
    try {
      operation = await this.acquireOperation("snapshot", ["warm"]);
      await this.checkpoint(operation.nonce, false, false);
      await this.stopAfterCheckpoint(operation.nonce);
    } catch (error) {
      if (
        operation &&
        !(error instanceof ManagedStopArmedError) &&
        !(await this.isManagedStopPending(operation.nonce))
      )
        await this.releaseOperationIfHeld(operation.nonce);
      console.error("Managed idle checkpoint failed", {
        sessionId: record.id,
        error: errorName(error),
      });
    }
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    let next: SessionRecord | undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<SessionRecord>(RECORD_KEY);
      if (
        !record ||
        record.status === "sleeping" ||
        record.status === "failed" ||
        record.status === "gone" ||
        record.operation?.kind === "vaporize"
      )
        return;
      const checkpointCommitted = hasCommittedManagedStop(record);
      next = checkpointCommitted
        ? {
            ...record,
            status: "sleeping",
            operation: null,
            failure: undefined,
            updatedAt: new Date().toISOString(),
          }
        : {
            ...record,
            status: "failed",
            operation: null,
            failure: {
              code: "runtime_stopped",
              message: "Sandbox runtime stopped before a managed checkpoint",
              recoverable: Boolean(record.backup?.current),
            },
            updatedAt: new Date().toISOString(),
          };
      await transaction.put(RECORD_KEY, next);
      await transaction.delete(TERMINAL_ATTACHMENTS_KEY);
    });
    if (next) await this.project(next);
  }

  async finalizeManagedStop(payload: ManagedStopPayload): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record)) return;
    if (
      record?.operation?.nonce === payload.nonce &&
      record.operation.checkpointedBackupId === record.backup?.current.id &&
      !record.operation.stopRequestedAt
    ) {
      if (Date.now() - Date.parse(payload.armedAt) < 30_000) {
        await this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload);
        return;
      }
      await this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload);
      let rollbackClaimed = false;
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<SessionRecord>(RECORD_KEY);
        if (
          current?.operation?.nonce !== payload.nonce ||
          current.operation.stopRequestedAt ||
          current.operation.checkpointedBackupId !== current.backup?.current.id
        )
          return;
        if (current.operation.stopRollbackAt) {
          rollbackClaimed = true;
          return;
        }
        rollbackClaimed = true;
        await transaction.put(RECORD_KEY, {
          ...current,
          operation: { ...current.operation, stopRollbackAt: new Date().toISOString() },
          updatedAt: new Date().toISOString(),
        });
      });
      if (!rollbackClaimed) return;
      try {
        await this.execChecked(resumeAgentCommand(), { timeout: 10_000 });
        await this.releaseOperationIfHeld(payload.nonce);
      } catch {
        await this.updateForOperation(payload.nonce, (current) => ({
          ...current,
          operation: current.operation && {
            kind: current.operation.kind,
            nonce: current.operation.nonce,
            startedAt: current.operation.startedAt,
            checkpointedBackupId: current.operation.checkpointedBackupId,
          },
          updatedAt: new Date().toISOString(),
        })).catch(() => undefined);
      }
      return;
    }
    if (!(await this.isManagedStopPending(payload.nonce))) return;
    await this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload);
    try {
      await this.stop();
    } catch (error) {
      console.error("Managed stop reconciliation failed", { error: errorName(error) });
    }
  }

  private async seedCredential(id: string): Promise<StoredCredential> {
    return this.runCredentialVault(
      Effect.flatMap(CredentialVault, (vault) =>
        vault.seed({
          codexAuthJson: this.env.CODEX_AUTH_JSON,
          codexSentinel: `${CODEX_SENTINEL_PREFIX}${id}-${randomToken(12)}`,
          githubSentinel: `${GITHUB_SENTINEL_PREFIX}${id}-${randomToken(12)}`,
        }),
      ),
    );
  }

  private async requireCredential(): Promise<StoredCredential> {
    return this.runCredentialVault(Effect.flatMap(CredentialVault, (vault) => vault.require));
  }

  private async prepareWorkspace(
    record: SessionRecord,
    githubSentinel: string,
  ): Promise<PreparedWorkspace> {
    const layer = workspaceLayer.pipe(Layer.provide(this.sandboxRuntimeLayer()));
    const result = await Effect.runPromise(
      Effect.flatMap(Workspace, (workspace) => workspace.prepare(record, githubSentinel)).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.result,
      ),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async seedContainerAuth(
    record: SessionRecord,
    credential: StoredCredential,
  ): Promise<void> {
    const layer = containerAuthLayer.pipe(Layer.provide(this.sandboxRuntimeLayer()));
    const result = await Effect.runPromise(
      Effect.flatMap(ContainerAuth, (auth) => auth.seed(record.id, credential)).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.result,
      ),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }
  private async checkpoint(
    nonce: string,
    resumeAgent: boolean,
    releaseLease = resumeAgent,
  ): Promise<SessionRecord> {
    const record = await this.requireRecord();
    const root = sessionRoot(record.id);
    let paused = false;
    let checkpointSucceeded = false;
    try {
      await this.execChecked(pauseAgentCommand(), { timeout: 10_000 });
      paused = true;
      await this.execChecked("sync", { timeout: 30_000 });
      const backup = await this.runBackupStore(
        Effect.flatMap(BackupStore, (store) =>
          store.create({
            dir: root,
            name: `scotty-${record.id}-${Date.now()}`,
            ttl: BACKUP_TTL_SECONDS,
            localBucket: true,
            compression: { format: "zstd" },
          }),
        ),
      );
      const priorPrevious = record.backup?.previous;
      const updated = await this.updateForOperation(nonce, (current) => ({
        ...current,
        operation: releaseLease
          ? null
          : current.operation && {
              ...current.operation,
              checkpointedBackupId: backup.id,
            },
        backup: { current: backup, previous: current.backup?.current },
        ownedBackupIds: [...new Set([...current.ownedBackupIds, backup.id])],
        backupExpiresAt: new Date(Date.now() + BACKUP_TTL_SECONDS * 1000).toISOString(),
        failure: undefined,
        updatedAt: new Date().toISOString(),
      }));
      if (priorPrevious) {
        await this.runBackupStore(
          Effect.flatMap(BackupStore, (store) => store.delete(priorPrevious.id)),
        ).catch(() => undefined);
      }
      checkpointSucceeded = true;
      return updated;
    } finally {
      if (paused && (resumeAgent || !checkpointSucceeded)) {
        await this.exec(resumeAgentCommand(), { timeout: 10_000 }).catch(() => undefined);
      }
    }
  }

  private async stopAfterCheckpoint(nonce: string): Promise<SessionRecord> {
    const payload = { nonce, armedAt: new Date().toISOString() } satisfies ManagedStopPayload;
    await this.schedule(MANAGED_STOP_RETRY_SECONDS, "finalizeManagedStop", payload);
    try {
      await this.updateForOperation(nonce, (record) => {
        if (record.operation?.stopRollbackAt) throw conflict("Managed stop rollback started");
        return {
          ...record,
          operation: record.operation && {
            ...record.operation,
            stopRequestedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        };
      });
      await this.releaseAllTerminalAttachments();
      await this.stop();
    } catch (error) {
      const current = await this.requireRecord();
      if (current.status === "sleeping") return current;
      throw new ManagedStopArmedError(error);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stopped = await this.requireRecord();
      if (stopped.status === "sleeping") return stopped;
      if (stopped.status === "failed") throw wrongState(stopped.status, "stop");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.stop().catch((error) => {
        throw new ManagedStopArmedError(error);
      });
    }
    throw new ScottyError("upstream", "Session shutdown is still completing", {
      httpStatus: 502,
      exitCode: 4,
    });
  }

  private async isManagedStopPending(nonce: string): Promise<boolean> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    return (
      (record?.status === "warm" || record?.status === "booting") &&
      record.operation?.nonce === nonce &&
      Boolean(record.operation.stopRequestedAt)
    );
  }

  private async releaseAllTerminalAttachments(): Promise<void> {
    const attachments = await this.readTerminalAttachments();
    await Promise.all(
      attachments.map((attachment) => this.requestTerminalAttachmentRelease(attachment.sessionId)),
    );
  }

  private decodeTerminalAttachments(stored: unknown): TerminalAttachmentLease[] {
    return Option.getOrElse(decodeTerminalAttachmentLeases(stored), () => []).filter((attachment) =>
      /^scotty-web-[0-9a-f]{12}$/u.test(attachment.sessionId),
    );
  }

  private async readTerminalAttachments(): Promise<TerminalAttachmentLease[]> {
    return this.decodeTerminalAttachments(
      await this.ctx.storage.get<unknown>(TERMINAL_ATTACHMENTS_KEY),
    );
  }

  private async updateTerminalAttachment(
    sessionId: string,
    update: (attachment: TerminalAttachmentLease) => TerminalAttachmentLease,
    predicate: (attachment: TerminalAttachmentLease) => boolean = () => true,
  ): Promise<TerminalAttachmentLease | undefined> {
    let updated: TerminalAttachmentLease | undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      const attachments = this.decodeTerminalAttachments(
        await transaction.get<unknown>(TERMINAL_ATTACHMENTS_KEY),
      );
      const next = attachments.map((attachment) => {
        if (attachment.sessionId !== sessionId || !predicate(attachment)) return attachment;
        updated = update(attachment);
        return updated;
      });
      if (updated) await transaction.put(TERMINAL_ATTACHMENTS_KEY, next);
    });
    return updated;
  }

  private async removeTerminalAttachment(sessionId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const attachments = this.decodeTerminalAttachments(
        await transaction.get<unknown>(TERMINAL_ATTACHMENTS_KEY),
      );
      await transaction.put(
        TERMINAL_ATTACHMENTS_KEY,
        attachments.filter((attachment) => attachment.sessionId !== sessionId),
      );
    });
  }

  private async finishTerminalAttachmentRelease(
    attachment: TerminalAttachmentLease,
  ): Promise<void> {
    const lifecycle = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(lifecycle)) return;
    let settled = attachment;
    if (!settled.createSettled) {
      const record = await this.requireRecord();
      if (record.status !== "warm" || !sessionAllowsRuntimeAccess(record)) {
        await this.removeTerminalAttachment(settled.sessionId);
        return;
      }
      const credential = await this.requireCredential();
      const beforeCreate = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
      if (!sessionAllowsRuntimeAccess(beforeCreate)) return;
      try {
        await this.createSession({
          id: settled.sessionId,
          cwd: sessionRoot(record.id),
          env: agentEnv(record.id, credential),
        });
      } catch (error) {
        if (!isRecord(error) || error.code !== "SESSION_ALREADY_EXISTS") return;
      }
      const updated = await this.updateTerminalAttachment(
        settled.sessionId,
        (current) => ({ ...current, createSettled: true }),
        (current) => current.status === "releasing",
      );
      if (!updated) return;
      settled = updated;
    }
    try {
      const beforeList = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
      if (!sessionAllowsRuntimeAccess(beforeList)) return;
      const { sessions } = await this.client.utils.listSessions();
      if (!sessions.includes(settled.sessionId)) {
        await this.removeTerminalAttachment(settled.sessionId);
        return;
      }
      const beforeDelete = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
      if (!sessionAllowsRuntimeAccess(beforeDelete)) return;
      await this.deleteSession(settled.sessionId);
      await this.removeTerminalAttachment(settled.sessionId);
    } catch {}
  }

  private async requestTerminalAttachmentRelease(
    sessionId: string,
    condition: TerminalAttachmentPayload["condition"] = { kind: "always" },
  ): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record)) return;
    await this.schedule(TERMINAL_ATTACHMENT_RETRY_SECONDS, "finalizeTerminalAttachment", {
      sessionId,
      condition,
    } satisfies TerminalAttachmentPayload);
    const updated = await this.updateTerminalAttachment(
      sessionId,
      (attachment) => ({ ...attachment, status: "releasing" }),
      (attachment) => this.terminalReleaseConditionMatches(attachment, condition),
    );
    if (updated) await this.finishTerminalAttachmentRelease(updated);
  }

  private terminalReleaseConditionMatches(
    attachment: TerminalAttachmentLease,
    condition: TerminalAttachmentPayload["condition"] = { kind: "always" },
  ): boolean {
    if (condition.kind === "observedAt") return attachment.lastSeenAt === condition.value;
    if (condition.kind === "staleBefore")
      return Date.parse(attachment.lastSeenAt) <= Date.parse(condition.value);
    return true;
  }

  private async reconcileExpiredTerminalAttachments(): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record)) return;
    const cutoff = Date.now() - TERMINAL_ATTACHMENT_TTL_MS;
    const attachments = await this.readTerminalAttachments();
    for (const attachment of attachments) {
      if (Date.parse(attachment.lastSeenAt) > cutoff || attachment.status === "releasing") continue;
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

  private async continueVaporizeSession(
    payload: VaporizeRetryPayload,
  ): Promise<{ id: string; status: "gone" }> {
    const current = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!current) throw notFound(payload.id);
    if (current.status === "gone") {
      await this.removeProjection(current.id);
      this.cancelAllSessionSchedules();
      return { id: current.id, status: "gone" };
    }
    if (current.operation?.kind !== "vaporize" || current.operation.nonce !== payload.nonce)
      throw conflict("Session vaporize lease changed");

    this.cancelVaporizeConflictingSchedules();
    await this.ctx.storage.delete(TERMINAL_ATTACHMENTS_KEY);
    const destroyed = await this.destroyBeforeDeadline();
    if (!destroyed) {
      await this.armVaporizeRetry(payload);
      this.ctx.abort(`Sandbox destroy exceeded ${DESTROY_DEADLINE_MS}ms`);
      throw new ScottyError("upstream", "Sandbox destruction timed out", {
        httpStatus: 502,
        exitCode: 1,
      });
    }

    for (const backupId of new Set(current.ownedBackupIds)) {
      await this.runBackupStore(Effect.flatMap(BackupStore, (store) => store.delete(backupId)));
    }
    await this.runCredentialVault(Effect.flatMap(CredentialVault, (vault) => vault.delete));
    const gone = await this.updateForOperation(payload.nonce, (record) => ({
      ...record,
      status: "gone",
      operation: null,
      backup: undefined,
      ownedBackupIds: [],
      backupExpiresAt: undefined,
      codexThreadId: undefined,
      failure: undefined,
      updatedAt: new Date().toISOString(),
    }));
    await this.removeProjection(gone.id);
    this.cancelAllSessionSchedules();
    return { id: gone.id, status: "gone" };
  }

  private async armVaporizeRetry(payload: VaporizeRetryPayload): Promise<void> {
    this.deleteSchedules("retryVaporizeSession");
    await this.schedule(DESTROY_RETRY_SECONDS, "retryVaporizeSession", payload);
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

  private async destroyBeforeDeadline(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.destroy().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), DESTROY_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async destroyFailedRuntime(sessionId: string): Promise<void> {
    this.deleteSchedules("retryHardCapDestroy");
    try {
      const destroyed = await this.destroyBeforeDeadline();
      if (destroyed) return;
    } catch {}
    await this.schedule(DESTROY_RETRY_SECONDS, "retryHardCapDestroy", sessionId);
    this.ctx.abort(`Sandbox destroy did not complete for ${sessionId}`);
  }

  private async acquireOperation(
    kind: OperationKind,
    allowed: SessionStatus[],
    replaceOperationOlderThanMs?: number,
  ): Promise<NonNullable<SessionRecord["operation"]>> {
    return this.runSessionStore(
      Effect.flatMap(SessionStore, (store) =>
        store.acquireOperation(kind, allowed, crypto.randomUUID(), replaceOperationOlderThanMs),
      ),
    );
  }

  private async updateForOperation(
    nonce: string,
    update: (record: SessionRecord) => SessionRecord,
  ): Promise<SessionRecord> {
    const next = await this.runSessionStore(
      Effect.flatMap(SessionStore, (store) => store.updateForOperation(nonce, update)),
    );
    await this.project(next);
    return next;
  }

  private async releaseOperation(nonce: string): Promise<SessionRecord> {
    const next = await this.runSessionStore(
      Effect.flatMap(SessionStore, (store) => store.releaseOperation(nonce)),
    );
    await this.project(next);
    return next;
  }

  private async releaseOperationIfHeld(nonce: string): Promise<void> {
    const next = await this.runSessionStore(
      Effect.flatMap(SessionStore, (store) => store.releaseOperationIfHeld(nonce)),
    );
    if (next) await this.project(next).catch(() => undefined);
  }

  private async failOperation(
    nonce: string,
    code: string,
    message: string,
    recoverable: boolean,
  ): Promise<SessionRecord> {
    const next = await this.runSessionStore(
      Effect.flatMap(SessionStore, (store) =>
        store.failOperation(nonce, code, message, recoverable),
      ),
    );
    await this.project(next);
    return next;
  }

  async retryHardCapDestroy(sessionId: string): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (
      !record ||
      record.id !== sessionId ||
      record.status !== "failed" ||
      record.operation?.kind === "vaporize"
    )
      return;
    await this.destroyFailedRuntime(sessionId);
  }

  private async markHardCapFailure(record: SessionRecord, message: string): Promise<void> {
    let failed: SessionRecord | undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionRecord>(RECORD_KEY);
      if (!hardCapObservationIsCurrent(record, current)) return;
      failed = {
        ...current,
        status: "failed",
        operation: null,
        failure: {
          code: "hard_cap_checkpoint_failed",
          message,
          recoverable: Boolean(current.backup?.current),
        },
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(RECORD_KEY, failed);
    });
    if (!failed) return;
    await this.project(failed);
    await this.destroyFailedRuntime(failed.id);
  }

  private async requireRecord(): Promise<SessionRecord> {
    return this.runSessionStore(Effect.flatMap(SessionStore, (store) => store.requireRecord));
  }

  private assertTerminalAttachmentAllowed(
    record: SessionRecord | undefined,
  ): asserts record is SessionRecord {
    if (sessionAllowsTerminalAttachment(record)) return;
    if (!record) throw notFound("unknown");
    if (record.status !== "warm") throw wrongState(record.status, "attach");
    if (!sessionAllowsRuntimeAccess(record))
      throw conflict("Session destruction is already in progress");
    if (record.operation) throw conflict(`Session is already running ${record.operation.kind}`);
    throw conflict("Session is not accepting terminal attachments");
  }

  private async assertRuntimeAccess(): Promise<SessionRecord> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!sessionAllowsRuntimeAccess(record))
      throw conflict("Session destruction is already in progress");
    return record;
  }

  private async runSessionStore<A>(
    program: Effect.Effect<A, ScottyError, SessionStore>,
  ): Promise<A> {
    const layer = sessionStoreLayer(durableObjectSessionRecordStorage(this.ctx.storage));
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async project(record: SessionRecord): Promise<void> {
    const layer = sessionProjectionLayer(kvSessionProjectionStorage(this.env.SESSIONS));
    await Effect.runPromise(
      projectSessionBestEffort(record).pipe(Effect.provide(layer), Effect.scoped),
    );
  }

  private async removeProjection(id: string): Promise<void> {
    const layer = sessionProjectionLayer(kvSessionProjectionStorage(this.env.SESSIONS));
    const result = await Effect.runPromise(
      removeSessionProjection(id).pipe(Effect.provide(layer), Effect.scoped, Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async runBackupStore<A>(
    program: Effect.Effect<A, BackupStoreFailure, BackupStore>,
  ): Promise<A> {
    const layer = backupStoreLayer({
      createBackup: async (options) => {
        await this.assertRuntimeAccess();
        return this.createBackup(options);
      },
      restoreBackup: async (backup) => {
        await this.assertRuntimeAccess();
        return this.restoreBackup(backup);
      },
      listObjects: (prefix, cursor) =>
        this.env.BACKUP_BUCKET.list({ prefix, cursor }).then((page) => ({
          keys: page.objects.map((object) => object.key),
          cursor: page.truncated ? page.cursor : undefined,
        })),
      deleteObjects: (keys) => this.env.BACKUP_BUCKET.delete([...keys]),
    });
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async runCredentialVault<A>(
    program: Effect.Effect<A, CredentialVaultFailure, CredentialVault>,
  ): Promise<A> {
    const layer = credentialVaultLayer(
      durableObjectCredentialVaultStorage(this.ctx.storage),
      this.env.GH_TOKEN,
    );
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async runAgent(launch: AgentLaunch, id: SessionRecord["id"]): Promise<void> {
    const dependencies = Layer.merge(
      this.sandboxRuntimeLayer(),
      credentialVaultLayer(
        durableObjectCredentialVaultStorage(this.ctx.storage),
        this.env.GH_TOKEN,
      ),
    );
    const layer = agentLayer(this.env.SCOTTY_FAKE_AGENT === "1").pipe(Layer.provide(dependencies));
    const result = await Effect.runPromise(
      Effect.flatMap(Agent, (agent) => agent.launch(id, launch)).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.result,
      ),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async execChecked(
    command: string,
    options: { env?: Record<string, string>; timeout?: number } = {},
  ): Promise<ExecResult> {
    return this.runSandboxRuntime(
      Effect.flatMap(SandboxRuntime, (runtime) => runtime.execChecked(command, options)),
    );
  }

  private async execResult(
    command: string,
    options: { env?: Record<string, string>; timeout?: number } = {},
  ): Promise<ExecResult> {
    return this.runSandboxRuntime(
      Effect.flatMap(SandboxRuntime, (runtime) => runtime.exec(command, options)),
    );
  }

  private async runSandboxRuntime<A>(
    program: Effect.Effect<A, SandboxRuntimeFailure, SandboxRuntime>,
  ): Promise<A> {
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(this.sandboxRuntimeLayer()), Effect.scoped, Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private async runRolloutDiscovery<A>(
    program: Effect.Effect<A, SandboxRuntimeFailure, RolloutDiscovery>,
  ): Promise<A> {
    const layer = rolloutDiscoveryLayer.pipe(Layer.provide(this.sandboxRuntimeLayer()));
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped, Effect.result),
    );
    return Result.match(result, {
      onFailure: (error) => {
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private sandboxRuntimeLayer(): Layer.Layer<SandboxRuntime> {
    return sandboxRuntimeLayer({
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
