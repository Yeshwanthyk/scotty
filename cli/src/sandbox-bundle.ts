import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  DeployedSnapshotSchema,
  DigestSchema,
  PluginBundleManifestSchema,
  type DeployedSnapshot,
  type PluginBundleManifest,
  type SandboxFileModeClass,
  type SandboxFileRecord,
  type ScottyConfig,
} from "../../protocol/sandbox-config";
import { CliError, EXIT } from "./core";

export const SANDBOX_BUNDLE_SCHEMA_VERSION = 1 as const;
export const SandboxDigestSchema = DigestSchema;

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

export type { PluginBundleManifest, SandboxFileModeClass, SandboxFileRecord };

const encodePluginBundleManifest = Schema.encodeSync(PluginBundleManifestSchema);
const encodeDeployedSnapshot = Schema.encodeSync(DeployedSnapshotSchema);
const decodePluginBundleManifestJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(PluginBundleManifestSchema),
  { onExcessProperty: "error" },
);
const decodeDeployedSnapshotJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(DeployedSnapshotSchema),
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
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export const sha256Text = (text: string): string => sha256Bytes(new TextEncoder().encode(text));

export const isExcludedBasename = (name: string): boolean => {
  if (SANDBOX_EXCLUDED_BASENAMES.has(name)) return true;
  if (name.endsWith("~")) return true;
  return SANDBOX_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

export const isSafeBundlePath = (path: string): boolean => {
  if (path.length === 0 || path.length > SANDBOX_MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
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
  return `sha256:${hash.digest("hex")}`;
};

export const encodeBundleManifestJson = (manifest: PluginBundleManifest): string =>
  `${JSON.stringify(encodePluginBundleManifest(manifest), null, 2)}\n`;

export const encodeDeployedSnapshotJson = (snapshot: DeployedSnapshot): string =>
  `${JSON.stringify(encodeDeployedSnapshot(snapshot), null, 2)}\n`;

export const decodeBundleManifestText = decodePluginBundleManifestJson;
export const decodeDeployedSnapshotText = decodeDeployedSnapshotJson;

export interface SandboxRemoteSnapshot {
  readonly status: "synchronized" | "diverged";
  readonly activeSnapshotDigest: string | null;
  readonly revision: number;
}

export interface SandboxSyncOutput {
  readonly schemaVersion: 1;
  readonly snapshotDigest: string;
  readonly pluginBundleDigest: string;
  readonly configDigest: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly plugins: ReadonlyArray<{ readonly id: string; readonly type: string }>;
  readonly remote: SandboxRemoteSnapshot;
}

export const sandboxSyncOutput = (
  config: ScottyConfig,
  prepared: {
    readonly snapshotDigest: string;
    readonly pluginBundleDigest: string;
    readonly snapshot: DeployedSnapshot;
    readonly bytes: number;
    readonly fileCount: number;
  },
  remote: SandboxRemoteSnapshot,
): SandboxSyncOutput => ({
  schemaVersion: 1,
  snapshotDigest: prepared.snapshotDigest,
  pluginBundleDigest: prepared.pluginBundleDigest,
  configDigest: prepared.snapshot.configDigest,
  bytes: prepared.bytes,
  fileCount: prepared.fileCount,
  plugins: config.plugins.filter((plugin) => plugin.enabled).map(({ id, type }) => ({ id, type })),
  remote,
});

export const encodeSandboxSyncJson = (output: SandboxSyncOutput): unknown => output;

export const formatSandboxSync = (output: SandboxSyncOutput): string =>
  `Prepared snapshot ${output.snapshotDigest} and Plugin bundle ${output.pluginBundleDigest} (${output.bytes} bytes, ${output.fileCount} files).\nActive revision ${output.remote.revision}.\n`;
