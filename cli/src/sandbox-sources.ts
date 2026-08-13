import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Effect, Result, Schema } from "effect";
import { CliError, EXIT } from "./core";
import {
  BUILTIN_PI_PACKAGE_NAMES,
  BUILTIN_SKILL_NAMES,
  loadSandboxConfig,
  PiPackageNameSchema,
  saveSandboxConfig,
  SkillNameSchema,
  type PiPackageSource,
  type SandboxConfig,
  type SkillSource,
  sandboxNameConflict,
} from "./sandbox-config";
import { FileSystem } from "./services";

export const sandboxSourceInvalid = (message: string, hint: string): CliError =>
  new CliError("sandbox_source_invalid", message, hint, EXIT.USAGE);

const decodeSkillName = Schema.decodeUnknownResult(SkillNameSchema);
const decodePackageManifestJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ name: PiPackageNameSchema })),
);

const builtinSkillNames = new Set<string>(BUILTIN_SKILL_NAMES);
const builtinPiPackageNames = new Set<string>(BUILTIN_PI_PACKAGE_NAMES);

export const parseSkillFrontmatterName = (text: string): Result.Result<string, void> => {
  if (!text.startsWith("---")) return Result.fail(undefined);
  const rest = text.slice(3).replace(/^\r?\n/u, "");
  const end = rest.search(/\r?\n---(?:\r?\n|$)/u);
  if (end === -1) return Result.fail(undefined);
  const match = /^name:\s*(?:["']([^"'\n]+)["']|([^\s#\n]+))\s*$/mu.exec(rest.slice(0, end));
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined) return Result.fail(undefined);
  const decoded = decodeSkillName(raw);
  return Result.isFailure(decoded) ? Result.fail(undefined) : Result.succeed(decoded.success);
};

export const parsePiPackageName = (text: string): Result.Result<string, void> => {
  const decoded = decodePackageManifestJson(text);
  return Result.isFailure(decoded) ? Result.fail(undefined) : Result.succeed(decoded.success.name);
};

const looksLikeGitUrl = (source: string): boolean =>
  source.startsWith("git@") || source.startsWith("ssh://") || source.startsWith("https://");

export const canonicalizeGitRepository = (source: string): Result.Result<string, CliError> => {
  if (source.startsWith("git@")) {
    if (!/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~+/-]+\.git$/u.test(source))
      return Result.fail(
        sandboxSourceInvalid(
          "Git source must be an HTTPS or SSH repository URL",
          "Example: https://github.com/acme/pi-review-tools.git --ref v1.2.0",
        ),
      );
    return Result.succeed(source);
  }
  if (!URL.canParse(source))
    return Result.fail(
      sandboxSourceInvalid(
        "Git source must be an HTTPS or SSH repository URL",
        "Example: https://github.com/acme/pi-review-tools.git --ref v1.2.0",
      ),
    );
  const url = new URL(source);
  if (url.password !== "" || (url.protocol === "https:" && url.username !== ""))
    return Result.fail(
      sandboxSourceInvalid(
        "Git repository URLs must not contain credentials",
        "Use SSH or HTTPS without userinfo, then retry.",
      ),
    );
  if (url.search !== "" || url.hash !== "")
    return Result.fail(
      sandboxSourceInvalid(
        "Git repository URLs must not contain a query or fragment",
        "Pass the repository URL and --ref separately.",
      ),
    );
  if (url.protocol === "ssh:") {
    if (url.username !== "" && url.username !== "git")
      return Result.fail(
        sandboxSourceInvalid(
          "SSH Git URLs must use the git user",
          "Example: ssh://git@github.com/acme/pi-review-tools.git",
        ),
      );
    const path = url.pathname.replace(/\/+$/u, "");
    if (!path.endsWith(".git") || path.split("/").filter(Boolean).length < 2)
      return Result.fail(
        sandboxSourceInvalid(
          "Git source must be an HTTPS or SSH repository URL",
          "Example: ssh://git@github.com/acme/pi-review-tools.git --ref v1.2.0",
        ),
      );
    return Result.succeed(`ssh://git@${url.hostname}${path}`);
  }
  if (url.protocol !== "https:")
    return Result.fail(
      sandboxSourceInvalid(
        "Git source must be an HTTPS or SSH repository URL",
        "Example: https://github.com/acme/pi-review-tools.git --ref v1.2.0",
      ),
    );
  const path = url.pathname.replace(/\/+$/u, "");
  if (path.split("/").filter(Boolean).length < 2)
    return Result.fail(
      sandboxSourceInvalid(
        "Git source must be an HTTPS or SSH repository URL",
        "Example: https://github.com/acme/pi-review-tools.git --ref v1.2.0",
      ),
    );
  return Result.succeed(`${url.origin}${path}`);
};

export type ClassifiedSandboxSource =
  | { readonly kind: "skill"; readonly path: string }
  | { readonly kind: "git"; readonly repository: string };

export const classifySandboxSource = Effect.fnUntraced(function* (
  source: string,
  cwd: string,
  requestedRef: string | undefined,
) {
  if (source.trim() !== source || source.length === 0)
    return yield* sandboxSourceInvalid(
      "Sandbox source is empty or has surrounding whitespace",
      "Pass a local Skill directory or a Git repository URL.",
    );
  if (looksLikeGitUrl(source)) {
    if (requestedRef === undefined)
      return yield* sandboxSourceInvalid(
        "Git package sources require --ref",
        "Pass an explicit tag or commit, not a branch.",
      );
    const repository = yield* Effect.fromResult(canonicalizeGitRepository(source));
    return { kind: "git", repository } as const;
  }
  if (source.includes("://"))
    return yield* sandboxSourceInvalid(
      "Git source must be an HTTPS or SSH repository URL",
      "Example: https://github.com/acme/pi-review-tools.git --ref v1.2.0",
    );
  if (requestedRef !== undefined)
    return yield* sandboxSourceInvalid(
      "--ref is only valid for Git package sources",
      "Omit --ref when adding a local Skill directory.",
    );
  const path = isAbsolute(source) ? source : resolve(cwd, source);
  const metadata = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: () =>
      sandboxSourceInvalid(
        "Skill source must be an existing local directory containing SKILL.md",
        `Checked ${path}.`,
      ),
  });
  if (metadata.isSymbolicLink())
    return yield* sandboxSourceInvalid(
      "Skill source must not be a symlink",
      "Point sandbox add at a real directory.",
    );
  if (!metadata.isDirectory())
    return yield* sandboxSourceInvalid(
      "Skill source must be a local directory containing SKILL.md",
      `Checked ${path}.`,
    );
  return { kind: "skill", path } as const;
});

const readSkillName = Effect.fnUntraced(function* (path: string) {
  const skillMd = join(path, "SKILL.md");
  const metadata = yield* Effect.tryPromise({
    try: () => lstat(skillMd),
    catch: () => sandboxSourceInvalid("Skill source must contain SKILL.md", `Checked ${skillMd}.`),
  });
  if (metadata.isSymbolicLink() || !metadata.isFile())
    return yield* sandboxSourceInvalid(
      "Skill source must contain a regular SKILL.md file",
      `Checked ${skillMd}.`,
    );
  const text = yield* Effect.tryPromise({
    try: () => readFile(skillMd, "utf8"),
    catch: () => sandboxSourceInvalid("Could not read SKILL.md", `Checked ${skillMd}.`),
  });
  const name = parseSkillFrontmatterName(text);
  if (Result.isFailure(name))
    return yield* sandboxSourceInvalid(
      "SKILL.md frontmatter must declare a valid name",
      `Checked ${skillMd}.`,
    );
  return name.success;
});

const configuredNames = (config: SandboxConfig): ReadonlySet<string> =>
  new Set([
    ...config.skills.map((item) => item.name),
    ...config.piPackages.map((item) => item.name),
  ]);

export const assertAvailableSkillName = (
  config: SandboxConfig,
  name: string,
): Result.Result<void, CliError> => {
  if (builtinSkillNames.has(name))
    return Result.fail(
      sandboxNameConflict(name, "Choose a Skill name that does not collide with a built-in Skill."),
    );
  if (configuredNames(config).has(name))
    return Result.fail(
      sandboxNameConflict(name, "Remove the existing source or choose a different name."),
    );
  return Result.succeed(undefined);
};

export const assertAvailablePiPackageName = (
  config: SandboxConfig,
  name: string,
): Result.Result<void, CliError> => {
  if (builtinPiPackageNames.has(name))
    return Result.fail(
      sandboxNameConflict(
        name,
        "Choose a Pi package name that does not collide with a required image package.",
      ),
    );
  if (configuredNames(config).has(name))
    return Result.fail(
      sandboxNameConflict(name, "Remove the existing source or choose a different name."),
    );
  return Result.succeed(undefined);
};

export const addSkillSource = (
  config: SandboxConfig,
  source: SkillSource,
): Result.Result<SandboxConfig, CliError> => {
  const available = assertAvailableSkillName(config, source.name);
  if (Result.isFailure(available)) return Result.fail(available.failure);
  return Result.succeed({
    ...config,
    skills: [...config.skills, source],
  });
};

export const addPiPackageSource = (
  config: SandboxConfig,
  source: PiPackageSource,
): Result.Result<SandboxConfig, CliError> => {
  const available = assertAvailablePiPackageName(config, source.name);
  if (Result.isFailure(available)) return Result.fail(available.failure);
  return Result.succeed({
    ...config,
    piPackages: [...config.piPackages, source],
  });
};

export const removeSandboxSource = (
  config: SandboxConfig,
  name: string,
): Result.Result<
  { readonly config: SandboxConfig; readonly kind: "skill" | "piPackage" },
  CliError
> => {
  const skills = config.skills.filter((item) => item.name === name);
  const packages = config.piPackages.filter((item) => item.name === name);
  if (skills.length + packages.length > 1)
    return Result.fail(
      new CliError(
        "sandbox_name_conflict",
        `Sandbox name ${name} is ambiguous`,
        "Skill and Pi package names must be unique. Edit sandbox.json, then retry.",
        EXIT.USAGE,
      ),
    );
  if (skills.length === 1)
    return Result.succeed({
      kind: "skill",
      config: { ...config, skills: config.skills.filter((item) => item.name !== name) },
    });
  if (packages.length === 1)
    return Result.succeed({
      kind: "piPackage",
      config: { ...config, piPackages: config.piPackages.filter((item) => item.name !== name) },
    });
  return Result.fail(
    new CliError(
      "sandbox_source_invalid",
      `No sandbox source named ${name} is configured`,
      "Run scotty sandbox list, then retry with an exact name.",
      EXIT.NOT_FOUND,
    ),
  );
};

export const mutateSandboxConfig = Effect.fnUntraced(function* (
  path: string,
  mutate: (config: SandboxConfig) => Result.Result<SandboxConfig, CliError>,
) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem.withLock(
    path,
    Effect.gen(function* () {
      const current = yield* loadSandboxConfig(path, true);
      const next = yield* Effect.fromResult(mutate(current));
      return yield* saveSandboxConfig(path, next);
    }),
  );
});

export const readSkillDirectoryName = readSkillName;
