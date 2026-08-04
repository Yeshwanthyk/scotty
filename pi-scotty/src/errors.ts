export type PiScottyErrorCode =
  | "config_missing"
  | "config_invalid"
  | "config_permissions"
  | "input_invalid"
  | "transport_failed"
  | "response_invalid"
  | "response_too_large"
  | "stream_invalid"
  | "pairing_failed";

export class PiScottyError extends Error {
  readonly code: PiScottyErrorCode;
  readonly status: number | undefined;

  constructor(code: PiScottyErrorCode, message: string, status?: number) {
    super(message);
    this.name = "PiScottyError";
    this.code = code;
    this.status = status;
  }
}

export const safeErrorMessage = (error: unknown): string =>
  error instanceof PiScottyError ? error.message : "pi-scotty failed";
