import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  listRepoProjections,
  RepoProjection,
  RepoProjectionFailure,
  repoProjectionLayer,
  type RepoProjectionStorage,
  trackRepoBestEffort,
} from "../src/repo-projection";

const NOW = Date.parse("2026-07-23T12:34:56.000Z");

class MemoryRepoProjectionStorage implements RepoProjectionStorage {
  readonly values = new Map<string, unknown>();
  fail?: "get" | "list" | "put";

  get = async (key: string): Promise<unknown | null> => {
    if (this.fail === "get") return Promise.reject("get failed");
    return this.values.get(key) ?? null;
  };

  list = async (): Promise<{ keys: ReadonlyArray<string> }> => {
    if (this.fail === "list") return Promise.reject("list failed");
    return { keys: [...this.values.keys()] };
  };

  put = async (key: string, value: string): Promise<void> => {
    if (this.fail === "put") return Promise.reject("put failed");
    this.values.set(key, JSON.parse(value));
  };
}

const withProjection = <A, E>(
  storage: RepoProjectionStorage,
  effect: Effect.Effect<A, E, RepoProjection>,
): Effect.Effect<A, E> => Effect.provide(effect, repoProjectionLayer(storage));

describe("RepoProjection", () => {
  it.effect("upserts one repository key with Clock time", () =>
    Effect.gen(function* () {
      const storage = new MemoryRepoProjectionStorage();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "main"));

      assert.strictEqual(storage.values.size, 1);
      assert.deepStrictEqual(storage.values.get("repo:owner/repo"), {
        version: 1,
        repo: "owner/repo",
        defaultBranch: "main",
        lastUsedAt: "2026-07-23T12:34:56.000Z",
      });

      yield* TestClock.setTime(NOW + 1_000);
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "trunk"));
      assert.strictEqual(storage.values.size, 1);
      assert.deepStrictEqual(storage.values.get("repo:owner/repo"), {
        version: 1,
        repo: "owner/repo",
        defaultBranch: "trunk",
        lastUsedAt: "2026-07-23T12:34:57.000Z",
      });
    }),
  );

  it.effect("skips malformed neighbors and key mismatches, strips extras, and orders repos", () =>
    Effect.gen(function* () {
      const storage = new MemoryRepoProjectionStorage();
      const valid = {
        version: 1,
        repo: "owner/newer",
        defaultBranch: "main",
        lastUsedAt: "2026-07-23T12:00:00.000Z",
        secret: "strip me",
      };
      storage.values.set("repo:owner/newer", valid);
      storage.values.set("repo:owner/older", {
        ...valid,
        repo: "owner/older",
        lastUsedAt: "2026-07-22T12:00:00.000Z",
      });
      storage.values.set("repo:owner/mismatch", { ...valid, repo: "owner/different" });
      storage.values.set("repo:owner/version", {
        ...valid,
        repo: "owner/version",
        version: 2,
      });
      storage.values.set("repo:owner/time", {
        ...valid,
        repo: "owner/time",
        lastUsedAt: "not-a-time",
      });
      storage.values.set("repo:owner/branch", {
        ...valid,
        repo: "owner/branch",
        defaultBranch: 123,
      });
      storage.values.set("repo:owner/json", "{");

      const repositories = yield* withProjection(storage, listRepoProjections);
      assert.deepStrictEqual(
        repositories.map((repository) => repository.repo),
        ["owner/newer", "owner/older"],
      );
      assert.ok(!("secret" in repositories[0]));
      assert.deepStrictEqual(repositories[0], {
        repo: "owner/newer",
        defaultBranch: "main",
        lastUsedAt: "2026-07-23T12:00:00.000Z",
      });
    }),
  );

  it.effect("keeps provider failures typed and writes best effort", () =>
    Effect.gen(function* () {
      const storage = new MemoryRepoProjectionStorage();
      storage.fail = "put";
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "main"));
      assert.strictEqual(storage.values.size, 0);

      storage.values.set("repo:owner/repo", {});
      storage.fail = "get";
      const getResult = yield* Effect.result(withProjection(storage, listRepoProjections));
      assert.ok(Result.isFailure(getResult));
      assert.deepStrictEqual(getResult.failure, new RepoProjectionFailure({ operation: "get" }));

      storage.fail = "list";
      const listResult = yield* Effect.result(withProjection(storage, listRepoProjections));
      assert.ok(Result.isFailure(listResult));
      assert.deepStrictEqual(listResult.failure, new RepoProjectionFailure({ operation: "list" }));
    }),
  );

  it.effect("continues listing across empty pages", () =>
    Effect.gen(function* () {
      const storage = new MemoryRepoProjectionStorage();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "main"));
      const paged: RepoProjectionStorage = {
        get: storage.get,
        list: async (cursor) =>
          cursor === undefined ? { keys: [], cursor: "next" } : { keys: ["repo:owner/repo"] },
        put: storage.put,
      };

      const repositories = yield* withProjection(paged, listRepoProjections);
      assert.deepStrictEqual(repositories, [
        {
          repo: "owner/repo",
          defaultBranch: "main",
          lastUsedAt: "2026-07-23T12:34:56.000Z",
        },
      ]);
    }),
  );
});
