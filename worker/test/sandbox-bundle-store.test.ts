import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { sha256BytesHex } from "../src/digest";
import {
  SandboxBundleStore,
  sandboxBundleStoreLayer,
  sandboxPluginBundleTarGzKey,
  sandboxSnapshotKey,
  type SandboxBundleCapabilities,
  type SandboxBundleObjectMetadata,
} from "../src/sandbox-bundle-store";

interface StoredObject extends SandboxBundleObjectMetadata {
  readonly bytes: Uint8Array;
}

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const makeMemoryCapabilities = () => {
  const objects = new Map<string, StoredObject>();
  let putCalls = 0;
  const capabilities: SandboxBundleCapabilities = {
    put: async (key, bytes, metadata, onlyIf) => {
      putCalls += 1;
      if (onlyIf.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const object: StoredObject = {
        key,
        size: bytes.byteLength,
        contentType: metadata.contentType,
        customMetadata: { ...metadata.customMetadata },
        bytes: Uint8Array.from(bytes),
      };
      objects.set(key, object);
      return object;
    },
    get: async (key) => {
      const object = objects.get(key);
      return object === undefined
        ? undefined
        : { metadata: object, body: new Blob([object.bytes]).stream() };
    },
  };
  return {
    capabilities,
    objects,
    putCalls: () => putCalls,
  };
};

const contentDigest = async (bytes: Uint8Array): Promise<string> =>
  `sha256:${await sha256BytesHex(bytes)}`;

describe("SandboxBundleStore", () => {
  it.effect("creates Plugin bundle and snapshot objects only once and verifies replay", () =>
    Effect.gen(function* () {
      const memory = makeMemoryCapabilities();
      const layer = sandboxBundleStoreLayer(memory.capabilities);
      const bytes = Uint8Array.from([0x1f, 0x8b, 0x08]);
      const snapshotJson = '{"schemaVersion":1}\n';
      const bundleDigest = yield* Effect.promise(() => contentDigest(bytes));
      const snapshotDigest = yield* Effect.promise(() =>
        contentDigest(new TextEncoder().encode(snapshotJson)),
      );
      const put = Effect.flatMap(SandboxBundleStore, (store) =>
        Effect.gen(function* () {
          yield* store.putPluginBundle(bundleDigest, bytes);
          yield* store.putSnapshot({
            snapshotDigest,
            snapshotJson,
            pluginBundleDigest: bundleDigest,
          });
        }),
      ).pipe(Effect.provide(layer));
      yield* put;
      assert.strictEqual(memory.putCalls(), 2);
      assert.ok(memory.objects.has(sandboxPluginBundleTarGzKey(bundleDigest)));
      assert.ok(memory.objects.has(sandboxSnapshotKey(snapshotDigest)));
      yield* put;
      assert.strictEqual(memory.putCalls(), 4);
      assert.deepStrictEqual(
        memory.objects.get(sandboxPluginBundleTarGzKey(bundleDigest))?.bytes,
        bytes,
      );
    }),
  );

  it.effect("rejects an existing object with mismatched immutable metadata", () =>
    Effect.gen(function* () {
      const memory = makeMemoryCapabilities();
      const requested = yield* Effect.promise(() => contentDigest(Uint8Array.from([1, 2, 3])));
      const key = sandboxPluginBundleTarGzKey(requested);
      memory.objects.set(key, {
        key,
        size: 3,
        contentType: "application/gzip",
        customMetadata: { digest: digest("d") },
        bytes: Uint8Array.from([1, 2, 3]),
      });
      const failure = yield* Effect.flatMap(SandboxBundleStore, (store) =>
        store.putPluginBundle(requested, Uint8Array.from([1, 2, 3])),
      ).pipe(Effect.provide(sandboxBundleStoreLayer(memory.capabilities)), Effect.flip);
      assert.strictEqual(failure.reason, "metadata_mismatch");
      assert.strictEqual(memory.objects.get(key)?.customMetadata.digest, digest("d"));
    }),
  );

  it.effect("loads snapshot bytes with their pinned Plugin bundle digest", () =>
    Effect.gen(function* () {
      const memory = makeMemoryCapabilities();
      const layer = sandboxBundleStoreLayer(memory.capabilities);
      const bundleDigest = digest("e");
      const snapshotJson = '{"schemaVersion":1}\n';
      const snapshotDigest = yield* Effect.promise(() =>
        contentDigest(new TextEncoder().encode(snapshotJson)),
      );
      yield* Effect.flatMap(SandboxBundleStore, (store) =>
        store.putSnapshot({ snapshotDigest, snapshotJson, pluginBundleDigest: bundleDigest }),
      ).pipe(Effect.provide(layer));
      const loaded = yield* Effect.flatMap(SandboxBundleStore, (store) =>
        store.getSnapshot(snapshotDigest),
      ).pipe(Effect.provide(layer));
      assert.deepStrictEqual(loaded, { snapshotJson, pluginBundleDigest: bundleDigest });
    }),
  );

  it.effect("rejects immutable reads whose bytes do not match digest metadata", () =>
    Effect.gen(function* () {
      const memory = makeMemoryCapabilities();
      const expectedBytes = Uint8Array.from([1, 2, 3]);
      const requested = yield* Effect.promise(() => contentDigest(expectedBytes));
      const key = sandboxPluginBundleTarGzKey(requested);
      memory.objects.set(key, {
        key,
        size: 3,
        contentType: "application/gzip",
        customMetadata: { digest: requested },
        bytes: Uint8Array.from([3, 2, 1]),
      });
      const failure = yield* Effect.flatMap(SandboxBundleStore, (store) =>
        store.getPluginBundle(requested),
      ).pipe(Effect.provide(sandboxBundleStoreLayer(memory.capabilities)), Effect.flip);
      assert.strictEqual(failure.reason, "metadata_mismatch");

      memory.objects.set(key, {
        key,
        size: 3,
        contentType: "application/gzip",
        customMetadata: { digest: requested, legacySource: "remote" },
        bytes: expectedBytes,
      });
      const excessMetadata = yield* Effect.flatMap(SandboxBundleStore, (store) =>
        store.getPluginBundle(requested),
      ).pipe(Effect.provide(sandboxBundleStoreLayer(memory.capabilities)), Effect.flip);
      assert.strictEqual(excessMetadata.reason, "metadata_mismatch");
    }),
  );
});
