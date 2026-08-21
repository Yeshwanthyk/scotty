import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  EnvironmentOriginSchema,
  EnvironmentApprovalListSchema,
  EnvironmentAuthorizationResultSchema,
  EnvironmentAuthoritySchema,
  EnvironmentVariablesViewSchema,
  ENVIRONMENT_MAX_AUTHORIZATION_KEYS,
  ENVIRONMENT_MAX_ORIGIN_POLICIES,
  ENVIRONMENT_MAX_PENDING_OBSERVATIONS,
  type EnvironmentAuthority,
} from "../src/environment-contracts";
import {
  EnvironmentStore,
  environmentStoreLayer,
  type EnvironmentAuthorityStorage,
} from "../src/environment-store";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

const decodeVariablesView = Schema.decodeUnknownSync(EnvironmentVariablesViewSchema);
const decodeOrigin = Schema.decodeUnknownOption(EnvironmentOriginSchema);
const decodeAuthority = Schema.decodeUnknownOption(EnvironmentAuthoritySchema);
const decodeApprovalList = Schema.decodeUnknownOption(EnvironmentApprovalListSchema);
const decodeAuthorizationResult = Schema.decodeUnknownOption(EnvironmentAuthorizationResultSchema);

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
const makePolicies = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    sourceScope: "global" as const,
    name: `POLICY_${index}`,
    origin: `https://policy-${index}.example`,
    decision: "rejected" as const,
    updatedAt: "observed",
  }));

const makePendingObservations = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    sourceScope: "global" as const,
    name: `PENDING_${index}`,
    origin: `https://pending-${index}.example`,
    firstObservedAt: "observed",
    lastObservedAt: "observed",
  }));

describe("EnvironmentStore", () => {
  it.effect("migrates validated v1 and v2 authorities losslessly into v3", () =>
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
      const v1Authority = v1.authority() as EnvironmentAuthority;
      assert.strictEqual(v1Authority.version, 3);
      assert.deepStrictEqual(v1Authority.originPolicies, []);
      assert.deepStrictEqual(v1Authority.pendingObservations, []);
      assert.strictEqual(v1Authority.global.variables.LEGACY?.value, "retained-v1");

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
      const v2Authority = v2.authority() as EnvironmentAuthority;
      assert.strictEqual(v2Authority.version, 3);
      assert.deepStrictEqual(Object.keys(v2Authority.repositories), ["owner/project"]);
      assert.strictEqual(
        v2Authority.repositories["owner/project"]?.variables.REPO_SECRET?.value,
        "repo-secret",
      );
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

  it.effect("keeps public views write-only while materialization remains internal", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
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
      yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("GH_TOKEN", { value: token, secret: true }),
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
        Effect.flatMap(EnvironmentStore, (store) => store.resolveGlobalGithubToken),
      );
      assert.strictEqual(resolved, token);
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
      const legacyPlainStorage = makeStorage({
        version: 3,
        revision: 1,
        policyRevision: 0,
        global: {
          variables: {
            GH_TOKEN: { value: token, secret: false, updatedAt: "2026-08-20T12:00:00.000Z" },
          },
        },
        repositories: {},
        originPolicies: [],
        pendingObservations: [],
      });
      const legacyPlainView = yield* withStore(
        legacyPlainStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.list()),
      );
      assert.notInclude(JSON.stringify(legacyPlainView), token);
      assert.strictEqual(legacyPlainView.variables[0]?.secret, true);
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
        version: 3 as const,
        revision: 0,
        policyRevision: 0,
        global: { variables: {} },
        repositories: {},
        originPolicies: [],
        pendingObservations: [],
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
          Effect.flip(Effect.flatMap(EnvironmentStore, (store) => store.resolveGlobalGithubToken)),
        );
        assert.strictEqual(failure.reason, "invalid_github_token");
        assert.deepStrictEqual(storage.writes, []);
      }
    }),
  );

  it.effect("requires a live observation and an exact configured secret before approval", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const origin = "https://registry.example";
      const directStorage = makeStorage();
      yield* withStore(
        directStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "opaque", secret: true }),
        ),
      );
      const directFailure = yield* withStore(
        directStorage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.approve({ sourceScope: "global", name: "TOKEN", origin }),
          ),
        ),
      );
      assert.strictEqual(directFailure.reason, "invalid_input");
      assert.include(directFailure.message, "pending");
      assert.deepStrictEqual(
        (directStorage.authority() as EnvironmentAuthority).originPolicies,
        [],
      );

      const variableStorage = makeStorage();
      yield* withStore(
        variableStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.put("TOKEN", { value: "opaque", secret: false }),
        ),
      );
      const plainFailure = yield* withStore(
        variableStorage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.approve({ sourceScope: "global", name: "TOKEN", origin }),
          ),
        ),
      );
      assert.strictEqual(plainFailure.reason, "invalid_input");
      assert.include(plainFailure.message, "secret");
      yield* withStore(
        variableStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) => store.remove("TOKEN")),
      );
      const missingFailure = yield* withStore(
        variableStorage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.approve({ sourceScope: "global", name: "TOKEN", origin }),
          ),
        ),
      );
      assert.strictEqual(missingFailure.reason, "invalid_input");
      assert.include(missingFailure.message, "secret");

      const pending = yield* withStore(
        directStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.authorizeOrRecordPending({
            origin,
            keys: [{ sourceScope: "global", name: "TOKEN" }],
          }),
        ),
      );
      assert.strictEqual(pending.decisions[0]?.status, "pending");
      const approved = yield* withStore(
        directStorage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.approve({ sourceScope: "global", name: "TOKEN", origin }),
        ),
      );
      assert.strictEqual(approved.decision, "approved");
    }),
  );

  it.effect("enforces policy and observation capacities without growing state", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const pendingCountBeforeFill = ENVIRONMENT_MAX_PENDING_OBSERVATIONS - 1;
      const fillName = `PENDING_${pendingCountBeforeFill}`;
      const storage = makeStorage({
        version: 3,
        revision: 4,
        policyRevision: 4,
        global: {
          variables: {
            [fillName]: { value: "opaque", secret: true, updatedAt: "observed" },
            OVERFLOW: { value: "opaque", secret: true, updatedAt: "observed" },
          },
        },
        repositories: {},
        originPolicies: makePolicies(ENVIRONMENT_MAX_ORIGIN_POLICIES),
        pendingObservations: makePendingObservations(pendingCountBeforeFill),
      });

      const filled = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.authorizeOrRecordPending({
            origin: `https://pending-${pendingCountBeforeFill}.example`,
            keys: [{ sourceScope: "global", name: fillName }],
          }),
        ),
      );
      assert.strictEqual(filled.decisions[0]?.status, "pending");
      assert.strictEqual(
        (storage.authority() as EnvironmentAuthority).pendingObservations.length,
        ENVIRONMENT_MAX_PENDING_OBSERVATIONS,
      );
      assert.strictEqual(
        (storage.authority() as EnvironmentAuthority).originPolicies.length,
        ENVIRONMENT_MAX_ORIGIN_POLICIES,
      );

      const writesAtCapacity = storage.writes.length;
      const repeated = yield* withStore(
        storage.storage,
        Effect.flatMap(EnvironmentStore, (store) =>
          store.authorizeOrRecordPending({
            origin: `https://pending-${pendingCountBeforeFill}.example`,
            keys: [{ sourceScope: "global", name: fillName }],
          }),
        ),
      );
      assert.strictEqual(repeated.decisions[0]?.status, "pending");
      assert.strictEqual(storage.writes.length, writesAtCapacity);
      assert.strictEqual(
        (storage.authority() as EnvironmentAuthority).pendingObservations.length,
        ENVIRONMENT_MAX_PENDING_OBSERVATIONS,
      );

      const beforePendingOverflow = storage.authority();
      const pendingOverflow = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin: "https://overflow.example",
              keys: [{ sourceScope: "global", name: "OVERFLOW" }],
            }),
          ),
        ),
      );
      assert.strictEqual(pendingOverflow.reason, "invalid_input");
      assert.include(pendingOverflow.message, "capacity");
      assert.strictEqual(storage.writes.length, writesAtCapacity);
      assert.deepStrictEqual(storage.authority(), beforePendingOverflow);

      const beforePolicyOverflow = storage.authority();
      const policyOverflow = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.reject({
              sourceScope: "global",
              name: "POLICY_OVERFLOW",
              origin: "https://policy-overflow.example",
            }),
          ),
        ),
      );
      assert.strictEqual(policyOverflow.reason, "invalid_input");
      assert.include(policyOverflow.message, "capacity");
      assert.strictEqual(storage.writes.length, writesAtCapacity);
      assert.deepStrictEqual(storage.authority(), beforePolicyOverflow);
    }),
  );

  it.effect("rejects oversized authorization requests and policy output states", () =>
    Effect.gen(function* () {
      const storage = makeStorage();
      const oversizedRequest = yield* withStore(
        storage.storage,
        Effect.flip(
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin: "https://registry.example",
              keys: Array.from({ length: ENVIRONMENT_MAX_AUTHORIZATION_KEYS + 1 }, (_, index) => ({
                sourceScope: "global",
                name: `REQUEST_${index}`,
              })),
            }),
          ),
        ),
      );
      assert.strictEqual(oversizedRequest.reason, "invalid_input");
      assert.deepStrictEqual(storage.writes, []);

      const policy = makePolicies(ENVIRONMENT_MAX_ORIGIN_POLICIES)[0];
      const pending = makePendingObservations(ENVIRONMENT_MAX_PENDING_OBSERVATIONS)[0];
      assert.isTrue(
        Option.isSome(
          decodeAuthority({
            version: 3,
            revision: 0,
            policyRevision: 0,
            global: { variables: {} },
            repositories: {},
            originPolicies: makePolicies(ENVIRONMENT_MAX_ORIGIN_POLICIES),
            pendingObservations: [],
          }),
        ),
      );
      assert.isTrue(
        Option.isSome(
          decodeAuthority({
            version: 3,
            revision: 0,
            policyRevision: 0,
            global: { variables: {} },
            repositories: {},
            originPolicies: [],
            pendingObservations: makePendingObservations(ENVIRONMENT_MAX_PENDING_OBSERVATIONS),
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          decodeAuthority({
            version: 3,
            revision: 0,
            policyRevision: 0,
            global: { variables: {} },
            repositories: {},
            originPolicies: [
              ...makePolicies(ENVIRONMENT_MAX_ORIGIN_POLICIES),
              {
                sourceScope: "global",
                name: "POLICY_OVERFLOW",
                origin: "https://policy-overflow.example",
                decision: "rejected",
                updatedAt: "observed",
              },
            ],
            pendingObservations: [],
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          decodeAuthority({
            version: 3,
            revision: 0,
            policyRevision: 0,
            global: { variables: {} },
            repositories: {},
            originPolicies: [],
            pendingObservations: [
              ...makePendingObservations(ENVIRONMENT_MAX_PENDING_OBSERVATIONS),
              {
                sourceScope: "global",
                name: "PENDING_OVERFLOW",
                origin: "https://pending-overflow.example",
                firstObservedAt: "observed",
                lastObservedAt: "observed",
              },
            ],
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          decodeApprovalList({
            revision: 0,
            policyRevision: 0,
            approvals: [policy, ...makePolicies(ENVIRONMENT_MAX_ORIGIN_POLICIES)],
            pending: [],
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          decodeApprovalList({
            revision: 0,
            policyRevision: 0,
            approvals: [],
            pending: [pending, ...makePendingObservations(ENVIRONMENT_MAX_PENDING_OBSERVATIONS)],
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          decodeAuthorizationResult({
            policyRevision: 0,
            authorized: false,
            decisions: Array.from({ length: ENVIRONMENT_MAX_AUTHORIZATION_KEYS + 1 }, () => ({
              sourceScope: "global",
              name: "TOKEN",
              origin: "https://registry.example",
              status: "pending",
            })),
          }),
        ),
      );
    }),
  );
  it.effect(
    "creates pending observations only during live authorization and keeps decisions keyed",
    () =>
      Effect.gen(function* () {
        const storage = makeStorage();
        yield* TestClock.setTime(NOW);
        const put = (sourceScope: string | undefined, value: string) =>
          withStore(
            storage.storage,
            Effect.flatMap(EnvironmentStore, (store) =>
              store.put("TOKEN", { value, secret: true }, sourceScope),
            ),
          );
        yield* put(undefined, "global-secret");
        yield* put("Owner/Project", "repo-secret");
        const origin = "https://registry.example/";
        const before = storage.authority() as EnvironmentAuthority;
        assert.deepStrictEqual(before.pendingObservations, []);
        const rejectedOrigin = yield* withStore(
          storage.storage,
          Effect.flip(
            Effect.flatMap(EnvironmentStore, (store) =>
              store.authorizeOrRecordPending({
                origin: "https://registry.example/path",
                keys: [{ sourceScope: "global", name: "TOKEN" }],
              }),
            ),
          ),
        );
        assert.strictEqual(rejectedOrigin.reason, "invalid_input");
        assert.deepStrictEqual(
          (storage.authority() as EnvironmentAuthority).pendingObservations,
          [],
        );

        const pending = yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin,
              keys: [
                { sourceScope: "global", name: "TOKEN" },
                { sourceScope: "OWNER/PROJECT", name: "TOKEN" },
              ],
            }),
          ),
        );
        assert.isFalse(pending.authorized);
        assert.deepStrictEqual(
          pending.decisions.map(({ sourceScope, name, origin: resolvedOrigin, status }) => ({
            sourceScope,
            name,
            origin: resolvedOrigin,
            status,
          })),
          [
            {
              sourceScope: "global",
              name: "TOKEN",
              origin: "https://registry.example",
              status: "pending",
            },
            {
              sourceScope: "owner/project",
              name: "TOKEN",
              origin: "https://registry.example",
              status: "pending",
            },
          ],
        );
        assert.deepStrictEqual(
          (storage.authority() as EnvironmentAuthority).pendingObservations.map(
            ({ sourceScope, name, origin: observedOrigin }) => ({
              sourceScope,
              name,
              origin: observedOrigin,
            }),
          ),
          [
            { sourceScope: "global", name: "TOKEN", origin: "https://registry.example" },
            { sourceScope: "owner/project", name: "TOKEN", origin: "https://registry.example" },
          ],
        );

        yield* TestClock.setTime(NOW + 1_000);
        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.approve({
              sourceScope: "OWNER/PROJECT",
              name: "TOKEN",
              origin,
            }),
          ),
        );
        const repoApproved = yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin,
              keys: [{ sourceScope: "owner/project", name: "TOKEN" }],
            }),
          ),
        );
        assert.isTrue(repoApproved.authorized);
        assert.strictEqual(repoApproved.decisions[0]?.status, "approved");
        const globalPending = yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin,
              keys: [{ sourceScope: "global", name: "TOKEN" }],
            }),
          ),
        );
        assert.strictEqual(globalPending.decisions[0]?.status, "pending");

        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.reject({ sourceScope: "owner/project", name: "TOKEN", origin }),
          ),
        );
        const rejected = yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin,
              keys: [{ sourceScope: "owner/project", name: "TOKEN" }],
            }),
          ),
        );
        assert.strictEqual(rejected.decisions[0]?.status, "rejected");
        yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.revoke({ sourceScope: "owner/project", name: "TOKEN", origin }),
          ),
        );
        const revoked = yield* withStore(
          storage.storage,
          Effect.flatMap(EnvironmentStore, (store) =>
            store.authorizeOrRecordPending({
              origin,
              keys: [{ sourceScope: "owner/project", name: "TOKEN" }],
            }),
          ),
        );
        assert.strictEqual(revoked.decisions[0]?.status, "revoked");
        assert.deepStrictEqual(
          (yield* withStore(
            storage.storage,
            Effect.flatMap(EnvironmentStore, (store) => store.listApprovals("OWNER/PROJECT")),
          )).pending,
          [],
        );
        assert.isTrue(
          (yield* withStore(
            storage.storage,
            Effect.flatMap(EnvironmentStore, (store) => store.listApprovals()),
          )).pending.length > 0,
        );
        assert.isFalse(Option.isSome(decodeOrigin("https://registry.example/path")));
      }),
  );
});
