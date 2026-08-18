import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { EnvironmentAuthority } from "../src/environment-contracts";
import {
  type EnvironmentAuthorityStorage,
  EnvironmentStore,
  environmentStoreLayer,
} from "../src/environment-store";

const makeStorage = (initial?: unknown) => {
  let authority = initial;
  const storage: EnvironmentAuthorityStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => authority,
        put: async (next) => {
          authority = next;
        },
      }),
  };
  return { layer: environmentStoreLayer(storage), snapshot: () => authority };
};

describe("environment store", () => {
  it.effect("stores plain and secret values but returns secrets write-only", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* EnvironmentStore;
      yield* store.put("PUBLIC_URL", { value: "https://example.test", secret: false });
      yield* store.put("API_TOKEN", { value: "do-not-return", secret: true });

      const view = yield* store.list();
      assert.strictEqual(view.revision, 2);
      assert.deepEqual(view.variables, [
        {
          name: "API_TOKEN",
          secret: true,
          configured: true,
          updatedAt: view.variables[0]?.updatedAt,
        },
        {
          name: "PUBLIC_URL",
          secret: false,
          configured: true,
          updatedAt: view.variables[1]?.updatedAt,
          value: "https://example.test",
        },
      ]);
      assert.notInclude(JSON.stringify(view), "do-not-return");
      assert.strictEqual(
        (storage.snapshot() as EnvironmentAuthority).global.variables.API_TOKEN?.value,
        "do-not-return",
      );
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("returns a complete snapshot and removes idempotently", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* EnvironmentStore;
      yield* store.put("FEATURE_MODE", { value: "strict", secret: false });
      assert.deepEqual(yield* store.snapshot(), {
        revision: 1,
        variables: { FEATURE_MODE: "strict" },
      });
      assert.deepEqual(yield* store.remove("FEATURE_MODE"), {
        name: "FEATURE_MODE",
        removed: true,
        revision: 2,
      });
      assert.deepEqual(yield* store.remove("FEATURE_MODE"), {
        name: "FEATURE_MODE",
        removed: false,
        revision: 2,
      });
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("resolves repository overrides without copying inherited globals", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* EnvironmentStore;
      yield* store.put("CHANNEL", { value: "global", secret: false });
      yield* store.put("GLOBAL_SECRET", { value: "hidden-global", secret: true });
      yield* store.put("CHANNEL", { value: "repository", secret: false }, "Owner/Project");
      yield* store.put("REPO_SECRET", { value: "hidden-repo", secret: true }, "owner/project");

      const view = yield* store.list("OWNER/PROJECT");
      assert.strictEqual(view.repo, "OWNER/PROJECT");
      assert.deepEqual(
        view.variables.map(({ name, source, value }) => ({ name, source, value })),
        [
          { name: "CHANNEL", source: "repo", value: "repository" },
          { name: "GLOBAL_SECRET", source: "global", value: undefined },
          { name: "REPO_SECRET", source: "repo", value: undefined },
        ],
      );
      assert.notInclude(JSON.stringify(view), "hidden-global");
      assert.notInclude(JSON.stringify(view), "hidden-repo");
      assert.deepEqual(yield* store.snapshot("owner/project"), {
        revision: 4,
        variables: {
          CHANNEL: "repository",
          GLOBAL_SECRET: "hidden-global",
          REPO_SECRET: "hidden-repo",
        },
      });
      assert.deepEqual(
        Object.keys(
          (storage.snapshot() as EnvironmentAuthority).repositories["owner/project"]?.variables ??
            {},
        ),
        ["CHANNEL", "REPO_SECRET"],
      );
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("removing an override reveals the current global and evicts empty scopes", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* EnvironmentStore;
      yield* store.put("CHANNEL", { value: "first", secret: false });
      yield* store.put("CHANNEL", { value: "override", secret: false }, "owner/project");
      yield* store.put("CHANNEL", { value: "current", secret: false });
      assert.deepEqual(yield* store.remove("CHANNEL", "owner/project"), {
        name: "CHANNEL",
        repo: "owner/project",
        removed: true,
        revision: 4,
      });
      assert.deepEqual(yield* store.snapshot("owner/project"), {
        revision: 4,
        variables: { CHANNEL: "current" },
      });
      assert.deepEqual((storage.snapshot() as EnvironmentAuthority).repositories, {});
      yield* store.remove("CHANNEL");
      assert.deepEqual(yield* store.snapshot("owner/project"), { revision: 5, variables: {} });
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("migrates Slice 1 authority and rejects malformed repository scopes", () => {
    const storage = makeStorage({
      version: 1,
      revision: 3,
      variables: {
        LEGACY: {
          value: "retained",
          secret: false,
          updatedAt: "2026-08-20T12:00:00.000Z",
        },
      },
    });
    return Effect.gen(function* () {
      const store = yield* EnvironmentStore;
      assert.deepEqual(yield* store.snapshot("owner/project"), {
        revision: 3,
        variables: { LEGACY: "retained" },
      });
      const failure = yield* Effect.flip(
        store.put("SAFE_NAME", { value: "hidden", secret: true }, "owner/project/extra"),
      );
      assert.strictEqual(failure.reason, "invalid_scope");
      assert.notInclude(failure.message, "hidden");
      yield* store.put("NEXT", { value: "value", secret: false });
      assert.strictEqual((storage.snapshot() as EnvironmentAuthority).version, 2);
      assert.strictEqual(
        (storage.snapshot() as EnvironmentAuthority).global.variables.LEGACY?.value,
        "retained",
      );
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("rejects invalid and Scotty-owned names without echoing values", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* EnvironmentStore;
      for (const name of ["9INVALID", "GH_TOKEN", "PATH", "SCOTTY_CUSTOM"]) {
        const failure = yield* Effect.flip(store.put(name, { value: "do-not-echo", secret: true }));
        assert.strictEqual(failure.reason, "invalid_input");
        assert.notInclude(failure.message, "do-not-echo");
      }
      assert.strictEqual(storage.snapshot(), undefined);
    }).pipe(Effect.provide(storage.layer));
  });
});
