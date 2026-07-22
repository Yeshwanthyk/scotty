import { assert, describe, it } from "@effect/vitest";
import type { BackupOptions, RestoreBackupResult } from "@cloudflare/sandbox";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  BackupStore,
  BackupStoreFailure,
  backupStoreLayer,
  type BackupCapabilities,
  type BackupObjectPage,
} from "../src/backup-store";
import type { DirectoryBackup } from "../src/contracts";

const backup: DirectoryBackup = {
  id: "backup-1",
  dir: "/workspace/a0b1c2d3e4f5",
  localBucket: true,
};

class FakeBackupCapabilities implements BackupCapabilities {
  readonly createCalls: BackupOptions[] = [];
  readonly restoreCalls: DirectoryBackup[] = [];
  readonly listCalls: Array<{ prefix: string; cursor?: string }> = [];
  readonly deleteCalls: ReadonlyArray<string>[] = [];
  readonly pages: BackupObjectPage[] = [];
  fail?: "create" | "delete" | "list" | "restore";
  createFailuresRemaining = 0;

  createBackup = async (options: BackupOptions): Promise<DirectoryBackup> => {
    this.createCalls.push(options);
    if (this.fail === "create") return Promise.reject("provider create details");
    if (this.createFailuresRemaining > 0) {
      this.createFailuresRemaining -= 1;
      return Promise.reject("provider create details");
    }
    return backup;
  };

  restoreBackup = async (value: DirectoryBackup): Promise<RestoreBackupResult> => {
    this.restoreCalls.push(value);
    if (this.fail === "restore") return Promise.reject("provider restore details");
    return { success: true, id: value.id, dir: value.dir };
  };

  listObjects = async (prefix: string, cursor?: string): Promise<BackupObjectPage> => {
    this.listCalls.push({ prefix, cursor });
    if (this.fail === "list") return Promise.reject("provider list details");
    return this.pages.shift() ?? { keys: [] };
  };

  deleteObjects = async (keys: ReadonlyArray<string>): Promise<void> => {
    this.deleteCalls.push(keys);
    if (this.fail === "delete") return Promise.reject("provider delete details");
  };
}

const withStore = <A, E>(
  capabilities: BackupCapabilities,
  effect: Effect.Effect<A, E, BackupStore>,
): Effect.Effect<A, E> => Effect.provide(effect, backupStoreLayer(capabilities));

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("BackupStore", () => {
  it.effect("passes exact create and restore arguments to the Sandbox capability", () =>
    Effect.gen(function* () {
      const capabilities = new FakeBackupCapabilities();
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
      assert.deepStrictEqual(capabilities.createCalls, [options]);
      assert.deepStrictEqual(capabilities.restoreCalls, [backup]);
    }),
  );

  it.effect("retries one first-create failure after a bounded delay", () =>
    Effect.gen(function* () {
      const capabilities = new FakeBackupCapabilities();
      capabilities.createFailuresRemaining = 1;
      const options: BackupOptions = { dir: backup.dir, localBucket: true };
      const fiber = yield* Effect.forkChild(
        withStore(
          capabilities,
          Effect.flatMap(BackupStore, (store) => store.create(options)),
        ),
      );

      yield* TestClock.adjust("999 millis");
      assert.strictEqual(capabilities.createCalls.length, 1);
      yield* TestClock.adjust("1 millis");
      const created = yield* Fiber.join(fiber);

      assert.strictEqual(created, backup);
      assert.deepStrictEqual(capabilities.createCalls, [options, options]);
    }),
  );

  it.effect("deletes every paginated object under only the requested backup prefix", () =>
    Effect.gen(function* () {
      const capabilities = new FakeBackupCapabilities();
      capabilities.pages.push(
        { keys: ["backups/backup-1/archive", "backups/backup-1/meta.json"], cursor: "next" },
        { keys: [], cursor: "empty" },
        { keys: ["backups/backup-1/part"] },
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.delete("backup-1")),
      );

      assert.deepStrictEqual(capabilities.listCalls, [
        { prefix: "backups/backup-1/", cursor: undefined },
        { prefix: "backups/backup-1/", cursor: "next" },
        { prefix: "backups/backup-1/", cursor: "empty" },
      ]);
      assert.deepStrictEqual(capabilities.deleteCalls, [
        ["backups/backup-1/archive", "backups/backup-1/meta.json"],
        ["backups/backup-1/part"],
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
        const capabilities = new FakeBackupCapabilities();
        capabilities.fail = operation;
        if (operation === "delete") capabilities.pages.push({ keys: ["backups/backup-1/a"] });
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
        assert.strictEqual(capabilities.createCalls.length, expectedCreateCalls);
      }
    }),
  );

  it.effect("reconstructs from capabilities without runtime-memory state", () =>
    Effect.gen(function* () {
      const capabilities = new FakeBackupCapabilities();
      const created = yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.create({ dir: backup.dir })),
      );
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.restore(structuredClone(created))),
      );
      capabilities.pages.push({ keys: ["backups/backup-1/archive"] });
      yield* withStore(
        capabilities,
        Effect.flatMap(BackupStore, (store) => store.delete(created.id)),
      );
      assert.deepStrictEqual(capabilities.restoreCalls, [backup]);
      assert.deepStrictEqual(capabilities.deleteCalls, [["backups/backup-1/archive"]]);
    }),
  );
});
