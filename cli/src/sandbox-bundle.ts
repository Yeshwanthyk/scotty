import { createHash } from "node:crypto";
import { Schema } from "effect";
import { CliError, EXIT } from "./core";
import {
  GitCommitSchema,
  GitRepositorySchema,
  PiPackageNameSchema,
  SANDBOX_CONFIG_SCHEMA_VERSION,
  SandboxDigestSchema,
  SkillNameSchema,
  formatSandboxStatus,
  type SandboxConfig,
} from "./sandbox-config";

export const SANDBOX_BUNDLE_SCHEMA_VERSION = 1 as const;

export const SANDBOX_MAX_FILE_BYTES = 1_048_576;
export const SANDBOX_MAX_SKILL_BYTES = 4_194_304;
export const SANDBOX_MAX_SKILL_FILES = 128;
export const SANDBOX_MAX_PACKAGE_BYTES = 33_554_432;
export const SANDBOX_MAX_PACKAGE_FILES = 4_096;
export const SANDBOX_MAX_BUNDLE_FILES = 8_192;
export const SANDBOX_MAX_PATH_BYTES = 240;

export const SANDBOX_EXCLUDED_BASENAMES = new Set([
  ".DS_Store",
  ".cache",
  ".git",
  ".hg",
  ".mypy_cache",
  ".npm",
  ".pytest_cache",
  ".svn",
  "Thumbs.db",
  "__pycache__",
]);

export const SANDBOX_EXCLUDED_SUFFIXES = [".pyc", ".swp", ".swo"];

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
  repository: GitRepositorySchema,
  requestedRef: Schema.NonEmptyString,
  commit: GitCommitSchema,
  lockDigest: Schema.NullOr(SandboxDigestSchema),
  digest: SandboxDigestSchema,
  files: Schema.Array(SandboxFileRecordSchema),
});
export const SandboxBundleManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SANDBOX_BUNDLE_SCHEMA_VERSION),
  skills: Schema.Array(SandboxSkillManifestSchema),
  piPackages: Schema.Array(SandboxPiPackageManifestSchema),
});
export const SandboxSyncOutputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SANDBOX_CONFIG_SCHEMA_VERSION),
  digest: SandboxDigestSchema,
  bytes: Schema.Int,
  fileCount: Schema.Int,
  skills: Schema.Array(Schema.Struct({ name: SkillNameSchema, path: Schema.NonEmptyString })),
  piPackages: Schema.Array(
    Schema.Struct({
      name: PiPackageNameSchema,
      repository: GitRepositorySchema,
      commit: GitCommitSchema,
      requestedRef: Schema.NonEmptyString,
    }),
  ),
  remote: Schema.Struct({
    status: Schema.Literals(["not_queried", "unavailable", "synchronized", "diverged"]),
    activeDigest: Schema.NullOr(SandboxDigestSchema),
  }),
});

export type SandboxFileModeClass = typeof SandboxFileModeClassSchema.Type;
export type SandboxFileRecord = typeof SandboxFileRecordSchema.Type;
export type SandboxSkillManifest = typeof SandboxSkillManifestSchema.Type;
export type SandboxPiPackageManifest = typeof SandboxPiPackageManifestSchema.Type;
export type SandboxBundleManifest = typeof SandboxBundleManifestSchema.Type;
export type SandboxSyncOutput = typeof SandboxSyncOutputSchema.Type;

const encodeSandboxBundleManifest = Schema.encodeSync(SandboxBundleManifestSchema);
const encodeSandboxSyncOutput = Schema.encodeSync(SandboxSyncOutputSchema);
const decodeSandboxBundleManifestJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(SandboxBundleManifestSchema),
  { onExcessProperty: "error" },
);

export { sandboxSourceInvalid } from "./sandbox-sources";

export const sandboxPackageUnsupported = (message: string, hint: string): CliError =>
  new CliError("sandbox_package_unsupported", message, hint, EXIT.USAGE);

export const sandboxBundleTooLarge = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_too_large", message, hint, EXIT.USAGE);

export const sandboxArchiveInvalid = (message: string, hint: string): CliError =>
  new CliError("sandbox_archive_invalid", message, hint, EXIT.GENERIC);

export const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const isExcludedBasename = (name: string): boolean => {
  if (SANDBOX_EXCLUDED_BASENAMES.has(name)) return true;
  if (name.endsWith("~")) return true;
  return SANDBOX_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

export const isSafeBundlePath = (path: string): boolean => {
  if (path.length === 0 || path.length > SANDBOX_MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
};

export const itemContentDigest = (files: ReadonlyArray<SandboxFileRecord>): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => compareUtf8(left.path, right.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.modeClass);
    hash.update("\0");
    hash.update(file.digest);
    hash.update("\n");
  }
  return hash.digest("hex");
};

export const encodeBundleManifestJson = (manifest: SandboxBundleManifest): string =>
  `${JSON.stringify(encodeSandboxBundleManifest(manifest), null, 2)}\n`;

export const decodeBundleManifestText = decodeSandboxBundleManifestJson;

export const sandboxSyncOutput = (
  config: SandboxConfig,
  digest: string,
  bytes: number,
  fileCount: number,
): SandboxSyncOutput => ({
  schemaVersion: SANDBOX_CONFIG_SCHEMA_VERSION,
  digest,
  bytes,
  fileCount,
  skills: config.skills,
  piPackages: config.piPackages,
  remote: { status: "not_queried", activeDigest: null },
});

export const encodeSandboxSyncJson = (output: SandboxSyncOutput): unknown =>
  encodeSandboxSyncOutput(output);

export const formatSandboxSync = (output: SandboxSyncOutput): string =>
  `Prepared sandbox bundle ${output.digest} (${output.bytes} bytes, ${output.fileCount} files). Not uploaded.\n${formatSandboxStatus(
    {
      schemaVersion: output.schemaVersion,
      skills: output.skills,
      piPackages: output.piPackages,
      remote: output.remote,
    },
  )}`;
