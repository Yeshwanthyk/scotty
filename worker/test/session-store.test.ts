import { assert, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { SessionStore, sessionStoreLayer, type SessionRecordStorage } from "../src/session-store";
import {
  makeSessionRecord as record,
  makeDeployedSessionRecordStorage,
  makeSessionRecordStorageFake,
  deployedSessionRecordStorageEnabled,
  runContractSuite,
} from "./support";

const NOW = Date.parse("2026-04-05T06:07:08.000Z");

const withStore = <A, E>(
  storage: SessionRecordStorage,
  effect: Effect.Effect<A, E, SessionStore>,
): Effect.Effect<A, E> => Effect.provide(effect, sessionStoreLayer(storage));

const failure = <A>(result: Result.Result<A, unknown>): unknown => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

type SessionRecordStorageFactory = (initial?: unknown) => {
  readonly storage: SessionRecordStorage;
};

runContractSuite<SessionRecordStorageFactory>(
  "SessionStore contract",
  [
    { name: "in-memory", make: makeSessionRecordStorageFake },
    {
      name: "deployed Durable Object storage",
      make: makeDeployedSessionRecordStorage,
      enabled: deployedSessionRecordStorageEnabled,
    },
  ],
  ({ make }) => {
    it.effect("reuses a persisted Pi transport capability across store access", () =>
      Effect.gen(function* () {
        const existingToken = "b".repeat(64);
        const storage = make(record({ piSessionTransportToken: existingToken })).storage;
        const first = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) => store.ensurePiSessionTransportToken),
        );
        assert.strictEqual(first, existingToken);
        const second = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) => store.ensurePiSessionTransportToken),
        );
        assert.strictEqual(second, first);
        assert.strictEqual(
          (yield* withStore(
            storage,
            Effect.flatMap(SessionStore, (store) => store.requireRecord),
          )).piSessionTransportToken,
          first,
        );
      }),
    );

    it.effect("reads valid authority optionally while rejecting malformed stored records", () =>
      Effect.gen(function* () {
        const missing = yield* withStore(
          make().storage,
          Effect.flatMap(SessionStore, (store) => store.read),
        );
        assert.deepStrictEqual(missing, Option.none());

        const existing = record();
        const present = yield* withStore(
          make(existing).storage,
          Effect.flatMap(SessionStore, (store) => store.read),
        );
        assert.deepStrictEqual(present, Option.some(existing));

        const malformed = yield* Effect.result(
          withStore(
            make({ ...existing, status: "invented" }).storage,
            Effect.flatMap(SessionStore, (store) => store.read),
          ),
        );
        assert.deepInclude(failure(malformed), {
          code: "internal",
          message: "Authoritative session record is invalid",
        });
      }),
    );

    it.effect("fails closed for missing and malformed authoritative records", () =>
      Effect.gen(function* () {
        const missing = yield* Effect.result(
          withStore(
            make().storage,
            Effect.flatMap(SessionStore, (store) => store.requireRecord),
          ),
        );
        assert.deepInclude(failure(missing), {
          code: "not_found",
          message: "Session unknown was not found",
        });

        const malformed = yield* Effect.result(
          withStore(
            make({ ...record(), status: "invented" }).storage,
            Effect.flatMap(SessionStore, (store) => store.requireRecord),
          ),
        );
        assert.deepInclude(failure(malformed), {
          code: "internal",
          message: "Authoritative session record is invalid",
        });

        const missingUpdate = yield* Effect.result(
          withStore(
            make().storage,
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

    it.effect("renames a session without disturbing its lifecycle state", () =>
      Effect.gen(function* () {
        const existing = record({
          title: "Old title",
          operation: {
            kind: "snapshot",
            nonce: "held",
            startedAt: "2026-01-01T00:00:02.000Z",
          },
        });
        const storage = make(existing).storage;
        yield* TestClock.setTime(NOW);
        const renamed = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) => store.rename("New title")),
        );
        assert.deepInclude(renamed, {
          title: "New title",
          operation: existing.operation,
          status: existing.status,
          updatedAt: "2026-04-05T06:07:08.000Z",
        });
      }),
    );

    it.effect("acquires a persisted lease with Clock-owned timestamps", () =>
      Effect.gen(function* () {
        const storage = make(record()).storage;
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
        const activeStorage = make(active).storage;
        const conflictResult = yield* Effect.result(
          withStore(
            activeStorage,
            Effect.flatMap(SessionStore, (store) =>
              store.acquireOperation("down", ["warm"], "new"),
            ),
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

        const sleepingStorage = make(record({ status: "sleeping" })).storage;
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
        const freshStorage = make(fresh).storage;
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

        const expiredStorage = make(
          record({
            operation: {
              kind: "resume",
              nonce: "expired",
              startedAt: new Date(NOW - 300_000).toISOString(),
            },
          }),
        ).storage;
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
        const storage = make(held).storage;
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

    it.effect("persists the operation owner's recoverability decision", () =>
      Effect.gen(function* () {
        for (const backup of [
          undefined,
          {
            current: {
              id: "backup-1",
              dir: "/workspace/a0b1c2d3e4f5",
              localBucket: true,
            },
          },
        ] as const) {
          const storage = make(
            record({
              operation: {
                kind: "resume",
                nonce: "held",
                startedAt: "2026-01-01T00:00:00.000Z",
              },
              backup,
            }),
          ).storage;
          const failed = yield* withStore(
            storage,
            Effect.flatMap(SessionStore, (store) =>
              store.failOperation("held", "resume_failed", "Session restore failed", true),
            ),
          );
          assert.deepStrictEqual(failed.failure, {
            code: "resume_failed",
            message: "Session restore failed",
            recoverable: true,
          });
          assert.strictEqual(failed.status, "failed");
          assert.strictEqual(failed.operation, null);
        }
      }),
    );

    it.effect("marks hard-cap failure only for the current authoritative observation", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const observed = record({
          operation: {
            kind: "snapshot",
            nonce: "observed",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        });
        const storage = make(observed).storage;
        const stale = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) =>
            store.markHardCapFailure({ ...observed, updatedAt: "stale" }, "timed out"),
          ),
        );
        assert.deepStrictEqual(stale, Option.none());

        const failed = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) => store.markHardCapFailure(observed, "timed out")),
        );
        assert.deepInclude(Option.getOrThrow(failed), {
          status: "failed",
          operation: null,
          failure: {
            code: "hard_cap_checkpoint_failed",
            message: "timed out",
            recoverable: false,
          },
          updatedAt: "2026-04-05T06:07:08.000Z",
        });
      }),
    );

    it.effect("records managed and unmanaged runtime stops atomically", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const backup = {
          current: { id: "backup-1", dir: "/workspace/a0b1c2d3e4f5", localBucket: true },
        };
        const managedStorage = make(
          record({
            backup,
            operation: {
              kind: "snapshot",
              nonce: "managed",
              startedAt: "2026-01-01T00:00:00.000Z",
              checkpointedBackupId: "backup-1",
              stopRequestedAt: "2026-01-01T00:01:00.000Z",
            },
          }),
        ).storage;
        const managed = yield* withStore(
          managedStorage,
          Effect.flatMap(SessionStore, (store) => store.recordRuntimeStop),
        );
        assert.deepInclude(Option.getOrThrow(managed), {
          status: "sleeping",
          operation: null,
          failure: undefined,
        });

        const unmanagedStorage = make(record({ backup })).storage;
        const unmanaged = yield* withStore(
          unmanagedStorage,
          Effect.flatMap(SessionStore, (store) => store.recordRuntimeStop),
        );
        assert.deepInclude(Option.getOrThrow(unmanaged), {
          status: "failed",
          operation: null,
          failure: {
            code: "runtime_stopped",
            message: "Sandbox runtime stopped before a managed checkpoint",
            recoverable: true,
          },
        });
      }),
    );

    it.effect("claims managed-stop rollback once while preserving an existing claim", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const storage = make(
          record({
            backup: {
              current: {
                id: "backup-1",
                dir: "/workspace/a0b1c2d3e4f5",
                localBucket: true,
              },
            },
            operation: {
              kind: "snapshot",
              nonce: "managed",
              startedAt: "2026-01-01T00:00:00.000Z",
              checkpointedBackupId: "backup-1",
            },
          }),
        ).storage;

        assert.isTrue(
          yield* withStore(
            storage,
            Effect.flatMap(SessionStore, (store) => store.claimManagedStopRollback("managed")),
          ),
        );
        const claimed = yield* withStore(
          storage,
          Effect.flatMap(SessionStore, (store) => store.requireRecord),
        );
        assert.strictEqual(claimed.operation?.stopRollbackAt, "2026-04-05T06:07:08.000Z");
        assert.isTrue(
          yield* withStore(
            storage,
            Effect.flatMap(SessionStore, (store) => store.claimManagedStopRollback("managed")),
          ),
        );
        assert.isFalse(
          yield* withStore(
            storage,
            Effect.flatMap(SessionStore, (store) => store.claimManagedStopRollback("stale")),
          ),
        );
      }),
    );

    it.effect("reconstructs the service without creating runtime-memory authority", () =>
      Effect.gen(function* () {
        const storage = make(record()).storage;
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
  },
);
