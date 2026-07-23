import type { DirectoryBackup as SandboxDirectoryBackup } from "@cloudflare/sandbox";
import { Option, Schema } from "effect";

export const DEFAULT_REPO = "anomalyco/rift";
export const DEFAULT_HARD_CAP_SECONDS = 4 * 60 * 60;
export const MIN_HARD_CAP_SECONDS = 60;
export const MAX_HARD_CAP_SECONDS = 24 * 60 * 60;
export const SESSION_ROOT = "/workspace";
export const SESSION_KV_PREFIX = "session:";
export const REPO_KV_PREFIX = "repo:";

export const SessionStatusSchema = Schema.Literals([
  "booting",
  "warm",
  "sleeping",
  "failed",
  "gone",
]);
export type SessionStatus = typeof SessionStatusSchema.Type;

export const OperationKindSchema = Schema.Literals([
  "create",
  "snapshot",
  "resume",
  "pr",
  "down",
  "vaporize",
]);
export type OperationKind = typeof OperationKindSchema.Type;

export const SessionOperationSchema = Schema.Struct({
  kind: OperationKindSchema,
  nonce: Schema.String,
  startedAt: Schema.String,
  checkpointedBackupId: Schema.optionalKey(Schema.String),
  stopRequestedAt: Schema.optionalKey(Schema.String),
  stopRollbackAt: Schema.optionalKey(Schema.String),
});
export type SessionOperation = typeof SessionOperationSchema.Type;

export const SessionFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  recoverable: Schema.Boolean,
});
export type SessionFailure = typeof SessionFailureSchema.Type;

export const DirectoryBackupSchema = Schema.Struct({
  id: Schema.String,
  dir: Schema.String,
  localBucket: Schema.optional(Schema.Boolean),
});
export type DirectoryBackup = typeof DirectoryBackupSchema.Type;

type Assert<T extends true> = T;
export type DirectoryBackupSdkCompatibility = Assert<
  DirectoryBackup extends SandboxDirectoryBackup
    ? SandboxDirectoryBackup extends DirectoryBackup
      ? true
      : false
    : false
>;

export const SessionRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  status: SessionStatusSchema,
  operation: Schema.NullOr(SessionOperationSchema),
  repo: Schema.String,
  repoExistsAtCreate: Schema.Boolean,
  defaultBranch: Schema.String,
  branch: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  hardCapAt: Schema.String,
  hardCapDurationSeconds: Schema.Number,
  ownedBackupIds: Schema.Array(Schema.String),
  backupExpiresAt: Schema.optional(Schema.String),
  backup: Schema.optional(
    Schema.Struct({
      current: DirectoryBackupSchema,
      previous: Schema.optional(DirectoryBackupSchema),
    }),
  ),
  codexThreadId: Schema.optional(Schema.String),
  failure: Schema.optional(SessionFailureSchema),
});
export type SessionRecord = typeof SessionRecordSchema.Type;

export function hasCommittedManagedStop(record: SessionRecord): boolean {
  const operation = record.operation;
  const backupId = record.backup?.current.id;
  return (
    operation?.kind === "snapshot" &&
    Boolean(operation.stopRequestedAt) &&
    Boolean(operation.checkpointedBackupId) &&
    operation.checkpointedBackupId === backupId
  );
}

export const decodeSessionRecord = Schema.decodeUnknownEffect(SessionRecordSchema, {
  onExcessProperty: "error",
});
export const decodeSessionRecordResult = Schema.decodeUnknownResult(SessionRecordSchema, {
  onExcessProperty: "error",
});

export const SessionProjectionSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  status: SessionStatusSchema,
  repo: Schema.String,
  defaultBranch: Schema.String,
  branch: Schema.String,
  backupId: Schema.optionalKey(Schema.String),
  codexThreadId: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  hardCapAt: Schema.String,
  projectedAt: Schema.String,
  failure: Schema.optionalKey(SessionFailureSchema),
});
export type SessionProjection = typeof SessionProjectionSchema.Type;

export const decodeSessionProjection = Schema.decodeUnknownOption(SessionProjectionSchema);

export const SessionViewSchema = Schema.Struct({
  ...SessionProjectionSchema.fields,
  ageSeconds: Schema.Number,
  capRemainingSeconds: Schema.Number,
});
export type SessionView = typeof SessionViewSchema.Type;

export const RepoProjectionSchema = Schema.Struct({
  version: Schema.Literal(1),
  repo: Schema.String,
  defaultBranch: Schema.String,
  lastUsedAt: Schema.String,
});
export type RepoProjection = typeof RepoProjectionSchema.Type;

export const decodeRepoProjection = Schema.decodeUnknownOption(RepoProjectionSchema);

export const RepoViewSchema = Schema.Struct({
  repo: Schema.String,
  defaultBranch: Schema.String,
  lastUsedAt: Schema.String,
});
export type RepoView = typeof RepoViewSchema.Type;

export const CreateSessionInputSchema = Schema.Struct({
  prompt: Schema.String,
  repo: Schema.String,
  hardCapSeconds: Schema.Number,
});
export type CreateSessionInput = typeof CreateSessionInputSchema.Type;

export const PrInputSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
});
export type PrInput = typeof PrInputSchema.Type;

export const PrResultSchema = Schema.Struct({
  prUrl: Schema.optionalKey(Schema.String),
  branchUrl: Schema.String,
  created: Schema.Boolean,
});
export type PrResult = typeof PrResultSchema.Type;

export const DownManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  codexThreadId: Schema.optionalKey(Schema.String),
  rolloutFile: Schema.optionalKey(Schema.String),
});
export type DownManifest = typeof DownManifestSchema.Type;

export const DownArchiveSchema = Schema.Struct({
  path: Schema.String,
  filename: Schema.String,
  manifest: DownManifestSchema,
});
export type DownArchive = typeof DownArchiveSchema.Type;

const OptionalNonEmptyStringSchema = Schema.optional(Schema.NonEmptyString);

export const CodexTokenSetSchema = Schema.Struct({
  id_token: OptionalNonEmptyStringSchema,
  access_token: OptionalNonEmptyStringSchema,
  refresh_token: OptionalNonEmptyStringSchema,
  account_id: Schema.NullOr(Schema.NonEmptyString),
});
export type CodexTokenSet = typeof CodexTokenSetSchema.Type;

export const CodexCredentialBundleSchema = Schema.Struct({
  OPENAI_API_KEY: Schema.NullOr(Schema.NonEmptyString),
  tokens: Schema.optional(CodexTokenSetSchema),
  account_id: Schema.NullOr(Schema.NonEmptyString),
  last_refresh: Schema.NullOr(Schema.NonEmptyString),
});
export type CodexCredentialBundle = typeof CodexCredentialBundleSchema.Type;

export const CredentialRefreshLeaseValueSchema = Schema.Struct({
  nonce: Schema.NonEmptyString,
  startedAt: Schema.NonEmptyString,
});

export const StoredCredentialSchema = Schema.Struct({
  codex: CodexCredentialBundleSchema,
  githubToken: Schema.NonEmptyString,
  codexSentinel: Schema.NonEmptyString,
  githubSentinel: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
  refreshLease: Schema.optional(CredentialRefreshLeaseValueSchema),
});
export type StoredCredential = typeof StoredCredentialSchema.Type;

export const LegacyStoredCredentialSchema = Schema.Struct({
  codex: CodexCredentialBundleSchema,
  codexSentinel: Schema.NonEmptyString,
  githubSentinel: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
  refreshLease: Schema.optional(CredentialRefreshLeaseValueSchema),
});
export type LegacyStoredCredential = typeof LegacyStoredCredentialSchema.Type;

export const CredentialSeedSchema = Schema.Struct({
  codexAuthJson: Schema.NonEmptyString,
  codexSentinel: Schema.NonEmptyString,
  githubSentinel: Schema.NonEmptyString,
});
export type CredentialSeed = typeof CredentialSeedSchema.Type;

export const CredentialRefreshLeaseSchema = Schema.Struct({
  credential: StoredCredentialSchema,
  nonce: Schema.NonEmptyString,
});
export type CredentialRefreshLease = typeof CredentialRefreshLeaseSchema.Type;

export const CredentialPatchSchema = Schema.Struct({
  idToken: OptionalNonEmptyStringSchema,
  accessToken: OptionalNonEmptyStringSchema,
  refreshToken: OptionalNonEmptyStringSchema,
});
export type CredentialPatch = typeof CredentialPatchSchema.Type;

export const OAuthRefreshRequestSchema = Schema.StructWithRest(
  Schema.Struct({
    grant_type: Schema.Literal("refresh_token"),
    refresh_token: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type OAuthRefreshRequest = typeof OAuthRefreshRequestSchema.Type;

export const OAuthUpstreamSuccessSchema = Schema.Struct({
  id_token: OptionalNonEmptyStringSchema,
  access_token: Schema.NonEmptyString,
  refresh_token: OptionalNonEmptyStringSchema,
});
export type OAuthUpstreamSuccess = typeof OAuthUpstreamSuccessSchema.Type;

export const OAuthContainerResultSchema = Schema.Struct({
  id_token: Schema.NonEmptyString,
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});
export type OAuthContainerResult = typeof OAuthContainerResultSchema.Type;

const RawCodexCredentialSchema = Schema.Struct({
  OPENAI_API_KEY: Schema.optionalKey(Schema.Unknown),
  tokens: Schema.optionalKey(Schema.Unknown),
  account_id: Schema.optionalKey(Schema.Unknown),
  last_refresh: Schema.optionalKey(Schema.Unknown),
});
const RawCodexTokenSetSchema = Schema.Struct({
  id_token: Schema.optionalKey(Schema.Unknown),
  access_token: Schema.optionalKey(Schema.Unknown),
  refresh_token: Schema.optionalKey(Schema.Unknown),
  account_id: Schema.optionalKey(Schema.Unknown),
});
const RawOAuthUpstreamSuccessSchema = Schema.Struct({
  id_token: Schema.optionalKey(Schema.Unknown),
  access_token: Schema.optionalKey(Schema.Unknown),
  refresh_token: Schema.optionalKey(Schema.Unknown),
});

export const decodeJsonValue = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
export const decodeRawCodexCredential = Schema.decodeUnknownOption(RawCodexCredentialSchema);
export const decodeRawCodexTokenSet = Schema.decodeUnknownOption(RawCodexTokenSetSchema);
export const decodeStoredCredentialOption = Schema.decodeUnknownOption(StoredCredentialSchema);
export const decodeStoredCredentialResult = Schema.decodeUnknownResult(StoredCredentialSchema, {
  onExcessProperty: "error",
});
export const decodeLegacyStoredCredentialResult = Schema.decodeUnknownResult(
  LegacyStoredCredentialSchema,
  { onExcessProperty: "error" },
);
export const decodeCredentialSeedResult = Schema.decodeUnknownResult(CredentialSeedSchema, {
  onExcessProperty: "error",
});
export const decodeNonEmptyStringResult = Schema.decodeUnknownResult(Schema.NonEmptyString);
export const decodeCredentialRefreshLeaseOption = Schema.decodeUnknownOption(
  Schema.NullOr(CredentialRefreshLeaseSchema),
);
export const decodeCredentialPatchOption = Schema.decodeUnknownOption(CredentialPatchSchema);
export const decodeCredentialPatchResult = Schema.decodeUnknownResult(CredentialPatchSchema);
export const decodeOAuthRefreshRequestOption =
  Schema.decodeUnknownOption(OAuthRefreshRequestSchema);
export const decodeRawOAuthUpstreamSuccess = Schema.decodeUnknownOption(
  RawOAuthUpstreamSuccessSchema,
);
export const decodeOAuthUpstreamSuccessOption = Schema.decodeUnknownOption(
  OAuthUpstreamSuccessSchema,
);
export const decodeOAuthContainerResultOption = Schema.decodeUnknownOption(
  OAuthContainerResultSchema,
);

export const ApiErrorCodeSchema = Schema.Literals([
  "bad_request",
  "auth",
  "not_found",
  "wrong_state",
  "conflict",
  "upstream",
  "internal",
]);
export type ApiErrorCode = typeof ApiErrorCodeSchema.Type;

const PublicErrorMessageFields = {
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
};

export const PublicErrorSchema = Schema.Union([
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("bad_request"),
    httpStatus: Schema.Literal(400),
    exitCode: Schema.Literal(2),
  }),
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("auth"),
    httpStatus: Schema.Literal(401),
    exitCode: Schema.Literal(4),
  }),
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("not_found"),
    httpStatus: Schema.Literal(404),
    exitCode: Schema.Literal(3),
  }),
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("wrong_state"),
    httpStatus: Schema.Literal(409),
    exitCode: Schema.Literal(5),
  }),
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("conflict"),
    httpStatus: Schema.Literal(409),
    exitCode: Schema.Literal(5),
  }),
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("upstream"),
    httpStatus: Schema.Literal(502),
    exitCode: Schema.Literal(1),
  }),
  Schema.Struct({
    ...PublicErrorMessageFields,
    code: Schema.Literal("internal"),
    httpStatus: Schema.Literal(500),
    exitCode: Schema.Literal(1),
  }),
]);
export type PublicError = typeof PublicErrorSchema.Type;
export const decodePublicError = Schema.decodeUnknownEffect(PublicErrorSchema);

export const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({
    code: ApiErrorCodeSchema,
    message: Schema.String,
    hint: Schema.optionalKey(Schema.String),
  }),
});
export type ErrorEnvelope = typeof ErrorEnvelopeSchema.Type;
export const decodeErrorEnvelope = Schema.decodeUnknownEffect(ErrorEnvelopeSchema);

const ScottyErrorFields = {
  code: ApiErrorCodeSchema,
  message: Schema.String,
  httpStatus: Schema.Number,
  exitCode: Schema.Literals([1, 2, 3, 4, 5]),
  hint: Schema.optionalKey(Schema.String),
};

export class ScottyError extends Schema.TaggedErrorClass<ScottyError>("ScottyError")(
  "ScottyError",
  ScottyErrorFields,
) {
  constructor(
    code: ApiErrorCode,
    message: string,
    options: { httpStatus: number; exitCode: 1 | 2 | 3 | 4 | 5; hint?: string },
  ) {
    super({
      code,
      message,
      httpStatus: options.httpStatus,
      exitCode: options.exitCode,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    });
  }
}

export function badRequest(message: string, hint?: string): ScottyError {
  return new ScottyError("bad_request", message, { httpStatus: 400, exitCode: 2, hint });
}

export function notFound(id: string): ScottyError {
  return new ScottyError("not_found", `Session ${id} was not found`, {
    httpStatus: 404,
    exitCode: 3,
  });
}

export function wrongState(status: SessionStatus, operation: string, hint?: string): ScottyError {
  return new ScottyError("wrong_state", `Cannot ${operation} a session in ${status} state`, {
    httpStatus: 409,
    exitCode: 5,
    hint,
  });
}

export function conflict(message: string): ScottyError {
  return new ScottyError("conflict", message, { httpStatus: 409, exitCode: 5 });
}

const RawCreateSessionInputSchema = Schema.Struct({
  prompt: Schema.optionalKey(Schema.Unknown),
  repo: Schema.optionalKey(Schema.Unknown),
  hardCapSeconds: Schema.optionalKey(Schema.Unknown),
});
const decodeRawCreateSessionInput = Schema.decodeUnknownOption(RawCreateSessionInputSchema);

export function parseCreateInput(value: unknown): CreateSessionInput {
  const decoded = decodeRawCreateSessionInput(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Request body must be a JSON object");
  const prompt = readNonEmptyString(decoded.value.prompt, "prompt", 64_000);
  const repo = decoded.value.repo === undefined ? DEFAULT_REPO : parseRepo(decoded.value.repo);
  const hardCapSeconds =
    decoded.value.hardCapSeconds === undefined
      ? DEFAULT_HARD_CAP_SECONDS
      : readInteger(
          decoded.value.hardCapSeconds,
          "hardCapSeconds",
          MIN_HARD_CAP_SECONDS,
          MAX_HARD_CAP_SECONDS,
        );
  return { prompt, repo, hardCapSeconds };
}

const RawPrInputSchema = Schema.NullOr(
  Schema.Struct({
    title: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeRawPrInput = Schema.decodeUnknownOption(RawPrInputSchema);

export function parsePrInput(value: unknown): PrInput {
  if (value === undefined) return {};
  const decoded = decodeRawPrInput(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Request body must be a JSON object");
  if (decoded.value === null || decoded.value.title === undefined) return {};
  return { title: readNonEmptyString(decoded.value.title, "title", 256) };
}

export function parseSessionId(value: string): string {
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono path parser preserves the existing thrown ScottyError contract
  if (!/^[a-z0-9][a-z0-9-]{5,31}$/.test(value)) throw badRequest("Invalid session id");
  return value;
}

export function parseRepo(value: unknown): string {
  const repo = readNonEmptyString(value, "repo", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest("repo must be in owner/name form");
  }
  return repo;
}

export function toProjection(record: SessionRecord, now: Date): SessionProjection {
  return {
    version: 1,
    id: record.id,
    status: record.status,
    repo: record.repo,
    defaultBranch: record.defaultBranch,
    branch: record.branch,
    backupId: record.backup?.current.id,
    codexThreadId: record.codexThreadId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hardCapAt: record.hardCapAt,
    projectedAt: now.toISOString(),
    failure: record.failure,
  };
}

export function toSessionView(projection: SessionProjection, nowMs: number): SessionView {
  return {
    ...projection,
    ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(projection.createdAt)) / 1000)),
    capRemainingSeconds: Math.max(0, Math.floor((Date.parse(projection.hardCapAt) - nowMs) / 1000)),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest(`${field} must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
