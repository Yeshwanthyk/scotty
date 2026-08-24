import { Schema } from "effect";
import {
  DeployedSnapshotSchema,
  DigestSchema,
  LocalPluginSchema,
  PiSettingsSchema,
  PluginBundleManifestSchema,
  SandboxSetupSchema,
  ScottyConfigSchema,
} from "../../protocol/sandbox-config";

export * from "../../protocol/sandbox-config";

export const SandboxRemoteStatusSchema = Schema.Literals([
  "not_queried",
  "unavailable",
  "synchronized",
  "diverged",
]);
export const SandboxStatusOutputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installation: ScottyConfigSchema.fields.installation,
  pi: PiSettingsSchema,
  plugins: Schema.Array(LocalPluginSchema),
  sandboxSetup: SandboxSetupSchema,
  remote: Schema.Struct({
    status: SandboxRemoteStatusSchema,
    activeSnapshotDigest: Schema.NullOr(DigestSchema),
    revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
});
export type SandboxStatusOutput = typeof SandboxStatusOutputSchema.Type;

export const PreparedSandboxSchema = Schema.Struct({
  snapshot: DeployedSnapshotSchema,
  snapshotDigest: DigestSchema,
  pluginBundleDigest: DigestSchema,
  manifest: PluginBundleManifestSchema,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const formatSandboxStatus = (status: SandboxStatusOutput): string => {
  const plugins =
    status.plugins.length === 0
      ? "  (none)\n"
      : status.plugins
          .map(
            (plugin) =>
              `  ${plugin.id}  ${plugin.type}  ${plugin.enabled ? "enabled" : "disabled"}\n`,
          )
          .join("");
  const remote =
    status.remote.status === "not_queried"
      ? "Remote installation was not queried.\n"
      : status.remote.status === "unavailable"
        ? "Remote installation status is unavailable.\n"
        : status.remote.status === "synchronized"
          ? `Remote snapshot ${status.remote.activeSnapshotDigest} is synchronized.\n`
          : `Remote snapshot ${status.remote.activeSnapshotDigest} differs from local desired state.\n`;
  return `Installation: ${status.installation.name}\nPlugins:\n${plugins}${remote}`;
};
