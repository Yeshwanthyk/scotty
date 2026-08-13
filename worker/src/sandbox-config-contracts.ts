import { Schema } from "effect";

export const SandboxDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SkillNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
);
export const PiPackageNameSchema = Schema.String.check(
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);
export const GitCommitSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

export const SandboxFileModeClassSchema = Schema.Literals(["regular", "executable"]);
export const SandboxFileRecordSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  size: Schema.Int,
  modeClass: SandboxFileModeClassSchema,
  digest: SandboxDigestSchema,
});
export const SandboxSkillManifestSchema = Schema.Struct({
  name: SkillNameSchema,
  digest: SandboxDigestSchema,
  hasExecutableContent: Schema.Boolean,
  files: Schema.Array(SandboxFileRecordSchema),
});
export const SandboxPiPackageManifestSchema = Schema.Struct({
  name: PiPackageNameSchema,
  repository: Schema.NonEmptyString,
  requestedRef: Schema.NonEmptyString,
  commit: GitCommitSchema,
  lockDigest: Schema.NullOr(SandboxDigestSchema),
  digest: SandboxDigestSchema,
  files: Schema.Array(SandboxFileRecordSchema),
});
export const SandboxBundleManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  skills: Schema.Array(SandboxSkillManifestSchema),
  piPackages: Schema.Array(SandboxPiPackageManifestSchema),
});
export type SandboxBundleManifest = typeof SandboxBundleManifestSchema.Type;

export const SandboxConfigStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: NonNegativeIntSchema,
  activeDigest: Schema.NullOr(SandboxDigestSchema),
});
export type SandboxConfigStatus = typeof SandboxConfigStatusSchema.Type;

export const SandboxConfigLastSyncSchema = Schema.Struct({
  idempotencyKey: Schema.NonEmptyString,
  digest: SandboxDigestSchema,
  expectedRevision: Schema.NullOr(NonNegativeIntSchema),
  status: SandboxConfigStatusSchema,
});
export type SandboxConfigLastSync = typeof SandboxConfigLastSyncSchema.Type;

export const SandboxConfigAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeIntSchema,
  activeDigest: Schema.NullOr(SandboxDigestSchema),
  lastSync: Schema.NullOr(SandboxConfigLastSyncSchema),
});
export type SandboxConfigAuthority = typeof SandboxConfigAuthoritySchema.Type;

export const SandboxActivateInputSchema = Schema.Struct({
  digest: SandboxDigestSchema,
  idempotencyKey: Schema.NonEmptyString,
  expectedRevision: Schema.NullOr(NonNegativeIntSchema),
});
export type SandboxActivateInput = typeof SandboxActivateInputSchema.Type;
