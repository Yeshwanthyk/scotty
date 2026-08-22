import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  EnvironmentAuthoritySchema,
  EnvironmentVariablesViewSchema,
  type EnvironmentAuthority,
} from "../src/environment-contracts";
import {
  EnvironmentStore,
  environmentStoreLayer,
  type EnvironmentAuthorityStorage,
} from "../src/environment-store";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

const decodeVariablesView = Schema.decodeUnknownSync(EnvironmentVariablesViewSchema);
const decodeAuthority = Schema.decodeUnknownSync(EnvironmentAuthoritySchema);

const makeStorage = (initial?: unknown) => {
  let authority = structuredClone(initial);
  const writes: unknown[] = [];
  const storage: EnvironmentAuthorityStorage = {
    transaction: async (operation) =>
      operation({
        get: async () => structuredClone(authority),
        put: async (next) => {
          writes.push(structuredClone(next));
          authority = structuredClone(next);
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
  storage: EnvironmentAuthorityStorage,
  effect: Effect.Effect<A, E, EnvironmentStore>,
): Effect.Effect<A, E> => Effect.provide(effect, environmentStoreLayer(storage));

describe("EnvironmentStore", () => {
  it.effect("migrates validated v1 and v2 authorities losslessly into v4", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const v1 = makeStorage({
        version: 1,
        revision: 3,
        variables: {
          LEGACY: {
            value: "retained-v1",
            secret: false,
            updatedAt: "2026-08-20T11:00:00.000Z",
          },
        },
      });
      const v1Materialization = yield* withStore(
        v1.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.materialize("OWNER/PROJECT")),
      );
      assert.strictEqual(v1Materialization.revision, 3);
      assert.strictEqual(v1Materialization.repo, "owner/project");
      assert.deepStrictEqual(v1Materialization.variables.LEGACY, {
        value: "retained-v1",
        secret: false,
        updatedAt: "2026-08-20T11:00:00.000Z",
        sourceScope: "global",
      });
      const v1Authority = decodeAuthority(v1.authority());
      assert.strictEqual(v1Authority.version, 4);
      assert.deepStrictEqual(v1Authority.global.variables.LEGACY, {
        value: "retained-v1",
        secret: false,
        updatedAt: "2026-08-20T11:00:00.000Z",
      });

      const v2 = makeStorage({
        version: 2,
        revision: 7,
        global: {
          variables: {
            GLOBAL_SECRET: {
              value: "global-secret",
              secret: true,
              updatedAt: "2026-08-20T11:01:00.000Z",
            },
          },
        },
        repositories: {
          "Owner/Project": {
            variables: {
              REPO_SECRET: {
                value: "repo-secret",
                secret: true,
                updatedAt: "2026-08-20T11:02:00.000Z",
              },
            },
          },
        },
      });
      const v2Materialization = yield* withStore(
        v2.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.materialize("owner/project")),
      );
      assert.strictEqual(v2Materialization.revision, 7);
      assert.deepStrictEqual(v2Materialization.variables, {
        GLOBAL_SECRET: {
          value: "global-secret",
          secret: true,
          updatedAt: "2026-08-20T11:01:00.000Z",
          sourceScope: "global",
        },
        REPO_SECRET: {
          value: "repo-secret",
          secret: true,
          updatedAt: "2026-08-20T11:02:00.000Z",
          sourceScope: "owner/project",
        },
      });
      const v2Authority = decodeAuthority(v2.authority());
      assert.strictEqual(v2Authority.version, 4);
      assert.deepStrictEqual(Object.keys(v2Authority.repositories), ["owner/project"]);
      assert.deepStrictEqual(v2Authority.global.variables.GLOBAL_SECRET, {
        value: "global-secret",
        secret: true,
        updatedAt: "2026-08-20T11:01:00.000Z",
      });
      assert.deepStrictEqual(v2Authority.repositories["owner/project"]?.variables.REPO_SECRET, {
        value: "repo-secret",
        secret: true,
        updatedAt: "2026-08-20T11:02:00.000Z",
      });
    }),
  );

  it.effect("folds approved v3 origin policies into variables and discards the rest", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const v3 = makeStorage({
        version: 3,
        revision: 9,
        policyRevision: 2,
        global: {
          variables: {
            API_TOKEN: { value: "api-value", secret: true, updatedAt: "u1" },
            PLAIN: { value: "plain-value", secret: false, updatedAt: "u2" },
            GH_TOKEN: { value: "gh-value", secret: true, updatedAt: "u3" },
          },
        },
        repositories: {
          "owner/project": {
            variables: {
              REPO_TOKEN: { value: "repo-value", secret: true, updatedAt: "u4" },
            },
          },
        },
        originPolicies: [
          {
            sourceScope: "global",
            name: "API_TOKEN",
            origin: "https://api.example",
            decision: "approved",
            updatedAt: "p1",
          },
          {
            sourceScope: "global",
            name: "PLAIN",
            origin: "https://plain.example",
            decision: "rejected",
            updatedAt: "p2",
          },
          {
            sourceScope: "owner/project",
            name: "REPO_TOKEN",
            origin: "https://repo.example",
            decision: "approved",
            updatedAt: "p3",
          },
          {
            sourceScope: "global",
            name: "MISSING_VARIABLE",
            origin: "https://missing.example",
            decision: "approved",
            updatedAt: "p4",
          },
        ],
        pendingObservations: [
          {
            sourceScope: "global",
            name: "API_TOKEN",
            origin: "https://observed.example",
            firstObservedAt: "o1",
            lastObservedAt: "o2",
          },
        ],
      });
      yield* withStore(
        v3.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.strictEqual(v3.writes.length, 1);
      const authority: EnvironmentAuthority = decodeAuthority(v3.authority());
      assert.strictEqual(authority.version, 4);
      assert.strictEqual(authority.revision, 9);
      assert.deepStrictEqual(authority.global.variables.API_TOKEN, {
        value: "api-value",
        secret: true,
        updatedAt: "u1",
        origins: ["https://api.example"],
      });
      assert.deepStrictEqual(authority.global.variables.PLAIN, {
        value: "plain-value",
        secret: false,
        updatedAt: "u2",
      });
      assert.deepStrictEqual(authority.global.variables.GH_TOKEN, {
        value: "gh-value",
        secret: true,
        updatedAt: "u3",
        scheme: "basic-x-access-token",
      });
      assert.deepStrictEqual(authority.repositories["owner/project"]?.variables.REPO_TOKEN, {
        value: "repo-value",
        secret: true,
        updatedAt: "u4",
        origins: ["https://repo.example"],
      });
      assert.isFalse("originPolicies" in authority);
      assert.isFalse("policyRevision" in authority);
      assert.isFalse("pendingObservations" in authority);
    }),
  );

  it.effect("rejects a lossy v2 repository case collision", () =>
    Effect.gen(function* () {
      const storage = makeStorage({
        version: 2,
        revision: 1,
        global: { variables: {} },
        repositories: {
          "owner/project": { variables: { TOKEN: { value: "one", secret: true, updatedAt: "a" } } },
          "OWNER/PROJECT": { variables: { TOKEN: { value: "two", secret: true, updatedAt: "b" } } },
        },
      });
      const failure = yield* withStore(
        storage.storage,
        Effect.flip(Effect.flatMap(EnvironmentStore, (store) => store.list())),
      );
      assert.strictEqual(failure.reason, "invalid_authority");
      assert.deepStrictEqual(storage.writes, []);
    }),
  );

  it.effect("uses canonical global and repository source identities", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      yield* TestClock.setTime(NOW);
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "global-secret", secret: true }),
        ),
      );
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "repo-secret", secret: true }, "Owner/Project"),
        ),
      );
      const materialization = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.materialize("OWNER/PROJECT")),
      );
      assert.strictEqual(materialization.repo, "owner/project");
      assert.strictEqual(materialization.variables.TOKEN?.value, "repo-secret");
      assert.strictEqual(materialization.variables.TOKEN?.sourceScope, "owner/project");
      const view = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list("OWNER/PROJECT")),
      );
      assert.strictEqual(view.repo, "OWNER/PROJECT");
      assert.strictEqual(view.variables[0]?.source, "repo");
      assert.deepStrictEqual((storage.authority() as EnvironmentAuthority).repositories, {
        "owner/project": {
          variables: {
            TOKEN: {
              value: "repo-secret",
              secret: true,
              updatedAt: view.variables[0]?.updatedAt,
            },
          },
        },
      });
    }),
  );

  it.effect("round-trips put, scoped list, and idempotent remove", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = makeStorage();
      const created = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "global-secret", secret: true }),
        ),
      );
      assert.deepStrictEqual(created, {
        name: "TOKEN",
        secret: true,
        configured: true,
        revision: 1,
      });
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "repo-value", secret: false }, "Owner/Project"),
        ),
      );
      const repoView = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list("OWNER/PROJECT")),
      );
      assert.deepStrictEqual(
        repoView.variables.map(({ name, secret, value, source }) => ({
          name,
          secret,
          value,
          source,
        })),
        [{ name: "TOKEN", secret: false, value: "repo-value", source: "repo" }],
      );
      const removedGlobal = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.remove("TOKEN")),
      );
      assert.deepStrictEqual(removedGlobal, { name: "TOKEN", removed: true, revision: 3 });
      const repeatRemove = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.remove("TOKEN")),
      );
      assert.deepStrictEqual(repeatRemove, { name: "TOKEN", removed: false, revision: 3 });
      const afterGlobalRemove = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list("owner/project")),
      );
      assert.deepStrictEqual(
        afterGlobalRemove.variables.map(({ name, secret, value }) => ({ name, secret, value })),
        [{ name: "TOKEN", secret: false, value: "repo-value" }],
      );
      const removedRepo = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.remove("TOKEN", "OWNER/PROJECT")),
      );
      assert.deepStrictEqual(removedRepo, {
        name: "TOKEN",
        repo: "owner/project",
        removed: true,
        revision: 4,
      });
      const emptyView = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list("OWNER/PROJECT")),
      );
      assert.deepStrictEqual(emptyView.variables, []);
    }),
  );

  it.effect("keeps public views write-only while materialization remains internal", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      yield* TestClock.setTime(NOW);
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("PUBLIC_URL", { value: "https://example.test", secret: false }),
        ),
      );
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("API_TOKEN", { value: "known-real-secret", secret: true }),
        ),
      );
      const view = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.deepStrictEqual(decodeVariablesView(view), view);
      assert.notInclude(JSON.stringify(view), "known-real-secret");
      assert.deepStrictEqual(
        view.variables.map(({ name, value, secret }) => ({ name, value, secret })),
        [
          { name: "API_TOKEN", value: undefined, secret: true },
          { name: "PUBLIC_URL", value: "https://example.test", secret: false },
        ],
      );
      const materialization = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.materialize()),
      );
      assert.strictEqual(materialization.variables.API_TOKEN?.value, "known-real-secret");
      assert.strictEqual(materialization.variables.API_TOKEN?.secret, true);
      assert.strictEqual(materialization.variables.PUBLIC_URL?.value, "https://example.test");
    }),
  );

  it.effect("resolves the global GH_TOKEN secret without exposing its value in public views", () =>
    Effect.gen(function* () {
      const token = "authority-github-token";
      const storage = makeStorage();
      yield* TestClock.setTime(NOW);
      const openaiKey = "authority-openai-key";
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          Effect.all([
            store.put("GH_TOKEN", { value: token, secret: true }),
            store.put("OPENAI_API_KEY", { value: openaiKey, secret: true }),
          ]),
        ),
      );
      const view = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.include(
        view.variables.map((variable) => variable.name),
        "GH_TOKEN",
      );
      assert.notInclude(JSON.stringify(view), token);
      const resolved = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.resolveGlobalSecret("GH_TOKEN")),
      );
      assert.strictEqual(resolved, token);
      const openaiResolved = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.resolveGlobalSecret("OPENAI_API_KEY")),
      );
      assert.strictEqual(openaiResolved, openaiKey);
      const materialized = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.materialize()),
      );
      assert.deepInclude(materialized.variables.GH_TOKEN, {
        value: token,
        secret: true,
        sourceScope: "global",
      });
      const plainFailure = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.put("GH_TOKEN", { value: token, secret: false }),
          ),
        ),
      );
      assert.strictEqual(plainFailure.reason, "invalid_input");
      const repositoryFailure = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.put("GH_TOKEN", { value: token, secret: true }, "owner/project"),
          ),
        ),
      );
      assert.strictEqual(repositoryFailure.reason, "invalid_input");
      const plainStoredStorage = makeStorage({
        version: 4,
        revision: 1,
        global: {
          variables: {
            GH_TOKEN: { value: token, secret: false, updatedAt: "2026-08-20T12:00:00.000Z" },
          },
        },
        repositories: {},
      });
      const plainStoredView = yield* withStore(
        plainStoredStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.notInclude(JSON.stringify(plainStoredView), token);
      assert.strictEqual(plainStoredView.variables[0]?.secret, true);
      const sentinelFailure = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.put("CODEX_HOME", { value: "reserved", secret: true }),
          ),
        ),
      );
      assert.strictEqual(sentinelFailure.reason, "invalid_input");
    }),
  );

  it.effect("rejects missing, plain, repository-scoped, and empty GH_TOKEN authority", () =>
    Effect.gen(function* () {
      const base = {
        version: 4 as const,
        revision: 0,
        global: { variables: {} },
        repositories: {},
      };
      const authorities = [
        base,
        {
          ...base,
          global: {
            variables: {
              GH_TOKEN: { value: "plain", secret: false, updatedAt: "now" },
            },
          },
        },
        {
          ...base,
          repositories: {
            "owner/project": {
              variables: {
                GH_TOKEN: { value: "repository-token", secret: true, updatedAt: "now" },
              },
            },
          },
        },
        {
          ...base,
          global: {
            variables: {
              GH_TOKEN: { value: "", secret: true, updatedAt: "now" },
            },
          },
        },
      ];
      for (const authority of authorities) {
        const storage = makeStorage(authority);
        const failure = yield* withStore(
          storage.storage,
          Effect.flip(
            Effect.flatMap(EnvironmentStore, (store) => store.resolveGlobalSecret("GH_TOKEN")),
          ),
        );
        assert.strictEqual(failure.reason, "invalid_global_secret");
        assert.deepStrictEqual(storage.writes, []);
      }
    }),
  );

  it.effect("returns the declared credential for an exact origin and denies unmapped origins", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = makeStorage();
      const resolve = (input: unknown) =>
        withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) => store.resolveCredentialForOrigin(input)),
        );
      assert.strictEqual(yield* resolve({ origin: "https://registry.example" }), null);

      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          Effect.all([
            store.put("API_TOKEN", {
              value: "opaque-api-value",
              secret: true,
              origins: ["https://registry.example"],
            }),
            store.put("PUBLIC_URL", {
              value: "https://public.test",
              secret: false,
              origins: ["https://registry.example"],
            }),
          ]),
        ),
      );
      const binding = yield* resolve({ origin: "https://registry.example" });
      assert.deepStrictEqual(binding, {
        name: "API_TOKEN",
        scheme: "bearer",
        value: "opaque-api-value",
      });
      const canonicalized = yield* resolve({ origin: "https://registry.example/" });
      assert.deepStrictEqual(canonicalized, binding);
      assert.strictEqual(yield* resolve({ origin: "https://other.example" }), null);

      const pathFailure = yield* withStore(
        storage.storage,
        Effect.flip(resolve({ origin: "https://registry.example/path" })),
      );
      assert.strictEqual(pathFailure.reason, "invalid_input");
      const excessFailure = yield* withStore(
        storage.storage,
        Effect.flip(resolve({ origin: "https://registry.example", extra: true })),
      );
      assert.strictEqual(excessFailure.reason, "invalid_input");
    }),
  );

  it.effect(
    "prefers GH_TOKEN, then managed keys, then alphabetical order when resolving an origin",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const storage = makeStorage();
        const origin = "https://cloud.example";
        const names = [
          "ZETA_TOKEN",
          "OPENCODE_API_KEY",
          "ALPHA_TOKEN",
          "OPENAI_API_KEY",
          "BETA_TOKEN",
          "GH_TOKEN",
        ] as const;
        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            Effect.forEach(names, (name) =>
              store.put(name, { value: `value-${name}`, secret: true, origins: [origin] }),
            ),
          ),
        );
        const resolve = () =>
          withStore(
            storage.storage,
            Effect.flatMap(EnvironmentStore, (store) =>
              store.resolveCredentialForOrigin({ origin }),
            ),
          );
        const ghBinding = yield* resolve();
        assert.deepStrictEqual(ghBinding, {
          name: "GH_TOKEN",
          scheme: "basic-x-access-token",
          value: "value-GH_TOKEN",
        });
        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) => store.remove("GH_TOKEN")),
        );
        const openaiBinding = yield* resolve();
        assert.strictEqual(openaiBinding?.name, "OPENAI_API_KEY");
        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) => store.remove("OPENAI_API_KEY")),
        );
        const opencodeBinding = yield* resolve();
        assert.strictEqual(opencodeBinding?.name, "OPENCODE_API_KEY");
        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) => store.remove("OPENCODE_API_KEY")),
        );
        const alphaBinding = yield* resolve();
        assert.deepStrictEqual(alphaBinding, {
          name: "ALPHA_TOKEN",
          scheme: "bearer",
          value: "value-ALPHA_TOKEN",
        });
      }),
  );

  it.effect("updates origins alone without requiring a value and retains prior fields", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = makeStorage();
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "original-value", secret: true }),
        ),
      );
      const initialUpdatedAt = (storage.authority() as EnvironmentAuthority).global.variables.TOKEN
        ?.updatedAt;

      yield* TestClock.setTime(NOW + 1_000);
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { origins: ["https://a.example", "https://b.example/"] }),
        ),
      );
      assert.deepStrictEqual((storage.authority() as EnvironmentAuthority).global.variables.TOKEN, {
        value: "original-value",
        secret: true,
        updatedAt: new Date(NOW + 1_000).toISOString(),
        origins: ["https://a.example", "https://b.example/"],
      });
      assert.notStrictEqual(
        (storage.authority() as EnvironmentAuthority).global.variables.TOKEN?.updatedAt,
        initialUpdatedAt,
      );

      yield* TestClock.setTime(NOW + 2_000);
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { origins: [], scheme: "bearer" }),
        ),
      );
      assert.deepStrictEqual((storage.authority() as EnvironmentAuthority).global.variables.TOKEN, {
        value: "original-value",
        secret: true,
        updatedAt: new Date(NOW + 2_000).toISOString(),
        origins: [],
        scheme: "bearer",
      });
      const view = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.strictEqual(view.variables[0]?.origins, undefined);

      const writesBeforeCreateFailure = storage.writes.length;
      const createOriginsOnly = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.put("FRESH_VAR", { origins: ["https://a.example"] }),
          ),
        ),
      );
      assert.strictEqual(createOriginsOnly.reason, "invalid_input");
      assert.include(createOriginsOnly.message, "require a value");
      assert.strictEqual(storage.writes.length, writesBeforeCreateFailure);

      const defaultedSecret = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.put("QUIET_VAR", { value: "quiet" })),
      );
      assert.strictEqual(defaultedSecret.secret, true);
      assert.strictEqual(
        (storage.authority() as EnvironmentAuthority).global.variables.QUIET_VAR?.secret,
        true,
      );
    }),
  );

  it.effect("persists credential scheme across updates, views, and origin resolution", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const storage = makeStorage();
      const origin = "https://api.stripe.example";
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("STRIPE_KEY", {
            value: "sk-test-value",
            secret: true,
            scheme: "bearer",
            origins: [origin],
          }),
        ),
      );
      assert.deepStrictEqual(
        (storage.authority() as EnvironmentAuthority).global.variables.STRIPE_KEY,
        {
          value: "sk-test-value",
          secret: true,
          updatedAt: new Date(NOW).toISOString(),
          origins: [origin],
          scheme: "bearer",
        },
      );
      const initialView = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.deepStrictEqual(initialView.variables[0]?.scheme, "bearer");
      assert.deepStrictEqual(initialView.variables[0]?.origins, [origin]);

      yield* TestClock.setTime(NOW + 1_000);
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("STRIPE_KEY", { scheme: "basic-x-access-token" }),
        ),
      );
      assert.deepStrictEqual(
        (storage.authority() as EnvironmentAuthority).global.variables.STRIPE_KEY,
        {
          value: "sk-test-value",
          secret: true,
          updatedAt: new Date(NOW + 1_000).toISOString(),
          origins: [origin],
          scheme: "basic-x-access-token",
        },
      );
      const binding = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.resolveCredentialForOrigin({ origin })),
      );
      assert.deepStrictEqual(binding, {
        name: "STRIPE_KEY",
        scheme: "basic-x-access-token",
        value: "sk-test-value",
      });
      const updatedView = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.strictEqual(updatedView.variables[0]?.scheme, "basic-x-access-token");
      assert.notInclude(JSON.stringify(updatedView), "sk-test-value");
    }),
  );
});
