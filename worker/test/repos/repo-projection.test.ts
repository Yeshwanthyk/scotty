import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  forgetRepoProjection,
  listRepoProjections,
  projectRepoEntryBestEffort,
  RepoProjection,
  RepoProjectionFailure,
  rebuildRepoProjection,
  repoProjectionMatches,
  repoProjectionLayer,
  trackRepoBestEffort,
} from "../../src/repos/projection";
import { InMemoryFaultInjectableFake, repoProjectionStorageFake } from "../support";

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
        repo: "owner/repo",
        defaultBranch: "main",
        lastUsedAt: "2026-07-23T12:34:56.000Z",
      });

      yield* TestClock.setTime(NOW + 1_000);
      yield* withProjection(storage, trackRepoBestEffort("owner/repo", "trunk"));
      assert.strictEqual(storage.values.size, 1);
      assert.deepStrictEqual(storage.values.get("repo:owner/repo"), {
        repo: "owner/repo",
        defaultBranch: "trunk",
        lastUsedAt: "2026-07-23T12:34:57.000Z",
      });
    }),
  );

  it.effect("forgets every case variant and keeps deletion failures typed", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      storage.values.set("repo:owner/remove", {
        repo: "owner/remove",
        defaultBranch: "main",
        lastUsedAt: "2026-07-23T12:00:00.000Z",
      });
      storage.values.set("repo:OWNER/REMOVE", {
        repo: "OWNER/REMOVE",
        defaultBranch: "main",
        lastUsedAt: "2026-07-23T11:00:00.000Z",
      });
      storage.values.set("repo:owner/keep", {
        repo: "owner/keep",
        defaultBranch: "main",
        lastUsedAt: "2026-07-22T12:00:00.000Z",
      });
      storage.values.set("session:a0b1c2d3e4f5", { repo: "owner/remove" });

      yield* withProjection(storage, forgetRepoProjection("owner/remove"));
      yield* withProjection(storage, forgetRepoProjection("owner/remove"));

      assert.isFalse(storage.values.has("repo:owner/remove"));
      assert.isFalse(storage.values.has("repo:OWNER/REMOVE"));
      assert.isTrue(storage.values.has("repo:owner/keep"));
      assert.isTrue(storage.values.has("session:a0b1c2d3e4f5"));

      storage.injectFailure("delete");
      const result = yield* Effect.result(
        withProjection(storage, forgetRepoProjection("owner/keep")),
      );
      assert.ok(Result.isFailure(result));
      assert.deepStrictEqual(result.failure, new RepoProjectionFailure({ operation: "delete" }));
    }),
  );

  it.effect("skips malformed neighbors and key mismatches, strips extras, and orders repos", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      const valid = {
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

  it.effect("matches the authority without writes and detects stale values", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      const entry = {
        repo: "owner/repo",
        defaultBranch: "main",
        addedAt: "2026-07-23T12:00:00.000Z",
        lastUsedAt: "2026-07-23T12:34:56.000Z",
      };
      yield* withProjection(storage, projectRepoEntryBestEffort(entry));
      const putsBefore = storage.calls("put").length;
      const deletesBefore = storage.calls("delete").length;
      const matches = yield* withProjection(storage, repoProjectionMatches([entry]));
      assert.isTrue(matches);
      assert.strictEqual(storage.calls("put").length, putsBefore);
      assert.strictEqual(storage.calls("delete").length, deletesBefore);

      const stale = yield* withProjection(
        storage,
        repoProjectionMatches([{ ...entry, defaultBranch: "trunk" }]),
      );
      assert.isFalse(stale);
    }),
  );

  it.effect("rebuilds every repository projection and removes stale repository keys only", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      storage.values.set("repo:owner/stale", {
        repo: "owner/stale",
        defaultBranch: "main",
        addedAt: "2026-07-20T12:00:00.000Z",
        lastUsedAt: "2026-07-20T12:00:00.000Z",
      });
      storage.values.set("repo:OWNER/KEEP", {
        repo: "OWNER/KEEP",
        defaultBranch: "main",
        addedAt: "2026-07-21T12:00:00.000Z",
        lastUsedAt: "2026-07-21T12:00:00.000Z",
      });
      storage.values.set("session:keep", { status: "warm" });
      const entries = [
        {
          repo: "owner/newer",
          defaultBranch: "trunk",
          addedAt: "2026-07-22T12:00:00.000Z",
          lastUsedAt: "2026-07-23T12:00:00.000Z",
        },
        {
          repo: "owner/older",
          defaultBranch: "main",
          addedAt: "2026-07-19T12:00:00.000Z",
          lastUsedAt: "2026-07-20T12:00:00.000Z",
        },
      ];

      yield* withProjection(storage, rebuildRepoProjection(entries));
      assert.isFalse(storage.values.has("repo:owner/stale"));
      assert.isFalse(storage.values.has("repo:OWNER/KEEP"));
      assert.deepStrictEqual(storage.values.get("session:keep"), { status: "warm" });
      assert.deepStrictEqual(storage.values.get("repo:owner/newer"), {
        ...entries[0],
      });
      assert.deepStrictEqual(storage.values.get("repo:owner/older"), {
        ...entries[1],
      });
      assert.deepStrictEqual(
        storage.calls("delete").map(([key]) => key),
        ["repo:owner/stale", "repo:OWNER/KEEP"],
      );
    }),
  );
});
