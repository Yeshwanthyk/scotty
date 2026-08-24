import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  readStats,
  recordWorkspaceCreation,
  StatsProjection,
  StatsProjectionFailure,
  statsProjectionLayer,
} from "../src/stats-projection";
import { InMemoryFaultInjectableFake, statsProjectionStorageFake } from "./support";

const MARKER_PREFIX = "stats:workspace-created:";

const marker = (
  sessionId: string,
  repository: string,
  createdAt: string,
  provider: "cloudflare" | "runner" = "cloudflare",
) => ({ sessionId, repository, provider, createdAt });

const session = (id: string, status: "provisioning" | "warm" | "stopped", repo: string) => ({
  version: 1 as const,
  revision: 1,
  id,
  title: "Test session",
  status,
  provider: "cloudflare" as const,
  repo,
  defaultBranch: "main",
  branch: `scotty/${id}`,
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:01:00.000Z",
  hardCapAt: "2026-07-29T14:00:00.000Z",
  projectedAt: "2026-07-29T10:01:00.000Z",
});

const withStats = <A, E>(
  memory: InMemoryFaultInjectableFake,
  effect: Effect.Effect<A, E, StatsProjection>,
): Effect.Effect<A, E> =>
  Effect.provide(effect, statsProjectionLayer(statsProjectionStorageFake(memory)));

describe("StatsProjection", () => {
  it.effect("records one deterministic non-secret creation marker by session id", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      const created = marker("a0b1c2d3e4f5", "Example/scotty", "2026-07-29T10:00:00.000Z");

      yield* withStats(storage, recordWorkspaceCreation(created));
      yield* withStats(storage, recordWorkspaceCreation(created));

      assert.deepStrictEqual(storage.values.get(`${MARKER_PREFIX}${created.sessionId}`), created);
      assert.deepStrictEqual([...storage.values.keys()], [`${MARKER_PREFIX}${created.sessionId}`]);
    }),
  );

  it.effect(
    "aggregates retained creation history with only current warm and stopped statuses",
    () =>
      Effect.gen(function* () {
        const storage = new InMemoryFaultInjectableFake();
        const markers = [
          marker("a0b1c2d3e4f5", "Example/scotty", "2026-07-27T09:00:00.000Z"),
          marker("b0b1c2d3e4f5", "example/SCOTTY", "2026-07-29T11:00:00.000Z"),
          marker("c0b1c2d3e4f5", "owner/other", "2026-07-28T10:00:00.000Z"),
          marker("d0b1c2d3e4f5", "owner/other", "2026-07-29T12:00:00.000Z"),
        ];
        for (const value of markers)
          storage.values.set(`${MARKER_PREFIX}${value.sessionId}`, value);
        storage.values.set("session:a0b1c2d3e4f5", session("a0b1c2d3e4f5", "warm", "moved/repo"));
        storage.values.set(
          "session:b0b1c2d3e4f5",
          session("b0b1c2d3e4f5", "stopped", "Example/scotty"),
        );
        storage.values.set(
          "session:c0b1c2d3e4f5",
          session("c0b1c2d3e4f5", "provisioning", "owner/other"),
        );
        storage.values.set(
          "session:unmarked-session",
          session("unmarked-session", "warm", "owner/untracked"),
        );

        const stats = yield* withStats(storage, readStats);

        assert.deepStrictEqual(stats, {
          trackingSince: "2026-07-27T09:00:00.000Z",
          overall: {
            workspacesCreated: 4,
            projects: 2,
            warmNow: 1,
            stoppedNow: 1,
          },
          projects: [
            {
              repository: "owner/other",
              workspacesCreated: 2,
              warmNow: 0,
              stoppedNow: 0,
              lastCreated: "2026-07-29T12:00:00.000Z",
            },
            {
              repository: "Example/scotty",
              workspacesCreated: 2,
              warmNow: 1,
              stoppedNow: 1,
              lastCreated: "2026-07-29T11:00:00.000Z",
            },
          ],
        });
      }),
  );

  it.effect(
    "skips malformed KV neighbors and keeps a vaporized workspace in creation history",
    () =>
      Effect.gen(function* () {
        const storage = new InMemoryFaultInjectableFake();
        const retained = marker("a0b1c2d3e4f5", "owner/retained", "2026-07-29T10:00:00.000Z");
        storage.values.set(`${MARKER_PREFIX}${retained.sessionId}`, {
          ...retained,
          secret: "strip me",
        });
        storage.values.set(`${MARKER_PREFIX}key-mismatch`, retained);
        storage.values.set(`${MARKER_PREFIX}invalid-time`, {
          ...retained,
          sessionId: "invalid-time",
          createdAt: "not-a-time",
        });
        storage.values.set(`${MARKER_PREFIX}invalid-repository`, {
          ...retained,
          sessionId: "invalid-repository",
          repository: "not-a-repository",
        });
        storage.values.set(`${MARKER_PREFIX}malformed-json`, "{");
        storage.values.set("session:malformed", { status: "warm" });

        const stats = yield* withStats(storage, readStats);

        assert.deepStrictEqual(stats, {
          trackingSince: retained.createdAt,
          overall: {
            workspacesCreated: 1,
            projects: 1,
            warmNow: 0,
            stoppedNow: 0,
          },
          projects: [
            {
              repository: retained.repository,
              workspacesCreated: 1,
              warmNow: 0,
              stoppedNow: 0,
              lastCreated: retained.createdAt,
            },
          ],
        });
        assert.ok(!("secret" in stats.projects[0]));
      }),
  );

  it.effect("keeps marker write and read provider failures typed", () =>
    Effect.gen(function* () {
      const storage = new InMemoryFaultInjectableFake();
      storage.injectFailure("put");
      const putResult = yield* Effect.result(
        withStats(
          storage,
          recordWorkspaceCreation(marker("a0b1c2d3e4f5", "owner/repo", "2026-07-29T10:00:00.000Z")),
        ),
      );
      assert.ok(Result.isFailure(putResult));
      assert.deepStrictEqual(putResult.failure, new StatsProjectionFailure({ operation: "put" }));

      storage.clearFailure();
      storage.injectFailure("list");
      const listResult = yield* Effect.result(withStats(storage, readStats));
      assert.ok(Result.isFailure(listResult));
      assert.deepStrictEqual(listResult.failure, new StatsProjectionFailure({ operation: "list" }));

      storage.clearFailure();
      storage.values.set(
        `${MARKER_PREFIX}a0b1c2d3e4f5`,
        marker("a0b1c2d3e4f5", "owner/repo", "2026-07-29T10:00:00.000Z"),
      );
      storage.injectFailure("get");
      const getResult = yield* Effect.result(withStats(storage, readStats));
      assert.ok(Result.isFailure(getResult));
      assert.deepStrictEqual(getResult.failure, new StatsProjectionFailure({ operation: "get" }));
    }),
  );
});
