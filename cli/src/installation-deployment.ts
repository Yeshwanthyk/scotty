import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Cloudflare from "alchemy/Cloudflare";
import { deploy } from "alchemy/Deploy";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Data, Effect, Layer, Option } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  cloudflareStack,
  expectedCloudflareResourceConfirmation,
  expectedCloudflareStackApproval,
} from "../../infra/cloudflare-stack.ts";
import {
  adoptionMatchesInstallation,
  CLOUDFLARE_STAGE,
  decodeAdoptionManifestJson,
  makeInstallationTopology,
  type AdoptionManifest,
} from "../../infra/installation.ts";
import { CONTAINER_INPUTS, DEPLOYMENT_INPUTS } from "./deployment-inputs.ts";
import type { InstallationDeployRequest, InstallationDeployResult } from "./services.ts";

const DEPLOYMENT_ARCHIVE_NAME = "scotty-deployment.tar.gz";
const CONTAINER_CONTEXT_PATH = ".alchemy/scotty-container-context";
class InstallationDeploymentError extends Data.TaggedError("InstallationDeploymentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const embeddedDeploymentArchive = (): Blob | undefined =>
  Bun.embeddedFiles.find((file) => {
    const name = Reflect.get(file, "name");
    return (
      typeof name === "string" &&
      (name === DEPLOYMENT_ARCHIVE_NAME || /^scotty-deployment-[a-f0-9]+\.tar\.gz$/u.test(name))
    );
  });

const sourceRoot = (): string => resolve(import.meta.dir, "../..");

const copyInputs = async (
  root: string,
  destination: string,
  inputs: ReadonlyArray<string>,
): Promise<void> => {
  for (const input of inputs) {
    const output = join(destination, input);
    await mkdir(dirname(output), { recursive: true });
    await cp(join(root, input), output, { recursive: true });
  }
};

const prepareDeploymentRoot = async (): Promise<{
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}> => {
  const archive = embeddedDeploymentArchive();
  if (!archive) return { root: sourceRoot(), cleanup: async () => undefined };
  const root = await mkdtemp(join(tmpdir(), "scotty-deployment-"));
  const bytes = await archive.arrayBuffer();
  await new Bun.Archive(bytes).extract(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const prepareContainerContext = async (root: string): Promise<void> => {
  const context = join(root, CONTAINER_CONTEXT_PATH);
  await rm(context, { recursive: true, force: true });
  await copyInputs(root, context, CONTAINER_INPUTS);
};

const readAdoptionManifest = async (
  path: string | undefined,
  installationName: string,
): Promise<AdoptionManifest | undefined> => {
  if (!path) return undefined;
  const text = await Bun.file(path).text();
  const decoded = decodeAdoptionManifestJson(text);
  if (Option.isNone(decoded) || !adoptionMatchesInstallation(decoded.value, installationName)) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise file adapter rejects invalid machine-local adoption input before Alchemy evaluation
    throw new InstallationDeploymentError({
      message: "Adoption manifest is invalid or names a different installation.",
    });
  }
  return decoded.value;
};

const deployWithProfile = async (
  request: InstallationDeployRequest,
  root: string,
  adoption: AdoptionManifest | undefined,
): Promise<InstallationDeployResult> => {
  const installation = makeInstallationTopology(request.installationName, adoption);
  const previousProfile = process.env.ALCHEMY_PROFILE;
  const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
  const previousDirectory = process.cwd();
  process.env.ALCHEMY_PROFILE = request.profile;
  process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
  process.chdir(root);

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
    }),
  );

  const program = Effect.gen(function* () {
    const output = yield* deploy({ stack, stage: CLOUDFLARE_STAGE });
    if (!output.url)
      return yield* new InstallationDeploymentError({
        message: "Deployed Worker has no URL.",
      });
    yield* Workers.putScriptSecret({
      accountId: output.accountId,
      scriptName: output.workerName,
      name: "SCOTTY_TOKEN",
      text: request.token,
      type: "secret_text",
    }).pipe(Effect.provide(Cloudflare.CloudflareApiLive()));
    return {
      installationName: request.installationName,
      profile: request.profile,
      stackName: installation.stackName,
      stage: CLOUDFLARE_STAGE,
      accountId: output.accountId,
      workerName: output.workerName,
      host: output.url,
    } satisfies InstallationDeployResult;
  }).pipe(
    Effect.provide(Cloudflare.state()),
    Effect.provideService(ArtifactStore, createArtifactStore()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(LoggingCli, AlchemyContextLive),
        Layer.mergeAll(
          PlatformServices,
          NodeServices.layer,
          FetchHttpClient.layer,
          Layer.provide(ProfileLive, PlatformServices),
          Layer.provide(CredentialsStoreLive, PlatformServices),
        ),
      ),
    ),
  );

  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must restore process-wide profile and cwd state
  try {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: standalone installer owns the one Alchemy Effect-to-Promise execution
    return await Effect.runPromise(program);
  } finally {
    process.chdir(previousDirectory);
    if (previousProfile === undefined) delete process.env.ALCHEMY_PROFILE;
    else process.env.ALCHEMY_PROFILE = previousProfile;
    if (previousTelemetry === undefined) delete process.env.ALCHEMY_TELEMETRY_DISABLED;
    else process.env.ALCHEMY_TELEMETRY_DISABLED = previousTelemetry;
  }
};

export async function deployInstallation(
  request: InstallationDeployRequest,
): Promise<InstallationDeployResult> {
  const deployment = await prepareDeploymentRoot();
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise deployment adapter must remove its extracted payload on every exit
  try {
    const adoption = await readAdoptionManifest(
      request.adoptionManifestPath,
      request.installationName,
    );
    await prepareContainerContext(deployment.root);
    return await deployWithProfile(request, deployment.root, adoption);
  } finally {
    await deployment.cleanup();
  }
}

export { DEPLOYMENT_ARCHIVE_NAME, DEPLOYMENT_INPUTS };
