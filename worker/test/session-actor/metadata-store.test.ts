import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import {
  AuthorityStateSchema,
  type SessionAuthority,
  type StableState,
} from "../../src/session-actor/authority";
import {
  makeSessionActorMetadataStore,
  MetadataStoreConflict,
  MetadataStoreCorrupt,
  MetadataStoreMutationOutcomeUnknown,
  type MetadataStorageMutation,
  type MetadataStoragePort,
} from "../../src/session-actor/metadata-store";
import type { SessionActorMetadataInput } from "../../src/session-actor/metadata";

const T0 = "2026-08-31T12:00:00.000Z";
const T1 = "2026-08-31T12:01:00.000Z";
const DEADLINE = "2026-08-31T16:00:00.000Z";
const hardCap = {
  durationSeconds: 4 * 60 * 60,
  deadlineAt: DEADLINE,
  generation: "hard-cap-generation-1",
};

const createAuthority = (): SessionAuthority => ({
  session: {
    id: "metadata-store-session",
    title: "Metadata store session",
    repository: "owner/disposable",
    execution: { provider: "cloudflare", runtimeName: "runtime-metadata-store-session" },
    createdAt: T0,
  },
  hardCap,
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
  branch: "scotty/metadata-store-session",
  createRepositoryIfMissing: false,
  hardCap,
  createIdempotency: { keyDigest: "b".repeat(64), inputDigest: "c".repeat(64) },
  payload: { reference: "private-payload-reference-1" },
  initialPrompt: "This prompt must be scrubbed when create settles.",
});

const failed = (): StableState => ({
  _tag: "Failed",
  code: "create_failed",
  actionable: false,
  origin: "Absent",
  lastStable: null,
  backup: null,
  ownedBackupIds: [],
  wakeSource: null,
});

const stableAuthority = (): SessionAuthority => ({
  ...createAuthority(),
  revision: 2,
  state: { _tag: "Stable", stable: failed() },
});

interface FakeMetadataStorage extends MetadataStoragePort {
  readonly inspect: () => unknown | undefined;
  readonly writeCount: () => number;
  readonly rejectNextMutationAfterApply: () => void;
}

const fakeStorage = (initial?: unknown): FakeMetadataStorage => {
  let stored = initial;
  let writes = 0;
  let rejectAfterApply = false;
  return {
    read: () => Promise.resolve(stored),
    transaction: (decide) => {
      const mutation: MetadataStorageMutation = decide(stored);
      if (Predicate.isTagged(mutation, "Put")) {
        stored = mutation.value;
        writes += 1;
      }
      if (rejectAfterApply) {
        rejectAfterApply = false;
        return Promise.reject(new Error("simulated lost transaction response"));
      }
      return Promise.resolve(mutation.outcome);
    },
    inspect: () => stored,
    writeCount: () => writes,
    rejectNextMutationAfterApply: () => {
      rejectAfterApply = true;
    },
  };
};

describe("session actor metadata store", () => {
  it.effect("admits once and replays only matching safe idempotency digests", () =>
    Effect.gen(function* () {
      const port = fakeStorage();
      const store = makeSessionActorMetadataStore(port);

      const missing = yield* store.inspectCreate(createAuthority(), input());
      assert.ok(Predicate.isTagged(missing, "Missing"));

      const created = yield* store.admitCreate(createAuthority(), input());
      assert.ok(Predicate.isTagged(created, "Created"));
      assert.equal(port.writeCount(), 1);

      const replay = yield* store.admitCreate(createAuthority(), input());
      assert.ok(Predicate.isTagged(replay, "IdempotentReplay"));
      assert.equal(port.writeCount(), 1);

      const nextRequest = createAuthority();
      assert.ok(AuthorityStateSchema.guards.Transitioning(nextRequest.state));
      if (!AuthorityStateSchema.guards.Transitioning(nextRequest.state)) return;
      const replayWithNewAttempt = yield* store.admitCreate(
        {
          ...nextRequest,
          state: {
            _tag: "Transitioning",
            transition: {
              ...nextRequest.state.transition,
              nonce: "create-nonce-2",
              attempt: "create-attempt-2",
            },
          },
        },
        input(),
      );
      assert.ok(Predicate.isTagged(replayWithNewAttempt, "IdempotentReplay"));
      assert.equal(replayWithNewAttempt.metadata.createAttempt, "create-attempt-1");
      assert.equal(port.writeCount(), 1);

      const inspected = yield* store.inspectCreate(nextRequest, input());
      assert.ok(Predicate.isTagged(inspected, "Existing"));
      assert.equal(inspected.metadata.createAttempt, "create-attempt-1");

      const conflict = yield* Effect.flip(
        store.admitCreate(createAuthority(), {
          ...input(),
          createIdempotency: {
            keyDigest: input().createIdempotency?.keyDigest ?? "",
            inputDigest: "d".repeat(64),
          },
        }),
      );
      assert.ok(Predicate.isTagged(conflict, "MetadataStoreConflict"));
      assert.equal(conflict.code, "idempotency_input_conflict");
      assert.equal(port.writeCount(), 1);
    }),
  );

  it.effect("rejects corrupt unknown storage before domain use", () =>
    Effect.gen(function* () {
      const store = makeSessionActorMetadataStore(fakeStorage({ status: "warm" }));
      const failure = yield* Effect.flip(store.read(createAuthority()));
      assert.ok(failure instanceof MetadataStoreCorrupt);
      assert.equal(failure.operation, "read");
    }),
  );

  it.effect("records fenced observations monotonically and makes exact duplicates no-ops", () =>
    Effect.gen(function* () {
      const port = fakeStorage();
      const store = makeSessionActorMetadataStore(port);
      yield* store.admitCreate(createAuthority(), input());
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

      const recorded = yield* store.recordObservation(createAuthority(), observation);
      assert.ok(Predicate.isTagged(recorded, "ObservationRecorded"));
      assert.equal(port.writeCount(), 2);

      const replay = yield* store.recordObservation(createAuthority(), observation);
      assert.ok(Predicate.isTagged(replay, "ObservationReplay"));
      assert.equal(port.writeCount(), 2);

      const conflict = yield* Effect.flip(
        store.recordObservation(createAuthority(), {
          ...observation,
          value: { ...observation.value, workspaceId: "workspace-2" },
        }),
      );
      assert.ok(Predicate.isTagged(conflict, "SessionActorMetadataViolation"));
      assert.equal(conflict.code, "create_observation_conflict");
      assert.equal(port.writeCount(), 2);
    }),
  );

  it.effect("rejects stale observation fences without mutating metadata", () =>
    Effect.gen(function* () {
      const port = fakeStorage();
      const store = makeSessionActorMetadataStore(port);
      yield* store.admitCreate(createAuthority(), input());
      const failure = yield* Effect.flip(
        store.recordObservation(createAuthority(), {
          _tag: "Bundle",
          value: {
            attempt: "stale-attempt",
            payloadReference: "private-payload-reference-1",
            observedAt: T1,
            digest: "a".repeat(64),
          },
        }),
      );
      assert.ok(Predicate.isTagged(failure, "SessionActorMetadataViolation"));
      assert.equal(failure.code, "create_observation_fence_mismatch");
      assert.equal(port.writeCount(), 1);
    }),
  );

  it.effect("scrubs private prompt and payload after authority settles", () =>
    Effect.gen(function* () {
      const port = fakeStorage();
      const store = makeSessionActorMetadataStore(port);
      yield* store.admitCreate(createAuthority(), input());

      const scrubbed = yield* store.scrubSettledCreate(stableAuthority());
      assert.ok(Predicate.isTagged(scrubbed, "PrivateInputScrubbed"));
      assert.strictEqual(scrubbed.metadata.privateCreateInput, null);

      const read = yield* store.read(stableAuthority());
      assert.strictEqual(read?.privateCreateInput, null);
      const replay = yield* store.scrubSettledCreate(stableAuthority());
      assert.ok(Predicate.isTagged(replay, "PrivateInputAlreadyScrubbed"));
      assert.equal(port.writeCount(), 2);
    }),
  );

  it.effect("reports an applied mutation with a lost response as outcome unknown", () =>
    Effect.gen(function* () {
      const port = fakeStorage();
      const store = makeSessionActorMetadataStore(port);
      port.rejectNextMutationAfterApply();

      const failure = yield* Effect.flip(store.admitCreate(createAuthority(), input()));
      assert.ok(failure instanceof MetadataStoreMutationOutcomeUnknown);
      assert.equal(failure.operation, "admit");
      assert.equal(port.writeCount(), 1);

      const observed = yield* store.read(createAuthority());
      assert.equal(observed?.sessionId, "metadata-store-session");
    }),
  );

  it.effect("fails an observation when companion metadata is absent", () =>
    Effect.gen(function* () {
      const store = makeSessionActorMetadataStore(fakeStorage());
      const failure = yield* Effect.flip(
        store.recordObservation(createAuthority(), {
          _tag: "Bundle",
          value: {
            attempt: "create-attempt-1",
            payloadReference: "private-payload-reference-1",
            observedAt: T1,
            digest: "a".repeat(64),
          },
        }),
      );
      assert.ok(failure instanceof MetadataStoreConflict);
      assert.equal(failure.code, "metadata_missing");
    }),
  );
});
