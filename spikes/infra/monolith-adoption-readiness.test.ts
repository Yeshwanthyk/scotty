import { assert, describe, it } from "@effect/vitest";
import * as Output from "alchemy/Output";
import wranglerFixture from "../fixtures/wrangler-bundle-metadata.json" with { type: "json" };
import {
  assertChunk2Ready,
  CHUNK2_PLAN_SURFACES,
  CHUNK2_PROTECTED_RESOURCES,
  CHUNK2_SCAN_ARTIFACTS,
  CHUNK2_SECRET_PROP_KEYS,
  CHUNK2_WRANGLER_PARITY,
  chunk2CloneEvidenceBlockers,
  chunk2InventoryBlockers,
  chunk2PlanReviewBlockers,
  chunk2ReadinessBlockers,
  normalizeChunk2Plan,
  type Chunk2Blocker,
  type Chunk2BlockerCode,
  type Chunk2CloneEvidence,
  type Chunk2LiveInventory,
  type Chunk2PlanResourceReview,
  type Chunk2PlanReviewSnapshot,
  type Chunk2PlanTranscript,
  type Chunk2SecretProps,
  type Chunk2Topology,
} from "./monolith-adoption-readiness.ts";

const markers = {
  plaintext: "synthetic-plaintext-7a5d",
  ownerKey: "synthetic-owner-key-82ce",
} as const;
const digest = (hex: string): string => `sha256:${hex.repeat(64).slice(0, 64)}`;
const fqn = (logicalId: string): string => `scotty::clone::${logicalId}`;
const outputUrl = Output.literal("https://clone.scotty.example");

const policy = () => ({
  lifecycleRules: [
    {
      id: "archive-retention",
      enabled: true,
      conditions: "prefix=archives/;age=30d",
      actions: "transition=InfrequentAccess",
    },
    {
      id: "delete-temp",
      enabled: true,
      conditions: "prefix=tmp/;age=7d",
      actions: "delete",
    },
  ],
  corsRules: [
    {
      allowedOrigins: ["https://admin.scotty.example", "https://scotty.example"],
      allowedMethods: ["HEAD", "GET"],
      allowedHeaders: ["content-type", "authorization"],
      exposedHeaders: ["x-version", "etag"],
      maxAgeSeconds: 3600,
    },
  ],
  customDomains: [
    { domain: "backups.scotty.example", enabled: true, status: "active", minimumTls: "1.2" },
    { domain: "archive.scotty.example", enabled: true, status: "active", minimumTls: "1.2" },
  ],
  location: "WNAM",
  storageClass: "Standard",
});

const bindings = () => [
  {
    type: "durable_object",
    name: "SANDBOX",
    className: "ScottySandbox",
    namespaceId: "do-namespace-01",
  },
  { type: "kv_namespace", name: "SESSIONS", namespaceId: "kv-namespace-01" },
  { type: "r2_bucket", name: "BACKUP_BUCKET", bucketName: "scotty-backups" },
  { type: "assets", name: "ASSETS" },
  { type: "plain_text", name: "SANDBOX_TRANSPORT", value: "rpc" },
  { type: "plain_text", name: "BACKUP_BUCKET_NAME", value: "scotty-backups" },
  { type: "secret_text", name: "CODEX_AUTH_JSON" },
  { type: "secret_text", name: "GH_TOKEN" },
  { type: "secret_text", name: "SCOTTY_TOKEN" },
];

const topology = (): Chunk2Topology => ({
  worker: {
    name: "scotty-worker",
    physicalId: "worker-script:scotty-worker",
    entryPoint: "worker/src/index.ts",
    exports: ["ContainerProxy", "ScottySandbox", "default"],
    compatibilityDate: "2026-07-20",
    compatibilityFlags: ["nodejs_compat"],
    observability: true,
    routes: [],
    assets: {
      binding: "ASSETS",
      directory: "worker/public",
      runWorkerFirst: ["/api/*", "/s/*", "/health"],
      notFoundHandling: "404-page",
    },
    outputKeys: ["url"],
    bindings: bindings(),
  },
  durableObject: {
    binding: "SANDBOX",
    className: "ScottySandbox",
    namespaceId: "do-namespace-01",
    hostScript: "scotty-worker",
    migrations: [{ tag: "v1", newSqliteClasses: ["ScottySandbox"] }],
  },
  container: {
    applicationId: "container-app-01",
    applicationName: "scotty-worker-scottysandbox",
    dockerfile: "worker/container/Dockerfile",
    instanceType: "standard-2",
    maxInstances: 10,
    durableObjectNamespaceId: "do-namespace-01",
  },
  kv: { binding: "SESSIONS", namespaceId: "kv-namespace-01", title: "scotty-sessions" },
  r2: { binding: "BACKUP_BUCKET", bucketName: "scotty-backups", policy: policy() },
});

const inventory = (): Chunk2LiveInventory => ({
  alchemyVersion: "2.0.0-beta.63",
  ...topology(),
});

const secretEvidence = (): readonly (Chunk2SecretProps & { readonly physicalId: string })[] => [
  {
    bindingName: "CODEX_AUTH_JSON",
    sourceId: "scotty/codex-auth",
    physicalId: "secret-1",
    accountId: "account-01",
    storeId: "store-01",
    secretName: "codex-auth-json",
    providerVersion: 1,
    keyedDigest: "hmac-sha256:v1:codex-auth-json",
  },
  {
    bindingName: "GH_TOKEN",
    sourceId: "scotty/github-token",
    physicalId: "secret-2",
    accountId: "account-01",
    storeId: "store-01",
    secretName: "github-token",
    providerVersion: 1,
    keyedDigest: "hmac-sha256:v1:github-token",
  },
  {
    bindingName: "SCOTTY_TOKEN",
    sourceId: "scotty/http-auth",
    physicalId: "secret-3",
    accountId: "account-01",
    storeId: "store-01",
    secretName: "scotty-token",
    providerVersion: 1,
    keyedDigest: "hmac-sha256:v1:scotty-token",
  },
];

const evidence = (): Chunk2CloneEvidence => ({
  physicalIds: {
    worker: { before: "worker-script:scotty-worker", after: "worker-script:scotty-worker" },
    durableObject: { before: "do-namespace-01", after: "do-namespace-01" },
    container: { before: "container-app-01", after: "container-app-01" },
    kv: { before: "kv-namespace-01", after: "kv-namespace-01" },
    r2: { before: "scotty-backups", after: "scotty-backups" },
  },
  seededDigests: {
    session: { before: digest("1"), after: digest("1") },
    lease: { before: digest("2"), after: digest("2") },
    credential: { before: digest("3"), after: digest("3") },
    schedule: { before: digest("4"), after: digest("4") },
    kvProjection: { before: digest("5"), after: digest("5") },
    r2Backup: { before: digest("6"), after: digest("6") },
  },
  observedTopology: { before: topology(), after: topology() },
  outgoingWorkerMigrations: {
    newClasses: [],
    newSqliteClasses: [],
    deletedClasses: [],
    renamedClasses: [],
    transferredClasses: [],
  },
  persistedRetainRows: CHUNK2_PROTECTED_RESOURCES.map(({ logicalId, resourceType }) => ({
    logicalId,
    resourceType,
    removalPolicy: "retain",
  })),
  activeSecretReferences: secretEvidence(),
  postDestroyPhysicalIds: {
    worker: "worker-script:scotty-worker",
    durableObject: "do-namespace-01",
    container: "container-app-01",
    kv: "kv-namespace-01",
    r2: "scotty-backups",
  },
  disclosureScan: {
    markers: { ...markers },
    artifacts: CHUNK2_SCAN_ARTIFACTS.map(({ id, kind }, index) => ({
      id,
      kind,
      digest: digest((index + 1).toString(16)),
      scanResult: "clean" as const,
    })),
    matches: [],
  },
});

const edges = (logicalId: string) => {
  const byResource = new Map<string, readonly string[]>([
    ["MonolithWorker", ["SandboxContainer"]],
    ["SandboxContainer", ["Sandbox"]],
    ["SessionsProjection", []],
    ["BackupBucket", []],
    ["CodexAuthSecret", []],
    ["GithubTokenSecret", []],
    ["ScottyTokenSecret", []],
  ]);
  return (byResource.get(logicalId) ?? []).map((sid) => ({
    sid,
    action: "noop" as const,
  }));
};

const plan = (phase: "reviewed" | "second" = "reviewed"): Chunk2PlanReviewSnapshot => ({
  resources: [
    {
      fqn: fqn("MonolithWorker"),
      logicalId: "MonolithWorker",
      resourceType: "Cloudflare.Worker",
      action: "noop",
      removalPolicy: "retain",
      resolvedIdentity: {
        before: "worker-script:scotty-worker",
        desired: "worker-script:scotty-worker",
      },
      changedInputKeys: [],
      bindingActions: edges("MonolithWorker"),
      derivationFailures: [],
      desiredTopology: topology(),
      workerMigrations: {
        newClasses: [],
        newSqliteClasses: [],
        deletedClasses: [],
        renamedClasses: [],
        transferredClasses: [],
      },
    },
    {
      fqn: fqn("SandboxContainer"),
      logicalId: "SandboxContainer",
      resourceType: "Cloudflare.Container",
      action: "noop",
      removalPolicy: "retain",
      resolvedIdentity: { before: "container-app-01", desired: "container-app-01" },
      changedInputKeys: [],
      bindingActions: edges("SandboxContainer"),
      derivationFailures: [],
    },
    {
      fqn: fqn("SessionsProjection"),
      logicalId: "SessionsProjection",
      resourceType: "Cloudflare.KVNamespace",
      action: "noop",
      removalPolicy: "retain",
      resolvedIdentity: { before: "kv-namespace-01", desired: "kv-namespace-01" },
      changedInputKeys: [],
      bindingActions: [],
      derivationFailures: [],
    },
    {
      fqn: fqn("BackupBucket"),
      logicalId: "BackupBucket",
      resourceType: "Cloudflare.R2Bucket",
      action: "noop",
      removalPolicy: "retain",
      resolvedIdentity: { before: "scotty-backups", desired: "scotty-backups" },
      changedInputKeys: [],
      bindingActions: [],
      derivationFailures: [],
      r2LifecycleRulesInput: "omitted",
    },
    ...secretEvidence().map((secret, index): Chunk2PlanResourceReview => {
      const resource = CHUNK2_PROTECTED_RESOURCES[index + 4];
      return {
        fqn: fqn(resource?.logicalId ?? "missing"),
        logicalId: resource?.logicalId ?? "missing",
        resourceType: "Scotty.WriteOnlySecret",
        action: phase === "reviewed" ? "create" : "noop",
        removalPolicy: "retain",
        resolvedIdentity: {
          before: phase === "reviewed" ? undefined : secret.physicalId,
          desired: secret.physicalId,
        },
        changedInputKeys: [],
        bindingActions: edges(resource?.logicalId ?? "missing"),
        derivationFailures: [],
        secretProps: {
          sourceId: secret.sourceId,
          accountId: secret.accountId,
          storeId: secret.storeId,
          secretName: secret.secretName,
          bindingName: secret.bindingName,
          providerVersion: secret.providerVersion,
          keyedDigest: secret.keyedDigest,
        },
      };
    }),
  ],
  actions: [],
  deletions: [],
  actionDeletions: [],
  output: { url: "https://clone.scotty.example" },
  cycleMembers: [],
});

const transcript = (phase: "reviewed" | "second" = "reviewed"): Chunk2PlanTranscript => {
  const result: Record<string, Chunk2PlanTranscript[string]> = {};
  for (const resource of plan(phase).resources) {
    const {
      fqn: resourceFqn,
      logicalId: _logicalId,
      resourceType: _resourceType,
      action: _action,
      removalPolicy: _removalPolicy,
      bindingActions: _bindingActions,
      ...entry
    } = resource;
    result[resourceFqn] = entry;
  }
  return result;
};

const rawPlan = (phase: "reviewed" | "second" = "reviewed") => {
  const snapshot = plan(phase);
  return {
    resources: Object.fromEntries(
      snapshot.resources.map((resource) => [
        resource.fqn,
        {
          resource: {
            LogicalId: resource.logicalId,
            Type: resource.resourceType,
            RemovalPolicy: resource.removalPolicy,
          },
          action: resource.action,
          bindings: resource.bindingActions.map(({ sid, action }) => ({ sid, action, data: {} })),
        },
      ]),
    ),
    actions: {},
    deletions: {},
    actionDeletions: {},
    output: { url: outputUrl },
    cycleMembers: new Set(snapshot.cycleMembers),
  };
};

const codes = (blockers: readonly Chunk2Blocker[]): readonly Chunk2BlockerCode[] =>
  blockers.map(({ code }) => code);
const planCodes = (snapshot: Chunk2PlanReviewSnapshot, phase: "reviewed" | "second" = "reviewed") =>
  codes(chunk2PlanReviewBlockers(snapshot, inventory(), evidence(), markers, phase));
const cloneCodes = (value: Chunk2CloneEvidence) =>
  codes(chunk2CloneEvidenceBlockers(inventory(), value, markers));
const replaceResource = (
  snapshot: Chunk2PlanReviewSnapshot,
  logicalId: string,
  replace: (resource: Chunk2PlanResourceReview) => Chunk2PlanResourceReview,
): Chunk2PlanReviewSnapshot => ({
  ...snapshot,
  resources: snapshot.resources.map((resource) =>
    resource.logicalId === logicalId ? replace(resource) : resource,
  ),
});

describe("Chunk 2 monolith adoption readiness", () => {
  it("pins every Wrangler fixture surface used by the adoption contract", () => {
    assert.deepStrictEqual(CHUNK2_PLAN_SURFACES, [
      "resources",
      "actions",
      "deletions",
      "actionDeletions",
      "output",
      "cycleMembers",
    ]);
    assert.deepStrictEqual(CHUNK2_SECRET_PROP_KEYS, [
      "sourceId",
      "accountId",
      "storeId",
      "secretName",
      "bindingName",
      "providerVersion",
      "keyedDigest",
    ]);
    assert.strictEqual(wranglerFixture.worker.name, CHUNK2_WRANGLER_PARITY.worker.name);
    assert.strictEqual(wranglerFixture.worker.entryPoint, CHUNK2_WRANGLER_PARITY.worker.entryPoint);
    assert.deepStrictEqual(wranglerFixture.worker.exports, [
      ...CHUNK2_WRANGLER_PARITY.worker.exports,
    ]);
    assert.strictEqual(
      wranglerFixture.worker.compatibilityDate,
      CHUNK2_WRANGLER_PARITY.worker.compatibilityDate,
    );
    assert.deepStrictEqual(wranglerFixture.worker.compatibilityFlags, [
      ...CHUNK2_WRANGLER_PARITY.worker.compatibilityFlags,
    ]);
    assert.strictEqual(
      wranglerFixture.worker.observability,
      CHUNK2_WRANGLER_PARITY.worker.observability,
    );
    assert.deepStrictEqual(wranglerFixture.assets, {
      ...CHUNK2_WRANGLER_PARITY.assets,
      runWorkerFirst: [...CHUNK2_WRANGLER_PARITY.assets.runWorkerFirst],
    });
    assert.deepStrictEqual(wranglerFixture.durableObjectMigrations, [
      { tag: "v1", newSqliteClasses: ["ScottySandbox"] },
    ]);
    assert.deepStrictEqual(wranglerFixture.containers[0], {
      className: "ScottySandbox",
      dockerfile: CHUNK2_WRANGLER_PARITY.container.dockerfile,
      imageName: CHUNK2_WRANGLER_PARITY.container.expectedWranglerName,
      instanceType: CHUNK2_WRANGLER_PARITY.container.instanceType,
      maxInstances: CHUNK2_WRANGLER_PARITY.container.maxInstances,
    });
    assert.deepStrictEqual(
      wranglerFixture.bindings,
      bindings()
        .slice(0, 6)
        .map(({ namespaceId: _namespaceId, ...binding }) => binding),
    );
  });

  it("normalizes a keyed beta.63 Plan and rejects malformed Plan surfaces", () => {
    const normalized = normalizeChunk2Plan(rawPlan(), transcript());
    assert.strictEqual(normalized.output.url, outputUrl);
    assert.deepStrictEqual({ ...normalized, output: plan().output }, plan());
    const missingCycleMembers = { ...rawPlan() };
    Reflect.deleteProperty(missingCycleMembers, "cycleMembers");
    assert.throws(
      () => normalizeChunk2Plan(missingCycleMembers, transcript()),
      /PLAN_SHAPE_INVALID/u,
    );
    assert.throws(
      () => normalizeChunk2Plan({ ...rawPlan(), resources: [] }, transcript()),
      /PLAN_SHAPE_INVALID/u,
    );
    assert.throws(
      () => normalizeChunk2Plan({ ...rawPlan(), summary: {} }, transcript()),
      /PLAN_SHAPE_INVALID/u,
    );
    assert.throws(
      () => normalizeChunk2Plan({ ...rawPlan(), output: { url: "ok", extra: true } }, transcript()),
      /PLAN_SHAPE_INVALID/u,
    );
    const missingType = rawPlan();
    Reflect.deleteProperty(missingType.resources[fqn("MonolithWorker")]?.resource ?? {}, "Type");
    assert.throws(
      () => normalizeChunk2Plan(missingType, transcript()),
      /resourceType must be a string/u,
    );
    const missingSid = rawPlan();
    Reflect.deleteProperty(missingSid.resources[fqn("MonolithWorker")]?.bindings[0] ?? {}, "sid");
    assert.throws(
      () => normalizeChunk2Plan(missingSid, transcript()),
      /bindingActions\[0\].sid must be a string/u,
    );
  });

  it("requires transcript membership to match resource FQNs exactly", () => {
    const missingTranscript = { ...transcript() };
    Reflect.deleteProperty(missingTranscript, fqn("BackupBucket"));
    assert.throws(
      () => normalizeChunk2Plan(rawPlan(), missingTranscript),
      /transcript FQNs must exactly match/u,
    );
    assert.throws(
      () => normalizeChunk2Plan(rawPlan(), { ...transcript(), unexpected: {} }),
      /transcript FQNs must exactly match/u,
    );
  });

  it("accepts exact reviewed/second plans but keeps the unconditional beta.63 blocker", () => {
    assert.deepStrictEqual(codes(chunk2InventoryBlockers(inventory())), []);
    assert.deepStrictEqual(cloneCodes(evidence()), []);
    assert.deepStrictEqual(planCodes(plan()), []);
    assert.deepStrictEqual(planCodes(plan("second"), "second"), []);
    assert.deepStrictEqual(
      codes(chunk2ReadinessBlockers(inventory(), evidence(), plan(), plan("second"), markers)),
      ["B4_CONTAINER_IDENTITY_UNPROVEN"],
    );
    assert.throws(
      () =>
        assertChunk2Ready(
          inventory(),
          evidence(),
          rawPlan(),
          transcript(),
          rawPlan("second"),
          transcript("second"),
          markers,
        ),
      /B4_CONTAINER_IDENTITY_UNPROVEN/u,
    );
  });

  it("rejects active actions, deletions, action deletions, and marker leaks in actions/output", () => {
    assert.deepStrictEqual(planCodes({ ...plan(), actions: [{ fqn: "task", action: "noop" }] }), [
      "PLAN_ACTIVE_ACTION_PRESENT",
    ]);
    assert.deepStrictEqual(
      planCodes({
        ...plan(),
        deletions: [
          {
            fqn: "old-fqn",
            logicalId: "old",
            resourceType: "Cloudflare.Worker",
            action: "delete",
          },
        ],
      }),
      ["PLAN_DELETION_PRESENT"],
    );
    assert.deepStrictEqual(
      planCodes({
        ...plan(),
        actionDeletions: [{ fqn: "old-fqn", logicalId: "old", action: "delete" }],
      }),
      ["PLAN_ACTION_DELETION_PRESENT"],
    );
    assert.deepStrictEqual(planCodes({ ...plan(), output: { url: markers.ownerKey } }), [
      "PLAN_DISCLOSURE_MARKER_FOUND",
    ]);
    assert.deepStrictEqual(
      planCodes({ ...plan(), actions: [{ fqn: markers.plaintext, action: "noop" }] }),
      ["PLAN_ACTIVE_ACTION_PRESENT", "PLAN_DISCLOSURE_MARKER_FOUND"],
    );
  });

  it("blocks keyed run actions and nonempty Set or serialized cycle members", () => {
    const withRun = { ...rawPlan(), actions: { "scotty::clone::Build": { action: "run" } } };
    assert.deepStrictEqual(planCodes(normalizeChunk2Plan(withRun, transcript())), [
      "PLAN_ACTIVE_ACTION_PRESENT",
    ]);
    for (const cycleMembers of [new Set([fqn("MonolithWorker")]), [fqn("MonolithWorker")]]) {
      assert.deepStrictEqual(
        planCodes(normalizeChunk2Plan({ ...rawPlan(), cycleMembers }, transcript())),
        ["PLAN_CYCLE_MEMBERS_PRESENT"],
      );
    }
  });

  it("requires exact Alchemy binding sid ownership and noop actions", () => {
    const mutateEdges = (
      logicalId: string,
      bindingActions: Chunk2PlanResourceReview["bindingActions"],
    ) =>
      planCodes(
        replaceResource(plan(), logicalId, (resource) => ({ ...resource, bindingActions })),
      );
    const worker = edges("MonolithWorker");
    const workerEdge = worker[0] ?? { sid: "", action: "noop" as const };
    assert.deepStrictEqual(mutateEdges("MonolithWorker", []), ["PLAN_BINDING_ACTION_INVALID"]);
    assert.deepStrictEqual(mutateEdges("MonolithWorker", [workerEdge, workerEdge]), [
      "PLAN_BINDING_ACTION_INVALID",
    ]);
    assert.deepStrictEqual(
      mutateEdges("MonolithWorker", [...worker, { sid: "Unexpected", action: "noop" }]),
      ["PLAN_BINDING_ACTION_INVALID"],
    );
    assert.deepStrictEqual(mutateEdges("MonolithWorker", [{ ...workerEdge, action: "delete" }]), [
      "PLAN_BINDING_ACTION_INVALID",
    ]);
    assert.deepStrictEqual(mutateEdges("SandboxContainer", []), ["PLAN_BINDING_ACTION_INVALID"]);
    assert.deepStrictEqual(
      mutateEdges("SessionsProjection", [{ sid: "Unexpected", action: "noop" }]),
      ["PLAN_BINDING_ACTION_INVALID"],
    );
    for (const logicalId of [
      "BackupBucket",
      "CodexAuthSecret",
      "GithubTokenSecret",
      "ScottyTokenSecret",
    ]) {
      assert.deepStrictEqual(mutateEdges(logicalId, [{ sid: "Unexpected", action: "noop" }]), [
        "PLAN_BINDING_ACTION_INVALID",
      ]);
    }
  });

  it("requires observed before/after exact key sets for IDs, digests, and post-destroy IDs", () => {
    const cases: readonly [
      "physicalIds" | "seededDigests" | "postDestroyPhysicalIds",
      string,
      Chunk2BlockerCode,
    ][] = [
      ["physicalIds", "worker", "CLONE_PHYSICAL_IDENTITY_CHANGED"],
      ["seededDigests", "session", "CLONE_SEEDED_STATE_CHANGED"],
      ["postDestroyPhysicalIds", "worker", "CLONE_DESTROY_REMOVED_RESOURCE"],
    ];
    for (const [field, key, expected] of cases) {
      const missing = evidence();
      Reflect.deleteProperty(missing[field], key);
      assert.include(cloneCodes(missing), expected);
      const extra = evidence();
      Reflect.set(
        extra[field],
        "unexpected",
        field === "postDestroyPhysicalIds" ? "id" : { before: "x", after: "x" },
      );
      assert.include(cloneCodes(extra), expected);
    }
    const changed = evidence();
    Reflect.set(changed.physicalIds, "container", {
      before: "container-app-01",
      after: "container-app-02",
    });
    assert.include(cloneCodes(changed), "CLONE_PHYSICAL_IDENTITY_CHANGED");
    const malformedDigest = evidence();
    Reflect.set(malformedDigest.seededDigests, "session", {
      before: "sha256:bad",
      after: "sha256:bad",
    });
    assert.include(cloneCodes(malformedDigest), "CLONE_SEEDED_STATE_CHANGED");
  });

  it("correlates fresh secret creates and second-plan identity plus all metadata by bindingName", () => {
    const populatedBefore = replaceResource(plan(), "CodexAuthSecret", (resource) => ({
      ...resource,
      resolvedIdentity: { before: "already-there", desired: resource.resolvedIdentity.desired },
    }));
    assert.include(planCodes(populatedBefore), "PLAN_IDENTITY_CHANGED");
    const mutations: readonly [keyof Chunk2SecretProps | "physicalId", string | number][] = [
      ["physicalId", "secret-changed"],
      ["accountId", "account-02"],
      ["providerVersion", 2],
      ["keyedDigest", "hmac-sha256:v1:changed"],
    ];
    for (const [field, value] of mutations) {
      const second = replaceResource(plan("second"), "CodexAuthSecret", (resource) =>
        field === "physicalId"
          ? { ...resource, resolvedIdentity: { before: String(value), desired: String(value) } }
          : {
              ...resource,
              secretProps:
                resource.secretProps === undefined
                  ? undefined
                  : { ...resource.secretProps, [field]: value },
            },
      );
      assert.include(
        codes(chunk2ReadinessBlockers(inventory(), evidence(), plan(), second, markers)),
        "PLAN_SECRET_CORRELATION_INVALID",
      );
    }
    const reordered = {
      ...evidence(),
      activeSecretReferences: [...evidence().activeSecretReferences].reverse(),
    };
    assert.deepStrictEqual(
      codes(chunk2ReadinessBlockers(inventory(), reordered, plan(), plan("second"), markers)),
      ["B4_CONTAINER_IDENTITY_UNPROVEN"],
    );
  });

  it("preserves secret_text bindings on beta.63 and blocks Secrets Store conversion behind guarded update evidence", () => {
    const convertedTopology = topology();
    convertedTopology.worker.bindings.forEach((binding) => {
      if (binding.type === "secret_text") Reflect.set(binding, "type", "secrets_store_secret");
    });
    const converted = replaceResource(plan(), "MonolithWorker", (resource) => ({
      ...resource,
      action: "update",
      desiredTopology: convertedTopology,
    }));
    assert.include(planCodes(converted), "PLAN_ACTION_INVALID");
    assert.include(planCodes(converted), "PLAN_PROVIDER_FIREWALL_INVALID");
    assert.include(planCodes(converted), "PLAN_WORKER_BINDINGS_INVALID");
    const noopConversion = replaceResource(plan(), "MonolithWorker", (resource) => ({
      ...resource,
      desiredTopology: convertedTopology,
    }));
    assert.include(planCodes(noopConversion), "PLAN_WORKER_BINDINGS_INVALID");
  });

  it("requires exact SHA-256 provider transcript and request digests", () => {
    for (const field of [
      "transcriptArtifactDigest",
      "reviewedRequestDigests",
      "observedRequestDigests",
    ]) {
      const malformedTranscript = transcript();
      const providerRequestEvidence = {
        transcriptArtifactDigest: digest("a"),
        firewallMode: "deny-by-default",
        reviewedRequestDigests: [digest("b")],
        observedRequestDigests: [digest("b")],
      };
      Reflect.set(
        providerRequestEvidence,
        field,
        field === "transcriptArtifactDigest" ? "sha256:bad" : ["sha256:bad"],
      );
      Reflect.set(
        malformedTranscript[fqn("MonolithWorker")] ?? {},
        "providerRequestEvidence",
        providerRequestEvidence,
      );
      assert.throws(
        () => normalizeChunk2Plan(rawPlan(), malformedTranscript),
        /contains a malformed digest/u,
      );
    }
  });

  it("requires exactly two strong labeled markers and complete unique artifact digest coverage", () => {
    const zero = evidence();
    Reflect.deleteProperty(zero.disclosureScan.markers, "plaintext");
    Reflect.deleteProperty(zero.disclosureScan.markers, "ownerKey");
    assert.include(cloneCodes(zero), "DISCLOSURE_SCAN_INVALID");
    const blank = evidence();
    Reflect.set(blank.disclosureScan.markers, "ownerKey", " ");
    assert.include(cloneCodes(blank), "DISCLOSURE_SCAN_INVALID");
    const duplicate = evidence();
    Reflect.set(duplicate.disclosureScan.markers, "ownerKey", markers.plaintext);
    assert.include(cloneCodes(duplicate), "DISCLOSURE_SCAN_INVALID");
    const missingArtifact = evidence();
    Reflect.set(
      missingArtifact.disclosureScan,
      "artifacts",
      missingArtifact.disclosureScan.artifacts.slice(1),
    );
    assert.include(cloneCodes(missingArtifact), "DISCLOSURE_SCAN_INVALID");
    const duplicateArtifact = evidence();
    Reflect.set(duplicateArtifact.disclosureScan.artifacts[0] ?? {}, "id", "state");
    assert.include(cloneCodes(duplicateArtifact), "DISCLOSURE_SCAN_INVALID");
    const malformedDigest = evidence();
    Reflect.set(malformedDigest.disclosureScan.artifacts[0] ?? {}, "digest", "sha256:not-a-digest");
    assert.include(cloneCodes(malformedDigest), "DISCLOSURE_SCAN_INVALID");
    const missingCleanResult = evidence();
    Reflect.deleteProperty(missingCleanResult.disclosureScan.artifacts[0] ?? {}, "scanResult");
    assert.include(cloneCodes(missingCleanResult), "DISCLOSURE_SCAN_INVALID");
  });

  it("fails explicit transcript derivation gaps and a configured R2 lifecycle input", () => {
    const missingDerivation = replaceResource(plan(), "MonolithWorker", (resource) => ({
      ...resource,
      derivationFailures: [
        {
          field: "desiredTopology.worker.bindings",
          transcriptArtifactDigest: digest("a"),
        },
      ],
    }));
    assert.include(planCodes(missingDerivation), "PLAN_SHAPE_INVALID");
    const configuredLifecycle = replaceResource(plan(), "BackupBucket", (resource) => ({
      ...resource,
      r2LifecycleRulesInput: "configured",
    }));
    assert.include(planCodes(configuredLifecycle), "B6_R2_POLICY_UNCONFIRMED");
  });

  it("canonicalizes keyed collections while preserving the full topology contract", () => {
    const original = topology();
    const firstCors = original.r2.policy.corsRules[0];
    const reorderedTopology: Chunk2Topology = {
      ...original,
      worker: {
        ...original.worker,
        bindings: [...original.worker.bindings].reverse(),
        exports: [...original.worker.exports].reverse(),
      },
      r2: {
        ...original.r2,
        policy: {
          ...original.r2.policy,
          lifecycleRules: [...original.r2.policy.lifecycleRules].reverse(),
          customDomains: [...original.r2.policy.customDomains].reverse(),
          corsRules:
            firstCors === undefined
              ? []
              : [
                  {
                    ...firstCors,
                    allowedOrigins: [...firstCors.allowedOrigins].reverse(),
                    allowedMethods: [...firstCors.allowedMethods].reverse(),
                  },
                ],
        },
      },
    };
    const originalEvidence = evidence();
    const reorderedEvidence: Chunk2CloneEvidence = {
      ...originalEvidence,
      observedTopology: { ...originalEvidence.observedTopology, after: reorderedTopology },
      persistedRetainRows: [...originalEvidence.persistedRetainRows].reverse(),
      activeSecretReferences: [...originalEvidence.activeSecretReferences].reverse(),
    };
    const reorderedPlan = replaceResource(plan(), "MonolithWorker", (resource) => ({
      ...resource,
      desiredTopology: reorderedTopology,
    }));
    assert.deepStrictEqual(
      codes(
        chunk2ReadinessBlockers(
          inventory(),
          reorderedEvidence,
          reorderedPlan,
          plan("second"),
          markers,
        ),
      ),
      ["B4_CONTAINER_IDENTITY_UNPROVEN"],
    );
  });

  it("rejects complete parity drift across Worker, DO, Container, KV, and R2", () => {
    const fields: readonly [string, (value: Chunk2Topology) => void][] = [
      ["worker", (value) => Reflect.set(value.worker, "entryPoint", "other.ts")],
      ["do", (value) => Reflect.set(value.durableObject, "hostScript", "other-worker")],
      ["container", (value) => Reflect.set(value.container, "instanceType", "standard-1")],
      ["kv", (value) => Reflect.set(value.kv, "title", "other-title")],
      ["r2", (value) => Reflect.set(value.r2.policy, "storageClass", "InfrequentAccess")],
    ];
    for (const [_label, mutate] of fields) {
      const changed = topology();
      mutate(changed);
      assert.include(
        planCodes(
          replaceResource(plan(), "MonolithWorker", (resource) => ({
            ...resource,
            desiredTopology: changed,
          })),
        ),
        "PLAN_TOPOLOGY_INVALID",
      );
    }
  });
});
