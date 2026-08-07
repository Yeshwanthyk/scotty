import { readFileSync } from "node:fs";
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
  adoptionMatchesInstallation,
  decodeAdoptionManifestJson,
  decodeInstallationPreviewConfiguration,
  makeInstallationTopology,
  parseInstallationName,
  type AdoptionManifest,
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

const adoptionPath = process.env.SCOTTY_ADOPTION_MANIFEST?.trim();
let adoption: AdoptionManifest | undefined;
if (adoptionPath) {
  const decoded = decodeAdoptionManifestJson(readFileSync(adoptionPath, "utf8"));
  if (Option.isNone(decoded) || !adoptionMatchesInstallation(decoded.value, installationName)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects invalid machine-local adoption metadata
    throw new Error("SCOTTY_ADOPTION_MANIFEST is invalid or names a different installation.");
  }
  adoption = decoded.value;
}

const previewBase = process.env.SCOTTY_PREVIEW_BASE?.trim();
const previewZoneId = process.env.SCOTTY_PREVIEW_ZONE_ID?.trim();
let preview: InstallationPreviewConfiguration | undefined;
if (previewBase !== undefined || previewZoneId !== undefined) {
  const decoded = decodeInstallationPreviewConfiguration({
    base: previewBase,
    zoneId: previewZoneId,
  });
  if (Option.isNone(decoded)) {
    // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects partial or malformed explicit preview topology
    throw new Error(
      "SCOTTY_PREVIEW_BASE and SCOTTY_PREVIEW_ZONE_ID must both name the explicit preview topology.",
    );
  }
  preview = decoded.value;
}

const evidenceEnabled = process.env.SCOTTY_EVIDENCE_ENABLED === "true";
if (evidenceEnabled && preview === undefined) {
  // oxlint-disable-next-line scotty/no-error-constructor, scotty/no-try-catch-or-throw -- boundary: local Alchemy entry point rejects an enabled bridge without explicit preview authority
  throw new Error("SCOTTY_EVIDENCE_ENABLED requires the explicit preview topology.");
}

const installation = makeInstallationTopology(installationName, adoption, preview, evidenceEnabled);

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
