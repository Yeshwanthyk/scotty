import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { Credentials as DistilledCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as DNS from "@distilled.cloud/cloudflare/dns";
import type { NotFound as CloudflareNotFound } from "@distilled.cloud/cloudflare/Errors";
import * as KV from "@distilled.cloud/cloudflare/kv";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Clock, Context, Data, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  assessContainerSettlement,
  CONTAINER_ROLLOUT_POLL_MS,
  CONTAINER_ROLLOUT_TIMEOUT_MS,
} from "../../scripts/deploy-production.mjs";
import {
  readControlPlaneEffect,
  type ContainerControlPlaneSnapshot,
} from "../../scripts/container-control-plane.mjs";
import {
  cloudflareStack,
  expectedCloudflareResourceConfirmation,
  expectedCloudflareStackApproval,
} from "../../infra/cloudflare-stack.ts";
import {
  adoptionMatchesInstallation,
  CLOUDFLARE_STAGE,
  decodeAdoptionManifestJson,
  decodeInstallationPreviewConfiguration,
  makeInstallationTopology,
  type AdoptionManifest,
  type InstallationPreviewConfiguration,
} from "../../infra/installation.ts";
import {
  PreviewCleanupOwnershipError,
  readOwnedPreviewTopologyDeletion,
} from "../../infra/preview-ownership.ts";
import {
  CONTAINER_INPUTS,
  DEPLOYMENT_ARCHIVE_NAME,
  DEPLOYMENT_INPUTS,
  isDeploymentArchiveFileName,
  prepareContainerContext,
} from "./deployment-packaging.mjs";
import {
  missingPrebuiltWorkerEntries,
  rewritePrebuiltRunnerStackPlaceholders,
} from "./prebuilt-worker-bundles.ts";
import type {
  InstallationApplyRequest,
  InstallationCreateRequest,
  InstallationDeployRequest,
  InstallationInspectRequest,
  InstallationPlan,
  InstallationRecoverRequest,
  InstallationResult,
  InstallationUninstallRequest,
  InstallationUninstallResult,
} from "./services.ts";

type WorkerBinding = NonNullable<
  Workers.GetScriptScriptAndVersionSettingResponse["bindings"]
>[number];
type DurableObjectBinding = Extract<WorkerBinding, { readonly type: "durable_object_namespace" }>;
type KvBinding = Extract<WorkerBinding, { readonly type: "kv_namespace" }>;
type R2Binding = Extract<WorkerBinding, { readonly type: "r2_bucket" }>;
type PlainTextBinding = Extract<WorkerBinding, { readonly type: "plain_text" }>;

const isDurableObjectBinding = (binding: WorkerBinding): binding is DurableObjectBinding =>
  binding.type === "durable_object_namespace";
const isKvBinding = (binding: WorkerBinding): binding is KvBinding =>
  binding.type === "kv_namespace";
const isR2Binding = (binding: WorkerBinding): binding is R2Binding => binding.type === "r2_bucket";
const isPlainTextBinding = (binding: WorkerBinding): binding is PlainTextBinding =>
  binding.type === "plain_text";

export class InstallationDeploymentError extends Data.TaggedError("InstallationDeploymentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ContainerControlPlaneReader<R = never> = (input: {
  readonly accountId: string;
  readonly applicationId: string;
}) => Effect.Effect<ContainerControlPlaneSnapshot, unknown, R>;

export const isContainerPlanChanged = (plan: Plan.Plan): boolean => {
  const containerNode = plan.resources["SandboxContainer"];
  return containerNode !== undefined && containerNode.action !== "noop";
};

export const assertContainerBaselineSettled = (
  snapshot: ContainerControlPlaneSnapshot,
): Effect.Effect<void, InstallationDeploymentError> => {
  const activeRollouts = snapshot.rollouts.filter(
    (rollout) => rollout.status === "pending" || rollout.status === "progressing",
  );
  if (snapshot.application.activeRolloutId !== null || activeRollouts.length > 0) {
    return new InstallationDeploymentError({
      message: "Container application already has an active rollout.",
    });
  }
  return Effect.void;
};

const defaultReadControlPlane: ContainerControlPlaneReader<
  typeof DistilledCredentials | typeof Cloudflare.CloudflareEnvironment
> = (input) =>
  readControlPlaneEffect(input).pipe(
    Effect.mapError(
      (cause) =>
        new InstallationDeploymentError({
          message: "Cloudflare Container control-plane request failed.",
          cause,
        }),
    ),
  );

export const waitForContainerRollout = Effect.fnUntraced(function* <R = never>(
  before: ContainerControlPlaneSnapshot,
  target: { readonly accountId: string; readonly applicationId: string },
  options: {
    readonly containerAction?: "updated" | "noop" | "unknown";
    readonly readControlPlane?: ContainerControlPlaneReader<R>;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly reportProgress?: (message: string) => void;
  } = {},
) {
  const read = (options.readControlPlane ??
    defaultReadControlPlane) as ContainerControlPlaneReader<R>;
  const timeoutMs = options.timeoutMs ?? CONTAINER_ROLLOUT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CONTAINER_ROLLOUT_POLL_MS;
  const containerAction = options.containerAction ?? "updated";
  const reportProgress = options.reportProgress;

  const startedAt = yield* Clock.currentTimeMillis;
  let lastObservation =
    `${before.application.version}:${before.application.updatedAt}:` +
    `${before.application.activeRolloutId}:${before.application.configurationDigest}:` +
    `${JSON.stringify(before.application.health)}`;
  let lastObservationAt = startedAt;
  let lastReportedProgress: string | undefined = undefined;

  while (true) {
    const current = yield* read(target);
    const observedAt = yield* Clock.currentTimeMillis;
    const elapsedMs = observedAt - startedAt;

    const newRollout = current.rollouts.find(
      (rollout) => !before.rollouts.some((previous) => previous.id === rollout.id),
    );
    const observation = newRollout
      ? `${newRollout.id}:${newRollout.status}:${newRollout.lastUpdatedAt}:` +
        `${newRollout.targetVersion}:${newRollout.progress.updatedInstances}:` +
        `${JSON.stringify(newRollout.health)}:${JSON.stringify(current.application.health)}`
      : `${current.application.version}:${current.application.updatedAt}:` +
        `${current.application.activeRolloutId}:${current.application.configurationDigest}:` +
        `${JSON.stringify(current.application.health)}`;

    if (observation !== lastObservation) {
      lastObservation = observation;
      lastObservationAt = observedAt;
    }

    const assessment = assessContainerSettlement(before, current, containerAction, {
      quietMs: observedAt - lastObservationAt,
    });

    if (observation !== lastReportedProgress) {
      reportProgress?.(assessment.message);
      lastReportedProgress = observation;
    }

    if (assessment.status === "settled") {
      return current;
    }

    if (assessment.status === "failed") {
      return yield* new InstallationDeploymentError({
        message: assessment.message,
      });
    }

    if (elapsedMs >= timeoutMs) {
      return yield* new InstallationDeploymentError({
        message: `Container rollout did not settle within ${Math.ceil(timeoutMs / 60_000)} minutes: ${assessment.message}`,
      });
    }

    const sleepMs = Math.min(pollMs, timeoutMs - elapsedMs);
    yield* Effect.sleep(Duration.millis(sleepMs));
  }
});

const embeddedDeploymentArchive = (): Blob | undefined =>
  Bun.embeddedFiles.find((file) => {
    const name = Reflect.get(file, "name");
    const fileName = typeof name === "string" ? basename(name) : "";
    return isDeploymentArchiveFileName(fileName);
  });

const sourceRoot = (): string => resolve(import.meta.dir, "../..");

const prepareDeploymentRoot = async (): Promise<{
  readonly root: string;
  readonly cleanup: () => Promise<void>;
  readonly prebuiltWorkers: boolean;
}> => {
  const archive = embeddedDeploymentArchive();
  if (!archive)
    return { root: sourceRoot(), cleanup: async () => undefined, prebuiltWorkers: false };
  const root = await mkdtemp(join(tmpdir(), "scotty-deployment-"));
  let prepared = false;
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: embedded archive extraction must remove partial roots on every exit
  try {
    const bytes = await archive.arrayBuffer();
    await new Bun.Archive(bytes).extract(root);
    const missing = missingPrebuiltWorkerEntries(root);
    if (missing.length > 0) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: embedded archives may never fall back to source-mode Worker bundling
      throw new InstallationDeploymentError({
        message: `Embedded deployment archive is missing prebuilt worker bundles: ${missing.join(", ")}`,
      });
    }
    await mkdir(join(root, ".alchemy"), { recursive: true });
    prepared = true;
    return {
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
      prebuiltWorkers: true,
    };
  } finally {
    if (!prepared) await rm(root, { recursive: true, force: true });
  }
};

const preparePrebuiltWorkerDeployment = async (
  root: string,
  prebuiltWorkers: boolean,
  installation: ReturnType<typeof makeInstallationTopology>,
): Promise<void> => {
  if (!prebuiltWorkers) return;
  const missing = missingPrebuiltWorkerEntries(root);
  if (missing.length > 0) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: embedded archive must ship prebuilt worker bundles
    throw new InstallationDeploymentError({
      message: `Embedded deployment archive is missing prebuilt worker bundles: ${missing.join(", ")}`,
    });
  }
  await rewritePrebuiltRunnerStackPlaceholders(root, installation.stackName, CLOUDFLARE_STAGE);
};

const prepareInstallationContainerContext = async (root: string): Promise<void> => {
  await prepareContainerContext(root, { inputs: CONTAINER_INPUTS });
};

const readAdoptionManifest = async (
  path: string | undefined,
  installationName: string,
): Promise<AdoptionManifest | undefined> => {
  if (!path) return undefined;
  const text = await Bun.file(path).text();
  const decoded = decodeAdoptionManifestJson(text);
  if (Option.isNone(decoded) || !adoptionMatchesInstallation(decoded.value, installationName)) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise file adapter rejects invalid machine-local adoption input before Cloudflare access
    throw new InstallationDeploymentError({
      message: "Adoption manifest is invalid or names a different installation.",
    });
  }
  return decoded.value;
};

const alchemyRuntimeLayer = Layer.provideMerge(
  Layer.mergeAll(LoggingCli, AlchemyContextLive),
  Layer.mergeAll(
    PlatformServices,
    NodeServices.layer,
    FetchHttpClient.layer,
    Layer.provide(ProfileLive, PlatformServices),
    Layer.provide(CredentialsStoreLive, PlatformServices),
  ),
);

const cloudflareApiLive = () => {
  const live = Cloudflare.CloudflareApiLive();
  // Alchemy and its runtime peers install different Distilled versions under the same Context key.
  // Re-expose Alchemy's resolved credentials through the direct API client's tag.

  return Layer.fromBuild((memoMap, scope) =>
    Layer.buildWithMemoMap(live, memoMap, scope).pipe(
      Effect.map((services) =>
        Context.add(
          services,
          DistilledCredentials,
          Context.get(services as Context.Context<DistilledCredentials>, DistilledCredentials),
        ),
      ),
    ),
  );
};

const provideAlchemy = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provide(Cloudflare.state()),
    Effect.provideService(ArtifactStore, createArtifactStore()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide(alchemyRuntimeLayer),
  );

const DOCKER_CONTEXT_INSPECT_ARGS = [
  "context",
  "inspect",
  "--format",
  "{{json .Endpoints.docker.Host}}",
] as const;
const DOCKER_CONTEXT_INSPECT_TIMEOUT_MS = 30_000;

export type InstallationDockerInspect = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<string>;

const decodeDockerContextHostJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.String),
);

const inspectDockerContextHost: InstallationDockerInspect = async (command, args) => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: host subprocess timeout uses the platform timer API
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, DOCKER_CONTEXT_INSPECT_TIMEOUT_MS);
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]).finally(() => {
    clearTimeout(timer);
  });
  if (timedOut || exitCode !== 0) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw, scotty/no-error-constructor -- boundary: host subprocess adapter reports inspect failure through Promise rejection
    throw new Error("docker context inspect failed");
  }
  return stdout;
};

export const resolveInstallationDockerHost = Effect.fnUntraced(function* (
  environment: NodeJS.ProcessEnv = process.env,
  inspect: InstallationDockerInspect = inspectDockerContextHost,
) {
  if (environment.DOCKER_HOST?.trim()) return undefined;
  const output = yield* Effect.tryPromise({
    try: () => inspect("docker", DOCKER_CONTEXT_INSPECT_ARGS),
    catch: (cause) => cause,
  }).pipe(Effect.option);
  if (Option.isNone(output)) return undefined;
  const decoded = decodeDockerContextHostJson(output.value.trim());
  if (Option.isNone(decoded) || decoded.value.length === 0) return undefined;
  return decoded.value;
});

const runWithProfile = async <A, E>(
  profile: string,
  root: string,
  makeProgram: () => Effect.Effect<A, E>,
): Promise<A> => {
  const previousProfile = process.env.ALCHEMY_PROFILE;
  const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
  const previousDockerHost = process.env.DOCKER_HOST;
  const previousDirectory = process.cwd();
  process.env.ALCHEMY_PROFILE = profile;
  process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
  process.chdir(root);
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: standalone CLI owns this Alchemy Effect-to-Promise execution
  const resolvedDockerHost = await Effect.runPromise(resolveInstallationDockerHost());
  if (resolvedDockerHost !== undefined) process.env.DOCKER_HOST = resolvedDockerHost;
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must restore process-wide profile and cwd state
  try {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: standalone CLI owns this Alchemy Effect-to-Promise execution
    return await Effect.runPromise(makeProgram());
  } finally {
    process.chdir(previousDirectory);
    if (previousProfile === undefined) delete process.env.ALCHEMY_PROFILE;
    else process.env.ALCHEMY_PROFILE = previousProfile;
    if (previousTelemetry === undefined) delete process.env.ALCHEMY_TELEMETRY_DISABLED;
    else process.env.ALCHEMY_TELEMETRY_DISABLED = previousTelemetry;
    if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousDockerHost;
  }
};

const previewConfiguration = (
  request: InstallationDeployRequest | InstallationInspectRequest,
): InstallationPreviewConfiguration | undefined => {
  if (request.previewBase === undefined && request.previewZoneId === undefined) return undefined;
  const decoded = decodeInstallationPreviewConfiguration({
    base: request.previewBase,
    zoneId: request.previewZoneId,
  });
  if (Option.isNone(decoded)) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter rejects partial or malformed explicit preview topology before Cloudflare access
    throw new InstallationDeploymentError({
      message: "Preview base and Cloudflare zone must both be valid explicit configuration.",
    });
  }
  return decoded.value;
};

const makeStack = (
  request: InstallationDeployRequest,
  adoption: AdoptionManifest | undefined,
  prebuiltWorkers: boolean,
) => {
  const installation = makeInstallationTopology(
    request.installationName,
    adoption,
    previewConfiguration(request),
    request.evidenceEnabled === true,
  );
  const stack = Alchemy.Stack(
    installation.stackName,
    {
      providers: Cloudflare.providers(),
      state: Cloudflare.state(),
    },
    cloudflareStack({
      stage: CLOUDFLARE_STAGE,
      telemetryDisabled: true,
      installation,
      resourceConfirmation: expectedCloudflareResourceConfirmation(installation),
      approval: expectedCloudflareStackApproval(installation),
      prebuiltWorkers,
    }).pipe(Alchemy.AdoptPolicy.adopt(adoption !== undefined)),
  );
  return { installation, stack };
};

const bindingPlanAction = (
  action: Plan.BindingAction,
): "binding-create" | "binding-update" | "binding-delete" | undefined => {
  if (action === "create") return "binding-create";
  if (action === "update") return "binding-update";
  if (action === "delete") return "binding-delete";
  return undefined;
};

const fingerprintPlan = Effect.fnUntraced(function* (
  installationName: string,
  accountId: string,
  plan: Plan.Plan,
) {
  const changes: InstallationPlan["changes"] = [
    ...Object.entries(plan.resources).flatMap(([id, node]) => [
      ...(node.action === "noop" ? [] : [{ id, action: node.action }]),
      ...node.bindings.flatMap((binding) => {
        const action = bindingPlanAction(binding.action);
        return action === undefined ? [] : [{ id: `${id}#${binding.sid}`, action }];
      }),
    ]),
    ...Object.entries(plan.deletions).flatMap(([id, node]) =>
      node === undefined ? [] : [{ id, action: "delete" as const }],
    ),
    ...Object.entries(plan.actions).flatMap(([id, node]) =>
      node.action === "noop" ? [] : [{ id, action: "run" as const }],
    ),
    ...Object.entries(plan.actionDeletions).flatMap(([id, node]) =>
      node === undefined ? [] : [{ id, action: "delete" as const }],
    ),
  ].sort(
    (left, right) => left.id.localeCompare(right.id) || left.action.localeCompare(right.action),
  );
  const fingerprintInput = {
    installationName,
    resources: Object.entries(plan.resources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, node]) => ({
        id,
        action: node.action,
        type: node.resource.Type,
        props: node.action === "noop" ? node.state.props : node.props,
        previousProps: node.state?.props,
        bindings: node.bindings.map((binding) => ({
          sid: binding.sid,
          action: binding.action,
          data: binding.data,
        })),
      })),
    deletions: Object.keys(plan.deletions).sort(),
    actions: Object.entries(plan.actions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, node]) => ({ id, action: node.action })),
    actionDeletions: Object.keys(plan.actionDeletions).sort(),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(fingerprintInput));
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", encoded),
    catch: (cause) =>
      new InstallationDeploymentError({ message: "Could not fingerprint deployment plan.", cause }),
  });
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    installationName,
    accountId,
    hasExistingResources: Object.values(plan.resources).some((node) => node.action !== "create"),
    fingerprint,
    changes,
  } satisfies InstallationPlan;
});

const planWithProfile = async (
  request: InstallationDeployRequest,
  root: string,
  adoption: AdoptionManifest | undefined,
  prebuiltWorkers: boolean,
): Promise<InstallationPlan> => {
  const { stack } = makeStack(request, adoption, prebuiltWorkers);
  return runWithProfile(request.profile, root, () =>
    provideAlchemy(
      evalStack(
        stack,
        (compiled) =>
          Effect.gen(function* () {
            const environment = yield* Cloudflare.CloudflareEnvironment;
            const { accountId } = yield* environment;
            const plan = yield* Plan.make(compiled);
            return yield* fingerprintPlan(request.installationName, accountId, plan);
          }).pipe(Effect.provide(cloudflareApiLive())),
        { stage: CLOUDFLARE_STAGE },
      ),
    ),
  );
};

const deployWithProfile = async (
  request: InstallationApplyRequest,
  root: string,
  adoption: AdoptionManifest | undefined,
  prebuiltWorkers: boolean,
): Promise<InstallationResult> => {
  const { installation, stack } = makeStack(request, adoption, prebuiltWorkers);
  return runWithProfile(request.profile, root, () =>
    provideAlchemy(
      evalStack(
        stack,
        (compiled) =>
          Effect.gen(function* () {
            const environment = yield* Cloudflare.CloudflareEnvironment;
            const { accountId } = yield* environment;
            if (accountId !== request.expectedAccountId)
              return yield* new InstallationDeploymentError({
                message: "The Cloudflare account changed after confirmation.",
              });
            const plan = yield* Plan.make(compiled);
            const summary = yield* fingerprintPlan(request.installationName, accountId, plan);
            if (summary.fingerprint !== request.expectedPlanFingerprint)
              return yield* new InstallationDeploymentError({
                message: "The deployment plan changed after confirmation.",
              });

            const containerChanged = isContainerPlanChanged(plan);
            let beforeSnapshot: ContainerControlPlaneSnapshot | undefined;
            let containerAppId: string | undefined;

            if (containerChanged) {
              const applications = yield* Containers.listContainerApplications({ accountId });
              const application = applications.find(
                (candidate) => candidate.name === installation.containerName,
              );
              if (application) {
                containerAppId = application.id;
                beforeSnapshot = yield* defaultReadControlPlane({
                  accountId,
                  applicationId: application.id,
                });
                yield* assertContainerBaselineSettled(beforeSnapshot);
              }
            }

            const output = yield* Apply.apply(plan);
            if (!output.url)
              return yield* new InstallationDeploymentError({
                message: "Deployed Worker has no URL.",
              });

            if (beforeSnapshot !== undefined && containerAppId !== undefined) {
              yield* waitForContainerRollout(beforeSnapshot, {
                accountId,
                applicationId: containerAppId,
              });
            }

            return {
              installationName: request.installationName,
              profile: request.profile,
              stackName: installation.stackName,
              stage: CLOUDFLARE_STAGE,
              accountId: output.accountId,
              workerName: output.workerName,
              runnerWorkerName: installation.runnerWorkerName,
              containerName: installation.containerName,
              kvTitle: installation.kvTitle,
              backupBucketName: installation.backupBucketName,
              ...(installation.preview === undefined
                ? {}
                : {
                    previewBase: installation.preview.base,
                    previewZoneId: installation.preview.zoneId,
                  }),
              ...(installation.evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
              host: output.url,
            } satisfies InstallationResult;
          }).pipe(Effect.provide(cloudflareApiLive())),
        { stage: CLOUDFLARE_STAGE },
      ),
    ),
  );
};

const inspectWithProfile = async (
  request: InstallationInspectRequest,
  root: string,
  adoption: AdoptionManifest | undefined,
  rootVerifierBootstrap?: string,
  expectedAccountId?: string,
): Promise<InstallationResult> => {
  const installation = makeInstallationTopology(
    request.installationName,
    adoption,
    previewConfiguration(request),
    request.evidenceEnabled === true,
  );
  return runWithProfile(request.profile, root, () =>
    provideAlchemy(
      Effect.gen(function* () {
        const environment = yield* Cloudflare.CloudflareEnvironment;
        const { accountId } = yield* environment;
        if (expectedAccountId !== undefined && accountId !== expectedAccountId)
          return yield* new InstallationDeploymentError({
            message: "The Cloudflare account changed after confirmation.",
          });
        const workerSettings = yield* Workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: installation.workerName,
        });
        const bindings = workerSettings.bindings ?? [];
        const bindingNames = new Set(bindings.map((binding) => binding.name));
        const requiredBindings = [
          "AUTH",
          "RUNNER_REGISTRY",
          "RUNNERS",
          "SANDBOX",
          "SANDBOX_CONFIG",
          "SESSIONS",
          "BACKUP_BUCKET",
          "ARTIFACT_BUCKET",
          "SANDBOX_BUNDLE_BUCKET",
        ];
        const sandboxBinding = bindings
          .filter(isDurableObjectBinding)
          .find((binding) => binding.name === "SANDBOX");
        const sessionsBinding = bindings
          .filter(isKvBinding)
          .find((binding) => binding.name === "SESSIONS");
        const backupBinding = bindings
          .filter(isR2Binding)
          .find((binding) => binding.name === "BACKUP_BUCKET");
        const artifactBinding = bindings
          .filter(isR2Binding)
          .find((binding) => binding.name === "ARTIFACT_BUCKET");
        const sandboxBundleBinding = bindings
          .filter(isR2Binding)
          .find((binding) => binding.name === "SANDBOX_BUNDLE_BUCKET");
        const previewBaseBinding = bindings
          .filter(isPlainTextBinding)
          .find((binding) => binding.name === "SCOTTY_PREVIEW_BASE");
        const evidenceEnabledBinding = bindings
          .filter(isPlainTextBinding)
          .find((binding) => binding.name === "SCOTTY_EVIDENCE_ENABLED");
        if (
          requiredBindings.some((name) => !bindingNames.has(name)) ||
          sandboxBinding?.namespaceId === undefined ||
          sessionsBinding?.namespaceId === undefined ||
          backupBinding?.bucketName !== installation.backupBucketName ||
          artifactBinding?.bucketName !== installation.artifactBucketName ||
          sandboxBundleBinding?.bucketName !== installation.sandboxBundleBucketName ||
          (installation.preview === undefined
            ? previewBaseBinding !== undefined
            : previewBaseBinding?.text !== installation.preview.base) ||
          (installation.evidenceEnabled === true
            ? evidenceEnabledBinding?.text !== "true"
            : evidenceEnabledBinding !== undefined)
        )
          return yield* new InstallationDeploymentError({
            message: "The named Worker does not have the required Scotty bindings.",
          });
        yield* Workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: installation.runnerWorkerName,
        }).pipe(Effect.asVoid);
        const applications = yield* Containers.listContainerApplications({ accountId });
        const application = applications.find(
          (candidate) => candidate.name === installation.containerName,
        );
        if (!application || application.durableObjects?.namespaceId !== sandboxBinding.namespaceId)
          return yield* new InstallationDeploymentError({
            message: "The named Scotty Container application is not bound to this Worker.",
          });
        const namespace = yield* KV.listNamespaces.items({ accountId, perPage: 100 }).pipe(
          Stream.filter((candidate) => candidate.title === installation.kvTitle),
          Stream.runHead,
        );
        if (Option.isNone(namespace) || namespace.value.id !== sessionsBinding.namespaceId)
          return yield* new InstallationDeploymentError({
            message: "The named Scotty KV namespace is not bound to this Worker.",
          });
        yield* R2.getBucket({
          accountId,
          bucketName: installation.backupBucketName,
        }).pipe(Effect.asVoid);
        yield* R2.getBucket({
          accountId,
          bucketName: installation.artifactBucketName,
        }).pipe(Effect.asVoid);
        yield* R2.getBucket({
          accountId,
          bucketName: installation.sandboxBundleBucketName,
        }).pipe(Effect.asVoid);
        if (installation.preview !== undefined) {
          const records = Array.from(
            yield* DNS.listRecords
              .items({
                zoneId: installation.preview.zoneId,
                name: { exact: `*.${installation.preview.base}` },
                type: "AAAA",
              })
              .pipe(Stream.runCollect),
          );
          const routes = Array.from(
            yield* Workers.listRoutes.items({ zoneId: installation.preview.zoneId }).pipe(
              Stream.filter((route) => route.pattern === `*.${installation.preview?.base}/*`),
              Stream.runCollect,
            ),
          );
          if (
            records.length !== 1 ||
            records[0]?.name !== `*.${installation.preview.base}` ||
            records[0].type !== "AAAA" ||
            records[0].content !== "100::" ||
            records[0].proxied !== true ||
            routes.length !== 1 ||
            routes[0]?.script !== installation.workerName
          )
            return yield* new InstallationDeploymentError({
              message: "The evidence preview DNS or Worker Route has drifted.",
            });
        }
        const scriptSubdomain = yield* Workers.getScriptSubdomain({
          accountId,
          scriptName: installation.workerName,
        });
        if (!scriptSubdomain.enabled)
          return yield* new InstallationDeploymentError({
            message: "The Scotty Worker has no workers.dev URL.",
          });
        const { subdomain } = yield* Workers.getSubdomain({ accountId });
        if (rootVerifierBootstrap !== undefined)
          yield* Workers.putScriptSecret({
            accountId,
            scriptName: installation.workerName,
            name: "SCOTTY_ROOT_VERIFIER_BOOTSTRAP",
            text: rootVerifierBootstrap,
            type: "plain_text",
          });
        return {
          installationName: request.installationName,
          profile: request.profile,
          stackName: installation.stackName,
          stage: CLOUDFLARE_STAGE,
          accountId,
          workerName: installation.workerName,
          runnerWorkerName: installation.runnerWorkerName,
          containerName: installation.containerName,
          kvTitle: installation.kvTitle,
          backupBucketName: installation.backupBucketName,
          ...(installation.preview === undefined
            ? {}
            : {
                previewBase: installation.preview.base,
                previewZoneId: installation.preview.zoneId,
              }),
          ...(installation.evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
          host: `https://${installation.workerName}.${subdomain}.workers.dev`,
        } satisfies InstallationResult;
      }).pipe(Effect.provide(cloudflareApiLive())),
    ),
  );
};

const prepareInstallationDeployment = async (
  deployment: { readonly root: string; readonly prebuiltWorkers: boolean },
  installation: ReturnType<typeof makeInstallationTopology>,
): Promise<void> => {
  await prepareInstallationContainerContext(deployment.root);
  await preparePrebuiltWorkerDeployment(deployment.root, deployment.prebuiltWorkers, installation);
};

export async function planInstallation(
  request: InstallationDeployRequest,
): Promise<InstallationPlan> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must remove its extracted payload on every exit
  try {
    const adoption = await readAdoptionManifest(
      request.adoptionManifestPath,
      request.installationName,
    );
    const installation = makeInstallationTopology(
      request.installationName,
      adoption,
      previewConfiguration(request),
      request.evidenceEnabled === true,
    );
    await prepareInstallationDeployment(deployment, installation);
    return await planWithProfile(request, deployment.root, adoption, deployment.prebuiltWorkers);
  } finally {
    await deployment.cleanup();
  }
}

export async function deployInstallation(
  request: InstallationApplyRequest,
): Promise<InstallationResult> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must remove its extracted payload on every exit
  try {
    const adoption = await readAdoptionManifest(
      request.adoptionManifestPath,
      request.installationName,
    );
    const installation = makeInstallationTopology(
      request.installationName,
      adoption,
      previewConfiguration(request),
      request.evidenceEnabled === true,
    );
    await prepareInstallationDeployment(deployment, installation);
    return await deployWithProfile(request, deployment.root, adoption, deployment.prebuiltWorkers);
  } finally {
    await deployment.cleanup();
  }
}

export async function planCreateInstallation(
  request: InstallationDeployRequest,
): Promise<InstallationPlan> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must remove its extracted payload on every exit
  try {
    const installation = makeInstallationTopology(
      request.installationName,
      undefined,
      previewConfiguration(request),
      request.evidenceEnabled === true,
    );
    await prepareInstallationDeployment(deployment, installation);
    return await planWithProfile(request, deployment.root, undefined, deployment.prebuiltWorkers);
  } finally {
    await deployment.cleanup();
  }
}

export async function createInstallation(
  request: InstallationCreateRequest,
): Promise<InstallationResult> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must remove its extracted payload on every exit
  try {
    const deployRequest = {
      installationName: request.installationName,
      profile: request.profile,
      ...(request.previewBase === undefined || request.previewZoneId === undefined
        ? {}
        : { previewBase: request.previewBase, previewZoneId: request.previewZoneId }),
      ...(request.evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
    };
    const installation = makeInstallationTopology(
      request.installationName,
      undefined,
      previewConfiguration(deployRequest),
      request.evidenceEnabled === true,
    );
    await prepareInstallationDeployment(deployment, installation);
    const plan = await planWithProfile(
      deployRequest,
      deployment.root,
      undefined,
      deployment.prebuiltWorkers,
    );
    if (
      plan.accountId !== request.expectedAccountId ||
      plan.fingerprint !== request.expectedPlanFingerprint
    ) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: confirmed account and plan must remain stable before mutation
      throw new InstallationDeploymentError({
        message: "The installation target changed after confirmation.",
      });
    }
    const unsafeFreshPlan =
      plan.hasExistingResources ||
      plan.changes.length === 0 ||
      plan.changes.some(
        (change) =>
          change.action !== "create" &&
          change.action !== "run" &&
          change.action !== "binding-create",
      );
    const unsafeResumePlan = plan.changes.some(
      (change) =>
        change.action !== "create" &&
        change.action !== "update" &&
        change.action !== "run" &&
        change.action !== "binding-create" &&
        change.action !== "binding-update",
    );
    if (
      (request.mode === "fresh" && unsafeFreshPlan) ||
      (request.mode === "resume" && unsafeResumePlan)
    ) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: create replay rejects unowned, destructive, or ambiguous resource plans
      throw new InstallationDeploymentError({
        message: "The named Scotty installation cannot be created or safely resumed.",
      });
    }
    const deployed =
      plan.changes.length === 0
        ? await inspectWithProfile(
            request,
            deployment.root,
            undefined,
            request.rootVerifierBootstrap,
            request.expectedAccountId,
          )
        : await deployWithProfile(
            {
              ...deployRequest,
              expectedAccountId: request.expectedAccountId,
              expectedPlanFingerprint: plan.fingerprint,
            },
            deployment.root,
            undefined,
            deployment.prebuiltWorkers,
          );
    if (plan.changes.length > 0)
      await inspectWithProfile(
        request,
        deployment.root,
        undefined,
        request.rootVerifierBootstrap,
        request.expectedAccountId,
      );
    return deployed;
  } finally {
    await deployment.cleanup();
  }
}

export async function uninstallInstallation(
  request: InstallationUninstallRequest,
): Promise<InstallationUninstallResult> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must remove its extracted payload on every exit
  try {
    const adoption = await readAdoptionManifest(
      request.adoptionManifestPath,
      request.installationName,
    );
    const installation = makeInstallationTopology(
      request.installationName,
      adoption,
      previewConfiguration(request),
      request.evidenceEnabled === true,
    );
    await prepareInstallationDeployment(deployment, installation);
    const { stack } = makeStack(request, adoption, deployment.prebuiltWorkers);
    return await runWithProfile(request.profile, deployment.root, () =>
      provideAlchemy(
        evalStack(
          stack,
          (compiled) =>
            Effect.gen(function* () {
              const environment = yield* Cloudflare.CloudflareEnvironment;
              const { accountId } = yield* environment;
              if (
                accountId !== request.expectedAccountId ||
                installation.workerName !== request.expectedWorkerName ||
                installation.runnerWorkerName !== request.expectedRunnerWorkerName ||
                installation.containerName !== request.expectedContainerName ||
                installation.kvTitle !== request.expectedKvTitle ||
                installation.backupBucketName !== request.expectedBackupBucketName ||
                installation.preview?.base !== request.expectedPreviewBase ||
                installation.preview?.zoneId !== request.expectedPreviewZoneId
              )
                return yield* new InstallationDeploymentError({
                  message: "The uninstall target no longer matches the saved installation.",
                });

              const destroyPlan = yield* Plan.make({
                ...compiled,
                resources: {},
                bindings: {},
                actions: {},
                output: {},
              });
              const missingOwnership = Object.keys(compiled.resources).filter(
                (id) => destroyPlan.deletions[id] === undefined,
              );
              if (missingOwnership.length > 0)
                return yield* new InstallationDeploymentError({
                  message: `Alchemy state does not prove ownership of every installation resource: ${missingOwnership.join(", ")}`,
                });
              const ownedPreviewDeletion =
                installation.preview === undefined
                  ? undefined
                  : readOwnedPreviewTopologyDeletion(
                      Object.values(destroyPlan.deletions),
                      installation.preview,
                      installation.workerName,
                    );
              if (installation.preview !== undefined && ownedPreviewDeletion === undefined)
                return yield* new PreviewCleanupOwnershipError({
                  message:
                    "Alchemy state does not prove ownership of the evidence preview route and DNS record",
                  hint: "No preview resource was deleted. Verify Alchemy state ownership, then remove the wildcard route and DNS record manually or rerun uninstall after restoring ownership proof.",
                });

              const applications = yield* Containers.listContainerApplications({ accountId });
              const application = applications.find(
                (candidate) => candidate.name === installation.containerName,
              );
              if (application)
                yield* Containers.deleteContainerApplication({
                  accountId,
                  applicationId: application.id,
                }).pipe(Effect.catchTag("ContainerApplicationNotFound", () => Effect.void));

              const deletedPreviewResources: string[] = [];
              if (installation.preview !== undefined && ownedPreviewDeletion !== undefined) {
                const previewDnsName = `*.${installation.preview.base}`;
                const previewRoutePattern = `${previewDnsName}/*`;
                yield* Workers.deleteRoute({
                  zoneId: installation.preview.zoneId,
                  routeId: ownedPreviewDeletion.routeId,
                }).pipe(Effect.catchTag("RouteNotFound", () => Effect.void));
                yield* DNS.deleteRecord({
                  zoneId: installation.preview.zoneId,
                  dnsRecordId: ownedPreviewDeletion.dnsRecordId,
                }).pipe(
                  // Distilled maps HTTP 404 to this shared error even though this generated
                  // operation's static error union omits non-default HTTP status errors.
                  Effect.mapError((error): DNS.DeleteRecordError | CloudflareNotFound => error),
                  Effect.catchTag("NotFound", () => Effect.void),
                );
                deletedPreviewResources.push(previewRoutePattern, previewDnsName);
              }

              yield* Workers.deleteScript({
                accountId,
                scriptName: installation.runnerWorkerName,
                force: true,
              }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
              yield* Workers.deleteScript({
                accountId,
                scriptName: installation.workerName,
                force: true,
              }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));

              const retainedBuckets = [
                installation.backupBucketName,
                installation.artifactBucketName,
                installation.sandboxBundleBucketName,
              ];
              const retainedData = [installation.kvTitle, ...retainedBuckets];
              const deletedData: string[] = [];
              if (request.deleteData) {
                const namespace = yield* KV.listNamespaces.items({ accountId, perPage: 100 }).pipe(
                  Stream.filter((candidate) => candidate.title === installation.kvTitle),
                  Stream.runHead,
                );
                if (Option.isSome(namespace)) {
                  yield* KV.deleteNamespace({
                    accountId,
                    namespaceId: namespace.value.id,
                  }).pipe(Effect.catchTag("NamespaceNotFound", () => Effect.void));
                  deletedData.push(installation.kvTitle);
                }

                for (const bucketName of retainedBuckets) {
                  yield* R2.listObjects.items({ accountId, bucketName, perPage: 1000 }).pipe(
                    Stream.filter(
                      (object): object is typeof object & { key: string } =>
                        typeof object.key === "string" && object.key.length > 0,
                    ),
                    Stream.map((object) => object.key),
                    Stream.runForEachArray((keys) =>
                      R2.deleteObjects({
                        accountId,
                        bucketName,
                        body: [...keys],
                      }),
                    ),
                    Effect.catchTag("NoSuchBucket", () => Effect.void),
                  );
                  yield* R2.deleteBucket({ accountId, bucketName }).pipe(
                    Effect.catchTag("NoSuchBucket", () => Effect.void),
                  );
                  deletedData.push(bucketName);
                }
              }

              // Retained resources stay in Alchemy state until every direct deletion succeeds.
              // This preserves ownership proof across interruption and makes retries safe.
              yield* Apply.apply(destroyPlan);
              return {
                installationName: request.installationName,
                deletedCompute: [
                  installation.containerName,
                  installation.runnerWorkerName,
                  installation.workerName,
                  ...deletedPreviewResources,
                ],
                retainedData: request.deleteData ? [] : retainedData,
                deletedData,
              } satisfies InstallationUninstallResult;
            }).pipe(Effect.provide(cloudflareApiLive())),
          { stage: CLOUDFLARE_STAGE },
        ),
      ),
    );
  } finally {
    await deployment.cleanup();
  }
}

export async function inspectInstallation(
  request: InstallationInspectRequest,
): Promise<InstallationResult> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: standalone inspection must remove its extracted payload on every exit
  try {
    const adoption = await readAdoptionManifest(
      request.adoptionManifestPath,
      request.installationName,
    );
    return await inspectWithProfile(request, deployment.root, adoption);
  } finally {
    await deployment.cleanup();
  }
}

export async function recoverInstallation(
  request: InstallationRecoverRequest,
): Promise<InstallationResult> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: standalone recovery must remove its extracted payload on every exit
  try {
    const adoption = await readAdoptionManifest(
      request.adoptionManifestPath,
      request.installationName,
    );
    const installation = makeInstallationTopology(
      request.installationName,
      adoption,
      previewConfiguration(request),
      request.evidenceEnabled === true,
    );
    if (
      installation.workerName !== request.expectedWorkerName ||
      installation.runnerWorkerName !== request.expectedRunnerWorkerName ||
      installation.containerName !== request.expectedContainerName ||
      installation.kvTitle !== request.expectedKvTitle ||
      installation.backupBucketName !== request.expectedBackupBucketName ||
      installation.preview?.base !== request.expectedPreviewBase ||
      installation.preview?.zoneId !== request.expectedPreviewZoneId
    ) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise recovery adapter rejects a mapping that changed after confirmation
      throw new InstallationDeploymentError({
        message: "The recovery resource mapping changed after confirmation.",
      });
    }
    return await inspectWithProfile(
      request,
      deployment.root,
      adoption,
      request.rootVerifierBootstrap,
      request.expectedAccountId,
    );
  } finally {
    await deployment.cleanup();
  }
}

export { DEPLOYMENT_ARCHIVE_NAME, DEPLOYMENT_INPUTS };
