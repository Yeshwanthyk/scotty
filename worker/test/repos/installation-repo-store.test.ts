import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  InstallationRepoFailure,
  InstallationRepoStore,
  installationRepoStoreLayer,
  type InstallationRepoAuthorityStorage,
} from "../../src/repos/installation-store";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

const makeStorage = (initial?: unknown) => {
  let authority = structuredClone(initial);
  const writes: unknown[] = [];
  const storage: InstallationRepoAuthorityStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => structuredClone(authority),
        put: async (value) => {
          writes.push(structuredClone(value));
          authority = structuredClone(value);
        },
      }),
  };
  return {
    storage,
    writes,
    authority: () => structuredClone(authority),
  };
};

const withStore = <A, E>(
  storage: InstallationRepoAuthorityStorage,
  effect: Effect.Effect<A, E, InstallationRepoStore>,
): Effect.Effect<A, E> => Effect.provide(effect, installationRepoStoreLayer(storage));

const failureReason = <A>(result: Result.Result<A, InstallationRepoFailure>): string =>
  Result.match(result, {
    onFailure: (failure) => failure.reason,
    onSuccess: () => assert.fail("expected an installation repository failure"),
  });

describe("InstallationRepoStore", () => {
  it.effect("upserts with Clock timestamps, preserves addedAt, and orders deterministically", () =>
    Effect.gen(function* () {
      const fake = makeStorage();
      yield* TestClock.setTime(NOW);
      const first = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) =>
          store.upsert({ repo: "owner/older", defaultBranch: "main" }),
        ),
      );
      assert.deepStrictEqual(first, {
        repo: "owner/older",
        defaultBranch: "main",
        addedAt: "2026-08-15T12:00:00.000Z",
        lastUsedAt: "2026-08-15T12:00:00.000Z",
      });

      yield* TestClock.setTime(NOW + 1_000);
      const second = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) =>
          store.upsert({ repo: "owner/newer", defaultBranch: "trunk" }),
        ),
      );
      assert.strictEqual(second.addedAt, "2026-08-15T12:00:01.000Z");

      yield* TestClock.setTime(NOW + 2_000);
      const updated = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) =>
          store.upsert({ repo: "OWNER/OLDER", defaultBranch: "develop" }),
        ),
      );
      assert.strictEqual(updated.addedAt, "2026-08-15T12:00:00.000Z");
      assert.strictEqual(updated.lastUsedAt, "2026-08-15T12:00:02.000Z");

      yield* TestClock.setTime(NOW - 1_000);
      const replayedAtEarlierClock = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) =>
          store.upsert({ repo: "owner/older", defaultBranch: "feature" }),
        ),
      );
      assert.strictEqual(replayedAtEarlierClock.defaultBranch, "feature");
      assert.strictEqual(replayedAtEarlierClock.addedAt, "2026-08-15T12:00:00.000Z");
      assert.strictEqual(replayedAtEarlierClock.lastUsedAt, "2026-08-15T12:00:02.000Z");

      const listed = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) => store.list),
      );
      assert.deepStrictEqual(listed, [replayedAtEarlierClock, second]);
      assert.deepStrictEqual(fake.authority(), {
        entries: [replayedAtEarlierClock, second],
      });
      assert.strictEqual(fake.writes.length, 4);

      const writesBeforeList = fake.writes.length;
      yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) => store.list),
      );
      assert.strictEqual(fake.writes.length, writesBeforeList);
    }),
  );

  it.effect("rejects corrupt authority and invalid upsert/remove boundaries", () =>
    Effect.gen(function* () {
      const corrupt = makeStorage({
        entries: [
          {
            repo: "owner/repo",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:00.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
            secret: "must not survive",
          },
        ],
      });
      const corruptResult = yield* Effect.result(
        withStore(
          corrupt.storage,
          Effect.flatMap(InstallationRepoStore, (store) => store.list),
        ),
      );
      assert.ok(Result.isFailure(corruptResult));
      assert.strictEqual(failureReason(corruptResult), "invalid_authority");

      const valid = makeStorage();
      for (const input of [
        { repo: "owner/repo", defaultBranch: "main", extra: true },
        { repo: "owner/repo", defaultBranch: "bad..branch" },
        { repo: "owner/repo" },
      ]) {
        const result = yield* Effect.result(
          withStore(
            valid.storage,
            Effect.flatMap(InstallationRepoStore, (store) => store.upsert(input)),
          ),
        );
        assert.ok(Result.isFailure(result));
      }

      const removeResult = yield* Effect.result(
        withStore(
          valid.storage,
          Effect.flatMap(InstallationRepoStore, (store) => store.remove("not a repo")),
        ),
      );
      assert.ok(Result.isFailure(removeResult));
      assert.strictEqual(valid.writes.length, 0);
    }),
  );

  it.effect("fails closed on duplicate identities and leaves a remove no-op unwritten", () =>
    Effect.gen(function* () {
      const corrupt = makeStorage({
        entries: [
          {
            repo: "owner/repo",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:00.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
          },
          {
            repo: "OWNER/REPO",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:00.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
          },
        ],
      });
      const listResult = yield* Effect.result(
        withStore(
          corrupt.storage,
          Effect.flatMap(InstallationRepoStore, (store) => store.list),
        ),
      );
      assert.ok(Result.isFailure(listResult));
      assert.strictEqual(failureReason(listResult), "invalid_authority");

      const fake = makeStorage({
        entries: [
          {
            repo: "owner/repo",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:00.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
          },
        ],
      });
      const removed = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) => store.remove("owner/missing")),
      );
      assert.isFalse(removed);
      assert.deepStrictEqual(fake.authority(), {
        entries: [
          {
            repo: "owner/repo",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:00.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
          },
        ],
      });
      assert.strictEqual(fake.writes.length, 0);
    }),
  );

  it.effect("rejects an authority whose usage time predates its added time", () =>
    Effect.gen(function* () {
      const corrupt = makeStorage({
        entries: [
          {
            repo: "owner/repo",
            defaultBranch: "main",
            addedAt: "2026-08-15T12:00:01.000Z",
            lastUsedAt: "2026-08-15T12:00:00.000Z",
          },
        ],
      });
      const result = yield* Effect.result(
        withStore(
          corrupt.storage,
          Effect.flatMap(InstallationRepoStore, (store) => store.list),
        ),
      );
      assert.ok(Result.isFailure(result));
      assert.strictEqual(failureReason(result), "invalid_authority");
      assert.strictEqual(corrupt.writes.length, 0);
    }),
  );

  it.effect("returns typed failures when authority storage rejects reads or writes", () =>
    Effect.gen(function* () {
      const readFailure: InstallationRepoAuthorityStorage = {
        transaction: () => Promise.reject("read failed"),
      };
      const readResult = yield* Effect.result(
        withStore(
          readFailure,
          Effect.flatMap(InstallationRepoStore, (store) => store.list),
        ),
      );
      assert.ok(Result.isFailure(readResult));
      assert.strictEqual(failureReason(readResult), "storage");

      let writes = 0;
      const writeFailure: InstallationRepoAuthorityStorage = {
        transaction: async (operation) =>
          operation({
            get: async () => undefined,
            put: async () => {
              writes += 1;
              return Promise.reject("write failed");
            },
          }),
      };
      const writeResult = yield* Effect.result(
        withStore(
          writeFailure,
          Effect.flatMap(InstallationRepoStore, (store) =>
            store.upsert({ repo: "owner/repo", defaultBranch: "main" }),
          ),
        ),
      );
      assert.ok(Result.isFailure(writeResult));
      assert.strictEqual(failureReason(writeResult), "storage");
      assert.strictEqual(writes, 1);
    }),
  );

  it.effect("removes by case-insensitive identity without affecting other entries", () =>
    Effect.gen(function* () {
      const fake = makeStorage();
      yield* TestClock.setTime(NOW);
      yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) =>
          store.upsert({ repo: "owner/remove", defaultBranch: "main" }),
        ),
      );
      yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) =>
          store.upsert({ repo: "owner/keep", defaultBranch: "main" }),
        ),
      );
      const removed = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) => store.remove("OWNER/REMOVE")),
      );
      assert.isTrue(removed);
      const missing = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) => store.remove("OWNER/REMOVE")),
      );
      assert.isFalse(missing);
      const listed = yield* withStore(
        fake.storage,
        Effect.flatMap(InstallationRepoStore, (store) => store.list),
      );
      assert.deepStrictEqual(
        listed.map((entry) => entry.repo),
        ["owner/keep"],
      );
    }),
  );
});
