import { createHash } from "node:crypto";
import { sandboxBundleItemDigestMaterial } from "../../protocol/sandbox-bundle";
import { Schema } from "effect";
import { CliError, EXIT } from "./core";

export const SandboxDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const SkillNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
);
export const PiPackageNameSchema = Schema.String.check(
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);

export const SANDBOX_MAX_FILE_BYTES = 8_388_608;
export const SANDBOX_MAX_SKILL_BYTES = 4_194_304;
export const SANDBOX_MAX_SKILL_FILES = 128;
export const SANDBOX_MAX_PACKAGE_BYTES = 67_108_864;
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

const SANDBOX_SENSITIVE_EXACT_BASENAMES = new Set([
  ".aws",
  ".dockerconfigjson",
  ".envrc",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "access_token",
  "auth",
  "auth.json",
  "credentials",
  "credentials.json",
  "refresh_token",
  "token",
  "token.json",
  "tokens.json",
]);

export const isSensitiveBundlePath = (path: string): boolean => {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    SANDBOX_SENSITIVE_EXACT_BASENAMES.has(basename) ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.endsWith(".env") ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.+\.(?:key|pem|p12|pfx))$/u.test(basename) ||
    basename === "history" ||
    basename.endsWith("_history") ||
    basename.endsWith(".history") ||
    basename === "log" ||
    basename === "logs" ||
    basename.endsWith(".log")
  );
};

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
  Schema.makeFilter((name) => isSafeBundlePath(name) && !name.includes("/"), {
    expected: "a safe bundle item name",
  }),
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
export type SandboxFileModeClass = typeof SandboxFileModeClassSchema.Type;
export type SandboxFileRecord = typeof SandboxFileRecordSchema.Type;
export type SandboxBundleItemKind = typeof SandboxBundleItemKindSchema.Type;
export type SandboxBundleItemManifest = typeof SandboxBundleItemManifestSchema.Type;
export type SandboxBundleManifest = typeof SandboxBundleManifestSchema.Type;

export interface BuiltSandboxBundle {
  readonly digest: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly manifest: SandboxBundleManifest;
  readonly archive: Uint8Array;
}
const encodeSandboxBundleManifest = Schema.encodeSync(SandboxBundleManifestSchema);
const decodeSandboxBundleManifestJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(SandboxBundleManifestSchema),
  { onExcessProperty: "error" },
);

export const sandboxSourceInvalid = (message: string, hint: string): CliError =>
  new CliError("sandbox_source_invalid", message, hint, EXIT.USAGE);

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

export const itemContentDigest = (files: ReadonlyArray<SandboxFileRecord>): string =>
  createHash("sha256").update(sandboxBundleItemDigestMaterial(files)).digest("hex");

export const encodeBundleManifestJson = (manifest: SandboxBundleManifest): string =>
  `${JSON.stringify(encodeSandboxBundleManifest(manifest), null, 2)}\n`;

export const decodeBundleManifestText = decodeSandboxBundleManifestJson;
