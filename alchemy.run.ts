import { RuntimeImageCompatibilityEvidenceSchema } from "./protocol/runtime-image-compatibility";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fileURLToPath } from "node:url";
import {
  assertCloudflareDeploymentAssets,
  cloudflareStack,
  expectedCloudflareResourceConfirmation,
  expectedCloudflareStackApproval,
  makeCloudflareStackTopology,
} from "./infra/cloudflare-stack.ts";
import {
  decodeInstallationPreviewConfiguration,
  makeInstallationTopology,
  parseInstallationName,
  type InstallationPreviewConfiguration,
} from "./infra/installation.ts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point reports missing operator metadata
    throw new Error(`Scotty deployment requires ${name}.`);
  }
  return value;
};

const installationName = required("SCOTTY_INSTALLATION_NAME");
if (Option.isNone(parseInstallationName(installationName))) {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects an unsafe resource namespace
  throw new Error("SCOTTY_INSTALLATION_NAME must be a 2-32 character lowercase name.");
}

const previewBase = required("SCOTTY_PREVIEW_BASE");
const previewZoneId = required("SCOTTY_PREVIEW_ZONE_ID");
const decodedPreview = decodeInstallationPreviewConfiguration({
  base: previewBase,
  zoneId: previewZoneId,
});
if (Option.isNone(decodedPreview)) {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects partial or malformed explicit preview topology
  throw new Error(
    "SCOTTY_PREVIEW_BASE and SCOTTY_PREVIEW_ZONE_ID must both name the explicit preview topology.",
  );
}
const preview: InstallationPreviewConfiguration = decodedPreview.value;

const installation = makeInstallationTopology(installationName, preview, true);
const expectedAccountId = required("SCOTTY_EXPECTED_ACCOUNT_ID");
if (!/^[0-9a-f]{32}$/u.test(expectedAccountId)) {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects an invalid account fence
  throw new Error("SCOTTY_EXPECTED_ACCOUNT_ID must identify the authorized Cloudflare account.");
}
const decodeExpectedAccountId = Schema.decodeUnknownEffect(Schema.Literal(expectedAccountId));
const containerImageDigest = required("SCOTTY_CONTAINER_IMAGE_DIGEST");
const decodeRuntimeCompatibility = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeImageCompatibilityEvidenceSchema),
);
if (!/^sha256:[0-9a-f]{64}$/u.test(containerImageDigest)) {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects an unverified image selector
  throw new Error("SCOTTY_CONTAINER_IMAGE_DIGEST must identify a verified prepushed image.");
}
const deploymentRoot = fileURLToPath(new URL(".", import.meta.url));
assertCloudflareDeploymentAssets(deploymentRoot, makeCloudflareStackTopology(installation));

export default Alchemy.Stack(
  installation.stackName,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const environment = yield* Cloudflare.CloudflareEnvironment;
    const { accountId } = yield* environment;
    yield* decodeExpectedAccountId(accountId).pipe(
      Effect.mapError((cause) => new Config.ConfigError(cause)),
    );
    const runtimeCompatibility =
      process.env.SCOTTY_RUNTIME_IMAGE_COMPATIBILITY === undefined
        ? undefined
        : yield* decodeRuntimeCompatibility(process.env.SCOTTY_RUNTIME_IMAGE_COMPATIBILITY).pipe(
            Effect.mapError((cause) => new Config.ConfigError(cause)),
          );
    return yield* cloudflareStack({
      stage,
      telemetryDisabled: process.env.ALCHEMY_TELEMETRY_DISABLED === "1",
      deploymentRoot,
      installation,
      containerImage: {
        digest: containerImageDigest,
        ...(runtimeCompatibility === undefined ? {} : { runtimeCompatibility }),
      },
      resourceConfirmation: process.env.SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED,
      approval: process.env.SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL,
    });
  }),
);

export const expectedResourceConfirmation = expectedCloudflareResourceConfirmation(installation);
export const expectedDeployApproval = expectedCloudflareStackApproval(installation);
