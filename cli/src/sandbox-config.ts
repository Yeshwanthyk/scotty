import { join } from "node:path";
import { Effect, Option, Result, Schema } from "effect";
import { CliError, EXIT } from "./core";
import { FileSystem } from "./services";

export const SANDBOX_CONFIG_SCHEMA_VERSION = 1 as const;
export const SANDBOX_CONFIG_FILE_NAME = "sandbox.json";

export const SkillNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
);
export const PiPackageNameSchema = Schema.String.check(
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);
export const GitCommitSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
export const AbsolutePathSchema = Schema.String.check(
  Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0"), {
    expected: "an absolute filesystem path",
  }),
);
export const GitRepositorySchema = Schema.NonEmptyString;

export const SkillSourceSchema = Schema.Struct({
  name: SkillNameSchema,
  path: AbsolutePathSchema,
});
export const PiPackageSourceSchema = Schema.Struct({
  name: PiPackageNameSchema,
  repository: GitRepositorySchema,
  commit: GitCommitSchema,
  requestedRef: Schema.NonEmptyString,
});
export const SandboxConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SANDBOX_CONFIG_SCHEMA_VERSION),
  skills: Schema.Array(SkillSourceSchema),
  piPackages: Schema.Array(PiPackageSourceSchema),
});
export type SkillSource = typeof SkillSourceSchema.Type;
export type PiPackageSource = typeof PiPackageSourceSchema.Type;
export type SandboxConfig = typeof SandboxConfigSchema.Type;

export const SandboxRemoteStatusSchema = Schema.Literals([
  "not_queried",
  "unavailable",
  "synchronized",
  "diverged",
]);
export const SandboxDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const SandboxStatusOutputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SANDBOX_CONFIG_SCHEMA_VERSION),
  skills: Schema.Array(SkillSourceSchema),
  piPackages: Schema.Array(PiPackageSourceSchema),
  remote: Schema.Struct({
    status: SandboxRemoteStatusSchema,
    activeDigest: Schema.NullOr(SandboxDigestSchema),
  }),
});
export type SandboxStatusOutput = typeof SandboxStatusOutputSchema.Type;

const decodeSandboxConfigJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(SandboxConfigSchema),
  { onExcessProperty: "error" },
);
const encodeSandboxConfig = Schema.encodeSync(SandboxConfigSchema);

export const BUILTIN_SKILL_NAMES = [
  "breadboarding",
  "domain-modeling",
  "frontend-design",
  "grill-me",
  "grill-with-docs",
  "grilling",
  "i-have-adhd",
  "impeccable",
  "improve-codebase-architecture",
  "interactive-explainer",
  "make-interfaces-feel-better",
  "prototype",
  "research",
  "shaping",
  "stateful-systems",
  "to-spec",
  "to-tickets",
  "wayfinder",
  "yesh-architect",
  "yesh-debug",
  "yesh-how",
  "yesh-plan",
  "yesh-structure-review",
] as const;

export const BUILTIN_PI_PACKAGE_NAMES = [
  "@ogulcancelik/pi-codex-compaction",
  "pi-amp-ui",
  "pi-askuser",
  "pi-background-terminals",
  "pi-subagents",
  "pi-tasks",
  "pi-web-access",
  "pi-workflows",
  "scotty-browser-test",
  "scotty-hatch",
] as const;

export const emptySandboxConfig = (): SandboxConfig => ({
  schemaVersion: SANDBOX_CONFIG_SCHEMA_VERSION,
  skills: [],
  piPackages: [],
});

export const sandboxConfigPath = (home: string): string =>
  join(home, ".scotty", SANDBOX_CONFIG_FILE_NAME);

export const sandboxConfigInvalid = (path: string): CliError =>
  new CliError(
    "sandbox_config_invalid",
    "Sandbox configuration is invalid",
    `Fix ${path} without removing valid entries, then retry.`,
    EXIT.USAGE,
  );

export const sandboxNameConflict = (name: string, hint: string): CliError =>
  new CliError("sandbox_name_conflict", `Sandbox name ${name} is already used`, hint, EXIT.USAGE);

export const sortSandboxConfig = (config: SandboxConfig): SandboxConfig => ({
  schemaVersion: SANDBOX_CONFIG_SCHEMA_VERSION,
  skills: [...config.skills].sort((left, right) => left.name.localeCompare(right.name)),
  piPackages: [...config.piPackages].sort((left, right) => left.name.localeCompare(right.name)),
});

export const encodeSandboxConfigJson = (config: SandboxConfig): string =>
  `${JSON.stringify(encodeSandboxConfig(sortSandboxConfig(config)), null, 2)}\n`;

export const decodeSandboxConfigText = (text: string): Result.Result<SandboxConfig, void> => {
  const decoded = decodeSandboxConfigJson(text);
  if (Result.isFailure(decoded)) return Result.fail(undefined);
  return Result.succeed(sortSandboxConfig(decoded.success));
};

export const localSandboxStatus = (config: SandboxConfig): SandboxStatusOutput => ({
  schemaVersion: SANDBOX_CONFIG_SCHEMA_VERSION,
  skills: config.skills,
  piPackages: config.piPackages,
  remote: { status: "not_queried", activeDigest: null },
});

export const formatSandboxStatus = (status: SandboxStatusOutput): string => {
  const skills =
    status.skills.length === 0
      ? "  (none)\n"
      : status.skills.map((skill) => `  ${skill.name}  ${skill.path}\n`).join("");
  const packages =
    status.piPackages.length === 0
      ? "  (none)\n"
      : status.piPackages
          .map(
            (item) =>
              `  ${item.name}  ${item.repository}  ${item.commit}  (${item.requestedRef})\n`,
          )
          .join("");
  const remote =
    status.remote.status === "not_queried"
      ? "Remote installation was not queried.\n"
      : status.remote.status === "unavailable"
        ? "Remote installation status is unavailable.\n"
        : status.remote.status === "synchronized"
          ? `Remote active digest ${status.remote.activeDigest} is synchronized.\n`
          : `Remote active digest ${status.remote.activeDigest} differs from local desired state.\n`;
  return `Skills:\n${skills}Pi packages:\n${packages}${remote}`;
};

const writeSandboxConfig = Effect.fnUntraced(function* (path: string, config: SandboxConfig) {
  const fileSystem = yield* FileSystem;
  yield* fileSystem.writeSecure(path, encodeSandboxConfigJson(config));
});

export const loadSandboxConfig = Effect.fnUntraced(function* (
  path: string,
  createIfMissing: boolean,
) {
  const fileSystem = yield* FileSystem;
  const text = yield* fileSystem.readPrivateText(path).pipe(
    Effect.map(Option.some),
    Effect.catch((error) => {
      if (error.reason === "missing") return Effect.succeed(Option.none<string>());
      if (
        error.reason === "permissions" ||
        error.reason === "not_file" ||
        error.reason === "symlink"
      )
        return Effect.fail(
          new CliError(
            "sandbox_config_invalid",
            "Sandbox configuration must be a private regular file",
            `Use a non-symlinked mode-0600 file at ${path}.`,
            EXIT.USAGE,
          ),
        );
      return Effect.fail(
        new CliError(
          "sandbox_config_invalid",
          "Could not read sandbox configuration",
          `Check permissions on ${path}.`,
          EXIT.GENERIC,
        ),
      );
    }),
  );
  if (Option.isNone(text)) {
    if (!createIfMissing)
      return yield* new CliError(
        "sandbox_config_invalid",
        "Sandbox configuration is missing",
        `Run scotty init or scotty sandbox list to create ${path}.`,
        EXIT.USAGE,
      );
    const empty = emptySandboxConfig();
    yield* writeSandboxConfig(path, empty);
    return empty;
  }
  const decoded = decodeSandboxConfigText(text.value);
  if (Result.isFailure(decoded)) return yield* sandboxConfigInvalid(path);
  return decoded.success;
});

export const saveSandboxConfig = Effect.fnUntraced(function* (path: string, config: SandboxConfig) {
  yield* writeSandboxConfig(path, config);
  return sortSandboxConfig(config);
});
