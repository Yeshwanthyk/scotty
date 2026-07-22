import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Option, Result } from "effect";
import { Agent, type AgentLaunch, agentLayer } from "./agent";
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
  errorName,
  SandboxRuntime,
  type SandboxRuntimeFailure,
  sandboxRuntimeLayer,
  shellQuote,
} from "./sandbox-runtime";
import {
  kvSessionProjectionStorage,
  projectSessionBestEffort,
  sessionProjectionLayer,
} from "./session-projection";
import { RolloutDiscovery, rolloutDiscoveryLayer } from "./rollout-discovery";
import { type PreparedWorkspace, sessionRoot, Workspace, workspaceLayer } from "./workspace";

const RECORD_KEY = "scotty:session";
const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const HARD_CAP_GRACE_MS = 30_000;

interface HardCapPayload {
  hardCapAt: string;
}

export class Sandbox extends BaseSandbox<Bindings> {
  override sleepAfter = "60m";
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [...ALLOWED_HOSTS];

  async createScottySession(input: CreateSessionInput, id: string): Promise<SessionView> {
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

    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<SessionRecord>(RECORD_KEY);
      if (existing && existing.status !== "gone") throw conflict(`Session ${id} already exists`);
      await transaction.put(RECORD_KEY, initial);
    });
    await this.project(initial);

    try {
      const credential = await this.seedCredential(id);
      const worktree = await this.prepareWorkspace(initial, credential.githubSentinel);
      await this.seedContainerAuth(initial, credential);
      await this.runAgent({ kind: "start", prompt: input.prompt }, initial.id);
      await this.scheduleHardCap(initial.hardCapAt);

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
      try {
        await this.destroy();
      } catch {
        await this.schedule(10, "retryHardCapDestroy", failed.id);
      }
      throw this.upstreamError("Session setup failed", error, failed.id);
    }
  }

  async getScottySession(): Promise<SessionView> {
    const record = await this.requireRecord();
    return toSessionView(toProjection(record, new Date()), Date.now());
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
      await this.runBackupStore(Effect.flatMap(BackupStore, (store) => store.restore(backup)));
      const credential = await this.requireCredential();
      await this.seedContainerAuth(record, credential);
      await this.runAgent({ kind: "resume", threadId: record.codexThreadId }, record.id);
      const hardCapAt = new Date(Date.now() + record.hardCapDurationSeconds * 1000).toISOString();
      await this.scheduleHardCap(hardCapAt);
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
      try {
        await this.destroy();
      } catch {
        await this.schedule(10, "retryHardCapDestroy", record.id);
      }
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

  async vaporizeScottySession(): Promise<{ id: string; status: "gone" }> {
    const existing = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!existing) throw notFound("unknown");
    if (existing.status === "gone") return { id: existing.id, status: "gone" };
    const operation = await this.acquireOperation("vaporize", [
      "booting",
      "warm",
      "sleeping",
      "failed",
    ]);
    const record = await this.requireRecord();

    try {
      this.deleteSchedules("enforceHardCap");
      this.deleteSchedules("captureThreadId");
      await this.destroy();
      for (const backupId of new Set(record.ownedBackupIds)) {
        await this.runBackupStore(Effect.flatMap(BackupStore, (store) => store.delete(backupId)));
      }
      await this.runCredentialVault(Effect.flatMap(CredentialVault, (vault) => vault.delete));
      const gone: SessionRecord = {
        ...record,
        status: "gone",
        operation: null,
        backup: undefined,
        ownedBackupIds: [],
        backupExpiresAt: undefined,
        codexThreadId: undefined,
        failure: undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(RECORD_KEY, gone);
      await this.project(gone);
      return { id: record.id, status: "gone" };
    } catch (error) {
      await this.releaseOperation(operation.nonce);
      throw this.upstreamError("Vaporize failed", error);
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
    if (!record || record.status !== "warm") return;
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
      if (!current || current.status !== "warm" || current.codexThreadId === threadId) return;
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

    let operation: SessionRecord["operation"];
    try {
      operation = await this.acquireOperation("snapshot", ["warm", "booting"]);
      await this.checkpoint(operation.nonce, false, false);
      await this.stopAfterCheckpoint(operation.nonce);
    } catch {
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
      if (operation) await this.releaseOperationIfHeld(operation.nonce);
      console.error("Managed idle checkpoint failed", {
        sessionId: record.id,
        error: errorName(error),
      });
    }
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (
      !record ||
      record.status === "sleeping" ||
      record.status === "failed" ||
      record.status === "gone"
    )
      return;
    if (record.operation?.kind === "vaporize" || record.operation?.kind === "snapshot") return;
    const failed: SessionRecord = {
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
    await this.ctx.storage.put(RECORD_KEY, failed);
    await this.project(failed);
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
        operation: releaseLease ? null : current.operation,
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
    try {
      await this.stop();
    } catch (error) {
      await this.exec(resumeAgentCommand(), { timeout: 10_000 }).catch(() => undefined);
      throw error;
    }
    return this.updateForOperation(nonce, (record) => ({
      ...record,
      status: "sleeping",
      operation: null,
      failure: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  private async scheduleHardCap(hardCapAt: string): Promise<void> {
    this.deleteSchedules("enforceHardCap");
    await this.schedule(new Date(hardCapAt), "enforceHardCap", {
      hardCapAt,
    } satisfies HardCapPayload);
  }
  private async acquireOperation(
    kind: OperationKind,
    allowed: SessionStatus[],
  ): Promise<NonNullable<SessionRecord["operation"]>> {
    return this.runSessionStore(
      Effect.flatMap(SessionStore, (store) =>
        store.acquireOperation(kind, allowed, crypto.randomUUID()),
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
    if (!record || record.id !== sessionId || record.status !== "failed") return;
    try {
      await this.destroy();
    } catch {
      await this.schedule(10, "retryHardCapDestroy", sessionId);
    }
  }

  private async markHardCapFailure(record: SessionRecord, message: string): Promise<void> {
    const failed: SessionRecord = {
      ...record,
      status: "failed",
      operation: null,
      failure: {
        code: "hard_cap_checkpoint_failed",
        message,
        recoverable: Boolean(record.backup?.current),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(RECORD_KEY, failed);
    await this.project(failed);
    try {
      await this.destroy();
    } catch {
      await this.schedule(10, "retryHardCapDestroy", record.id);
    }
  }

  private async requireRecord(): Promise<SessionRecord> {
    return this.runSessionStore(Effect.flatMap(SessionStore, (store) => store.requireRecord));
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

  private async runBackupStore<A>(
    program: Effect.Effect<A, BackupStoreFailure, BackupStore>,
  ): Promise<A> {
    const layer = backupStoreLayer({
      createBackup: (options) => this.createBackup(options),
      restoreBackup: (backup) => this.restoreBackup(backup),
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
      exec: (command, options) => this.exec(command, options),
      createSession: (options) => this.createSession(options),
      deleteSession: (sessionId) => this.deleteSession(sessionId),
      mkdir: (path, options) => this.mkdir(path, options),
      writeFile: (path, content) => this.writeFile(path, content),
      setEnvVars: (envVars) => this.setEnvVars(envVars),
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

function pauseAgentCommand(): string {
  return 'pid=$(tmux list-panes -t agent -F \'#{pane_pid}\' 2>/dev/null | head -1); [ -z "$pid" ] && exit 1; pgid=$(ps -o pgid= -p "$pid" | tr -d \' \'); [ -z "$pgid" ] && exit 1; kill -STOP -- -"$pgid"';
}

function resumeAgentCommand(): string {
  return 'pid=$(tmux list-panes -t agent -F \'#{pane_pid}\' 2>/dev/null | head -1); [ -z "$pid" ] && exit 0; pgid=$(ps -o pgid= -p "$pid" | tr -d \' \'); [ -z "$pgid" ] || kill -CONT -- -"$pgid"';
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
