import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  cloudflareStack,
  expectedCloudflareResourceConfirmation,
  expectedCloudflareStackApproval,
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

export default Alchemy.Stack(
  installation.stackName,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    return yield* cloudflareStack({
      stage,
      telemetryDisabled: process.env.ALCHEMY_TELEMETRY_DISABLED === "1",
      installation,
      resourceConfirmation: process.env.SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED,
      approval: process.env.SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL,
    });
  }),
);

export const expectedResourceConfirmation = expectedCloudflareResourceConfirmation(installation);
export const expectedDeployApproval = expectedCloudflareStackApproval(installation);
