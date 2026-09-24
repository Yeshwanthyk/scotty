import { assert, describe, it } from "@effect/vitest";
import type { BackupOptions } from "@cloudflare/sandbox";
import { Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  BackupStore,
  BackupStoreFailure,
  BackupStoreTimeout,
  backupStoreLayer,
  type BackupCapabilities,
} from "../../src/backups/store";
import type { DirectoryBackup } from "../../src/session/contracts";
import {
  backupCapabilitiesFake,
  deployedBackupStoreEnabled,
  InMemoryFaultInjectableFake,
  makeDeployedBackupCapabilities,
  runContractSuite,
  type BackupCapabilitiesContract,
} from "../support";

const backup: DirectoryBackup = {
  id: "backup-1",
  dir: "/workspace/a0b1c2d3e4f5",
  localBucket: true,
};

const withStore = <A, E>(
  capabilities: BackupCapabilities,
  effect: Effect.Effect<A, E, BackupStore>,
): Effect.Effect<A, E> => Effect.provide(effect, backupStoreLayer(capabilities));

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const makeInMemoryBackupCapabilities = (): BackupCapabilitiesContract => ({
  capabilities: backupCapabilitiesFake(new InMemoryFaultInjectableFake(), backup),
  dir: backup.dir,
});

runContractSuite<() => BackupCapabilitiesContract>(
  "BackupStore adapter contract",
  [
    { name: "in-memory", make: makeInMemoryBackupCapabilities },
    {
      name: "deployed Sandbox and R2",
      make: makeDeployedBackupCapabilities,
      enabled: deployedBackupStoreEnabled,
    },
  ],
  ({ make }) => {
    it.effect("creates, restores, and deletes a backup through the adapter", () =>
      Effect.gen(function* () {
        const { capabilities, dir } = make();
        const created = yield* withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) =>
            store.create(
              {
                dir,
                name: `scotty-contract-${crypto.randomUUID()}`,
                ttl: 900,
                localBucket: true,
                compression: { format: "zstd" },
              },
              Duration.millis(60_000),
            ),
          ),
        );
        assert.strictEqual(created.dir, dir);
        assert.ok(created.id.length > 0);

        yield* withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) => store.restore(created, Duration.millis(60_000))),
        );
        yield* withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) => store.delete(created.id)),
        );
      }),
    );
  },
);

describe("BackupStore", () => {
  for (const operation of ["create", "restore"] satisfies ReadonlyArray<"create" | "restore">) {
    it.effect(`times out a pending ${operation} without claiming its provider outcome`, () =>
      Effect.gen(function* () {
        const capabilities: BackupCapabilities = {
          createBackup: () => new Promise<DirectoryBackup>(() => {}),
          restoreBackup: () => new Promise(() => {}),
          deleteBackup: async () => undefined,
        };
        const fiber = yield* withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) =>
            Effect.result(
              operation === "create"
                ? store.create({ dir: backup.dir }, Duration.millis(5_000))
                : store.restore(backup, Duration.millis(5_000)),
            ),
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(4_999);
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust(1);
        assert.deepStrictEqual(
          yield* Fiber.join(fiber),
          Result.fail(new BackupStoreTimeout({ operation })),
        );
      }),
    );
  }

  it.effect("passes exact create and restore arguments to the Sandbox capability", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = backupCapabilitiesFake(memory, backup);
      const options: BackupOptions = {
        dir: "/workspace/a0b1c2d3e4f5",
        name: "scotty-a0b1c2d3e4f5-123",
        ttl: 30 * 24 * 60 * 60,
        localBucket: true,
        compression: { format: "zstd" },
      };
      const created = yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.create(options, Duration.millis(60_000))),
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.restore(created, Duration.millis(60_000))),
      );

      assert.strictEqual(created, backup);
      assert.deepStrictEqual(memory.calls("create"), [[options]]);
      assert.deepStrictEqual(memory.calls("restore"), [[backup]]);
    }),
  );

  it.effect("denies runtime access before invoking restore", () =>
    Effect.gen(function* () {
      let calls = 0;
      const capabilities: BackupCapabilities = {
        ...backupCapabilitiesFake(new InMemoryFaultInjectableFake(), backup),
        restoreBackup: () => {
          calls += 1;
          return Promise.resolve({ success: true, id: backup.id, dir: backup.dir });
        },
      };
      const result = yield* Effect.result(
        Effect.provide(
          Effect.flatMap(BackupStore, (store) => store.restore(backup, Duration.millis(60_000))),
          backupStoreLayer(capabilities, Effect.fail("runtime access denied")),
        ),
      );

      assert.deepStrictEqual(failure(result), new BackupStoreFailure({ operation: "restore" }));
      assert.strictEqual(calls, 0);
    }),
  );

  it.effect("does not retry an ambiguous create outcome", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      memory.injectFailure("create", { error: "provider create details", times: 1 });
      const capabilities = backupCapabilitiesFake(memory, backup);
      const options: BackupOptions = { dir: backup.dir, localBucket: true };
      const outcome = yield* Effect.result(
        withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) => store.create(options, Duration.millis(60_000))),
        ),
      );

      assert.ok(Result.isFailure(outcome));
      assert.deepStrictEqual(outcome.failure, new BackupStoreFailure({ operation: "create" }));
      assert.strictEqual(memory.calls("create").length, 1);
      assert.deepStrictEqual(memory.calls("create"), [[options]]);
    }),
  );

  it.effect("delegates deletion to the Sandbox backup queue", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = backupCapabilitiesFake(memory, backup);
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.delete("backup-1")),
      );

      assert.deepStrictEqual(memory.calls("delete"), [["backup-1"]]);
    }),
  );

  it.effect("maps provider failures to fixed redacted typed failures", () =>
    Effect.gen(function* () {
      for (const [operation, expectedCreateCalls] of [
        ["create", 1],
        ["restore", 0],
        ["delete", 0],
      ] as const) {
        const memory = new InMemoryFaultInjectableFake();
        const capabilities = backupCapabilitiesFake(memory, backup);
        memory.injectFailure(operation, { error: `provider ${operation} details` });
        const effect =
          operation === "create"
            ? Effect.flatMap(BackupStore, (store) =>
                store.create({ dir: backup.dir }, Duration.millis(60_000)),
              )
            : operation === "restore"
              ? Effect.flatMap(BackupStore, (store) =>
                  store.restore(backup, Duration.millis(60_000)),
                )
              : Effect.flatMap(BackupStore, (store) => store.delete(backup.id));
        const result = yield* Effect.result(withStore(capabilities, effect));
        assert.deepStrictEqual(failure(result), new BackupStoreFailure({ operation }));
        assert.ok(!JSON.stringify(failure(result)).includes("provider"));
        assert.strictEqual(memory.calls("create").length, expectedCreateCalls);
      }
    }),
  );

  it.effect("reconstructs from capabilities without runtime-memory state", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = backupCapabilitiesFake(memory, backup);
      const created = yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) =>
          store.create({ dir: backup.dir }, Duration.millis(60_000)),
        ),
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) =>
          store.restore(structuredClone(created), Duration.millis(60_000)),
        ),
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.delete(created.id)),
      );
      assert.deepStrictEqual(memory.calls("restore"), [[backup]]);
      assert.deepStrictEqual(memory.calls("delete"), [["backup-1"]]);
    }),
  );
});
