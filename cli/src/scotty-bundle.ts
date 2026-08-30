import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Result, Schema } from "effect";
import {
  SANDBOX_MAX_BUNDLE_FILES,
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_PACKAGE_BYTES,
  SANDBOX_MAX_PACKAGE_FILES,
  compareUtf8,
  encodeBundleManifestJson,
  itemContentDigest,
  isSensitiveBundlePath,
  sandboxBundleTooLarge,
  sandboxPackageUnsupported,
  sandboxSourceInvalid,
  type SandboxBundleItemKind,
  type SandboxBundleItemManifest,
  type SandboxBundleManifest,
  type SandboxFileRecord,
} from "./sandbox-bundle";
import { PiPackageNameSchema, SkillNameSchema, type BuiltSandboxBundle } from "./sandbox-bundle";
import {
  installPiPackageDependencies,
  type PiPackageDependencyInstaller,
  usePreparedPiPackage,
} from "./pi-package-prepare";
import { createDeterministicTarGz, type TarMember } from "./sandbox-archive";
import type { LoadedScottyTomlConfig, ResolvedScottyTomlRoots } from "./scotty-config";
import { walkSandboxItem, type SandboxWalkOptions, type WalkedSandboxFile } from "./sandbox-walk";
const PiPackageMetadataSchema = Schema.Struct({
  extensions: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  skills: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  prompts: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  themes: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
}).check(
  Schema.makeFilter(
    (metadata) =>
      (metadata.extensions?.length ?? 0) > 0 ||
      (metadata.skills?.length ?? 0) > 0 ||
      (metadata.prompts?.length ?? 0) > 0 ||
      (metadata.themes?.length ?? 0) > 0,
    { expected: "Pi package metadata declaring at least one resource" },
  ),
);
const PiPackageJsonSchema = Schema.Struct({
  name: PiPackageNameSchema,
  pi: PiPackageMetadataSchema,
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const decodeSkillName = Schema.decodeUnknownOption(SkillNameSchema);
const decodePiPackageJson = Schema.decodeUnknownResult(Schema.fromJsonString(PiPackageJsonSchema), {
  onExcessProperty: "ignore",
});

const bundleWalkOptions = {
  maxFileBytes: SANDBOX_MAX_FILE_BYTES,
  maxTotalBytes: SANDBOX_MAX_PACKAGE_BYTES,
  maxFiles: SANDBOX_MAX_PACKAGE_FILES,
  includeNodeModules: true,
  skipNodeModulesBin: false,
  executableScripts: false,
  rejectPath: isSensitiveBundlePath,
} as const;
const packageSourceWalkOptions = {
  ...bundleWalkOptions,
  includeNodeModules: false,
} as const;
const preparedPackageWalkOptions = {
  ...bundleWalkOptions,
  skipNodeModulesBin: true,
} as const;

export interface BuildScottyTomlBundleOptions {
  readonly installPackageDependencies?: PiPackageDependencyInstaller;
}

interface PreparedBundleItem {
  readonly manifest: SandboxBundleItemManifest;
  readonly files: ReadonlyArray<WalkedSandboxFile>;
}

const fileRecords = (files: ReadonlyArray<WalkedSandboxFile>): SandboxFileRecord[] =>
  files
    .map((file) => ({
      path: file.path,
      size: file.size,
      modeClass: file.modeClass,
      digest: file.digest,
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));

const prepareItem = Effect.fnUntraced(function* (
  kind: SandboxBundleItemKind,
  name: string,
  path: string,
  options: SandboxWalkOptions = bundleWalkOptions,
) {
  const walked = yield* walkSandboxItem(path, options);
  if (kind === "skill") {
    if (walked.shape !== "directory")
      return yield* sandboxSourceInvalid(
        "Skill bundle items must be directories",
        `Rejected ${path}.`,
      );
    const skillMd = walked.files.find((file) => file.path === "SKILL.md");
    if (skillMd === undefined)
      return yield* sandboxSourceInvalid(
        "Skill bundle items must contain SKILL.md",
        `Checked ${path}.`,
      );
  }
  const records = fileRecords(walked.files);
  return {
    manifest: {
      kind,
      name,
      shape: walked.shape,
      digest: itemContentDigest(records),
      files: records,
    },
    files: walked.files,
  } satisfies PreparedBundleItem;
});

const preparePackageItem = Effect.fnUntraced(function* (
  path: string,
  install: PiPackageDependencyInstaller,
) {
  const walked = yield* walkSandboxItem(path, packageSourceWalkOptions);
  if (walked.shape !== "directory")
    return yield* sandboxSourceInvalid(
      "Pi package bundle items must be directories",
      `Rejected ${path}.`,
    );
  const packageJson = walked.files.find((file) => file.path === "package.json");
  if (packageJson === undefined)
    return yield* sandboxSourceInvalid(
      "Pi package directory must contain package.json at its root",
      `Checked ${path}.`,
    );
  const decoded = decodePiPackageJson(new TextDecoder().decode(packageJson.bytes));
  if (Result.isFailure(decoded))
    return yield* sandboxSourceInvalid(
      "Pi package.json must declare a valid name and Pi package metadata",
      `Checked ${path}.`,
    );
  const dependencies = decoded.success.dependencies ?? {};
  const optionalDependencies = decoded.success.optionalDependencies ?? {};
  const needsInstall =
    Object.keys(dependencies).length > 0 || Object.keys(optionalDependencies).length > 0;
  const lockFile = walked.files.find((file) => file.path === "package-lock.json");
  if (needsInstall && lockFile === undefined)
    return yield* sandboxPackageUnsupported(
      "Pi packages with runtime dependencies require package-lock.json",
      `Add a lockfile at ${path}, then retry.`,
    );
  return yield* usePreparedPiPackage(path, needsInstall, install, (prepared) =>
    prepareItem("package", decoded.success.name, prepared, preparedPackageWalkOptions),
  );
});

const rootsByKind = (
  roots: ResolvedScottyTomlRoots,
): ReadonlyArray<readonly [SandboxBundleItemKind, ReadonlyArray<string>]> => [
  ["skill", roots.skills],
  ["tool", roots.tools],
  ["extension", roots.extensions],
];

const discoverItems = Effect.fnUntraced(function* (
  roots: ResolvedScottyTomlRoots,
  install: PiPackageDependencyInstaller,
) {
  const items: PreparedBundleItem[] = [];
  for (const path of roots.packages) items.push(yield* preparePackageItem(path, install));
  for (const [kind, categoryRoots] of rootsByKind(roots)) {
    for (const root of categoryRoots) {
      const entries = yield* Effect.tryPromise({
        try: () => readdir(root, { withFileTypes: true }),
        catch: () =>
          sandboxSourceInvalid("Could not list a configured bundle root", `Checked ${root}.`),
      });
      for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
        if (isSensitiveBundlePath(entry.name))
          return yield* sandboxSourceInvalid(
            "Bundle sources must not contain credential files",
            `Rejected ${join(root, entry.name)}.`,
          );
        const path = join(root, entry.name);
        if (kind === "skill") {
          if (!entry.isDirectory()) continue;
          const skillMd = yield* Effect.result(
            Effect.tryPromise({
              try: () => lstat(join(path, "SKILL.md")),
              catch: () =>
                sandboxSourceInvalid("Skill bundle item is missing SKILL.md", `Checked ${path}.`),
            }),
          );
          if (Result.isFailure(skillMd) || !skillMd.success.isFile()) continue;
        }
        if (kind === "skill" && Option.isNone(decodeSkillName(entry.name)))
          return yield* sandboxSourceInvalid(
            "Skill bundle item name is invalid",
            `Rejected ${entry.name}.`,
          );
        items.push(yield* prepareItem(kind, entry.name, path));
      }
    }
  }
  items.sort((left, right) => {
    const byKind = compareUtf8(left.manifest.kind, right.manifest.kind);
    return byKind === 0 ? compareUtf8(left.manifest.name, right.manifest.name) : byKind;
  });
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!.manifest;
    const current = items[index]!.manifest;
    if (previous.kind === current.kind && previous.name === current.name)
      return yield* sandboxSourceInvalid(
        "Configured bundle item names must be unique within each kind",
        `Duplicate ${current.kind} ${current.name}.`,
      );
  }
  return items;
});

const bundleItemRoot = (kind: SandboxBundleItemKind): string =>
  kind === "package" ? "pi-packages" : `${kind}s`;

const parentDirectories = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
};

const archiveMembers = (
  manifestJson: string,
  items: ReadonlyArray<PreparedBundleItem>,
): ReadonlyArray<TarMember> => {
  const members = new Map<string, TarMember>();
  const addDirectory = (path: string): void => {
    if (!members.has(path))
      members.set(path, {
        path,
        type: "directory",
        modeClass: "regular",
        bytes: new Uint8Array(),
      });
  };
  const addFile = (path: string, file: WalkedSandboxFile): void => {
    for (const parent of parentDirectories(path)) addDirectory(parent);
    members.set(path, { path, type: "file", modeClass: file.modeClass, bytes: file.bytes });
  };
  members.set("manifest.json", {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: new TextEncoder().encode(manifestJson),
  });
  for (const item of items) {
    const root = bundleItemRoot(item.manifest.kind);
    addDirectory(root);
    if (item.manifest.shape === "file") {
      const file = item.files[0];
      if (file !== undefined) addFile(`${root}/${file.path}`, file);
      continue;
    }
    addDirectory(`${root}/${item.manifest.name}`);
    for (const file of item.files) addFile(`${root}/${item.manifest.name}/${file.path}`, file);
  }
  return [...members.values()];
};

export const buildScottyTomlBundle = Effect.fnUntraced(function* (
  loaded: LoadedScottyTomlConfig,
  options: BuildScottyTomlBundleOptions = {},
) {
  const items = yield* discoverItems(
    loaded.resolvedRoots,
    options.installPackageDependencies ?? installPiPackageDependencies,
  );
  const fileCount = items.reduce((total, item) => total + item.files.length, 0);
  if (fileCount > SANDBOX_MAX_BUNDLE_FILES)
    return yield* sandboxBundleTooLarge(
      "Sandbox bundle exceeds the file-count limit",
      "Remove bundle items or reduce their contents, then retry.",
    );
  const manifest: SandboxBundleManifest = {
    items: items.map((item) => item.manifest),
  };
  const built = createDeterministicTarGz(archiveMembers(encodeBundleManifestJson(manifest), items));
  return {
    digest: built.digest,
    bytes: built.archive.byteLength,
    fileCount,
    manifest,
    archive: built.archive,
  } satisfies BuiltSandboxBundle;
});

export const bundleItemSummaries = (
  manifest: SandboxBundleManifest,
): ReadonlyArray<{ readonly kind: SandboxBundleItemKind; readonly name: string }> =>
  manifest.items.map(({ kind, name }) => ({ kind, name }));
