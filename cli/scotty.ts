#!/usr/bin/env bun

import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  WRONG_STATE: 5,
} as const;

type ExitCode = (typeof EXIT)[keyof typeof EXIT];
type JsonObject = Record<string, unknown>;
type Writer = (text: string) => void;

export interface CliDependencies {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  stdout: Writer;
  stderr: Writer;
  prompt: (label: string) => string | null;
  openBrowser: (url: string) => Promise<void>;
  run: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface Config {
  host?: string;
  token?: string;
}

interface GlobalOptions {
  json: boolean;
  host?: string;
  token?: string;
}

interface ApiErrorShape {
  error?: { code?: unknown; message?: unknown; hint?: unknown };
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
  }
}

const VERSION = "1.0.0";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MUTATION_REQUEST_TIMEOUT_MS = 5 * 60_000;

const COMMAND_HELP: Record<string, string> = {
  init: `Usage: scotty init [--host URL] [--token TOKEN] [--json]\n\nFlags:\n  --host URL      Worker origin\n  --token TOKEN    Scotty bearer token\n  --json           Emit JSON\n\nExamples:\n  scotty init\n  scotty init --host https://scotty.example.workers.dev --token "$SCOTTY_TOKEN"`,
  up: `Usage: scotty up "PROMPT" [--repo OWNER/NAME] [--cap DURATION] [--detach] [--json]\n\nFlags:\n  --repo REPO      GitHub owner/name\n  --cap DURATION   Hard cap, for example 4h\n  --detach         Don't open a browser\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty up "fix the failing tests" --detach --json\n  scotty up "review auth" --repo anomalyco/rift --cap 2h`,
  ls: `Usage: scotty ls [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty ls\n  scotty ls --json`,
  attach: `Usage: scotty attach ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty attach abc123\n  scotty attach abc123 --json`,
  snapshot: `Usage: scotty snapshot ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty snapshot abc123\n  scotty snapshot abc123 --json`,
  resume: `Usage: scotty resume ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty resume abc123\n  scotty resume abc123 --json`,
  pr: `Usage: scotty pr ID [--title TITLE] [--json]\n\nFlags:\n  --title TITLE    Pull request title\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty pr abc123 --json\n  scotty pr abc123 --title "Fix session restore"`,
  down: `Usage: scotty down ID [--json]\n\nFlags:\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty down abc123\n  scotty down abc123 --json`,
  vaporize: `Usage: scotty vaporize ID [--yes] [--json]\n\nFlags:\n  --yes            Skip the TTY confirmation\n  --host URL       Override configured host\n  --token TOKEN    Override configured token\n  --json           Emit JSON\n\nExamples:\n  scotty vaporize abc123 --yes --json\n  scotty vaporize abc123`,
  skills: `Usage: scotty skills [install (--claude | --codex | --here)] [--json]\n\nFlags:\n  --claude         Install Claude Code skill\n  --codex          Add pointer to ~/.codex/AGENTS.md\n  --here           Install in the current project\n  --json           Wrap output as JSON\n\nExamples:\n  scotty skills\n  scotty skills install --claude`,
};

const ROOT_HELP = `Usage: scotty <command> [flags]\n\nCommands:\n  init       Save Worker host and token\n  up         Start a cloud agent session\n  ls         List sessions\n  attach     Open a session terminal\n  snapshot   Checkpoint a warm session\n  resume     Restore a sleeping session\n  pr         Push work and open a pull request\n  down       Fetch branch and install local rollout\n  vaporize   Permanently delete a session\n  skills     Print or install the agent skill\n  help       Show help; use help --agents for agent docs\n\nFlags:\n  --host URL       Override SCOTTY_HOST and config\n  --token TOKEN    Override SCOTTY_TOKEN and config\n  --json           Emit JSON for scripting\n  --help           Show command help\n  --version        Show version\n\nExamples:\n  scotty up "fix CI" --detach --json\n  scotty ls --json`;

export const EMBEDDED_SKILL = `---
name: scotty
description: Manage cloud Codex agent sessions on Cloudflare
---

# Scotty

Scotty beams a Codex agent into a Cloudflare sandbox. Use it to start a cloud session, attach to its terminal, checkpoint or resume it, publish a PR, beam its branch and Codex rollout down to the current local repository, and permanently remove it.

## Command reference

- \`scotty init [--host URL] [--token TOKEN]\` writes \`~/.scotty.json\` with mode 0600. This is the only command that prompts.
- \`scotty up "PROMPT" [--repo OWNER/NAME] [--cap 4h] [--detach] --json\` returns \`{"id","url","branch","status"}\`.
- \`scotty ls --json\` returns session records including \`ageSeconds\` and \`capRemainingSeconds\`. This is the polling primitive.
- \`scotty attach ID --json\` opens the browser and returns \`{"id","url","opened"}\`.
- \`scotty snapshot ID --json\` checkpoints a warm session and returns \`{"id","status","backupId"?}\`.
- \`scotty resume ID --json\` restores a sleeping or recoverable failed session and returns \`{"id","url"?,"branch"?,"status"}\`.
- \`scotty pr ID [--title TITLE] --json\` returns \`{"prUrl"?,"branchUrl","created"}\`.
- \`scotty down ID --json\` fetches the session branch, securely installs its rollout when present, and returns \`{"branch","sha","rolloutPath","resumeCmd"}\`. The last two values are null when no usable rollout exists.
- \`scotty vaporize ID --yes --json\` permanently deletes runtime, backups, credentials, and registry state; it returns \`{"id","status":"gone"}\`.
- \`scotty skills\` prints this document. \`scotty help --agents\` does the same.
- \`scotty skills install --claude|--codex|--here\` installs this embedded source of truth.

Every operational command accepts \`--host\` and \`--token\`. Precedence is flags, then \`SCOTTY_HOST\`/\`SCOTTY_TOKEN\`, then \`~/.scotty.json\`. Non-TTY output automatically uses JSON. Errors are \`{"error":{"code","message","hint"}}\` on stderr.

Exit codes: 0 success, 1 generic or network failure, 2 bad usage/config, 3 session not found, 4 authentication/authorization failure, 5 wrong session state.

## Workflows

### Cloud work to PR

1. Run \`scotty up "TASK" --detach --json\`.
2. Poll \`scotty ls --json\` until the session is \`warm\`.
3. Run \`scotty pr ID --json\`.
4. Run \`scotty vaporize ID --yes --json\` after the work is safely published.

### Sleep and resume

1. Run \`scotty snapshot ID --json\` before a deliberate pause.
2. Poll \`scotty ls --json\`; hard-capped or idle sessions become \`sleeping\` automatically.
3. Run \`scotty resume ID --json\` only when it is sleeping or recoverably failed.

### Beam down

1. Change into the matching local Git repository.
2. Run \`scotty down ID --json\`.
3. Run the returned \`resumeCmd\` when non-null.

## State machine

\`booting -> warm -> sleeping -> booting -> warm\`. Setup or checkpoint failures may enter \`failed\`; recoverable failures can resume through \`booting\`. \`vaporize\` moves any live state to terminal \`gone\`.

## Rules of thumb

- Always pass \`--json\` in agent automation.
- Poll \`ls\`; its records are a projection and direct commands enforce authoritative state.
- A hard cap forces a checkpoint and sleep even while a terminal is attached.
- Vaporize completed sessions to stop spend. It never snapshots first.
- Retry network failures, but don't retry exit 2, 4, or 5 without changing input, credentials, or state.
`;

function defaultDependencies(): CliDependencies {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    prompt: (label) => globalThis.prompt(label),
    openBrowser: async (url) => {
      const command =
        process.platform === "darwin"
          ? ["open", url]
          : process.platform === "win32"
            ? ["cmd", "/c", "start", "", url]
            : ["xdg-open", url];
      const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
      const code = await child.exited;
      if (code !== 0) throw new Error(`browser opener exited ${code}`);
    },
    run: async (command) => {
      const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

function outputJson(write: Writer, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function asRecord(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(
      "invalid_response",
      "Server returned an invalid response",
      "Check that the CLI and Worker versions match.",
      EXIT.GENERIC,
    );
  }
  return value as JsonObject;
}

function requireString(record: JsonObject, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(
      "invalid_response",
      `Server response is missing ${key}`,
      "Check that the CLI and Worker versions match.",
      EXIT.GENERIC,
    );
  }
  return value;
}

function optionalString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireBoolean(record: JsonObject, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new CliError(
      "invalid_response",
      `Server response has invalid ${key}`,
      "Check that the CLI and Worker versions match.",
      EXIT.GENERIC,
    );
  }
  return value;
}

function requireNumber(record: JsonObject, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliError(
      "invalid_response",
      `Server response has invalid ${key}`,
      "Check that the CLI and Worker versions match.",
      EXIT.GENERIC,
    );
  }
  return value;
}

function parseGlobal(args: string[]): { args: string[]; options: GlobalOptions } {
  const rest: string[] = [];
  const options: GlobalOptions = { json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--host" || arg === "--token") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw usage(`Missing value for ${arg}`);
      options[arg.slice(2) as "host" | "token"] = value;
    } else if (arg.startsWith("--host=") || arg.startsWith("--token=")) {
      const [key, ...parts] = arg.slice(2).split("=");
      const value = parts.join("=");
      if (!value) throw usage(`Missing value for --${key}`);
      options[key as "host" | "token"] = value;
    } else rest.push(arg);
  }
  return { args: rest, options };
}

function usage(message: string, hint = "Run scotty --help for usage."): CliError {
  return new CliError("bad_usage", message, hint, EXIT.USAGE);
}

function takeValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const arg = args[index];
  if (arg.includes("=")) {
    const value = arg.slice(arg.indexOf("=") + 1);
    args.splice(index, 1);
    if (!value) throw usage(`Missing value for ${name}`);
    return value;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw usage(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

function takeBoolean(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function assertNoFlags(args: string[]): void {
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) throw usage(`Unknown flag: ${flag}`);
}

function requireId(args: string[], command: string): string {
  assertNoFlags(args);
  if (args.length !== 1 || !args[0])
    throw usage(`Usage: scotty ${command} ID`, `Run scotty ${command} --help for examples.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(args[0])) throw usage("Invalid session ID");
  return args[0];
}

function normalizeHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(
      "Host must be an absolute http:// or https:// URL",
      "Example: https://scotty.example.workers.dev",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw usage("Host must use http:// or https://");
  if (url.username || url.password || url.search || url.hash)
    throw usage("Host must not contain credentials, a query, or a fragment");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(
      "config_read_failed",
      "Could not read Scotty config",
      `Check permissions on ${path}.`,
      EXIT.GENERIC,
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not object");
    return {
      host: typeof parsed.host === "string" ? parsed.host : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    throw new CliError(
      "invalid_config",
      "Scotty config is not valid JSON",
      `Fix or rerun scotty init for ${path}.`,
      EXIT.USAGE,
    );
  }
}

async function secureWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function credentials(
  options: GlobalOptions,
  deps: CliDependencies,
): Promise<{ host: string; token: string }> {
  let hostValue = options.host ?? deps.env.SCOTTY_HOST;
  let token = options.token ?? deps.env.SCOTTY_TOKEN;
  if (!hostValue || !token) {
    const config = await readConfig(join(deps.home, ".scotty.json"));
    hostValue ??= config.host;
    token ??= config.token;
  }
  if (!hostValue)
    throw usage("Scotty host is not configured", "Run scotty init or pass --host / SCOTTY_HOST.");
  if (!token)
    throw usage(
      "Scotty token is not configured",
      "Run scotty init or pass --token / SCOTTY_TOKEN.",
    );
  return { host: normalizeHost(hostValue), token };
}

function sanitizeUrl(raw: string, host: string, id?: string): string {
  try {
    const base = new URL(host);
    const url = new URL(raw, base);
    if (url.origin !== base.origin) throw new Error("cross-origin URL");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return id ? `${host}/s/${encodeURIComponent(id)}` : host;
  }
}

function browserUrl(raw: string | undefined, host: string, token: string, id: string): string {
  const base = new URL(host);
  const url = new URL(raw || `${host}/s/${encodeURIComponent(id)}`, base);
  if (url.origin !== base.origin)
    throw new CliError(
      "invalid_response",
      "Worker returned a cross-origin terminal URL",
      "Check the configured Worker host.",
      EXIT.GENERIC,
    );
  url.searchParams.set("t", token);
  return url.toString();
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("[REDACTED]") : result),
    text,
  );
}

function statusExit(status: number, code: string): ExitCode {
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

async function readLimited(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES)
    throw new CliError(
      "response_too_large",
      "Server response is too large",
      "Retry the operation or inspect the Worker.",
      EXIT.GENERIC,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new CliError(
      "response_too_large",
      "Server response is too large",
      "Retry the operation or inspect the Worker.",
      EXIT.GENERIC,
    );
  return bytes;
}

async function apiRequest(
  deps: CliDependencies,
  auth: { host: string; token: string },
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; bytes: Uint8Array }> {
  const controller = new AbortController();
  const method = init.method || "GET";
  const timeout =
    method === "GET" && !path.endsWith("/down")
      ? DEFAULT_REQUEST_TIMEOUT_MS
      : MUTATION_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${auth.token}`);
  headers.set("accept", "application/json, application/x-tar, application/octet-stream");
  if (init.body) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("idempotency-key", crypto.randomUUID());
  try {
    const response = await deps.fetch(`${auth.host}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const bytes = await readLimited(response);
    if (!response.ok) {
      let body: ApiErrorShape = {};
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        /* handled below */
      }
      const serverError = body.error;
      const code =
        typeof serverError?.code === "string" ? serverError.code : `http_${response.status}`;
      const message =
        typeof serverError?.message === "string"
          ? serverError.message
          : `Request failed with HTTP ${response.status}`;
      const hint =
        typeof serverError?.hint === "string"
          ? serverError.hint
          : "Check the session state and Worker logs.";
      throw new CliError(
        code,
        redact(message, [auth.token]),
        redact(hint, [auth.token]),
        statusExit(response.status, code),
      );
    }
    return { response, bytes };
  } catch (error) {
    if (error instanceof CliError) throw error;
    const timedOut = controller.signal.aborted;
    throw new CliError(
      timedOut ? "timeout" : "network_error",
      timedOut ? "Request timed out" : "Could not reach the Scotty Worker",
      "Check --host and your network, then retry.",
      EXIT.GENERIC,
    );
  } finally {
    clearTimeout(timer);
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CliError(
      "invalid_response",
      "Server returned invalid JSON",
      "Check that the CLI and Worker versions match.",
      EXIT.GENERIC,
    );
  }
}

async function requestJson(
  deps: CliDependencies,
  auth: { host: string; token: string },
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const { bytes } = await apiRequest(deps, auth, path, init);
  return decodeJson(bytes);
}

function stableUp(
  value: unknown,
  host: string,
): { id: string; url: string; branch: string; status: string } {
  const record = asRecord(value);
  const id = requireString(record, "id");
  return {
    id,
    url: sanitizeUrl(requireString(record, "url"), host, id),
    branch: requireString(record, "branch"),
    status: requireString(record, "status"),
  };
}

function stablePr(value: unknown): { prUrl?: string; branchUrl: string; created: boolean } {
  const record = asRecord(value);
  const result: { prUrl?: string; branchUrl: string; created: boolean } = {
    branchUrl: requireString(record, "branchUrl"),
    created: requireBoolean(record, "created"),
  };
  const prUrl = optionalString(record, "prUrl");
  if (prUrl) result.prUrl = prUrl;
  return result;
}

function stableSession(value: unknown): JsonObject {
  const record = asRecord(value);
  const result: JsonObject = {
    id: requireString(record, "id"),
    status: requireString(record, "status"),
    repo: requireString(record, "repo"),
    defaultBranch: requireString(record, "defaultBranch"),
    branch: requireString(record, "branch"),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
    hardCapAt: requireString(record, "hardCapAt"),
    ageSeconds: requireNumber(record, "ageSeconds"),
    capRemainingSeconds: requireNumber(record, "capRemainingSeconds"),
  };
  const projectedAt = optionalString(record, "projectedAt");
  const codexThreadId = optionalString(record, "codexThreadId");
  if (projectedAt) result.projectedAt = projectedAt;
  if (codexThreadId) result.codexThreadId = codexThreadId;
  if (record.failure && typeof record.failure === "object" && !Array.isArray(record.failure)) {
    const failure = record.failure as JsonObject;
    result.failure = {
      code: typeof failure.code === "string" ? failure.code : "unknown",
      message: typeof failure.message === "string" ? failure.message : "Session failed",
      recoverable: failure.recoverable === true,
    };
  }
  return result;
}

function humanSession(record: JsonObject): string {
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

function parseTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => {
      const value = decoder.decode(header.subarray(start, start + length));
      const terminator = value.indexOf("\0");
      return terminator === -1 ? value : value.slice(0, terminator);
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = field(124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const checksumText = field(148, 8).trim();
    const expectedChecksum = Number.parseInt(checksumText || "0", 8);
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index++)
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    if (!Number.isFinite(expectedChecksum) || expectedChecksum !== actualChecksum)
      throw new CliError(
        "invalid_archive",
        "Beam-down archive checksum is invalid",
        "Retry down or inspect the Worker.",
        EXIT.GENERIC,
      );
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length)
      throw new CliError(
        "invalid_archive",
        "Beam-down archive is malformed",
        "Retry down or inspect the Worker.",
        EXIT.GENERIC,
      );
    if (!safeRelativePath(path))
      throw new CliError(
        "invalid_archive",
        "Beam-down archive contains an unsafe path",
        "Inspect the Worker before retrying.",
        EXIT.GENERIC,
      );
    const type = header[156];
    if (type === 0 || type === 48) {
      if (files.has(path))
        throw new CliError(
          "invalid_archive",
          "Beam-down archive contains duplicate entries",
          "Inspect the Worker before retrying.",
          EXIT.GENERIC,
        );
      files.set(path, bytes.slice(offset + 512, offset + 512 + size));
      if (files.size > 2)
        throw new CliError(
          "invalid_archive",
          "Beam-down archive contains unexpected files",
          "Inspect the Worker before retrying.",
          EXIT.GENERIC,
        );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function safeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.includes("\0") &&
    !normalized.split("/").includes("..")
  );
}

function validGitRef(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.includes("//")
  );
}

function rolloutDestination(home: string, archivePath: string): string {
  const file = basename(archivePath);
  if (!file.endsWith(".jsonl") || file === ".jsonl")
    throw new CliError(
      "invalid_rollout",
      "Beam-down rollout filename is invalid",
      "The branch was fetched, but the rollout was not installed.",
      EXIT.GENERIC,
    );
  const normalized = archivePath.replace(/\\/g, "/");
  const nested = normalized.match(/(?:^|\/)sessions\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+$/);
  const dated = file.match(/(?:rollout-)?(\d{4})-(\d{2})-(\d{2})T/);
  const parts = nested?.slice(1, 4) ?? dated?.slice(1, 4);
  if (!parts)
    throw new CliError(
      "invalid_rollout",
      "Beam-down rollout has no recognizable date",
      "The branch was fetched, but the rollout was not installed.",
      EXIT.GENERIC,
    );
  return join(home, ".codex", "sessions", parts[0], parts[1], parts[2], file);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function durationSeconds(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw usage("--cap must be a duration such as 30m, 4h, or 1d");
  const seconds = Number(match[1]) * { m: 60, h: 3_600, d: 86_400 }[match[2] as "m" | "h" | "d"];
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86_400)
    throw usage("--cap must be between 1m and 1d");
  return seconds;
}

function rolloutThreadId(path: string): string | null {
  const match = basename(path).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

async function handleDown(
  id: string,
  options: GlobalOptions,
  deps: CliDependencies,
): Promise<JsonObject> {
  const auth = await credentials(options, deps);
  const { response, bytes } = await apiRequest(
    deps,
    auth,
    `/api/sessions/${encodeURIComponent(id)}/down`,
  );
  const contentType = response.headers.get("content-type") || "";
  let metadata: JsonObject;
  let rollout: { path: string; bytes: Uint8Array } | undefined;
  if (contentType.includes("json")) {
    metadata = asRecord(decodeJson(bytes));
    const encoded = optionalString(metadata, "rolloutBase64");
    const name = optionalString(metadata, "rolloutName");
    if (encoded && name) rollout = { path: name, bytes: Uint8Array.fromBase64(encoded) };
  } else {
    const files = parseTar(bytes);
    const metadataBytes = files.get("metadata.json");
    if (!metadataBytes)
      throw new CliError(
        "invalid_archive",
        "Beam-down archive has no canonical metadata.json",
        "Retry down or inspect the Worker.",
        EXIT.GENERIC,
      );
    metadata = asRecord(decodeJson(metadataBytes));
    const rolloutEntries = [...files.entries()].filter(([path]) => path.endsWith(".jsonl"));
    if (rolloutEntries.length > 1)
      throw new CliError(
        "invalid_archive",
        "Beam-down archive contains multiple rollouts",
        "Inspect the Worker before retrying.",
        EXIT.GENERIC,
      );
    const rolloutEntry = rolloutEntries[0];
    if (rolloutEntry) rollout = { path: rolloutEntry[0], bytes: rolloutEntry[1] };
  }
  const declaredRolloutPath = optionalString(metadata, "rolloutPath");
  const declaredRolloutFile = optionalString(metadata, "rolloutFile");
  for (const declared of [declaredRolloutPath, declaredRolloutFile]) {
    if (declared && !safeRelativePath(declared))
      throw new CliError(
        "invalid_archive",
        "Beam-down metadata contains an unsafe rollout path",
        "Inspect the Worker before retrying.",
        EXIT.GENERIC,
      );
    if (declared && rollout && basename(declared) !== basename(rollout.path))
      throw new CliError(
        "invalid_archive",
        "Beam-down metadata does not match the rollout file",
        "Retry down or inspect the Worker.",
        EXIT.GENERIC,
      );
  }
  if (rollout && declaredRolloutPath) rollout.path = declaredRolloutPath;
  const branch = requireString(metadata, "branch");
  const sha = requireString(metadata, "sha");
  if (!validGitRef(branch))
    throw new CliError(
      "invalid_response",
      "Server returned an unsafe branch name",
      "Inspect the Worker before retrying.",
      EXIT.GENERIC,
    );
  if (!/^[0-9a-f]{40}$/i.test(sha))
    throw new CliError(
      "invalid_response",
      "Server returned an invalid commit SHA",
      "Inspect the Worker before retrying.",
      EXIT.GENERIC,
    );
  const fetched = await deps.run(["git", "fetch", "origin", branch]);
  if (fetched.exitCode !== 0)
    throw new CliError(
      "git_fetch_failed",
      "Could not fetch the session branch",
      redact(fetched.stderr.trim() || `Run git fetch origin ${branch} manually.`, [auth.token]),
      EXIT.GENERIC,
    );
  const resolved = await deps.run(["git", "rev-parse", "FETCH_HEAD"]);
  if (resolved.exitCode !== 0 || resolved.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
    throw new CliError(
      "sha_mismatch",
      "Fetched branch does not match the beam-down manifest",
      "Do not install the rollout; inspect the remote branch and Worker.",
      EXIT.GENERIC,
    );
  }

  let rolloutPath: string | null = null;
  let resumeCmd: string | null = null;
  if (rollout) {
    try {
      rolloutPath = rolloutDestination(deps.home, rollout.path);
      await secureWrite(rolloutPath, new TextDecoder().decode(rollout.bytes));
      const threadId = optionalString(metadata, "codexThreadId") ?? rolloutThreadId(rolloutPath);
      if (threadId)
        resumeCmd = `codex resume ${shellQuote(threadId)} -C ${shellQuote(resolve(deps.cwd))}`;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "invalid_rollout") throw error;
      deps.stderr(`warning: ${error.message}; branch ${branch} was fetched\n`);
    }
  }
  return { branch, sha, rolloutPath, resumeCmd };
}

async function appendOnce(path: string, marker: string, content: string): Promise<boolean> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing.includes(marker)) return false;
  const next = existing.length === 0 ? content : `${existing.replace(/\s*$/, "")}\n\n${content}`;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "w", 0o644);
  try {
    await file.writeFile(next, "utf8");
  } finally {
    await file.close();
  }
  return true;
}

async function installSkill(args: string[], json: boolean, deps: CliDependencies): Promise<void> {
  const targets = ["--claude", "--codex", "--here"].filter((flag) => takeBoolean(args, flag));
  assertNoFlags(args);
  if (args.length) throw usage(`Unexpected argument: ${args[0]}`);
  if (targets.length > 1) throw usage("Choose exactly one of --claude, --codex, or --here");
  if (targets.length === 0) {
    const paths = [
      join(deps.home, ".claude", "skills", "scotty", "SKILL.md"),
      join(deps.home, ".codex", "AGENTS.md"),
      join(deps.cwd, ".agents", "scotty.md"),
      join(deps.cwd, "AGENTS.md"),
    ];
    if (json) outputJson(deps.stdout, { wouldWrite: paths });
    else
      deps.stdout(
        `Would write:\n${paths.map((path) => `  ${path}`).join("\n")}\nPass --claude, --codex, or --here.\n`,
      );
    return;
  }
  const installed: string[] = [];
  if (targets[0] === "--claude") {
    const path = join(deps.home, ".claude", "skills", "scotty", "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, EMBEDDED_SKILL);
    installed.push(path);
  } else if (targets[0] === "--codex") {
    const path = join(deps.home, ".codex", "AGENTS.md");
    await appendOnce(
      path,
      "<!-- scotty-skill -->",
      "<!-- scotty-skill -->\n## Scotty\n\nRun `scotty skills` for the current Scotty cloud-session operating guide.",
    );
    installed.push(path);
  } else {
    const skillPath = join(deps.cwd, ".agents", "scotty.md");
    await mkdir(dirname(skillPath), { recursive: true });
    await Bun.write(skillPath, EMBEDDED_SKILL);
    const agentsPath = join(deps.cwd, "AGENTS.md");
    await appendOnce(
      agentsPath,
      "<!-- scotty-skill -->",
      "<!-- scotty-skill -->\nRead `.agents/scotty.md` before operating Scotty cloud sessions.",
    );
    installed.push(skillPath, agentsPath);
  }
  if (json) outputJson(deps.stdout, { installed });
  else deps.stdout(`Installed ${installed.join(", ")}\n`);
}

function humanResult(command: string, value: JsonObject): string {
  if (command === "up")
    return `${String(value.id)}  ${String(value.status)}  ${String(value.branch)}\n${String(value.url)}\n`;
  if (command === "attach") return `Opened ${String(value.url)}\n`;
  if (command === "snapshot") return `Snapshot ${String(value.id)}: ${String(value.status)}\n`;
  if (command === "resume")
    return `Session ${String(value.id)}: ${String(value.status)}${value.url ? `\n${String(value.url)}` : ""}\n`;
  if (command === "pr") return `${value.prUrl ?? value.branchUrl}\n`;
  if (command === "down")
    return value.resumeCmd
      ? `${String(value.resumeCmd)}\n`
      : `Fetched ${String(value.branch)} at ${String(value.sha)}; no usable rollout was included.\n`;
  if (command === "vaporize") return `Vaporized ${String(value.id)}\n`;
  return `${JSON.stringify(value)}\n`;
}

async function execute(rawArgs: string[], deps: CliDependencies): Promise<number> {
  const { args, options } = parseGlobal(rawArgs);
  const command = args.shift();
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    (command === "help" && args.length === 0)
  ) {
    deps.stdout(`${ROOT_HELP}\n`);
    return EXIT.OK;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    deps.stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (command === "help") {
    if (takeBoolean(args, "--agents")) {
      assertNoFlags(args);
      if (args.length) throw usage(`Unexpected argument: ${args[0]}`);
      if (options.json) outputJson(deps.stdout, { skill: EMBEDDED_SKILL });
      else deps.stdout(EMBEDDED_SKILL);
      return EXIT.OK;
    }
    const target = args[0];
    if (!target || args.length !== 1 || !COMMAND_HELP[target]) throw usage("Unknown help topic");
    deps.stdout(`${COMMAND_HELP[target]}\n`);
    return EXIT.OK;
  }
  const helpIndex = args.findIndex((arg) => arg === "--help" || arg === "-h");
  if (helpIndex >= 0) {
    if (!COMMAND_HELP[command]) throw usage(`Unknown command: ${command}`);
    deps.stdout(`${COMMAND_HELP[command]}\n`);
    return EXIT.OK;
  }
  if (command === "skills") {
    if (args[0] === "install") {
      args.shift();
      await installSkill(args, options.json, deps);
    } else {
      assertNoFlags(args);
      if (args.length) throw usage(`Unexpected argument: ${args[0]}`);
      if (options.json) outputJson(deps.stdout, { skill: EMBEDDED_SKILL });
      else deps.stdout(EMBEDDED_SKILL);
    }
    return EXIT.OK;
  }
  const autoJson = options.json || !deps.stdoutIsTTY;
  if (command === "init") {
    assertNoFlags(args);
    if (args.length) throw usage(`Unexpected argument: ${args[0]}`);
    let host = options.host;
    let token = options.token;
    if ((!host || !token) && !deps.stdinIsTTY)
      throw usage("init needs --host and --token when stdin is not a TTY");
    host ||= deps.prompt("Scotty Worker host: ")?.trim();
    token ||= deps.prompt("Scotty token: ")?.trim();
    if (!host || !token) throw usage("Host and token are required");
    host = normalizeHost(host);
    const configPath = join(deps.home, ".scotty.json");
    await secureWrite(configPath, `${JSON.stringify({ host, token }, null, 2)}\n`);
    const result = { configPath, host };
    if (autoJson) outputJson(deps.stdout, result);
    else deps.stdout(`Saved ${configPath} with mode 0600\n`);
    return EXIT.OK;
  }
  if (!COMMAND_HELP[command]) throw usage(`Unknown command: ${command}`);

  if (command === "attach") {
    const id = requireId(args, command);
    const auth = await credentials(options, deps);
    const safeUrl = `${auth.host}/s/${encodeURIComponent(id)}`;
    await deps.openBrowser(browserUrl(undefined, auth.host, auth.token, id));
    const result = { id, url: safeUrl, opened: true };
    if (autoJson) outputJson(deps.stdout, result);
    else deps.stdout(humanResult(command, result));
    return EXIT.OK;
  }

  if (command === "ls") {
    assertNoFlags(args);
    if (args.length) throw usage(`Unexpected argument: ${args[0]}`);
    const auth = await credentials(options, deps);
    const value = await requestJson(deps, auth, "/api/sessions");
    if (!Array.isArray(value))
      throw new CliError(
        "invalid_response",
        "Server response is not a session array",
        "Check that the CLI and Worker versions match.",
        EXIT.GENERIC,
      );
    const sessions = value.map(stableSession);
    if (autoJson) outputJson(deps.stdout, sessions);
    else
      deps.stdout(
        sessions.length ? `${sessions.map(humanSession).join("\n")}\n` : "No sessions.\n",
      );
    return EXIT.OK;
  }

  if (command === "up") {
    const repo = takeValue(args, "--repo");
    const cap = takeValue(args, "--cap");
    const detach = takeBoolean(args, "--detach");
    assertNoFlags(args);
    if (args.length !== 1 || !args[0].trim())
      throw usage('Usage: scotty up "PROMPT"', "Run scotty up --help for flags and examples.");
    if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
      throw usage("--repo must be OWNER/NAME");
    const auth = await credentials(options, deps);
    const body: JsonObject = { prompt: args[0] };
    if (repo) body.repo = repo;
    if (cap) {
      body.cap = cap;
      body.hardCapSeconds = durationSeconds(cap);
    }
    const raw = await requestJson(deps, auth, "/api/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const result = stableUp(raw, auth.host);
    if (!detach)
      await deps.openBrowser(
        browserUrl(optionalString(asRecord(raw), "url"), auth.host, auth.token, result.id),
      );
    if (autoJson) outputJson(deps.stdout, result);
    else deps.stdout(humanResult(command, result));
    return EXIT.OK;
  }

  if (command === "down") {
    const id = requireId(args, command);
    const result = await handleDown(id, options, deps);
    if (autoJson) outputJson(deps.stdout, result);
    else deps.stdout(humanResult(command, result));
    return EXIT.OK;
  }

  const title = command === "pr" ? takeValue(args, "--title") : undefined;
  const yes = command === "vaporize" ? takeBoolean(args, "--yes") : false;
  const id = requireId(args, command);
  if (command === "vaporize" && deps.stdoutIsTTY && deps.stdinIsTTY && !yes) {
    const answer = deps.prompt(`Permanently vaporize ${id}? Type ${id} to confirm: `);
    if (answer !== id)
      throw new CliError(
        "cancelled",
        "Vaporize cancelled",
        "Pass --yes to skip confirmation.",
        EXIT.USAGE,
      );
  }
  const auth = await credentials(options, deps);
  const path = `/api/sessions/${encodeURIComponent(id)}${command === "vaporize" ? "" : `/${command}`}`;
  const method = command === "vaporize" ? "DELETE" : "POST";
  const body =
    command === "pr" && title
      ? JSON.stringify({ title })
      : command === "pr"
        ? JSON.stringify({})
        : undefined;
  const raw = await requestJson(deps, auth, path, { method, body });
  let result: JsonObject;
  if (command === "pr") result = stablePr(raw);
  else if (command === "vaporize") {
    const record = asRecord(raw);
    const responseId = requireString(record, "id");
    const status = requireString(record, "status");
    if (responseId !== id || status !== "gone")
      throw new CliError(
        "invalid_response",
        "Server returned an invalid vaporize result",
        "Inspect the Worker before assuming resources were deleted.",
        EXIT.GENERIC,
      );
    result = { id: responseId, status };
  } else {
    const record = asRecord(raw);
    result = { id: optionalString(record, "id") ?? id, status: requireString(record, "status") };
    const url = optionalString(record, "url");
    const branch = optionalString(record, "branch");
    const backupId = optionalString(record, "backupId");
    if (url) result.url = sanitizeUrl(url, auth.host, id);
    if (branch) result.branch = branch;
    if (backupId) result.backupId = backupId;
  }
  if (autoJson) outputJson(deps.stdout, result);
  else deps.stdout(humanResult(command, result));
  return EXIT.OK;
}

export async function main(
  args = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...defaultDependencies(), ...overrides };
  try {
    return await execute(args, deps);
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(
            "internal_error",
            "Scotty failed unexpectedly",
            "Retry with --json; if it persists, inspect the local error and Worker logs.",
            EXIT.GENERIC,
          );
    outputJson(deps.stderr, {
      error: { code: cliError.code, message: cliError.message, hint: cliError.hint },
    });
    return cliError.exitCode;
  }
}

if (import.meta.main) process.exitCode = await main();
