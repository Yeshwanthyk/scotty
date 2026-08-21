import type { Plan } from "alchemy/Plan";
import { Option, Schema } from "effect";

export const CHUNK2_ALCHEMY_VERSION = "2.0.0-beta.63";

export const CHUNK2_ADOPTED_RESOURCES = [
  { logicalId: "MonolithWorker", resourceType: "Cloudflare.Worker" },
  { logicalId: "SandboxContainer", resourceType: "Cloudflare.Container" },
  { logicalId: "SessionsProjection", resourceType: "Cloudflare.KVNamespace" },
  { logicalId: "BackupBucket", resourceType: "Cloudflare.R2Bucket" },
] as const;

export const CHUNK2_SECRET_RESOURCES = [
  {
    logicalId: "GithubTokenSecret",
    resourceType: "Scotty.WriteOnlySecret",
    bindingName: "GH_TOKEN",
    sourceId: "scotty/github-token",
  },
  {
    logicalId: "ScottyTokenSecret",
    resourceType: "Scotty.WriteOnlySecret",
    bindingName: "SCOTTY_TOKEN",
    sourceId: "scotty/http-auth",
  },
] as const;

export const CHUNK2_PROTECTED_RESOURCES = [
  ...CHUNK2_ADOPTED_RESOURCES,
  ...CHUNK2_SECRET_RESOURCES,
] as const;

export const CHUNK2_SECRET_PROP_KEYS = [
  "sourceId",
  "accountId",
  "storeId",
  "secretName",
  "bindingName",
  "providerVersion",
  "keyedDigest",
] as const;

export const CHUNK2_PLAN_SURFACES = [
  "resources",
  "actions",
  "deletions",
  "actionDeletions",
  "output",
  "cycleMembers",
] as const;

export const CHUNK2_SCAN_ARTIFACTS = [
  { id: "reviewed-plan", kind: "reviewed-plan" },
  { id: "second-plan", kind: "second-plan" },
  { id: "state", kind: "state" },
  { id: "log", kind: "log" },
  { id: "output", kind: "output" },
  { id: "bundle", kind: "bundle" },
] as const;

export const CHUNK2_WRANGLER_PARITY = {
  worker: {
    name: "scotty-worker",
    entryPoint: "worker/src/index.ts",
    exports: ["ContainerProxy", "ScottySandbox", "default"],
    compatibilityDate: "2026-07-20",
    compatibilityFlags: ["nodejs_compat"],
    observability: true,
    routes: [],
    outputKeys: ["url"],
  },
  assets: {
    binding: "ASSETS",
    directory: "worker/public",
    runWorkerFirst: ["/api/*", "/s/*", "/sessions", "/health"],
    htmlHandling: "none",
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
  kv: { binding: "SESSIONS" },
  r2: { binding: "BACKUP_BUCKET", bucketName: "scotty-backups" },
  vars: { SANDBOX_TRANSPORT: "rpc", BACKUP_BUCKET_NAME: "scotty-backups" },
  removalPolicy: "retain",
} as const;

export type Chunk2PlanAction = "create" | "noop" | "update" | "replace" | "delete";
export type Chunk2TaskAction = "run" | "noop";
export type Chunk2BindingAction = "create" | "noop" | "update" | "delete";
export type Chunk2SecretBindingName = "GH_TOKEN" | "SCOTTY_TOKEN";

export interface Chunk2ResolvedIdentity {
  readonly before: string | undefined;
  readonly desired: string;
}

export interface Chunk2ObservedValue {
  readonly before: string;
  readonly after: string;
}

export interface Chunk2BindingReview {
  readonly sid: string;
  readonly action: Chunk2BindingAction;
}

export interface Chunk2WorkerMigrationOperations {
  readonly newClasses: readonly string[];
  readonly newSqliteClasses: readonly string[];
  readonly deletedClasses: readonly string[];
  readonly renamedClasses: readonly { readonly from: string; readonly to: string }[];
  readonly transferredClasses: readonly {
    readonly from: string;
    readonly to: string;
    readonly fromScript: string;
  }[];
}

export interface Chunk2NormalizedWorkerBinding {
  readonly type: string;
  readonly name: string;
  readonly className?: string;
  readonly namespaceId?: string;
  readonly bucketName?: string;
  readonly value?: string;
  readonly storeId?: string;
  readonly secretName?: string;
}

export interface Chunk2WorkerTopology {
  readonly name: string;
  readonly physicalId: string;
  readonly entryPoint: string;
  readonly exports: readonly string[];
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly observability: boolean;
  readonly routes: readonly string[];
  readonly assets: {
    readonly binding: string;
    readonly directory: string;
    readonly runWorkerFirst: readonly string[];
    readonly htmlHandling: string;
    readonly notFoundHandling: string;
  };
  readonly outputKeys: readonly string[];
  readonly bindings: readonly Chunk2NormalizedWorkerBinding[];
}

export interface Chunk2DurableObjectTopology {
  readonly binding: string;
  readonly className: string;
  readonly namespaceId: string;
  readonly hostScript: string;
  readonly migrations: readonly {
    readonly tag: string;
    readonly newSqliteClasses: readonly string[];
  }[];
}

export interface Chunk2ContainerTopology {
  readonly applicationId: string;
  readonly applicationName: string;
  readonly dockerfile: string;
  readonly instanceType: string;
  readonly maxInstances: number;
  readonly durableObjectNamespaceId: string;
}

export interface Chunk2R2PolicyDetails {
  readonly lifecycleRules: readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly conditions: string;
    readonly actions: string;
  }[];
  readonly corsRules: readonly {
    readonly allowedOrigins: readonly string[];
    readonly allowedMethods: readonly string[];
    readonly allowedHeaders: readonly string[];
    readonly exposedHeaders: readonly string[];
    readonly maxAgeSeconds: number | undefined;
  }[];
  readonly customDomains: readonly {
    readonly domain: string;
    readonly enabled: boolean;
    readonly status: string;
    readonly minimumTls: string;
  }[];
  readonly location: string;
  readonly storageClass: string;
}

export interface Chunk2Topology {
  readonly worker: Chunk2WorkerTopology;
  readonly durableObject: Chunk2DurableObjectTopology;
  readonly container: Chunk2ContainerTopology;
  readonly kv: { readonly binding: string; readonly namespaceId: string; readonly title: string };
  readonly r2: {
    readonly binding: string;
    readonly bucketName: string;
    readonly policy: Chunk2R2PolicyDetails;
  };
}

export interface Chunk2SecretProps {
  readonly sourceId: string;
  readonly accountId: string;
  readonly storeId: string;
  readonly secretName: string;
  readonly bindingName: Chunk2SecretBindingName;
  readonly providerVersion: 1;
  readonly keyedDigest: string;
}

export interface Chunk2ProviderRequestEvidence {
  readonly transcriptArtifactDigest: string;
  readonly firewallMode: "deny-by-default";
  readonly reviewedRequestDigests: readonly string[];
  readonly observedRequestDigests: readonly string[];
}

export interface Chunk2PlanResourceReview {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly action: Chunk2PlanAction;
  readonly removalPolicy: string;
  readonly resolvedIdentity: Chunk2ResolvedIdentity;
  readonly changedInputKeys: readonly string[];
  readonly bindingActions: readonly Chunk2BindingReview[];
  readonly derivationFailures: readonly {
    readonly field: string;
    readonly transcriptArtifactDigest: string;
  }[];
  readonly secretProps?: Chunk2SecretProps;
  readonly desiredTopology?: Chunk2Topology;
  readonly workerMigrations?: Chunk2WorkerMigrationOperations;
  readonly r2LifecycleRulesInput?: "omitted" | "configured";
  readonly providerRequestEvidence?: Chunk2ProviderRequestEvidence;
}

export interface Chunk2PlanDeletionReview {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly action: "delete";
}

export interface Chunk2ActionDeletionReview {
  readonly fqn: string;
  readonly logicalId: string;
  readonly action: "delete";
}

export interface Chunk2PlanReviewSnapshot {
  readonly resources: readonly Chunk2PlanResourceReview[];
  readonly actions: readonly { readonly fqn: string; readonly action: Chunk2TaskAction }[];
  readonly deletions: readonly Chunk2PlanDeletionReview[];
  readonly actionDeletions: readonly Chunk2ActionDeletionReview[];
  readonly output: { readonly url: unknown };
  readonly cycleMembers: readonly string[];
}

export type Chunk2PlanTranscript = Readonly<
  Record<
    string,
    Omit<
      Chunk2PlanResourceReview,
      "fqn" | "logicalId" | "resourceType" | "action" | "removalPolicy" | "bindingActions"
    >
  >
>;

export type Chunk2RawPlan = Omit<Plan<unknown>, "cycleMembers"> & {
  readonly cycleMembers: ReadonlySet<string> | readonly string[];
};

export interface Chunk2LiveInventory extends Chunk2Topology {
  readonly alchemyVersion: typeof CHUNK2_ALCHEMY_VERSION;
}

export interface Chunk2CloneEvidence {
  readonly physicalIds: Readonly<
    Record<"worker" | "durableObject" | "container" | "kv" | "r2", Chunk2ObservedValue>
  >;
  readonly seededDigests: Readonly<
    Record<
      "session" | "lease" | "credential" | "schedule" | "kvProjection" | "r2Backup",
      Chunk2ObservedValue
    >
  >;
  readonly observedTopology: { readonly before: Chunk2Topology; readonly after: Chunk2Topology };
  readonly outgoingWorkerMigrations: Chunk2WorkerMigrationOperations;
  readonly persistedRetainRows: readonly {
    readonly logicalId: string;
    readonly resourceType: string;
    readonly removalPolicy: string;
  }[];
  readonly activeSecretReferences: readonly (Chunk2SecretProps & { readonly physicalId: string })[];
  readonly postDestroyPhysicalIds: Readonly<
    Record<"worker" | "durableObject" | "container" | "kv" | "r2", string>
  >;
  readonly disclosureScan: {
    readonly markers: { readonly plaintext: string; readonly ownerKey: string };
    readonly artifacts: readonly {
      readonly id: (typeof CHUNK2_SCAN_ARTIFACTS)[number]["id"];
      readonly kind: (typeof CHUNK2_SCAN_ARTIFACTS)[number]["kind"];
      readonly digest: string;
      readonly scanResult: "clean" | "found";
    }[];
    readonly matches: readonly { readonly label: string; readonly artifact: string }[];
  };
}

export type Chunk2BlockerCode =
  | "B1_FOREIGN_ADOPTION_UNPROVEN"
  | "B2_SQLITE_MIGRATION_UNPROVEN"
  | "B3_RETENTION_PERSISTENCE_UNPROVEN"
  | "B4_CONTAINER_IDENTITY_UNPROVEN"
  | "B5_KV_IDENTITY_MISSING"
  | "B6_R2_POLICY_UNCONFIRMED"
  | "SECRET_CONTINUITY_UNPROVEN"
  | "CLONE_PHYSICAL_IDENTITY_CHANGED"
  | "CLONE_SEEDED_STATE_CHANGED"
  | "CLONE_DESTROY_REMOVED_RESOURCE"
  | "DISCLOSURE_SCAN_INVALID"
  | "PLAN_SHAPE_INVALID"
  | "PLAN_RESOURCE_SET_INVALID"
  | "PLAN_RESOURCE_TYPE_INVALID"
  | "PLAN_ACTION_INVALID"
  | "PLAN_ACTIVE_ACTION_PRESENT"
  | "PLAN_DELETION_PRESENT"
  | "PLAN_ACTION_DELETION_PRESENT"
  | "PLAN_OUTPUT_INVALID"
  | "PLAN_CYCLE_MEMBERS_PRESENT"
  | "PLAN_IDENTITY_UNRESOLVED"
  | "PLAN_IDENTITY_CHANGED"
  | "PLAN_CHANGED_INPUT_KEYS"
  | "PLAN_REMOVAL_POLICY_INVALID"
  | "PLAN_BINDING_ACTION_INVALID"
  | "PLAN_WORKER_BINDINGS_INVALID"
  | "PLAN_WORKER_MIGRATIONS_INVALID"
  | "PLAN_TOPOLOGY_INVALID"
  | "PLAN_SECRET_PROPS_INVALID"
  | "PLAN_SECRET_CORRELATION_INVALID"
  | "PLAN_PROVIDER_FIREWALL_INVALID"
  | "PLAN_DISCLOSURE_MARKER_FOUND";

export interface Chunk2Blocker {
  readonly code: Chunk2BlockerCode;
  readonly message: string;
}

export class Chunk2ReadinessError extends Error {}

const BindingInputSchema = Schema.Struct({
  type: Schema.Unknown,
  name: Schema.Unknown,
  className: Schema.optionalKey(Schema.Unknown),
  namespaceId: Schema.optionalKey(Schema.Unknown),
  bucketName: Schema.optionalKey(Schema.Unknown),
  value: Schema.optionalKey(Schema.Unknown),
  storeId: Schema.optionalKey(Schema.Unknown),
  secretName: Schema.optionalKey(Schema.Unknown),
});
const MigrationInputSchema = Schema.Struct({
  newClasses: Schema.Unknown,
  newSqliteClasses: Schema.Unknown,
  deletedClasses: Schema.Unknown,
  renamedClasses: Schema.Unknown,
  transferredClasses: Schema.Unknown,
});
const RenamedClassInputSchema = Schema.Struct({ from: Schema.Unknown, to: Schema.Unknown });
const TransferredClassInputSchema = Schema.Struct({
  from: Schema.Unknown,
  to: Schema.Unknown,
  fromScript: Schema.Unknown,
});
const PolicyInputSchema = Schema.Struct({
  lifecycleRules: Schema.Unknown,
  corsRules: Schema.Unknown,
  customDomains: Schema.Unknown,
  location: Schema.Unknown,
  storageClass: Schema.Unknown,
});
const LifecycleRuleInputSchema = Schema.Struct({
  id: Schema.Unknown,
  enabled: Schema.Unknown,
  conditions: Schema.Unknown,
  actions: Schema.Unknown,
});
const CorsRuleInputSchema = Schema.Struct({
  allowedOrigins: Schema.Unknown,
  allowedMethods: Schema.Unknown,
  allowedHeaders: Schema.Unknown,
  exposedHeaders: Schema.Unknown,
  maxAgeSeconds: Schema.Unknown,
});
const CustomDomainInputSchema = Schema.Struct({
  domain: Schema.Unknown,
  enabled: Schema.Unknown,
  status: Schema.Unknown,
  minimumTls: Schema.Unknown,
});
const TopologyInputSchema = Schema.Struct({
  worker: Schema.Unknown,
  durableObject: Schema.Unknown,
  container: Schema.Unknown,
  kv: Schema.Unknown,
  r2: Schema.Unknown,
});
const WorkerInputSchema = Schema.Struct({
  name: Schema.Unknown,
  physicalId: Schema.Unknown,
  entryPoint: Schema.Unknown,
  exports: Schema.Unknown,
  compatibilityDate: Schema.Unknown,
  compatibilityFlags: Schema.Unknown,
  observability: Schema.Unknown,
  routes: Schema.Unknown,
  assets: Schema.Unknown,
  outputKeys: Schema.Unknown,
  bindings: Schema.Unknown,
});
const AssetsInputSchema = Schema.Struct({
  binding: Schema.Unknown,
  directory: Schema.Unknown,
  runWorkerFirst: Schema.Unknown,
  htmlHandling: Schema.Unknown,
  notFoundHandling: Schema.Unknown,
});
const DurableObjectInputSchema = Schema.Struct({
  binding: Schema.Unknown,
  className: Schema.Unknown,
  namespaceId: Schema.Unknown,
  hostScript: Schema.Unknown,
  migrations: Schema.Unknown,
});
const DurableObjectMigrationInputSchema = Schema.Struct({
  tag: Schema.Unknown,
  newSqliteClasses: Schema.Unknown,
});
const ContainerInputSchema = Schema.Struct({
  applicationId: Schema.Unknown,
  applicationName: Schema.Unknown,
  dockerfile: Schema.Unknown,
  instanceType: Schema.Unknown,
  maxInstances: Schema.Unknown,
  durableObjectNamespaceId: Schema.Unknown,
});
const KvInputSchema = Schema.Struct({
  binding: Schema.Unknown,
  namespaceId: Schema.Unknown,
  title: Schema.Unknown,
});
const R2InputSchema = Schema.Struct({
  binding: Schema.Unknown,
  bucketName: Schema.Unknown,
  policy: Schema.Unknown,
});
const SecretPropsInputSchema = Schema.Struct({
  sourceId: Schema.Unknown,
  accountId: Schema.Unknown,
  storeId: Schema.Unknown,
  secretName: Schema.Unknown,
  bindingName: Schema.Unknown,
  providerVersion: Schema.Unknown,
  keyedDigest: Schema.Unknown,
});
const ResourceReviewInputSchema = Schema.Struct({
  fqn: Schema.Unknown,
  logicalId: Schema.Unknown,
  resourceType: Schema.Unknown,
  action: Schema.Unknown,
  removalPolicy: Schema.Unknown,
  resolvedIdentity: Schema.Unknown,
  changedInputKeys: Schema.Unknown,
  bindingActions: Schema.Unknown,
  derivationFailures: Schema.Unknown,
  secretProps: Schema.optionalKey(Schema.Unknown),
  desiredTopology: Schema.optionalKey(Schema.Unknown),
  workerMigrations: Schema.optionalKey(Schema.Unknown),
  r2LifecycleRulesInput: Schema.optionalKey(Schema.Unknown),
  providerRequestEvidence: Schema.optionalKey(Schema.Unknown),
});
const ResolvedIdentityInputSchema = Schema.Struct({
  before: Schema.Unknown,
  desired: Schema.Unknown,
});
const BindingActionInputSchema = Schema.Struct({ sid: Schema.Unknown, action: Schema.Unknown });
const DerivationFailureInputSchema = Schema.Struct({
  field: Schema.Unknown,
  transcriptArtifactDigest: Schema.Unknown,
});
const ProviderEvidenceInputSchema = Schema.Struct({
  transcriptArtifactDigest: Schema.Unknown,
  firewallMode: Schema.Unknown,
  reviewedRequestDigests: Schema.Unknown,
  observedRequestDigests: Schema.Unknown,
});
const RawPlanInputSchema = Schema.Struct({
  resources: Schema.Unknown,
  actions: Schema.Unknown,
  deletions: Schema.Unknown,
  actionDeletions: Schema.Unknown,
  output: Schema.Unknown,
  cycleMembers: Schema.Unknown,
});
const OutputInputSchema = Schema.Struct({ url: Schema.Unknown });

// Alchemy beta.63 rows are open objects. Their named fields are decoded here,
// while extra provider fields remain accepted and are not retained by Scotty.
const RawActionInputSchema = Schema.Struct({ action: Schema.optionalKey(Schema.Unknown) });
const RawDeletionInputSchema = Schema.Struct({
  action: Schema.optionalKey(Schema.Unknown),
  resource: Schema.optionalKey(Schema.Unknown),
});
const RawDeletionResourceInputSchema = Schema.Struct({
  LogicalId: Schema.optionalKey(Schema.Unknown),
  Type: Schema.optionalKey(Schema.Unknown),
});
const RawActionDeletionInputSchema = Schema.Struct({
  action: Schema.optionalKey(Schema.Unknown),
  def: Schema.optionalKey(Schema.Unknown),
});
const RawActionDefinitionInputSchema = Schema.Struct({
  LogicalId: Schema.optionalKey(Schema.Unknown),
});
const RawResourceNodeInputSchema = Schema.Struct({
  resource: Schema.optionalKey(Schema.Unknown),
  action: Schema.optionalKey(Schema.Unknown),
  bindings: Schema.optionalKey(Schema.Unknown),
});
const RawResourceInputSchema = Schema.Struct({
  LogicalId: Schema.optionalKey(Schema.Unknown),
  Type: Schema.optionalKey(Schema.Unknown),
  RemovalPolicy: Schema.optionalKey(Schema.Unknown),
});
const RawBindingInputSchema = Schema.Struct({
  sid: Schema.optionalKey(Schema.Unknown),
  action: Schema.optionalKey(Schema.Unknown),
});
const ObservedValueInputSchema = Schema.Struct({ before: Schema.Unknown, after: Schema.Unknown });
const DisclosureMarkersInputSchema = Schema.Struct({
  plaintext: Schema.String,
  ownerKey: Schema.String,
});

const strict = { onExcessProperty: "error" } as const;
const open = { onExcessProperty: "preserve" } as const;
const decodeBindingInput = Schema.decodeUnknownOption(BindingInputSchema, strict);
const decodeMigrationInput = Schema.decodeUnknownOption(MigrationInputSchema, strict);
const decodeRenamedClassInput = Schema.decodeUnknownOption(RenamedClassInputSchema, strict);
const decodeTransferredClassInput = Schema.decodeUnknownOption(TransferredClassInputSchema, strict);
const decodePolicyInput = Schema.decodeUnknownOption(PolicyInputSchema, strict);
const decodeLifecycleRuleInput = Schema.decodeUnknownOption(LifecycleRuleInputSchema, strict);
const decodeCorsRuleInput = Schema.decodeUnknownOption(CorsRuleInputSchema, strict);
const decodeCustomDomainInput = Schema.decodeUnknownOption(CustomDomainInputSchema, strict);
const decodeTopologyInput = Schema.decodeUnknownOption(TopologyInputSchema, strict);
const decodeWorkerInput = Schema.decodeUnknownOption(WorkerInputSchema, strict);
const decodeAssetsInput = Schema.decodeUnknownOption(AssetsInputSchema, strict);
const decodeDurableObjectInput = Schema.decodeUnknownOption(DurableObjectInputSchema, strict);
const decodeDurableObjectMigrationInput = Schema.decodeUnknownOption(
  DurableObjectMigrationInputSchema,
  strict,
);
const decodeContainerInput = Schema.decodeUnknownOption(ContainerInputSchema, strict);
const decodeKvInput = Schema.decodeUnknownOption(KvInputSchema, strict);
const decodeR2Input = Schema.decodeUnknownOption(R2InputSchema, strict);
const decodeSecretPropsInput = Schema.decodeUnknownOption(SecretPropsInputSchema, strict);
const decodeResourceReviewInput = Schema.decodeUnknownOption(ResourceReviewInputSchema, strict);
const decodeResolvedIdentityInput = Schema.decodeUnknownOption(ResolvedIdentityInputSchema, strict);
const decodeBindingActionInput = Schema.decodeUnknownOption(BindingActionInputSchema, strict);
const decodeDerivationFailureInput = Schema.decodeUnknownOption(
  DerivationFailureInputSchema,
  strict,
);
const decodeProviderEvidenceInput = Schema.decodeUnknownOption(ProviderEvidenceInputSchema, strict);
const decodeRawPlanInput = Schema.decodeUnknownOption(RawPlanInputSchema, strict);
const decodeOutputInput = Schema.decodeUnknownOption(OutputInputSchema, strict);
const decodeRawActionInput = Schema.decodeUnknownOption(RawActionInputSchema, open);
const decodeRawDeletionInput = Schema.decodeUnknownOption(RawDeletionInputSchema, open);
const decodeRawDeletionResourceInput = Schema.decodeUnknownOption(
  RawDeletionResourceInputSchema,
  open,
);
const decodeRawActionDeletionInput = Schema.decodeUnknownOption(RawActionDeletionInputSchema, open);
const decodeRawActionDefinitionInput = Schema.decodeUnknownOption(
  RawActionDefinitionInputSchema,
  open,
);
const decodeRawResourceNodeInput = Schema.decodeUnknownOption(RawResourceNodeInputSchema, open);
const decodeRawResourceInput = Schema.decodeUnknownOption(RawResourceInputSchema, open);
const decodeRawBindingInput = Schema.decodeUnknownOption(RawBindingInputSchema, open);
const decodeObservedValueInput = Schema.decodeUnknownOption(ObservedValueInputSchema, strict);
const decodeDisclosureMarkersInput = Schema.decodeUnknownOption(
  DisclosureMarkersInputSchema,
  strict,
);

const blocker = (code: Chunk2BlockerCode, message: string): Chunk2Blocker => ({ code, message });
const missing = (value: string | undefined): boolean => value === undefined || value.trim() === "";
const sorted = (values: readonly string[]): readonly string[] => [...values].sort();
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const sameOrdered = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const failShape = (message: string): never => {
  throw new Chunk2ReadinessError(`PLAN_SHAPE_INVALID: ${message}`);
};
const isEntriesObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const entriesOf = (value: unknown, path: string): readonly [string, unknown][] => {
  if (!isEntriesObject(value)) return failShape(`${path} must be a record`);
  return Object.entries(value);
};
const decodeShape = <A>(
  decoder: (value: unknown) => Option.Option<A>,
  value: unknown,
  path: string,
  message: string,
): A => {
  entriesOf(value, path);
  const decoded = decoder(value);
  if (Option.isNone(decoded)) return failShape(message);
  return decoded.value;
};
const string = (value: unknown, path: string): string => {
  if (typeof value !== "string") return failShape(`${path} must be a string`);
  return value;
};
const nonEmptyString = (value: unknown, path: string): string => {
  const result = string(value, path);
  if (result.trim() === "") return failShape(`${path} must be nonempty`);
  return result;
};
const optionalString = (value: unknown, path: string): string | undefined =>
  value === undefined ? undefined : string(value, path);
const boolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") return failShape(`${path} must be a boolean`);
  return value;
};
const number = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    return failShape(`${path} must be a number`);
  return value;
};
const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) return failShape(`${path} must be an array`);
  return value;
};
const strings = (value: unknown, path: string): readonly string[] =>
  array(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
const isPlanAction = (value: string): value is Chunk2PlanAction =>
  ["create", "noop", "update", "replace", "delete"].includes(value);
const isApplyAction = (value: string): value is Exclude<Chunk2PlanAction, "delete"> =>
  ["create", "noop", "update", "replace"].includes(value);
const isTaskAction = (value: string): value is Chunk2TaskAction =>
  value === "run" || value === "noop";
const isBindingAction = (value: string): value is Chunk2BindingAction =>
  ["create", "noop", "update", "delete"].includes(value);
const isSecretBindingName = (value: string): value is Chunk2SecretBindingName =>
  CHUNK2_SECRET_RESOURCES.some(({ bindingName }) => bindingName === value);

const normalizeBinding = (value: unknown, path: string): Chunk2NormalizedWorkerBinding => {
  const input = decodeShape(
    decodeBindingInput,
    value,
    path,
    `${path} has missing or unknown fields`,
  );
  const className = optionalString(input.className, `${path}.className`);
  const namespaceId = optionalString(input.namespaceId, `${path}.namespaceId`);
  const bucketName = optionalString(input.bucketName, `${path}.bucketName`);
  const bindingValue = optionalString(input.value, `${path}.value`);
  const storeId = optionalString(input.storeId, `${path}.storeId`);
  const secretName = optionalString(input.secretName, `${path}.secretName`);
  return {
    type: string(input.type, `${path}.type`),
    name: string(input.name, `${path}.name`),
    ...(className === undefined ? {} : { className }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(bucketName === undefined ? {} : { bucketName }),
    ...(bindingValue === undefined ? {} : { value: bindingValue }),
    ...(storeId === undefined ? {} : { storeId }),
    ...(secretName === undefined ? {} : { secretName }),
  };
};

const normalizeMigrations = (value: unknown, path: string): Chunk2WorkerMigrationOperations => {
  const input = decodeShape(
    decodeMigrationInput,
    value,
    path,
    `${path} has missing or unknown fields`,
  );
  const renamedClasses = array(input.renamedClasses, `${path}.renamedClasses`).map(
    (entry, index) => {
      const rowPath = `${path}.renamedClasses[${index}]`;
      const row = decodeShape(decodeRenamedClassInput, entry, rowPath, `${rowPath} is malformed`);
      return { from: string(row.from, `${path}.from`), to: string(row.to, `${path}.to`) };
    },
  );
  const transferredClasses = array(input.transferredClasses, `${path}.transferredClasses`).map(
    (entry, index) => {
      const rowPath = `${path}.transferredClasses[${index}]`;
      const row = decodeShape(
        decodeTransferredClassInput,
        entry,
        rowPath,
        `${rowPath} is malformed`,
      );
      return {
        from: string(row.from, `${path}.from`),
        to: string(row.to, `${path}.to`),
        fromScript: string(row.fromScript, `${path}.fromScript`),
      };
    },
  );
  return {
    newClasses: strings(input.newClasses, `${path}.newClasses`),
    newSqliteClasses: strings(input.newSqliteClasses, `${path}.newSqliteClasses`),
    deletedClasses: strings(input.deletedClasses, `${path}.deletedClasses`),
    renamedClasses,
    transferredClasses,
  };
};

const normalizePolicy = (value: unknown, path: string): Chunk2R2PolicyDetails => {
  const input = decodeShape(
    decodePolicyInput,
    value,
    path,
    `${path} has missing or unknown fields`,
  );
  const lifecycleRules = array(input.lifecycleRules, `${path}.lifecycleRules`).map(
    (entry, index) => {
      const rowPath = `${path}.lifecycleRules[${index}]`;
      const row = decodeShape(decodeLifecycleRuleInput, entry, rowPath, `${rowPath} is malformed`);
      return {
        id: string(row.id, `${path}.id`),
        enabled: boolean(row.enabled, `${path}.enabled`),
        conditions: string(row.conditions, `${path}.conditions`),
        actions: string(row.actions, `${path}.actions`),
      };
    },
  );
  const corsRules = array(input.corsRules, `${path}.corsRules`).map((entry, index) => {
    const rowPath = `${path}.corsRules[${index}]`;
    const row = decodeShape(decodeCorsRuleInput, entry, rowPath, `${rowPath} is malformed`);
    return {
      allowedOrigins: strings(row.allowedOrigins, `${path}.allowedOrigins`),
      allowedMethods: strings(row.allowedMethods, `${path}.allowedMethods`),
      allowedHeaders: strings(row.allowedHeaders, `${path}.allowedHeaders`),
      exposedHeaders: strings(row.exposedHeaders, `${path}.exposedHeaders`),
      maxAgeSeconds:
        row.maxAgeSeconds === undefined
          ? undefined
          : number(row.maxAgeSeconds, `${path}.maxAgeSeconds`),
    };
  });
  const customDomains = array(input.customDomains, `${path}.customDomains`).map((entry, index) => {
    const rowPath = `${path}.customDomains[${index}]`;
    const row = decodeShape(decodeCustomDomainInput, entry, rowPath, `${rowPath} is malformed`);
    return {
      domain: string(row.domain, `${path}.domain`),
      enabled: boolean(row.enabled, `${path}.enabled`),
      status: string(row.status, `${path}.status`),
      minimumTls: string(row.minimumTls, `${path}.minimumTls`),
    };
  });
  return {
    lifecycleRules,
    corsRules,
    customDomains,
    location: string(input.location, `${path}.location`),
    storageClass: string(input.storageClass, `${path}.storageClass`),
  };
};

const normalizeTopology = (value: unknown, path: string): Chunk2Topology => {
  const input = decodeShape(
    decodeTopologyInput,
    value,
    path,
    `${path} has missing or unknown fields`,
  );
  const workerPath = `${path}.worker`;
  const worker = decodeShape(
    decodeWorkerInput,
    input.worker,
    workerPath,
    `${workerPath} is malformed`,
  );
  const assetsPath = `${path}.worker.assets`;
  const assets = decodeShape(
    decodeAssetsInput,
    worker.assets,
    assetsPath,
    `${assetsPath} is malformed`,
  );
  const durableObjectPath = `${path}.durableObject`;
  const durableObject = decodeShape(
    decodeDurableObjectInput,
    input.durableObject,
    durableObjectPath,
    `${durableObjectPath} is malformed`,
  );
  const migrations = array(durableObject.migrations, `${path}.durableObject.migrations`).map(
    (entry, index) => {
      const rowPath = `${path}.durableObject.migrations[${index}]`;
      const row = decodeShape(
        decodeDurableObjectMigrationInput,
        entry,
        rowPath,
        `${rowPath} is malformed`,
      );
      return {
        tag: string(row.tag, `${path}.tag`),
        newSqliteClasses: strings(row.newSqliteClasses, `${path}.newSqliteClasses`),
      };
    },
  );
  const containerPath = `${path}.container`;
  const container = decodeShape(
    decodeContainerInput,
    input.container,
    containerPath,
    `${containerPath} is malformed`,
  );
  const kvPath = `${path}.kv`;
  const kv = decodeShape(decodeKvInput, input.kv, kvPath, `${kvPath} is malformed`);
  const r2Path = `${path}.r2`;
  const r2 = decodeShape(decodeR2Input, input.r2, r2Path, `${r2Path} is malformed`);
  return {
    worker: {
      name: string(worker.name, `${path}.worker.name`),
      physicalId: string(worker.physicalId, `${path}.worker.physicalId`),
      entryPoint: string(worker.entryPoint, `${path}.worker.entryPoint`),
      exports: strings(worker.exports, `${path}.worker.exports`),
      compatibilityDate: string(worker.compatibilityDate, `${path}.worker.compatibilityDate`),
      compatibilityFlags: strings(worker.compatibilityFlags, `${path}.worker.compatibilityFlags`),
      observability: boolean(worker.observability, `${path}.worker.observability`),
      routes: strings(worker.routes, `${path}.worker.routes`),
      assets: {
        binding: string(assets.binding, `${path}.assets.binding`),
        directory: string(assets.directory, `${path}.assets.directory`),
        runWorkerFirst: strings(assets.runWorkerFirst, `${path}.assets.runWorkerFirst`),
        htmlHandling: string(assets.htmlHandling, `${path}.assets.htmlHandling`),
        notFoundHandling: string(assets.notFoundHandling, `${path}.assets.notFoundHandling`),
      },
      outputKeys: strings(worker.outputKeys, `${path}.worker.outputKeys`),
      bindings: array(worker.bindings, `${path}.worker.bindings`).map((entry, index) =>
        normalizeBinding(entry, `${path}.worker.bindings[${index}]`),
      ),
    },
    durableObject: {
      binding: string(durableObject.binding, `${path}.durableObject.binding`),
      className: string(durableObject.className, `${path}.durableObject.className`),
      namespaceId: string(durableObject.namespaceId, `${path}.durableObject.namespaceId`),
      hostScript: string(durableObject.hostScript, `${path}.durableObject.hostScript`),
      migrations,
    },
    container: {
      applicationId: string(container.applicationId, `${path}.container.applicationId`),
      applicationName: string(container.applicationName, `${path}.container.applicationName`),
      dockerfile: string(container.dockerfile, `${path}.container.dockerfile`),
      instanceType: string(container.instanceType, `${path}.container.instanceType`),
      maxInstances: number(container.maxInstances, `${path}.container.maxInstances`),
      durableObjectNamespaceId: string(
        container.durableObjectNamespaceId,
        `${path}.container.durableObjectNamespaceId`,
      ),
    },
    kv: {
      binding: string(kv.binding, `${path}.kv.binding`),
      namespaceId: string(kv.namespaceId, `${path}.kv.namespaceId`),
      title: string(kv.title, `${path}.kv.title`),
    },
    r2: {
      binding: string(r2.binding, `${path}.r2.binding`),
      bucketName: string(r2.bucketName, `${path}.r2.bucketName`),
      policy: normalizePolicy(r2.policy, `${path}.r2.policy`),
    },
  };
};

const normalizeSecretProps = (value: unknown, path: string): Chunk2SecretProps => {
  const input = decodeShape(
    decodeSecretPropsInput,
    value,
    path,
    `${path} has missing or unknown fields`,
  );
  const bindingName = string(input.bindingName, `${path}.bindingName`);
  if (!isSecretBindingName(bindingName)) return failShape(`${path}.bindingName is unsupported`);
  const providerVersion = number(input.providerVersion, `${path}.providerVersion`);
  if (providerVersion !== 1) return failShape(`${path}.providerVersion is unsupported`);
  return {
    sourceId: string(input.sourceId, `${path}.sourceId`),
    accountId: string(input.accountId, `${path}.accountId`),
    storeId: string(input.storeId, `${path}.storeId`),
    secretName: string(input.secretName, `${path}.secretName`),
    bindingName,
    providerVersion,
    keyedDigest: string(input.keyedDigest, `${path}.keyedDigest`),
  };
};

const normalizeResource = (value: unknown, path: string): Chunk2PlanResourceReview => {
  const input = decodeShape(
    decodeResourceReviewInput,
    value,
    path,
    `${path} has missing or unknown fields`,
  );
  const identityPath = `${path}.resolvedIdentity`;
  const identity = decodeShape(
    decodeResolvedIdentityInput,
    input.resolvedIdentity,
    identityPath,
    `${identityPath} is malformed`,
  );
  const bindingActions = array(input.bindingActions, `${path}.bindingActions`).map(
    (entry, index) => {
      const rowPath = `${path}.bindingActions[${index}]`;
      const row = decodeShape(decodeBindingActionInput, entry, rowPath, `${rowPath} is malformed`);
      const action = string(row.action, `${path}.bindingActions[${index}].action`);
      if (!isBindingAction(action))
        return failShape(`${path}.bindingActions[${index}].action is unsupported`);
      return {
        sid: nonEmptyString(row.sid, `${path}.bindingActions[${index}].sid`),
        action,
      };
    },
  );
  const action = string(input.action, `${path}.action`);
  if (!isPlanAction(action)) return failShape(`${path}.action is unsupported`);
  const derivationFailures = array(input.derivationFailures, `${path}.derivationFailures`).map(
    (entry, index) => {
      const rowPath = `${path}.derivationFailures[${index}]`;
      const row = decodeShape(
        decodeDerivationFailureInput,
        entry,
        rowPath,
        `${rowPath} is malformed`,
      );
      const transcriptArtifactDigest = string(
        row.transcriptArtifactDigest,
        `${path}.derivationFailures[${index}].transcriptArtifactDigest`,
      );
      if (!/^sha256:[0-9a-f]{64}$/u.test(transcriptArtifactDigest))
        return failShape(
          `${path}.derivationFailures[${index}].transcriptArtifactDigest is malformed`,
        );
      return {
        field: string(row.field, `${path}.derivationFailures[${index}].field`),
        transcriptArtifactDigest,
      };
    },
  );
  const r2LifecycleRulesInput = optionalString(
    input.r2LifecycleRulesInput,
    `${path}.r2LifecycleRulesInput`,
  );
  if (
    r2LifecycleRulesInput !== undefined &&
    r2LifecycleRulesInput !== "omitted" &&
    r2LifecycleRulesInput !== "configured"
  )
    return failShape(`${path}.r2LifecycleRulesInput is unsupported`);
  const secretProps =
    input.secretProps === undefined
      ? undefined
      : normalizeSecretProps(input.secretProps, `${path}.secretProps`);
  const desiredTopology =
    input.desiredTopology === undefined
      ? undefined
      : normalizeTopology(input.desiredTopology, `${path}.desiredTopology`);
  const workerMigrations =
    input.workerMigrations === undefined
      ? undefined
      : normalizeMigrations(input.workerMigrations, `${path}.workerMigrations`);
  const providerRequestEvidence =
    input.providerRequestEvidence === undefined
      ? undefined
      : normalizeProviderEvidence(input.providerRequestEvidence, `${path}.providerRequestEvidence`);
  return {
    fqn: nonEmptyString(input.fqn, `${path}.fqn`),
    logicalId: string(input.logicalId, `${path}.logicalId`),
    resourceType: string(input.resourceType, `${path}.resourceType`),
    action,
    removalPolicy: string(input.removalPolicy, `${path}.removalPolicy`),
    resolvedIdentity: {
      before: optionalString(identity.before, `${path}.before`),
      desired: string(identity.desired, `${path}.desired`),
    },
    changedInputKeys: strings(input.changedInputKeys, `${path}.changedInputKeys`),
    bindingActions,
    derivationFailures,
    ...(secretProps === undefined ? {} : { secretProps }),
    ...(desiredTopology === undefined ? {} : { desiredTopology }),
    ...(workerMigrations === undefined ? {} : { workerMigrations }),
    ...(r2LifecycleRulesInput === undefined ? {} : { r2LifecycleRulesInput }),
    ...(providerRequestEvidence === undefined ? {} : { providerRequestEvidence }),
  };
};

const normalizeProviderEvidence = (value: unknown, path: string): Chunk2ProviderRequestEvidence => {
  const input = decodeShape(decodeProviderEvidenceInput, value, path, `${path} is malformed`);
  const firewallMode = string(input.firewallMode, `${path}.firewallMode`);
  if (firewallMode !== "deny-by-default") return failShape(`${path}.firewallMode is unsupported`);
  const transcriptArtifactDigest = string(
    input.transcriptArtifactDigest,
    `${path}.transcriptArtifactDigest`,
  );
  const reviewedRequestDigests = strings(
    input.reviewedRequestDigests,
    `${path}.reviewedRequestDigests`,
  );
  const observedRequestDigests = strings(
    input.observedRequestDigests,
    `${path}.observedRequestDigests`,
  );
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(transcriptArtifactDigest) ||
    !reviewedRequestDigests.every((digest) => /^sha256:[0-9a-f]{64}$/u.test(digest)) ||
    !observedRequestDigests.every((digest) => /^sha256:[0-9a-f]{64}$/u.test(digest))
  )
    return failShape(`${path} contains a malformed digest`);
  return {
    transcriptArtifactDigest,
    firewallMode,
    reviewedRequestDigests,
    observedRequestDigests,
  };
};

const normalizeCycleMembers = (value: unknown): readonly string[] => {
  const members =
    value instanceof Set
      ? [...value].map((entry, index) => nonEmptyString(entry, `plan.cycleMembers[${index}]`))
      : strings(value, "plan.cycleMembers").map((entry, index) =>
          nonEmptyString(entry, `plan.cycleMembers[${index}]`),
        );
  if (new Set(members).size !== members.length)
    return failShape("plan.cycleMembers must not contain duplicates");
  return members;
};

export function normalizeChunk2Plan(
  input: unknown,
  transcriptInput: unknown,
): Chunk2PlanReviewSnapshot {
  const plan = decodeShape(decodeRawPlanInput, input, "plan", "plan surfaces must be exact");
  const output = decodeShape(
    decodeOutputInput,
    plan.output,
    "plan.output",
    "plan.output must contain only url",
  );
  const resources = entriesOf(plan.resources, "plan.resources");
  const transcript = entriesOf(transcriptInput, "transcript");
  if (
    !sameStrings(
      resources.map(([fqn]) => fqn),
      transcript.map(([fqn]) => fqn),
    )
  )
    return failShape("transcript FQNs must exactly match plan.resources FQNs");
  const transcriptByFqn = new Map(transcript);
  const actions = entriesOf(plan.actions, "plan.actions").map(([fqn, value]) => {
    const rowPath = `plan.actions.${fqn}`;
    const row = decodeShape(decodeRawActionInput, value, rowPath, `${rowPath} is malformed`);
    const action = string(row.action, `plan.actions.${fqn}.action`);
    if (!isTaskAction(action)) return failShape(`plan.actions.${fqn}.action is unsupported`);
    return { fqn: nonEmptyString(fqn, "plan action FQN"), action };
  });
  const deletions = entriesOf(plan.deletions, "plan.deletions").map(([fqn, value]) => {
    const rowPath = `plan.deletions.${fqn}`;
    const row = decodeShape(decodeRawDeletionInput, value, rowPath, `${rowPath} is malformed`);
    const resourcePath = `plan.deletions.${fqn}.resource`;
    const resource = decodeShape(
      decodeRawDeletionResourceInput,
      row.resource,
      resourcePath,
      `${resourcePath} is malformed`,
    );
    if (row.action !== "delete") return failShape(`plan.deletions.${fqn}.action is unsupported`);
    return {
      fqn: nonEmptyString(fqn, "plan deletion FQN"),
      logicalId: nonEmptyString(resource.LogicalId, `plan.deletions.${fqn}.resource.LogicalId`),
      resourceType: nonEmptyString(resource.Type, `plan.deletions.${fqn}.resource.Type`),
      action: "delete" as const,
    };
  });
  const actionDeletions = entriesOf(plan.actionDeletions, "plan.actionDeletions").map(
    ([fqn, value]) => {
      const rowPath = `plan.actionDeletions.${fqn}`;
      const row = decodeShape(
        decodeRawActionDeletionInput,
        value,
        rowPath,
        `${rowPath} is malformed`,
      );
      if (row.action !== "delete")
        return failShape(`plan.actionDeletions.${fqn}.action is unsupported`);
      const definitionPath = `plan.actionDeletions.${fqn}.def`;
      const definition = decodeShape(
        decodeRawActionDefinitionInput,
        row.def,
        definitionPath,
        `${definitionPath} is malformed`,
      );
      return {
        fqn: nonEmptyString(fqn, "plan action deletion FQN"),
        logicalId: nonEmptyString(
          definition.LogicalId,
          `plan.actionDeletions.${fqn}.def.LogicalId`,
        ),
        action: "delete" as const,
      };
    },
  );
  return {
    resources: resources.map(([fqn, value]) => {
      const nodePath = `plan.resources.${fqn}`;
      const node = decodeShape(
        decodeRawResourceNodeInput,
        value,
        nodePath,
        `${nodePath} is malformed`,
      );
      const resourcePath = `plan.resources.${fqn}.resource`;
      const resource = decodeShape(
        decodeRawResourceInput,
        node.resource,
        resourcePath,
        `${resourcePath} is malformed`,
      );
      const action = string(node.action, `plan.resources.${fqn}.action`);
      if (!isApplyAction(action)) return failShape(`plan.resources.${fqn}.action is unsupported`);
      const bindingActions = array(node.bindings, `plan.resources.${fqn}.bindings`).map(
        (binding, index) => {
          const rowPath = `plan.resources.${fqn}.bindings[${index}]`;
          const row = decodeShape(
            decodeRawBindingInput,
            binding,
            rowPath,
            `${rowPath} is malformed`,
          );
          return { sid: row.sid, action: row.action };
        },
      );
      return normalizeResource(
        Object.fromEntries([
          ...entriesOf(transcriptByFqn.get(fqn), `transcript.${fqn}`),
          ["fqn", fqn],
          ["logicalId", resource.LogicalId],
          ["resourceType", resource.Type],
          ["removalPolicy", resource.RemovalPolicy],
          ["action", action],
          ["bindingActions", bindingActions],
        ]),
        `review.${fqn}`,
      );
    }),
    actions,
    deletions,
    actionDeletions,
    output: { url: output.url },
    cycleMembers: normalizeCycleMembers(plan.cycleMembers),
  };
}

const canonicalBindings = (bindings: readonly Chunk2NormalizedWorkerBinding[]) =>
  [...bindings].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
  );
const canonicalPolicy = (policy: Chunk2R2PolicyDetails): Chunk2R2PolicyDetails => ({
  ...policy,
  lifecycleRules: [...policy.lifecycleRules].sort((left, right) => left.id.localeCompare(right.id)),
  customDomains: [...policy.customDomains].sort((left, right) =>
    left.domain.localeCompare(right.domain),
  ),
  corsRules: policy.corsRules
    .map((rule) => ({
      ...rule,
      allowedOrigins: sorted(rule.allowedOrigins),
      allowedMethods: sorted(rule.allowedMethods),
      allowedHeaders: sorted(rule.allowedHeaders),
      exposedHeaders: sorted(rule.exposedHeaders),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
});
const canonicalTopology = (topology: Chunk2Topology): Chunk2Topology => ({
  durableObject: topology.durableObject,
  container: topology.container,
  kv: topology.kv,
  worker: {
    ...topology.worker,
    exports: sorted(topology.worker.exports),
    compatibilityFlags: sorted(topology.worker.compatibilityFlags),
    routes: sorted(topology.worker.routes),
    assets: {
      ...topology.worker.assets,
      runWorkerFirst: sorted(topology.worker.assets.runWorkerFirst),
    },
    outputKeys: sorted(topology.worker.outputKeys),
    bindings: canonicalBindings(topology.worker.bindings),
  },
  r2: { ...topology.r2, policy: canonicalPolicy(topology.r2.policy) },
});
const sameTopology = (left: Chunk2Topology, right: Chunk2Topology): boolean =>
  sameOrdered(canonicalTopology(left), canonicalTopology(right));
const emptyMigrations = (): Chunk2WorkerMigrationOperations => ({
  newClasses: [],
  newSqliteClasses: [],
  deletedClasses: [],
  renamedClasses: [],
  transferredClasses: [],
});

const expectedEdges = new Map<string, readonly string[]>([
  ["MonolithWorker", ["SandboxContainer"]],
  ["SandboxContainer", ["Sandbox"]],
  ["SessionsProjection", []],
  ["BackupBucket", []],
  ["CodexAuthSecret", []],
  ["GithubTokenSecret", []],
  ["ScottyTokenSecret", []],
]);

const exactRecordKeys = (value: object, expected: readonly string[]): boolean =>
  sameStrings(Object.keys(value), expected) && Object.keys(value).length === expected.length;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const isSha256Digest = (value: unknown): value is string =>
  typeof value === "string" && SHA256_DIGEST.test(value);

export function chunk2InventoryBlockers(
  inventory: Chunk2LiveInventory | undefined,
): readonly Chunk2Blocker[] {
  if (inventory === undefined)
    return [blocker("B1_FOREIGN_ADOPTION_UNPROVEN", "Read-only live inventory is required.")];
  const blockers: Chunk2Blocker[] = [];
  const expected = CHUNK2_WRANGLER_PARITY;
  if (
    inventory.alchemyVersion !== CHUNK2_ALCHEMY_VERSION ||
    inventory.worker.name !== expected.worker.name ||
    missing(inventory.worker.physicalId)
  )
    blockers.push(
      blocker(
        "B1_FOREIGN_ADOPTION_UNPROVEN",
        "The exact named Worker identity must be inventoried.",
      ),
    );
  if (
    !sameOrdered(inventory.durableObject.migrations, [
      { tag: "v1", newSqliteClasses: ["ScottySandbox"] },
    ]) ||
    inventory.durableObject.binding !== expected.durableObject.binding ||
    inventory.durableObject.className !== expected.durableObject.className ||
    inventory.durableObject.hostScript !== expected.worker.name ||
    missing(inventory.durableObject.namespaceId)
  )
    blockers.push(
      blocker("B2_SQLITE_MIGRATION_UNPROVEN", "The external v1 SQLite namespace must be exact."),
    );
  if (
    missing(inventory.container.applicationId) ||
    inventory.container.applicationName !== expected.container.expectedWranglerName ||
    inventory.container.dockerfile !== expected.container.dockerfile ||
    inventory.container.instanceType !== expected.container.instanceType ||
    inventory.container.maxInstances !== expected.container.maxInstances ||
    inventory.container.durableObjectNamespaceId !== inventory.durableObject.namespaceId
  )
    blockers.push(
      blocker("B4_CONTAINER_IDENTITY_UNPROVEN", "Container topology or DO association differs."),
    );
  if (
    inventory.kv.binding !== expected.kv.binding ||
    missing(inventory.kv.namespaceId) ||
    missing(inventory.kv.title)
  )
    blockers.push(blocker("B5_KV_IDENTITY_MISSING", "The exact KV UUID and title are required."));
  if (
    inventory.r2.binding !== expected.r2.binding ||
    inventory.r2.bucketName !== expected.r2.bucketName ||
    missing(inventory.r2.policy.location) ||
    missing(inventory.r2.policy.storageClass)
  )
    blockers.push(blocker("B6_R2_POLICY_UNCONFIRMED", "Complete R2 policy is required."));
  const currentSecrets = inventory.worker.bindings
    .filter(({ type }) => type === "secret_text")
    .map(({ name }) => name);
  if (
    !sameStrings(
      currentSecrets,
      CHUNK2_SECRET_RESOURCES.map(({ bindingName }) => bindingName),
    )
  )
    blockers.push(
      blocker(
        "SECRET_CONTINUITY_UNPROVEN",
        "The current Worker must retain all required secret_text bindings.",
      ),
    );
  return blockers;
}

const observedRecordValid = (
  value: object,
  keys: readonly string[],
  expected: Readonly<Record<string, string>>,
): boolean =>
  exactRecordKeys(value, keys) &&
  keys.every((key) => {
    const entry = Object.getOwnPropertyDescriptor(value, key)?.value;
    const decoded = decodeObservedValueInput(entry);
    return (
      Option.isSome(decoded) &&
      decoded.value.before === expected[key] &&
      decoded.value.after === expected[key]
    );
  });

export function chunk2CloneEvidenceBlockers(
  inventory: Chunk2LiveInventory | undefined,
  evidence: Chunk2CloneEvidence | undefined,
  disclosureMarkers: Chunk2CloneEvidence["disclosureScan"]["markers"],
): readonly Chunk2Blocker[] {
  if (inventory === undefined || evidence === undefined)
    return [
      blocker("CLONE_PHYSICAL_IDENTITY_CHANGED", "Structured clone evidence is required."),
      blocker("DISCLOSURE_SCAN_INVALID", "Disclosure evidence is required."),
    ];
  const blockers: Chunk2Blocker[] = [];
  const physicalKeys = ["worker", "durableObject", "container", "kv", "r2"];
  const expectedIds: Readonly<Record<string, string>> = {
    worker: inventory.worker.physicalId,
    durableObject: inventory.durableObject.namespaceId,
    container: inventory.container.applicationId,
    kv: inventory.kv.namespaceId,
    r2: inventory.r2.bucketName,
  };
  if (!observedRecordValid(evidence.physicalIds, physicalKeys, expectedIds))
    blockers.push(
      blocker(
        "CLONE_PHYSICAL_IDENTITY_CHANGED",
        "Physical ID evidence must have exact keys and equal before/after values.",
      ),
    );
  const digestKeys = ["session", "lease", "credential", "schedule", "kvProjection", "r2Backup"];
  if (
    !exactRecordKeys(evidence.seededDigests, digestKeys) ||
    digestKeys.some((key) => {
      const entry = Object.getOwnPropertyDescriptor(evidence.seededDigests, key)?.value;
      const decoded = decodeObservedValueInput(entry);
      return (
        Option.isNone(decoded) ||
        !isSha256Digest(decoded.value.before) ||
        !isSha256Digest(decoded.value.after) ||
        decoded.value.before !== decoded.value.after
      );
    })
  )
    blockers.push(
      blocker(
        "CLONE_SEEDED_STATE_CHANGED",
        "Seed digest evidence must have exact keys and equal before/after values.",
      ),
    );
  if (
    !sameTopology(evidence.observedTopology.before, inventory) ||
    !sameTopology(evidence.observedTopology.after, inventory)
  )
    blockers.push(
      blocker(
        "PLAN_TOPOLOGY_INVALID",
        "Observed before/after topology must preserve the full Wrangler topology.",
      ),
    );
  if (!sameOrdered(evidence.outgoingWorkerMigrations, emptyMigrations()))
    blockers.push(
      blocker("PLAN_WORKER_MIGRATIONS_INVALID", "No Worker migration operation may be emitted."),
    );
  const expectedRows = CHUNK2_PROTECTED_RESOURCES.map(({ logicalId, resourceType }) => ({
    logicalId,
    resourceType,
    removalPolicy: "retain",
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  const actualRows = [...evidence.persistedRetainRows].sort((left, right) =>
    left.logicalId.localeCompare(right.logicalId),
  );
  if (!sameOrdered(actualRows, expectedRows))
    blockers.push(blocker("B3_RETENTION_PERSISTENCE_UNPROVEN", "Exact retain rows must persist."));
  const refs = [...evidence.activeSecretReferences].sort((left, right) =>
    left.bindingName.localeCompare(right.bindingName),
  );
  const uniqueRefs = new Set(refs.map(({ bindingName }) => bindingName));
  if (
    refs.length !== CHUNK2_SECRET_RESOURCES.length ||
    uniqueRefs.size !== CHUNK2_SECRET_RESOURCES.length ||
    refs.some((reference) => {
      const expected = CHUNK2_SECRET_RESOURCES.find(
        ({ bindingName }) => bindingName === reference.bindingName,
      );
      return (
        expected === undefined ||
        reference.sourceId !== expected.sourceId ||
        missing(reference.physicalId) ||
        missing(reference.accountId) ||
        missing(reference.storeId) ||
        missing(reference.secretName) ||
        reference.providerVersion !== 1 ||
        missing(reference.keyedDigest)
      );
    })
  )
    blockers.push(
      blocker(
        "SECRET_CONTINUITY_UNPROVEN",
        "Active secret evidence must be exact and keyed by bindingName.",
      ),
    );
  if (
    !exactRecordKeys(evidence.postDestroyPhysicalIds, physicalKeys) ||
    physicalKeys.some(
      (key) =>
        Object.getOwnPropertyDescriptor(evidence.postDestroyPhysicalIds, key)?.value !==
        expectedIds[key],
    )
  )
    blockers.push(
      blocker(
        "CLONE_DESTROY_REMOVED_RESOURCE",
        "Post-destroy IDs must have exact keys and preserve every resource.",
      ),
    );
  const decodedMarkers = decodeDisclosureMarkersInput(disclosureMarkers);
  const markerShapeValid = Option.isSome(decodedMarkers);
  const markerValues = markerShapeValid
    ? [decodedMarkers.value.plaintext, decodedMarkers.value.ownerKey]
    : [];
  const artifacts = [...evidence.disclosureScan.artifacts].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const expectedArtifacts = [...CHUNK2_SCAN_ARTIFACTS].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (
    !markerShapeValid ||
    markerValues.length !== 2 ||
    markerValues.some((marker) => marker.trim().length < 16) ||
    markerValues[0] === markerValues[1] ||
    !sameOrdered(evidence.disclosureScan.markers, disclosureMarkers) ||
    evidence.disclosureScan.matches.length !== 0 ||
    artifacts.length !== CHUNK2_SCAN_ARTIFACTS.length ||
    new Set(artifacts.map(({ id }) => id)).size !== artifacts.length ||
    new Set(artifacts.map(({ kind }) => kind)).size !== artifacts.length ||
    !sameOrdered(
      artifacts.map(({ id, kind }) => ({ id, kind })),
      expectedArtifacts,
    ) ||
    artifacts.some(({ digest, scanResult }) => !isSha256Digest(digest) || scanResult !== "clean")
  )
    blockers.push(
      blocker(
        "DISCLOSURE_SCAN_INVALID",
        "Exactly two labeled markers and clean, SHA-256-digested reviewed-plan/second-plan/state/log/output/bundle scans are required.",
      ),
    );
  return blockers;
}

const workerBindingsValid = (
  bindings: readonly Chunk2NormalizedWorkerBinding[],
  inventory: Chunk2LiveInventory,
): boolean => {
  const expected = inventory.worker.bindings;
  return (
    bindings.length === expected.length &&
    new Set(bindings.map(({ type, name }) => `${type}:${name}`)).size === bindings.length &&
    sameOrdered(canonicalBindings(bindings), canonicalBindings(expected))
  );
};
const providerEvidenceValid = (evidence: Chunk2ProviderRequestEvidence | undefined): boolean =>
  evidence !== undefined &&
  isSha256Digest(evidence.transcriptArtifactDigest) &&
  evidence.firewallMode === "deny-by-default" &&
  evidence.reviewedRequestDigests.length > 0 &&
  evidence.reviewedRequestDigests.every(isSha256Digest) &&
  evidence.observedRequestDigests.every(isSha256Digest) &&
  sameStrings(evidence.reviewedRequestDigests, evidence.observedRequestDigests);

export function chunk2PlanReviewBlockers(
  snapshot: Chunk2PlanReviewSnapshot | undefined,
  inventory: Chunk2LiveInventory | undefined,
  evidence: Chunk2CloneEvidence | undefined,
  disclosureMarkers: Chunk2CloneEvidence["disclosureScan"]["markers"],
  phase: "reviewed" | "second",
): readonly Chunk2Blocker[] {
  if (snapshot === undefined || inventory === undefined || evidence === undefined)
    return [blocker("PLAN_RESOURCE_SET_INVALID", `${phase} plan snapshot is required.`)];
  const blockers: Chunk2Blocker[] = [];
  const expectedIds = new Set<string>(CHUNK2_PROTECTED_RESOURCES.map(({ logicalId }) => logicalId));
  const actualIds = snapshot.resources.map(({ logicalId }) => logicalId);
  if (
    actualIds.length !== expectedIds.size ||
    new Set(actualIds).size !== actualIds.length ||
    actualIds.some((id) => !expectedIds.has(id))
  )
    blockers.push(blocker("PLAN_RESOURCE_SET_INVALID", "Plan resource membership must be exact."));
  if (snapshot.actions.length !== 0)
    blockers.push(blocker("PLAN_ACTIVE_ACTION_PRESENT", "Active actions must be empty."));
  if (snapshot.deletions.length !== 0)
    blockers.push(blocker("PLAN_DELETION_PRESENT", "Resource deletions must be empty."));
  if (snapshot.actionDeletions.length !== 0)
    blockers.push(blocker("PLAN_ACTION_DELETION_PRESENT", "Action deletions must be empty."));
  if (!exactRecordKeys(snapshot.output, ["url"]) || snapshot.output.url === undefined)
    blockers.push(
      blocker("PLAN_OUTPUT_INVALID", "Plan output must contain exactly the url expression."),
    );
  if (snapshot.cycleMembers.length !== 0)
    blockers.push(
      blocker(
        "PLAN_CYCLE_MEMBERS_PRESENT",
        "The adoption plan must not contain dependency cycle members.",
      ),
    );
  const expectedTypes = new Map<string, string>(
    CHUNK2_PROTECTED_RESOURCES.map(({ logicalId, resourceType }) => [logicalId, resourceType]),
  );
  const adoptedIds = new Map<string, string>([
    ["MonolithWorker", inventory.worker.physicalId],
    ["SandboxContainer", inventory.container.applicationId],
    ["SessionsProjection", inventory.kv.namespaceId],
    ["BackupBucket", inventory.r2.bucketName],
  ]);
  for (const resource of snapshot.resources) {
    if (resource.resourceType !== expectedTypes.get(resource.logicalId))
      blockers.push(
        blocker("PLAN_RESOURCE_TYPE_INVALID", `${resource.logicalId} has an unexpected type.`),
      );
    const secret = CHUNK2_SECRET_RESOURCES.find(
      ({ logicalId }) => logicalId === resource.logicalId,
    );
    const allowed = secret !== undefined && phase === "reviewed" ? ["create", "noop"] : ["noop"];
    if (!allowed.includes(resource.action))
      blockers.push(
        blocker("PLAN_ACTION_INVALID", `${resource.logicalId} may not plan ${resource.action}.`),
      );
    if (missing(resource.resolvedIdentity.desired))
      blockers.push(
        blocker("PLAN_IDENTITY_UNRESOLVED", `${resource.logicalId} identity is unresolved.`),
      );
    if (resource.action === "create" && resource.resolvedIdentity.before !== undefined)
      blockers.push(
        blocker(
          "PLAN_IDENTITY_CHANGED",
          `${resource.logicalId} create must have no before identity.`,
        ),
      );
    if (
      resource.action === "noop" &&
      (resource.resolvedIdentity.before !== resource.resolvedIdentity.desired ||
        (adoptedIds.has(resource.logicalId) &&
          resource.resolvedIdentity.desired !== adoptedIds.get(resource.logicalId)))
    )
      blockers.push(
        blocker("PLAN_IDENTITY_CHANGED", `${resource.logicalId} noop identity must be preserved.`),
      );
    if (resource.changedInputKeys.length !== 0)
      blockers.push(
        blocker("PLAN_CHANGED_INPUT_KEYS", `${resource.logicalId} has changed inputs.`),
      );
    if (resource.removalPolicy !== "retain")
      blockers.push(blocker("PLAN_REMOVAL_POLICY_INVALID", `${resource.logicalId} must retain.`));
    if (resource.derivationFailures.length !== 0)
      blockers.push(
        blocker(
          "PLAN_SHAPE_INVALID",
          `${resource.logicalId} has fields that could not be derived from the Plan transcript.`,
        ),
      );
    const stableIds = resource.bindingActions.map(({ sid }) => sid);
    const expectedStableIds = expectedEdges.get(resource.logicalId) ?? [];
    if (
      stableIds.some(missing) ||
      stableIds.length !== new Set(stableIds).size ||
      !sameStrings(stableIds, expectedStableIds) ||
      resource.bindingActions.some(({ action }) => action !== "noop")
    )
      blockers.push(
        blocker(
          "PLAN_BINDING_ACTION_INVALID",
          `${resource.logicalId} binding edge membership/actions must be exact.`,
        ),
      );
    if (
      CHUNK2_ADOPTED_RESOURCES.some(({ logicalId }) => logicalId === resource.logicalId) &&
      resource.action === "update" &&
      !providerEvidenceValid(resource.providerRequestEvidence)
    )
      blockers.push(
        blocker(
          "PLAN_PROVIDER_FIREWALL_INVALID",
          `${resource.logicalId} update lacks transcript/firewall proof.`,
        ),
      );
    if (secret !== undefined) {
      const reference = evidence.activeSecretReferences.find(
        ({ bindingName }) => bindingName === secret.bindingName,
      );
      if (
        resource.secretProps === undefined ||
        reference === undefined ||
        !sameOrdered(resource.secretProps, {
          sourceId: reference.sourceId,
          accountId: reference.accountId,
          storeId: reference.storeId,
          secretName: reference.secretName,
          bindingName: reference.bindingName,
          providerVersion: reference.providerVersion,
          keyedDigest: reference.keyedDigest,
        }) ||
        resource.resolvedIdentity.desired !== reference.physicalId
      )
        blockers.push(
          blocker(
            "PLAN_SECRET_PROPS_INVALID",
            `${resource.logicalId} secret identity/metadata must match active evidence.`,
          ),
        );
    }
    if (resource.logicalId === "BackupBucket" && resource.r2LifecycleRulesInput !== "omitted")
      blockers.push(
        blocker("B6_R2_POLICY_UNCONFIRMED", "R2 lifecycleRules must be omitted during adoption."),
      );
  }
  const worker = snapshot.resources.find(({ logicalId }) => logicalId === "MonolithWorker");
  if (
    worker?.desiredTopology === undefined ||
    !sameTopology(worker.desiredTopology, inventory) ||
    !sameTopology(worker.desiredTopology, evidence.observedTopology.after)
  )
    blockers.push(
      blocker(
        "PLAN_TOPOLOGY_INVALID",
        "Before, plan desired, and observed-after topology must match exactly.",
      ),
    );
  if (!sameOrdered(worker?.workerMigrations, emptyMigrations()))
    blockers.push(
      blocker(
        "PLAN_WORKER_MIGRATIONS_INVALID",
        "Worker migration operations must remain empty and ordered.",
      ),
    );
  if (
    worker?.desiredTopology === undefined ||
    !workerBindingsValid(worker.desiredTopology.worker.bindings, inventory)
  )
    blockers.push(
      blocker(
        "PLAN_WORKER_BINDINGS_INVALID",
        "A noop Worker must preserve the exact current binding types and membership.",
      ),
    );
  const serialized = JSON.stringify({
    resources: snapshot.resources,
    actions: snapshot.actions,
    output: snapshot.output,
  });
  if (
    [disclosureMarkers.plaintext, disclosureMarkers.ownerKey].some(
      (marker) => marker !== "" && serialized.includes(marker),
    )
  )
    blockers.push(
      blocker(
        "PLAN_DISCLOSURE_MARKER_FOUND",
        "A disclosure marker appears in plan resources/actions/output.",
      ),
    );
  return blockers;
}

const correlatePlans = (
  reviewed: Chunk2PlanReviewSnapshot | undefined,
  second: Chunk2PlanReviewSnapshot | undefined,
): readonly Chunk2Blocker[] => {
  if (reviewed === undefined || second === undefined) return [];
  const blockers: Chunk2Blocker[] = [];
  for (const secret of CHUNK2_SECRET_RESOURCES) {
    const first = reviewed.resources.find(({ logicalId }) => logicalId === secret.logicalId);
    const next = second.resources.find(({ logicalId }) => logicalId === secret.logicalId);
    if (
      first === undefined ||
      next === undefined ||
      next.action !== "noop" ||
      next.resolvedIdentity.before !== first.resolvedIdentity.desired ||
      next.resolvedIdentity.desired !== first.resolvedIdentity.desired ||
      !sameOrdered(next.secretProps, first.secretProps)
    )
      blockers.push(
        blocker(
          "PLAN_SECRET_CORRELATION_INVALID",
          `${secret.logicalId} changed between reviewed and second plans.`,
        ),
      );
  }
  return blockers;
};

export function chunk2ReadinessBlockers(
  inventory: Chunk2LiveInventory | undefined,
  evidence: Chunk2CloneEvidence | undefined,
  reviewedPlan: Chunk2PlanReviewSnapshot | undefined,
  secondPlan: Chunk2PlanReviewSnapshot | undefined,
  disclosureMarkers: Chunk2CloneEvidence["disclosureScan"]["markers"],
): readonly Chunk2Blocker[] {
  return [
    ...chunk2InventoryBlockers(inventory),
    ...chunk2CloneEvidenceBlockers(inventory, evidence, disclosureMarkers),
    ...chunk2PlanReviewBlockers(reviewedPlan, inventory, evidence, disclosureMarkers, "reviewed"),
    ...chunk2PlanReviewBlockers(secondPlan, inventory, evidence, disclosureMarkers, "second"),
    ...correlatePlans(reviewedPlan, secondPlan),
    blocker(
      "B4_CONTAINER_IDENTITY_UNPROVEN",
      "Pinned beta.63 cold adoption cannot preserve the existing Container association safely.",
    ),
  ];
}

export function assertChunk2ReadOnlyPlan(
  input: unknown,
  transcript: unknown,
  inventory: Chunk2LiveInventory,
  evidence: Chunk2CloneEvidence,
  disclosureMarkers: Chunk2CloneEvidence["disclosureScan"]["markers"],
  phase: "reviewed" | "second" = "reviewed",
): void {
  const blockers = chunk2PlanReviewBlockers(
    normalizeChunk2Plan(input, transcript),
    inventory,
    evidence,
    disclosureMarkers,
    phase,
  );
  if (blockers.length > 0)
    throw new Chunk2ReadinessError(blockers.map(({ code }) => code).join(", "));
}

export function assertChunk2Ready(
  inventory: Chunk2LiveInventory | undefined,
  evidence: Chunk2CloneEvidence | undefined,
  reviewedInput: unknown,
  reviewedTranscript: unknown,
  secondInput: unknown,
  secondTranscript: unknown,
  disclosureMarkers: Chunk2CloneEvidence["disclosureScan"]["markers"],
): void {
  const reviewed = normalizeChunk2Plan(reviewedInput, reviewedTranscript);
  const second = normalizeChunk2Plan(secondInput, secondTranscript);
  const blockers = chunk2ReadinessBlockers(
    inventory,
    evidence,
    reviewed,
    second,
    disclosureMarkers,
  );
  if (blockers.length > 0)
    throw new Chunk2ReadinessError(
      `Chunk 2 adoption blocked: ${blockers.map(({ code }) => code).join(", ")}.`,
    );
}
