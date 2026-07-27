import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import ScottyRunnerWorkerLive, {
  SCOTTY_RUNNER_WORKER_NAME,
  ScottyRunnerWorker,
} from "../worker/src/runner-worker.ts";
import { bindExternalSandboxContainer } from "./external-sandbox-container-binding.ts";

export const CLOUDFLARE_STAGE = "production";
export const CLOUDFLARE_WORKER_NAME = "scotty-worker";
export const CLOUDFLARE_RUNNER_WORKER_NAME = SCOTTY_RUNNER_WORKER_NAME;
export const CLOUDFLARE_KV_TITLE = "scotty-sessions";
export const CLOUDFLARE_BACKUP_BUCKET_NAME = "scotty-backups";
export const CLOUDFLARE_CONTAINER_APPLICATION_NAME =
  "scotty-sandboxcontainer-production-ytkhty6mswuofjo5";
export const CLOUDFLARE_WORKER_SECRETS = [
  "CODEX_AUTH_JSON",
  "GH_TOKEN",
  "SCOTTY_RUNNER_TOKEN",
  "SCOTTY_TOKEN",
] as const;

const EXISTING_ALCHEMY_LOGICAL_IDS = {
  // Alchemy state is keyed by logical ID. Changing this value would create a
  // second Worker resource instead of updating the deployed Scotty Worker.
  worker: "MonolithWorker",
} as const;

export const CLOUDFLARE_STACK = {
  worker: {
    logicalId: EXISTING_ALCHEMY_LOGICAL_IDS.worker,
    name: CLOUDFLARE_WORKER_NAME,
    main: "worker/src/index.ts",
    url: true,
    compatibilityDate: "2026-07-20",
    compatibilityFlags: ["nodejs_compat"],
    observability: true,
  },
  assets: {
    directory: "worker/public",
    binding: "ASSETS",
    runWorkerFirst: ["/api/*", "/s/*", "/sessions", "/devices", "/pair", "/health"],
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
  runnerDurableObject: {
    logicalId: "Runner",
    bindingName: "RUNNERS",
    className: "ScottyRunner",
    workerName: CLOUDFLARE_RUNNER_WORKER_NAME,
  },
  container: {
    logicalId: "SandboxContainer",
    name: CLOUDFLARE_CONTAINER_APPLICATION_NAME,
    context: ".",
    dockerfile: "worker/container/Dockerfile",
    instanceType: "standard-2",
    maxInstances: 10,
  },
  kv: {
    logicalId: "SessionsProjection",
    bindingName: "SESSIONS",
    title: CLOUDFLARE_KV_TITLE,
  },
  r2: {
    logicalId: "BackupBucket",
    bindingName: "BACKUP_BUCKET",
    name: CLOUDFLARE_BACKUP_BUCKET_NAME,
  },
  vars: {
    SANDBOX_TRANSPORT: "rpc",
    BACKUP_BUCKET_NAME: CLOUDFLARE_BACKUP_BUCKET_NAME,
    SCOTTY_RUNNER_NAME: "slumbers",
  },
  outputKeys: ["url"],
  removalPolicy: "retain",
} as const;

export interface CloudflareStackConfig {
  readonly stage: string;
  readonly telemetryDisabled: boolean;
  readonly accountId: string;
  readonly resourceConfirmation: string | undefined;
  readonly approval: string | undefined;
}

export const expectedCloudflareResourceConfirmation = (accountId: string): string =>
  [
    "confirmed",
    accountId,
    `worker=${CLOUDFLARE_STACK.worker.name}`,
    `runnerWorker=${CLOUDFLARE_STACK.runnerDurableObject.workerName}`,
    `durableObjects=${CLOUDFLARE_STACK.durableObject.className},${CLOUDFLARE_STACK.authDurableObject.className},${CLOUDFLARE_STACK.runnerDurableObject.className}`,
    `container=${CLOUDFLARE_STACK.container.name}`,
    `kv=${CLOUDFLARE_STACK.kv.title}`,
    `r2=${CLOUDFLARE_STACK.r2.name}`,
  ].join(":");

export const expectedCloudflareStackApproval = (accountId: string): string =>
  `deploy:${accountId}:${CLOUDFLARE_WORKER_NAME}`;

export function assertCloudflareStackConfig(config: CloudflareStackConfig): void {
  if (config.stage !== CLOUDFLARE_STAGE) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error(`Cloudflare deployment requires exact stage ${CLOUDFLARE_STAGE}.`);
  }
  if (!config.telemetryDisabled) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error("Cloudflare deployment requires telemetry to be disabled.");
  }
  if (!/^[0-9a-f]{32}$/u.test(config.accountId)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error("Cloudflare deployment requires a 32-lowercase-hex accountId.");
  }
  if (config.resourceConfirmation !== expectedCloudflareResourceConfirmation(config.accountId)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error("Cloudflare deployment requires exact account-scoped resource confirmation.");
  }
  if (config.approval !== expectedCloudflareStackApproval(config.accountId)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: synchronous deployment preflight rejects invalid host configuration before resource evaluation
    throw new Error("Cloudflare deployment requires exact account-scoped approval.");
  }
}

export const cloudflareStack = Effect.fnUntraced(function* (config: CloudflareStackConfig) {
  // This synchronous guard intentionally precedes every Resource Effect.
  assertCloudflareStackConfig(config);

  const removalPolicy = RemovalPolicy.retain();
  const sessions = yield* Cloudflare.KV.Namespace(CLOUDFLARE_STACK.kv.logicalId, {
    title: CLOUDFLARE_STACK.kv.title,
  }).pipe(removalPolicy);
  const backups = yield* Cloudflare.R2.Bucket(CLOUDFLARE_STACK.r2.logicalId, {
    name: CLOUDFLARE_STACK.r2.name,
  }).pipe(removalPolicy);
  const durableObject = Cloudflare.DurableObject(CLOUDFLARE_STACK.durableObject.logicalId, {
    className: CLOUDFLARE_STACK.durableObject.className,
  });
  const authDurableObject = Cloudflare.DurableObject(CLOUDFLARE_STACK.authDurableObject.logicalId, {
    className: CLOUDFLARE_STACK.authDurableObject.className,
  });
  const runnerWorker = yield* ScottyRunnerWorker.pipe(
    Effect.provide(ScottyRunnerWorkerLive),
    removalPolicy,
  );
  const runnerDurableObject = Cloudflare.DurableObject(
    CLOUDFLARE_STACK.runnerDurableObject.logicalId,
    {
      className: CLOUDFLARE_STACK.runnerDurableObject.className,
      scriptName: runnerWorker.workerName,
    },
  );
  const assetConfig = {
    directory: CLOUDFLARE_STACK.assets.directory,
    binding: CLOUDFLARE_STACK.assets.binding,
    runWorkerFirst: [...CLOUDFLARE_STACK.assets.runWorkerFirst],
    htmlHandling: CLOUDFLARE_STACK.assets.htmlHandling,
    notFoundHandling: CLOUDFLARE_STACK.assets.notFoundHandling,
  };
  const worker = yield* Cloudflare.Worker(CLOUDFLARE_STACK.worker.logicalId, {
    name: CLOUDFLARE_STACK.worker.name,
    main: CLOUDFLARE_STACK.worker.main,
    url: CLOUDFLARE_STACK.worker.url,
    assets: assetConfig,
    compatibility: {
      date: CLOUDFLARE_STACK.worker.compatibilityDate,
      flags: [...CLOUDFLARE_STACK.worker.compatibilityFlags],
    },
    observability: { enabled: CLOUDFLARE_STACK.worker.observability },
    env: {
      AUTH: authDurableObject,
      RUNNERS: runnerDurableObject,
      SANDBOX: durableObject,
      SESSIONS: sessions,
      BACKUP_BUCKET: backups,
      ...CLOUDFLARE_STACK.vars,
    },
  }).pipe(removalPolicy);
  yield* worker.bind("InheritedWorkerSecrets", {
    bindings: CLOUDFLARE_WORKER_SECRETS.map((name) => ({ type: "inherit", name })),
  });
  const container = yield* Cloudflare.Containers.ContainerPlatform(
    CLOUDFLARE_STACK.container.logicalId,
    {
      name: CLOUDFLARE_STACK.container.name,
      context: CLOUDFLARE_STACK.container.context,
      dockerfile: CLOUDFLARE_STACK.container.dockerfile,
      instanceType: CLOUDFLARE_STACK.container.instanceType,
      maxInstances: CLOUDFLARE_STACK.container.maxInstances,
    },
  ).pipe(removalPolicy);

  yield* bindExternalSandboxContainer({ worker, container, durableObject });

  return { url: worker.url };
});
