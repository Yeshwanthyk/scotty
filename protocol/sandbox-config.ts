import { Schema } from "effect";

export const SANDBOX_CONFIG_SCHEMA_VERSION = 1 as const;

export const DigestSchema = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
export const NonNegativeRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PluginIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u),
);
export const ResourceNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u),
);
export const AbsolutePathSchema = Schema.String.check(
  Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0"), {
    expected: "an absolute filesystem path",
  }),
);
export const RelativeResourcePathSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    { expected: "a safe relative resource path" },
  ),
);

export const PluginTypeSchema = Schema.Literals([
  "compute-provider",
  "pi-extension",
  "skill",
  "sandbox-tool",
]);
export type PluginType = typeof PluginTypeSchema.Type;

export const LocalPluginSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("builtin"), name: PluginIdSchema }),
  Schema.Struct({ kind: Schema.Literal("path"), path: AbsolutePathSchema }),
]);
export type LocalPluginSource = typeof LocalPluginSourceSchema.Type;

export const LocalPluginSchema = Schema.Struct({
  id: PluginIdSchema,
  type: PluginTypeSchema,
  enabled: Schema.Boolean,
  source: LocalPluginSourceSchema,
});
export type LocalPlugin = typeof LocalPluginSchema.Type;

const BoundedCountSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }));
const BoundedMillisSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 }));

export const PiThinkingLevelSchema = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const PiSettingsSchema = Schema.Struct({
  defaultProvider: Schema.NonEmptyString,
  defaultModel: Schema.NonEmptyString,
  defaultThinkingLevel: PiThinkingLevelSchema,
  hideThinkingBlock: Schema.optionalKey(Schema.Boolean),
  showCacheMissNotices: Schema.optionalKey(Schema.Boolean),
  thinkingBudgets: Schema.optionalKey(
    Schema.Struct({
      minimal: Schema.optionalKey(BoundedCountSchema),
      low: Schema.optionalKey(BoundedCountSchema),
      medium: Schema.optionalKey(BoundedCountSchema),
      high: Schema.optionalKey(BoundedCountSchema),
    }),
  ),
  steeringMode: Schema.optionalKey(Schema.Literals(["all", "one-at-a-time"])),
  followUpMode: Schema.optionalKey(Schema.Literals(["all", "one-at-a-time"])),
  compaction: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      reserveTokens: Schema.optionalKey(BoundedCountSchema),
      keepRecentTokens: Schema.optionalKey(BoundedCountSchema),
    }),
  ),
  branchSummary: Schema.optionalKey(
    Schema.Struct({
      reserveTokens: Schema.optionalKey(BoundedCountSchema),
      skipPrompt: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  retry: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      maxRetries: Schema.optionalKey(BoundedCountSchema),
      baseDelayMs: Schema.optionalKey(BoundedMillisSchema),
      provider: Schema.optionalKey(
        Schema.Struct({
          timeoutMs: Schema.optionalKey(BoundedMillisSchema),
          maxRetries: Schema.optionalKey(BoundedCountSchema),
          maxRetryDelayMs: Schema.optionalKey(BoundedMillisSchema),
        }),
      ),
    }),
  ),
  theme: Schema.optionalKey(Schema.Literals(["dark", "light"])),
  quietStartup: Schema.optionalKey(Schema.Boolean),
  collapseChangelog: Schema.optionalKey(Schema.Boolean),
  enableInstallTelemetry: Schema.optionalKey(Schema.Boolean),
  enableAnalytics: Schema.optionalKey(Schema.Boolean),
  terminal: Schema.optionalKey(
    Schema.Struct({
      showImages: Schema.optionalKey(Schema.Boolean),
      imageWidthCells: Schema.optionalKey(BoundedCountSchema),
      clearOnShrink: Schema.optionalKey(Schema.Boolean),
      showTerminalProgress: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  images: Schema.optionalKey(
    Schema.Struct({
      autoResize: Schema.optionalKey(Schema.Boolean),
      blockImages: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  markdown: Schema.optionalKey(
    Schema.Struct({
      codeBlockIndent: Schema.optionalKey(Schema.String),
      mermaid: Schema.optionalKey(Schema.Literals(["off", "final", "streaming"])),
    }),
  ),
  enabledModels: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  doubleEscapeAction: Schema.optionalKey(Schema.Literals(["fork", "tree", "none"])),
  treeFilterMode: Schema.optionalKey(
    Schema.Literals(["default", "no-tools", "user-only", "labeled-only", "all"]),
  ),
  editorPaddingX: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  ),
  outputPad: Schema.optionalKey(Schema.Literals([0, 1])),
  autocompleteMaxVisible: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 3, maximum: 20 })),
  ),
  showHardwareCursor: Schema.optionalKey(Schema.Boolean),
  tuiMode: Schema.optionalKey(Schema.Literals(["regular", "fullscreen"])),
  fullscreenScrollbar: Schema.optionalKey(Schema.Literals(["auto", "always", "hidden"])),
});
export type PiSettings = typeof PiSettingsSchema.Type;

export const SandboxSetupSchema = Schema.Struct({
  piExtensions: Schema.Array(PluginIdSchema),
  skills: Schema.Array(PluginIdSchema),
  sandboxTools: Schema.Array(PluginIdSchema),
});
export type SandboxSetup = typeof SandboxSetupSchema.Type;

export const ScottyConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SANDBOX_CONFIG_SCHEMA_VERSION),
  installation: Schema.Struct({
    name: Schema.NonEmptyString,
    cloudflareAccountId: Schema.NonEmptyString,
  }),
  pi: PiSettingsSchema,
  plugins: Schema.Array(LocalPluginSchema),
  sandboxSetup: SandboxSetupSchema,
});
export type ScottyConfig = typeof ScottyConfigSchema.Type;

export const SandboxFileModeClassSchema = Schema.Literals(["regular", "executable"]);
export type SandboxFileModeClass = typeof SandboxFileModeClassSchema.Type;
export const SandboxFileRecordSchema = Schema.Struct({
  path: RelativeResourcePathSchema,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  modeClass: SandboxFileModeClassSchema,
  digest: DigestSchema,
});
export type SandboxFileRecord = typeof SandboxFileRecordSchema.Type;

export const ComputeProviderManifestSchema = Schema.Struct({
  provider: Schema.Literal("cloudflare"),
});
export const PiExtensionManifestSchema = Schema.Struct({
  identity: ResourceNameSchema,
  entrypoints: Schema.NonEmptyArray(RelativeResourcePathSchema),
  resourceDestinations: Schema.NonEmptyArray(RelativeResourcePathSchema),
});
export const SkillManifestSchema = Schema.Struct({
  name: ResourceNameSchema,
  resourceDestinations: Schema.NonEmptyArray(RelativeResourcePathSchema),
});
export const SandboxToolCommandSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._+:-]*$/u)),
  path: RelativeResourcePathSchema,
  probe: Schema.NonEmptyArray(Schema.NonEmptyString),
});
export type SandboxToolCommand = typeof SandboxToolCommandSchema.Type;
export const SandboxToolManifestSchema = Schema.Struct({
  commands: Schema.NonEmptyArray(SandboxToolCommandSchema),
  resourceDestinations: Schema.Array(RelativeResourcePathSchema),
});

const BuiltinSnapshotSourceSchema = Schema.Struct({
  kind: Schema.Literal("builtin"),
  name: PluginIdSchema,
  releaseDigest: DigestSchema,
});
const BundleSnapshotSourceSchema = Schema.Struct({
  kind: Schema.Literal("bundle"),
  digest: DigestSchema,
});

export const DeployedPluginSchema = Schema.Union([
  Schema.Struct({
    id: PluginIdSchema,
    type: Schema.Literal("compute-provider"),
    source: BuiltinSnapshotSourceSchema,
    manifest: ComputeProviderManifestSchema,
  }),
  Schema.Struct({
    id: PluginIdSchema,
    type: Schema.Literal("pi-extension"),
    source: Schema.Union([BuiltinSnapshotSourceSchema, BundleSnapshotSourceSchema]),
    manifest: PiExtensionManifestSchema,
  }),
  Schema.Struct({
    id: PluginIdSchema,
    type: Schema.Literal("skill"),
    source: Schema.Union([BuiltinSnapshotSourceSchema, BundleSnapshotSourceSchema]),
    manifest: SkillManifestSchema,
  }),
  Schema.Struct({
    id: PluginIdSchema,
    type: Schema.Literal("sandbox-tool"),
    source: Schema.Union([BuiltinSnapshotSourceSchema, BundleSnapshotSourceSchema]),
    manifest: SandboxToolManifestSchema,
  }),
]);
export type DeployedPlugin = typeof DeployedPluginSchema.Type;

export const DeployedSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installationName: Schema.NonEmptyString,
  revision: NonNegativeRevisionSchema,
  configDigest: DigestSchema,
  pluginBundleDigest: DigestSchema,
  pi: PiSettingsSchema,
  plugins: Schema.Array(DeployedPluginSchema),
  sandboxSetup: SandboxSetupSchema,
});
export type DeployedSnapshot = typeof DeployedSnapshotSchema.Type;

export const PluginBundleEntrySchema = Schema.Struct({
  pluginId: PluginIdSchema,
  pluginType: PluginTypeSchema,
  files: Schema.Array(SandboxFileRecordSchema),
});
export const PluginBundleManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  plugins: Schema.Array(PluginBundleEntrySchema),
});
export type PluginBundleManifest = typeof PluginBundleManifestSchema.Type;

export const SandboxActivationSchema = Schema.Struct({
  revision: NonNegativeRevisionSchema,
  snapshotDigest: DigestSchema,
  configDigest: DigestSchema,
  syncId: Schema.NonEmptyString,
  activatedAt: Schema.NonEmptyString,
});
export type SandboxActivation = typeof SandboxActivationSchema.Type;
