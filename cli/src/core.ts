export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  WRONG_STATE: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export type JsonObject = Record<string, unknown>;
export type Writer = (text: string) => void;

export interface GlobalOptions {
  json: boolean;
  host?: string;
  token?: string;
}

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly exitCode: ExitCode;
}> {
  constructor(code: string, message: string, hint: string, exitCode: ExitCode) {
    super({ code, message, hint, exitCode });
  }
}

export const VERSION = "0.2.0";
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MUTATION_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const PENDING_UP_TTL_MS = 24 * 60 * 60_000;
import { Data } from "effect";
