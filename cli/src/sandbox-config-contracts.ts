import { Schema } from "effect";

export const SANDBOX_CONFIG_SCHEMA_VERSION = 1 as const;

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
