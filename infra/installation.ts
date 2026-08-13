import { Option, Schema } from "effect";

export const INSTALLATION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
export const CLOUDFLARE_STAGE = "production";

const InstallationNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(INSTALLATION_NAME_PATTERN, {
      expected: "a 2-32 character lowercase installation name",
    }),
  ),
);

const ResourceNameSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)),
);

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

export const AdoptionManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installationName: InstallationNameSchema,
  stackName: Schema.optionalKey(Schema.NonEmptyString),
  resources: Schema.optionalKey(
    Schema.Struct({
      workerName: Schema.optionalKey(ResourceNameSchema),
      runnerWorkerName: Schema.optionalKey(ResourceNameSchema),
      containerName: Schema.optionalKey(Schema.NonEmptyString),
      kvTitle: Schema.optionalKey(Schema.NonEmptyString),
      backupBucketName: Schema.optionalKey(Schema.NonEmptyString),
      artifactBucketName: Schema.optionalKey(Schema.NonEmptyString),
      sandboxBundleBucketName: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  logicalIds: Schema.optionalKey(
    Schema.Struct({
      worker: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  preview: Schema.optionalKey(InstallationPreviewConfigurationSchema),
});
export type AdoptionManifest = typeof AdoptionManifestSchema.Type;

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

export const decodeAdoptionManifest = Schema.decodeUnknownOption(AdoptionManifestSchema);
export const decodeAdoptionManifestJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(AdoptionManifestSchema),
);

export function makeInstallationTopology(
  installationName: string,
  adoption?: AdoptionManifest,
  preview: InstallationPreviewConfiguration | undefined = adoption?.preview,
  evidenceEnabled = false,
): InstallationTopology {
  const prefix = `scotty-${installationName}`;
  const resources = adoption?.resources;
  return {
    installationName,
    stackName: adoption?.stackName ?? `Scotty-${installationName}`,
    stage: CLOUDFLARE_STAGE,
    workerName: resources?.workerName ?? `${prefix}-worker`,
    runnerWorkerName: resources?.runnerWorkerName ?? `${prefix}-runner`,
    containerName: resources?.containerName ?? `${prefix}-sandbox`,
    kvTitle: resources?.kvTitle ?? `${prefix}-sessions`,
    backupBucketName: resources?.backupBucketName ?? `${prefix}-backups`,
    artifactBucketName: resources?.artifactBucketName ?? `${prefix}-artifacts`,
    sandboxBundleBucketName: resources?.sandboxBundleBucketName ?? `${prefix}-sandbox-bundles`,
    workerLogicalId: adoption?.logicalIds?.worker ?? "Worker",
    ...(preview === undefined ? {} : { preview }),
    ...(evidenceEnabled ? { evidenceEnabled: true as const } : {}),
  };
}

export function parseInstallationName(value: string): Option.Option<string> {
  return INSTALLATION_NAME_PATTERN.test(value) ? Option.some(value) : Option.none();
}

export function adoptionMatchesInstallation(
  adoption: AdoptionManifest,
  installationName: string,
): boolean {
  return adoption.installationName === installationName;
}
