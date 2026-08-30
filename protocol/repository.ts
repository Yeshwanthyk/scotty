import { Schema } from "effect";

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;

const INVALID_DEFAULT_BRANCH_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/** Returns true only for a Git branch name accepted by the GitHub repository API. */
export const isDefaultBranchName = (branch: string): boolean => {
  const hasInvalidCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) ||
      INVALID_DEFAULT_BRANCH_CHARACTERS.has(character)
    );
  });
  if (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch.startsWith("-") ||
    branch === "@" ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    hasInvalidCharacter
  )
    return false;
  return branch
    .split("/")
    .every(
      (segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"),
    );
};

/** Returns true only for a two-segment repository identity safe to place in a URL path. */
export const isRepositoryIdentity = (value: string): boolean => {
  const segments = value.split("/");
  return (
    segments.length === 2 &&
    segments.every(
      (segment) => REPOSITORY_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..",
    )
  );
};

export const RepositoryIdentitySchema = Schema.String.check(
  Schema.makeFilter(isRepositoryIdentity, { expected: "a safe owner/name repository identity" }),
);

export const RepositoryDefaultBranchSchema = Schema.String.check(
  Schema.makeFilter(isDefaultBranchName, { expected: "a valid non-empty GitHub default branch" }),
);

export const RepositoryTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter(
    (value) => {
      const millis = Date.parse(value);
      return Number.isFinite(millis) && new Date(millis).toISOString() === value;
    },
    { expected: "a canonical UTC timestamp with millisecond precision" },
  ),
);

export const RepositoryRegistryEntrySchema = Schema.Struct({
  repo: RepositoryIdentitySchema,
  defaultBranch: RepositoryDefaultBranchSchema,
  addedAt: RepositoryTimestampSchema,
  lastUsedAt: RepositoryTimestampSchema,
}).check(
  Schema.makeFilter((entry) => Date.parse(entry.lastUsedAt) >= Date.parse(entry.addedAt), {
    expected: "lastUsedAt must not precede addedAt",
  }),
);
export type RepositoryRegistryEntry = typeof RepositoryRegistryEntrySchema.Type;

export const RepositoryRegistryAuthoritySchema = Schema.Struct({
  entries: Schema.Array(RepositoryRegistryEntrySchema),
});
export type RepositoryRegistryAuthority = typeof RepositoryRegistryAuthoritySchema.Type;

export const RepositoryRegistryUpsertInputSchema = Schema.Struct({
  repo: RepositoryIdentitySchema,
  defaultBranch: RepositoryDefaultBranchSchema,
});
export type RepositoryRegistryUpsertInput = typeof RepositoryRegistryUpsertInputSchema.Type;

export const RepositoryRegistryRemovalResponseSchema = Schema.Struct({
  repo: RepositoryIdentitySchema,
  removed: Schema.Boolean,
});

export const decodeRepositoryRegistryEntry = Schema.decodeUnknownOption(
  RepositoryRegistryEntrySchema,
  { onExcessProperty: "error" },
);
export const decodeRepositoryRegistryAuthority = Schema.decodeUnknownOption(
  RepositoryRegistryAuthoritySchema,
  { onExcessProperty: "error" },
);
export const decodeRepositoryRegistryUpsertInput = Schema.decodeUnknownOption(
  RepositoryRegistryUpsertInputSchema,
  { onExcessProperty: "error" },
);
export const decodeRepositoryRegistryRemoveInput =
  Schema.decodeUnknownOption(RepositoryIdentitySchema);

/** Decodes the small HTTP request accepted by POST /api/repos. */
export const RepositoryRegistryRequestSchema = Schema.Struct({
  repo: RepositoryIdentitySchema,
});
export type RepositoryRegistryRequest = typeof RepositoryRegistryRequestSchema.Type;
export const decodeRepositoryRegistryRequest = Schema.decodeUnknownOption(
  RepositoryRegistryRequestSchema,
  { onExcessProperty: "error" },
);

/** Returns newest entries first, with a stable repository tie-breaker. */
export const compareRepositoryRegistryEntries = (
  left: Pick<RepositoryRegistryEntry, "repo" | "lastUsedAt">,
  right: Pick<RepositoryRegistryEntry, "repo" | "lastUsedAt">,
): number =>
  Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt) || left.repo.localeCompare(right.repo);

/** Case-insensitive identity used to avoid duplicate GitHub repository entries. */
export const repositoryIdentityKey = (repo: string): string => repo.toLocaleLowerCase("en-US");
