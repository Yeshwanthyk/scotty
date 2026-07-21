import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { accountSecretsStoreWorkerBinding } from "./account-secrets-store-binding.ts";
import type { LocalSecretPaths } from "./local-secret-source.ts";
import {
  WriteOnlySecret,
  WriteOnlySecretDestination,
  WRITE_ONLY_SECRET_PROVIDER_VERSION,
} from "./write-only-secret.ts";

export const M01B_STAGE_PREFIX = "m01b-secret-canary-";
export const M01B_PHYSICAL_PREFIX = "scotty-m01b-disposable-";
export const M01B_DEPLOY_APPROVAL = "SCOTTY_M01B_APPROVE_DEPLOY";
export const M01B_MUTATION_APPROVAL = "SCOTTY_M01B_APPROVE_MUTATION";
export const M01B_CLEANUP_APPROVAL = "SCOTTY_M01B_APPROVE_CLEANUP";
export const M01B_SYNTHETIC_SOURCE_ID = "scotty/m01b-synthetic-codex-auth";
export const M01B_SYNTHETIC_AUTH_FILE = "SCOTTY_M01B_SYNTHETIC_AUTH_FILE";
export const M01B_ROOT_KEY_FILE = "SCOTTY_M01B_ROOT_KEY_FILE";
export const M01B_KEYED_DIGEST = "SCOTTY_M01B_KEYED_DIGEST";
export const M01B_ACCOUNT_ID = "SCOTTY_M01B_ACCOUNT_ID";
export const M01B_STORE_ID = "SCOTTY_M01B_STORE_ID";
export const M01B_BINDING_ATTACHED = "SCOTTY_M01B_BINDING_ATTACHED";
export const M01B_INTERRUPT_AFTER_WRITE = "SCOTTY_M01B_INTERRUPT_AFTER_WRITE";
export const M01B_PHASE = "SCOTTY_M01B_PHASE";
export const M01B_OPERATION = "SCOTTY_M01B_OPERATION";

export interface M01BCanaryConfig {
  readonly stage: string;
  readonly deployApproval: string | undefined;
  readonly mutationApproval: string | undefined;
  readonly cleanupApproval: string | undefined;
  readonly telemetryDisabled: boolean;
  readonly sourceId: string;
  readonly keyedDigest: string;
  readonly accountId: string;
  readonly storeId: string;
  readonly bindingName: "M01B_SYNTHETIC_SECRET";
  readonly secretName: string;
  readonly bindingAttached: boolean;
}

export const expectedM01BApprovals = (stage: string) => ({
  deploy: `deploy:${stage}`,
  mutation: `mutate:${stage}:synthetic`,
  cleanup: `destroy:${stage}:disposable`,
});

const reject = (message: string): never => {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- deployment preflight boundary
  throw new Error(message);
};

const requiredEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = environment[name];
  return value === undefined || value.length === 0 ? reject(`M01B requires ${name}.`) : value;
};

export const assertM01BCanaryApprovals = (
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  if (!/^m01b-secret-canary-[0-9a-f]{32}$/u.test(stage))
    reject(`M01B rejected stage; expected ${M01B_STAGE_PREFIX}<32 lowercase hex>.`);
  const approvals = expectedM01BApprovals(stage);
  if (environment[M01B_DEPLOY_APPROVAL] !== approvals.deploy)
    reject("M01B deploy approval is missing or wrong.");
  if (environment[M01B_MUTATION_APPROVAL] !== approvals.mutation)
    reject("M01B synthetic mutation approval is missing or wrong.");
  if (environment[M01B_CLEANUP_APPROVAL] !== approvals.cleanup)
    reject("M01B disposable cleanup approval is missing or wrong.");
  if (environment.ALCHEMY_TELEMETRY_DISABLED !== "1")
    reject("M01B requires ALCHEMY_TELEMETRY_DISABLED=1.");
};

export function assertM01BCanaryConfig(config: M01BCanaryConfig): void {
  if (!/^m01b-secret-canary-[0-9a-f]{32}$/u.test(config.stage))
    reject(`M01B rejected stage; expected ${M01B_STAGE_PREFIX}<32 lowercase hex>.`);
  const approvals = expectedM01BApprovals(config.stage);
  if (config.deployApproval !== approvals.deploy)
    reject("M01B deploy approval is missing or wrong.");
  if (config.mutationApproval !== approvals.mutation)
    reject("M01B synthetic mutation approval is missing or wrong.");
  if (config.cleanupApproval !== approvals.cleanup)
    reject("M01B disposable cleanup approval is missing or wrong.");
  if (!config.telemetryDisabled) reject("M01B requires ALCHEMY_TELEMETRY_DISABLED=1.");
  if (config.sourceId !== M01B_SYNTHETIC_SOURCE_ID) reject("M01B sourceId must be synthetic.");
  if (!/^hmac-sha256:v1:[0-9a-f]{64}$/u.test(config.keyedDigest))
    reject("M01B requires a canonical keyed digest.");
  if (config.bindingName !== "M01B_SYNTHETIC_SECRET") reject("M01B binding name is not synthetic.");
  const random96 = config.stage.slice(M01B_STAGE_PREFIX.length, M01B_STAGE_PREFIX.length + 24);
  if (config.secretName !== `${M01B_PHYSICAL_PREFIX}${random96}-secret`)
    reject("M01B secret name is not disposable synthetic metadata.");
  if (config.accountId.length === 0 || config.storeId.length === 0)
    reject("M01B account/store identifier metadata is required.");
}

export const m01bCanaryNames = (stage: string) => {
  const random96 = stage.slice(M01B_STAGE_PREFIX.length, M01B_STAGE_PREFIX.length + 24);
  return {
    worker: `${M01B_PHYSICAL_PREFIX}${random96}-worker`,
    secret: `${M01B_PHYSICAL_PREFIX}${random96}-secret`,
  } as const;
};

export const m01bCanaryConfigFromEnvironment = (
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
): M01BCanaryConfig => {
  assertM01BCanaryApprovals(stage, environment);
  const names = m01bCanaryNames(stage);
  const bindingAttached = requiredEnvironment(environment, M01B_BINDING_ATTACHED);
  if (bindingAttached !== "0" && bindingAttached !== "1")
    reject("M01B binding state must be exactly 0 or 1.");
  const config: M01BCanaryConfig = {
    stage,
    deployApproval: environment[M01B_DEPLOY_APPROVAL],
    mutationApproval: environment[M01B_MUTATION_APPROVAL],
    cleanupApproval: environment[M01B_CLEANUP_APPROVAL],
    telemetryDisabled: environment.ALCHEMY_TELEMETRY_DISABLED === "1",
    sourceId: M01B_SYNTHETIC_SOURCE_ID,
    keyedDigest: requiredEnvironment(environment, M01B_KEYED_DIGEST),
    accountId: requiredEnvironment(environment, M01B_ACCOUNT_ID),
    storeId: requiredEnvironment(environment, M01B_STORE_ID),
    bindingName: "M01B_SYNTHETIC_SECRET",
    secretName: names.secret,
    bindingAttached: bindingAttached === "1",
  };
  assertM01BCanaryConfig(config);
  return config;
};

const m01bCanaryLocalPathsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
): LocalSecretPaths => ({
  codexAuthPath: requiredEnvironment(environment, M01B_SYNTHETIC_AUTH_FILE),
  rootKeyPath: requiredEnvironment(environment, M01B_ROOT_KEY_FILE),
  previousRootKeyPaths: [],
  expectedUid,
});

/** Approval-first path decode for commands that will open synthetic files. */
export const m01bCanaryApprovedLocalPaths = (
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
  expectedUid: number,
): LocalSecretPaths => {
  assertM01BCanaryApprovals(stage, environment);
  const paths = m01bCanaryLocalPathsFromEnvironment(environment, expectedUid);
  const homeDirectory = requiredEnvironment(environment, "HOME");
  const expectedDirectory = `${homeDirectory}/.config/scotty/canaries/${stage}`;
  if (
    !homeDirectory.startsWith("/") ||
    paths.codexAuthPath !== `${expectedDirectory}/auth.json` ||
    paths.rootKeyPath !== `${expectedDirectory}/root-key`
  )
    reject("M01B synthetic files must use the exact stage-local canary directory.");
  return paths;
};

export type M01BInterruptAfterWrite = "create" | "patch" | undefined;

export const m01bCanaryFaultFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): M01BInterruptAfterWrite => {
  const operation = environment[M01B_INTERRUPT_AFTER_WRITE];
  return operation === undefined || operation === "create" || operation === "patch"
    ? operation
    : reject("M01B fault injection operation is invalid.");
};

/**
 * Canary-only deterministic ambiguous-write seam. It interrupts after the
 * concrete destination reports a committed create/patch and never inspects
 * or retains the write body.
 */
export const m01bCanaryFaultDestinationLayer = (operation: M01BInterruptAfterWrite) =>
  Layer.effect(
    WriteOnlySecretDestination,
    Effect.map(WriteOnlySecretDestination, (destination) =>
      WriteOnlySecretDestination.of({
        read: destination.read,
        find: destination.find,
        create: (key, body) =>
          destination
            .create(key, body)
            .pipe(
              Effect.flatMap((metadata) =>
                operation === "create" ? Effect.interrupt : Effect.succeed(metadata),
              ),
            ),
        patch: (key, body) =>
          destination
            .patch(key, body)
            .pipe(
              Effect.flatMap((metadata) =>
                operation === "patch" ? Effect.interrupt : Effect.succeed(metadata),
              ),
            ),
        delete: destination.delete,
      }),
    ),
  );

export const m01bCanaryDesired = (config: M01BCanaryConfig) => {
  assertM01BCanaryConfig(config);
  const names = m01bCanaryNames(config.stage);
  const secretProps = {
    sourceId: config.sourceId,
    accountId: config.accountId,
    storeId: config.storeId,
    secretName: config.secretName,
    bindingName: config.bindingName,
    providerVersion: WRITE_ONLY_SECRET_PROVIDER_VERSION,
    keyedDigest: config.keyedDigest,
  } as const;
  return { names, secretProps, binding: accountSecretsStoreWorkerBinding(secretProps) };
};

export const m01bCanaryProgram = Effect.fnUntraced(function* (config: M01BCanaryConfig) {
  // This synchronous guard intentionally precedes the first resource Effect evaluation.
  const desired = m01bCanaryDesired(config);
  yield* WriteOnlySecret("SyntheticSecret", desired.secretProps).pipe(RemovalPolicy.destroy());
  const worker = yield* Cloudflare.Worker("SyntheticBindingWorker", {
    name: desired.names.worker,
    main: "spikes/infra/account-secrets-store-canary-worker.ts",
    url: true,
    observability: { enabled: false },
    env: config.bindingAttached ? { M01B_SYNTHETIC_SECRET: desired.binding } : {},
  }).pipe(RemovalPolicy.destroy());
  return { workerName: worker.workerName, workerUrl: worker.url };
});

export type M01BPlanAction = "create" | "noop" | "delete" | "update" | "replace";
export interface M01BPlanEntry {
  readonly logicalId: string;
  readonly resource: string;
  readonly action: M01BPlanAction;
}

export type M01BPhase = "first" | "first-replay" | "update" | "second" | "unbind" | "destroy";

export const m01bCanaryPhaseFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): M01BPhase => {
  const phase = environment[M01B_PHASE];
  return phase === "first" ||
    phase === "first-replay" ||
    phase === "update" ||
    phase === "second" ||
    phase === "unbind" ||
    phase === "destroy"
    ? phase
    : reject("M01B phase is missing or invalid.");
};

export const m01bCanaryOperationFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): "plan" | "apply" => {
  const operation = environment[M01B_OPERATION];
  return operation === "plan" || operation === "apply"
    ? operation
    : reject("M01B operation must be exactly plan or apply.");
};

export function assertM01BPlan(
  entries: readonly M01BPlanEntry[],
  phase: M01BPhase,
  actionCount = 0,
): void {
  const expected = [
    { logicalId: "SyntheticSecret", resource: "Scotty.WriteOnlySecret" },
    { logicalId: "SyntheticBindingWorker", resource: "Cloudflare.Worker" },
  ];
  if (
    actionCount !== 0 ||
    entries.length !== 2 ||
    !expected.every(({ logicalId, resource }) =>
      entries.some((entry) => entry.logicalId === logicalId && entry.resource === resource),
    )
  )
    reject("M01B plan contains an unexpected or missing resource.");
  const secretAction =
    phase === "first" || phase === "first-replay"
      ? "create"
      : phase === "update"
        ? "update"
        : phase === "destroy"
          ? "delete"
          : "noop";
  const workerAction =
    phase === "first"
      ? "create"
      : phase === "first-replay"
        ? "noop"
        : phase === "unbind"
          ? "update"
          : phase === "destroy"
            ? "delete"
            : "noop";
  if (
    !entries.every((entry) =>
      entry.logicalId === "SyntheticSecret"
        ? entry.action === secretAction
        : entry.action === workerAction,
    )
  )
    reject(`M01B ${phase} plan has an unsafe action.`);
}

export function assertM01BScanClean(value: unknown, ...markers: readonly string[]): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of markers) {
    if (marker.length === 0) continue;
    const escaped = JSON.stringify(marker).slice(1, -1);
    const escapedTwice = JSON.stringify(escaped).slice(1, -1);
    if (
      serialized.includes(marker) ||
      serialized.includes(escaped) ||
      serialized.includes(escapedTwice)
    )
      reject("M01B non-disclosure scan failed.");
  }
}
