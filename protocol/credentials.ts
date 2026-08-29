import { Option, Schema } from "effect";
import { RepositoryIdentitySchema, repositoryIdentityKey } from "./repository";

const CREDENTIAL_NAME_PATTERN = /^(?:[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u;
const CREDENTIAL_SEGMENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const CREDENTIAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

const hasUnresolvedPathPlaceholder = (value: string): boolean =>
  value.includes("$") ||
  value.includes("{{") ||
  value.includes("}}") ||
  /%[A-Za-z_][A-Za-z0-9_]*%/u.test(value);

export const CredentialNameSchema = Schema.String.check(
  Schema.isPattern(CREDENTIAL_NAME_PATTERN, {
    expected: "a lowercase credential name",
  }),
);
export type CredentialName = typeof CredentialNameSchema.Type;

export const CredentialKindSchema = Schema.Literals(["pi-auth", "github-cli"]);
export type CredentialKind = typeof CredentialKindSchema.Type;

export const CredentialScopeSchema = Schema.Literals(["global", "repository"]);
export type CredentialScope = typeof CredentialScopeSchema.Type;

export const CredentialSourceSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      value.length <= 1_024 &&
      value.trim() === value &&
      !value.includes("\0") &&
      !hasUnresolvedPathPlaceholder(value) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
      (!value.startsWith("~") || value === "~" || value.startsWith("~/")) &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
    { expected: "a bounded local credential source pointer" },
  ),
);
export type CredentialSource = typeof CredentialSourceSchema.Type;

export const CredentialRepositoriesSchema = Schema.NonEmptyArray(RepositoryIdentitySchema).check(
  Schema.makeFilter(
    (repositories) => new Set(repositories.map(repositoryIdentityKey)).size === repositories.length,
    { expected: "unique exact credential repository identities" },
  ),
);
export type CredentialRepositories = typeof CredentialRepositoriesSchema.Type;

const CredentialScopeDeclarationShape = {
  scope: CredentialScopeSchema,
  repositories: Schema.optionalKey(CredentialRepositoriesSchema),
};

const hasRepositoriesForScope = (declaration: {
  readonly scope: CredentialScope;
  readonly repositories?: CredentialRepositories;
}): boolean =>
  declaration.scope === "global"
    ? declaration.repositories === undefined
    : declaration.repositories !== undefined;

export const PiAuthCredentialDeclarationSchema = Schema.Struct({
  kind: Schema.Literal("pi-auth"),
  source: CredentialSourceSchema,
  scope: Schema.Literal("global"),
});
export type PiAuthCredentialDeclaration = typeof PiAuthCredentialDeclarationSchema.Type;

export const GithubCliCredentialDeclarationSchema = Schema.Struct({
  kind: Schema.Literal("github-cli"),
  source: Schema.optionalKey(Schema.Never),
  ...CredentialScopeDeclarationShape,
}).check(
  Schema.makeFilter(hasRepositoriesForScope, {
    expected: "repository policy matching the credential scope",
  }),
);
export type GithubCliCredentialDeclaration = typeof GithubCliCredentialDeclarationSchema.Type;

export const CredentialDeclarationSchema = Schema.Union([
  PiAuthCredentialDeclarationSchema,
  GithubCliCredentialDeclarationSchema,
]);
export type CredentialDeclaration = typeof CredentialDeclarationSchema.Type;

export const CredentialDeclarationsSchema = Schema.Record(
  Schema.String,
  CredentialDeclarationSchema,
).check(
  Schema.makeFilter(
    (declarations) => Object.keys(declarations).every((name) => CREDENTIAL_NAME_PATTERN.test(name)),
    { expected: "credential declarations keyed by strict credential names" },
  ),
);
export type CredentialDeclarations = typeof CredentialDeclarationsSchema.Type;

export const decodeCredentialNameOption = Schema.decodeUnknownOption(CredentialNameSchema);
export const decodePiAuthCredentialDeclarationOption = Schema.decodeUnknownOption(
  PiAuthCredentialDeclarationSchema,
  { onExcessProperty: "error" },
);
export const decodeGithubCliCredentialDeclarationOption = Schema.decodeUnknownOption(
  GithubCliCredentialDeclarationSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialDeclarationOption = Schema.decodeUnknownOption(
  CredentialDeclarationSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialDeclarationsOption = Schema.decodeUnknownOption(
  CredentialDeclarationsSchema,
  { onExcessProperty: "error" },
);

export const isCredentialName = (value: unknown): value is CredentialName =>
  Option.isSome(decodeCredentialNameOption(value));

export const CredentialVersionRefSchema = Schema.String.check(
  Schema.isPattern(CREDENTIAL_VERSION_PATTERN, {
    expected: "a bounded credential version reference",
  }),
);
export type CredentialVersionRef = typeof CredentialVersionRefSchema.Type;

export const ManagedHandleProviderSchema = Schema.String.check(
  Schema.isPattern(CREDENTIAL_SEGMENT_PATTERN, {
    expected: "a lowercase managed-handle provider",
  }),
);
export type ManagedHandleProvider = typeof ManagedHandleProviderSchema.Type;

export const ManagedHandleSlotNameSchema = Schema.Literals(["api-key", "access", "git-https"]);
export type ManagedHandleSlotName = typeof ManagedHandleSlotNameSchema.Type;

export const ManagedHandleSlotSchema = Schema.Struct({
  provider: ManagedHandleProviderSchema,
  slot: ManagedHandleSlotNameSchema,
});
export type ManagedHandleSlot = typeof ManagedHandleSlotSchema.Type;

export const ManagedHandleSchema = Schema.Struct({
  name: CredentialNameSchema,
  provider: ManagedHandleProviderSchema,
  slot: ManagedHandleSlotNameSchema,
});
export type ManagedHandle = typeof ManagedHandleSchema.Type;

const decodeManagedHandle = Schema.decodeUnknownOption(ManagedHandleSchema, {
  onExcessProperty: "error",
});

export const formatManagedHandle = (handle: ManagedHandle): string =>
  `scotty-managed://${handle.name}/${handle.provider}/${handle.slot}`;

export const parseManagedHandle = (value: unknown): Option.Option<ManagedHandle> => {
  const prefix = "scotty-managed://";
  if (typeof value !== "string" || !value.startsWith(prefix)) return Option.none();
  const segments = value.slice(prefix.length).split("/");
  if (segments.length !== 3) return Option.none();
  const decoded = decodeManagedHandle({
    name: segments[0],
    provider: segments[1],
    slot: segments[2],
  });
  return Option.isSome(decoded) && formatManagedHandle(decoded.value) === value
    ? decoded
    : Option.none();
};

export const isManagedHandle = (value: unknown): value is string =>
  Option.isSome(parseManagedHandle(value));

const uniqueManagedHandleSlots = (slots: ReadonlyArray<ManagedHandleSlot>): boolean =>
  new Set(slots.map(({ provider, slot }) => `${provider}\u0000${slot}`)).size === slots.length;

export const CredentialGrantHandleSlotsSchema = Schema.NonEmptyArray(ManagedHandleSlotSchema).check(
  Schema.makeFilter(uniqueManagedHandleSlots, {
    expected: "unique non-empty managed credential handle slots",
  }),
);
export type CredentialGrantHandleSlots = typeof CredentialGrantHandleSlotsSchema.Type;

export const CredentialGrantSchema = Schema.Struct({
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  versionRef: CredentialVersionRefSchema,
  handleSlots: CredentialGrantHandleSlotsSchema,
  expires: Schema.optionalKey(Schema.Finite),
}).check(
  Schema.makeFilter((grant) => grant.kind === "pi-auth" || grant.expires === undefined, {
    expected: "expiry metadata on Pi credentials only",
  }),
);
export type CredentialGrant = typeof CredentialGrantSchema.Type;

export const CredentialRedactedMetadataSchema = Schema.Struct({
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  scope: CredentialScopeSchema,
  repositories: Schema.optionalKey(CredentialRepositoriesSchema),
  configured: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (metadata) =>
      metadata.scope === "global"
        ? metadata.repositories === undefined
        : metadata.repositories !== undefined,
    { expected: "repository policy matching the credential scope" },
  ),
);
export type CredentialRedactedMetadata = typeof CredentialRedactedMetadataSchema.Type;

export const decodeCredentialGrantOption = Schema.decodeUnknownOption(CredentialGrantSchema, {
  onExcessProperty: "error",
});
export const decodeCredentialRedactedMetadataOption = Schema.decodeUnknownOption(
  CredentialRedactedMetadataSchema,
  { onExcessProperty: "error" },
);
