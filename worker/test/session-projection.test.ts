import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  listSessionProjections,
  projectSessionBestEffort,
  removeSessionProjection,
  SessionProjection,
  SessionProjectionFailure,
  sessionProjectionLayer,
} from "../src/session-projection";
import {
  InMemoryFaultInjectableFake,
  makeSessionRecord as record,
  sessionProjectionStorageFake,
} from "./support";

const NOW = Date.parse("2026-04-05T06:07:08.000Z");

const authority = (session = record(), revision = 1) => ({ record: session, revision });

const withProjection = <A, E>(
  memory: InMemoryFaultInjectableFake,
  effect: Effect.Effect<A, E, SessionProjection>,
): Effect.Effect<A, E> =>
  Effect.provide(effect, sessionProjectionLayer(sessionProjectionStorageFake(memory)));

describe("SessionProjection", () => {
  it.effect("projects with Clock time and removes gone projections", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      yield* TestClock.setTime(NOW);
      yield* withProjection(
        storage,
        Effect.flatMap(SessionProjection, (projection) => projection.project(authority())),
      );
      assert.deepInclude(storage.values.get("session:a0b1c2d3e4f5"), {
        id: "a0b1c2d3e4f5",
        projectedAt: "2026-04-05T06:07:08.000Z",
      });
      const projected = storage.values.get("session:a0b1c2d3e4f5");
      assert.ok(typeof projected === "object" && projected !== null);
      assert.ok(!("piSessionTransportToken" in projected));

      yield* withProjection(
        storage,
        projectSessionBestEffort(
          authority(
            record({
              operation: {
                kind: "vaporize",
                nonce: "delete-nonce",
                startedAt: "2026-04-05T06:07:08.000Z",
              },
            }),
          ),
        ),
      );
      assert.deepInclude(storage.values.get("session:a0b1c2d3e4f5"), { deleting: true });

      yield* withProjection(
        storage,
        projectSessionBestEffort(authority(record({ status: "gone" }), 2)),
      );
      assert.strictEqual(storage.values.size, 0);
    }),
  );

  it.effect("skips malformed neighbors and key mismatches, strips extras, and orders views", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      const valid = {
        version: 1,
        id: "a0b1c2d3e4f5",
        revision: 1,
        title: "Test session",
        status: "warm",
        provider: "cloudflare",
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

  it.effect("does not overwrite a newer projection with an observed stale revision", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      yield* TestClock.setTime(NOW);
      yield* withProjection(
        storage,
        projectSessionBestEffort(authority(record({ title: "newer" }), 7)),
      );
      yield* withProjection(
        storage,
        projectSessionBestEffort(authority(record({ title: "stale" }), 6)),
      );
      assert.deepInclude(storage.values.get("session:a0b1c2d3e4f5"), {
        revision: 7,
        title: "newer",
      });

      yield* withProjection(
        storage,
        projectSessionBestEffort(authority(record({ title: "repaired" }), 8)),
      );
      assert.deepInclude(storage.values.get("session:a0b1c2d3e4f5"), {
        revision: 8,
        title: "repaired",
      });
    }),
  );

  it.effect("keeps provider failures typed and best-effort writes non-authoritative", () =>
    Effect.gen(function* () {
      const authoritative = record();
      const storage = new InMemoryFaultInjectableFake();
      storage.injectFailure("put");
      yield* withProjection(storage, projectSessionBestEffort(authority(authoritative)));
      assert.strictEqual(authoritative.status, "warm");
      assert.strictEqual(storage.values.size, 0);

      storage.values.set("session:a0b1c2d3e4f5", { stale: true });
      storage.clearFailure();
      storage.injectFailure("delete");
      const gone = record({ status: "gone" });
      yield* withProjection(storage, projectSessionBestEffort(authority(gone, 2)));
      assert.strictEqual(gone.status, "gone");
      assert.deepStrictEqual(storage.values.get("session:a0b1c2d3e4f5"), { stale: true });

      storage.values.set("session:a0b1c2d3e4f5", {});
      storage.clearFailure();
      storage.injectFailure("get");
      const result = yield* Effect.result(withProjection(storage, listSessionProjections));
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof SessionProjectionFailure);
      assert.deepStrictEqual(result.failure, new SessionProjectionFailure({ operation: "get" }));

      storage.clearFailure();
      storage.injectFailure("list");
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
      const storage = new InMemoryFaultInjectableFake();
      storage.values.set("session:a0b1c2d3e4f5", { stale: true });
      storage.injectFailure("delete");

      const failed = yield* Effect.result(
        withProjection(storage, removeSessionProjection("a0b1c2d3e4f5")),
      );
      assert.ok(Result.isFailure(failed));
      assert.deepStrictEqual(failed.failure, new SessionProjectionFailure({ operation: "delete" }));
      assert.deepStrictEqual(storage.values.get("session:a0b1c2d3e4f5"), { stale: true });

      storage.clearFailure();
      yield* withProjection(storage, removeSessionProjection("a0b1c2d3e4f5"));
      assert.strictEqual(storage.values.size, 0);
    }),
  );

  it.effect("continues projection listing across empty pages", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, projectSessionBestEffort(authority()));
      storage.handle("list", (cursor) =>
        cursor === undefined ? { keys: [], cursor: "next" } : { keys: ["session:a0b1c2d3e4f5"] },
      );
      const views = yield* withProjection(storage, listSessionProjections);
      assert.deepStrictEqual(
        views.map((view) => view.id),
        ["a0b1c2d3e4f5"],
      );
    }),
  );

  it.effect("reconstructs from KV without runtime-memory authority", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      yield* TestClock.setTime(NOW);
      yield* withProjection(storage, projectSessionBestEffort(authority()));
      const persisted = storage.values.get("session:a0b1c2d3e4f5");
      assert.ok(persisted !== null && typeof persisted === "object" && !Array.isArray(persisted));
      storage.values.set("session:a0b1c2d3e4f5", {
        ...persisted,
        status: "stopped",
        backupId: "backup-1",
        operationResult: {
          kind: "snapshot",
          stage: "commit",
          progress: "completed",
          lastProvenEffect: "runtime_stopped",
          retainedState: "checkpoint",
          ambiguity: "none",
          safeRetry: "none",
          humanAction: "resume",
          outcome: { status: "succeeded" },
          stoppedReason: "snapshot",
          recoveryAction: "resume",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      const reconstructed = yield* withProjection(storage, listSessionProjections);
      assert.strictEqual(reconstructed[0].status, "stopped");
    }),
  );
});
