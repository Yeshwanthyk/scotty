import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { bindExternalSandboxContainer } from "./external-sandbox-container-binding.ts";

export const M01C_STACK_NAME = "ScottyM01CSandboxCanary";
export const M01C_STAGE_PREFIX = "m01c-canary-";
export const M01C_DEPLOY_APPROVAL = "SCOTTY_M01C_APPROVE_DEPLOY";
export const M01C_CLEANUP_APPROVAL = "SCOTTY_M01C_APPROVE_CLEANUP";
export const M01C_PUBLIC_EXTENSION_REQUIRED = true;
export const M01C_ACCOUNT_SECRET_MAX_BYTES = 1024;

const syntheticNamePrefix = "scotty-m01c-disposable";
const compatibilityDate = "2026-07-20";

export interface M01CCanaryConfig {
  readonly stage: string;
  readonly deployApproval: string | undefined;
  readonly cleanupApproval: string | undefined;
  readonly armCleanup: boolean;
  readonly telemetryDisabled: boolean;
  readonly pinnedSafetyExtensionsReady: boolean;
}

export interface M01CCanaryNames {
  readonly worker: string;
  readonly container: string;
  readonly sessions: string;
  readonly backups: string;
}

/** Metadata-only input for the deferred Account Secrets Store provider. */
export interface M01CAccountSecretReference {
  readonly sourceId: string;
  readonly storeId: string;
  readonly secretId: string;
  readonly secretName: string;
  readonly bindingName: string;
  readonly providerVersion: number;
  readonly keyedDigest: string;
  readonly expectedOwnerMarker: string;
}

export interface M01CAccountSecretBinding {
  readonly type: "secrets_store_secret";
  readonly name: string;
  readonly store_id: string;
  readonly secret_name: string;
}

export const m01cAccountSecretBinding = (
  reference: M01CAccountSecretReference,
): M01CAccountSecretBinding => ({
  type: "secrets_store_secret",
  name: reference.bindingName,
  store_id: reference.storeId,
  secret_name: reference.secretName,
});

export type M01CLiveStatus = "unverified-live";

export interface M01CLiveAssertion {
  readonly id:
    | "command"
    | "files"
    | "named-session"
    | "pty-websocket"
    | "backup-restore"
    | "lifecycle-callbacks"
    | "outbound-interception"
    | "do-reconstruction"
    | "idempotent-plan"
    | "guarded-cleanup";
  readonly status: M01CLiveStatus;
  readonly assertion: string;
}

export const M01C_LIVE_ASSERTIONS: readonly M01CLiveAssertion[] = [
  {
    id: "command",
    status: "unverified-live",
    assertion: "The official SDK executes a fixed command in the deployed container.",
  },
  {
    id: "files",
    status: "unverified-live",
    assertion: "File write/read/rename/delete operations round-trip under /tmp/m01c-canary.",
  },
  {
    id: "named-session",
    status: "unverified-live",
    assertion: "A named execution session preserves cwd and environment between commands.",
  },
  {
    id: "pty-websocket",
    status: "unverified-live",
    assertion: "The native terminal callback upgrades, exchanges binary data, and reconnects.",
  },
  {
    id: "backup-restore",
    status: "unverified-live",
    assertion:
      "The credential-less binding-backed R2 backup path preserves completed writes; the production presigned path remains a separate M01B-gated assertion.",
  },
  {
    id: "lifecycle-callbacks",
    status: "unverified-live",
    assertion: "onStart, onStop, and activity-expiry callbacks retain their native SDK behavior.",
  },
  {
    id: "outbound-interception",
    status: "unverified-live",
    assertion:
      "A fixed allowlisted unauthenticated request succeeds and the catch-all outbound policy denies an unlisted host.",
  },
  {
    id: "do-reconstruction",
    status: "unverified-live",
    assertion: "A synthetic DO storage marker survives runtime stop and host reconstruction.",
  },
  {
    id: "idempotent-plan",
    status: "unverified-live",
    assertion: "The normalized second Alchemy plan contains only no-op resource actions.",
  },
  {
    id: "guarded-cleanup",
    status: "unverified-live",
    assertion: "Explicitly armed cleanup removes only this isolated synthetic stage.",
  },
] as const;

export const expectedDeployApproval = (stage: string): string => `deploy:${stage}`;

export const expectedCleanupApproval = (stage: string): string => `destroy:${stage}:disposable`;

export function assertM01CCanaryConfig(config: M01CCanaryConfig): void {
  if (
    !/^m01c-canary-[a-f0-9]{32}$/u.test(config.stage) ||
    /(?:^|-)(?:prod|production|main|staging)(?:-|$)/u.test(config.stage)
  ) {
    throw new Error(
      `M01C refuses stage ${JSON.stringify(config.stage)}; use an isolated ${M01C_STAGE_PREFIX}<id> stage.`,
    );
  }
  if (config.deployApproval !== expectedDeployApproval(config.stage)) {
    throw new Error(
      `M01C deployment is not approved for stage ${config.stage}; set ${M01C_DEPLOY_APPROVAL} to the exact stage-scoped approval.`,
    );
  }
  if (!config.telemetryDisabled) {
    throw new Error("M01C requires ALCHEMY_TELEMETRY_DISABLED=1.");
  }
  if (!config.pinnedSafetyExtensionsReady) {
    throw new Error(
      "M01C deployment is blocked until pinned Alchemy refuses existing KV/R2 resources and persists retain-to-destroy policy changes on no-op apply.",
    );
  }
  if (config.armCleanup && config.cleanupApproval !== expectedCleanupApproval(config.stage)) {
    throw new Error(
      `M01C cleanup is not approved for stage ${config.stage}; set ${M01C_CLEANUP_APPROVAL} to the exact destructive approval.`,
    );
  }
}

export function m01cCanaryNames(stage: string): M01CCanaryNames {
  const suffix = stage.slice(M01C_STAGE_PREFIX.length, M01C_STAGE_PREFIX.length + 24);
  return {
    worker: `${syntheticNamePrefix}-${suffix}-host`,
    container: `${syntheticNamePrefix}-${suffix}-container`,
    sessions: `${syntheticNamePrefix}-${suffix}-sessions`,
    backups: `${syntheticNamePrefix}-${suffix}-backups`,
  };
}

export const m01cCanaryProgram = Effect.fnUntraced(function* (config: M01CCanaryConfig) {
  assertM01CCanaryConfig(config);
  const names = m01cCanaryNames(config.stage);
  const removalPolicy = RemovalPolicy.destroy(config.armCleanup);

  const sessions = yield* Cloudflare.KV.Namespace("CanarySessions", {
    title: names.sessions,
  }).pipe(removalPolicy);
  const backups = yield* Cloudflare.R2.Bucket("CanaryBackups", {
    name: names.backups,
    lifecycleRules: [
      {
        id: "m01c-disposable-backups",
        prefix: "backups/",
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      },
    ],
  }).pipe(removalPolicy);
  const durableObject = Cloudflare.DurableObject<
    import("./sandbox-sdk-canary-worker.ts").ScottySandbox
  >("Sandbox", {
    className: "ScottySandbox",
    scriptName: names.worker,
  });
  const worker = yield* Cloudflare.Worker("SandboxHost", {
    name: names.worker,
    main: "spikes/infra/sandbox-sdk-canary-worker.ts",
    url: true,
    assets: {
      directory: "worker/public",
      binding: "ASSETS",
      runWorkerFirst: ["/m01c/*", "/health"],
      notFoundHandling: "404-page",
    },
    compatibility: {
      date: compatibilityDate,
      flags: ["nodejs_compat"],
    },
    observability: { enabled: false },
    env: {
      SANDBOX: durableObject,
      SESSIONS: sessions,
      BACKUP_BUCKET: backups,
      SANDBOX_TRANSPORT: "rpc",
      BACKUP_BUCKET_NAME: names.backups,
      M01C_CANARY_STAGE: config.stage,
    },
  }).pipe(removalPolicy);
  const container = yield* Cloudflare.Containers.ContainerPlatform("SandboxContainer", {
    name: names.container,
    context: "worker/container",
    dockerfile: "Dockerfile",
    instanceType: "standard-2",
    maxInstances: 1,
    observability: { logs: { enabled: false } },
  }).pipe(removalPolicy);

  yield* bindExternalSandboxContainer({ worker, container, durableObject });

  return {
    stage: config.stage,
    workerName: worker.workerName,
    workerUrl: worker.url,
    containerName: container.applicationName,
    backupBucketName: backups.bucketName,
  };
});

export default Alchemy.Stack(
  M01C_STACK_NAME,
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    return yield* m01cCanaryProgram({
      stage,
      deployApproval: process.env[M01C_DEPLOY_APPROVAL],
      cleanupApproval: process.env[M01C_CLEANUP_APPROVAL],
      armCleanup: process.env.SCOTTY_M01C_ARM_CLEANUP === "1",
      telemetryDisabled: process.env.ALCHEMY_TELEMETRY_DISABLED === "1",
      // Hard-coded fail-closed until a pinned Alchemy extension and its regressions land.
      pinnedSafetyExtensionsReady: false,
    });
  }).pipe(Effect.orDie),
);
