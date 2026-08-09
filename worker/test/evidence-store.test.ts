import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  ArtifactStore,
  artifactStoreLayer,
  type ArtifactObjectBody,
  type ArtifactObjectMetadata,
  type ArtifactStoreCapabilities,
} from "../src/artifact-store";
import {
  EVIDENCE_PREVIEW_AGGREGATE_BYTES,
  EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS,
  EVIDENCE_PREVIEW_MAX_INGRESS_BYTES,
  EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  type BrowserEvidenceJobV2,
  type EvidenceArtifactV2,
  type EvidenceJobSummaryV2,
  type EvidenceStateV2,
} from "../src/evidence-contracts";
import { EvidenceStore, evidenceStoreLayer } from "../src/evidence-store";
import {
  SessionStore,
  sessionStoreLayer,
  type SessionEvidenceTransaction,
  type SessionRecordStorage,
  type SessionRecordTransaction,
} from "../src/session-store";
import { makeSessionRecord } from "./support";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const SESSION_ID = "a0b1c2d3e4f5";
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);
const DIAGNOSTIC = {
  operation: "screenshot",
  reason: "ambiguous",
  step: 0,
  kitesurf: { operation: "screenshot", reason: "ambiguous" },
} as const;

const JOB: BrowserEvidenceJobV2 = {
  version: 2,
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  capture: { screenshots: "after-each-step", video: false },
  steps: [
    {
      name: "Shows the ready state",
      action: { kind: "goto", path: "/" },
      expect: [
        {
          kind: "textExact",
          locator: { kind: "testId", value: "status" },
          expected: "Ready",
        },
      ],
    },
  ],
};

const makeArtifactCapabilities = () => {
  const objects = new Map<string, ArtifactObjectMetadata & { readonly bytes: Uint8Array }>();
  const capabilities: ArtifactStoreCapabilities = {
    put: async (key, bytes, metadata) => {
      objects.set(key, {
        key,
        size: bytes.byteLength,
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata,
        bytes: Uint8Array.from(bytes),
      });
    },
    head: async (key) => objects.get(key),
    get: async (key): Promise<ArtifactObjectBody | undefined> => {
      const object = objects.get(key);
      if (object === undefined) return undefined;
      return {
        ...object,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.bytes);
            controller.close();
          },
        }),
      };
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { capabilities, objects };
};

const makeAuthorityStorage = (initialEvidence?: unknown) => {
  let record: unknown = makeSessionRecord({
    id: SESSION_ID,
    hardCapAt: "2026-08-06T13:00:00.000Z",
  });
  let evidence: unknown | undefined = structuredClone(initialEvidence);
  const runtimeEpoch = "runtime-1";
  const storage: SessionRecordStorage = {
    get: async () => structuredClone(record),
    put: async (next) => {
      record = structuredClone(next);
    },
    transaction: async <A>(
      operation: (transaction: SessionRecordTransaction) => Promise<A>,
    ): Promise<A> => {
      let staged = structuredClone(record);
      const result = await operation({
        get: async () => structuredClone(staged),
        put: async (next) => {
          staged = structuredClone(next);
        },
      });
      record = staged;
      return result;
    },
    getEvidence: async () => structuredClone(evidence),
    getRuntimeEpoch: async () => runtimeEpoch,
    evidenceTransaction: async <A>(
      operation: (transaction: SessionEvidenceTransaction) => Promise<A>,
    ): Promise<A> => {
      let stagedRecord = structuredClone(record);
      let stagedEvidence = structuredClone(evidence);
      const result = await operation({
        getRecord: async () => structuredClone(stagedRecord),
        getEvidence: async () => structuredClone(stagedEvidence),
        getRuntimeEpoch: async () => runtimeEpoch,
        putRecord: async (next) => {
          stagedRecord = structuredClone(next);
        },
        putEvidence: async (next) => {
          stagedEvidence = structuredClone(next);
        },
        deleteEvidence: async () => {
          stagedEvidence = undefined;
        },
      });
      record = stagedRecord;
      evidence = stagedEvidence;
      return result;
    },
  };
  return {
    storage,
    readRecord: () => structuredClone(record),
    readEvidence: () => structuredClone(evidence) as EvidenceStateV2 | undefined,
  };
};

const layers = (storage: SessionRecordStorage, artifacts: ArtifactStoreCapabilities) =>
  Layer.mergeAll(
    sessionStoreLayer(storage),
    evidenceStoreLayer(storage),
    artifactStoreLayer(artifacts),
  );

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const accept = (testLayers: Layer.Layer<SessionStore | EvidenceStore | ArtifactStore>) =>
  Effect.flatMap(EvidenceStore, (store) =>
    store.accept({
      jobId: "job-1",
      operationNonce: "evidence-nonce",
      runtimeEpoch: "runtime-1",
      routeNonce: "0123456789abcdef",
      deadlineAt: "2026-08-06T12:05:00.000Z",
      flowHash: "a".repeat(64),
      job: JOB,
    }),
  ).pipe(Effect.provide(testLayers));

const publishPreview = (testLayers: Layer.Layer<SessionStore | EvidenceStore | ArtifactStore>) =>
  Effect.gen(function* () {
    const store = yield* EvidenceStore;
    yield* store.beginPreviewExposure("evidence-nonce", {
      runtimeEpoch: "runtime-1",
      runtimeRunning: true,
    });
    yield* store.publishPreviewExposure("evidence-nonce", {
      runtimeEpoch: "runtime-1",
      runtimeRunning: true,
      cookieDigest: "a".repeat(64),
    });
  }).pipe(Effect.provide(testLayers));

const previewAdmission = (requestId: string) => ({
  requestId,
  sessionId: SESSION_ID,
  port: JOB.port,
  routeNonce: "0123456789abcdef",
  runtimeEpoch: "runtime-1",
  cookieDigest: "a".repeat(64),
  ingressBytes: 0,
  runtimeRunning: true,
});

const retainedSummary = (index: number): EvidenceJobSummaryV2 => ({
  version: 2,
  sequence: index,
  jobId: `retained-${index}`,
  status: "succeeded",
  acceptedAt: "2026-08-05T12:00:00.000Z",
  completedAt: "2026-08-05T12:00:01.000Z",
  totalSteps: 1,
  completedSteps: 1,
  viewport: JOB.viewport,
  recordVideo: false,
  flowHash: "a".repeat(64),
  steps: [],
  frameCount: index === 99 ? 1 : 0,
});

const retainedArtifact = (jobId: string): EvidenceArtifactV2 => ({
  version: 2,
  sessionId: SESSION_ID,
  jobId,
  frameId: "old-frame",
  objectKey: `evidence/v2/${SESSION_ID}/${jobId}/old-frame.png`,
  mediaType: "image/png",
  sha256: "a".repeat(64),
  bytes: PNG.byteLength,
  capturedAt: "2026-08-05T12:00:01.000Z",
  offsetMillis: 1_000,
  expiresAt: "2026-08-12T12:00:01.000Z",
  status: "available",
});

describe("EvidenceStore", () => {
  it.effect("owns the deterministic manifest across every upload seam", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      const accepted = yield* accept(testLayers);
      assert.strictEqual(accepted.status, "accepted");
      assert.deepInclude(authority.readRecord(), {
        operation: {
          kind: "evidence",
          nonce: "evidence-nonce",
          startedAt: "2026-08-06T12:00:00.000Z",
        },
      });

      const collision = yield* Effect.result(
        Effect.flatMap(SessionStore, (store) =>
          store.acquireOperation("snapshot", ["warm"], "snapshot-nonce"),
        ).pipe(Effect.provide(testLayers)),
      );
      assert.deepInclude(failure(collision), {
        code: "conflict",
        message: "Session is already running evidence",
      });

      const prepared = yield* Effect.flatMap(ArtifactStore, (store) =>
        store.prepareFrame({
          sessionId: SESSION_ID,
          jobId: accepted.jobId,
          frameId: "frame-1",
          bytes: PNG,
          capturedAt: "2026-08-06T12:00:01.000Z",
          offsetMillis: 1_000,
        }),
      ).pipe(Effect.provide(testLayers));
      assert.strictEqual(artifacts.objects.size, 0);
      yield* Effect.flatMap(EvidenceStore, (store) =>
        store.prepareArtifactUpload("evidence-nonce", 0, prepared.artifact),
      ).pipe(Effect.provide(testLayers));
      assert.deepInclude(authority.readEvidence()?.artifacts[0], {
        objectKey: `evidence/v2/${SESSION_ID}/job-1/frame-1.png`,
        status: "delete_pending",
      });
      assert.deepInclude(authority.readEvidence()?.pendingDeletes[0], {
        objectKey: `evidence/v2/${SESSION_ID}/job-1/frame-1.png`,
        reason: "abandoned",
      });
      const artifact = yield* Effect.flatMap(ArtifactStore, (store) =>
        store.writeFrame(prepared),
      ).pipe(Effect.provide(testLayers));
      assert.strictEqual(artifact.objectKey, `evidence/v2/${SESSION_ID}/job-1/frame-1.png`);
      assert.strictEqual(artifacts.objects.size, 1);

      const step = yield* Effect.flatMap(EvidenceStore, (store) =>
        store.completeStep("evidence-nonce", {
          index: 0,
          startedAt: "2026-08-06T12:00:00.100Z",
          completedAt: "2026-08-06T12:00:01.000Z",
          offsetMillis: 1_000,
          assertions: [{ kind: "textExact", passed: false, expected: "Ready", actual: "Broken" }],
          artifact,
        }),
      ).pipe(Effect.provide(testLayers));
      assert.strictEqual(step.status, "failed");
      assert.strictEqual(step.frame?.frameId, "frame-1");
      assert.deepInclude(authority.readEvidence()?.artifacts[0], {
        objectKey: artifact.objectKey,
        status: "available",
      });
      assert.deepStrictEqual(authority.readEvidence()?.pendingDeletes, []);

      yield* TestClock.setTime(NOW + 2_000);
      const summary = yield* Effect.flatMap(EvidenceStore, (store) =>
        store.finalize("evidence-nonce", "succeeded"),
      ).pipe(Effect.provide(testLayers));
      assert.deepInclude(summary, {
        status: "failed",
        completedSteps: 1,
        frameCount: 1,
        failure: { code: "assertion_mismatch", step: 0 },
      });
      assert.deepInclude(authority.readRecord(), { operation: null });
      const persisted = authority.readEvidence();
      assert.ok(persisted !== undefined);
      assert.notProperty(persisted, "activeJob");
      assert.strictEqual(persisted.retainedBytes, artifact.bytes);

      yield* Effect.flatMap(SessionStore, (store) =>
        store.acquireOperation("vaporize", ["warm"], "vaporize-nonce"),
      ).pipe(Effect.provide(testLayers));
      const pending = yield* Effect.flatMap(EvidenceStore, (store) =>
        store.prepareVaporizeDeletes("vaporize-nonce"),
      ).pipe(Effect.provide(testLayers));
      assert.deepInclude(pending[0], { status: "delete_pending" });
      assert.deepInclude(authority.readEvidence()?.pendingDeletes[0], {
        objectKey: artifact.objectKey,
        reason: "vaporize",
      });
      yield* Effect.flatMap(ArtifactStore, (store) => store.deleteFrame(pending[0])).pipe(
        Effect.provide(testLayers),
      );
      yield* Effect.flatMap(EvidenceStore, (store) => store.confirmDelete(artifact.objectKey)).pipe(
        Effect.provide(testLayers),
      );
      yield* Effect.flatMap(EvidenceStore, (store) =>
        store.clearForVaporize("vaporize-nonce"),
      ).pipe(Effect.provide(testLayers));
      assert.strictEqual(artifacts.objects.size, 0);
      assert.strictEqual(authority.readEvidence(), undefined);
    }),
  );

  it.effect("commits one bounded WebM only after every requested step completes", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      const store = yield* Effect.provide(EvidenceStore, testLayers);
      const accepted = yield* store
        .accept({
          jobId: "job-video",
          operationNonce: "evidence-video-nonce",
          runtimeEpoch: "runtime-1",
          routeNonce: "0123456789abcdef",
          deadlineAt: "2026-08-06T12:05:00.000Z",
          flowHash: "b".repeat(64),
          job: {
            ...JOB,
            capture: { screenshots: "after-each-step", video: true },
          },
        })
        .pipe(Effect.provide(testLayers));
      yield* store
        .completeStep(accepted.operationNonce, {
          index: 0,
          startedAt: "2026-08-06T12:00:00.100Z",
          completedAt: "2026-08-06T12:00:01.000Z",
          offsetMillis: 1_000,
          assertions: [{ kind: "textExact", passed: true, expected: "Ready", actual: "Ready" }],
        })
        .pipe(Effect.provide(testLayers));

      const prepared = yield* Effect.flatMap(ArtifactStore, (artifactStore) =>
        artifactStore.prepareVideo({
          sessionId: SESSION_ID,
          jobId: accepted.jobId,
          artifactId: "recording",
          bytes: WEBM,
          capturedAt: "2026-08-06T12:00:01.100Z",
          offsetMillis: 1_100,
        }),
      ).pipe(Effect.provide(testLayers));
      yield* store
        .prepareVideoUpload(accepted.operationNonce, prepared.artifact)
        .pipe(Effect.provide(testLayers));
      const artifact = yield* Effect.flatMap(ArtifactStore, (artifactStore) =>
        artifactStore.writeArtifact(prepared),
      ).pipe(Effect.provide(testLayers));
      yield* store
        .completeVideo(accepted.operationNonce, { artifact })
        .pipe(Effect.provide(testLayers));
      const summary = yield* store
        .finalize(accepted.operationNonce, "succeeded")
        .pipe(Effect.provide(testLayers));

      assert.deepInclude(summary, {
        status: "succeeded",
        recordVideo: true,
      });
      assert.strictEqual(summary.video?.artifactId, "recording");
      assert.strictEqual(summary.video?.bytes, WEBM.byteLength);
      assert.deepInclude(authority.readEvidence()?.artifacts[0], {
        mediaType: "video/webm",
        status: "available",
      });
      assert.deepStrictEqual(authority.readEvidence()?.pendingDeletes, []);
    }),
  );

  it.effect("admits, claims, and idempotently settles persisted preview accounting", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      yield* accept(testLayers);
      yield* publishPreview(testLayers);
      const requestId = "1".repeat(32);
      const store = yield* Effect.provide(EvidenceStore, testLayers);
      const admitted = yield* store
        .admitPreview({ ...previewAdmission(requestId), ingressBytes: 100 })
        .pipe(Effect.provide(testLayers));
      assert.deepStrictEqual(admitted, {
        requestId,
        expiresAt: "2026-08-06T12:00:30.000Z",
      });
      assert.deepInclude(authority.readEvidence()?.activeJob?.previewAccounting.permits[0], {
        requestId,
        state: "admitted",
        ingressBytes: 100,
      });

      const claimed = yield* store
        .claimPreview(previewAdmission(requestId))
        .pipe(Effect.provide(testLayers));
      assert.deepStrictEqual(claimed, {
        operationNonce: "evidence-nonce",
        expiresAt: admitted?.expiresAt,
      });
      yield* TestClock.setTime(NOW + 2_000);
      yield* store.settlePreview(requestId, 1_024).pipe(Effect.provide(testLayers));
      yield* store.settlePreview(requestId, 1_024).pipe(Effect.provide(testLayers));
      yield* store.cancelPreview(requestId).pipe(Effect.provide(testLayers));
      assert.deepStrictEqual(authority.readEvidence()?.activeJob?.previewAccounting, {
        consumedBytes: 1_124,
        consumedRequestMillis: 2_000,
        permits: [],
      });
    }),
  );

  it.effect("adjusts reservations and distinguishes normal cancellation from expiry", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      yield* accept(testLayers);
      yield* publishPreview(testLayers);
      const store = yield* Effect.provide(EvidenceStore, testLayers);
      const canceledId = "2".repeat(32);
      assert.ok(
        (yield* store
          .admitPreview({
            ...previewAdmission(canceledId),
            ingressBytes: EVIDENCE_PREVIEW_MAX_INGRESS_BYTES,
          })
          .pipe(Effect.provide(testLayers))) !== undefined,
      );
      assert.isTrue(yield* store.adjustPreview(canceledId, 123).pipe(Effect.provide(testLayers)));
      assert.isTrue(yield* store.adjustPreview(canceledId, 123).pipe(Effect.provide(testLayers)));
      yield* TestClock.setTime(NOW + 1_000);
      yield* store.cancelPreview(canceledId).pipe(Effect.provide(testLayers));
      assert.deepStrictEqual(authority.readEvidence()?.activeJob?.previewAccounting, {
        consumedBytes: 123,
        consumedRequestMillis: 1_000,
        permits: [],
      });

      const expiredId = "3".repeat(32);
      assert.ok(
        (yield* store
          .admitPreview({ ...previewAdmission(expiredId), ingressBytes: 100 })
          .pipe(Effect.provide(testLayers))) !== undefined,
      );
      yield* store.expirePreview(expiredId).pipe(Effect.provide(testLayers));
      yield* store.expirePreview(expiredId).pipe(Effect.provide(testLayers));
      yield* store.cancelPreview(expiredId).pipe(Effect.provide(testLayers));
      assert.deepStrictEqual(authority.readEvidence()?.activeJob?.previewAccounting, {
        consumedBytes: 123 + 100 + EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
        consumedRequestMillis: 1_000 + EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
        permits: [],
      });
    }),
  );

  it.effect("revalidates the forwarding route at claim and consumes a mismatched permit", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      yield* accept(testLayers);
      yield* publishPreview(testLayers);
      const store = yield* Effect.provide(EvidenceStore, testLayers);
      const requestId = "7".repeat(32);
      assert.ok(
        (yield* store
          .admitPreview(previewAdmission(requestId))
          .pipe(Effect.provide(testLayers))) !== undefined,
      );
      assert.strictEqual(
        yield* store
          .claimPreview({ ...previewAdmission(requestId), port: 5_173 })
          .pipe(Effect.provide(testLayers)),
        undefined,
      );
      assert.deepStrictEqual(authority.readEvidence()?.activeJob?.previewAccounting, {
        consumedBytes: EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
        consumedRequestMillis: EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
        permits: [],
      });
    }),
  );

  it.effect("reserves capacity and charges stale permits conservatively without reopening it", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      yield* accept(testLayers);
      yield* publishPreview(testLayers);
      const store = yield* Effect.provide(EvidenceStore, testLayers);
      for (const digit of ["1", "2", "3", "4"]) {
        const admitted = yield* store
          .admitPreview(previewAdmission(digit.repeat(32)))
          .pipe(Effect.provide(testLayers));
        assert.ok(admitted !== undefined);
      }
      assert.strictEqual(
        yield* store
          .admitPreview(previewAdmission("5".repeat(32)))
          .pipe(Effect.provide(testLayers)),
        undefined,
      );

      yield* store.cancelPreview("1".repeat(32)).pipe(Effect.provide(testLayers));
      assert.ok(
        (yield* store
          .admitPreview(previewAdmission("5".repeat(32)))
          .pipe(Effect.provide(testLayers))) !== undefined,
      );
      yield* TestClock.setTime(NOW + EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS);
      assert.strictEqual(
        yield* store
          .admitPreview(previewAdmission("6".repeat(32)))
          .pipe(Effect.provide(testLayers)),
        undefined,
      );
      assert.deepStrictEqual(authority.readEvidence()?.activeJob?.previewAccounting, {
        consumedBytes: EVIDENCE_PREVIEW_AGGREGATE_BYTES,
        consumedRequestMillis: EVIDENCE_PREVIEW_AGGREGATE_REQUEST_MILLIS,
        permits: [],
      });
      assert.strictEqual(
        EVIDENCE_PREVIEW_AGGREGATE_BYTES,
        EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES * 4,
      );
    }),
  );

  it.effect("rejects deadlines beyond the hard cap without acquiring authority", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      yield* TestClock.setTime(NOW);
      const result = yield* Effect.result(
        Effect.flatMap(EvidenceStore, (store) =>
          store.accept({
            jobId: "job-1",
            operationNonce: "evidence-nonce",
            runtimeEpoch: "runtime-1",
            routeNonce: "0123456789abcdef",
            deadlineAt: "2026-08-06T14:00:00.000Z",
            flowHash: "a".repeat(64),
            job: JOB,
          }),
        ).pipe(Effect.provide(layers(authority.storage, artifacts.capabilities))),
      );
      assert.deepInclude(failure(result), { reason: "invalid" });
      assert.deepInclude(authority.readRecord(), { operation: null });
      assert.strictEqual(authority.readEvidence(), undefined);
    }),
  );

  it.effect(
    "preserves the first specific failure and diagnostic through generic interruption",
    () =>
      Effect.gen(function* () {
        const authority = makeAuthorityStorage();
        const artifacts = makeArtifactCapabilities();
        const testLayers = layers(authority.storage, artifacts.capabilities);
        yield* TestClock.setTime(NOW);
        yield* accept(testLayers);
        const store = yield* Effect.provide(EvidenceStore, testLayers);
        yield* store
          .recordFailure("evidence-nonce", { code: "interrupted", step: 0 }, DIAGNOSTIC)
          .pipe(Effect.provide(testLayers));
        yield* store
          .recordFailure("evidence-nonce", { code: "interrupted" })
          .pipe(Effect.provide(testLayers));
        yield* store
          .revokePreview("evidence-nonce", "interrupted")
          .pipe(Effect.provide(testLayers));

        const summary = yield* store
          .finalize("evidence-nonce", "interrupted")
          .pipe(Effect.provide(testLayers));

        assert.deepInclude(summary, {
          status: "interrupted",
          completedSteps: 0,
          frameCount: 0,
          failure: { code: "interrupted", step: 0 },
          diagnostic: DIAGNOSTIC,
        });
        assert.deepInclude(authority.readEvidence()?.jobs[0], {
          failure: { code: "interrupted", step: 0 },
          diagnostic: DIAGNOSTIC,
        });
        assert.deepInclude(authority.readRecord(), { operation: null });
      }),
  );

  it.effect("interrupts only the matching evidence nonce and releases its lease", () =>
    Effect.gen(function* () {
      const authority = makeAuthorityStorage();
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      yield* accept(testLayers);

      const stale = yield* Effect.result(
        Effect.flatMap(EvidenceStore, (store) => store.interrupt("stale", "deadline")).pipe(
          Effect.provide(testLayers),
        ),
      );
      assert.deepInclude(failure(stale), { reason: "lease_changed" });

      const interrupted = yield* Effect.flatMap(EvidenceStore, (store) =>
        store.interrupt("evidence-nonce", "deadline"),
      ).pipe(Effect.provide(testLayers));
      assert.deepInclude(interrupted, {
        status: "interrupted",
        failure: { code: "deadline" },
      });
      assert.deepInclude(authority.readRecord(), { operation: null });
    }),
  );

  it.effect("persists expiry intent before an expired artifact can be deleted", () =>
    Effect.gen(function* () {
      const artifact = retainedArtifact("retained-0");
      const authority = makeAuthorityStorage({
        version: 2,
        nextSequence: 1,
        jobs: [retainedSummary(0)],
        artifacts: [artifact],
        pendingDeletes: [],
        retainedBytes: artifact.bytes,
      });
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(Date.parse(artifact.expiresAt));

      const pending = yield* Effect.flatMap(
        EvidenceStore,
        (store) => store.prepareExpiredDeletes,
      ).pipe(Effect.provide(testLayers));

      assert.deepInclude(pending[0], { objectKey: artifact.objectKey, status: "delete_pending" });
      assert.deepInclude(authority.readEvidence()?.pendingDeletes[0], {
        objectKey: artifact.objectKey,
        reason: "expired",
      });
      const unavailable = yield* Effect.result(
        Effect.flatMap(EvidenceStore, (store) =>
          store.getArtifact(artifact.jobId, artifact.frameId),
        ).pipe(Effect.provide(testLayers)),
      );
      assert.deepInclude(failure(unavailable), { code: "not_found" });
    }),
  );

  it.effect("evicts and confirms bounded-history artifacts before accepting a new job", () =>
    Effect.gen(function* () {
      const jobs = Array.from({ length: 100 }, (_, index) => retainedSummary(index));
      const artifact = retainedArtifact("retained-99");
      const authority = makeAuthorityStorage({
        version: 2,
        nextSequence: 100,
        jobs,
        artifacts: [artifact],
        pendingDeletes: [],
        retainedBytes: artifact.bytes,
      });
      const artifacts = makeArtifactCapabilities();
      const testLayers = layers(authority.storage, artifacts.capabilities);
      yield* TestClock.setTime(NOW);
      const pending = yield* Effect.flatMap(
        EvidenceStore,
        (store) => store.prepareJobCapacity,
      ).pipe(Effect.provide(testLayers));
      assert.deepInclude(pending[0], { objectKey: artifact.objectKey, status: "delete_pending" });
      assert.deepInclude(authority.readEvidence()?.pendingDeletes[0], {
        objectKey: artifact.objectKey,
        reason: "history_evicted",
      });
      yield* Effect.flatMap(ArtifactStore, (store) => store.deleteFrame(pending[0])).pipe(
        Effect.provide(testLayers),
      );
      yield* Effect.flatMap(EvidenceStore, (store) => store.confirmDelete(artifact.objectKey)).pipe(
        Effect.provide(testLayers),
      );
      yield* accept(testLayers);
      yield* Effect.flatMap(EvidenceStore, (store) =>
        store.finalize("evidence-nonce", "succeeded"),
      ).pipe(Effect.provide(testLayers));

      const state = authority.readEvidence();
      assert.ok(state !== undefined);
      assert.strictEqual(state.jobs.length, 100);
      assert.isFalse(state.jobs.some((job) => job.jobId === artifact.jobId));
      assert.deepStrictEqual(state.artifacts, []);
      assert.deepStrictEqual(state.pendingDeletes, []);
    }),
  );
});
