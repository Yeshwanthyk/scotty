import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { CliError } from "./core";
import { SANDBOX_GIT_ENV, mapSandboxGitFailure } from "./sandbox-git";
import {
  SANDBOX_MAX_BUNDLE_FILES,
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_PACKAGE_BYTES,
  SANDBOX_MAX_PACKAGE_FILES,
  SANDBOX_MAX_SKILL_BYTES,
  SANDBOX_MAX_SKILL_FILES,
  compareUtf8,
  encodeBundleManifestJson,
  isSafeBundlePath,
  itemContentDigest,
  sandboxBundleTooLarge,
  sandboxPackageUnsupported,
  sandboxSourceInvalid,
  sha256Bytes,
  type SandboxBundleManifest,
  type SandboxFileRecord,
  type SandboxPiPackageManifest,
  type SandboxSkillManifest,
} from "./sandbox-bundle";
import { createDeterministicTarGz, type TarMember } from "./sandbox-archive";
import {
  PiPackageNameSchema,
  type PiPackageSource,
  type SandboxConfig,
  type SkillSource,
} from "./sandbox-config";
import { readSkillDirectoryName } from "./sandbox-sources";
import { walkSandboxTree, type WalkedSandboxFile } from "./sandbox-walk";
import { ProcessRunner } from "./services";

export interface BuiltSandboxBundle {
  readonly digest: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly manifest: SandboxBundleManifest;
  readonly archive: Uint8Array;
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const NPM_CI = ["npm", "ci", "--omit=dev", "--ignore-scripts"] as const;
const NPM_ENV = {
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_ignore_scripts: "true",
} as const;

const PiPackageJsonSchema = Schema.Struct({
  name: PiPackageNameSchema,
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  pi: Schema.optionalKey(
    Schema.Struct({
      extensions: Schema.Array(Schema.NonEmptyString),
    }),
  ),
});
const decodePiPackageJson = Schema.decodeUnknownResult(Schema.fromJsonString(PiPackageJsonSchema), {
  onExcessProperty: "ignore",
});

const skillWalkOptions = {
  maxFileBytes: SANDBOX_MAX_FILE_BYTES,
  maxTotalBytes: SANDBOX_MAX_SKILL_BYTES,
  maxFiles: SANDBOX_MAX_SKILL_FILES,
  includeNodeModules: false,
  skipNodeModulesBin: false,
  executableScripts: true,
} as const;

const packageWalkOptions = {
  maxFileBytes: SANDBOX_MAX_FILE_BYTES,
  maxTotalBytes: SANDBOX_MAX_PACKAGE_BYTES,
  maxFiles: SANDBOX_MAX_PACKAGE_FILES,
  includeNodeModules: true,
  skipNodeModulesBin: true,
  executableScripts: false,
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

const hasExecutableContent = (files: ReadonlyArray<WalkedSandboxFile>): boolean =>
  files.some(
    (file) =>
      file.modeClass === "executable" ||
      file.path === "scripts" ||
      file.path.startsWith("scripts/"),
  );

const parentDirectories = (path: string): string[] => {
  const parts = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index++)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
};

const toArchiveMembers = (
  manifestJson: string,
  skills: ReadonlyArray<{
    readonly name: string;
    readonly files: ReadonlyArray<WalkedSandboxFile>;
  }>,
  packages: ReadonlyArray<{
    readonly name: string;
    readonly files: ReadonlyArray<WalkedSandboxFile>;
  }>,
): TarMember[] => {
  const members = new Map<string, TarMember>();
  const addDirectory = (path: string): void => {
    if (members.has(path)) return;
    members.set(path, {
      path,
      type: "directory",
      modeClass: "regular",
      bytes: new Uint8Array(),
    });
  };
  const addFile = (path: string, file: WalkedSandboxFile): void => {
    for (const directory of parentDirectories(path)) addDirectory(directory);
    members.set(path, {
      path,
      type: "file",
      modeClass: file.modeClass,
      bytes: file.bytes,
    });
  };
  members.set("manifest.json", {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: new TextEncoder().encode(manifestJson),
  });
  for (const skill of skills) {
    addDirectory("skills");
    addDirectory(`skills/${skill.name}`);
    for (const file of skill.files) addFile(`skills/${skill.name}/${file.path}`, file);
  }
  for (const item of packages) {
    addDirectory("pi-packages");
    addDirectory(`pi-packages/${item.name}`);
    for (const file of item.files) addFile(`pi-packages/${item.name}/${file.path}`, file);
  }
  return [...members.values()];
};

const rejectLfsPointers = (
  files: ReadonlyArray<WalkedSandboxFile>,
): Result.Result<void, CliError> => {
  const decoder = new TextDecoder();
  for (const file of files) {
    if (file.size > 200) continue;
    if (decoder.decode(file.bytes.subarray(0, LFS_POINTER_PREFIX.length)) === LFS_POINTER_PREFIX)
      return Result.fail(
        sandboxPackageUnsupported(
          "Pi package sources must not contain Git LFS pointer files",
          `Rejected ${file.path}.`,
        ),
      );
  }
  return Result.succeed(undefined);
};

export const prepareSkillSource = Effect.fnUntraced(function* (source: SkillSource) {
  const name = yield* readSkillDirectoryName(source.path);
  if (name !== source.name)
    return yield* sandboxSourceInvalid(
      `SKILL.md name ${name} does not match configured name ${source.name}`,
      `Checked ${source.path}.`,
    );
  const files = yield* walkSandboxTree(source.path, skillWalkOptions);
  if (files.every((file) => file.path !== "SKILL.md"))
    return yield* sandboxSourceInvalid(
      "Skill source must contain SKILL.md",
      `Checked ${source.path}.`,
    );
  const records = fileRecords(files);
  const manifest: SandboxSkillManifest = {
    name: source.name,
    digest: itemContentDigest(records),
    hasExecutableContent: hasExecutableContent(files),
    files: records,
  };
  return { manifest, files };
});

const readPackageManifest = (files: ReadonlyArray<WalkedSandboxFile>) => {
  const manifestFile = files.find((file) => file.path === "package.json");
  if (manifestFile === undefined)
    return Result.fail(
      sandboxPackageUnsupported(
        "Pi package repository must contain package.json at the root",
        "v1 does not support monorepo subpaths.",
      ),
    );
  const decoded = decodePiPackageJson(new TextDecoder().decode(manifestFile.bytes));
  if (Result.isFailure(decoded))
    return Result.fail(
      sandboxPackageUnsupported(
        "Pi package.json must declare a valid package name",
        "Check the repository at the resolved commit.",
      ),
    );
  return Result.succeed(decoded.success);
};

const assertPiResources = (
  directory: string,
  files: ReadonlyArray<WalkedSandboxFile>,
  manifest: typeof PiPackageJsonSchema.Type,
): Result.Result<void, CliError> => {
  const extensions = manifest.pi?.extensions;
  if (extensions !== undefined) {
    if (extensions.length === 0)
      return Result.fail(
        sandboxPackageUnsupported(
          "Pi package.json pi.extensions must not be empty",
          "Declare at least one extension path inside the repository.",
        ),
      );
    const available = new Set(files.map((file) => file.path));
    for (const extension of extensions) {
      const normalized = extension.startsWith("./") ? extension.slice(2) : extension;
      if (!isSafeBundlePath(normalized) || !available.has(normalized))
        return Result.fail(
          sandboxPackageUnsupported(
            "Pi package resource paths must stay inside the repository root",
            `Rejected ${extension}.`,
          ),
        );
    }
    return Result.succeed(undefined);
  }
  if (files.some((file) => file.path === "extensions" || file.path.startsWith("extensions/")))
    return Result.succeed(undefined);
  return Result.fail(
    sandboxPackageUnsupported(
      "Pi package must declare pi.extensions or use an extensions/ directory",
      `Checked ${directory}.`,
    ),
  );
};

const runInDirectory = Effect.fnUntraced(function* (
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>>,
) {
  const processRunner = yield* ProcessRunner;
  return yield* processRunner.run(command, { cwd, env });
});

export const checkoutPiPackage = Effect.fnUntraced(function* (
  source: PiPackageSource,
  destination: string,
) {
  yield* Effect.tryPromise({
    try: () => mkdir(destination, { recursive: true }),
    catch: () =>
      sandboxPackageUnsupported(
        "Could not prepare a Git staging directory",
        "Retry scotty sandbox sync after checking local disk space.",
      ),
  });
  const initialized = yield* runInDirectory(
    ["git", "init", "--quiet"],
    destination,
    SANDBOX_GIT_ENV,
  );
  if (initialized.exitCode !== 0)
    return yield* sandboxPackageUnsupported(
      "Could not prepare a Git staging directory",
      "Retry scotty sandbox sync after checking local Git.",
    );
  const fetched = yield* runInDirectory(
    ["git", "fetch", "--quiet", "--depth", "1", "--no-tags", source.repository, source.commit],
    destination,
    SANDBOX_GIT_ENV,
  );
  if (fetched.exitCode !== 0)
    return yield* mapSandboxGitFailure(
      fetched.stderr,
      sandboxPackageUnsupported(
        `Git commit ${source.commit} could not be fetched`,
        "Confirm the repository and configured commit, then retry.",
      ),
    );
  const checkedOut = yield* runInDirectory(
    ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
    destination,
    SANDBOX_GIT_ENV,
  );
  if (checkedOut.exitCode !== 0)
    return yield* sandboxPackageUnsupported(
      `Git commit ${source.commit} could not be checked out`,
      "Confirm the repository and configured commit, then retry.",
    );
  const head = yield* runInDirectory(["git", "rev-parse", "HEAD"], destination, SANDBOX_GIT_ENV);
  if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== source.commit)
    return yield* sandboxPackageUnsupported(
      "Checked-out Git HEAD did not match the configured commit",
      "Retry scotty sandbox sync after confirming the persisted commit.",
    );
});

const installPiPackageDependencies = Effect.fnUntraced(function* (
  directory: string,
  hasRuntimeDependencies: boolean,
  lockFile: WalkedSandboxFile | undefined,
) {
  if (!hasRuntimeDependencies) return;
  if (lockFile === undefined)
    return yield* sandboxPackageUnsupported(
      "Pi packages with runtime dependencies require package-lock.json",
      "Add a lockfile at the repository root, then retry.",
    );
  const installed = yield* runInDirectory(NPM_CI, directory, NPM_ENV);
  if (installed.exitCode !== 0)
    return yield* sandboxPackageUnsupported(
      "npm ci --omit=dev --ignore-scripts failed for the Pi package",
      "Confirm the lockfile and local npm, then retry.",
    );
});

const stripPackageCaches = Effect.fnUntraced(function* (directory: string) {
  yield* Effect.promise(() => rm(join(directory, ".git"), { recursive: true, force: true }));
  yield* Effect.promise(() => rm(join(directory, ".npm"), { recursive: true, force: true }));
  yield* Effect.promise(() =>
    rm(join(directory, "node_modules", ".cache"), { recursive: true, force: true }),
  );
});

export const preparePiPackageSource = Effect.fnUntraced(function* (
  source: PiPackageSource,
  destination: string,
) {
  yield* checkoutPiPackage(source, destination);
  const beforeInstall = yield* walkSandboxTree(destination, {
    ...packageWalkOptions,
    includeNodeModules: false,
  });
  if (
    beforeInstall.some(
      (file) => file.path === ".gitmodules" || file.path.startsWith(".gitmodules/"),
    )
  )
    return yield* sandboxPackageUnsupported(
      "Pi package sources must not contain Git submodules",
      "Remove .gitmodules from the resolved commit.",
    );
  const decoded = yield* Effect.fromResult(readPackageManifest(beforeInstall));
  if (decoded.name !== source.name)
    return yield* sandboxPackageUnsupported(
      `package.json name ${decoded.name} does not match configured name ${source.name}`,
      "Remove and re-add the package at the resolved commit.",
    );
  yield* Effect.fromResult(assertPiResources(destination, beforeInstall, decoded));
  const lockFile = beforeInstall.find((file) => file.path === "package-lock.json");
  const hasRuntimeDependencies = Object.keys(decoded.dependencies ?? {}).length > 0;
  yield* installPiPackageDependencies(destination, hasRuntimeDependencies, lockFile);
  yield* stripPackageCaches(destination);
  const files = yield* walkSandboxTree(destination, packageWalkOptions);
  yield* Effect.fromResult(rejectLfsPointers(files));
  yield* Effect.fromResult(assertPiResources(destination, files, decoded));
  const records = fileRecords(files);
  const manifest: SandboxPiPackageManifest = {
    name: source.name,
    repository: source.repository,
    requestedRef: source.requestedRef,
    commit: source.commit,
    lockDigest: lockFile === undefined ? null : sha256Bytes(lockFile.bytes),
    digest: itemContentDigest(records),
    files: records,
  };
  return { manifest, files };
});

const assembleBundle = (
  skills: ReadonlyArray<{
    readonly manifest: SandboxSkillManifest;
    readonly files: ReadonlyArray<WalkedSandboxFile>;
  }>,
  packages: ReadonlyArray<{
    readonly manifest: SandboxPiPackageManifest;
    readonly files: ReadonlyArray<WalkedSandboxFile>;
  }>,
): Result.Result<BuiltSandboxBundle, CliError> => {
  const fileCount =
    skills.reduce((sum, item) => sum + item.files.length, 0) +
    packages.reduce((sum, item) => sum + item.files.length, 0);
  if (fileCount > SANDBOX_MAX_BUNDLE_FILES)
    return Result.fail(
      sandboxBundleTooLarge(
        "Sandbox bundle exceeds the file-count limit",
        "Remove sources or reduce package contents, then retry.",
      ),
    );
  const manifest: SandboxBundleManifest = {
    schemaVersion: 1,
    skills: skills.map((item) => item.manifest),
    piPackages: packages.map((item) => item.manifest),
  };
  const built = createDeterministicTarGz(
    toArchiveMembers(
      encodeBundleManifestJson(manifest),
      skills.map((item) => ({ name: item.manifest.name, files: item.files })),
      packages.map((item) => ({ name: item.manifest.name, files: item.files })),
    ),
  );
  return Result.succeed({
    digest: built.digest,
    bytes: built.archive.byteLength,
    fileCount,
    manifest,
    archive: built.archive,
  });
};

export const buildSandboxBundle = Effect.fnUntraced(function* (config: SandboxConfig) {
  const skills: Array<{
    readonly manifest: SandboxSkillManifest;
    readonly files: ReadonlyArray<WalkedSandboxFile>;
  }> = [];
  for (const source of [...config.skills].sort((left, right) => compareUtf8(left.name, right.name)))
    skills.push(yield* prepareSkillSource(source));
  if (config.piPackages.length === 0) return yield* Effect.fromResult(assembleBundle(skills, []));
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "scotty-sandbox-bundle-")),
      catch: () =>
        sandboxSourceInvalid(
          "Could not create a staging directory",
          "Retry scotty sandbox sync after checking local disk space.",
        ),
    }),
    (root) =>
      Effect.gen(function* () {
        const packages: Array<{
          readonly manifest: SandboxPiPackageManifest;
          readonly files: ReadonlyArray<WalkedSandboxFile>;
        }> = [];
        const sources = [...config.piPackages].sort((left, right) =>
          compareUtf8(left.name, right.name),
        );
        for (const [index, source] of sources.entries()) {
          packages.push(yield* preparePiPackageSource(source, join(root, `pkg-${index}`)));
        }
        return yield* Effect.fromResult(assembleBundle(skills, packages));
      }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );
});
