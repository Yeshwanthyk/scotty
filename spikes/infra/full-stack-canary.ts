import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { CLOUDFLARE_WORKER_SECRETS } from "../../infra/cloudflare-stack.ts";
import { bindExternalSandboxContainer } from "../../infra/external-sandbox-container-binding.ts";

export const FULL_STACK_CANARY_STAGE_PREFIX = "scotty-e2e-";
export const FULL_STACK_CANARY_DEPLOY_APPROVAL = "SCOTTY_E2E_APPROVE_DEPLOY";
export const FULL_STACK_CANARY_CLEANUP_APPROVAL = "SCOTTY_E2E_APPROVE_CLEANUP";

export interface FullStackCanaryConfig {
  readonly stage: string;
  readonly deployApproval: string | undefined;
  readonly cleanupApproval: string | undefined;
  readonly telemetryDisabled: boolean;
}

export interface FullStackCanaryNames {
  readonly worker: string;
  readonly container: string;
  readonly sessions: string;
  readonly backups: string;
  readonly sandboxBundles: string;
}

export const fullStackCanaryAssetHash = (digest: string): string => `scotty-assets-v1:${digest}`;

export const expectedFullStackCanaryApprovals = (stage: string) => ({
  deploy: `deploy:${stage}`,
  cleanup: `destroy:${stage}:disposable`,
});

export function assertFullStackCanaryConfig(config: FullStackCanaryConfig): void {
  if (
    !/^scotty-e2e-[a-f0-9]{32}$/u.test(config.stage) ||
    /(?:^|-)(?:prod|production|main|staging)(?:-|$)/u.test(config.stage)
  ) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: disposable deployment preflight rejects unsafe stages before resource evaluation
    throw new Error(
      `Full-stack E2E refuses stage ${JSON.stringify(config.stage)}; use ${FULL_STACK_CANARY_STAGE_PREFIX}<32 lowercase hex>.`,
    );
  }
  const approvals = expectedFullStackCanaryApprovals(config.stage);
  if (config.deployApproval !== approvals.deploy) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: disposable deployment preflight requires exact stage-scoped approval
    throw new Error(
      `Full-stack E2E deployment requires ${FULL_STACK_CANARY_DEPLOY_APPROVAL}=${approvals.deploy}.`,
    );
  }
  if (config.cleanupApproval !== approvals.cleanup) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: disposable deployment preflight requires exact stage-scoped cleanup approval
    throw new Error(
      `Full-stack E2E cleanup requires ${FULL_STACK_CANARY_CLEANUP_APPROVAL}=${approvals.cleanup}.`,
    );
  }
  if (!config.telemetryDisabled) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: disposable deployment preflight keeps canary telemetry disabled
    throw new Error("Full-stack E2E requires ALCHEMY_TELEMETRY_DISABLED=1.");
  }
}

export function fullStackCanaryNames(stage: string): FullStackCanaryNames {
  const suffix = stage.slice(
    FULL_STACK_CANARY_STAGE_PREFIX.length,
    FULL_STACK_CANARY_STAGE_PREFIX.length + 24,
  );
  const prefix = `scotty-e2e-${suffix}`;
  return {
    worker: `${prefix}-worker`,
    container: `${prefix}-container`,
    sessions: `${prefix}-sessions`,
    backups: `${prefix}-backups`,
    sandboxBundles: `${prefix}-sandbox-bundles`,
  };
}

export const fullStackCanaryProgram = Effect.fnUntraced(function* (config: FullStackCanaryConfig) {
  assertFullStackCanaryConfig(config);
  const names = fullStackCanaryNames(config.stage);
  const removalPolicy = RemovalPolicy.destroy();
  const assetConfig = {
    directory: "worker/public",
    binding: "ASSETS",
    runWorkerFirst: [
      "/__e2e/*",
      "/api/*",
      "/s/*",
      "/sessions",
      "/providers",
      "/devices",
      "/pair",
      "/health",
    ],
    htmlHandling: "none" as const,
    notFoundHandling: "404-page" as const,
  };
  const assetDigest = (yield* Cloudflare.readAssets(assetConfig).pipe(
    // oxlint-disable-next-line scotty/no-effect-escape-hatch -- boundary: missing or invalid checked-in canary assets are an unrecoverable Alchemy build defect
    Effect.orDie,
  )).hash;
  const sessions = yield* Cloudflare.KV.Namespace("SessionsProjection", {
    title: names.sessions,
  }).pipe(removalPolicy);
  const backups = yield* Cloudflare.R2.Bucket("BackupBucket", {
    name: names.backups,
    lifecycleRules: [
      {
        id: "disposable-e2e-backups",
        prefix: "backups/",
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      },
    ],
  }).pipe(removalPolicy);
  const sandboxBundles = yield* Cloudflare.R2.Bucket("SandboxBundleBucket", {
    name: names.sandboxBundles,
  }).pipe(removalPolicy);
  const durableObject = Cloudflare.DurableObject("Sandbox", {
    className: "ScottySandbox",
  });
  const authDurableObject = Cloudflare.DurableObject("AuthRegistry", {
    className: "ScottyAuthRegistry",
  });
  const runnerRegistryDurableObject = Cloudflare.DurableObject("RunnerRegistry", {
    className: "ScottyRunnerRegistry",
  });
  const sandboxConfigDurableObject = Cloudflare.DurableObject("SandboxConfig", {
    className: "ScottySandboxConfig",
  });
  const worker = yield* Cloudflare.Worker("CanaryWorker", {
    name: names.worker,
    main: "spikes/infra/full-stack-canary-worker.ts",
    workersDev: true,
    assets: {
      ...assetConfig,
      hash: fullStackCanaryAssetHash(assetDigest),
    },
    compatibility: {
      date: "2026-07-20",
      flags: ["nodejs_compat"],
    },
    observability: { enabled: false },
    env: {
      AUTH: authDurableObject,
      RUNNER_REGISTRY: runnerRegistryDurableObject,
      SANDBOX: durableObject,
      SANDBOX_CONFIG: sandboxConfigDurableObject,
      SANDBOX_BUNDLE_BUCKET: sandboxBundles,
      SESSIONS: sessions,
      BACKUP_BUCKET: backups,
      SANDBOX_TRANSPORT: "rpc",
      BACKUP_BUCKET_NAME: names.backups,
      SCOTTY_E2E_CANARY_STAGE: config.stage,
    },
  }).pipe(removalPolicy);
  yield* worker.bind("InheritedWorkerSecrets", {
    bindings: CLOUDFLARE_WORKER_SECRETS.map((name) => ({
      type: "inherit" as const,
      name,
    })),
  });
  const container = yield* Cloudflare.Containers.ContainerPlatform("SandboxContainer", {
    name: names.container,
    context: ".",
    dockerfile: "worker/container/Dockerfile",
    instanceType: "standard-2",
    maxInstances: 3,
    observability: { logs: { enabled: false } },
  }).pipe(removalPolicy);

  yield* bindExternalSandboxContainer({ worker, container, durableObject });

  return {
    stage: config.stage,
    workerName: worker.workerName,
    workerUrl: worker.url,
    containerName: container.applicationName,
    backupBucketName: backups.bucketName,
    sandboxBundleBucketName: sandboxBundles.bucketName,
  };
});
