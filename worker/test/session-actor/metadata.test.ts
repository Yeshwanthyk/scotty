import { assert, describe, it } from "@effect/vitest";
import { Predicate, Result } from "effect";
import type { SessionAuthority, StableState } from "../../src/session-actor/authority";
import {
  decodeSessionActorMetadata,
  makeSessionActorMetadata,
  recordCreateObservation,
  safeSessionActorMetadata,
  scrubSettledCreatePrivateInput,
  type SessionActorMetadata,
  type SessionActorMetadataInput,
  validateSessionActorMetadata,
  validateSessionActorMetadataUpdate,
} from "../../src/session-actor/metadata";

const T0 = "2026-08-31T12:00:00.000Z";
const T1 = "2026-08-31T12:01:00.000Z";
const DEADLINE = "2026-08-31T16:00:00.000Z";
const DIGEST = "a".repeat(64);

const createAuthority = (): SessionAuthority => ({
  session: {
    id: "metadata-session",
    title: "Metadata session",
    repository: "owner/disposable",
    execution: { provider: "cloudflare", runtimeName: "runtime-metadata-session" },
    createdAt: T0,
  },
  revision: 1,
  state: {
    _tag: "Transitioning",
    transition: {
      _tag: "Create",
      nonce: "create-nonce",
      origin: "Absent",
      attempt: "create-attempt-1",
      startedAt: T0,
      lastProgressAt: T0,
      deadlineAt: DEADLINE,
      mode: "executing",
      phase: "IntentCommitted",
      proof: {
        workspaceId: null,
        readiness: { runtime: null, supervisor: null, transport: null },
      },
    },
  },
});

const input = (): SessionActorMetadataInput => ({
  branch: "scotty/metadata-session",
  createRepositoryIfMissing: false,
  hardCap: {
    durationSeconds: 4 * 60 * 60,
    deadlineAt: DEADLINE,
    generation: "hard-cap-generation-1",
  },
  createIdempotency: { keyDigest: "b".repeat(64), inputDigest: "c".repeat(64) },
  payload: { reference: "private-payload-reference-1" },
  initialPrompt: "Keep this prompt private and scrub it after create settles.",
});

const metadata = (): SessionActorMetadata => {
  const result = makeSessionActorMetadata(createAuthority(), input());
  assert.ok(Result.isSuccess(result));
  return result.success;
};

const stableAuthority = (stable: StableState): SessionAuthority => ({
  ...createAuthority(),
  revision: 2,
  state: { _tag: "Stable", stable },
});

const warm = (): StableState => ({
  _tag: "Warm",
  readiness: {
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
  },
  backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
  activity: null,
});

describe("session actor companion metadata", () => {
  it("decodes exact safe-reference metadata and rejects excess or credential plaintext fields", () => {
    const value = metadata();
    assert.ok(Result.isSuccess(decodeSessionActorMetadata(value)));
    assert.ok(Result.isFailure(decodeSessionActorMetadata({ ...value, status: "warm" })));
    assert.ok(
      Result.isFailure(
        decodeSessionActorMetadata({
          ...value,
          createObservations: {
            ...value.createObservations,
            credentialGrants: {
              attempt: "create-attempt-1",
              payloadReference: "private-payload-reference-1",
              observedAt: T1,
              grants: [
                {
                  name: "github",
                  kind: "github-cli",
                  versionRef: "github-version-1",
                  handleSlots: [{ provider: "github", slot: "git-https" }],
                  token: "secret-token",
                },
              ],
            },
          },
        }),
      ),
    );
    assert.ok(
      Result.isFailure(
        decodeSessionActorMetadata({
          ...value,
          privateCreateInput: { ...value.privateCreateInput, rawEnv: { TOKEN: "secret" } },
        }),
      ),
    );
  });

  it("requires authority identity and create-attempt consistency", () => {
    const value = metadata();
    const mismatchedIdentity = {
      ...createAuthority(),
      session: { ...createAuthority().session, id: "another-session" },
    };
    assert.ok(Result.isFailure(validateSessionActorMetadata(mismatchedIdentity, value)));

    const mismatchedAttempt = createAuthority();
    const state = mismatchedAttempt.state;
    assert.ok(Predicate.isTagged(state, "Transitioning"));
    const changed = {
      ...mismatchedAttempt,
      state: {
        _tag: "Transitioning" as const,
        transition: { ...state.transition, attempt: "create-attempt-2" },
      },
    };
    assert.ok(Result.isFailure(validateSessionActorMetadata(changed, value)));
  });

  it("scrubs the prompt and opaque payload when create settles", () => {
    for (const stable of [
      warm(),
      {
        _tag: "Failed" as const,
        code: "create_failed",
        actionable: false,
        origin: "Absent" as const,
        lastStable: null,
        backup: null,
        ownedBackupIds: [],
        wakeSource: null,
      },
      {
        _tag: "Gone" as const,
        cleanup: {
          absent: [
            "runtime" as const,
            "backups" as const,
            "evidence" as const,
            "grants" as const,
            "hatch" as const,
            "idempotency" as const,
            "schedules" as const,
          ],
          lastObservedAt: T1,
        },
      },
    ]) {
      const authority = stableAuthority(stable);
      assert.ok(Result.isFailure(validateSessionActorMetadata(authority, metadata())));
      const scrubbed = scrubSettledCreatePrivateInput(authority, metadata());
      assert.ok(Result.isSuccess(scrubbed));
      assert.strictEqual(scrubbed.success.privateCreateInput, null);
    }
  });

  it("fences provider observations by the current create attempt and opaque reference", () => {
    const authority = createAuthority();
    const value = metadata();
    const observation = {
      _tag: "Workspace" as const,
      value: {
        attempt: "create-attempt-1",
        payloadReference: "private-payload-reference-1",
        observedAt: T1,
        workspaceId: "workspace-1",
        repository: "owner/disposable",
        defaultBranch: "main",
        repositoryExists: true,
      },
    };
    const recorded = recordCreateObservation(authority, value, observation);
    assert.ok(Result.isSuccess(recorded));
    assert.deepStrictEqual(
      recordCreateObservation(authority, recorded.success, observation),
      recorded,
    );
    assert.ok(
      Result.isFailure(
        recordCreateObservation(authority, value, {
          ...observation,
          value: { ...observation.value, attempt: "stale-attempt" },
        }),
      ),
    );
    assert.ok(
      Result.isFailure(
        recordCreateObservation(authority, recorded.success, {
          ...observation,
          value: { ...observation.value, workspaceId: "workspace-conflict" },
        }),
      ),
    );
  });

  it("rejects immutable config changes and observation rollback", () => {
    const authority = createAuthority();
    const value = metadata();
    assert.ok(
      Result.isFailure(
        validateSessionActorMetadataUpdate(authority, value, {
          ...value,
          branch: "scotty/changed-branch",
        }),
      ),
    );
    const recorded = recordCreateObservation(authority, value, {
      _tag: "Bundle",
      value: {
        attempt: "create-attempt-1",
        payloadReference: "private-payload-reference-1",
        observedAt: T1,
        digest: DIGEST,
      },
    });
    assert.ok(Result.isSuccess(recorded));
    assert.ok(
      Result.isFailure(validateSessionActorMetadataUpdate(authority, recorded.success, value)),
    );
  });

  it("projects no prompt, opaque payload reference, grant slots, or version references", () => {
    const observed = recordCreateObservation(createAuthority(), metadata(), {
      _tag: "CredentialGrants",
      value: {
        attempt: "create-attempt-1",
        payloadReference: "private-payload-reference-1",
        observedAt: T1,
        grants: [
          {
            name: "github",
            kind: "github-cli",
            versionRef: "github-version-1",
            handleSlots: [{ provider: "github", slot: "git-https" }],
          },
        ],
      },
    });
    assert.ok(Result.isSuccess(observed));
    const projection = safeSessionActorMetadata(observed.success);
    const serialized = JSON.stringify(projection);
    assert.strictEqual(projection.credentialGrantCount, 1);
    assert.ok(!serialized.includes(input().initialPrompt));
    assert.ok(!serialized.includes(input().payload.reference));
    assert.ok(!serialized.includes("github-version-1"));
    assert.ok(!serialized.includes("git-https"));
    assert.ok(!serialized.includes('"status"'));
    assert.ok(!serialized.includes('"phase"'));
  });
});
