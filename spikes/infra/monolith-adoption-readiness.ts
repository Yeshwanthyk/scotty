export const CHUNK2_ALCHEMY_VERSION = "2.0.0-beta.63";

export const CHUNK2_PROTECTED_RESOURCES = [
  "MonolithWorker",
  "SandboxNamespace",
  "SandboxContainer",
  "SessionsProjection",
  "BackupBucket",
] as const;

export type Chunk2ProtectedResource = (typeof CHUNK2_PROTECTED_RESOURCES)[number];

export const CHUNK2_WRANGLER_PARITY = {
  worker: {
    name: "scotty-worker",
    entryPoint: "worker/src/index.ts",
    exports: ["ContainerProxy", "ScottySandbox", "default"],
    compatibilityDate: "2026-07-20",
    compatibilityFlags: ["nodejs_compat"],
    observability: true,
    routes: [],
  },
  assets: {
    binding: "ASSETS",
    directory: "worker/public",
    runWorkerFirst: ["/api/*", "/s/*", "/health"],
    notFoundHandling: "404-page",
  },
  durableObject: {
    binding: "SANDBOX",
    className: "ScottySandbox",
    migrationTag: "v1",
    migrationKind: "new_sqlite_classes",
  },
  container: {
    expectedWranglerName: "scotty-worker-scottysandbox",
    dockerfile: "worker/container/Dockerfile",
    instanceType: "standard-2",
    maxInstances: 10,
  },
  kv: { binding: "SESSIONS", title: undefined },
  r2: {
    binding: "BACKUP_BUCKET",
    bucketName: "scotty-backups",
    lifecycleRules: "omit-preserve-live",
  },
  vars: {
    SANDBOX_TRANSPORT: "rpc",
    BACKUP_BUCKET_NAME: "scotty-backups",
  },
  secrets: [
    { binding: "CODEX_AUTH_JSON", kind: "write-only-reference" },
    { binding: "GH_TOKEN", kind: "write-only-reference" },
    { binding: "SCOTTY_TOKEN", kind: "write-only-reference" },
  ],
  outputKeys: ["url"],
  removalPolicy: "retain",
} as const;

export type Chunk2BlockerCode =
  | "B1_FOREIGN_ADOPTION_UNPROVEN"
  | "B2_SQLITE_MIGRATION_UNPROVEN"
  | "B3_RETENTION_PERSISTENCE_UNPROVEN"
  | "B4_CONTAINER_IDENTITY_UNPROVEN"
  | "B5_KV_IDENTITY_MISSING"
  | "B6_R2_POLICY_UNCONFIRMED"
  | "SECRET_CONTINUITY_UNPROVEN";

export interface Chunk2LiveInventory {
  readonly alchemyVersion: typeof CHUNK2_ALCHEMY_VERSION;
  readonly worker: {
    readonly name: "scotty-worker";
    readonly foreignAdoptionProven: boolean;
    readonly secretBindings: readonly {
      readonly name: "CODEX_AUTH_JSON" | "GH_TOKEN" | "SCOTTY_TOKEN";
      readonly type: string;
    }[];
  };
  readonly durableObject: {
    readonly binding: "SANDBOX";
    readonly className: "ScottySandbox";
    readonly namespaceId: string;
    readonly hostScript: "scotty-worker";
    readonly existingV1SqliteMigrationPreserved: boolean;
  };
  readonly container: {
    readonly applicationId: string;
    readonly applicationName: string;
    readonly durableObjectNamespaceId: string;
    readonly coldAdoptionKeepsApplicationId: boolean;
  };
  readonly kv: {
    readonly binding: "SESSIONS";
    readonly namespaceId: string;
    readonly title: string;
  };
  readonly r2: {
    readonly binding: "BACKUP_BUCKET";
    readonly bucketName: "scotty-backups";
    readonly livePolicyRecorded: boolean;
  };
  readonly retention: {
    readonly worker: boolean;
    readonly durableObject: boolean;
    readonly container: boolean;
    readonly kv: boolean;
    readonly r2: boolean;
    readonly persistedAfterNoopApply: boolean;
  };
  readonly secretContinuity: {
    readonly writeOnlyReferencesOnly: boolean;
    readonly codexSourceProven: boolean;
    readonly githubSourceProven: boolean;
    readonly scottyTokenSourceProven: boolean;
  };
}

export interface Chunk2Blocker {
  readonly code: Chunk2BlockerCode;
  readonly message: string;
}

const missing = (value: string): boolean => value.trim().length === 0;

export function chunk2ReadinessBlockers(
  inventory: Chunk2LiveInventory | undefined,
): readonly Chunk2Blocker[] {
  if (inventory === undefined) {
    return [
      { code: "B1_FOREIGN_ADOPTION_UNPROVEN", message: "Read-only live inventory is required." },
      {
        code: "B2_SQLITE_MIGRATION_UNPROVEN",
        message: "The existing v1 SQLite namespace migration has not been observed.",
      },
      {
        code: "B3_RETENTION_PERSISTENCE_UNPROVEN",
        message: "Retain policy persistence has not been read back from Alchemy state.",
      },
      {
        code: "B4_CONTAINER_IDENTITY_UNPROVEN",
        message: "The Wrangler Container application identity and association are unknown.",
      },
      {
        code: "B5_KV_IDENTITY_MISSING",
        message: "The existing SESSIONS namespace ID and title must be read live.",
      },
      {
        code: "B6_R2_POLICY_UNCONFIRMED",
        message: "Live R2 lifecycle, CORS, domain, and storage settings are unrecorded.",
      },
      {
        code: "SECRET_CONTINUITY_UNPROVEN",
        message: "All three runtime secrets require approved write-only source continuity.",
      },
    ];
  }

  const blockers: Chunk2Blocker[] = [];
  if (
    inventory.alchemyVersion !== CHUNK2_ALCHEMY_VERSION ||
    inventory.worker.name !== CHUNK2_WRANGLER_PARITY.worker.name ||
    !inventory.worker.foreignAdoptionProven
  )
    blockers.push({
      code: "B1_FOREIGN_ADOPTION_UNPROVEN",
      message:
        "Pinned beta.63 must preserve the named Worker and external Durable Object on a clone.",
    });
  if (
    inventory.durableObject.binding !== CHUNK2_WRANGLER_PARITY.durableObject.binding ||
    inventory.durableObject.className !== CHUNK2_WRANGLER_PARITY.durableObject.className ||
    inventory.durableObject.hostScript !== CHUNK2_WRANGLER_PARITY.worker.name ||
    missing(inventory.durableObject.namespaceId) ||
    !inventory.durableObject.existingV1SqliteMigrationPreserved
  )
    blockers.push({
      code: "B2_SQLITE_MIGRATION_UNPROVEN",
      message:
        "Adoption must reuse the existing namespace without emitting new_sqlite_classes again.",
    });
  if (
    !Object.values(inventory.retention).every(Boolean) ||
    !inventory.retention.persistedAfterNoopApply
  )
    blockers.push({
      code: "B3_RETENTION_PERSISTENCE_UNPROVEN",
      message:
        "Every persistent resource must retain and the policy must survive a no-op state round-trip.",
    });
  if (
    missing(inventory.container.applicationId) ||
    inventory.container.applicationName !== CHUNK2_WRANGLER_PARITY.container.expectedWranglerName ||
    inventory.container.durableObjectNamespaceId !== inventory.durableObject.namespaceId ||
    !inventory.container.coldAdoptionKeepsApplicationId ||
    inventory.alchemyVersion === CHUNK2_ALCHEMY_VERSION
  )
    blockers.push({
      code: "B4_CONTAINER_IDENTITY_UNPROVEN",
      message:
        "Pinned beta.63 cold adoption compares an empty old binding set and cannot preserve the existing Container association without planning replacement.",
    });
  if (
    inventory.kv.binding !== CHUNK2_WRANGLER_PARITY.kv.binding ||
    missing(inventory.kv.namespaceId) ||
    missing(inventory.kv.title)
  )
    blockers.push({
      code: "B5_KV_IDENTITY_MISSING",
      message: "Do not derive or guess the Wrangler-created KV title.",
    });
  if (
    inventory.r2.binding !== CHUNK2_WRANGLER_PARITY.r2.binding ||
    inventory.r2.bucketName !== CHUNK2_WRANGLER_PARITY.r2.bucketName ||
    !inventory.r2.livePolicyRecorded
  )
    blockers.push({
      code: "B6_R2_POLICY_UNCONFIRMED",
      message: "Record live R2 policy and omit lifecycleRules from the adoption declaration.",
    });
  const expectedSecretNames = CHUNK2_WRANGLER_PARITY.secrets.map(({ binding }) => binding).sort();
  const observedSecretNames = inventory.worker.secretBindings.map(({ name }) => name).sort();
  if (
    !inventory.secretContinuity.writeOnlyReferencesOnly ||
    !inventory.secretContinuity.codexSourceProven ||
    !inventory.secretContinuity.githubSourceProven ||
    !inventory.secretContinuity.scottyTokenSourceProven ||
    observedSecretNames.length !== expectedSecretNames.length ||
    observedSecretNames.some((name, index) => name !== expectedSecretNames[index]) ||
    inventory.worker.secretBindings.some(({ type }) => type !== "secret_text")
  )
    blockers.push({
      code: "SECRET_CONTINUITY_UNPROVEN",
      message: "Never place secret plaintext or Config.redacted values in Alchemy inputs or state.",
    });
  return blockers;
}

export type Chunk2PlanAction = "create" | "noop" | "update" | "replace" | "delete";

export interface Chunk2PlanEntry {
  readonly logicalId: string;
  readonly action: Chunk2PlanAction;
}

const reject = (message: string): never => {
  // oxlint-disable-next-line scotty/no-raw-error-throw -- guarded plan-review boundary
  throw new Error(message);
};

export function assertChunk2ReadOnlyPlan(entries: readonly Chunk2PlanEntry[]): void {
  if (entries.length !== CHUNK2_PROTECTED_RESOURCES.length)
    reject("Chunk 2 plan has an unexpected or missing persistent resource.");
  for (const logicalId of CHUNK2_PROTECTED_RESOURCES) {
    const matches = entries.filter((entry) => entry.logicalId === logicalId);
    if (matches.length !== 1) reject(`Chunk 2 plan must contain exactly one ${logicalId}.`);
    if (matches[0]?.action !== "noop" && matches[0]?.action !== "update")
      reject(`Chunk 2 plan would ${matches[0]?.action ?? "omit"} ${logicalId}.`);
  }
}

export function assertChunk2Ready(inventory: Chunk2LiveInventory | undefined): void {
  const blockers = chunk2ReadinessBlockers(inventory);
  if (blockers.length > 0)
    reject(`Chunk 2 adoption blocked: ${blockers.map(({ code }) => code).join(", ")}.`);
}
