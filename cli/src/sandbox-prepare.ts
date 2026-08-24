import { basename } from "node:path";
import { Effect, Result, Schema } from "effect";
import rawStandardToolset from "../../worker/container/toolsets/standard.json" with { type: "json" };
import {
  DeployedSnapshotSchema,
  PluginBundleManifestSchema,
  SandboxToolManifestSchema,
  ScottyConfigSchema,
  type DeployedPlugin,
  type DeployedSnapshot,
  type LocalPlugin,
  type PluginBundleManifest,
  type SandboxFileRecord,
  type ScottyConfig,
} from "../../protocol/sandbox-config";
import { CliError } from "./core";
import { createDeterministicTarGz, type TarMember } from "./sandbox-archive";
import {
  SANDBOX_MAX_BUNDLE_FILES,
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_PACKAGE_BYTES,
  SANDBOX_MAX_PACKAGE_FILES,
  compareUtf8,
  encodeBundleManifestJson,
  encodeDeployedSnapshotJson,
  sandboxBundleTooLarge,
  sandboxSourceInvalid,
  sha256Bytes,
  sha256Text,
} from "./sandbox-bundle";
import { sandboxConfigInvalid } from "./sandbox-config";
import { walkSandboxTree, type WalkedSandboxFile } from "./sandbox-walk";

export interface BuiltSandboxBundle {
  readonly digest: string;
  readonly snapshotDigest: string;
  readonly pluginBundleDigest: string;
  readonly configDigest: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly manifest: PluginBundleManifest;
  readonly snapshot: DeployedSnapshot;
  readonly snapshotJson: string;
  readonly archive: Uint8Array;
}

const BUILTIN_ROOT = "/opt/scotty/pi-packages/sources";

const StandardToolsetSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.Literal("standard"),
  tools: Schema.Array(
    Schema.Struct({
      commands: Schema.Array(Schema.NonEmptyString),
      probe: Schema.NonEmptyArray(Schema.NonEmptyString),
    }),
  ),
});
const standardToolset = Schema.decodeUnknownSync(StandardToolsetSchema)(rawStandardToolset);
const standardToolManifest = Schema.decodeUnknownSync(SandboxToolManifestSchema)({
  commands: standardToolset.tools.flatMap((tool) =>
    tool.commands.map((name) => ({ name, path: name, probe: tool.probe })),
  ),
  resourceDestinations: standardToolset.tools.flatMap((tool) =>
    tool.commands.map((name) => `tools/${name}`),
  ),
});

const builtinManifests = {
  cloudflare: {
    type: "compute-provider",
    manifest: { provider: "cloudflare" },
  },
  standard: {
    type: "sandbox-tool",
    manifest: standardToolManifest,
  },
  "pi-subagents-extension": {
    type: "pi-extension",
    manifest: {
      identity: "pi-subagents",
      entrypoints: ["extensions/subagents/index.ts", "extensions/activity-rail/index.ts"],
      resourceDestinations: [
        "extensions/pi-subagents/subagents",
        "extensions/pi-subagents/activity-rail",
      ],
    },
  },
  "pi-subagents-skill": {
    type: "skill",
    manifest: { name: "subagents", resourceDestinations: ["skills/subagents"] },
  },
} as const;

type BuiltinName = keyof typeof builtinManifests;

const builtinReleaseDigest = (name: BuiltinName): string =>
  sha256Text(`scotty-builtin-v1\0${name}\0${JSON.stringify(builtinManifests[name])}`);

const localWalkOptions = {
  maxFileBytes: SANDBOX_MAX_FILE_BYTES,
  maxTotalBytes: SANDBOX_MAX_PACKAGE_BYTES,
  maxFiles: SANDBOX_MAX_PACKAGE_FILES,
  includeNodeModules: true,
  skipNodeModulesBin: true,
  executableScripts: true,
} as const;

const fileRecords = (files: ReadonlyArray<WalkedSandboxFile>): SandboxFileRecord[] =>
  [...files]
    .map((file) => ({
      path: file.path,
      size: file.size,
      modeClass: file.modeClass,
      digest: file.digest,
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));

const textFile = (
  files: ReadonlyArray<WalkedSandboxFile>,
  path: string,
): Result.Result<string, CliError> => {
  const file = files.find((candidate) => candidate.path === path);
  return file === undefined
    ? Result.fail(sandboxSourceInvalid(`Plugin source must contain ${path}`, `Checked ${path}.`))
    : Result.succeed(new TextDecoder().decode(file.bytes));
};

const SkillFrontmatterSchema = Schema.Struct({ name: Schema.NonEmptyString });
const decodeSkillFrontmatter = Schema.decodeUnknownResult(SkillFrontmatterSchema, {
  onExcessProperty: "ignore",
});

export const parseSkillFrontmatterName = (text: string): Result.Result<string, CliError> => {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n"))
    return Result.fail(
      sandboxSourceInvalid("SKILL.md must start with YAML frontmatter", "Add a name field."),
    );
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0)
    return Result.fail(
      sandboxSourceInvalid("SKILL.md frontmatter is not terminated", "Add the closing ---."),
    );
  const values: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const value = line.slice(separator + 1).trim();
    values[line.slice(0, separator).trim()] =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
  }
  const decoded = decodeSkillFrontmatter(values);
  return Result.isFailure(decoded)
    ? Result.fail(
        sandboxSourceInvalid("SKILL.md must declare a name", "Add a non-empty name field."),
      )
    : Result.succeed(decoded.success.name);
};

const PiPackageSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  pi: Schema.Struct({ extensions: Schema.NonEmptyArray(Schema.NonEmptyString) }),
});
const decodePiPackage = Schema.decodeUnknownResult(Schema.fromJsonString(PiPackageSchema), {
  onExcessProperty: "ignore",
});
const decodeToolManifest = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({ schemaVersion: Schema.Literal(1), ...SandboxToolManifestSchema.fields }),
  ),
  { onExcessProperty: "error" },
);
const encodeScottyConfig = Schema.encodeSync(ScottyConfigSchema);
const decodeDeployedSnapshot = Schema.decodeUnknownResult(DeployedSnapshotSchema, {
  onExcessProperty: "error",
});
const decodePluginBundleManifest = Schema.decodeUnknownResult(PluginBundleManifestSchema, {
  onExcessProperty: "error",
});

const normalizeRelative = (path: string): string => (path.startsWith("./") ? path.slice(2) : path);

const prepareLocalManifest = (
  plugin: LocalPlugin,
  files: ReadonlyArray<WalkedSandboxFile>,
): Result.Result<DeployedPlugin["manifest"], CliError> => {
  if (plugin.type === "compute-provider")
    return Result.fail(
      sandboxSourceInvalid(
        `Compute-provider Plugin ${plugin.id} must use a product builtin`,
        `Change ${plugin.id} to source kind builtin.`,
      ),
    );
  if (plugin.type === "skill") {
    const skillText = Result.flatMap(textFile(files, "SKILL.md"), parseSkillFrontmatterName);
    if (Result.isFailure(skillText)) return Result.fail(skillText.failure);
    return Result.succeed({
      name: skillText.success,
      resourceDestinations: [`skills/${skillText.success}`],
    });
  }
  if (plugin.type === "pi-extension") {
    const packageText = textFile(files, "package.json");
    if (Result.isFailure(packageText)) return Result.fail(packageText.failure);
    const decoded = decodePiPackage(packageText.success);
    if (Result.isFailure(decoded))
      return Result.fail(
        sandboxSourceInvalid(
          `Pi extension Plugin ${plugin.id} must declare package.json pi.extensions`,
          `Checked ${plugin.source.kind === "path" ? plugin.source.path : plugin.id}.`,
        ),
      );
    const available = new Set(files.map((file) => file.path));
    const entrypoints = [
      normalizeRelative(decoded.success.pi.extensions[0]),
      ...decoded.success.pi.extensions.slice(1).map(normalizeRelative),
    ] as const;
    for (const entrypoint of entrypoints) {
      if (!available.has(entrypoint))
        return Result.fail(
          sandboxSourceInvalid(
            `Pi extension Plugin ${plugin.id} entrypoint ${entrypoint} is missing`,
            `Fix package.json for ${plugin.id}.`,
          ),
        );
    }
    return Result.succeed({
      identity: decoded.success.name,
      entrypoints,
      resourceDestinations: [
        `extensions/${plugin.id}/${basename(entrypoints[0])}`,
        ...entrypoints
          .slice(1)
          .map((entrypoint) => `extensions/${plugin.id}/${basename(entrypoint)}`),
      ],
    });
  }
  const manifestText = textFile(files, "scotty-plugin.json");
  if (Result.isFailure(manifestText)) return Result.fail(manifestText.failure);
  const decoded = decodeToolManifest(manifestText.success);
  if (Result.isFailure(decoded))
    return Result.fail(
      sandboxSourceInvalid(
        `Sandbox tool Plugin ${plugin.id} has an invalid scotty-plugin.json`,
        "Use schemaVersion 1 with strict commands and resourceDestinations.",
      ),
    );
  const available = new Set(files.map((file) => file.path));
  for (const command of decoded.success.commands) {
    if (!available.has(command.path))
      return Result.fail(
        sandboxSourceInvalid(
          `Sandbox tool Plugin ${plugin.id} command path ${command.path} is missing`,
          `Fix scotty-plugin.json for ${plugin.id}.`,
        ),
      );
  }
  return Result.succeed({
    commands: decoded.success.commands,
    resourceDestinations: decoded.success.resourceDestinations,
  });
};

const duplicate = (values: ReadonlyArray<string>): string | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
};

const validateDesiredWiring = (config: ScottyConfig): Result.Result<void, CliError> => {
  const duplicateId = duplicate(config.plugins.map((plugin) => plugin.id));
  if (duplicateId !== undefined)
    return Result.fail(sandboxConfigInvalid("config.json", `duplicate Plugin ID ${duplicateId}`));
  const byId = new Map(config.plugins.map((plugin) => [plugin.id, plugin]));
  const lists = [
    ["piExtensions", "pi-extension", config.sandboxSetup.piExtensions],
    ["skills", "skill", config.sandboxSetup.skills],
    ["sandboxTools", "sandbox-tool", config.sandboxSetup.sandboxTools],
  ] as const;
  for (const [field, expectedType, references] of lists) {
    const duplicateRef = duplicate(references);
    if (duplicateRef !== undefined)
      return Result.fail(
        sandboxConfigInvalid("config.json", `duplicate ${field} reference ${duplicateRef}`),
      );
    for (const reference of references) {
      const plugin = byId.get(reference);
      if (plugin === undefined)
        return Result.fail(
          sandboxConfigInvalid("config.json", `${field} reference ${reference} is unresolved`),
        );
      if (!plugin.enabled)
        return Result.fail(
          sandboxConfigInvalid("config.json", `${field} reference ${reference} is disabled`),
        );
      if (plugin.type !== expectedType)
        return Result.fail(
          sandboxConfigInvalid(
            "config.json",
            `${field} reference ${reference} has type ${plugin.type}, expected ${expectedType}`,
          ),
        );
    }
  }
  const cloudflare = config.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.type === "compute-provider" &&
      plugin.source.kind === "builtin" &&
      plugin.source.name === "cloudflare",
  );
  return cloudflare.length === 1
    ? Result.succeed(undefined)
    : Result.fail(
        sandboxConfigInvalid(
          "config.json",
          "exactly one enabled builtin cloudflare compute-provider is required",
        ),
      );
};

const collision = (
  claims: ReadonlyArray<{
    readonly namespace: string;
    readonly value: string;
    readonly owner: string;
  }>,
): Result.Result<void, CliError> => {
  const owners = new Map<string, string>();
  for (const claim of claims) {
    const key = `${claim.namespace}\0${claim.value}`;
    const previous = owners.get(key);
    if (previous !== undefined)
      return Result.fail(
        sandboxSourceInvalid(
          `${claim.namespace} collision for ${claim.value} between Plugins ${previous} and ${claim.owner}`,
          "Change one Plugin manifest or disable one owner.",
        ),
      );
    owners.set(key, claim.owner);
  }
  return Result.succeed(undefined);
};

const manifestClaims = (plugin: DeployedPlugin) => {
  if (plugin.type === "compute-provider") return [];
  const resources = plugin.manifest.resourceDestinations.map((value) => ({
    namespace: "resource destination",
    value,
    owner: plugin.id,
  }));
  if (plugin.type === "skill")
    return [
      { namespace: "Skill name", value: plugin.manifest.name, owner: plugin.id },
      ...resources,
    ];
  if (plugin.type === "pi-extension")
    return [
      { namespace: "Pi extension identity", value: plugin.manifest.identity, owner: plugin.id },
      ...resources,
    ];
  return [
    ...plugin.manifest.commands.map((command) => ({
      namespace: "tool command",
      value: command.name,
      owner: plugin.id,
    })),
    ...resources,
  ];
};

const parentDirectories = (path: string): string[] => {
  const parts = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index++)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
};

const archiveMembers = (
  manifestJson: string,
  plugins: ReadonlyArray<{ readonly id: string; readonly files: ReadonlyArray<WalkedSandboxFile> }>,
): TarMember[] => {
  const members = new Map<string, TarMember>();
  const addDirectory = (path: string): void => {
    if (!members.has(path))
      members.set(path, { path, type: "directory", modeClass: "regular", bytes: new Uint8Array() });
  };
  members.set("manifest.json", {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: new TextEncoder().encode(manifestJson),
  });
  for (const plugin of plugins) {
    for (const file of plugin.files) {
      const path = `plugins/${plugin.id}/${file.path}`;
      for (const directory of parentDirectories(path)) addDirectory(directory);
      members.set(path, { path, type: "file", modeClass: file.modeClass, bytes: file.bytes });
    }
  }
  return [...members.values()];
};

const normalizedConfigDigest = (config: ScottyConfig): string => {
  const normalized: ScottyConfig = {
    ...config,
    plugins: [...config.plugins].sort((left, right) => compareUtf8(left.id, right.id)),
  };
  return sha256Text(JSON.stringify(encodeScottyConfig(normalized)));
};

export const buildSandboxBundle = Effect.fnUntraced(function* (config: ScottyConfig, revision = 1) {
  yield* Effect.fromResult(validateDesiredWiring(config));
  const local: Array<{
    readonly plugin: LocalPlugin;
    readonly files: ReadonlyArray<WalkedSandboxFile>;
    readonly manifest: DeployedPlugin["manifest"];
  }> = [];
  const builtin: Array<{
    readonly plugin: LocalPlugin;
    readonly manifest: DeployedPlugin["manifest"];
  }> = [];
  for (const plugin of [...config.plugins]
    .filter((candidate) => candidate.enabled)
    .sort((left, right) => compareUtf8(left.id, right.id))) {
    if (plugin.source.kind === "builtin") {
      const definition = builtinManifests[plugin.source.name as BuiltinName];
      if (definition === undefined || definition.type !== plugin.type)
        return yield* sandboxSourceInvalid(
          `Builtin ${plugin.source.name} is unavailable for Plugin ${plugin.id} of type ${plugin.type}`,
          `Fix Plugin ${plugin.id}.`,
        );
      builtin.push({ plugin, manifest: definition.manifest });
      continue;
    }
    const files = yield* walkSandboxTree(plugin.source.path, localWalkOptions);
    const manifest = yield* Effect.fromResult(prepareLocalManifest(plugin, files));
    local.push({ plugin, files, manifest });
  }
  const fileCount = local.reduce((sum, item) => sum + item.files.length, 0);
  if (fileCount > SANDBOX_MAX_BUNDLE_FILES)
    return yield* sandboxBundleTooLarge(
      "Plugin bundle exceeds the file-count limit",
      "Remove Plugin sources or reduce their contents, then retry.",
    );
  const bundleManifest: PluginBundleManifest = {
    schemaVersion: 1,
    plugins: local.map((item) => ({
      pluginId: item.plugin.id,
      pluginType: item.plugin.type,
      files: fileRecords(item.files),
    })),
  };
  const archived = createDeterministicTarGz(
    archiveMembers(
      encodeBundleManifestJson(bundleManifest),
      local.map((item) => ({ id: item.plugin.id, files: item.files })),
    ),
  );
  const pluginBundleDigest = sha256Bytes(archived.archive);
  const deployedPlugins = [...builtin, ...local]
    .map(({ plugin, manifest }): DeployedPlugin => {
      const source =
        plugin.source.kind === "builtin"
          ? {
              kind: "builtin" as const,
              name: plugin.source.name,
              releaseDigest: builtinReleaseDigest(plugin.source.name as BuiltinName),
            }
          : { kind: "bundle" as const, digest: pluginBundleDigest };
      return { id: plugin.id, type: plugin.type, source, manifest } as DeployedPlugin;
    })
    .sort((left, right) => compareUtf8(left.id, right.id));
  yield* Effect.fromResult(collision(deployedPlugins.flatMap(manifestClaims)));
  const snapshot: DeployedSnapshot = {
    schemaVersion: 1,
    installationName: config.installation.name,
    revision,
    configDigest: normalizedConfigDigest(config),
    pluginBundleDigest,
    pi: config.pi,
    plugins: deployedPlugins,
    sandboxSetup: config.sandboxSetup,
  };
  const decodedSnapshot = decodeDeployedSnapshot(snapshot);
  const decodedManifest = decodePluginBundleManifest(bundleManifest);
  if (Result.isFailure(decodedSnapshot) || Result.isFailure(decodedManifest))
    return yield* sandboxSourceInvalid(
      "Prepared Plugin manifests do not satisfy the deployed snapshot contract",
      "Fix the named Plugin manifest and retry.",
    );
  const snapshotJson = encodeDeployedSnapshotJson(snapshot);
  const snapshotDigest = sha256Text(snapshotJson);
  return {
    digest: snapshotDigest,
    snapshotDigest,
    pluginBundleDigest,
    configDigest: snapshot.configDigest,
    bytes: archived.archive.byteLength,
    fileCount,
    manifest: bundleManifest,
    snapshot,
    snapshotJson,
    archive: archived.archive,
  } satisfies BuiltSandboxBundle;
});

export const builtinPluginPath = (name: "pi-subagents-extension" | "pi-subagents-skill"): string =>
  name === "pi-subagents-extension"
    ? `${BUILTIN_ROOT}/pi-subagents`
    : `${BUILTIN_ROOT}/pi-subagents/skills/subagents`;
