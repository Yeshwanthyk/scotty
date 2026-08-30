import { Option, Schema } from "effect";

export const INSTALLATION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
export const CLOUDFLARE_STAGE = "production";

export const PreviewBaseSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
      { expected: "a lowercase DNS preview base without a wildcard or scheme" },
    ),
  ),
);
const CloudflareZoneIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
);

export const InstallationPreviewConfigurationSchema = Schema.Struct({
  base: PreviewBaseSchema,
  zoneId: CloudflareZoneIdSchema,
});
export type InstallationPreviewConfiguration = typeof InstallationPreviewConfigurationSchema.Type;
export const decodeInstallationPreviewConfiguration = Schema.decodeUnknownOption(
  InstallationPreviewConfigurationSchema,
  { onExcessProperty: "error" },
);

export interface InstallationTopology {
  readonly installationName: string;
  readonly stackName: string;
  readonly stage: typeof CLOUDFLARE_STAGE;
  readonly workerName: string;
  readonly runnerWorkerName: string;
  readonly containerName: string;
  readonly kvTitle: string;
  readonly backupBucketName: string;
  readonly artifactBucketName: string;
  readonly sandboxBundleBucketName: string;
  readonly workerLogicalId: string;
  readonly preview?: InstallationPreviewConfiguration;
  readonly evidenceEnabled?: true;
}

function installationResourceNames(prefix: string) {
  return {
    workerName: `${prefix}-worker`,
    runnerWorkerName: `${prefix}-runner`,
    containerName: `${prefix}-sandbox`,
    kvTitle: `${prefix}-sessions`,
    backupBucketName: `${prefix}-backups`,
    artifactBucketName: `${prefix}-artifacts`,
    sandboxBundleBucketName: `${prefix}-sandbox-bundles`,
  };
}

export function makeInstallationTopology(
  installationName: string,
  preview?: InstallationPreviewConfiguration,
  evidenceEnabled = false,
): InstallationTopology {
  const prefix = `scotty-${installationName}`;
  return {
    installationName,
    stackName: `Scotty-${installationName}`,
    stage: CLOUDFLARE_STAGE,
    ...installationResourceNames(prefix),
    workerLogicalId: "Worker",
    ...(preview === undefined ? {} : { preview }),
    ...(evidenceEnabled ? { evidenceEnabled: true as const } : {}),
  };
}

export function parseInstallationName(value: string): Option.Option<string> {
  return INSTALLATION_NAME_PATTERN.test(value) ? Option.some(value) : Option.none();
}
