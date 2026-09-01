import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import type { SessionAuthority } from "../../src/session-actor/authority";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import {
  SessionActorProjectionUnavailable,
  sessionProjectionFromActor,
  sessionViewFromActor,
} from "../../src/session-actor/public-view";

const CREATED_AT = "2026-08-31T12:00:00.000Z";
const UPDATED_AT = "2026-08-31T12:02:00.000Z";
const HARD_CAP_AT = "2026-08-31T16:00:00.000Z";
const PROJECTED_AT = {
  iso: "2026-08-31T13:00:00.000Z",
  epochMillis: Date.parse("2026-08-31T13:00:00.000Z"),
};
const DIGEST = "a".repeat(64);

const identity = {
  id: "public-session",
  title: "Public session",
  repository: "owner/disposable",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-public-session" },
  createdAt: CREATED_AT,
};

const readiness = {
  runtime: {
    providerRuntimeId: "provider-runtime-1",
    runtimeGeneration: "runtime-generation-1",
    containerIncarnation: "container-incarnation-1",
  },
  supervisor: {
    processId: "supervisor-process-1",
    supervisorEpoch: "supervisor-epoch-1",
    runtimeGeneration: "runtime-generation-1",
    containerIncarnation: "container-incarnation-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch: "supervisor-epoch-1",
    runtimeGeneration: "runtime-generation-1",
    containerIncarnation: "container-incarnation-1",
  },
};

const metadata = (workspaceObserved = true): SessionActorMetadata => ({
  sessionId: identity.id,
  repository: identity.repository,
  branch: "scotty/public-session",
  createRepositoryIfMissing: false,
  hardCap: { durationSeconds: 14_400, deadlineAt: HARD_CAP_AT, generation: "cap-1" },
  createIdempotency: null,
  createAttempt: "create-attempt-1",
  privateCreateInput: null,
  createObservations: {
    workspace: workspaceObserved
      ? {
          attempt: "create-attempt-1",
          payloadReference: "payload-1",
          observedAt: UPDATED_AT,
          workspaceId: "workspace-1",
          repository: "owner/disposable",
          defaultBranch: "main",
          repositoryExists: true,
        }
      : null,
    bundle: {
      attempt: "create-attempt-1",
      payloadReference: "payload-1",
      observedAt: UPDATED_AT,
      digest: DIGEST,
    },
    credentialGrants: null,
  },
});

const createAuthority = (): SessionAuthority => ({
  session: identity,
  revision: 1,
  state: {
    _tag: "Transitioning",
    transition: {
      _tag: "Create",
      nonce: "create-nonce",
      origin: "Absent",
      attempt: "create-attempt-1",
      startedAt: CREATED_AT,
      lastProgressAt: CREATED_AT,
      deadlineAt: UPDATED_AT,
      mode: "executing",
      phase: "WorkspacePreparing",
      proof: {
        workspaceId: null,
        readiness: { runtime: null, supervisor: null, transport: null },
      },
    },
  },
});

const warmAuthority = (): SessionAuthority => ({
  session: identity,
  revision: 7,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: {
        ownedBackupIds: ["backup-1"],
        prepared: {
          backupId: "backup-1",
          preparedAt: CREATED_AT,
          confirmedAt: UPDATED_AT,
          sourceRuntimeGeneration: "runtime-generation-1",
        },
        currentBackupId: "backup-1",
      },
      activity: {
        activityGeneration: "activity-1",
        runtimeGeneration: "runtime-generation-1",
        supervisorEpoch: "supervisor-epoch-1",
        state: "working",
        observedAt: UPDATED_AT,
        freshUntil: HARD_CAP_AT,
      },
    },
  },
});

describe("session actor public projection", () => {
  it("does not guess a default branch before the workspace observation", () => {
    const result = sessionProjectionFromActor(
      createAuthority(),
      metadata(false),
      UPDATED_AT,
      PROJECTED_AT,
    );
    assert.ok(Result.isFailure(result));
    assert.deepStrictEqual(
      result.failure,
      new SessionActorProjectionUnavailable({ code: "workspace_not_observed" }),
    );
  });

  it("projects a complete Warm session without storing public status", () => {
    const result = sessionViewFromActor(warmAuthority(), metadata(), UPDATED_AT, PROJECTED_AT);
    assert.ok(Result.isSuccess(result));
    assert.deepInclude(result.success, {
      id: "public-session",
      status: "warm",
      repo: "owner/disposable",
      defaultBranch: "main",
      branch: "scotty/public-session",
      backupId: "backup-1",
      hardCapAt: HARD_CAP_AT,
      sandboxBundle: { digest: DIGEST },
      ageSeconds: 3600,
      capRemainingSeconds: 10_800,
    });
  });

  it("derives create failure only after workspace metadata is available", () => {
    const failed: SessionAuthority = {
      session: identity,
      revision: 6,
      state: {
        _tag: "Stable",
        stable: {
          _tag: "Failed",
          code: "create_transport_failed",
          actionable: false,
          origin: "Absent",
          lastStable: null,
          backup: null,
          ownedBackupIds: [],
          wakeSource: null,
        },
      },
    };
    const result = sessionProjectionFromActor(failed, metadata(), UPDATED_AT, PROJECTED_AT);
    assert.ok(Result.isSuccess(result));
    assert.deepInclude(result.success, {
      status: "failed",
      failure: {
        code: "create_transport_failed",
        message: "create_transport_failed",
        recoverable: false,
      },
    });
  });

  it("publishes fenced activity only from coherent Warm authority", () => {
    const result = sessionProjectionFromActor(
      warmAuthority(),
      metadata(),
      UPDATED_AT,
      PROJECTED_AT,
    );
    assert.ok(Result.isSuccess(result));
    assert.strictEqual(result.success.status, "warm");
    assert.strictEqual(result.success.agentState, "working");
    assert.strictEqual(result.success.lastAgentEventAt, UPDATED_AT);
    assert.strictEqual(result.success.codexThreadId, undefined);
  });

  it("marks an origin-compatible Vaporize projection as deleting", () => {
    const vaporizing: SessionAuthority = {
      session: identity,
      revision: 8,
      state: {
        _tag: "Transitioning",
        transition: {
          _tag: "Vaporize",
          nonce: "vaporize-nonce",
          origin: "Warm",
          attempt: "vaporize-attempt",
          startedAt: UPDATED_AT,
          lastProgressAt: UPDATED_AT,
          deadlineAt: HARD_CAP_AT,
          mode: "executing",
          phase: "RuntimeAccessRevoked",
          proof: {
            revokedAt: UPDATED_AT,
            cleanup: { absent: [], lastObservedAt: UPDATED_AT },
          },
        },
      },
    };
    const result = sessionProjectionFromActor(vaporizing, metadata(), UPDATED_AT, PROJECTED_AT);
    assert.ok(Result.isSuccess(result));
    assert.strictEqual(result.success.status, "warm");
    assert.strictEqual(result.success.deleting, true);
  });
});
