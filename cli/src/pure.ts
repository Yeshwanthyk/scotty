import { basename } from "node:path";
import { Option, Result } from "effect";
import scottySkill from "../skills/scotty/SKILL.md" with { type: "text" };
import {
  CliError,
  EXIT,
  type ExitCode,
  type GlobalOptions,
  type JsonObject,
  type Writer,
} from "./core";
import {
  decodeNonEmptyString,
  decodeRawSessionFailure,
  decodeString,
  decodeUpResponse,
  type SessionResponse,
} from "./schemas";

export const COMMAND_HELP: Record<string, string> = {
  init: `Usage: scotty init [--host URL] [--token TOKEN] [--json]\n\nFlags:\n  --host URL      Worker origin\n  --token TOKEN    Scotty bearer token\n  --json           Emit JSON\n\nExamples:\n  scotty init\n  scotty init --host https://scotty.example.workers.dev --token "$SCOTTY_TOKEN"`,
  up: `Usage: scotty up "PROMPT" [--repo OWNER/NAME] [--cap DURATION] [--detach] [--json]\n\nFlags:\n  --repo REPO      GitHub owner/name\n  --cap DURATION   Hard cap, for example 4h\n  --detach         Don't open a browser\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty up "fix the failing tests" --detach --json\n  scotty up "review auth" --repo anomalyco/rift --cap 2h`,
  ls: `Usage: scotty ls [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty ls\n  scotty ls --json`,
  attach: `Usage: scotty attach ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty attach abc123\n  scotty attach abc123 --json`,
  snapshot: `Usage: scotty snapshot ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty snapshot abc123\n  scotty snapshot abc123 --json`,
  resume: `Usage: scotty resume ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty resume abc123\n  scotty resume abc123 --json`,
  down: `Usage: scotty down ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty down abc123\n  scotty down abc123 --json`,
  vaporize: `Usage: scotty vaporize ID [--yes] [--json]\n\nFlags:\n  --yes            Skip the TTY confirmation\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty vaporize abc123 --yes --json\n  scotty vaporize abc123`,
  skills: `Usage: scotty skills\n\nPrint the embedded Scotty agent guide as Markdown.\n\nExample:\n  scotty skills`,
  tools: `Usage: scotty tools <list | doctor> [--json]\n\nCommands:\n  list             Print the standard sandbox tool manifest\n  doctor           Probe every declared tool and report missing or mismatched installs\n\nFlags:\n  --json           Emit JSON\n\nExamples:\n  scotty tools list --json\n  scotty tools doctor --json`,
};

export const ROOT_HELP = `Usage: scotty <command> [flags]\n\nCommands:\n  init       Save Worker host and token\n  up         Start a cloud agent session\n  ls         List sessions\n  attach     Open a session terminal\n  snapshot   Checkpoint a warm session\n  resume     Restore a sleeping session\n  down       Fetch branch and install local rollout\n  vaporize   Permanently delete a session\n  skills     Print the embedded agent skill\n  tools      List or verify standard sandbox tools\n  help       Show command help\n\nFlags:\n  --host URL       Override SCOTTY_HOST and config\n  --token TOKEN    Override SCOTTY_TOKEN and config\n  --json           Emit JSON for operational commands\n  --help           Show command help\n  --version        Show version\n\nExamples:\n  scotty up "fix CI" --detach --json\n  scotty tools doctor --json`;

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

export function parseGlobal(
  args: string[],
): Result.Result<{ args: string[]; options: GlobalOptions }, CliError> {
  const rest: string[] = [];
  const options: GlobalOptions = { json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--host" || arg === "--token") {
      const value = args[++index];
      if (!value || value.startsWith("--")) return Result.fail(usage(`Missing value for ${arg}`));
      options[arg.slice(2) as "host" | "token"] = value;
    } else if (arg.startsWith("--host=") || arg.startsWith("--token=")) {
      const [key, ...parts] = arg.slice(2).split("=");
      const value = parts.join("=");
      if (!value) return Result.fail(usage(`Missing value for --${key}`));
      options[key as "host" | "token"] = value;
    } else rest.push(arg);
  }
  return Result.succeed({ args: rest, options });
}

export function usage(message: string, hint = "Run scotty --help for usage."): CliError {
  return new CliError("bad_usage", message, hint, EXIT.USAGE);
}

export function takeValue(
  args: string[],
  name: string,
): Result.Result<string | undefined, CliError> {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return Result.succeed(undefined);
  const arg = args[index];
  if (arg.includes("=")) {
    const value = arg.slice(arg.indexOf("=") + 1);
    args.splice(index, 1);
    if (!value) return Result.fail(usage(`Missing value for ${name}`));
    return Result.succeed(value);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return Result.fail(usage(`Missing value for ${name}`));
  args.splice(index, 2);
  return Result.succeed(value);
}

export function takeBoolean(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function assertNoFlags(args: string[]): Result.Result<void, CliError> {
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) return Result.fail(usage(`Unknown flag: ${flag}`));
  return Result.succeed(undefined);
}

export function requireId(args: string[], command: string): Result.Result<string, CliError> {
  const flags = assertNoFlags(args);
  if (Result.isFailure(flags)) return flags;
  if (args.length !== 1 || !args[0])
    return Result.fail(
      usage(`Usage: scotty ${command} ID`, `Run scotty ${command} --help for examples.`),
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(args[0]))
    return Result.fail(usage("Invalid session ID"));
  return Result.succeed(args[0]);
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
        id ? `Worker returned an invalid terminal URL for ${id}` : "Worker returned an invalid URL",
      ),
    );
  const base = new URL(host);
  const url = new URL(raw, base);
  if (url.origin !== base.origin || url.username || url.password)
    return Result.fail(invalidResponse("Worker returned an unsafe terminal URL"));
  url.search = "";
  url.hash = "";
  return Result.succeed(url.toString().replace(/\/$/, ""));
}

export function browserUrl(
  raw: string | undefined,
  host: string,
  token: string,
  id: string,
): Result.Result<string, CliError> {
  const base = new URL(host);
  const url = new URL(raw || `${host}/s/${encodeURIComponent(id)}`, base);
  if (url.origin !== base.origin || url.username || url.password)
    return Result.fail(
      new CliError(
        "invalid_response",
        "Worker returned an unsafe terminal URL",
        "Check the configured Worker host.",
        EXIT.GENERIC,
      ),
    );
  url.searchParams.set("t", token);
  return Result.succeed(url.toString());
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
  { output: { id: string; url: string; branch: string; status: string }; terminalUrl: string },
  CliError
> {
  const decoded = decodeUpResponse(value);
  if (Option.isNone(decoded)) return Result.fail(invalidResponse());
  const sanitized = sanitizeUrl(decoded.value.url, host, decoded.value.id);
  if (Result.isFailure(sanitized)) return sanitized;
  return Result.succeed({
    output: {
      id: decoded.value.id,
      url: sanitized.success,
      branch: decoded.value.branch,
      status: decoded.value.status,
    },
    terminalUrl: decoded.value.url,
  });
}

export function stableSession(record: SessionResponse): JsonObject {
  const result: JsonObject = {
    id: record.id,
    status: record.status,
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
  const repo = String(record.repo ?? "-");
  const branch = String(record.branch ?? "-");
  const age =
    typeof record.ageSeconds === "number" ? `${Math.max(0, Math.floor(record.ageSeconds))}s` : "-";
  const cap =
    typeof record.capRemainingSeconds === "number"
      ? `${Math.max(0, Math.floor(record.capRemainingSeconds))}s`
      : "-";
  return `${id.padEnd(14)} ${status.padEnd(10)} ${repo.padEnd(28)} ${branch.padEnd(24)} age ${age.padStart(7)} cap ${cap.padStart(7)}`;
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
  if (command === "up")
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
