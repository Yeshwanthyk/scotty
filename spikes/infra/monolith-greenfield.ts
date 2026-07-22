import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { bindExternalSandboxContainer } from "./external-sandbox-container-binding.ts";

export const MONOLITH_GREENFIELD_STAGE = "production";
export const MONOLITH_GREENFIELD_WORKER_NAME = "scotty-worker";
export const MONOLITH_GREENFIELD_KV_TITLE = "scotty-sessions";
export const MONOLITH_GREENFIELD_BACKUP_BUCKET_NAME = "scotty-backups";
export const MONOLITH_GREENFIELD_INHERITED_SECRETS = [
  "CODEX_AUTH_JSON",
  "GH_TOKEN",
  "SCOTTY_TOKEN",
] as const;

export const MONOLITH_GREENFIELD_TOPOLOGY = {
  worker: {
    logicalId: "MonolithWorker",
    name: MONOLITH_GREENFIELD_WORKER_NAME,
    main: "worker/src/index.ts",
    url: true,
    compatibilityDate: "2026-07-20",
    compatibilityFlags: ["nodejs_compat"],
    observability: true,
  },
  assets: {
    directory: "worker/public",
    binding: "ASSETS",
    runWorkerFirst: ["/api/*", "/s/*", "/terminal", "/health"],
    htmlHandling: "none",
    notFoundHandling: "404-page",
  },
  durableObject: {
    logicalId: "Sandbox",
    bindingName: "SANDBOX",
    className: "ScottySandbox",
    scriptName: MONOLITH_GREENFIELD_WORKER_NAME,
  },
  container: {
    logicalId: "SandboxContainer",
    context: "worker/container",
    dockerfile: "worker/container/Dockerfile",
    instanceType: "standard-2",
    maxInstances: 10,
  },
  kv: {
    logicalId: "SessionsProjection",
    bindingName: "SESSIONS",
    title: MONOLITH_GREENFIELD_KV_TITLE,
  },
  r2: {
    logicalId: "BackupBucket",
    bindingName: "BACKUP_BUCKET",
    name: MONOLITH_GREENFIELD_BACKUP_BUCKET_NAME,
  },
  vars: {
    SANDBOX_TRANSPORT: "rpc",
    BACKUP_BUCKET_NAME: MONOLITH_GREENFIELD_BACKUP_BUCKET_NAME,
  },
  outputKeys: ["url"],
  removalPolicy: "retain",
} as const;

export interface MonolithGreenfieldAbsenceEvidence {
  readonly accountId: string;
  readonly worker: boolean;
  readonly durableObject: boolean;
  readonly container: boolean;
  readonly kv: boolean;
  readonly r2: boolean;
}

export interface MonolithGreenfieldConfig {
  readonly stage: string;
  readonly telemetryDisabled: boolean;
  readonly accountId: string;
  readonly absenceEvidence: MonolithGreenfieldAbsenceEvidence;
  readonly approval: string | undefined;
}

export const expectedMonolithGreenfieldApproval = (accountId: string): string =>
  `greenfield:${accountId}:${MONOLITH_GREENFIELD_WORKER_NAME}`;

export function assertMonolithGreenfieldConfig(config: MonolithGreenfieldConfig): void {
  if (config.stage !== MONOLITH_GREENFIELD_STAGE) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: deployment preflight reports configuration failure to a future Alchemy CLI wrapper
    throw new Error(`Greenfield deployment requires exact stage ${MONOLITH_GREENFIELD_STAGE}.`);
  }
  if (!config.telemetryDisabled) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: deployment preflight reports configuration failure to a future Alchemy CLI wrapper
    throw new Error("Greenfield deployment requires telemetry to be disabled.");
  }
  if (!/^[0-9a-f]{32}$/u.test(config.accountId)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: deployment preflight reports configuration failure to a future Alchemy CLI wrapper
    throw new Error("Greenfield deployment requires a 32-lowercase-hex accountId.");
  }
  const evidence = config.absenceEvidence;
  if (evidence.accountId !== config.accountId) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: deployment preflight reports configuration failure to a future Alchemy CLI wrapper
    throw new Error("Greenfield absence evidence must identify the deployment account.");
  }
  if (
    evidence.worker !== true ||
    evidence.durableObject !== true ||
    evidence.container !== true ||
    evidence.kv !== true ||
    evidence.r2 !== true
  ) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: deployment preflight reports configuration failure to a future Alchemy CLI wrapper
    throw new Error("Greenfield deployment requires explicit absence evidence for all resources.");
  }
  if (config.approval !== expectedMonolithGreenfieldApproval(config.accountId)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: deployment preflight reports configuration failure to a future Alchemy CLI wrapper
    throw new Error("Greenfield deployment requires exact account-scoped approval.");
  }
}

export const monolithGreenfieldProgram = Effect.fnUntraced(function* (
  config: MonolithGreenfieldConfig,
) {
  // This synchronous guard intentionally precedes every Resource Effect.
  assertMonolithGreenfieldConfig(config);

  const removalPolicy = RemovalPolicy.retain();
  const sessions = yield* Cloudflare.KV.Namespace(MONOLITH_GREENFIELD_TOPOLOGY.kv.logicalId, {
    title: MONOLITH_GREENFIELD_TOPOLOGY.kv.title,
  }).pipe(removalPolicy);
  const backups = yield* Cloudflare.R2.Bucket(MONOLITH_GREENFIELD_TOPOLOGY.r2.logicalId, {
    name: MONOLITH_GREENFIELD_TOPOLOGY.r2.name,
  }).pipe(removalPolicy);
  const durableObject = Cloudflare.DurableObject(
    MONOLITH_GREENFIELD_TOPOLOGY.durableObject.logicalId,
    {
      className: MONOLITH_GREENFIELD_TOPOLOGY.durableObject.className,
      scriptName: MONOLITH_GREENFIELD_TOPOLOGY.durableObject.scriptName,
    },
  );
  const assetConfig = {
    directory: MONOLITH_GREENFIELD_TOPOLOGY.assets.directory,
    binding: MONOLITH_GREENFIELD_TOPOLOGY.assets.binding,
    runWorkerFirst: [...MONOLITH_GREENFIELD_TOPOLOGY.assets.runWorkerFirst],
    htmlHandling: MONOLITH_GREENFIELD_TOPOLOGY.assets.htmlHandling,
    notFoundHandling: MONOLITH_GREENFIELD_TOPOLOGY.assets.notFoundHandling,
  };
  const worker = yield* Cloudflare.Worker(MONOLITH_GREENFIELD_TOPOLOGY.worker.logicalId, {
    name: MONOLITH_GREENFIELD_TOPOLOGY.worker.name,
    main: MONOLITH_GREENFIELD_TOPOLOGY.worker.main,
    url: MONOLITH_GREENFIELD_TOPOLOGY.worker.url,
    assets: assetConfig,
    compatibility: {
      date: MONOLITH_GREENFIELD_TOPOLOGY.worker.compatibilityDate,
      flags: [...MONOLITH_GREENFIELD_TOPOLOGY.worker.compatibilityFlags],
    },
    observability: { enabled: MONOLITH_GREENFIELD_TOPOLOGY.worker.observability },
    env: {
      SANDBOX: durableObject,
      SESSIONS: sessions,
      BACKUP_BUCKET: backups,
      ...MONOLITH_GREENFIELD_TOPOLOGY.vars,
    },
  }).pipe(removalPolicy);
  yield* worker.bind("InheritedWorkerSecrets", {
    bindings: MONOLITH_GREENFIELD_INHERITED_SECRETS.map((name) => ({ type: "inherit", name })),
  });
  const container = yield* Cloudflare.Containers.ContainerPlatform(
    MONOLITH_GREENFIELD_TOPOLOGY.container.logicalId,
    {
      context: MONOLITH_GREENFIELD_TOPOLOGY.container.context,
      dockerfile: MONOLITH_GREENFIELD_TOPOLOGY.container.dockerfile,
      instanceType: MONOLITH_GREENFIELD_TOPOLOGY.container.instanceType,
      maxInstances: MONOLITH_GREENFIELD_TOPOLOGY.container.maxInstances,
    },
  ).pipe(removalPolicy);

  yield* bindExternalSandboxContainer({ worker, container, durableObject });

  return { url: worker.url };
});
