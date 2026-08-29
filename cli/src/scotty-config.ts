import { lstat, realpath } from "node:fs/promises";
import { join, parse as parsePath, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parse as parseToml } from "smol-toml";
import { CliError, EXIT } from "./core";
import { ScottyTomlConfigSchema, type ScottyTomlConfig } from "./scotty-config-contracts";
import { FileSystem } from "./services";

export const SCOTTY_TOML_CONFIG_FILE_NAME = "scotty.toml";

export const scottyTomlConfigPath = (home: string): string =>
  join(home, ".config", "scotty", SCOTTY_TOML_CONFIG_FILE_NAME);

const decodeScottyTomlUnknown = Schema.decodeUnknownEffect(ScottyTomlConfigSchema, {
  onExcessProperty: "error",
});

const invalidScottyConfig = (path: string, reason: string): CliError =>
  new CliError(
    "scotty_config_invalid",
    `Scotty TOML configuration is invalid: ${reason}`,
    `Fix ${path}; only version, sync.skills/packages/tools/extensions, repos.allowed, and credentials.<name> are accepted.`,
    EXIT.USAGE,
  );

const configFileFailure = (path: string, reason: string): CliError =>
  invalidScottyConfig(path, reason);

const readScottyToml = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem.readPrivateText(path).pipe(
    Effect.catch((error) => {
      if (error.reason === "missing")
        return Effect.fail(configFileFailure(path, "the file is missing"));
      if (
        error.reason === "permissions" ||
        error.reason === "not_file" ||
        error.reason === "symlink"
      )
        return Effect.fail(
          new CliError(
            "scotty_config_invalid",
            "Scotty TOML configuration must be a private regular file",
            `Use a non-symlinked mode-0600 file at ${path}.`,
            EXIT.USAGE,
          ),
        );
      return Effect.fail(
        new CliError(
          "scotty_config_read_failed",
          "Could not read Scotty TOML configuration",
          `Check permissions on ${path}.`,
          EXIT.GENERIC,
        ),
      );
    }),
  );
});

export const decodeScottyTomlText = Effect.fnUntraced(function* (
  text: string,
  path = SCOTTY_TOML_CONFIG_FILE_NAME,
) {
  const parsed: unknown = yield* Effect.try({
    try: () => parseToml(text),
    catch: () => configFileFailure(path, "the TOML syntax could not be parsed"),
  });
  return yield* decodeScottyTomlUnknown(parsed).pipe(
    Effect.mapError(() => configFileFailure(path, "it contains unsupported or malformed keys")),
  );
});

type ScottyRootCategory = keyof ScottyTomlConfig["sync"];

const rootCategoryDescription: Record<ScottyRootCategory, string> = {
  skills: "skill",
  packages: "package",
  tools: "tool",
  extensions: "extension",
};

const unsafeResolvedRoot = (resolved: string, home: string): boolean =>
  resolved === parsePath(resolved).root || resolved === resolve(home);

const resolveConfiguredRoot = Effect.fnUntraced(function* (input: {
  readonly configPath: string;
  readonly category: ScottyRootCategory;
  readonly source: string;
  readonly home: string;
  readonly cwd: string;
}) {
  const expanded =
    input.source === "~"
      ? input.home
      : input.source.startsWith("~/")
        ? join(input.home, input.source.slice(2))
        : input.source;
  const resolved = resolve(input.cwd, expanded);
  if (unsafeResolvedRoot(resolved, input.home))
    return yield* new CliError(
      "scotty_config_invalid",
      `Scotty TOML ${rootCategoryDescription[input.category]} root is unsafe`,
      `Choose a non-root directory for sync.${input.category}; checked ${input.source}.`,
      EXIT.USAGE,
    );
  const metadata = yield* Effect.tryPromise({
    try: () => lstat(resolved),
    catch: () =>
      invalidScottyConfig(
        input.configPath,
        `sync.${input.category} root ${input.source} does not exist or cannot be read`,
      ),
  });
  if (metadata.isSymbolicLink())
    return yield* new CliError(
      "scotty_config_invalid",
      `Scotty TOML ${rootCategoryDescription[input.category]} root is unsafe`,
      `sync.${input.category} must point directly to a non-symlinked directory; checked ${input.source}.`,
      EXIT.USAGE,
    );
  if (!metadata.isDirectory())
    return yield* invalidScottyConfig(
      input.configPath,
      `sync.${input.category} root ${input.source} is not a directory`,
    );
  const canonical = yield* Effect.tryPromise({
    try: () => realpath(resolved),
    catch: () =>
      invalidScottyConfig(
        input.configPath,
        `sync.${input.category} root ${input.source} cannot be resolved`,
      ),
  });
  if (unsafeResolvedRoot(canonical, input.home))
    return yield* new CliError(
      "scotty_config_invalid",
      `Scotty TOML ${rootCategoryDescription[input.category]} root is unsafe`,
      `Choose a non-root directory for sync.${input.category}; checked ${input.source}.`,
      EXIT.USAGE,
    );
  return canonical;
});

const resolveConfiguredRoots = Effect.fnUntraced(function* (input: {
  readonly configPath: string;
  readonly category: ScottyRootCategory;
  readonly sources: ReadonlyArray<string>;
  readonly home: string;
  readonly cwd: string;
}) {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const source of input.sources) {
    const root = yield* resolveConfiguredRoot({
      configPath: input.configPath,
      category: input.category,
      source,
      home: input.home,
      cwd: input.cwd,
    });
    if (seen.has(root))
      return yield* invalidScottyConfig(
        input.configPath,
        `sync.${input.category} contains duplicate roots after resolution`,
      );
    seen.add(root);
    resolved.push(root);
  }
  return resolved;
});

export const resolveConfiguredCredentialSource = (
  source: string | undefined,
  home: string,
  cwd: string,
): string =>
  resolve(
    cwd,
    source === undefined
      ? ""
      : source === "~"
        ? home
        : source.startsWith("~/")
          ? join(home, source.slice(2))
          : source,
  );

export type ResolvedScottyTomlRoots = {
  readonly skills: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
};

export type LoadedScottyTomlConfig = {
  readonly path: string;
  readonly config: ScottyTomlConfig;
  readonly resolvedRoots: ResolvedScottyTomlRoots;
};

export const loadScottyTomlConfig = Effect.fnUntraced(function* (input: {
  readonly home: string;
  readonly cwd: string;
}) {
  const path = scottyTomlConfigPath(input.home);
  const text = yield* readScottyToml(path);
  const config = yield* decodeScottyTomlText(text, path);
  const resolvedRoots: ResolvedScottyTomlRoots = {
    skills: yield* resolveConfiguredRoots({
      configPath: path,
      category: "skills",
      sources: config.sync.skills,
      home: input.home,
      cwd: input.cwd,
    }),
    packages: yield* resolveConfiguredRoots({
      configPath: path,
      category: "packages",
      sources: config.sync.packages,
      home: input.home,
      cwd: input.cwd,
    }),
    tools: yield* resolveConfiguredRoots({
      configPath: path,
      category: "tools",
      sources: config.sync.tools,
      home: input.home,
      cwd: input.cwd,
    }),
    extensions: yield* resolveConfiguredRoots({
      configPath: path,
      category: "extensions",
      sources: config.sync.extensions,
      home: input.home,
      cwd: input.cwd,
    }),
  };
  return { path, config, resolvedRoots } satisfies LoadedScottyTomlConfig;
});

export const scottyConfigCheckOutput = (loaded: LoadedScottyTomlConfig) => ({
  ok: true as const,
  configPath: loaded.path,
  version: loaded.config.version,
  sync: loaded.config.sync,
  repos: loaded.config.repos,
  ...(loaded.config.credentials === undefined ? {} : { credentials: loaded.config.credentials }),
});

export const formatScottyConfigCheck = (loaded: LoadedScottyTomlConfig): string =>
  `Valid Scotty TOML configuration at ${loaded.path}.\n`;

export * from "./scotty-config-contracts";
