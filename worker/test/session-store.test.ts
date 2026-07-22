import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { type SessionRecord } from "../src/contracts";
import {
  SessionStore,
  sessionStoreLayer,
  type SessionRecordStorage,
  type SessionRecordTransaction,
} from "../src/session-store";

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
  updatedAt: "2026-01-01T00:00:00.000Z",
  hardCapAt: "2026-01-01T04:00:00.000Z",
  hardCapDurationSeconds: 14_400,
  ownedBackupIds: [],
  ...overrides,
});

class MemorySessionRecordStorage implements SessionRecordStorage {
  private value: unknown | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(value?: unknown) {
    this.value = value;
  }

  get = async (): Promise<unknown | undefined> => this.value;

  put = async (next: SessionRecord): Promise<void> => {
    this.value = structuredClone(next);
  };

  transaction = async <A>(
    operation: (transaction: SessionRecordTransaction) => Promise<A>,
  ): Promise<A> => {
    const preceding = this.tail;
    let unlock = (): void => undefined;
    this.tail = new Promise((resolve) => {
      unlock = resolve;
    });
    await preceding;
    let staged = structuredClone(this.value);
    try {
      const result = await operation({
        get: async () => structuredClone(staged),
        put: async (next) => {
          staged = structuredClone(next);
        },
      });
      this.value = staged;
      return result;
    } finally {
      unlock();
    }
  };
}

const withStore = <A, E>(
  storage: SessionRecordStorage,
  effect: Effect.Effect<A, E, SessionStore>,
): Effect.Effect<A, E> => Effect.provide(effect, sessionStoreLayer(storage));

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("SessionStore", () => {
  it.effect("fails closed for missing and malformed authoritative records", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.result(
        withStore(
          new MemorySessionRecordStorage(),
          Effect.flatMap(SessionStore, (store) => store.requireRecord),
        ),
      );
      assert.deepInclude(failure(missing), {
        code: "not_found",
        message: "Session unknown was not found",
      });

      const malformed = yield* Effect.result(
        withStore(
          new MemorySessionRecordStorage({ ...record(), status: "invented" }),
          Effect.flatMap(SessionStore, (store) => store.requireRecord),
        ),
      );
      assert.deepInclude(failure(malformed), {
        code: "internal",
        message: "Authoritative session record is invalid",
      });

      const missingUpdate = yield* Effect.result(
        withStore(
          new MemorySessionRecordStorage(),
          Effect.flatMap(SessionStore, (store) =>
            store.updateForOperation("missing", (current) => current),
          ),
        ),
      );
      assert.deepInclude(failure(missingUpdate), {
        code: "not_found",
        message: "Session unknown was not found",
      });
    }),
  );

  it.effect("acquires a persisted lease with Clock-owned timestamps", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionRecordStorage(record());
      yield* TestClock.setTime(NOW);
      const operation = yield* withStore(
        storage,
        Effect.flatMap(SessionStore, (store) =>
          store.acquireOperation("snapshot", ["warm"], "nonce-1"),
        ),
      );
      assert.deepStrictEqual(operation, {
        kind: "snapshot",
        nonce: "nonce-1",
        startedAt: "2026-04-05T06:07:08.000Z",
      });
      assert.deepInclude(
        yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (s) => s.requireRecord),
        ),
        {
          operation,
          updatedAt: operation.startedAt,
        },
      );
    }),
  );

  it.effect("rejects active-operation conflicts and disallowed states without mutation", () =>
    Effect.gen(function* () {
      const active = record({
        operation: { kind: "snapshot", nonce: "held", startedAt: "2026-01-01T00:00:00.000Z" },
      });
      const activeStorage = new MemorySessionRecordStorage(active);
      const conflictResult = yield* Effect.result(
        withStore(
          activeStorage,
          Effect.flatMap(SessionStore, (store) => store.acquireOperation("pr", ["warm"], "new")),
        ),
      );
      assert.deepInclude(failure(conflictResult), {
        code: "conflict",
        message: "Session is already running snapshot",
      });
      assert.deepStrictEqual(
        yield* withStore(
          activeStorage,
          Effect.flatMap(SessionStore, (s) => s.requireRecord),
        ),
        active,
      );

      const sleepingStorage = new MemorySessionRecordStorage(record({ status: "sleeping" }));
      const wrongStateResult = yield* Effect.result(
        withStore(
          sleepingStorage,
          Effect.flatMap(SessionStore, (store) =>
            store.acquireOperation("snapshot", ["warm"], "new"),
          ),
        ),
      );
      assert.deepInclude(failure(wrongStateResult), {
        code: "wrong_state",
        message: "Cannot snapshot a session in sleeping state",
      });
    }),
  );

  it.effect("lets vaporize atomically replace only an expired operation lease", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fresh = record({
        operation: {
          kind: "resume",
          nonce: "fresh",
          startedAt: new Date(NOW - 299_999).toISOString(),
        },
      });
      const freshStorage = new MemorySessionRecordStorage(fresh);
      const freshResult = yield* Effect.result(
        withStore(
          freshStorage,
          Effect.flatMap(SessionStore, (store) =>
            store.acquireOperation("vaporize", ["warm"], "replacement", 300_000),
          ),
        ),
      );
      assert.deepInclude(failure(freshResult), {
        code: "conflict",
        message: "Session is already running resume",
      });
      assert.deepStrictEqual(
        yield* withStore(
          freshStorage,
          Effect.flatMap(SessionStore, (store) => store.requireRecord),
        ),
        fresh,
      );

      const expiredStorage = new MemorySessionRecordStorage(
        record({
          operation: {
            kind: "resume",
            nonce: "expired",
            startedAt: new Date(NOW - 300_000).toISOString(),
          },
        }),
      );
      const replacement = yield* withStore(
        expiredStorage,
        Effect.flatMap(SessionStore, (store) =>
          store.acquireOperation("vaporize", ["warm"], "replacement", 300_000),
        ),
      );
      assert.deepStrictEqual(replacement, {
        kind: "vaporize",
        nonce: "replacement",
        startedAt: "2026-04-05T06:07:08.000Z",
      });
      assert.deepInclude(
        yield* withStore(
          expiredStorage,
          Effect.flatMap(SessionStore, (store) => store.requireRecord),
        ),
        { operation: replacement, updatedAt: replacement.startedAt },
      );
    }),
  );

  it.effect("rejects stale nonces and releases only the held lease", () =>
    Effect.gen(function* () {
      const held = record({
        operation: { kind: "down", nonce: "held", startedAt: "2026-01-01T00:00:00.000Z" },
      });
      const storage = new MemorySessionRecordStorage(held);
      const stale = yield* Effect.result(
        withStore(
          storage,
          Effect.flatMap(SessionStore, (store) =>
            store.updateForOperation("stale", (current) => ({ ...current, status: "sleeping" })),
          ),
        ),
      );
      assert.deepInclude(failure(stale), {
        code: "conflict",
        message: "Session operation lease changed",
      });

      assert.strictEqual(
        yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) => store.releaseOperationIfHeld("stale")),
        ),
        undefined,
      );
      yield* TestClock.setTime(NOW);
      const released = yield* withStore(
        storage,
        Effect.flatMap(SessionStore, (store) => store.releaseOperationIfHeld("held")),
      );
      assert.strictEqual(released?.operation, null);
      assert.strictEqual(released?.updatedAt, "2026-04-05T06:07:08.000Z");
    }),
  );

  it.effect("marks failures recoverable only when a current backup exists", () =>
    Effect.gen(function* () {
      for (const [backup, recoverable] of [
        [undefined, false],
        [{ current: { id: "backup-1", dir: "/workspace/a0b1c2d3e4f5", localBucket: true } }, true],
      ] as const) {
        const storage = new MemorySessionRecordStorage(
          record({
            operation: {
              kind: "resume",
              nonce: "held",
              startedAt: "2026-01-01T00:00:00.000Z",
            },
            backup,
          }),
        );
        const failed = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) =>
            store.failOperation("held", "resume_failed", "Session restore failed", true),
          ),
        );
        assert.deepStrictEqual(failed.failure, {
          code: "resume_failed",
          message: "Session restore failed",
          recoverable,
        });
        assert.strictEqual(failed.status, "failed");
        assert.strictEqual(failed.operation, null);
      }
    }),
  );

  it.effect("reconstructs the service without creating runtime-memory authority", () =>
    Effect.gen(function* () {
      const storage = new MemorySessionRecordStorage(record());
      yield* TestClock.setTime(NOW);
      yield* withStore(
        storage,
        Effect.flatMap(SessionStore, (store) =>
          store.acquireOperation("snapshot", ["warm"], "persisted"),
        ),
      );
      const reconstructed = yield* withStore(
        storage,
        Effect.flatMap(SessionStore, (store) => store.requireRecord),
      );
      assert.strictEqual(reconstructed.operation?.nonce, "persisted");
    }),
  );
});
