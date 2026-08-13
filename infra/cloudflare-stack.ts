import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { makeScottyRunnerWorker, ScottyRunnerWorker } from "../worker/src/runner-worker.ts";
import { bindExternalSandboxContainer } from "./external-sandbox-container-binding.ts";
import {
  CLOUDFLARE_STAGE,
  type InstallationTopology,
  makeInstallationTopology,
} from "./installation.ts";

export { CLOUDFLARE_STAGE };

export const CLOUDFLARE_WORKER_SECRETS = ["GH_TOKEN", "PI_AUTH_JSON", "SCOTTY_TOKEN"] as const;

export const makeCloudflareStackTopology = (installation: InstallationTopology) =>
  ({
    worker: {
      logicalId: installation.workerLogicalId,
      name: installation.workerName,
      main: "worker/src/index.ts",
      url: true,
      compatibilityDate: "2026-07-20",
      compatibilityFlags: ["nodejs_compat"],
      observability: true,
    },
    assets: {
      directory: "worker/public",
      binding: "ASSETS",
      runWorkerFirst: true,
      htmlHandling: "none",
      notFoundHandling: "404-page",
    },
    durableObject: {
      logicalId: "Sandbox",
      bindingName: "SANDBOX",
      className: "ScottySandbox",
    },
    authDurableObject: {
      logicalId: "AuthRegistry",
      bindingName: "AUTH",
      className: "ScottyAuthRegistry",
    },
    runnerRegistryDurableObject: {
      logicalId: "RunnerRegistry",
      bindingName: "RUNNER_REGISTRY",
      className: "ScottyRunnerRegistry",
    },
    runnerDurableObject: {
      logicalId: "Runner",
      bindingName: "RUNNERS",
      className: "ScottyRunner",
      workerName: installation.runnerWorkerName,
    },
    container: {
      logicalId: "SandboxContainer",
      name: installation.containerName,
      context: ".alchemy/scotty-container-context",
      dockerfile: ".alchemy/scotty-container-context/worker/container/Dockerfile",
      instanceType: "standard-2",
      maxInstances: 10,
    },
    kv: {
      logicalId: "SessionsProjection",
      bindingName: "SESSIONS",
      title: installation.kvTitle,
    },
    r2: {
      logicalId: "BackupBucket",
      bindingName: "BACKUP_BUCKET",
      name: installation.backupBucketName,
    },
    artifactR2: {
      logicalId: "ArtifactBucket",
      bindingName: "ARTIFACT_BUCKET",
      name: installation.artifactBucketName,
    },
    sandboxBundleR2: {
      logicalId: "SandboxBundleBucket",
      bindingName: "SANDBOX_BUNDLE_BUCKET",
      name: installation.sandboxBundleBucketName,
    },
    sandboxConfigDurableObject: {
      logicalId: "SandboxConfig",
      bindingName: "SANDBOX_CONFIG",
      className: "ScottySandboxConfig",
    },
    preview:
      installation.preview === undefined
        ? undefined
        : {
            base: installation.preview.base,
            zoneId: installation.preview.zoneId,
            dns: {
              logicalId: "EvidencePreviewWildcardDns",
              name: `*.${installation.preview.base}`,
              type: "AAAA" as const,
              content: "100::",
              proxied: true,
            },
            route: {
              logicalId: "EvidencePreviewWorkerRoute",
              pattern: `*.${installation.preview.base}/*`,
            },
          },
    vars: {
      SANDBOX_TRANSPORT: "rpc",
      BACKUP_BUCKET_NAME: installation.backupBucketName,
      ...(installation.preview === undefined
        ? {}
        : { SCOTTY_PREVIEW_BASE: installation.preview.base }),
      ...(installation.evidenceEnabled === true ? { SCOTTY_EVIDENCE_ENABLED: "true" } : {}),
    },
    outputKeys: ["url", "accountId", "workerName"],
    removalPolicy: "retain",
  }) as const;

export interface CloudflareStackConfig {
  readonly stage: string;
  readonly telemetryDisabled: boolean;
  readonly installation: InstallationTopology;
  readonly resourceConfirmation: string | undefined;
  readonly approval: string | undefined;
}

export const expectedCloudflareResourceConfirmation = (
  installation: InstallationTopology,
): string =>
  [
    "confirmed",
    installation.installationName,
    `worker=${installation.workerName}`,
    `runnerWorker=${installation.runnerWorkerName}`,
    "durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunnerRegistry,ScottyRunner,ScottySandboxConfig",
    `container=${installation.containerName}`,
    `kv=${installation.kvTitle}`,
    `r2=${installation.backupBucketName}`,
    `artifacts=${installation.artifactBucketName}`,
    `sandboxBundles=${installation.sandboxBundleBucketName}`,
    ...(installation.preview === undefined
      ? []
      : [`previewBase=${installation.preview.base}`, `previewZone=${installation.preview.zoneId}`]),
    ...(installation.evidenceEnabled === true ? ["evidence=enabled"] : []),
  ].join(":");

export const expectedCloudflareStackApproval = (installation: InstallationTopology): string =>
  `deploy:${installation.installationName}:${installation.workerName}`;

export function assertCloudflareStackConfig(config: CloudflareStackConfig): void {
  if (config.installation.evidenceEnabled === true && config.installation.preview === undefined) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects an enabled bridge without explicit preview authority
    throw new Error("Evidence requires an explicit preview topology.");
  }
  if (config.stage !== CLOUDFLARE_STAGE) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error(`Cloudflare deployment requires exact stage ${CLOUDFLARE_STAGE}.`);
  }
  if (!config.telemetryDisabled) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error("Cloudflare deployment requires telemetry to be disabled.");
  }
  if (config.resourceConfirmation !== expectedCloudflareResourceConfirmation(config.installation)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error(
      "Cloudflare deployment requires exact installation-scoped resource confirmation.",
    );
  }
  if (config.approval !== expectedCloudflareStackApproval(config.installation)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error("Cloudflare deployment requires exact installation-scoped approval.");
  }
}

export const cloudflareStack = Effect.fnUntraced(function* (config: CloudflareStackConfig) {
  assertCloudflareStackConfig(config);

  const topology = makeCloudflareStackTopology(config.installation);
  const environment = yield* Cloudflare.CloudflareEnvironment;
  const { accountId } = yield* environment;
  const removalPolicy = RemovalPolicy.retain();
  const sessions = yield* Cloudflare.KV.Namespace(topology.kv.logicalId, {
    title: topology.kv.title,
  }).pipe(removalPolicy);
  const backups = yield* Cloudflare.R2.Bucket(topology.r2.logicalId, {
    name: topology.r2.name,
  }).pipe(removalPolicy);
  const artifacts = yield* Cloudflare.R2.Bucket(topology.artifactR2.logicalId, {
    name: topology.artifactR2.name,
  }).pipe(removalPolicy);
  const sandboxBundles = yield* Cloudflare.R2.Bucket(topology.sandboxBundleR2.logicalId, {
    name: topology.sandboxBundleR2.name,
  }).pipe(removalPolicy);
  const durableObject = Cloudflare.DurableObject(topology.durableObject.logicalId, {
    className: topology.durableObject.className,
  });
  const authDurableObject = Cloudflare.DurableObject(topology.authDurableObject.logicalId, {
    className: topology.authDurableObject.className,
  });
  const runnerRegistryDurableObject = Cloudflare.DurableObject(
    topology.runnerRegistryDurableObject.logicalId,
    {
      className: topology.runnerRegistryDurableObject.className,
    },
  );
  const sandboxConfigDurableObject = Cloudflare.DurableObject(
    topology.sandboxConfigDurableObject.logicalId,
    {
      className: topology.sandboxConfigDurableObject.className,
    },
  );
  const runnerWorker = yield* ScottyRunnerWorker.pipe(
    Effect.provide(makeScottyRunnerWorker(topology.runnerDurableObject.workerName)),
    removalPolicy,
  );
  const runnerDurableObject = Cloudflare.DurableObject(topology.runnerDurableObject.logicalId, {
    className: topology.runnerDurableObject.className,
    scriptName: runnerWorker.workerName,
  });
  const assetConfig = {
    directory: topology.assets.directory,
    binding: topology.assets.binding,
    runWorkerFirst: topology.assets.runWorkerFirst,
    htmlHandling: topology.assets.htmlHandling,
    notFoundHandling: topology.assets.notFoundHandling,
  };
  const worker = yield* Cloudflare.Worker(topology.worker.logicalId, {
    name: topology.worker.name,
    main: topology.worker.main,
    workersDev: topology.worker.url,
    assets: assetConfig,
    compatibility: {
      date: topology.worker.compatibilityDate,
      flags: [...topology.worker.compatibilityFlags],
    },
    observability: { enabled: topology.worker.observability },
    env: {
      AUTH: authDurableObject,
      RUNNER_REGISTRY: runnerRegistryDurableObject,
      RUNNERS: runnerDurableObject,
      SANDBOX: durableObject,
      SANDBOX_CONFIG: sandboxConfigDurableObject,
      SESSIONS: sessions,
      BACKUP_BUCKET: backups,
      ARTIFACT_BUCKET: artifacts,
      SANDBOX_BUNDLE_BUCKET: sandboxBundles,
      ...topology.vars,
    },
  }).pipe(removalPolicy);
  yield* worker.bind("InheritedWorkerSecrets", {
    bindings: CLOUDFLARE_WORKER_SECRETS.map((name) => ({ type: "inherit", name })),
  });
  const container = yield* Cloudflare.Containers.ContainerPlatform(topology.container.logicalId, {
    name: topology.container.name,
    context: topology.container.context,
    dockerfile: topology.container.dockerfile,
    instanceType: topology.container.instanceType,
    maxInstances: topology.container.maxInstances,
  }).pipe(removalPolicy);

  yield* bindExternalSandboxContainer({ worker, container, durableObject });

  if (topology.preview !== undefined) {
    yield* Cloudflare.DNS.Record(topology.preview.dns.logicalId, {
      zoneId: topology.preview.zoneId,
      name: topology.preview.dns.name,
      type: topology.preview.dns.type,
      content: topology.preview.dns.content,
      proxied: topology.preview.dns.proxied,
    }).pipe(RemovalPolicy.destroy());
    yield* Cloudflare.Workers.WorkerRoute(topology.preview.route.logicalId, {
      zoneId: topology.preview.zoneId,
      pattern: topology.preview.route.pattern,
      script: worker.workerName,
    }).pipe(RemovalPolicy.destroy());
  }

  return { url: worker.url, accountId, workerName: topology.worker.name };
});

export const defaultCloudflareStackTopology = (installationName: string) =>
  makeCloudflareStackTopology(makeInstallationTopology(installationName));
