import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import {
  ARTIFACT_PUT_RETRY_DELAY_MILLIS,
  ArtifactStore,
  artifactStoreLayer,
  r2ArtifactStoreCapabilities,
  type ArtifactObjectBody,
  type ArtifactObjectMetadata,
  type ArtifactStoreCapabilities,
} from "../src/artifact-store";

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);

interface StoredObject extends ArtifactObjectMetadata {
  readonly bytes: Uint8Array;
}

const bodyFor = (stored: StoredObject): ArtifactObjectBody => ({
  key: stored.key,
  size: stored.size,
  contentType: stored.contentType,
  customMetadata: stored.customMetadata,
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(stored.bytes);
      controller.close();
    },
  }),
});

const makeMemoryCapabilities = (ambiguousPut = false) => {
  const objects = new Map<string, StoredObject>();
  let putCalls = 0;
  let headCalls = 0;
  const capabilities: ArtifactStoreCapabilities = {
    put: async (key, bytes, metadata) => {
      putCalls += 1;
      const object = {
        key,
        size: bytes.byteLength,
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata,
        bytes: Uint8Array.from(bytes),
      };
      objects.set(key, object);
      if (ambiguousPut) throw "put response lost";
      return object;
    },
    head: async (key) => {
      headCalls += 1;
      return objects.get(key);
    },
    get: async (key) => {
      const stored = objects.get(key);
      return stored === undefined ? undefined : bodyFor(stored);
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { capabilities, objects, putCalls: () => putCalls, headCalls: () => headCalls };
};

const r2Object = (stored: StoredObject, includeBody: boolean): R2Object | R2ObjectBody => {
  const base = {
    key: stored.key,
    version: "1",
    size: stored.size,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-08-06T12:00:00.000Z"),
    httpMetadata: { contentType: stored.contentType },
    customMetadata: { ...stored.customMetadata },
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  };
  if (!includeBody) return base as R2Object;
  const body = bodyFor(stored).body;
  return {
    ...base,
    body,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(stored.bytes.buffer.slice(0)),
    bytes: () => Promise.resolve(Uint8Array.from(stored.bytes)),
    text: () => Promise.resolve(""),
    json: <T>() => Promise.resolve({} as T),
    blob: () => Promise.resolve(new Blob([stored.bytes], { type: "image/png" })),
  } as R2ObjectBody;
};

const makeR2Capabilities = () => {
  const memory = makeMemoryCapabilities();
  const bucketShape = {
    put: async (
      key: string,
      value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string | null,
      options?: R2PutOptions,
    ) => {
      assert.ok(value instanceof Uint8Array);
      const contentType =
        options?.httpMetadata instanceof Headers
          ? options.httpMetadata.get("content-type")
          : options?.httpMetadata?.contentType;
      assert.strictEqual(contentType, "image/png");
      await memory.capabilities.put(key, value, {
        contentType: "image/png",
        customMetadata: options?.customMetadata ?? {},
      });
      const stored = memory.objects.get(key);
      assert.ok(stored);
      return r2Object(stored, false) as R2Object;
    },
    head: async (key: string) => {
      const stored = memory.objects.get(key);
      return stored === undefined ? null : (r2Object(stored, false) as R2Object);
    },
    get: async (key: string) => {
      const stored = memory.objects.get(key);
      return stored === undefined ? null : (r2Object(stored, true) as R2ObjectBody);
    },
    delete: async (key: string | string[]) => {
      for (const candidate of typeof key === "string" ? [key] : key)
        memory.objects.delete(candidate);
    },
  };
  return {
    capabilities: r2ArtifactStoreCapabilities(bucketShape as R2Bucket),
    objects: memory.objects,
    putCalls: memory.putCalls,
    headCalls: memory.headCalls,
  };
};

const prepareFrame = (capabilities: ArtifactStoreCapabilities, bytes = PNG) =>
  Effect.flatMap(ArtifactStore, (store) =>
    store.prepareFrame({
      sessionId: "a0b1c2d3e4f5",
      jobId: "job-1",
      frameId: "frame-1",
      bytes,
      capturedAt: "2026-08-06T12:00:01.000Z",
      offsetMillis: 1_000,
    }),
  ).pipe(Effect.provide(artifactStoreLayer(capabilities)));

const putFrame = (capabilities: ArtifactStoreCapabilities, bytes = PNG) =>
  Effect.gen(function* () {
    const store = yield* ArtifactStore;
    const prepared = yield* store.prepareFrame({
      sessionId: "a0b1c2d3e4f5",
      jobId: "job-1",
      frameId: "frame-1",
      bytes,
      capturedAt: "2026-08-06T12:00:01.000Z",
      offsetMillis: 1_000,
    });
    return yield* store.writeFrame(prepared);
  }).pipe(Effect.provide(artifactStoreLayer(capabilities)));

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("ArtifactStore", () => {
  for (const factory of [
    { name: "in-memory fake", make: makeMemoryCapabilities },
    { name: "live R2 binding shape", make: makeR2Capabilities },
  ]) {
    it.effect(`publishes and opens only verified private PNGs through the ${factory.name}`, () =>
      Effect.gen(function* () {
        const test = factory.make();
        const artifact = yield* putFrame(test.capabilities);
        assert.deepInclude(artifact, {
          sessionId: "a0b1c2d3e4f5",
          jobId: "job-1",
          frameId: "frame-1",
          mediaType: "image/png",
          bytes: PNG.byteLength,
          status: "available",
        });
        assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
        assert.strictEqual(artifact.objectKey, "evidence/v2/a0b1c2d3e4f5/job-1/frame-1.png");
        assert.strictEqual(test.putCalls(), 1);
        assert.strictEqual(test.headCalls(), 0);

        const opened = yield* Effect.flatMap(ArtifactStore, (store) =>
          store.openFrame(artifact),
        ).pipe(Effect.provide(artifactStoreLayer(test.capabilities)));
        assert.strictEqual(opened.bytes, PNG.byteLength);
        assert.strictEqual(opened.mediaType, "image/png");

        const unavailable = { ...artifact, status: "delete_pending" as const };
        const denied = yield* Effect.result(
          Effect.flatMap(ArtifactStore, (store) => store.openFrame(unavailable)).pipe(
            Effect.provide(artifactStoreLayer(test.capabilities)),
          ),
        );
        assert.deepInclude(failure(denied), { operation: "open", reason: "invalid_state" });

        yield* Effect.flatMap(ArtifactStore, (store) => store.deleteFrame(unavailable)).pipe(
          Effect.provide(artifactStoreLayer(test.capabilities)),
        );
        assert.strictEqual(test.objects.size, 0);
      }),
    );
  }

  it.effect("reconciles an ambiguous put only when exact head metadata exists", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities(true);
      const artifact = yield* putFrame(test.capabilities);
      assert.strictEqual(artifact.status, "available");
      assert.strictEqual(test.objects.size, 1);
      assert.strictEqual(test.headCalls(), 1);
    }),
  );

  it.effect("retries one missing R2 put and publishes its exact receipt", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      let attempts = 0;
      const capabilities: ArtifactStoreCapabilities = {
        ...test.capabilities,
        put: (key, bytes, metadata) => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("put: Unspecified error (0)"))
            : test.capabilities.put(key, bytes, metadata);
        },
      };
      const fiber = yield* putFrame(capabilities).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(ARTIFACT_PUT_RETRY_DELAY_MILLIS);
      const artifact = yield* Fiber.join(fiber);

      assert.strictEqual(artifact.status, "available");
      assert.strictEqual(attempts, 2);
      assert.strictEqual(test.headCalls(), 1);
    }),
  );

  it.effect("logs a safe actionable R2 failure without exposing a long token", () =>
    Effect.gen(function* () {
      const token = "a".repeat(48);
      const test = makeMemoryCapabilities();
      const capabilities: ArtifactStoreCapabilities = {
        ...test.capabilities,
        put: () => Promise.reject(new TypeError(`R2 write rejected ${token}`)),
        head: () => Promise.resolve(undefined),
      };
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const fiber = yield* Effect.result(putFrame(capabilities)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(ARTIFACT_PUT_RETRY_DELAY_MILLIS);
      const result = yield* Fiber.join(fiber);
      const calls = error.mock.calls;
      error.mockRestore();

      assert.deepInclude(failure(result), { operation: "put", reason: "put_unknown" });
      assert.deepStrictEqual(calls[0], [
        "Evidence artifact storage failed",
        { operation: "put", error: "TypeError", message: "R2 write rejected [redacted]" },
      ]);
      assert.notInclude(JSON.stringify(calls), token);
    }),
  );

  it.effect("rejects mismatched successful put metadata without issuing a head", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const capabilities: ArtifactStoreCapabilities = {
        ...test.capabilities,
        put: async (key, bytes, metadata) => {
          const receipt = await test.capabilities.put(key, bytes, metadata);
          return { ...receipt, contentType: "application/octet-stream" };
        },
      };
      const result = yield* Effect.result(putFrame(capabilities));

      assert.deepInclude(failure(result), { operation: "put", reason: "metadata_mismatch" });
      assert.strictEqual(test.putCalls(), 1);
      assert.strictEqual(test.headCalls(), 0);
    }),
  );

  it.effect("rejects bytes changed after manifest hashing before storage", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const prepared = yield* prepareFrame(test.capabilities);
      prepared.bytes[0] = 0;
      const result = yield* Effect.result(
        Effect.flatMap(ArtifactStore, (store) => store.writeFrame(prepared)).pipe(
          Effect.provide(artifactStoreLayer(test.capabilities)),
        ),
      );
      assert.deepInclude(failure(result), { operation: "validate", reason: "invalid_state" });
      assert.strictEqual(test.putCalls(), 0);
    }),
  );

  it.effect("rejects non-canonical ownership identifiers before storage", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const result = yield* Effect.result(
        Effect.flatMap(ArtifactStore, (store) =>
          store.prepareFrame({
            sessionId: "../other-session",
            jobId: "job-1",
            frameId: "frame-1",
            bytes: PNG,
            capturedAt: "2026-08-06T12:00:01.000Z",
            offsetMillis: 1_000,
          }),
        ).pipe(Effect.provide(artifactStoreLayer(test.capabilities))),
      );
      assert.deepInclude(failure(result), { operation: "validate", reason: "invalid_state" });
      assert.strictEqual(test.putCalls(), 0);
    }),
  );

  it.effect("rejects invalid screenshot bytes before storage", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const result = yield* Effect.result(
        prepareFrame(test.capabilities, Uint8Array.from([1, 2, 3])),
      );
      assert.deepInclude(failure(result), { operation: "validate", reason: "invalid_png" });
      assert.strictEqual(test.putCalls(), 0);
      assert.strictEqual(test.objects.size, 0);
    }),
  );

  it.effect("publishes and opens a verified browser-recorded WebM", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const artifact = yield* Effect.gen(function* () {
        const store = yield* ArtifactStore;
        const prepared = yield* store.prepareVideo({
          sessionId: "a0b1c2d3e4f5",
          jobId: "job-1",
          artifactId: "recording",
          bytes: WEBM,
          capturedAt: "2026-08-06T12:00:02.000Z",
          offsetMillis: 2_000,
        });
        return yield* store.writeArtifact(prepared);
      }).pipe(Effect.provide(artifactStoreLayer(test.capabilities)));

      assert.deepInclude(artifact, {
        version: 2,
        frameId: "recording",
        mediaType: "video/webm",
        bytes: WEBM.byteLength,
        status: "available",
      });
      assert.strictEqual(artifact.objectKey, "evidence/v2/a0b1c2d3e4f5/job-1/recording.webm");

      const opened = yield* Effect.flatMap(ArtifactStore, (store) =>
        store.openArtifact(artifact),
      ).pipe(Effect.provide(artifactStoreLayer(test.capabilities)));
      assert.strictEqual(opened.mediaType, "video/webm");
      assert.strictEqual(opened.bytes, WEBM.byteLength);
    }),
  );

  it.effect("rejects invalid WebM bytes before storage", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const result = yield* Effect.result(
        Effect.flatMap(ArtifactStore, (store) =>
          store.prepareVideo({
            sessionId: "a0b1c2d3e4f5",
            jobId: "job-1",
            artifactId: "recording",
            bytes: Uint8Array.from([1, 2, 3, 4]),
            capturedAt: "2026-08-06T12:00:02.000Z",
            offsetMillis: 2_000,
          }),
        ).pipe(Effect.provide(artifactStoreLayer(test.capabilities))),
      );
      assert.deepInclude(failure(result), { operation: "validate", reason: "invalid_webm" });
      assert.strictEqual(test.putCalls(), 0);
    }),
  );
});
