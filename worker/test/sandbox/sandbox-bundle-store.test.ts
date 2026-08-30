import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  SandboxBundleStore,
  SANDBOX_BUNDLE_MAX_GZIP_BYTES,
  sandboxBundleManifestKey,
  sandboxBundleStoreLayer,
  sandboxBundleTarGzKey,
  type SandboxBundleCapabilities,
  type SandboxBundleObjectMetadata,
} from "../../src/sandbox/bundle-store";

interface StoredObject extends SandboxBundleObjectMetadata {
  readonly bytes: Uint8Array;
}

const makeMemoryCapabilities = () => {
  const objects = new Map<string, StoredObject>();
  let putCalls = 0;
  let headCalls = 0;
  let getCalls = 0;
  const capabilities: SandboxBundleCapabilities = {
    put: async (key, bytes, metadata, onlyIf) => {
      putCalls += 1;
      if (onlyIf.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const object = {
        key,
        size: bytes.byteLength,
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata,
        bytes: Uint8Array.from(bytes),
      };
      objects.set(key, object);
      return object;
    },
    head: async (key) => {
      headCalls += 1;
      return objects.get(key);
    },
    get: async (key) => {
      getCalls += 1;
      const object = objects.get(key);
      if (object === undefined) return undefined;
      return {
        metadata: object,
        body: new Blob([object.bytes]).stream(),
      };
    },
  };
  return {
    capabilities,
    objects,
    putCalls: () => putCalls,
    headCalls: () => headCalls,
    getCalls: () => getCalls,
  };
};

const putBundle = (capabilities: SandboxBundleCapabilities, digest = "a".repeat(64)) =>
  Effect.flatMap(SandboxBundleStore, (store) =>
    store.putBundle({
      digest,
      gzipBytes: Uint8Array.from([0x1f, 0x8b, 0x08]),
      manifestJson: '{"items":[]}\n',
    }),
  ).pipe(Effect.provide(sandboxBundleStoreLayer(capabilities)));

const getBundle = (capabilities: SandboxBundleCapabilities, digest = "a".repeat(64)) =>
  Effect.flatMap(SandboxBundleStore, (store) => store.getBundle(digest)).pipe(
    Effect.provide(sandboxBundleStoreLayer(capabilities)),
  );

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("SandboxBundleStore", () => {
  it.effect(
    "creates bundle and manifest objects once and verifies existing objects on replay",
    () =>
      Effect.gen(function* () {
        const test = makeMemoryCapabilities();
        yield* putBundle(test.capabilities);
        assert.strictEqual(test.putCalls(), 2);
        assert.strictEqual(test.headCalls(), 0);
        assert.ok(test.objects.has(sandboxBundleTarGzKey("a".repeat(64))));
        assert.ok(test.objects.has(sandboxBundleManifestKey("a".repeat(64))));

        yield* putBundle(test.capabilities);
        assert.strictEqual(test.putCalls(), 4);
        assert.strictEqual(test.headCalls(), 2);
      }),
  );

  it.effect("accepts a committed object when the put response is lost", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const put = test.capabilities.put;
      let loseResponse = true;
      const capabilities: SandboxBundleCapabilities = {
        ...test.capabilities,
        put: async (...args) => {
          const stored = await put(...args);
          if (loseResponse) {
            loseResponse = false;
            // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: fake R2 Promise client simulates a native rejection after commit
            throw new Error("Network connection lost.");
          }
          return stored;
        },
      };

      yield* putBundle(capabilities);

      assert.strictEqual(test.putCalls(), 2);
      assert.strictEqual(test.headCalls(), 1);
      assert.ok(test.objects.has(sandboxBundleTarGzKey("a".repeat(64))));
      assert.ok(test.objects.has(sandboxBundleManifestKey("a".repeat(64))));
    }),
  );

  it.effect("rejects a lost put response when no object was committed", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const capabilities: SandboxBundleCapabilities = {
        ...test.capabilities,
        put: async () => {
          // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: fake R2 Promise client simulates a native rejection before commit
          throw new Error("Network connection lost.");
        },
      };

      const result = yield* Effect.result(putBundle(capabilities));

      assert.deepInclude(failure(result), { reason: "upstream" });
      assert.strictEqual(test.headCalls(), 1);
      assert.strictEqual(test.objects.size, 0);
    }),
  );

  it.effect("rejects mismatched existing metadata without overwriting", () =>
    Effect.gen(function* () {
      const test = makeMemoryCapabilities();
      const digest = "b".repeat(64);
      test.objects.set(sandboxBundleTarGzKey(digest), {
        key: sandboxBundleTarGzKey(digest),
        size: 3,
        contentType: "application/gzip",
        customMetadata: { digest: "c".repeat(64) },
        bytes: Uint8Array.from([1, 2, 3]),
      });
      const result = yield* Effect.result(putBundle(test.capabilities, digest));
      assert.deepInclude(failure(result), { reason: "metadata_mismatch" });
      assert.strictEqual(
        test.objects.get(sandboxBundleTarGzKey(digest))?.customMetadata.digest,
        "c".repeat(64),
      );
    }),
  );

  it.effect(
    "returns the stored gzip stream and rejects missing or mismatched metadata on get",
    () =>
      Effect.gen(function* () {
        const test = makeMemoryCapabilities();
        const digest = "d".repeat(64);
        const gzipBytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]);
        test.objects.set(sandboxBundleTarGzKey(digest), {
          key: sandboxBundleTarGzKey(digest),
          size: gzipBytes.byteLength,
          contentType: "application/gzip",
          customMetadata: { digest },
          bytes: gzipBytes,
        });

        const loaded = yield* getBundle(test.capabilities, digest);
        const loadedBytes = yield* Effect.promise(
          async () => new Uint8Array(await new Response(loaded.gzipStream).arrayBuffer()),
        );
        assert.deepStrictEqual(loadedBytes, gzipBytes);
        assert.strictEqual(test.getCalls(), 1);

        const missing = yield* Effect.result(getBundle(test.capabilities, "e".repeat(64)));
        assert.deepInclude(failure(missing), { reason: "missing" });

        const oversizedDigest = "1".repeat(64);
        test.objects.set(sandboxBundleTarGzKey(oversizedDigest), {
          key: sandboxBundleTarGzKey(oversizedDigest),
          size: SANDBOX_BUNDLE_MAX_GZIP_BYTES + 1,
          contentType: "application/gzip",
          customMetadata: { digest: oversizedDigest },
          bytes: Uint8Array.from([1]),
        });
        const oversized = yield* Effect.result(getBundle(test.capabilities, oversizedDigest));
        assert.deepInclude(failure(oversized), { reason: "too_large" });

        test.objects.set(sandboxBundleTarGzKey("f".repeat(64)), {
          key: sandboxBundleTarGzKey("f".repeat(64)),
          size: 3,
          contentType: "application/gzip",
          customMetadata: { digest: "0".repeat(64) },
          bytes: Uint8Array.from([1, 2, 3]),
        });
        const mismatch = yield* Effect.result(getBundle(test.capabilities, "f".repeat(64)));
        assert.deepInclude(failure(mismatch), { reason: "metadata_mismatch" });
      }),
  );
});
