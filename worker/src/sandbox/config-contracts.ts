import { Schema } from "effect";

export const SandboxDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SkillNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
);
export const PiPackageNameSchema = Schema.String.check(
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);

export const SandboxFileModeClassSchema = Schema.Literals(["regular", "executable"]);
export const SandboxFileRecordSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  size: Schema.Int,
  modeClass: SandboxFileModeClassSchema,
  digest: SandboxDigestSchema,
});
export const SandboxBundleItemKindSchema = Schema.Literals([
  "skill",
  "package",
  "tool",
  "extension",
]);
export const SandboxBundleItemShapeSchema = Schema.Literals(["file", "directory"]);
export const SandboxBundleItemNameSchema = Schema.String.check(
  Schema.makeFilter(
    (name) =>
      name.length > 0 &&
      name !== "." &&
      name !== ".." &&
      !name.includes("/") &&
      !name.includes("\\") &&
      !name.includes("\0"),
    { expected: "a safe bundle item name" },
  ),
);
const SandboxBundleItemContentSchema = {
  shape: SandboxBundleItemShapeSchema,
  digest: SandboxDigestSchema,
  files: Schema.Array(SandboxFileRecordSchema),
} as const;
export const SandboxBundleItemManifestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("skill"),
    name: SkillNameSchema,
    ...SandboxBundleItemContentSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("package"),
    name: PiPackageNameSchema,
    ...SandboxBundleItemContentSchema,
  }),
  Schema.Struct({
    kind: Schema.Literals(["tool", "extension"]),
    name: SandboxBundleItemNameSchema,
    ...SandboxBundleItemContentSchema,
  }),
]);
export const SandboxBundleManifestSchema = Schema.Struct({
  items: Schema.Array(SandboxBundleItemManifestSchema),
});
export type SandboxBundleItemKind = typeof SandboxBundleItemKindSchema.Type;
export type SandboxBundleItemManifest = typeof SandboxBundleItemManifestSchema.Type;
export type SandboxBundleManifest = typeof SandboxBundleManifestSchema.Type;

export const SandboxConfigStatusSchema = Schema.Struct({
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
