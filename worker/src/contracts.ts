import type { DirectoryBackup } from "@cloudflare/sandbox";

export const DEFAULT_REPO = "anomalyco/rift";
export const DEFAULT_HARD_CAP_SECONDS = 4 * 60 * 60;
export const MIN_HARD_CAP_SECONDS = 60;
export const MAX_HARD_CAP_SECONDS = 24 * 60 * 60;
export const SESSION_ROOT = "/workspace";
export const SESSION_KV_PREFIX = "session:";

export type SessionStatus = "booting" | "warm" | "sleeping" | "failed" | "gone";
export type OperationKind = "create" | "snapshot" | "resume" | "pr" | "down" | "vaporize";

export interface SessionOperation {
  kind: OperationKind;
  nonce: string;
  startedAt: string;
}

export interface SessionFailure {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface SessionRecord {
  version: 1;
  id: string;
  status: SessionStatus;
  operation: SessionOperation | null;
  repo: string;
  repoExistsAtCreate: boolean;
  defaultBranch: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  hardCapAt: string;
  hardCapDurationSeconds: number;
  ownedBackupIds: string[];
  backupExpiresAt?: string;
  backup?: {
    current: DirectoryBackup;
    previous?: DirectoryBackup;
  };
  codexThreadId?: string;
  failure?: SessionFailure;
}

export interface SessionProjection {
  version: 1;
  id: string;
  status: SessionStatus;
  repo: string;
  defaultBranch: string;
  branch: string;
  backupId?: string;
  codexThreadId?: string;
  createdAt: string;
  updatedAt: string;
  hardCapAt: string;
  projectedAt: string;
  failure?: SessionFailure;
}

export interface SessionView extends SessionProjection {
  ageSeconds: number;
  capRemainingSeconds: number;
}

export interface CreateSessionInput {
  prompt: string;
  repo: string;
  hardCapSeconds: number;
}

export interface PrInput {
  title?: string;
}

export interface PrResult {
  prUrl?: string;
  branchUrl: string;
  created: boolean;
}

export interface DownManifest {
  version: 1;
  id: string;
  repo: string;
  branch: string;
  sha: string;
  codexThreadId?: string;
  rolloutFile?: string;
}

export interface DownArchive {
  path: string;
  filename: string;
  manifest: DownManifest;
}

export type ApiErrorCode =
  | "bad_request"
  | "auth"
  | "not_found"
  | "wrong_state"
  | "conflict"
  | "upstream"
  | "internal";

export class ScottyError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly exitCode: 1 | 2 | 3 | 4 | 5;
  readonly hint?: string;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { httpStatus: number; exitCode: 1 | 2 | 3 | 4 | 5; hint?: string },
  ) {
    super(message);
    this.name = "ScottyError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.exitCode = options.exitCode;
    this.hint = options.hint;
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

export function parseCreateInput(value: unknown): CreateSessionInput {
  if (!isRecord(value)) throw badRequest("Request body must be a JSON object");
  const prompt = readNonEmptyString(value.prompt, "prompt", 64_000);
  const repo = value.repo === undefined ? DEFAULT_REPO : parseRepo(value.repo);
  const hardCapSeconds =
    value.hardCapSeconds === undefined
      ? DEFAULT_HARD_CAP_SECONDS
      : readInteger(
          value.hardCapSeconds,
          "hardCapSeconds",
          MIN_HARD_CAP_SECONDS,
          MAX_HARD_CAP_SECONDS,
        );
  return { prompt, repo, hardCapSeconds };
}

export function parsePrInput(value: unknown): PrInput {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw badRequest("Request body must be a JSON object");
  if (value.title === undefined) return {};
  return { title: readNonEmptyString(value.title, "title", 256) };
}

export function parseSessionId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{5,31}$/.test(value)) throw badRequest("Invalid session id");
  return value;
}

export function parseRepo(value: unknown): string {
  const repo = readNonEmptyString(value, "repo", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw badRequest("repo must be in owner/name form");
  }
  return repo;
}

export function toProjection(record: SessionRecord, now = new Date()): SessionProjection {
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

export function toSessionView(projection: SessionProjection, nowMs = Date.now()): SessionView {
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
  if (typeof value !== "string" || value.trim().length === 0)
    throw badRequest(`${field} must be a non-empty string`);
  if (value.length > maxLength)
    throw badRequest(`${field} must be at most ${maxLength} characters`);
  return value.trim();
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
