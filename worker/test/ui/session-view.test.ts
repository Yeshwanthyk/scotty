import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import type { SessionAuthority, ReadinessProof } from "../../src/session-actor/authority";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import {
  UiSessionListResponseSchema,
  UiSessionProjectionInvalid,
  UiSessionResponseSchema,
  uiSessionListResponseFromProjections,
  uiSessionResponseFromActor,
} from "../../src/ui/session-view";
import type { SessionView } from "../../src/session/contracts";

const CREATED_AT = "2026-09-03T12:00:00.000Z";
const UPDATED_AT = "2026-09-03T12:02:00.000Z";
const HARD_CAP_AT = "2026-09-03T16:00:00.000Z";
const NOW = Date.parse("2026-09-03T13:00:30.000Z");

const hardCap = {
  durationSeconds: 14_400,
  deadlineAt: HARD_CAP_AT,
  generation: "hard-cap-1",
};

const identity = {
  id: "session-view-test",
  title: "Session view contract",
  repository: "owner/disposable",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-session-view-test" },
  createdAt: CREATED_AT,
};

const readiness: ReadinessProof = {
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

const metadata: SessionActorMetadata = {
  sessionId: identity.id,
  repository: identity.repository,
  branch: "scotty/session-view-contract",
  createRepositoryIfMissing: false,
  hardCap,
  createIdempotency: null,
  createAttempt: "create-attempt-1",
  privateCreateInput: null,
  createObservations: {
    workspace: {
      attempt: "create-attempt-1",
      payloadReference: "payload-1",
      observedAt: UPDATED_AT,
      workspaceId: "workspace-1",
      repository: identity.repository,
      defaultBranch: "main",
      repositoryExists: true,
    },
    bundle: null,
    credentialGrants: null,
  },
};

const warmAuthority = (): SessionAuthority => ({
  session: identity,
  hardCap,
  revision: 7,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      activity: {
        supervisorEpoch: "supervisor-epoch-1",
        piSequence: 2,
        state: "working",
        observedAt: UPDATED_AT,
        expiresAt: HARD_CAP_AT,
      },
    },
  },
});

const checkpointAuthority = (): SessionAuthority => ({
  session: identity,
  hardCap,
  revision: 8,
  state: {
    _tag: "Transitioning",
    transition: {
      _tag: "Checkpoint",
      nonce: "checkpoint-nonce",
      origin: "Warm",
      attempt: "checkpoint-attempt",
      startedAt: UPDATED_AT,
      lastProgressAt: UPDATED_AT,
      deadlineAt: HARD_CAP_AT,
      mode: "reconciling",
      phase: "Syncing",
      proof: {
        readiness,
        piStoppedAt: UPDATED_AT,
        backup: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      },
    },
  },
});

const createAuthority = (): SessionAuthority => ({
  session: identity,
  hardCap,
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
      deadlineAt: HARD_CAP_AT,
      mode: "executing",
      phase: "WorkspacePreparing",
      proof: {
        workspaceId: null,
        readiness: { runtime: null, supervisor: null, transport: null },
      },
    },
  },
});

const runtimePreparationAuthority = (): SessionAuthority => ({
  session: identity,
  hardCap,
  revision: 9,
  state: {
    _tag: "Transitioning",
    transition: {
      _tag: "WarmWork",
      workKind: "RuntimePreparation",
      nonce: "runtime-preparation-nonce",
      origin: "Warm",
      attempt: "runtime-preparation-attempt",
      startedAt: UPDATED_AT,
      lastProgressAt: UPDATED_AT,
      deadlineAt: HARD_CAP_AT,
      mode: "executing",
      phase: "Running",
      proof: {
        readiness,
        backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
        activity: null,
        activityGeneration: "activity-generation-1",
        resultCode: null,
      },
    },
  },
});

const decodeResponse = Schema.decodeUnknownSync(UiSessionResponseSchema);
const decodeListResponse = Schema.decodeUnknownSync(UiSessionListResponseSchema);

const projected = (overrides: Partial<SessionView> = {}): SessionView => ({
  id: identity.id,
  title: identity.title,
  status: "warm",
  provider: "cloudflare",
  repo: identity.repository,
  defaultBranch: "main",
  branch: metadata.branch,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  hardCapAt: HARD_CAP_AT,
  projectedAt: UPDATED_AT,
  ageSeconds: 3_630,
  capRemainingSeconds: 10_770,
  sandboxBundle: { digest: null },
  ...overrides,
});

describe("UI session authority response", () => {
  it("maps stable warm authority to the v1 response without legacy fields", () => {
    const response = uiSessionResponseFromActor(warmAuthority(), metadata, NOW);

    assert.deepStrictEqual(Object.keys(response), ["version", "session"]);
    assert.deepStrictEqual(Object.keys(response.session).sort(), [
      "authority",
      "capabilities",
      "display",
      "identity",
      "runtime",
      "times",
    ]);
    assert.strictEqual(response.version, 1);
    assert.deepStrictEqual(response.session.identity, { id: identity.id });
    assert.deepStrictEqual(response.session.authority, {
      kind: "stable",
      lifecycle: "warm",
      failure: null,
    });
    assert.deepStrictEqual(response.session.capabilities, {
      checkpoint: true,
      sleep: true,
      resume: false,
      work: true,
      vaporize: true,
    });
    assert.deepStrictEqual(response.session.display, {
      title: identity.title,
      repository: identity.repository,
      branch: metadata.branch,
      defaultBranch: "main",
    });
    assert.deepStrictEqual(response.session.times, { capRemainingSeconds: 10_770 });
    assert.deepStrictEqual(decodeResponse(response), response);
  });

  it("uses canonical create and checkpoint transition discriminants", () => {
    const create = uiSessionResponseFromActor(createAuthority(), metadata, NOW);
    assert.deepStrictEqual(create.session.authority, {
      kind: "transitioning",
      action: "create",
      phase: "WorkspacePreparing",
      mode: "executing",
      startedAt: CREATED_AT,
    });
    const checkpoint = uiSessionResponseFromActor(checkpointAuthority(), metadata, NOW);
    assert.deepStrictEqual(checkpoint.session.authority, {
      kind: "transitioning",
      action: "checkpoint",
      phase: "Syncing",
      mode: "reconciling",
      startedAt: UPDATED_AT,
    });
    assert.deepStrictEqual(checkpoint.session.capabilities, {
      checkpoint: false,
      sleep: false,
      resume: false,
      work: false,
      vaporize: false,
    });
    assert.deepStrictEqual(decodeResponse(create), create);
    assert.deepStrictEqual(decodeResponse(checkpoint), checkpoint);
  });

  it("keeps runtime preparation distinct from checkpoint", () => {
    const response = uiSessionResponseFromActor(runtimePreparationAuthority(), metadata, NOW);
    assert.deepStrictEqual(response.session.authority, {
      kind: "transitioning",
      action: "work",
      phase: "Running",
      mode: "executing",
      startedAt: UPDATED_AT,
    });
    assert.deepStrictEqual(decodeResponse(response), response);
  });

  it("maps KV candidates to the same canonical session shape with explicit freshness", () => {
    const result = uiSessionListResponseFromProjections([
      projected(),
      projected({
        id: "sleeping-session",
        status: "sleeping",
        backupId: "backup-1",
        capRemainingSeconds: 0,
      }),
      projected({
        id: "checkpoint-session",
        operation: {
          kind: "snapshot",
          nonce: "checkpoint-1",
          startedAt: UPDATED_AT,
          mode: "reconciling",
          phase: "Syncing",
        },
      }),
    ]);

    assert.isTrue(Result.isSuccess(result));
    if (Result.isFailure(result)) return;
    assert.deepStrictEqual(result.success.sessions[0], {
      ...uiSessionResponseFromActor(warmAuthority(), metadata, NOW).session,
      projection: { projectedAt: UPDATED_AT },
    });
    assert.deepStrictEqual(result.success.sessions[1].authority, {
      kind: "stable",
      lifecycle: "sleeping",
      failure: null,
    });
    assert.deepStrictEqual(result.success.sessions[1].capabilities, {
      checkpoint: false,
      sleep: false,
      resume: true,
      work: false,
      vaporize: true,
    });
    assert.deepStrictEqual(result.success.sessions[2].authority, {
      kind: "transitioning",
      action: "checkpoint",
      phase: "Syncing",
      mode: "reconciling",
      startedAt: UPDATED_AT,
    });
    assert.deepStrictEqual(decodeListResponse(result.success), result.success);
  });

  it("rejects a booting candidate that lost its operation instead of inventing a state", () => {
    const result = uiSessionListResponseFromProjections([projected({ status: "booting" })]);

    assert.isTrue(Result.isFailure(result));
    if (Result.isSuccess(result)) return;
    assert.deepStrictEqual(
      result.failure,
      new UiSessionProjectionInvalid({
        sessionId: identity.id,
        reason: "booting_without_operation",
      }),
    );
  });
});
