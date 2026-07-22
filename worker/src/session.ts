import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Result } from "effect";
import { BackupStore, type BackupStoreFailure, backupStoreLayer } from "./backup-store";
import type { Bindings } from "./bindings";
import {
  conflict,
  notFound,
  SESSION_ROOT,
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
  decodeCredentialPatch,
  decodeStoredCredential,
  GITHUB_SENTINEL_PREFIX,
  denyOutbound,
  parseCodexCredential,
  passThrough,
  proxyChatGpt,
  proxyGitHub,
  proxyOAuthRefresh,
  proxyOpenAI,
  sentinelAuthJson,
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
  kvSessionProjectionStorage,
  projectSessionBestEffort,
  sessionProjectionLayer,
} from "./session-projection";

const RECORD_KEY = "scotty:session";
const CREDENTIAL_KEY = "scotty:credential";
const WEB_SESSION_ID = "scotty-web";
const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const HARD_CAP_GRACE_MS = 30_000;

interface HardCapPayload {
  hardCapAt: string;
}

interface WorktreeResult {
  defaultBranch: string;
  repoExists: boolean;
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
      const worktree = await this.prepareWorktree(initial, credential.githubSentinel);
      await this.seedContainerAuth(initial, credential);
      await this.startAgent(initial, input.prompt);
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
      await this.startAgent(record, undefined, record.codexThreadId, true);
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
    const env = this.agentEnv(record, credential);
    const root = this.sessionRoot(record.id);
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
    const root = this.sessionRoot(record.id);

    try {
      const sha = (
        await this.execChecked(`git -C ${shellQuote(root)} rev-parse HEAD`)
      ).stdout.trim();
      const rollout = await this.findNewestRollout(record.id);
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
      await this.ctx.storage.delete(CREDENTIAL_KEY);
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
    const stored = await this.ctx.storage.get(CREDENTIAL_KEY);
    if (stored === undefined) return null;
    const credential = decodeStoredCredential(stored);
    if (sentinel !== credential.codexSentinel && sentinel !== credential.githubSentinel)
      return null;
    return credential;
  }

  async beginCredentialRefresh(sentinel: string): Promise<CredentialRefreshLease | null> {
    let result: CredentialRefreshLease | null = null;
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get(CREDENTIAL_KEY);
      if (stored === undefined) return;
      const credential = decodeStoredCredential(stored);
      if (credential.codexSentinel !== sentinel || !credential.codex.tokens?.refresh_token) return;
      if (
        credential.refreshLease &&
        Date.now() - Date.parse(credential.refreshLease.startedAt) < 60_000
      )
        return;
      const nonce = crypto.randomUUID();
      const next: StoredCredential = {
        ...credential,
        refreshLease: { nonce, startedAt: new Date().toISOString() },
      };
      await transaction.put(CREDENTIAL_KEY, next);
      result = { credential: next, nonce };
    });
    return result;
  }

  async persistRotatedCredential(
    sentinel: string,
    patch: CredentialPatch,
    nonce: string,
  ): Promise<void> {
    const decodedPatch = decodeCredentialPatch(patch);
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get(CREDENTIAL_KEY);
      // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native credential RPC callback preserves its existing Promise rejection contract until Chunk 5
      if (stored === undefined) throw new Error("Session credential bundle is missing");
      const credential = decodeStoredCredential(stored);
      // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native credential RPC callback preserves its existing Promise rejection contract until Chunk 5
      if (credential.codexSentinel !== sentinel) throw new Error("Credential sentinel mismatch");
      if (credential.refreshLease?.nonce !== nonce)
        // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native credential RPC callback preserves its existing Promise rejection contract until Chunk 5
        throw new Error("Credential refresh lease mismatch");
      const tokens = credential.codex.tokens;
      // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native credential RPC callback preserves its existing Promise rejection contract until Chunk 5
      if (!tokens) throw new Error("Credential is not refreshable");
      const { refreshLease: _refreshLease, ...withoutLease } = credential;
      const next: StoredCredential = {
        ...withoutLease,
        codex: {
          ...credential.codex,
          tokens: {
            ...tokens,
            id_token: decodedPatch.idToken ?? tokens.id_token,
            access_token: decodedPatch.accessToken ?? tokens.access_token,
            refresh_token: decodedPatch.refreshToken ?? tokens.refresh_token,
          },
          last_refresh: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(CREDENTIAL_KEY, next);
    });
  }

  async cancelCredentialRefresh(sentinel: string, nonce: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get(CREDENTIAL_KEY);
      if (stored === undefined) return;
      const credential = decodeStoredCredential(stored);
      if (credential.codexSentinel !== sentinel || credential.refreshLease?.nonce !== nonce) return;
      const { refreshLease: _refreshLease, ...next } = credential;
      await transaction.put(CREDENTIAL_KEY, next);
    });
  }

  async captureThreadId(payload: { attempt?: number } = {}): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (!record || record.status !== "warm") return;
    const threadId = await this.discoverThreadId(record.id);
    if (!threadId) {
      const attempt = payload.attempt ?? 0;
      if (attempt < 11) await this.schedule(5, "captureThreadId", { attempt: attempt + 1 });
      return;
    }
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
    const existing = await this.ctx.storage.get(CREDENTIAL_KEY);
    if (existing !== undefined) return decodeStoredCredential(existing);
    const now = new Date().toISOString();
    const credential: StoredCredential = {
      codex: parseCodexCredential(this.env.CODEX_AUTH_JSON),
      codexSentinel: `${CODEX_SENTINEL_PREFIX}${id}-${randomToken(12)}`,
      githubSentinel: `${GITHUB_SENTINEL_PREFIX}${id}-${randomToken(12)}`,
      updatedAt: now,
    };
    await this.ctx.storage.put(CREDENTIAL_KEY, credential);
    return credential;
  }

  private async requireCredential(): Promise<StoredCredential> {
    const credential = await this.ctx.storage.get(CREDENTIAL_KEY);
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: native credential host adapter preserves its existing Promise rejection contract until Chunk 5
    if (credential === undefined) throw new Error("Session credential bundle is missing");
    return decodeStoredCredential(credential);
  }

  private async prepareWorktree(
    record: SessionRecord,
    githubSentinel: string,
  ): Promise<WorktreeResult> {
    const root = this.sessionRoot(record.id);
    const url = `https://github.com/${record.repo}.git`;
    const env = { GH_TOKEN: githubSentinel, GIT_TERMINAL_PROMPT: "0" };
    const repoView = await this.exec(
      `gh repo view ${shellQuote(record.repo)} --json defaultBranchRef --jq '.defaultBranchRef.name'`,
      { env, timeout: 60_000 },
    );

    await this.execChecked(`rm -rf ${shellQuote(root)} && mkdir -p ${shellQuote(SESSION_ROOT)}`);
    if (!repoView.success || !repoView.stdout.trim()) {
      await this.execChecked(
        `git init -b main ${shellQuote(root)} && git -C ${shellQuote(root)} remote add origin ${shellQuote(url)} && git -C ${shellQuote(root)} checkout -b ${shellQuote(record.branch)}`,
        { env },
      );
      await this.configureGitCredentialHelper(root);
      return { defaultBranch: "main", repoExists: false };
    }

    const defaultBranch = repoView.stdout.trim();
    const cache =
      record.repo === "anomalyco/rift" ? "/cache/rift.git" : `/tmp/scotty-cache-${record.id}.git`;
    const basic = btoa(`x-access-token:${githubSentinel}`);
    if (record.repo !== "anomalyco/rift") {
      await this.execChecked(
        `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} clone --bare ${shellQuote(url)} ${shellQuote(cache)}`,
        { env, timeout: 180_000 },
      );
    }
    await this.execChecked(
      `git -c http.extraHeader=${shellQuote(`Authorization: Basic ${basic}`)} -C ${shellQuote(cache)} fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
      { env, timeout: 180_000 },
    );
    await this.execChecked(
      `git -C ${shellQuote(cache)} worktree add -B ${shellQuote(record.branch)} ${shellQuote(root)} ${shellQuote(`refs/remotes/origin/${defaultBranch}`)}`,
      { env, timeout: 120_000 },
    );
    await this.configureGitCredentialHelper(root);
    return { defaultBranch, repoExists: true };
  }

  private async configureGitCredentialHelper(root: string): Promise<void> {
    const helper = "!f() { echo username=x-access-token; echo password=$GITHUB_SENTINEL; }; f";
    await this.execChecked(
      `git -C ${shellQuote(root)} config credential.helper ${shellQuote(helper)} && git -C ${shellQuote(root)} config credential.useHttpPath true && exclude=$(git -C ${shellQuote(root)} rev-parse --git-path info/exclude) && { grep -qxF '.codex/' "$exclude" 2>/dev/null || printf '.codex/\\n' >> "$exclude"; }`,
    );
  }

  private async seedContainerAuth(
    record: SessionRecord,
    credential: StoredCredential,
  ): Promise<void> {
    const root = this.sessionRoot(record.id);
    const codexHome = `${root}/.codex`;
    await this.mkdir(codexHome, { recursive: true });
    await this.writeFile(`${codexHome}/auth.json`, sentinelAuthJson(credential));
    await this.execChecked(
      `chmod 700 ${shellQuote(codexHome)} && chmod 600 ${shellQuote(`${codexHome}/auth.json`)}`,
    );
    await this.setEnvVars(this.agentEnv(record, credential));
  }

  private async startAgent(
    record: SessionRecord,
    prompt?: string,
    resumeThreadId?: string,
    resume = false,
  ): Promise<void> {
    const root = this.sessionRoot(record.id);
    const credential = await this.requireCredential();
    const env = this.agentEnv(record, credential);
    await this.exec("tmux kill-session -t agent 2>/dev/null || true", { env });

    let agentCommand: string;
    if (this.env.SCOTTY_FAKE_AGENT === "1") {
      agentCommand = `printf '\\033[1;36mScotty fake agent ready\\033[0m\\n'; exec bash`;
    } else if (resume) {
      agentCommand = resumeThreadId
        ? `exec codex --dangerously-bypass-approvals-and-sandbox resume ${shellQuote(resumeThreadId)}`
        : "exec codex --dangerously-bypass-approvals-and-sandbox resume --last";
    } else {
      agentCommand = `exec codex --dangerously-bypass-approvals-and-sandbox ${shellQuote(prompt ?? "")}`;
    }

    await this.execChecked(
      `tmux new-session -d -s agent -c ${shellQuote(root)} ${shellQuote(agentCommand)}`,
      { env, timeout: 30_000 },
    );
    await this.deleteSession(WEB_SESSION_ID).catch(() => undefined);
    await this.createSession({ id: WEB_SESSION_ID, cwd: root, env });
  }

  private agentEnv(record: SessionRecord, credential: StoredCredential): Record<string, string> {
    return {
      CODEX_HOME: `${this.sessionRoot(record.id)}/.codex`,
      OPENAI_API_KEY: credential.codexSentinel,
      GH_TOKEN: credential.githubSentinel,
      GITHUB_SENTINEL: credential.githubSentinel,
      GIT_TERMINAL_PROMPT: "0",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
  }

  private async checkpoint(
    nonce: string,
    resumeAgent: boolean,
    releaseLease = resumeAgent,
  ): Promise<SessionRecord> {
    const record = await this.requireRecord();
    const root = this.sessionRoot(record.id);
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
            localBucket: this.env.SCOTTY_LOCAL_BACKUP === "1",
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

  private async discoverThreadId(id: string): Promise<string | undefined> {
    const rollout = await this.findNewestRollout(id);
    if (!rollout) return undefined;
    return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.exec(
      basename(rollout),
    )?.[0];
  }

  private async findNewestRollout(id: string): Promise<string | undefined> {
    const codexHome = `${this.sessionRoot(id)}/.codex`;
    const result = await this.exec(
      `find ${shellQuote(`${codexHome}/sessions`)} -type f -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-`,
      { timeout: 15_000 },
    );
    return result.success && result.stdout.trim() ? result.stdout.trim() : undefined;
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

  private async execChecked(
    command: string,
    options: { env?: Record<string, string>; timeout?: number } = {},
  ): Promise<ExecResult> {
    const result = await this.exec(command, options);
    // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: official Sandbox SDK command adapter preserves its existing Promise rejection contract until Chunk 6
    if (!result.success) throw new Error(redactCommandFailure(result.stderr || result.stdout));
    return result;
  }

  private sessionRoot(id: string): string {
    return `${SESSION_ROOT}/${id}`;
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

Sandbox.outboundByHost = {
  "api.openai.com": proxyOpenAI,
  "chatgpt.com": proxyChatGpt,
  "auth.openai.com": proxyOAuthRefresh,
  "github.com": proxyGitHub,
  "api.github.com": proxyGitHub,
  "codeload.github.com": passThrough,
  "objects.githubusercontent.com": passThrough,
  "raw.githubusercontent.com": passThrough,
  "registry.npmjs.org": passThrough,
  "pypi.org": passThrough,
  "files.pythonhosted.org": passThrough,
  "crates.io": passThrough,
  "static.crates.io": passThrough,
  "index.crates.io": passThrough,
};
Sandbox.outbound = denyOutbound;

function pauseAgentCommand(): string {
  return 'pid=$(tmux list-panes -t agent -F \'#{pane_pid}\' 2>/dev/null | head -1); [ -z "$pid" ] && exit 1; pgid=$(ps -o pgid= -p "$pid" | tr -d \' \'); [ -z "$pgid" ] && exit 1; kill -STOP -- -"$pgid"';
}

function resumeAgentCommand(): string {
  return 'pid=$(tmux list-panes -t agent -F \'#{pane_pid}\' 2>/dev/null | head -1); [ -z "$pid" ] && exit 0; pgid=$(ps -o pgid= -p "$pid" | tr -d \' \'); [ -z "$pgid" ] || kill -CONT -- -"$pgid"';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function redactCommandFailure(value: string): string {
  return value
    .replaceAll(/scotty-(?:codex|github)-[A-Za-z0-9-]+/gu, "[sentinel]")
    .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
    .slice(0, 1_000);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
