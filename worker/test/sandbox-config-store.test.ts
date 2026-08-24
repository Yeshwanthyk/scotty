import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { SandboxActivateInput, SandboxConfigAuthority } from "../src/sandbox-config-contracts";
import {
  type SandboxConfigAuthorityStorage,
  SandboxConfigStore,
  sandboxConfigStoreLayer,
} from "../src/sandbox-config-store";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const activation = (overrides: Partial<SandboxActivateInput> = {}): SandboxActivateInput => ({
  installationName: "home",
  cloudflareAccountId: "account-1",
  snapshotDigest: digest("a"),
  configDigest: digest("b"),
  expectedRevision: 0,
  idempotencyKey: "sync-1",
  ...overrides,
});

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
  return { layer: sandboxConfigStoreLayer(storage), snapshot: () => authority };
};

const activate = (layer: ReturnType<typeof sandboxConfigStoreLayer>, input: SandboxActivateInput) =>
  Effect.flatMap(SandboxConfigStore, (store) => store.activate(input)).pipe(Effect.provide(layer));

describe("SandboxConfigStore", () => {
  it.effect("starts unbound with no active snapshot", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      const status = yield* Effect.flatMap(SandboxConfigStore, (store) => store.status()).pipe(
        Effect.provide(storage.layer),
      );
      assert.deepStrictEqual(status, {
        schemaVersion: 1,
        installationName: null,
        cloudflareAccountId: null,
        revision: 0,
        activeSnapshot: null,
      });
    }),
  );

  it.effect("atomically activates and replays an identical idempotency input", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date("2026-08-24T12:34:56.000Z").getTime());
      const storage = makeStorage();
      const input = activation();
      const first = yield* activate(storage.layer, input);
      const replay = yield* activate(storage.layer, input);
      assert.deepStrictEqual(replay, first);
      assert.deepStrictEqual(first, {
        schemaVersion: 1,
        installationName: "home",
        cloudflareAccountId: "account-1",
        revision: 1,
        activeSnapshot: {
          revision: 1,
          snapshotDigest: digest("a"),
          configDigest: digest("b"),
          syncId: "sync-1",
          activatedAt: "2026-08-24T12:34:56.000Z",
        },
      });
      const persisted = storage.snapshot() as SandboxConfigAuthority;
      assert.strictEqual(persisted.revision, 1);
      assert.strictEqual(persisted.lastSync?.idempotencyKey, "sync-1");
    }),
  );

  it.effect("rejects stale revisions and idempotency-key reuse without changing authority", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      yield* activate(storage.layer, activation());
      const stale = yield* activate(
        storage.layer,
        activation({
          snapshotDigest: digest("c"),
          configDigest: digest("d"),
          idempotencyKey: "sync-2",
        }),
      ).pipe(Effect.flip);
      assert.strictEqual(stale.reason, "conflict");
      const reused = yield* activate(
        storage.layer,
        activation({ snapshotDigest: digest("c"), configDigest: digest("d") }),
      ).pipe(Effect.flip);
      assert.strictEqual(reused.reason, "conflict");
      const persisted = storage.snapshot() as SandboxConfigAuthority;
      assert.strictEqual(persisted.revision, 1);
      assert.strictEqual(persisted.activeSnapshot?.snapshotDigest, digest("a"));
    }),
  );

  it.effect("keeps Installation name and account binding immutable", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      yield* activate(storage.layer, activation());
      for (const input of [
        activation({ installationName: "other", expectedRevision: 1, idempotencyKey: "sync-2" }),
        activation({
          cloudflareAccountId: "account-2",
          expectedRevision: 1,
          idempotencyKey: "sync-3",
        }),
      ]) {
        const failure = yield* activate(storage.layer, input).pipe(Effect.flip);
        assert.strictEqual(failure.reason, "conflict");
      }
      const persisted = storage.snapshot() as SandboxConfigAuthority;
      assert.strictEqual(persisted.installationName, "home");
      assert.strictEqual(persisted.cloudflareAccountId, "account-1");
      assert.strictEqual(persisted.revision, 1);
    }),
  );

  it.effect("fails closed on malformed persisted authority", () =>
    Effect.gen(function* () {
      const corrupt = makeStorage({
        version: 1,
        revision: -1,
        activeSnapshot: null,
        lastSync: null,
      });
      const failure = yield* Effect.flatMap(SandboxConfigStore, (store) => store.status()).pipe(
        Effect.provide(corrupt.layer),
        Effect.flip,
      );
      assert.strictEqual(failure.reason, "invalid_authority");
    }),
  );
});
