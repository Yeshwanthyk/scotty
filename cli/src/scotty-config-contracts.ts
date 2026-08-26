import { Schema } from "effect";
import { RepositoryIdentitySchema, repositoryIdentityKey } from "../../protocol/repository";

export const SCOTTY_TOML_CONFIG_SCHEMA_VERSION = 1 as const;

const hasUnresolvedPathPlaceholder = (value: string): boolean =>
  value.includes("$") ||
  value.includes("{{") ||
  value.includes("}}") ||
  /%[A-Za-z_][A-Za-z0-9_]*%/u.test(value);

const isSupportedLocalRootValue = (value: string): boolean =>
  value.length > 0 &&
  value.trim() === value &&
  !value.includes("\0") &&
  !hasUnresolvedPathPlaceholder(value) &&
  (!value.startsWith("~") || value === "~" || value.startsWith("~/"));

export const ScottyLocalRootPathSchema = Schema.String.check(
  Schema.makeFilter(isSupportedLocalRootValue, {
    expected: "a local source root without unresolved placeholders",
  }),
);

const hasUniqueRepositoryIdentities = (repositories: ReadonlyArray<string>): boolean => {
  const identities = repositories.map(repositoryIdentityKey);
  return new Set(identities).size === identities.length;
};

export const ScottyAllowedRepositorySchema = Schema.Array(RepositoryIdentitySchema).check(
  Schema.makeFilter(hasUniqueRepositoryIdentities, {
    expected: "unique repository identities",
  }),
);

export const ScottyTomlSyncSchema = Schema.Struct({
  skills: Schema.Array(ScottyLocalRootPathSchema),
  packages: Schema.Array(ScottyLocalRootPathSchema),
  tools: Schema.Array(ScottyLocalRootPathSchema),
  extensions: Schema.Array(ScottyLocalRootPathSchema),
});

export const ScottyTomlRepositoriesSchema = Schema.Struct({
  allowed: ScottyAllowedRepositorySchema,
});

export const ScottyTomlConfigSchema = Schema.Struct({
  version: Schema.Literal(SCOTTY_TOML_CONFIG_SCHEMA_VERSION),
  sync: ScottyTomlSyncSchema,
  repos: ScottyTomlRepositoriesSchema,
});

export type ScottyTomlSync = typeof ScottyTomlSyncSchema.Type;
export type ScottyTomlRepositories = typeof ScottyTomlRepositoriesSchema.Type;
export type ScottyTomlConfig = typeof ScottyTomlConfigSchema.Type;
