import { Schema } from "effect";
import {
  DeployedSnapshotSchema,
  DigestSchema,
  NonNegativeRevisionSchema,
  PluginBundleManifestSchema,
  SandboxActivationSchema,
} from "../../protocol/sandbox-config";

export * from "../../protocol/sandbox-config";
export const SandboxDigestSchema = DigestSchema;

export const SandboxConfigStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installationName: Schema.NullOr(Schema.NonEmptyString),
  cloudflareAccountId: Schema.NullOr(Schema.NonEmptyString),
  revision: NonNegativeRevisionSchema,
  activeSnapshot: Schema.NullOr(SandboxActivationSchema),
});
export type SandboxConfigStatus = typeof SandboxConfigStatusSchema.Type;

export const SandboxActivateInputSchema = Schema.Struct({
  installationName: Schema.NonEmptyString,
  cloudflareAccountId: Schema.NonEmptyString,
  snapshotDigest: DigestSchema,
  configDigest: DigestSchema,
  expectedRevision: NonNegativeRevisionSchema,
  idempotencyKey: Schema.NonEmptyString,
});
export type SandboxActivateInput = typeof SandboxActivateInputSchema.Type;

export const SandboxConfigLastSyncSchema = Schema.Struct({
  idempotencyKey: Schema.NonEmptyString,
  input: SandboxActivateInputSchema,
  status: SandboxConfigStatusSchema,
});
export type SandboxConfigLastSync = typeof SandboxConfigLastSyncSchema.Type;

export const SandboxConfigAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  installationName: Schema.NullOr(Schema.NonEmptyString),
  cloudflareAccountId: Schema.NullOr(Schema.NonEmptyString),
  revision: NonNegativeRevisionSchema,
  activeSnapshot: Schema.NullOr(SandboxActivationSchema),
  lastSync: Schema.NullOr(SandboxConfigLastSyncSchema),
});
export type SandboxConfigAuthority = typeof SandboxConfigAuthoritySchema.Type;

export const PreparedSnapshotProofSchema = Schema.Struct({
  snapshotDigest: DigestSchema,
  pluginBundleDigest: DigestSchema,
});
export type PreparedSnapshotProof = typeof PreparedSnapshotProofSchema.Type;

export { DeployedSnapshotSchema, PluginBundleManifestSchema };
