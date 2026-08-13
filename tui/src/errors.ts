export type TuiErrorCode =
  | "config_missing"
  | "config_invalid"
  | "config_permissions"
  | "input_invalid"
  | "transport_failed"
  | "response_invalid"
  | "response_too_large"
  | "stream_invalid"
  | "pairing_failed";

export class TuiError extends Error {
  readonly code: TuiErrorCode;
  readonly status: number | undefined;

  constructor(code: TuiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TuiError";
    this.code = code;
    this.status = status;
  }
}

export const safeErrorMessage = (error: unknown): string =>
  error instanceof TuiError ? error.message : "scotty tui failed";
