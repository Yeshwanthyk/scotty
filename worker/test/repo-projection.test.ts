import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  listRepoProjections,
  RepoProjection,
  RepoProjectionFailure,
  repoProjectionLayer,
  trackRepoBestEffort,
} from "../src/repo-projection";
import { InMemoryFaultInjectableFake, repoProjectionStorageFake } from "./support";

const NOW = Date.parse("2026-07-23T12:34:56.000Z");

const withProjection = <A, E>(
  memory: InMemoryFaultInjectableFake,
  effect: Effect.Effect<A, E, RepoProjection>,
): Effect.Effect<A, E> =>
  Effect.provide(effect, repoProjectionLayer(repoProjectionStorageFake(memory)));

describe("RepoProjection", () => {
  it.effect("upserts one repository key with Clock time", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
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
      const storage = new InMemoryFaultInjectableFake();
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
      const storage = new InMemoryFaultInjectableFake();
      storage.injectFailure("put");
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "main"));
      assert.strictEqual(storage.values.size, 0);

      storage.values.set("repo:owner/repo", {});
      storage.clearFailure();
      storage.injectFailure("get");
      const getResult = yield* Effect.result(withProjection(storage, listRepoProjections));
      assert.ok(Result.isFailure(getResult));
      assert.deepStrictEqual(getResult.failure, new RepoProjectionFailure({ operation: "get" }));

      storage.clearFailure();
      storage.injectFailure("list");
      const listResult = yield* Effect.result(withProjection(storage, listRepoProjections));
      assert.ok(Result.isFailure(listResult));
      assert.deepStrictEqual(listResult.failure, new RepoProjectionFailure({ operation: "list" }));
    }),
  );

  it.effect("continues listing across empty pages", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "main"));
      storage.handle("list", (cursor) =>
        cursor === undefined ? { keys: [], cursor: "next" } : { keys: ["repo:owner/repo"] },
      );

      const repositories = yield* withProjection(storage, listRepoProjections);
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
