import { assert, describe, it } from "@effect/vitest";
import type { BackupOptions } from "@cloudflare/sandbox";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  BackupStore,
  BackupStoreFailure,
  backupStoreLayer,
  type BackupCapabilities,
} from "../src/backup-store";
import type { DirectoryBackup } from "../src/contracts";
import {
  backupCapabilitiesFake,
  deployedBackupStoreEnabled,
  InMemoryFaultInjectableFake,
  makeDeployedBackupCapabilities,
  runContractSuite,
  type BackupCapabilitiesContract,
} from "./support";

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
            store.create({
              dir,
              name: `scotty-contract-${crypto.randomUUID()}`,
              ttl: 900,
              localBucket: true,
              compression: { format: "zstd" },
            }),
          ),
        );
        assert.strictEqual(created.dir, dir);
        assert.ok(created.id.length > 0);

        yield* withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) => store.restore(created)),
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
        Effect.flatMap(BackupStore, (store) => store.create(options)),
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.restore(created)),
      );

      assert.strictEqual(created, backup);
      assert.deepStrictEqual(memory.calls("create"), [[options]]);
      assert.deepStrictEqual(memory.calls("restore"), [[backup]]);
    }),
  );

  it.effect("retries one first-create failure after a bounded delay", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      memory.injectFailure("create", { error: "provider create details", times: 1 });
      const capabilities = backupCapabilitiesFake(memory, backup);
      const options: BackupOptions = { dir: backup.dir, localBucket: true };
      const fiber = yield* Effect.forkChild(
        withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) => store.create(options)),
        ),
      );

      yield* TestClock.adjust("999 millis");
      assert.strictEqual(memory.calls("create").length, 1);
      yield* TestClock.adjust("1 millis");
      const created = yield* Fiber.join(fiber);

      assert.strictEqual(created, backup);
      assert.deepStrictEqual(memory.calls("create"), [[options], [options]]);
    }),
  );

  it.effect("deletes every paginated object under only the requested backup prefix", () =>
    Effect.gen(function* () {
      const memory = new InMemoryFaultInjectableFake();
      const capabilities = backupCapabilitiesFake(memory, backup);
      memory.pages.push(
        { keys: ["backups/backup-1/archive", "backups/backup-1/meta.json"], cursor: "next" },
        { keys: [], cursor: "empty" },
        { keys: ["backups/backup-1/part"] },
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.delete("backup-1")),
      );

      assert.deepStrictEqual(memory.calls("list"), [
        ["backups/backup-1/", undefined],
        ["backups/backup-1/", "next"],
        ["backups/backup-1/", "empty"],
      ]);
      assert.deepStrictEqual(memory.calls("delete"), [
        [["backups/backup-1/archive", "backups/backup-1/meta.json"]],
        [["backups/backup-1/part"]],
      ]);
    }),
  );

  it.effect("maps provider failures to fixed redacted typed failures", () =>
    Effect.gen(function* () {
      for (const [operation, expectedCreateCalls] of [
        ["create", 2],
        ["restore", 0],
        ["list", 0],
        ["delete", 0],
      ] as const) {
        const memory = new InMemoryFaultInjectableFake();
        const capabilities = backupCapabilitiesFake(memory, backup);
        memory.injectFailure(operation, { error: `provider ${operation} details` });
        if (operation === "delete") memory.pages.push({ keys: ["backups/backup-1/a"] });
        const effect =
          operation === "create"
            ? Effect.flatMap(BackupStore, (store) => store.create({ dir: backup.dir }))
            : operation === "restore"
              ? Effect.flatMap(BackupStore, (store) => store.restore(backup))
              : Effect.flatMap(BackupStore, (store) => store.delete(backup.id));
        const fiber = yield* Effect.forkChild(Effect.result(withStore(capabilities, effect)));
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
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
        Effect.flatMap(BackupStore, (store) => store.create({ dir: backup.dir })),
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.restore(structuredClone(created))),
      );
      memory.pages.push({ keys: ["backups/backup-1/archive"] });
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.delete(created.id)),
      );
      assert.deepStrictEqual(memory.calls("restore"), [[backup]]);
      assert.deepStrictEqual(memory.calls("delete"), [[["backups/backup-1/archive"]]]);
    }),
  );
});
