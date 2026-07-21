import { assert, describe, it } from "@effect/vitest";
import wranglerFixture from "../fixtures/wrangler-bundle-metadata.json" with { type: "json" };
import {
  assertChunk2ReadOnlyPlan,
  assertChunk2Ready,
  CHUNK2_PROTECTED_RESOURCES,
  CHUNK2_WRANGLER_PARITY,
  chunk2ReadinessBlockers,
  type Chunk2LiveInventory,
  type Chunk2PlanAction,
} from "./monolith-adoption-readiness.ts";

const confirmedInventory = (): Chunk2LiveInventory => ({
  alchemyVersion: "2.0.0-beta.63",
  worker: {
    name: "scotty-worker",
    foreignAdoptionProven: true,
    secretBindings: [
      { name: "CODEX_AUTH_JSON", type: "secret_text" },
      { name: "GH_TOKEN", type: "secret_text" },
      { name: "SCOTTY_TOKEN", type: "secret_text" },
    ],
  },
  durableObject: {
    binding: "SANDBOX",
    className: "ScottySandbox",
    namespaceId: "namespace-metadata-only",
    hostScript: "scotty-worker",
    existingV1SqliteMigrationPreserved: true,
  },
  container: {
    applicationId: "application-metadata-only",
    applicationName: "scotty-worker-scottysandbox",
    durableObjectNamespaceId: "namespace-metadata-only",
    coldAdoptionKeepsApplicationId: true,
  },
  kv: { binding: "SESSIONS", namespaceId: "kv-metadata-only", title: "live-title" },
  r2: { binding: "BACKUP_BUCKET", bucketName: "scotty-backups", livePolicyRecorded: true },
  retention: {
    worker: true,
    durableObject: true,
    container: true,
    kv: true,
    r2: true,
    persistedAfterNoopApply: true,
  },
  secretContinuity: {
    writeOnlyReferencesOnly: true,
    codexSourceProven: true,
    githubSourceProven: true,
    scottyTokenSourceProven: true,
  },
});

const plan = (action: Chunk2PlanAction) =>
  CHUNK2_PROTECTED_RESOURCES.map((logicalId) => ({ logicalId, action }));

describe("Chunk 2 monolith adoption readiness", () => {
  it("pins exact Wrangler parity without guessing KV title or clearing R2 lifecycle", () => {
    assert.deepStrictEqual(CHUNK2_WRANGLER_PARITY.worker, {
      name: "scotty-worker",
      entryPoint: "worker/src/index.ts",
      exports: ["ContainerProxy", "ScottySandbox", "default"],
      compatibilityDate: "2026-07-20",
      compatibilityFlags: ["nodejs_compat"],
      observability: true,
      routes: [],
    });
    assert.deepStrictEqual(CHUNK2_WRANGLER_PARITY.assets.runWorkerFirst, [
      "/api/*",
      "/s/*",
      "/health",
    ]);
    assert.strictEqual(CHUNK2_WRANGLER_PARITY.kv.title, undefined);
    assert.strictEqual(CHUNK2_WRANGLER_PARITY.r2.lifecycleRules, "omit-preserve-live");
    assert.deepStrictEqual(CHUNK2_WRANGLER_PARITY.outputKeys, ["url"]);
    assert.strictEqual(CHUNK2_WRANGLER_PARITY.removalPolicy, "retain");
    assert.strictEqual(wranglerFixture.worker.name, CHUNK2_WRANGLER_PARITY.worker.name);
    assert.strictEqual(
      wranglerFixture.worker.compatibilityDate,
      CHUNK2_WRANGLER_PARITY.worker.compatibilityDate,
    );
    assert.deepStrictEqual(wranglerFixture.worker.compatibilityFlags, [
      ...CHUNK2_WRANGLER_PARITY.worker.compatibilityFlags,
    ]);
    assert.deepStrictEqual(wranglerFixture.assets, {
      ...CHUNK2_WRANGLER_PARITY.assets,
      runWorkerFirst: [...CHUNK2_WRANGLER_PARITY.assets.runWorkerFirst],
    });
    assert.deepStrictEqual(wranglerFixture.durableObjectMigrations, [
      { tag: "v1", newSqliteClasses: ["ScottySandbox"] },
    ]);
    assert.deepStrictEqual(wranglerFixture.bindings, [
      { type: "durable_object", name: "SANDBOX", className: "ScottySandbox" },
      { type: "kv_namespace", name: "SESSIONS" },
      { type: "r2_bucket", name: "BACKUP_BUCKET", bucketName: "scotty-backups" },
      { type: "assets", name: "ASSETS" },
      { type: "plain_text", name: "SANDBOX_TRANSPORT", value: "rpc" },
      { type: "plain_text", name: "BACKUP_BUCKET_NAME", value: "scotty-backups" },
    ]);
    assert.deepStrictEqual(wranglerFixture.containers, [
      {
        className: "ScottySandbox",
        dockerfile: CHUNK2_WRANGLER_PARITY.container.dockerfile,
        imageName: CHUNK2_WRANGLER_PARITY.container.expectedWranglerName,
        instanceType: CHUNK2_WRANGLER_PARITY.container.instanceType,
        maxInstances: CHUNK2_WRANGLER_PARITY.container.maxInstances,
      },
    ]);
  });

  it("stops with all offline blockers before live inventory exists", () => {
    assert.deepStrictEqual(
      chunk2ReadinessBlockers(undefined).map(({ code }) => code),
      [
        "B1_FOREIGN_ADOPTION_UNPROVEN",
        "B2_SQLITE_MIGRATION_UNPROVEN",
        "B3_RETENTION_PERSISTENCE_UNPROVEN",
        "B4_CONTAINER_IDENTITY_UNPROVEN",
        "B5_KV_IDENTITY_MISSING",
        "B6_R2_POLICY_UNCONFIRMED",
        "SECRET_CONTINUITY_UNPROVEN",
      ],
    );
    assert.throws(() => assertChunk2Ready(undefined));
  });

  it("fails closed for each data-sensitive live assumption", () => {
    const cases: readonly [keyof Chunk2LiveInventory, Chunk2LiveInventory][] = [
      [
        "worker",
        {
          ...confirmedInventory(),
          worker: { ...confirmedInventory().worker, foreignAdoptionProven: false },
        },
      ],
      [
        "durableObject",
        {
          ...confirmedInventory(),
          durableObject: {
            ...confirmedInventory().durableObject,
            existingV1SqliteMigrationPreserved: false,
          },
        },
      ],
      [
        "retention",
        {
          ...confirmedInventory(),
          retention: { ...confirmedInventory().retention, persistedAfterNoopApply: false },
        },
      ],
      [
        "container",
        {
          ...confirmedInventory(),
          container: { ...confirmedInventory().container, coldAdoptionKeepsApplicationId: false },
        },
      ],
      ["kv", { ...confirmedInventory(), kv: { ...confirmedInventory().kv, title: "" } }],
      [
        "r2",
        { ...confirmedInventory(), r2: { ...confirmedInventory().r2, livePolicyRecorded: false } },
      ],
      [
        "secretContinuity",
        {
          ...confirmedInventory(),
          secretContinuity: {
            ...confirmedInventory().secretContinuity,
            githubSourceProven: false,
          },
        },
      ],
    ];
    for (const [, inventory] of cases)
      assert.notStrictEqual(chunk2ReadinessBlockers(inventory).length, 0);
  });

  it("accepts only complete noop/update review plans and rejects destructive actions", () => {
    assert.doesNotThrow(() => assertChunk2ReadOnlyPlan(plan("noop")));
    assert.doesNotThrow(() => assertChunk2ReadOnlyPlan(plan("update")));
    for (const action of ["create", "replace", "delete"] as const)
      assert.throws(() => assertChunk2ReadOnlyPlan(plan(action)));
    assert.throws(() => assertChunk2ReadOnlyPlan(plan("noop").slice(1)));
    assert.throws(() =>
      assertChunk2ReadOnlyPlan([
        ...plan("noop").slice(1),
        { logicalId: "UnexpectedResource", action: "noop" },
      ]),
    );
  });

  it("keeps readiness inventory metadata-only and cannot clear the beta.63 blocker", () => {
    const serialized = JSON.stringify(confirmedInventory());
    assert.notInclude(serialized, "value");
    assert.notInclude(serialized, "plaintext");
    assert.deepStrictEqual(
      chunk2ReadinessBlockers(confirmedInventory()).map(({ code }) => code),
      ["B4_CONTAINER_IDENTITY_UNPROVEN"],
    );
    assert.throws(() => assertChunk2Ready(confirmedInventory()));
  });
});
