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
        (storage.snapshot() as EnvironmentAuthority).variables.API_TOKEN?.value,
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
