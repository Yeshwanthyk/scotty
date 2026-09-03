import { Option, Result } from "effect";
import { CliError, EXIT, type ExitCode, type Writer } from "./core";
import {
  decodeNonEmptyString,
  decodeRecoveryGrantResponse,
  decodeUpResponse,
  type AttachOutput,
  type BeamUpOutput,
  type InspectResponse,
  type SessionResponse,
  type SessionOperationOutput,
  type SteerResponse,
  type VaporizeOutput,
} from "./schemas";

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

const SESSION_CREATE_CONFLICT = /^Session ([a-z0-9][a-z0-9-]{5,31}) already exists$/u;

export function conflictSessionId(message: string): string | undefined {
  return SESSION_CREATE_CONFLICT.exec(message)?.[1];
}

export function stableUp(
  value: unknown,
  host: string,
): Result.Result<
  {
    output: BeamUpOutput;
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
      title: decoded.value.title,
      url: sanitized.success,
      branch: decoded.value.branch,
      provider: decoded.value.provider,
      status: decoded.value.status,
    },
    sessionUrl: decoded.value.url,
  });
}

export function humanInspect(id: string, snapshot: InspectResponse): string {
  const queued = snapshot.queue.steer.length + snapshot.queue.followUp.length;
  const truncated = snapshot.truncated.messages || snapshot.truncated.values ? "yes" : "no";
  return (
    [
      `Session ${id}`,
      `Epoch: ${snapshot.epoch}`,
      `Sequence: ${snapshot.sequence} (base ${snapshot.baseSequence})`,
      `Revision: ${snapshot.sessionRevision}`,
      `Messages: ${snapshot.messages.length}`,
      `Active tools: ${snapshot.activeTools.length}`,
      `Queued: ${queued}`,
      `Pending UI: ${snapshot.pendingUi.length}`,
      `Truncated: ${truncated}`,
    ].join("\n") + "\n"
  );
}

export type ReadMessageRole = "assistant" | "user";

export interface ReadMessage {
  readonly index: number;
  readonly role: ReadMessageRole;
  readonly content: string;
  readonly id?: string;
}

export interface ReadOutput {
  readonly id: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly messages: ReadonlyArray<ReadMessage>;
  readonly truncated: boolean;
}

const jsonProperty = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const readableMessageContent = (content: unknown): string | undefined => {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => {
      const text = jsonProperty(part, "text");
      return jsonProperty(part, "type") === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
};

export function readableMessages(
  snapshot: InspectResponse,
  options: {
    readonly last: number;
    readonly role?: ReadMessageRole;
  },
): ReadonlyArray<ReadMessage> {
  return snapshot.messages
    .flatMap((message, index) => {
      const rawRole = jsonProperty(message, "role");
      const role: ReadMessageRole | undefined =
        rawRole === "assistant" || rawRole === "user" ? rawRole : undefined;
      if (role === undefined) return [];
      if (options.role !== undefined && role !== options.role) return [];
      const content = readableMessageContent(jsonProperty(message, "content"));
      if (content === undefined) return [];
      const id = optionalString(jsonProperty(message, "id"));
      return [
        {
          index,
          role,
          content,
          ...(id === undefined ? {} : { id }),
        },
      ];
    })
    .slice(-options.last);
}

export function readOutput(
  id: string,
  snapshot: InspectResponse,
  messages: ReadonlyArray<ReadMessage>,
): ReadOutput {
  return {
    id,
    epoch: snapshot.epoch,
    sequence: snapshot.sequence,
    messages,
    truncated: snapshot.truncated.messages,
  };
}

export function humanRead(output: ReadOutput): string {
  if (output.messages.length === 0) return "No matching messages.\n";
  return `${output.messages
    .map(
      (message) =>
        `[${message.role}] sequence=${output.sequence} truncated=${output.truncated ? "yes" : "no"}\n${message.content}`,
    )
    .join("\n\n")}\n`;
}

export function humanSteer(result: SteerResponse): string {
  if (result.status === "accepted")
    return `Steer accepted for ${result.id} at revision ${result.sessionRevision}.\n`;
  if (result.status === "stale")
    return `Steer was stale for ${result.id}; no command was retried.\n`;
  if (result.status === "unavailable")
    return `Steer unavailable for ${result.id}: ${result.reason}.\n`;
  return `Steer outcome is ambiguous for ${result.id}: ${result.reason}; do not retry automatically.\n`;
}

export function humanSession(record: SessionResponse): string {
  const status =
    record.authority.kind === "stable"
      ? record.authority.lifecycle
      : `${record.authority.action}:${record.authority.mode}`;
  const branch = record.display.branch ?? "-";
  const cap = `${Math.max(0, Math.floor(record.times.capRemainingSeconds))}s`;
  return `${record.identity.id.padEnd(14)} ${record.display.title.padEnd(24)} ${status.padEnd(22)} ${record.runtime.provider.padEnd(12)} ${record.display.repository.padEnd(28)} ${branch.padEnd(24)} cap ${cap.padStart(7)}`;
}

export function durationSeconds(value: string): Result.Result<number, CliError> {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) return Result.fail(usage("--cap must be a duration such as 30m, 4h, or 1d"));
  const seconds = Number(match[1]) * { m: 60, h: 3_600, d: 86_400 }[match[2] as "m" | "h" | "d"];
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86_400)
    return Result.fail(usage("--cap must be between 1m and 1d"));
  return Result.succeed(seconds);
}

type HumanResultInput =
  | { readonly command: "beam"; readonly value: BeamUpOutput }
  | { readonly command: "attach"; readonly value: AttachOutput }
  | { readonly command: "checkpoint" | "resume"; readonly value: SessionOperationOutput }
  | { readonly command: "vaporize"; readonly value: VaporizeOutput };

const formatHumanResult = (input: HumanResultInput): string => {
  const { command, value } = input;
  if (command === "beam")
    return `${String(value.id)}  ${String(value.status)}  ${String(value.branch)}\n${String(value.url)}\n`;
  if (command === "attach") return `Opened ${String(value.url)}\n`;
  if (command === "checkpoint") return `Checkpoint ${String(value.id)}: ${String(value.status)}\n`;
  if (command === "resume")
    return `Session ${String(value.id)}: ${String(value.status)}${value.url ? `\n${String(value.url)}` : ""}\n`;
  return `Vaporized ${String(value.id)}\n`;
};

export const humanResult = (input: HumanResultInput): string => formatHumanResult(input);
