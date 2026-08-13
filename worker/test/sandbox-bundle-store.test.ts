import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  SandboxBundleStore,
  sandboxBundleManifestKey,
  sandboxBundleStoreLayer,
  sandboxBundleTarGzKey,
  type SandboxBundleCapabilities,
  type SandboxBundleObjectMetadata,
} from "../src/sandbox-bundle-store";

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
      manifestJson: '{"schemaVersion":1,"skills":[],"piPackages":[]}\n',
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

  it.effect("returns stored gzip bytes and rejects missing or mismatched metadata on get", () =>
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
      assert.deepStrictEqual(loaded.gzipBytes, gzipBytes);
      assert.strictEqual(test.getCalls(), 1);

      const missing = yield* Effect.result(getBundle(test.capabilities, "e".repeat(64)));
      assert.deepInclude(failure(missing), { reason: "missing" });

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
