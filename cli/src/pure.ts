import { basename } from "node:path";
import { Option, Result } from "effect";
import scottySkill from "../skills/scotty/SKILL.md" with { type: "text" };
import { CliError, EXIT, type ExitCode, type JsonObject, type Writer } from "./core";
import {
  decodeNonEmptyString,
  decodeRawSessionFailure,
  decodeRecoveryGrantResponse,
  decodeString,
  decodeUpResponse,
  type SessionResponse,
} from "./schemas";

export const EMBEDDED_SKILL = scottySkill;

export function outputJson(write: Writer, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

export function invalidResponse(message = "Server returned an invalid response"): CliError {
  return new CliError(
    "invalid_response",
    message,
    "Check that the CLI and Worker versions match.",
    EXIT.GENERIC,
  );
}

export function optionalString(value: unknown): string | undefined {
  return Option.getOrUndefined(decodeNonEmptyString(value));
}

export function usage(message: string, hint = "Run scotty --help for usage."): CliError {
  return new CliError("bad_usage", message, hint, EXIT.USAGE);
}

export function normalizeHost(raw: string): Result.Result<string, CliError> {
  if (!URL.canParse(raw))
    return Result.fail(
      usage(
        "Host must be an absolute http:// or https:// URL",
        "Example: https://scotty.example.workers.dev",
      ),
    );
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return Result.fail(usage("Host must use http:// or https://"));
  if (url.username || url.password || url.search || url.hash)
    return Result.fail(usage("Host must not contain credentials, a query, or a fragment"));
  return Result.succeed(url.origin + url.pathname.replace(/\/+$/, ""));
}

export function sanitizeUrl(
  raw: string,
  host: string,
  id?: string,
): Result.Result<string, CliError> {
  if (!URL.canParse(host) || !URL.canParse(raw, host))
    return Result.fail(
      invalidResponse(
        id ? `Worker returned an invalid session URL for ${id}` : "Worker returned an invalid URL",
      ),
    );
  const base = new URL(host);
  const url = new URL(raw, base);
  if (url.origin !== base.origin || url.username || url.password)
    return Result.fail(invalidResponse("Worker returned an unsafe session URL"));
  url.search = "";
  url.hash = "";
  return Result.succeed(url.toString().replace(/\/$/, ""));
}

export function browserUrl(
  raw: string | undefined,
  host: string,
  id: string,
): Result.Result<string, CliError> {
  return sanitizeUrl(raw || `${host}/s/${encodeURIComponent(id)}`, host, id);
}

export function stableRecoveryGrant(
  value: unknown,
  host: string,
  nowMillis: number,
): Result.Result<{ readonly url: string; readonly expiresAt: string }, CliError> {
  const decoded = decodeRecoveryGrantResponse(value);
  if (Option.isNone(decoded))
    return Result.fail(invalidResponse("Server returned an invalid recovery response"));
  if (!URL.canParse(host) || !URL.canParse(decoded.value.url, host))
    return Result.fail(invalidResponse("Worker returned an invalid recovery URL"));
  const base = new URL(host);
  const url = new URL(decoded.value.url, base);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const recoveryCredential = fragment.get("token");
  const expiresAtMillis = Date.parse(decoded.value.expiresAt);
  if (
    url.origin !== base.origin ||
    url.pathname !== "/recover" ||
    url.username ||
    url.password ||
    url.search ||
    [...fragment.keys()].length !== 1 ||
    !/^scotty_recovery\.[0-9a-f]{12}\.[A-Za-z0-9_-]{32,128}$/u.test(recoveryCredential ?? "") ||
    !Number.isFinite(expiresAtMillis) ||
    expiresAtMillis <= nowMillis ||
    expiresAtMillis > nowMillis + 10 * 60 * 1_000
  )
    return Result.fail(invalidResponse("Worker returned an unsafe recovery response"));
  return Result.succeed({
    url: url.toString(),
    expiresAt: new Date(expiresAtMillis).toISOString(),
  });
}

export function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("[REDACTED]") : result),
    text,
  );
}

export function statusExit(status: number, code: string): ExitCode {
  if (
    status === 401 ||
    status === 403 ||
    code === "unauthorized" ||
    code === "forbidden" ||
    code === "auth"
  )
    return EXIT.AUTH;
  if (status === 404 || code === "not_found") return EXIT.NOT_FOUND;
  if (status === 409 || code === "wrong_state" || code === "operation_conflict")
    return EXIT.WRONG_STATE;
  if (
    status === 400 ||
    status === 405 ||
    status === 422 ||
    code === "bad_request" ||
    code === "bad_usage"
  )
    return EXIT.USAGE;
  return EXIT.GENERIC;
}

export function stableUp(
  value: unknown,
  host: string,
): Result.Result<
  {
    output: {
      id: string;
      url: string;
      branch: string;
      provider: "cloudflare";
      status: string;
    };
    sessionUrl: string;
  },
  CliError
> {
  const decoded = decodeUpResponse(value);
  if (Option.isNone(decoded)) return Result.fail(invalidResponse());
  const sanitized = sanitizeUrl(decoded.value.url, host, decoded.value.id);
  if (Result.isFailure(sanitized)) return Result.fail(sanitized.failure);
  return Result.succeed({
    output: {
      id: decoded.value.id,
      url: sanitized.success,
      branch: decoded.value.branch,
      provider: decoded.value.provider,
      status: decoded.value.status,
    },
    sessionUrl: decoded.value.url,
  });
}

export function stableSession(record: SessionResponse): JsonObject {
  const result: JsonObject = {
    id: record.id,
    status: record.status,
    provider: record.provider,
    repo: record.repo,
    defaultBranch: record.defaultBranch,
    branch: record.branch,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hardCapAt: record.hardCapAt,
    ageSeconds: record.ageSeconds,
    capRemainingSeconds: record.capRemainingSeconds,
  };
  const projectedAt = optionalString(record.projectedAt);
  const codexThreadId = optionalString(record.codexThreadId);
  if (projectedAt) result.projectedAt = projectedAt;
  if (codexThreadId) result.codexThreadId = codexThreadId;
  const failure = decodeRawSessionFailure(record.failure);
  if (Option.isSome(failure)) {
    result.failure = {
      code: Option.getOrUndefined(decodeString(failure.value.code)) ?? "unknown",
      message: Option.getOrUndefined(decodeString(failure.value.message)) ?? "Session failed",
      recoverable: failure.value.recoverable === true,
    };
  }
  return result;
}

export function humanSession(record: JsonObject): string {
  const id = String(record.id ?? "-");
  const status = String(record.status ?? "-");
  const provider = String(record.provider ?? "-");
  const repo = String(record.repo ?? "-");
  const branch = String(record.branch ?? "-");
  const age =
    typeof record.ageSeconds === "number" ? `${Math.max(0, Math.floor(record.ageSeconds))}s` : "-";
  const cap =
    typeof record.capRemainingSeconds === "number"
      ? `${Math.max(0, Math.floor(record.capRemainingSeconds))}s`
      : "-";
  return `${id.padEnd(14)} ${status.padEnd(10)} ${provider.padEnd(12)} ${repo.padEnd(28)} ${branch.padEnd(24)} age ${age.padStart(7)} cap ${cap.padStart(7)}`;
}

export function durationSeconds(value: string): Result.Result<number, CliError> {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) return Result.fail(usage("--cap must be a duration such as 30m, 4h, or 1d"));
  const seconds = Number(match[1]) * { m: 60, h: 3_600, d: 86_400 }[match[2] as "m" | "h" | "d"];
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86_400)
    return Result.fail(usage("--cap must be between 1m and 1d"));
  return Result.succeed(seconds);
}

export function rolloutThreadId(path: string): string | null {
  const match = basename(path).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

export function probeOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr]
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n");
  return combined.split("\n")[0]?.slice(0, 512) ?? "";
}

export function humanResult(command: string, value: JsonObject): string {
  if (command === "beam up")
    return `${String(value.id)}  ${String(value.status)}  ${String(value.branch)}\n${String(value.url)}\n`;
  if (command === "attach") return `Opened ${String(value.url)}\n`;
  if (command === "snapshot") return `Snapshot ${String(value.id)}: ${String(value.status)}\n`;
  if (command === "resume")
    return `Session ${String(value.id)}: ${String(value.status)}${value.url ? `\n${String(value.url)}` : ""}\n`;
  if (command === "down")
    return value.resumeCmd
      ? `${String(value.resumeCmd)}\n`
      : `Fetched ${String(value.branch)} at ${String(value.sha)}; no usable rollout was included.\n`;
  if (command === "vaporize") return `Vaporized ${String(value.id)}\n`;
  return `${JSON.stringify(value)}\n`;
}
