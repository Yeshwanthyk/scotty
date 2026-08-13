import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SandboxConfigAuthority } from "../src/sandbox-config-contracts";
import {
  type SandboxConfigAuthorityStorage,
  SandboxConfigStore,
  sandboxConfigStoreLayer,
} from "../src/sandbox-config-store";

const makeStorage = (initial?: unknown) => {
  let authority = initial;
  const storage: SandboxConfigAuthorityStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => authority,
        put: async (next) => {
          authority = next;
        },
      }),
  };
  return {
    layer: sandboxConfigStoreLayer(storage),
    snapshot: () => authority,
  };
};

describe("sandbox config store", () => {
  it.effect("returns the initial status on a fresh authority", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      const status = yield* Effect.flatMap(SandboxConfigStore, (store) => store.status()).pipe(
        Effect.provide(storage.layer),
      );
      assert.deepEqual(status, { schemaVersion: 1, revision: 0, activeDigest: null });
    }),
  );

  it.effect("activates a bundle with revision increment and idempotent replay", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      const activated = yield* Effect.flatMap(SandboxConfigStore, (store) =>
        store.activate({
          digest: "a".repeat(64),
          idempotencyKey: "sync-1",
          expectedRevision: 0,
        }),
      ).pipe(Effect.provide(storage.layer));
      assert.deepEqual(activated, {
        schemaVersion: 1,
        revision: 1,
        activeDigest: "a".repeat(64),
      });
      const replay = yield* Effect.flatMap(SandboxConfigStore, (store) =>
        store.activate({
          digest: "a".repeat(64),
          idempotencyKey: "sync-1",
          expectedRevision: 0,
        }),
      ).pipe(Effect.provide(storage.layer));
      assert.deepEqual(replay, activated);
      const persisted = storage.snapshot() as SandboxConfigAuthority;
      assert.strictEqual(persisted.revision, 1);
      assert.strictEqual(persisted.activeDigest, "a".repeat(64));
    }),
  );

  it.effect("does not increment revision when the active digest is already selected", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      const first = yield* Effect.flatMap(SandboxConfigStore, (store) =>
        store.activate({
          digest: "a".repeat(64),
          idempotencyKey: "sync-1",
          expectedRevision: 0,
        }),
      ).pipe(Effect.provide(storage.layer));
      const second = yield* Effect.flatMap(SandboxConfigStore, (store) =>
        store.activate({
          digest: "a".repeat(64),
          idempotencyKey: "sync-2",
          expectedRevision: 0,
        }),
      ).pipe(Effect.provide(storage.layer));
      assert.deepEqual(second, first);
      const persisted = storage.snapshot() as SandboxConfigAuthority;
      assert.strictEqual(persisted.revision, 1);
      assert.strictEqual(persisted.lastSync?.idempotencyKey, "sync-1");
    }),
  );

  it.effect("rejects stale If-Match and idempotency reuse with different input", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      yield* Effect.flatMap(SandboxConfigStore, (store) =>
        store.activate({
          digest: "a".repeat(64),
          idempotencyKey: "sync-1",
          expectedRevision: null,
        }),
      ).pipe(Effect.provide(storage.layer));
      const stale = yield* Effect.flip(
        Effect.flatMap(SandboxConfigStore, (store) =>
          store.activate({
            digest: "b".repeat(64),
            idempotencyKey: "sync-2",
            expectedRevision: 0,
          }),
        ).pipe(Effect.provide(storage.layer)),
      );
      assert.strictEqual(stale.reason, "conflict");
      const reused = yield* Effect.flip(
        Effect.flatMap(SandboxConfigStore, (store) =>
          store.activate({
            digest: "b".repeat(64),
            idempotencyKey: "sync-1",
            expectedRevision: null,
          }),
        ).pipe(Effect.provide(storage.layer)),
      );
      assert.strictEqual(reused.reason, "conflict");
      const persisted = storage.snapshot() as SandboxConfigAuthority;
      assert.strictEqual(persisted.activeDigest, "a".repeat(64));
    }),
  );

  it.effect("fails closed on malformed authority", () =>
    Effect.gen(function* () {
      const corrupt = makeStorage({ version: 1, revision: -1, activeDigest: null, lastSync: null });
      const invalid = yield* Effect.flip(
        Effect.flatMap(SandboxConfigStore, (store) => store.status()).pipe(
          Effect.provide(corrupt.layer),
        ),
      );
      assert.strictEqual(invalid.reason, "invalid_authority");
    }),
  );
});
