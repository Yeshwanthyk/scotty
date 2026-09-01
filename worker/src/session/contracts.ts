import type { DirectoryBackup as SandboxDirectoryBackup } from "@cloudflare/sandbox";
import { Effect, Option, Schema } from "effect";
import { PI_CONSOLE_MAX_STRING_BYTES } from "../../../protocol/pi-console";
import { CredentialGrantSchema } from "../../../protocol/credentials";
import {
  RepositoryDefaultBranchSchema,
  RepositoryIdentitySchema,
  RepositoryTimestampSchema,
  isRepositoryIdentity,
} from "../../../protocol/repository";
import { SandboxDigestSchema } from "../sandbox/config-contracts";

export const DEFAULT_HARD_CAP_SECONDS = 4 * 60 * 60;
export const MIN_HARD_CAP_SECONDS = 60;
export const MAX_HARD_CAP_SECONDS = 24 * 60 * 60;
export const SESSION_ROOT = "/workspace";
export const SESSION_KV_PREFIX = "session:";
export const REPO_KV_PREFIX = "repo:";
export const WORKSPACE_CREATION_KV_PREFIX = "stats:workspace-created:";

export const ProviderSchema = Schema.Literals(["cloudflare", "runner"]);
export type Provider = typeof ProviderSchema.Type;

export const ExecutionBindingSchema = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("cloudflare") }),
  Schema.Struct({
    provider: Schema.Literal("runner"),
    runner: Schema.String,
    runtimeId: Schema.String,
  }),
]);
export type ExecutionBinding = typeof ExecutionBindingSchema.Type;

const SessionIdSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{5,31}$/));
const SessionRepositoryIdentitySchema = RepositoryIdentitySchema;
const ShortHexIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u));
const IdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{16,128}$/u));
const decodeSessionId = Schema.decodeUnknownOption(SessionIdSchema);
const ContainerSteerMessageSchema = Schema.String.check(
  Schema.makeFilter(
    (message) =>
      message.trim().length > 0 &&
      !message.trimStart().startsWith("/") &&
      new TextEncoder().encode(message).byteLength <= PI_CONSOLE_MAX_STRING_BYTES,
    { expected: "a bounded non-command steering message" },
  ),
);
export const ContainerSessionRequestSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("inspect"),
    targetId: SessionIdSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("steer"),
    targetId: SessionIdSchema,
    message: ContainerSteerMessageSchema,
  }),
]);
export type ContainerSessionRequest = typeof ContainerSessionRequestSchema.Type;
export const decodeContainerSessionRequest = Schema.decodeUnknownOption(
  ContainerSessionRequestSchema,
  { onExcessProperty: "error" },
);
const decodeShortHexId = Schema.decodeUnknownOption(ShortHexIdSchema);
const decodeIdempotencyKey = Schema.decodeUnknownOption(IdempotencyKeySchema);
const decodeProvider = Schema.decodeUnknownOption(ProviderSchema);

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
  "evidence",
  "hatch",
  "down",
  "vaporize",
]);
export type OperationKind = typeof OperationKindSchema.Type;

export const SessionOperationSchema = Schema.Struct({
  kind: OperationKindSchema,
  nonce: Schema.String,
  startedAt: Schema.String,
  createPhase: Schema.optionalKey(Schema.Literals(["setup", "runtime"])),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (operation) => (operation.kind === "create") === (operation.createPhase !== undefined),
      { expected: "only create operations to include a create phase" },
    ),
  ),
);
export type SessionOperation = typeof SessionOperationSchema.Type;

export const SessionCreateSetupStageSchema = Schema.Literals([
  "materialize",
  "seed",
  "preflight",
  "pi_health",
  "warm_commit",
  "runtime_phase",
]);
export type SessionCreateSetupStage = typeof SessionCreateSetupStageSchema.Type;

export const SessionFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  recoverable: Schema.Boolean,
  stage: Schema.optionalKey(SessionCreateSetupStageSchema),
});
export type SessionFailure = typeof SessionFailureSchema.Type;

export const AgentActivityStateSchema = Schema.Literals([
  "working",
  "waiting",
  "completed",
  "tool-stalled",
]);
export type AgentActivityState = typeof AgentActivityStateSchema.Type;

export const DirectoryBackupSchema = Schema.Struct({
  id: Schema.String,
  dir: Schema.String,
  localBucket: Schema.optional(Schema.Boolean),
});
export type DirectoryBackup = typeof DirectoryBackupSchema.Type;

export const SessionSandboxBundleSchema = Schema.Struct({
  digest: Schema.NullOr(SandboxDigestSchema),
});
export type SessionSandboxBundle = typeof SessionSandboxBundleSchema.Type;

export const SessionCredentialGrantSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  grants: Schema.Array(CredentialGrantSchema),
});
export type SessionCredentialGrant = typeof SessionCredentialGrantSchema.Type;

type Assert<T extends true> = T;
export type DirectoryBackupSdkCompatibility = Assert<
  DirectoryBackup extends SandboxDirectoryBackup
    ? SandboxDirectoryBackup extends DirectoryBackup
      ? true
      : false
    : false
>;

export const SessionRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: SessionStatusSchema,
  operation: Schema.NullOr(SessionOperationSchema),
  execution: ExecutionBindingSchema,
  provider: ProviderSchema,
  runner: Schema.optionalKey(Schema.String),
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
  agentState: Schema.optional(AgentActivityStateSchema),
  lastAgentEventAt: Schema.optional(Schema.String),
  failure: Schema.optional(SessionFailureSchema),
  sandboxBundle: SessionSandboxBundleSchema,
  credentialGrant: Schema.optionalKey(SessionCredentialGrantSchema),
});
export type SessionRecord = typeof SessionRecordSchema.Type;

export const decodeSessionRecordResult = Schema.decodeUnknownResult(SessionRecordSchema, {
  onExcessProperty: "error",
});

export const SessionProjectionSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: SessionStatusSchema,
  deleting: Schema.optionalKey(Schema.Boolean),
  provider: ProviderSchema,
  runner: Schema.optionalKey(Schema.String),
  repo: Schema.String,
  defaultBranch: Schema.String,
  branch: Schema.String,
  backupId: Schema.optionalKey(Schema.String),
  codexThreadId: Schema.optionalKey(Schema.String),
  agentState: Schema.optionalKey(AgentActivityStateSchema),
  lastAgentEventAt: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  hardCapAt: Schema.String,
  projectedAt: Schema.String,
  failure: Schema.optionalKey(SessionFailureSchema),
  sandboxBundle: SessionSandboxBundleSchema,
});
export type SessionProjection = typeof SessionProjectionSchema.Type;

export const decodeSessionProjection = Schema.decodeUnknownOption(SessionProjectionSchema);

export const SessionViewSchema = Schema.Struct({
  ...SessionProjectionSchema.fields,
  ageSeconds: Schema.Number,
  capRemainingSeconds: Schema.Number,
});
export type SessionView = typeof SessionViewSchema.Type;

export const WorkspaceCreationMarkerSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  repository: SessionRepositoryIdentitySchema,
  provider: ProviderSchema,
  createdAt: Schema.String,
});
export type WorkspaceCreationMarker = typeof WorkspaceCreationMarkerSchema.Type;
export const decodeWorkspaceCreationMarker = Schema.decodeUnknownOption(
  WorkspaceCreationMarkerSchema,
);

const StatsCountSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const StatsCountsFields = {
  workspacesCreated: StatsCountSchema,
  warmNow: StatsCountSchema,
  sleepingNow: StatsCountSchema,
};

export const StatsResponseSchema = Schema.Struct({
  trackingSince: Schema.NullOr(Schema.String),
  overall: Schema.Struct({
    ...StatsCountsFields,
    projects: StatsCountSchema,
  }),
  projects: Schema.Array(
    Schema.Struct({
      repository: RepositoryIdentitySchema,
      ...StatsCountsFields,
      lastCreated: Schema.String,
    }),
  ),
});
export type StatsResponse = typeof StatsResponseSchema.Type;
export const decodeStatsResponse = Schema.decodeUnknownOption(StatsResponseSchema);

export const RepoProjectionSchema = Schema.Struct({
  repo: RepositoryIdentitySchema,
  defaultBranch: RepositoryDefaultBranchSchema,
  addedAt: Schema.optionalKey(RepositoryTimestampSchema),
  lastUsedAt: RepositoryTimestampSchema,
});
export type RepoProjection = typeof RepoProjectionSchema.Type;

export const decodeRepoProjection = Schema.decodeUnknownOption(RepoProjectionSchema);

export const RepoViewSchema = Schema.Struct({
  repo: RepositoryIdentitySchema,
  defaultBranch: RepositoryDefaultBranchSchema,
  addedAt: Schema.optionalKey(RepositoryTimestampSchema),
  lastUsedAt: RepositoryTimestampSchema,
});
export type RepoView = typeof RepoViewSchema.Type;

export const CreateSessionInputSchema = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
  provider: ProviderSchema,
  runner: Schema.optionalKey(Schema.String),
  repo: Schema.String,
  newRepo: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  hardCapSeconds: Schema.Number,
});
export type CreateSessionInput = typeof CreateSessionInputSchema.Type;

export const DownManifestSchema = Schema.Struct({
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

export const decodeNonEmptyStringResult = Schema.decodeUnknownResult(Schema.NonEmptyString);

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

export class ScottyError extends Schema.TaggedError<ScottyError>("ScottyError")(
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
  title: Schema.optionalKey(Schema.Unknown),
  prompt: Schema.optionalKey(Schema.Unknown),
  provider: Schema.optionalKey(Schema.Unknown),
  runner: Schema.optionalKey(Schema.Unknown),
  repo: Schema.optionalKey(Schema.Unknown),
  newRepo: Schema.optionalKey(Schema.Unknown),
  hardCapSeconds: Schema.optionalKey(Schema.Unknown),
});
const decodeRawCreateSessionInput = Schema.decodeUnknownOption(RawCreateSessionInputSchema);

export function parseCreateInput(value: unknown): CreateSessionInput {
  const decoded = decodeRawCreateSessionInput(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Request body must be a JSON object");
  const title = parseSessionTitle(decoded.value.title);
  const prompt = readNonEmptyString(decoded.value.prompt, "prompt", 64_000);
  const provider = parseProvider(decoded.value.provider);
  const runner =
    decoded.value.runner === undefined
      ? undefined
      : readNonEmptyString(decoded.value.runner, "runner", 128);
  if (provider === "cloudflare" && runner !== undefined)
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest("runner is not valid with cloudflare");
  if (provider === "runner" && runner === undefined)
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest("runner is required for runner");
  const repo = parseRepo(decoded.value.repo);
  const newRepo =
    decoded.value.newRepo === undefined ? false : readBoolean(decoded.value.newRepo, "newRepo");
  const hardCapSeconds =
    decoded.value.hardCapSeconds === undefined
      ? DEFAULT_HARD_CAP_SECONDS
      : readInteger(
          decoded.value.hardCapSeconds,
          "hardCapSeconds",
          MIN_HARD_CAP_SECONDS,
          MAX_HARD_CAP_SECONDS,
        );
  return {
    title,
    prompt,
    provider,
    ...(runner === undefined ? {} : { runner }),
    repo,
    newRepo,
    hardCapSeconds,
  };
}

const RawRenameSessionInputSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.Unknown),
});
const decodeRawRenameSessionInput = Schema.decodeUnknownOption(RawRenameSessionInputSchema);
const RawSteerInputSchema = Schema.Struct({
  message: Schema.optionalKey(Schema.Unknown),
});
const decodeRawSteerInput = Schema.decodeUnknownOption(RawSteerInputSchema, {
  onExcessProperty: "error",
});

export function parseSteerInput(value: unknown): string {
  const decoded = decodeRawSteerInput(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Request body must contain only message");
  const message = decoded.value.message;
  if (typeof message !== "string" || message.trim().length === 0)
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest("message must be a non-empty string");
  if (new TextEncoder().encode(message).byteLength > PI_CONSOLE_MAX_STRING_BYTES)
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest(`message must be at most ${PI_CONSOLE_MAX_STRING_BYTES} UTF-8 bytes`);
  if (message.trimStart().startsWith("/"))
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest("message must be a prompt, not a slash command");
  return message;
}

export function parseRenameSessionInput(value: unknown): string {
  const decoded = decodeRawRenameSessionInput(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Request body must be a JSON object");
  return parseSessionTitle(decoded.value.title);
}

export function parseSessionTitle(value: unknown): string {
  return readNonEmptyString(value, "title", 120);
}

export function parseSessionId(value: string): string {
  const decoded = decodeSessionId(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono path parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Invalid session id");
  return decoded.value;
}

export function parseAuthClientId(value: string): string {
  const decoded = decodeShortHexId(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono path parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Invalid registered client id");
  return decoded.value;
}

export function parseIdempotencyKey(value: string): string {
  const decoded = decodeIdempotencyKey(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono header parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("Invalid idempotency key");
  return decoded.value;
}

export function parseRepo(value: unknown): string {
  const repo = readNonEmptyString(value, "repo", 200);
  if (!isRepositoryIdentity(repo)) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest("repo must be in owner/name form");
  }
  return repo;
}

export function parseProvider(value: unknown): Provider {
  const decoded = decodeProvider(value);
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
  if (Option.isNone(decoded)) throw badRequest("provider must be cloudflare or runner");
  return decoded.value;
}

export function toProjection(record: SessionRecord, now: Date): SessionProjection {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    deleting: record.operation?.kind === "vaporize" ? true : undefined,
    provider: record.provider,
    runner: record.runner,
    repo: record.repo,
    defaultBranch: record.defaultBranch,
    branch: record.branch,
    backupId: record.backup?.current.id,
    codexThreadId: record.codexThreadId,
    agentState: record.agentState,
    lastAgentEventAt: record.lastAgentEventAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hardCapAt: record.hardCapAt,
    projectedAt: now.toISOString(),
    failure: record.failure,
    sandboxBundle: record.sandboxBundle,
  };
}

export function toSessionView(projection: SessionProjection, nowMs: number): SessionView {
  return {
    ...projection,
    ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(projection.createdAt)) / 1000)),
    capRemainingSeconds: Math.max(0, Math.floor((Date.parse(projection.hardCapAt) - nowMs) / 1000)),
  };
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

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: synchronous Hono request parser preserves the existing thrown ScottyError contract
    throw badRequest(`${field} must be a boolean`);
  }
  return value;
}
