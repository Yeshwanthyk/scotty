import { assert, describe, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import {
  EnvironmentSecretVault,
  EnvironmentSecretVaultFailure,
  environmentSecretVaultLayer,
  type EnvironmentSecretVaultStorage,
} from "../src/environment-secret-vault";
import type { EnvironmentMaterialization } from "../src/environment-contracts";

const SESSION_ID = "a0b1c2d3e4f5";
class AmbiguousVaultPut extends Data.TaggedError("AmbiguousVaultPut")<{}> {}

const makeStorage = (initial?: unknown, failNextPutAfterWrite = false) => {
  let value = structuredClone(initial);
  let failPut = failNextPutAfterWrite;
  let deleted = false;
  const storage: EnvironmentSecretVaultStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => structuredClone(value),
        put: async (next) => {
          value = structuredClone(next);
          deleted = false;
          if (failPut) {
            failPut = false;
            return Promise.reject(new AmbiguousVaultPut());
          }
        },
      }),
    delete: async () => {
      value = undefined;
      deleted = true;
    },
  };
  return {
    layer: environmentSecretVaultLayer(storage),
    read: () => value,
    failNextPut: () => {
      failPut = true;
    },
    wasDeleted: () => deleted,
  };
};

const materialization = (
  revision: number,
  variables: EnvironmentMaterialization["variables"],
): EnvironmentMaterialization => ({ revision, variables });

const failureOf = <A>(effect: Effect.Effect<A, EnvironmentSecretVaultFailure>) =>
  Effect.flip(effect);

describe("environment secret vault", () => {
  it.effect("stages rotation/removal, then commits and prunes the old generation", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const vault = yield* EnvironmentSecretVault;
      const first = yield* vault.reconcile(
        materialization(1, {
          TOKEN: {
            value: "token-one",
            secret: true,
            updatedAt: "one",
            sourceScope: "global",
          },
          REMOVE_ME: {
            value: "remove-me",
            secret: true,
            updatedAt: "one",
            sourceScope: "owner/project",
          },
        }),
        SESSION_ID,
      );
      const firstToken = first.variables.TOKEN;
      const firstRemoved = first.variables.REMOVE_ME;
      assert.strictEqual(first.version, 1);
      assert.ok(firstToken?.startsWith(`scotty-env-${SESSION_ID}-`));
      assert.ok(firstRemoved?.startsWith(`scotty-env-${SESSION_ID}-`));
      assert.notInclude(JSON.stringify(first), "token-one");
      yield* vault.commit(first);

      const second = yield* vault.reconcile(
        materialization(2, {
          TOKEN: {
            value: "token-two",
            secret: true,
            updatedAt: "two",
            sourceScope: "global",
          },
          ADDED: {
            value: "added",
            secret: true,
            updatedAt: "two",
            sourceScope: "global",
          },
        }),
        SESSION_ID,
        first,
      );
      const secondToken = second.variables.TOKEN;
      assert.notStrictEqual(secondToken, firstToken);
      assert.ok(second.variables.ADDED?.startsWith(`scotty-env-${SESSION_ID}-`));

      // Precommit/apply failure leaves both generations resolvable; no prune happened.
      assert.strictEqual((yield* vault.resolve(firstToken))?.value, "token-one");
      assert.strictEqual((yield* vault.resolve(firstRemoved))?.value, "remove-me");
      assert.strictEqual((yield* vault.resolve(secondToken))?.value, "token-two");
      assert.deepStrictEqual(yield* vault.replay(first), first);

      yield* vault.commit(second);
      assert.strictEqual(yield* vault.resolve(firstToken), null);
      assert.strictEqual(yield* vault.resolve(firstRemoved), null);
      assert.strictEqual((yield* vault.resolve(secondToken))?.value, "token-two");
      assert.deepStrictEqual(yield* vault.replay(second), second);
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("reuses unchanged sentinels and prunes every unreferenced generation", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const vault = yield* EnvironmentSecretVault;
      const first = yield* vault.reconcile(
        materialization(1, {
          TOKEN: {
            value: "token-one",
            secret: true,
            updatedAt: "one",
            sourceScope: "global",
          },
        }),
        SESSION_ID,
      );
      yield* vault.commit(first);

      const staged = yield* vault.reconcile(
        materialization(2, {
          TOKEN: {
            value: "token-two",
            secret: true,
            updatedAt: "two",
            sourceScope: "global",
          },
        }),
        SESSION_ID,
        first,
      );
      const retried = yield* vault.reconcile(
        materialization(2, {
          TOKEN: {
            value: "token-two",
            secret: true,
            updatedAt: "two",
            sourceScope: "global",
          },
        }),
        SESSION_ID,
        staged,
      );
      assert.strictEqual(retried.variables.TOKEN, staged.variables.TOKEN);

      yield* vault.commit(retried);
      assert.strictEqual(yield* vault.resolve(first.variables.TOKEN), null);
      assert.deepStrictEqual(storage.read(), {
        version: 1,
        entries: {
          [staged.variables.TOKEN]: {
            sentinel: staged.variables.TOKEN,
            sourceScope: "global",
            name: "TOKEN",
            value: "token-two",
          },
        },
      });
    }).pipe(Effect.provide(storage.layer));
  });
  it.effect("keeps the old committed generation after an ambiguous stage write", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const vault = yield* EnvironmentSecretVault;
      const first = yield* vault.reconcile(
        materialization(1, {
          TOKEN: {
            value: "token-one",
            secret: true,
            updatedAt: "one",
            sourceScope: "global",
          },
        }),
        SESSION_ID,
      );
      yield* vault.commit(first);
      storage.failNextPut();
      const ambiguous = yield* failureOf(
        vault.reconcile(
          materialization(2, {
            TOKEN: {
              value: "token-two",
              secret: true,
              updatedAt: "two",
              sourceScope: "global",
            },
          }),
          SESSION_ID,
          first,
        ),
      );
      assert.strictEqual(ambiguous.reason, "storage");
      assert.deepStrictEqual(yield* vault.replay(first), first);
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("keeps proxy lookup session-bound and deletes the vault lifecycle", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const vault = yield* EnvironmentSecretVault;
      const snapshot = yield* vault.reconcile(
        materialization(1, {
          TOKEN: {
            value: "proxy-secret",
            secret: true,
            updatedAt: "one",
            sourceScope: "owner/project",
          },
        }),
        SESSION_ID,
      );
      yield* vault.commit(snapshot);
      const sentinel = snapshot.variables.TOKEN;
      const resolutions = yield* vault.readForProxy([sentinel]);
      assert.deepStrictEqual(resolutions, [
        {
          sentinel,
          sourceScope: "owner/project",
          name: "TOKEN",
          value: "proxy-secret",
        },
      ]);
      assert.strictEqual(
        yield* vault.readForProxy(["scotty-env-other-session-00000000000000000000000000000000"]),
        null,
      );
      const invalid = yield* failureOf(
        vault.reconcile(
          materialization(2, {
            PLAIN_SENTINEL: {
              value: "scotty-env-a0b1c2d3e4f5-00000000000000000000000000000000",
              secret: false,
              updatedAt: "two",
              sourceScope: "global",
            },
          }),
          SESSION_ID,
        ),
      );
      assert.strictEqual(invalid.reason, "invalid_input");

      const internalId = yield* failureOf(vault.reconcile(materialization(3, {}), "a".repeat(64)));
      assert.strictEqual(internalId.reason, "invalid_input");

      yield* vault.delete;
      assert.isTrue(storage.wasDeleted());
      assert.strictEqual(yield* vault.resolve(sentinel), null);
      assert.strictEqual(storage.read(), undefined);
    }).pipe(Effect.provide(storage.layer));
  });
});
