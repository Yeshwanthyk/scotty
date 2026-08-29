import { Option, Result, Schema } from "effect";
import {
  CredentialGrantHandleSlotsSchema,
  CredentialGrantSchema,
  CredentialKindSchema,
  CredentialNameSchema,
  CredentialRedactedMetadataSchema,
  CredentialRepositoriesSchema,
  CredentialScopeSchema,
  CredentialVersionRefSchema,
  isManagedHandle,
  ManagedHandleSchema,
  parseManagedHandle,
  type CredentialGrant,
  type CredentialKind,
  type CredentialName,
  type CredentialRedactedMetadata,
  type CredentialRepositories,
  type CredentialScope,
  type CredentialVersionRef,
  type ManagedHandle,
} from "../../protocol/credentials";
import { RepositoryIdentitySchema } from "../../protocol/repository";
import {
  PI_AUTH_MAX_MATERIAL_BYTES,
  PiAuthStoreSchema,
  serializePiAuthProviders,
} from "../../protocol/pi-auth";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,31}$/u;
const INSTALLATION_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const CREDENTIAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_ENCRYPTED_CREDENTIAL_BYTES = 256 * 1024;
const LEGACY_MAX_ROTATION_FIELD_LENGTH = 256 * 1024;
const LEGACY_CREDENTIAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const isCanonicalBase64Url = (value: string): boolean =>
  value.length > 0 &&
  value.length <= Math.ceil((MAX_ENCRYPTED_CREDENTIAL_BYTES * 4) / 3) + 4 &&
  value.length % 4 !== 1 &&
  BASE64URL_PATTERN.test(value);

const boundedText = (value: string, maximum: number): boolean =>
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value &&
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });

const LegacyBoundedRotationFieldSchema = Schema.String.check(
  Schema.makeFilter((value) => boundedText(value, LEGACY_MAX_ROTATION_FIELD_LENGTH), {
    expected: "a bounded non-empty rotation field",
  }),
);

const LegacyCredentialDigestSchema = Schema.String.check(
  Schema.isPattern(LEGACY_CREDENTIAL_DIGEST_PATTERN, { expected: "a SHA-256 digest" }),
);

export const CredentialBase64UrlSchema = Schema.String.check(
  Schema.makeFilter(isCanonicalBase64Url, { expected: "bounded unpadded base64url" }),
);
export type CredentialBase64Url = typeof CredentialBase64UrlSchema.Type;

export const EncryptedCredentialEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: CredentialKindSchema,
  iv: CredentialBase64UrlSchema,
  ciphertext: CredentialBase64UrlSchema,
  keyedDigest: CredentialBase64UrlSchema,
});
export type EncryptedCredentialEnvelope = typeof EncryptedCredentialEnvelopeSchema.Type;

export const CredentialVersionEnvelopeSchema = Schema.Struct({
  versionRef: CredentialVersionRefSchema,
  envelope: EncryptedCredentialEnvelopeSchema,
});
export type CredentialVersionEnvelope = typeof CredentialVersionEnvelopeSchema.Type;

export const CredentialSessionIdSchema = Schema.String.check(
  Schema.isPattern(SESSION_ID_PATTERN, { expected: "a valid Session identifier" }),
);
export type CredentialSessionId = typeof CredentialSessionIdSchema.Type;

export const CredentialInstallationNameSchema = Schema.String.check(
  Schema.isPattern(INSTALLATION_NAME_PATTERN, {
    expected: "a 2-32 character lowercase installation name",
  }),
);
export type CredentialInstallationName = typeof CredentialInstallationNameSchema.Type;

export const CredentialTimestampSchema = Schema.String.check(
  Schema.isPattern(CREDENTIAL_TIMESTAMP_PATTERN, {
    expected: "a canonical UTC timestamp with millisecond precision",
  }),
).check(
  Schema.makeFilter(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    { expected: "a canonical UTC timestamp with millisecond precision" },
  ),
);
export type CredentialTimestamp = typeof CredentialTimestampSchema.Type;

export const CredentialEncryptionContextSchema = Schema.Struct({
  installation: CredentialInstallationNameSchema,
  name: CredentialNameSchema,
  version: CredentialVersionRefSchema,
  kind: CredentialKindSchema,
});
export type CredentialEncryptionContext = typeof CredentialEncryptionContextSchema.Type;

const CredentialRepositoryPolicyShape = {
  repositories: Schema.optionalKey(CredentialRepositoriesSchema),
} as const;

export const CredentialRegistrySyncEntrySchema = Schema.Struct({
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  scope: CredentialScopeSchema,
  ...CredentialRepositoryPolicyShape,
  versionRef: CredentialVersionRefSchema,
  envelope: EncryptedCredentialEnvelopeSchema,
  expires: Schema.optionalKey(Schema.Finite),
})
  .check(
    Schema.makeFilter((entry) => entry.kind === "pi-auth" || entry.expires === undefined, {
      expected: "expiry metadata on Pi credentials only",
    }),
  )
  .check(
    Schema.makeFilter((entry) => entry.kind === entry.envelope.kind, {
      expected: "credential kind matching its encrypted envelope",
    }),
  )
  .check(
    Schema.makeFilter(
      (entry) =>
        entry.scope === "global"
          ? entry.repositories === undefined
          : entry.repositories !== undefined,
      { expected: "repository policy matching the credential scope" },
    ),
  );
export type CredentialRegistrySyncEntry = typeof CredentialRegistrySyncEntrySchema.Type;
const CredentialRegistryGithubTokenSchema = Schema.String.check(
  Schema.makeFilter((value) => boundedText(value, PI_AUTH_MAX_MATERIAL_BYTES), {
    expected: "a bounded GitHub credential",
  }),
);

export const CredentialRegistrySyncMaterialSchema = Schema.Union([
  Schema.Struct({
    name: CredentialNameSchema,
    kind: Schema.Literal("pi-auth"),
    scope: Schema.Literal("global"),
    providers: PiAuthStoreSchema,
  }).check(
    Schema.makeFilter(
      ({ providers }) =>
        new TextEncoder().encode(serializePiAuthProviders(providers)).byteLength <=
        PI_AUTH_MAX_MATERIAL_BYTES,
      { expected: "bounded Pi provider material" },
    ),
  ),
  Schema.Struct({
    name: CredentialNameSchema,
    kind: Schema.Literal("github-cli"),
    scope: CredentialScopeSchema,
    ...CredentialRepositoryPolicyShape,
    token: CredentialRegistryGithubTokenSchema,
  }).check(
    Schema.makeFilter(
      ({ scope, repositories }) =>
        scope === "global" ? repositories === undefined : repositories !== undefined,
      { expected: "repository policy matching the credential scope" },
    ),
  ),
]);
export type CredentialRegistrySyncMaterial = typeof CredentialRegistrySyncMaterialSchema.Type;

export const CredentialRegistryDesiredSyncInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(CredentialRegistrySyncMaterialSchema).check(
    Schema.makeFilter(
      (credentials) => new Set(credentials.map(({ name }) => name)).size === credentials.length,
      { expected: "unique credential names" },
    ),
  ),
});
export type CredentialRegistryDesiredSyncInput =
  typeof CredentialRegistryDesiredSyncInputSchema.Type;

export const CredentialRegistrySyncEntriesSchema = Schema.Array(
  CredentialRegistrySyncEntrySchema,
).check(
  Schema.makeFilter((entries) => new Set(entries.map(({ name }) => name)).size === entries.length, {
    expected: "unique credential names",
  }),
);

export const CredentialRegistrySyncInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: CredentialRegistrySyncEntriesSchema,
});
export type CredentialRegistrySyncInput = typeof CredentialRegistrySyncInputSchema.Type;

export const CREDENTIAL_REGISTRY_SYNC_MAX_BODY_BYTES = 1_048_576;

export const CredentialRegistrySyncResultSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(CredentialRedactedMetadataSchema),
});
export type CredentialRegistrySyncResult = typeof CredentialRegistrySyncResultSchema.Type;

export const CredentialRegistryGrantInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: CredentialSessionIdSchema,
  repository: Schema.optionalKey(RepositoryIdentitySchema),
});
export type CredentialRegistryGrantInput = typeof CredentialRegistryGrantInputSchema.Type;

export const CredentialRegistryGrantResultSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: CredentialSessionIdSchema,
  grants: Schema.Array(CredentialGrantSchema),
});
export type CredentialRegistryGrantResult = typeof CredentialRegistryGrantResultSchema.Type;
export const CredentialRegistryGithubCliResolveInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  repository: RepositoryIdentitySchema,
});
export type CredentialRegistryGithubCliResolveInput =
  typeof CredentialRegistryGithubCliResolveInputSchema.Type;

const CredentialRegistryResolvedCredentialValueSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      boundedText(value, PI_AUTH_MAX_MATERIAL_BYTES) &&
      new TextEncoder().encode(value).byteLength <= PI_AUTH_MAX_MATERIAL_BYTES,
    { expected: "a bounded resolved credential" },
  ),
);

export const CredentialRegistryResolvedCredentialSchema = Schema.Struct({
  version: Schema.Literal(1),
  value: CredentialRegistryResolvedCredentialValueSchema,
});
export type CredentialRegistryResolvedCredential =
  typeof CredentialRegistryResolvedCredentialSchema.Type;

const ManagedHandleTextSchema = Schema.String.check(
  Schema.makeFilter(isManagedHandle, { expected: "a valid managed credential handle" }),
);
export { ManagedHandleTextSchema };
export type ManagedHandleText = typeof ManagedHandleTextSchema.Type;

export const CredentialRegistryResolveInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: CredentialSessionIdSchema,
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  versionRef: CredentialVersionRefSchema,
  handle: ManagedHandleTextSchema,
}).check(
  Schema.makeFilter(
    (input) => {
      const handle = parseManagedHandle(input.handle);
      return Option.isSome(handle) && handle.value.name === input.name;
    },
    { expected: "a managed handle for the requested credential" },
  ),
);
export type CredentialRegistryResolveInput = typeof CredentialRegistryResolveInputSchema.Type;

const uniqueGrantNames = (grants: ReadonlyArray<CredentialGrant>): boolean =>
  new Set(grants.map(({ name }) => name)).size === grants.length;
const CredentialGrantListSchema = Schema.Array(CredentialGrantSchema).check(
  Schema.makeFilter(uniqueGrantNames, { expected: "unique credential grants" }),
);

export const CredentialRegistryReleaseInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: CredentialSessionIdSchema,
  grants: Schema.optionalKey(CredentialGrantListSchema),
});
export type CredentialRegistryReleaseInput = typeof CredentialRegistryReleaseInputSchema.Type;

export const CredentialRegistryReleaseResultSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: CredentialSessionIdSchema,
  released: Schema.Boolean,
});
export type CredentialRegistryReleaseResult = typeof CredentialRegistryReleaseResultSchema.Type;

export const CredentialRegistryVersionRecordSchema = Schema.Struct({
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  versionRef: CredentialVersionRefSchema,
  envelope: EncryptedCredentialEnvelopeSchema,
  createdAt: CredentialTimestampSchema,
  expires: Schema.optionalKey(Schema.Finite),
})
  .check(
    Schema.makeFilter((version) => version.kind === "pi-auth" || version.expires === undefined, {
      expected: "expiry metadata on Pi credentials only",
    }),
  )
  .check(
    Schema.makeFilter((version) => version.kind === version.envelope.kind, {
      expected: "credential kind matching its encrypted envelope",
    }),
  );
export type CredentialRegistryVersionRecord = typeof CredentialRegistryVersionRecordSchema.Type;
export const CredentialRegistryCredentialSchema = Schema.Struct({
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  scope: CredentialScopeSchema,
  ...CredentialRepositoryPolicyShape,
  currentVersionRef: CredentialVersionRefSchema,
}).check(
  Schema.makeFilter(
    (credential) =>
      credential.scope === "global"
        ? credential.repositories === undefined
        : credential.repositories !== undefined,
    { expected: "repository policy matching the credential scope" },
  ),
);
export type CredentialRegistryCredential = typeof CredentialRegistryCredentialSchema.Type;
export const CredentialRegistryGrantRecordSchema = Schema.Struct({
  sessionId: CredentialSessionIdSchema,
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  versionRef: CredentialVersionRefSchema,
  handleSlots: CredentialGrantHandleSlotsSchema,
  expires: Schema.optionalKey(Schema.Finite),
  issuedAt: CredentialTimestampSchema,
}).check(
  Schema.makeFilter((grant) => grant.kind === "pi-auth" || grant.expires === undefined, {
    expected: "expiry metadata on Pi credentials only",
  }),
);
export type CredentialRegistryGrantRecord = typeof CredentialRegistryGrantRecordSchema.Type;
export const CredentialRegistryAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(CredentialRegistryCredentialSchema),
  versions: Schema.Array(CredentialRegistryVersionRecordSchema),
  grants: Schema.Array(CredentialRegistryGrantRecordSchema),
  issuedSessions: Schema.optionalKey(Schema.Array(CredentialSessionIdSchema)),
});
export type CredentialRegistryAuthority = typeof CredentialRegistryAuthoritySchema.Type;

const LegacyCredentialRefreshLeaseSchema = Schema.Struct({
  sessionId: CredentialSessionIdSchema,
  nonce: LegacyBoundedRotationFieldSchema,
  startedAt: CredentialTimestampSchema,
});

const LegacyCredentialRegistryVersionRecordSchema = Schema.Struct({
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  versionRef: CredentialVersionRefSchema,
  envelope: EncryptedCredentialEnvelopeSchema,
  createdAt: CredentialTimestampSchema,
  refreshLease: Schema.optionalKey(LegacyCredentialRefreshLeaseSchema),
}).check(
  Schema.makeFilter((version) => version.kind === version.envelope.kind, {
    expected: "credential kind matching its encrypted envelope",
  }),
);

const LegacyCredentialRegistryRotationCompletionSchema = Schema.Struct({
  sessionId: CredentialSessionIdSchema,
  name: CredentialNameSchema,
  kind: CredentialKindSchema,
  versionRef: CredentialVersionRefSchema,
  nonceDigest: LegacyCredentialDigestSchema,
  patchDigest: LegacyCredentialDigestSchema,
  completedAt: CredentialTimestampSchema,
});

const LegacyCredentialRegistryAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(CredentialRegistryCredentialSchema),
  versions: Schema.Array(LegacyCredentialRegistryVersionRecordSchema),
  grants: Schema.Array(CredentialRegistryGrantRecordSchema),
  issuedSessions: Schema.optionalKey(Schema.Array(CredentialSessionIdSchema)),
  rotationCompletions: Schema.optionalKey(
    Schema.Array(LegacyCredentialRegistryRotationCompletionSchema).check(
      Schema.makeFilter((completions) => completions.length <= 32, {
        expected: "bounded OAuth rotation completion metadata",
      }),
    ),
  ),
});

export const decodeEncryptedCredentialEnvelopeResult = Schema.decodeUnknownResult(
  EncryptedCredentialEnvelopeSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialVersionEnvelopeResult = Schema.decodeUnknownResult(
  CredentialVersionEnvelopeSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistrySyncInputResult = Schema.decodeUnknownResult(
  CredentialRegistrySyncInputSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryDesiredSyncInputResult = Schema.decodeUnknownResult(
  CredentialRegistryDesiredSyncInputSchema,
  { onExcessProperty: "error" },
);

export const decodeCredentialRegistrySyncResult = Schema.decodeUnknownResult(
  CredentialRegistrySyncResultSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryGrantInputResult = Schema.decodeUnknownResult(
  CredentialRegistryGrantInputSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryGithubCliResolveInputResult = Schema.decodeUnknownResult(
  CredentialRegistryGithubCliResolveInputSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryResolvedCredentialResult = Schema.decodeUnknownResult(
  CredentialRegistryResolvedCredentialSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryGrantResult = Schema.decodeUnknownResult(
  CredentialRegistryGrantResultSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryResolveInputResult = Schema.decodeUnknownResult(
  CredentialRegistryResolveInputSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryReleaseInputResult = Schema.decodeUnknownResult(
  CredentialRegistryReleaseInputSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryReleaseResult = Schema.decodeUnknownResult(
  CredentialRegistryReleaseResultSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialRegistryAuthorityResult = Schema.decodeUnknownResult(
  CredentialRegistryAuthoritySchema,
  { onExcessProperty: "error" },
);
const decodeLegacyCredentialRegistryAuthorityResult = Schema.decodeUnknownResult(
  LegacyCredentialRegistryAuthoritySchema,
  { onExcessProperty: "error" },
);

export const decodePersistedCredentialRegistryAuthorityResult = (
  value: unknown,
): Result.Result<CredentialRegistryAuthority, Schema.SchemaError> => {
  const current = decodeCredentialRegistryAuthorityResult(value);
  if (Result.isSuccess(current)) return current;
  const legacy = decodeLegacyCredentialRegistryAuthorityResult(value);
  if (Result.isFailure(legacy)) return current;
  const { rotationCompletions: _rotationCompletions, ...authority } = legacy.success;
  return Result.succeed({
    ...authority,
    versions: authority.versions.map(({ refreshLease: _refreshLease, ...version }) => version),
  });
};

export type {
  CredentialGrant,
  CredentialKind,
  CredentialName,
  CredentialRedactedMetadata,
  CredentialRepositories,
  CredentialScope,
  CredentialVersionRef,
  ManagedHandle,
};
export { CredentialGrantHandleSlotsSchema, ManagedHandleSchema };

export const decodeCredentialGrantOption = Schema.decodeUnknownOption(CredentialGrantSchema, {
  onExcessProperty: "error",
});
export const decodeCredentialRedactedMetadataOption = Schema.decodeUnknownOption(
  CredentialRedactedMetadataSchema,
  { onExcessProperty: "error" },
);
export const decodeManagedHandleOption = Schema.decodeUnknownOption(ManagedHandleSchema, {
  onExcessProperty: "error",
});
const decodeManagedHandleTextOption = Schema.decodeUnknownOption(ManagedHandleTextSchema);

export const isManagedHandleText = (value: string): value is ManagedHandleText =>
  Option.isSome(decodeManagedHandleTextOption(value));
