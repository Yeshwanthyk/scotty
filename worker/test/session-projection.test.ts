import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import type { SessionRecord } from "../src/contracts";
import {
  listSessionProjections,
  projectSessionBestEffort,
  removeSessionProjection,
  SessionProjection,
  SessionProjectionFailure,
  sessionProjectionLayer,
  type SessionProjectionStorage,
} from "../src/session-projection";

const NOW = Date.parse("2026-04-05T06:07:08.000Z");

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  id: "a0b1c2d3e4f5",
  status: "warm",
  operation: null,
  repo: "anomalyco/rift",
  repoExistsAtCreate: true,
  defaultBranch: "dev",
  branch: "scotty/a0b1c2d3e4f5",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: [],
  ...overrides,
});

class MemorySessionProjectionStorage implements SessionProjectionStorage {
  readonly values = new Map<string, unknown>();
  fail?: "delete" | "get" | "list" | "put";

  delete = async (key: string): Promise<void> => {
    if (this.fail === "delete") return Promise.reject("delete failed");
    this.values.delete(key);
  };

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
  storage: SessionProjectionStorage,
  effect: Effect.Effect<A, E, SessionProjection>,
): Effect.Effect<A, E> => Effect.provide(effect, sessionProjectionLayer(storage));

describe("SessionProjection", () => {
  it.effect("projects with Clock time and removes gone projections", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionProjectionStorage();
      yield* TestClock.setTime(NOW);
      yield* withProjection(
        storage,
        Effect.flatMap(SessionProjection, (projection) => projection.project(record())),
      );
      assert.deepInclude(storage.values.get("session:a0b1c2d3e4f5"), {
        id: "a0b1c2d3e4f5",
        projectedAt: "2026-04-05T06:07:08.000Z",
      });

      yield* withProjection(storage, projectSessionBestEffort(record({ status: "gone" })));
      assert.strictEqual(storage.values.size, 0);
    }),
  );

  it.effect("skips malformed neighbors and key mismatches, strips extras, and orders views", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionProjectionStorage();
      const valid = {
        version: 1,
        id: "a0b1c2d3e4f5",
        status: "warm",
        repo: "owner/newer",
        defaultBranch: "main",
        branch: "scotty/a0b1c2d3e4f5",
        createdAt: "2026-01-02T00:00:00.000+14:00",
        updatedAt: "2026-01-02T00:00:01.000Z",
        hardCapAt: "2026-01-02T04:00:00.000Z",
        projectedAt: "2026-01-02T00:00:01.000Z",
        secret: "strip me",
      };
      storage.values.set("session:a0b1c2d3e4f5", valid);
      storage.values.set("session:b0b1c2d3e4f5", {
        ...valid,
        id: "b0b1c2d3e4f5",
        repo: "owner/newest",
        createdAt: "2026-01-01T23:00:00.000Z",
      });
      storage.values.set("session:key-mismatch", { ...valid, id: "different" });
      storage.values.set("session:unknown-version", {
        ...valid,
        id: "unknown-version",
        version: 2,
      });
      storage.values.set("session:invalid-time", {
        ...valid,
        id: "invalid-time",
        createdAt: "not-a-time",
      });
      storage.values.set("session:malformed", { ...valid, id: "malformed", backupId: 123 });
      storage.values.set("session:malformed-json", "{");

      yield* TestClock.setTime(Date.parse("2026-01-02T01:00:00.000Z"));
      const views = yield* withProjection(storage, listSessionProjections);
      assert.deepStrictEqual(
        views.map((view) => view.id),
        ["b0b1c2d3e4f5", "a0b1c2d3e4f5"],
      );
      assert.ok(!("secret" in views[0]));
      assert.strictEqual(views[0].ageSeconds, 7_200);
    }),
  );

  it.effect("keeps provider failures typed and best-effort writes non-authoritative", () =>
    Effect.gen(function* () {
      const authoritative = record({ status: "sleeping" });
      const storage = new MemorySessionProjectionStorage();
      storage.fail = "put";
      yield* withProjection(storage, projectSessionBestEffort(authoritative));
      assert.strictEqual(authoritative.status, "sleeping");
      assert.strictEqual(storage.values.size, 0);

      storage.values.set("session:a0b1c2d3e4f5", { stale: true });
      storage.fail = "delete";
      const gone = record({ status: "gone" });
      yield* withProjection(storage, projectSessionBestEffort(gone));
      assert.strictEqual(gone.status, "gone");
      assert.deepStrictEqual(storage.values.get("session:a0b1c2d3e4f5"), { stale: true });

      storage.values.set("session:a0b1c2d3e4f5", {});
      storage.fail = "get";
      const result = yield* Effect.result(withProjection(storage, listSessionProjections));
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof SessionProjectionFailure);
      assert.deepStrictEqual(result.failure, new SessionProjectionFailure({ operation: "get" }));

      storage.fail = "list";
      const listResult = yield* Effect.result(withProjection(storage, listSessionProjections));
      assert.ok(Result.isFailure(listResult));
      assert.deepStrictEqual(
        listResult.failure,
        new SessionProjectionFailure({ operation: "list" }),
      );
    }),
  );

  it.effect("requires confirmed projection removal for destructive cleanup", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionProjectionStorage();
      storage.values.set("session:a0b1c2d3e4f5", { stale: true });
      storage.fail = "delete";

      const failed = yield* Effect.result(
        withProjection(storage, removeSessionProjection("a0b1c2d3e4f5")),
      );
      assert.ok(Result.isFailure(failed));
      assert.deepStrictEqual(failed.failure, new SessionProjectionFailure({ operation: "delete" }));
      assert.deepStrictEqual(storage.values.get("session:a0b1c2d3e4f5"), { stale: true });

      storage.fail = undefined;
      yield* withProjection(storage, removeSessionProjection("a0b1c2d3e4f5"));
      assert.strictEqual(storage.values.size, 0);
    }),
  );

  it.effect("continues projection listing across empty pages", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionProjectionStorage();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, projectSessionBestEffort(record()));
      const paged: SessionProjectionStorage = {
        delete: storage.delete,
        get: storage.get,
        list: async (cursor) =>
          cursor === undefined ? { keys: [], cursor: "next" } : { keys: ["session:a0b1c2d3e4f5"] },
        put: storage.put,
      };
      const views = yield* withProjection(paged, listSessionProjections);
      assert.deepStrictEqual(
        views.map((view) => view.id),
        ["a0b1c2d3e4f5"],
      );
    }),
  );

  it.effect("reconstructs from KV without runtime-memory authority", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionProjectionStorage();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, projectSessionBestEffort(record()));
      const persisted = storage.values.get("session:a0b1c2d3e4f5");
      assert.ok(persisted !== null && typeof persisted === "object" && !Array.isArray(persisted));
      storage.values.set("session:a0b1c2d3e4f5", {
        ...persisted,
        status: "sleeping",
      });
      const reconstructed = yield* withProjection(storage, listSessionProjections);
      assert.strictEqual(reconstructed[0].status, "sleeping");
    }),
  );
});
