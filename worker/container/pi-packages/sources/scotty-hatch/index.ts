import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "smol-toml";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const SCOTTY_HATCH_ROUTE = "https://scotty.internal/api/hatch";
export const SCOTTY_HATCH_STARTUP_ROUTE = "https://scotty.internal/api/hatch/startup";
export const SCOTTY_HATCH_RESTORE_ROUTE = "https://scotty.internal/api/hatch/restore";
export const SCOTTY_HATCH_MAX_BYTES = 64 * 1_024;
export const SCOTTY_HATCH_LOG_TAIL_BYTES = 4 * 1_024;
export const SCOTTY_HATCH_READY_TIMEOUT_MILLIS = 30_000;
export const SCOTTY_HATCH_AUTHORITY_TIMEOUT_MILLIS = 30_000;
export const SCOTTY_HATCH_CONFIG_FILE_NAME = "hatch.toml";

class RepositoryHatchMissingError extends Error {}

const MAX_NAME_LENGTH = 120;
const MAX_ARG_LENGTH = 4_096;
const MAX_ARGV_LENGTH = 64;
const MAX_CWD_LENGTH = 1_024;
const MAX_HEALTH_PATH_LENGTH = 2_048;
const RESERVED_PORTS = [3_000, 43_117] as const;
const CLOUDFLARE_CA_CERTIFICATE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const IMAGE_COREPACK_HOME = "/opt/corepack";
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const SAFE_ENVIRONMENT_NAMES = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "UV_PYTHON_BIN_DIR",
  "UV_PYTHON_INSTALL_DIR",
] as const;

const ServiceNameSchema = Type.String({
  minLength: 1,
  maxLength: MAX_NAME_LENGTH,
  pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]*(?![\\s\\S])",
});
const ArgSchema = Type.String({ maxLength: MAX_ARG_LENGTH, pattern: "^[^\\u0000]*$" });
const RelativeCwdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_CWD_LENGTH,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\u0000]+$",
});
const HealthPathSchema = Type.String({
  minLength: 1,
  maxLength: MAX_HEALTH_PATH_LENGTH,
  pattern: "^/(?!/)[^\\\\#\\u0000-\\u001f\\u007f]*$",
});
const PortSchema = Type.Integer({
  minimum: 1_024,
  maximum: 65_535,
  not: { enum: RESERVED_PORTS },
});

const PrepareSchema = Type.Object(
  {
    argv: Type.Array(ArgSchema, { minItems: 1, maxItems: MAX_ARGV_LENGTH }),
    timeout_seconds: Type.Integer({ minimum: 1, maximum: 1800 }),
  },
  { additionalProperties: false },
);
const ReadyTimeoutSchema = Type.Integer({ minimum: 1, maximum: 300 });

export type HatchFailureCode =
  | "invalid_config"
  | "preparation_failed"
  | "preparation_timeout"
  | "process_start_failed"
  | "process_exited"
  | "readiness_timeout"
  | "registration_rejected"
  | "registration_unconfirmed"
  | "cleanup_failed"
  | "interrupted";
const failureMessages: Record<HatchFailureCode, string> = {
  invalid_config:
    "Hatch configuration is invalid or cannot be read. Check hatch.toml and workspace paths.",
  preparation_failed:
    "Hatch preparation failed. Correct the preparation command or its prerequisites before retrying ensure.",
  preparation_timeout:
    "Hatch preparation exceeded its time limit. Check preparation logs before retrying ensure.",
  process_start_failed:
    "Hatch service process could not be started. Check the executable and working directory.",
  process_exited:
    "Hatch service exited before becoming ready. Correct the startup failure before retrying ensure.",
  readiness_timeout:
    "Hatch service did not become ready in time. Check the port, health path and startup logs.",
  registration_rejected:
    "Hatch registration was rejected. Resolve the reported conflict or access failure before retrying.",
  registration_unconfirmed:
    "Hatch registration was not confirmed. Inspect Hatch status before another ensure call.",
  cleanup_failed:
    "Hatch process cleanup was not confirmed. Inspect the existing process before retrying.",
  interrupted: "Hatch startup was interrupted.",
};
export class HatchFailure extends Error {
  readonly _tag = "HatchFailure";
  readonly code: HatchFailureCode;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly exitCode: number | null;
  constructor(
    code: HatchFailureCode,
    stdoutTail = "",
    stderrTail = "",
    exitCode: number | null = null,
    detail?: string,
  ) {
    super(detail ?? failureMessages[code]);
    this.code = code;
    this.stdoutTail = stdoutTail;
    this.stderrTail = stderrTail;
    this.exitCode = exitCode;
  }
}
export function renderHatchFailure(error: HatchFailure): string {
  return [
    `Hatch failed (${error.code}): ${error.message}`,
    ...(error.exitCode === null ? [] : [`Exit code: ${error.exitCode}`]),
    ...(error.stdoutTail ? [`stdout tail:\n${error.stdoutTail}`] : []),
    ...(error.stderrTail ? [`stderr tail:\n${error.stderrTail}`] : []),
  ].join("\n");
}

const ExplicitEnsureParameters = Type.Object(
  {
    operation: Type.Literal("ensure"),
    service: ServiceNameSchema,
    argv: Type.Array(ArgSchema, { minItems: 1, maxItems: MAX_ARGV_LENGTH }),
    cwd: RelativeCwdSchema,
    port: PortSchema,
    healthPath: HealthPathSchema,
    prepare: Type.Optional(PrepareSchema),
    readyTimeoutSeconds: Type.Optional(ReadyTimeoutSchema),
  },
  { additionalProperties: false },
);
const RepositoryEnsureParameters = Type.Object(
  { operation: Type.Literal("ensure") },
  { additionalProperties: false },
);
const HatchTomlSchema = Type.Object(
  {
    hatch: Type.Object(
      {
        service: ServiceNameSchema,
        argv: Type.Array(ArgSchema, { minItems: 1, maxItems: MAX_ARGV_LENGTH }),
        cwd: RelativeCwdSchema,
        port: PortSchema,
        health_path: HealthPathSchema,
        prepare: Type.Optional(PrepareSchema),
        ready_timeout_seconds: Type.Optional(ReadyTimeoutSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const StatusParameters = Type.Object(
  { operation: Type.Literal("status") },
  { additionalProperties: false },
);
const CloseParameters = Type.Object(
  { operation: Type.Literal("close") },
  { additionalProperties: false },
);

export const ScottyHatchParameters = Type.Union([
  ExplicitEnsureParameters,
  RepositoryEnsureParameters,
  StatusParameters,
  CloseParameters,
]);
export type ScottyHatchInput = Static<typeof ScottyHatchParameters>;
type EnsureInput = Static<typeof ExplicitEnsureParameters>;

const displayText = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: 180,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*(?![\\s\\S])",
    description:
      "A short, plain-language phrase describing what this call is trying to achieve, for example 'Starting the invoice preview'. Use present tense; omit credentials, URLs, and internal identifiers.",
  }),
);
export const ScottyHatchToolParameters = Type.Union([
  Type.Object(
    { ...ExplicitEnsureParameters.properties, displayText },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...RepositoryEnsureParameters.properties, displayText },
    { additionalProperties: false },
  ),
  Type.Object({ ...StatusParameters.properties, displayText }, { additionalProperties: false }),
  Type.Object({ ...CloseParameters.properties, displayText }, { additionalProperties: false }),
]);

const TimestampSchema = Type.String({ minLength: 20, maxLength: 64 });
const ConfiguredStatusSchema = Type.Object(
  {
    status: Type.Literal("configured"),
    startupFailure: Type.Optional(Type.String({ maxLength: 64 })),
    hatchId: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\\s\\S])",
    }),
    generation: Type.Integer({ minimum: 1 }),
    service: Type.Object(
      { name: Type.String({ maxLength: MAX_NAME_LENGTH }), port: PortSchema },
      { additionalProperties: false },
    ),
    desiredStatus: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    observedStatus: Type.Union([
      Type.Literal("starting"),
      Type.Literal("running"),
      Type.Literal("sleeping"),
      Type.Literal("unhealthy"),
      Type.Literal("stopped"),
      Type.Literal("failed"),
    ]),
    exposure: Type.Union([
      Type.Literal("not_exposed"),
      Type.Literal("active"),
      Type.Literal("unexpose_pending"),
      Type.Literal("closed"),
    ]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    lastHealthyAt: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);
const HatchStatusSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("not_configured"),
      startupFailure: Type.Optional(Type.String({ maxLength: 64 })),
    },
    { additionalProperties: false },
  ),
  ConfiguredStatusSchema,
]);
const RestoreDescriptorSchema = Type.Object(
  {
    hatchId: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\\s\\S])",
    }),
    generation: Type.Integer({ minimum: 1 }),
    operationNonce: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\\s\\S])",
    }),
    runtimeEpoch: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\\s\\S])",
    }),
    service: Type.Object(
      {
        name: ServiceNameSchema,
        argv: Type.Array(ArgSchema, { minItems: 1, maxItems: MAX_ARGV_LENGTH }),
        workingDirectory: Type.String({
          minLength: 1,
          maxLength: MAX_CWD_LENGTH,
          pattern: "^/(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\u0000]+$",
        }),
        port: PortSchema,
        healthPath: HealthPathSchema,
        readyTimeoutSeconds: Type.Optional(ReadyTimeoutSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const ErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 64 }),
        message: Type.String({ minLength: 1, maxLength: 512 }),
        hint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

type HatchStatus = Static<typeof HatchStatusSchema>;
export type ConfiguredStatus = Static<typeof ConfiguredStatusSchema>;
type RestoreDescriptor = Static<typeof RestoreDescriptorSchema>;
type HatchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ProcessSignal = "SIGTERM" | "SIGKILL";

export interface HatchChildProcess {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface HatchServiceProcess {
  readonly argv: readonly [string, ...string[]];
  readonly workingDirectory: string;
  readonly port: number;
  readonly healthPath: string;
}

export interface ScottyHatchManagerOptions {
  readonly workspaceRoot?: string;
  readonly authorityTransport?: HatchTransport;
  readonly localTransport?: HatchTransport;
  readonly spawnProcess?: (
    argv: readonly [string, ...string[]],
    workingDirectory: string,
    environment: NodeJS.ProcessEnv,
  ) => HatchChildProcess;
  readonly signalProcessGroup?: (pid: number, signal: ProcessSignal) => void;
  readonly processGroupExists?: (pid: number) => boolean;
  readonly readyTimeoutMillis?: number;
  readonly termTimeoutMillis?: number;
  readonly killTimeoutMillis?: number;
}

export interface ScottyHatchResult {
  readonly operation: "ensure" | "status" | "close";
  readonly reference?: string;
  readonly hatch: HatchStatus;
  readonly process: {
    readonly status: "running" | "stopped" | "not_owned";
    readonly stdoutTail: string;
    readonly stderrTail: string;
  };
}

interface OwnedProcess {
  readonly fingerprint: string;
  readonly service: HatchServiceProcess;
  readonly child: HatchChildProcess;
  readonly spawnFailed: { value: boolean };
  readonly stdout: LogTail;
  readonly stderr: LogTail;
}

function startupFailureCode(
  stage: "readiness" | "registration",
  signal: AbortSignal | undefined,
  owned: OwnedProcess,
): HatchFailureCode {
  if (stage === "registration") return "registration_unconfirmed";
  if (signal?.aborted) return "interrupted";
  if (owned.spawnFailed.value) return "process_start_failed";
  return processExited(owned.child) ? "process_exited" : "readiness_timeout";
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readBoundedResponse(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > SCOTTY_HATCH_MAX_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > SCOTTY_HATCH_MAX_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function validTimestamp(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validateStatus(value: unknown): HatchStatus | undefined {
  if (!Check(HatchStatusSchema, value)) return undefined;
  if (value.status === "configured") {
    if (
      !validTimestamp(value.createdAt) ||
      !validTimestamp(value.updatedAt) ||
      (value.lastHealthyAt !== undefined && !validTimestamp(value.lastHealthyAt))
    )
      return undefined;
  }
  return value;
}

function sanitizeText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/gu, "[credential redacted]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/giu, "[url redacted]")
    .replace(/\bscotty-hatch:[A-Za-z0-9_-]+\b/gu, "[reference redacted]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [credential redacted]")
    .replace(
      /\b(authorization|credential|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[credential redacted]",
    );
}

function tailUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return value;
  return new TextDecoder().decode(bytes.subarray(bytes.byteLength - limit));
}

class LogTail {
  #raw = Buffer.alloc(0);

  append(chunk: string | Buffer): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const rawLimit = SCOTTY_HATCH_LOG_TAIL_BYTES * 4;
    const boundedIncoming =
      incoming.byteLength <= rawLimit
        ? incoming
        : incoming.subarray(incoming.byteLength - rawLimit);
    const combined = Buffer.concat([this.#raw, boundedIncoming]);
    this.#raw =
      combined.byteLength <= rawLimit
        ? combined
        : combined.subarray(combined.byteLength - rawLimit);
  }

  value(): string {
    return tailUtf8(sanitizeText(new TextDecoder().decode(this.#raw)), SCOTTY_HATCH_LOG_TAIL_BYTES);
  }
}

function readableCertificate(path: string | undefined): path is string {
  if (path === undefined || !isAbsolute(path)) return false;
  try {
    accessSync(path, fsConstants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  // Node reads this additive trust bundle at child startup. The Cloudflare CA is
  // ephemeral and is not present when the image is built or run without interception.
  const certificate = readableCertificate(CLOUDFLARE_CA_CERTIFICATE)
    ? CLOUDFLARE_CA_CERTIFICATE
    : readableCertificate(source.NODE_EXTRA_CA_CERTS)
      ? source.NODE_EXTRA_CA_CERTS
      : undefined;
  if (certificate !== undefined) environment.NODE_EXTRA_CA_CERTS = certificate;
  if (source.COREPACK_HOME === IMAGE_COREPACK_HOME) environment.COREPACK_HOME = IMAGE_COREPACK_HOME;
  return environment;
}

function defaultSpawnProcess(
  argv: readonly [string, ...string[]],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): HatchChildProcess {
  return spawn(argv[0], argv.slice(1), {
    cwd: workingDirectory,
    detached: true,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function missingProcessGroup(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function defaultSignalProcessGroup(pid: number, signal: ProcessSignal): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (missingProcessGroup(error)) return;
    throw error;
  }
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (missingProcessGroup(error)) return false;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM")
      return true;
    throw error;
  }
}

function processExited(child: HatchChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function abortError(): Error {
  const error = new Error("Scotty Hatch operation was interrupted");
  error.name = "AbortError";
  return error;
}

function wait(millis: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timeout = setTimeout(finish, millis);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      rejectPromise(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForLoopbackReadiness(
  service: HatchServiceProcess,
  child: HatchChildProcess,
  signal: AbortSignal | undefined,
  transport: HatchTransport = fetch,
  timeoutMillis = SCOTTY_HATCH_READY_TIMEOUT_MILLIS,
): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  const target = new URL(service.healthPath, `http://127.0.0.1:${service.port}`);
  for (;;) {
    if (signal?.aborted) throw abortError();
    if (processExited(child)) throw new Error("Hatch service exited before becoming ready");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await transport(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status <= 399 && !processExited(child)) return;
    } catch {
      if (signal?.aborted) throw abortError();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    if (Date.now() >= deadline) throw new Error("Hatch service did not become ready in time");
    await wait(Math.min(200, Math.max(1, deadline - Date.now())), signal);
  }
}

async function requestAuthority(
  operation: "ensure" | "status" | "close",
  body: string | undefined,
  signal: AbortSignal | undefined,
  transport: HatchTransport,
): Promise<HatchStatus> {
  const method = operation === "status" ? "GET" : operation === "close" ? "DELETE" : "POST";
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOTTY_HATCH_AUTHORITY_TIMEOUT_MILLIS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  let text: string | undefined;
  try {
    response = await transport(SCOTTY_HATCH_ROUTE, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
      signal: controller.signal,
    });
    text = await readBoundedResponse(response);
  } catch {
    if (signal?.aborted) throw abortError();
    throw new Error("Scotty Hatch authority request did not complete");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (text === undefined)
    throw new Error("Scotty Hatch response exceeds the 64 KiB limit or is invalid UTF-8");
  const value = parseJson(text);
  if (!response.ok) {
    if (operation === "ensure" && response.status >= 400 && response.status < 500)
      throw new HatchFailure(
        "registration_rejected",
        "",
        "",
        null,
        Check(ErrorEnvelopeSchema, value)
          ? `Hatch registration rejected (${value.error.code}). Review existing Hatch status and configuration.`
          : `Hatch registration rejected (HTTP ${response.status}).`,
      );
    if (Check(ErrorEnvelopeSchema, value))
      throw new Error(
        sanitizeText(`Scotty Hatch request failed (${value.error.code}): ${value.error.message}`),
      );
    throw new Error(`Scotty Hatch request failed with HTTP ${response.status}`);
  }
  const status = validateStatus(value);
  if (status === undefined) throw new Error("Scotty Hatch returned an invalid result");
  return status;
}

async function requestRestoreDescriptor(
  transport: HatchTransport,
  signal?: AbortSignal,
): Promise<RestoreDescriptor | undefined> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOTTY_HATCH_AUTHORITY_TIMEOUT_MILLIS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  let text: string | undefined;
  try {
    response = await transport(SCOTTY_HATCH_RESTORE_ROUTE, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.status === 204) {
      await response.body?.cancel();
      return undefined;
    }
    text = await readBoundedResponse(response);
  } catch {
    if (signal?.aborted) throw abortError();
    throw new Error("Scotty Hatch restore request did not complete");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok)
    throw new Error(`Scotty Hatch restore request failed with HTTP ${response.status}`);
  if (text === undefined)
    throw new Error("Scotty Hatch restore response exceeds the 64 KiB limit or is invalid UTF-8");
  const value = parseJson(text);
  if (!Check(RestoreDescriptorSchema, value) || value.service.argv[0]?.length === 0)
    throw new Error("Scotty Hatch returned an invalid restore descriptor");
  return value;
}

async function resolveWorkingDirectory(
  workspaceRoot: string,
  relativeCwd: string,
): Promise<string> {
  if (
    isAbsolute(relativeCwd) ||
    relativeCwd.includes("\\") ||
    relativeCwd.includes("\0") ||
    relativeCwd.split("/").includes("..")
  )
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Hatch cwd must be a workspace-relative path without parent traversal",
    );
  const normalized = normalize(relativeCwd);
  if (normalized === ".." || normalized.startsWith(`..${sep}`))
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Hatch cwd must stay inside the workspace",
    );
  const candidate = await realpath(resolve(workspaceRoot, normalized));
  const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (candidate !== workspaceRoot && !candidate.startsWith(rootPrefix))
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Hatch cwd resolves outside the workspace",
    );
  if (!(await stat(candidate)).isDirectory())
    throw new HatchFailure("invalid_config", "", "", null, "Hatch cwd must resolve to a directory");
  return candidate;
}

async function resolveRestoreWorkingDirectory(
  workspaceRoot: string,
  absoluteCwd: string,
): Promise<string> {
  const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (
    !isAbsolute(absoluteCwd) ||
    absoluteCwd.includes("\\") ||
    absoluteCwd.includes("\0") ||
    absoluteCwd.split("/").includes("..") ||
    (absoluteCwd !== workspaceRoot && !absoluteCwd.startsWith(rootPrefix))
  )
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Hatch restore cwd must stay inside the workspace",
    );
  const candidate = await realpath(absoluteCwd);
  if (
    candidate !== absoluteCwd ||
    (candidate !== workspaceRoot && !candidate.startsWith(rootPrefix)) ||
    !(await stat(candidate)).isDirectory()
  )
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Hatch restore cwd must resolve exactly inside the workspace",
    );
  return candidate;
}

function checkedInput(value: unknown): ScottyHatchInput {
  if (!Check(ScottyHatchToolParameters, value))
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "scotty_hatch input does not match the bounded operation schema",
    );
  if (value.operation === "ensure" && "argv" in value && value.argv[0]?.length === 0)
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "scotty_hatch argv[0] must not be empty",
    );
  const { displayText: _displayText, ...input } = value;
  return input;
}

function configReadError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    return new RepositoryHatchMissingError("Repository hatch.toml is missing");
  return new HatchFailure(
    "invalid_config",
    "",
    "",
    null,
    "Repository hatch.toml could not be read",
  );
}

export async function loadRepositoryHatchConfig(workspaceRoot: string): Promise<EnsureInput> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(workspaceRoot, SCOTTY_HATCH_CONFIG_FILE_NAME));
  } catch (error) {
    throw configReadError(error);
  }
  if (bytes.byteLength > SCOTTY_HATCH_MAX_BYTES)
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Repository hatch.toml exceeds the 64 KiB limit",
    );

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Repository hatch.toml is not valid UTF-8",
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Repository hatch.toml contains malformed TOML",
    );
  }
  if (!Check(HatchTomlSchema, parsed) || parsed.hatch.argv[0]?.length === 0)
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "Repository hatch.toml contains unsupported or malformed fields",
    );

  return {
    operation: "ensure",
    service: parsed.hatch.service,
    argv: parsed.hatch.argv,
    cwd: parsed.hatch.cwd,
    port: parsed.hatch.port,
    healthPath: parsed.hatch.health_path,
    ...(parsed.hatch.prepare === undefined ? {} : { prepare: parsed.hatch.prepare }),
    ...(parsed.hatch.ready_timeout_seconds === undefined
      ? {}
      : { readyTimeoutSeconds: parsed.hatch.ready_timeout_seconds }),
  };
}

function statusReference(status: HatchStatus): string | undefined {
  return status.status === "configured" ? `scotty-hatch:${status.hatchId}` : undefined;
}

function confirmsRunningService(status: HatchStatus, input: EnsureInput): boolean {
  return (
    status.status === "configured" &&
    status.service.name === input.service &&
    status.service.port === input.port &&
    status.desiredStatus === "open" &&
    status.observedStatus === "running" &&
    status.exposure === "active"
  );
}

function safeStatus(status: HatchStatus): HatchStatus {
  if (status.status === "not_configured") return status;
  return { ...status, service: { ...status.service, name: sanitizeText(status.service.name) } };
}

function fingerprint(service: HatchServiceProcess, name: string): string {
  return JSON.stringify({ name, ...service });
}

function ensureAuthorityBody(input: EnsureInput, workingDirectory: string): string {
  const body = JSON.stringify({
    service: {
      name: input.service,
      argv: input.argv,
      workingDirectory,
      port: input.port,
      healthPath: input.healthPath,
      ...(input.readyTimeoutSeconds === undefined
        ? {}
        : { readyTimeoutSeconds: input.readyTimeoutSeconds }),
    },
  });
  if (byteLength(body) > SCOTTY_HATCH_MAX_BYTES)
    throw new HatchFailure(
      "invalid_config",
      "",
      "",
      null,
      "scotty_hatch ensure request exceeds the 64 KiB limit",
    );
  return body;
}

function processProjection(owned: OwnedProcess | undefined): ScottyHatchResult["process"] {
  if (owned === undefined) return { status: "not_owned", stdoutTail: "", stderrTail: "" };
  return {
    status: processExited(owned.child) ? "stopped" : "running",
    stdoutTail: owned.stdout.value(),
    stderrTail: owned.stderr.value(),
  };
}

export class ScottyHatchManager {
  readonly #workspaceRoot: Promise<string>;
  readonly #authorityTransport: HatchTransport;
  readonly #localTransport: HatchTransport;
  readonly #spawnProcess: NonNullable<ScottyHatchManagerOptions["spawnProcess"]>;
  readonly #signalProcessGroup: NonNullable<ScottyHatchManagerOptions["signalProcessGroup"]>;
  readonly #processGroupExists: NonNullable<ScottyHatchManagerOptions["processGroupExists"]>;
  readonly #readyTimeoutMillis: number;
  readonly #termTimeoutMillis: number;
  readonly #killTimeoutMillis: number;
  #owned: OwnedProcess | undefined;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: ScottyHatchManagerOptions = {}) {
    this.#workspaceRoot = realpath(options.workspaceRoot ?? process.cwd());
    this.#authorityTransport = options.authorityTransport ?? fetch;
    this.#localTransport = options.localTransport ?? fetch;
    this.#spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.#signalProcessGroup = options.signalProcessGroup ?? defaultSignalProcessGroup;
    this.#processGroupExists = options.processGroupExists ?? defaultProcessGroupExists;
    this.#readyTimeoutMillis = options.readyTimeoutMillis ?? SCOTTY_HATCH_READY_TIMEOUT_MILLIS;
    this.#termTimeoutMillis = options.termTimeoutMillis ?? 3_000;
    this.#killTimeoutMillis = options.killTimeoutMillis ?? 1_000;
  }

  run(value: unknown, signal?: AbortSignal): Promise<ScottyHatchResult> {
    return this.#exclusive(async () => {
      let input: ScottyHatchInput;
      try {
        input = checkedInput(value);
      } catch (error) {
        return this.#reportInvalidConfig(error);
      }
      if (input.operation === "status") return this.#status(signal);
      if (input.operation === "close") return this.#close(signal);
      if ("service" in input) return this.#ensureReported(input, signal);
      let ensureInput: EnsureInput;
      try {
        ensureInput = await loadRepositoryHatchConfig(await this.#workspaceRoot);
      } catch (error) {
        if (error instanceof RepositoryHatchMissingError)
          return this.#result("ensure", { status: "not_configured" }, this.#owned);
        return this.#reportInvalidConfig(error);
      }
      return this.#ensureReported(ensureInput, signal);
    });
  }

  restore(signal?: AbortSignal): Promise<void> {
    return this.#exclusive(() => this.#restore(signal));
  }

  shutdown(): Promise<void> {
    return this.#exclusive(async () => {
      const owned = this.#owned;
      if (owned === undefined) return;
      await this.#stopOwned(owned);
      if (this.#owned === owned) this.#owned = undefined;
    });
  }

  async #exclusive<A>(operation: () => Promise<A>): Promise<A> {
    const previous = this.#operationTail;
    let release = () => {};
    this.#operationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #startupReport(input: unknown): Promise<{ attemptId: string; runtimeEpoch: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCOTTY_HATCH_AUTHORITY_TIMEOUT_MILLIS);
    try {
      const response = await this.#authorityTransport(SCOTTY_HATCH_STARTUP_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const text = await readBoundedResponse(response);
      const value = text === undefined ? undefined : parseJson(text);
      const ticket = Type.Object(
        {
          attemptId: Type.String({ minLength: 1, maxLength: 128 }),
          runtimeEpoch: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
      );
      if (!response.ok || !Check(ticket, value)) throw new HatchFailure("registration_unconfirmed");
      return value;
    } catch {
      throw new HatchFailure("registration_unconfirmed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async #reportInvalidConfig(error: unknown): Promise<never> {
    const failure = error instanceof HatchFailure ? error : new HatchFailure("invalid_config");
    const ticket = await this.#startupReport({ operation: "begin" });
    try {
      await this.#startupReport({ operation: "finish", ...ticket, failureCode: failure.code });
    } catch {
      /* Keep the original configuration error in the tool receipt. */
    }
    throw failure;
  }

  async #ensureReported(input: EnsureInput, signal?: AbortSignal): Promise<ScottyHatchResult> {
    const ticket = await this.#startupReport({ operation: "begin" });
    let result: ScottyHatchResult;
    try {
      result = await this.#ensure(input, signal);
    } catch (error) {
      const failure = error instanceof HatchFailure ? error : new HatchFailure("invalid_config");
      try {
        await this.#startupReport({ operation: "finish", ...ticket, failureCode: failure.code });
      } catch {
        /* The tool receipt still carries the original failure if status publication fails. */
      }
      throw failure;
    }
    try {
      await this.#startupReport({ operation: "finish", ...ticket });
    } catch {
      throw new HatchFailure("registration_unconfirmed");
    }
    return result;
  }

  async #ensure(input: EnsureInput, signal?: AbortSignal): Promise<ScottyHatchResult> {
    const workspaceRoot = await this.#workspaceRoot;
    const workingDirectory = await resolveWorkingDirectory(workspaceRoot, input.cwd);
    const [command, ...args] = input.argv;
    if (command === undefined || command.length === 0)
      throw new HatchFailure(
        "invalid_config",
        "",
        "",
        null,
        "scotty_hatch argv[0] must not be empty",
      );
    const argv: [string, ...string[]] = [command, ...args];
    const service: HatchServiceProcess = {
      argv,
      workingDirectory,
      port: input.port,
      healthPath: input.healthPath,
    };
    const authorityBody = ensureAuthorityBody(input, workingDirectory);
    const requestedFingerprint = fingerprint(service, input.service);
    if (this.#owned !== undefined && this.#owned.fingerprint !== requestedFingerprint)
      throw new HatchFailure(
        "invalid_config",
        "",
        "",
        null,
        "A different primary Hatch service is already owned by this session",
      );

    let owned = this.#owned;
    if (owned === undefined || processExited(owned.child)) {
      if (input.prepare !== undefined) await this.#prepare(input.prepare, service, signal);
      owned = this.#startOwned(service, input.service);
    }

    let stage: "readiness" | "registration" = "readiness";
    try {
      await waitForLoopbackReadiness(
        service,
        owned.child,
        signal,
        this.#localTransport,
        input.readyTimeoutSeconds === undefined
          ? this.#readyTimeoutMillis
          : input.readyTimeoutSeconds * 1000,
      );
      if (owned.spawnFailed.value) throw new Error("Hatch service process failed to start");
      stage = "registration";
      const status = await requestAuthority(
        "ensure",
        authorityBody,
        signal,
        this.#authorityTransport,
      );
      if (!confirmsRunningService(status, input))
        throw new HatchFailure(
          "registration_rejected",
          "",
          "",
          null,
          "Scotty Hatch did not confirm the requested running service",
        );
      return this.#result("ensure", status, owned);
    } catch (error) {
      const code =
        error instanceof HatchFailure ? error.code : startupFailureCode(stage, signal, owned);
      const failure = new HatchFailure(
        code,
        owned.stdout.value(),
        owned.stderr.value(),
        owned.child.exitCode,
        error instanceof HatchFailure ? error.message : undefined,
      );
      // A committed registration can lose its response. Keep the process owned while the
      // operator inspects authority; stopping it would leave a falsely running Hatch record.
      if (failure.code === "registration_unconfirmed") throw failure;
      try {
        await this.#stopOwned(owned);
      } catch {
        throw new HatchFailure(
          "cleanup_failed",
          failure.stdoutTail,
          failure.stderrTail,
          failure.exitCode,
        );
      }
      if (this.#owned === owned) this.#owned = undefined;
      throw failure;
    }
  }

  async #prepare(
    input: Static<typeof PrepareSchema>,
    service: HatchServiceProcess,
    signal?: AbortSignal,
  ): Promise<void> {
    const [command, ...args] = input.argv;
    if (!command) throw new HatchFailure("invalid_config");
    let owned: OwnedProcess;
    try {
      owned = this.#startOwned({ ...service, argv: [command, ...args] }, "preparation");
    } catch {
      throw new HatchFailure("preparation_failed");
    }
    const deadline = Date.now() + input.timeout_seconds * 1000;
    let failure: HatchFailure | undefined;
    try {
      while (!processExited(owned.child) && !owned.spawnFailed.value) {
        if (signal?.aborted) throw new HatchFailure("interrupted");
        if (Date.now() >= deadline) throw new HatchFailure("preparation_timeout");
        await wait(Math.min(100, Math.max(1, deadline - Date.now())), signal);
      }
      if (owned.spawnFailed.value || owned.child.exitCode !== 0)
        throw new HatchFailure("preparation_failed");
    } catch (error) {
      failure = new HatchFailure(
        signal?.aborted
          ? "interrupted"
          : error instanceof HatchFailure
            ? error.code
            : "preparation_failed",
        owned.stdout.value(),
        owned.stderr.value(),
        owned.child.exitCode,
      );
    }
    try {
      await this.#stopOwned(owned);
    } catch {
      throw new HatchFailure(
        "cleanup_failed",
        owned.stdout.value(),
        owned.stderr.value(),
        owned.child.exitCode,
      );
    }
    if (this.#owned === owned) this.#owned = undefined;
    if (failure !== undefined) throw failure;
  }

  async #restore(signal?: AbortSignal): Promise<void> {
    const descriptor = await requestRestoreDescriptor(this.#authorityTransport, signal);
    if (descriptor === undefined) return;
    const workspaceRoot = await this.#workspaceRoot;
    const workingDirectory = await resolveRestoreWorkingDirectory(
      workspaceRoot,
      descriptor.service.workingDirectory,
    );
    const [command, ...args] = descriptor.service.argv;
    if (command === undefined || command.length === 0)
      throw new Error("Hatch restore command must not be empty");
    const service: HatchServiceProcess = {
      argv: [command, ...args],
      workingDirectory,
      port: descriptor.service.port,
      healthPath: descriptor.service.healthPath,
    };
    const requestedFingerprint = fingerprint(service, descriptor.service.name);
    if (this.#owned !== undefined && this.#owned.fingerprint !== requestedFingerprint)
      throw new HatchFailure(
        "invalid_config",
        "",
        "",
        null,
        "A different primary Hatch service is already owned by this session",
      );
    let owned = this.#owned;
    if (owned === undefined || processExited(owned.child))
      owned = this.#startOwned(service, descriptor.service.name);
    try {
      await waitForLoopbackReadiness(
        service,
        owned.child,
        signal,
        this.#localTransport,
        descriptor.service.readyTimeoutSeconds === undefined
          ? this.#readyTimeoutMillis
          : descriptor.service.readyTimeoutSeconds * 1000,
      );
      if (owned.spawnFailed.value) throw new Error("Hatch service process failed to start");
    } catch (error) {
      try {
        await this.#stopOwned(owned);
      } catch {
        throw new Error("Scotty Hatch restore failed and its child process could not be stopped");
      }
      if (this.#owned === owned) this.#owned = undefined;
      throw error;
    }
  }

  #startOwned(service: HatchServiceProcess, name: string): OwnedProcess {
    let child: HatchChildProcess;
    try {
      child = this.#spawnProcess(
        service.argv,
        service.workingDirectory,
        safeEnvironment(process.env),
      );
    } catch {
      throw new HatchFailure("process_start_failed");
    }
    const stdout = new LogTail();
    const stderr = new LogTail();
    const spawnFailed = { value: false };
    child.once("error", () => {
      spawnFailed.value = true;
    });
    if (child.pid === undefined || child.pid <= 0) throw new HatchFailure("process_start_failed");
    child.stdout?.on("data", (chunk: string | Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: string | Buffer) => stderr.append(chunk));
    const owned = {
      fingerprint: fingerprint(service, name),
      service,
      child,
      spawnFailed,
      stdout,
      stderr,
    };
    this.#owned = owned;
    return owned;
  }

  async #status(signal?: AbortSignal): Promise<ScottyHatchResult> {
    const status = await requestAuthority("status", undefined, signal, this.#authorityTransport);
    return this.#result("status", status, this.#owned);
  }

  async #close(signal?: AbortSignal): Promise<ScottyHatchResult> {
    const status = await requestAuthority("close", undefined, signal, this.#authorityTransport);
    if (
      status.status === "configured" &&
      (status.desiredStatus !== "closed" ||
        status.observedStatus !== "stopped" ||
        status.exposure !== "closed")
    )
      throw new Error("Scotty Hatch did not confirm closure");
    const owned = this.#owned;
    if (owned !== undefined) await this.#stopOwned(owned);
    const result = this.#result("close", status, owned);
    if (this.#owned === owned) this.#owned = undefined;
    return result;
  }

  async #stopOwned(owned: OwnedProcess): Promise<void> {
    const pid = owned.child.pid;
    if (pid === undefined) throw new Error("Hatch service process group is unavailable");
    if (processExited(owned.child) && !this.#processGroupExists(pid)) return;
    this.#signalProcessGroup(pid, "SIGTERM");
    if (await this.#waitForOwnedGroupExit(owned, this.#termTimeoutMillis)) return;
    this.#signalProcessGroup(pid, "SIGKILL");
    if (!(await this.#waitForOwnedGroupExit(owned, this.#killTimeoutMillis)))
      throw new Error("Hatch service process group did not stop");
  }

  async #waitForOwnedGroupExit(owned: OwnedProcess, timeoutMillis: number): Promise<boolean> {
    const pid = owned.child.pid;
    if (pid === undefined) return false;
    const deadline = Date.now() + timeoutMillis;
    for (;;) {
      if (processExited(owned.child) && !this.#processGroupExists(pid)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await wait(Math.min(25, remaining));
    }
  }

  #result(
    operation: ScottyHatchResult["operation"],
    authoritative: HatchStatus,
    owned: OwnedProcess | undefined,
  ): ScottyHatchResult {
    const hatch = safeStatus(authoritative);
    const result: ScottyHatchResult = {
      operation,
      ...(statusReference(hatch) === undefined ? {} : { reference: statusReference(hatch) }),
      hatch,
      process: processProjection(owned),
    };
    if (byteLength(JSON.stringify(result)) > SCOTTY_HATCH_MAX_BYTES)
      throw new Error("Scotty Hatch result exceeds the 64 KiB limit");
    return result;
  }
}

function renderResult(result: ScottyHatchResult): string {
  if (result.hatch.status === "not_configured")
    return result.operation === "ensure"
      ? "Hatch is not configured for this repository. Add hatch.toml to enable it."
      : "Hatch is not configured.";
  if (result.reference === undefined) return "Hatch status is unavailable.";
  const status =
    result.hatch.status === "configured" ? result.hatch.observedStatus : "not_configured";
  const lines = [
    result.reference,
    `Hatch status: ${status}`,
    `Local process: ${result.process.status}`,
  ];
  if (result.process.stdoutTail) lines.push(`stdout tail:\n${result.process.stdoutTail}`);
  if (result.process.stderrTail) lines.push(`stderr tail:\n${result.process.stderrTail}`);
  return lines.join("\n");
}

export default function scottyHatch(pi: ExtensionAPI): void {
  const manager = new ScottyHatchManager();
  pi.on("session_start", async () => manager.restore());
  pi.on("session_shutdown", async () => manager.shutdown());
  pi.registerTool({
    name: "scotty_hatch",
    label: "Scotty Hatch",
    description:
      "Ensure, inspect, or close the one bounded application Hatch for the current warm Scotty session. Ensure loads strict repository-root hatch.toml configuration when service fields are omitted; complete inline configuration remains a manual override. If hatch.toml is absent, ensure is a no-op and must not be retried.",
    promptSnippet: "Manage the current session's bounded authenticated application Hatch",
    promptGuidelines: [
      "Include displayText on every call: a short phrase describing the intended task, not the tool name or a claim of success. Omit credentials, URLs, and internal identifiers.",
      "Use scotty_hatch ensure without inline service fields only when the repository has a reviewed root hatch.toml; if it is absent, do not call or retry ensure. Use a complete explicit argv array and workspace-relative cwd only as a manual override. Never pass shell commands, environment variables, credentials, URLs, or inferred service identity.",
      "In the next meaningful progress or final update, include the returned exact scotty-hatch:<hatchId> reference once. Never invent or repeat a reference, and do not publish ports, paths, argv, authority values, or URLs.",
    ],
    parameters: ScottyHatchToolParameters,
    async execute(_toolCallId, params, signal) {
      try {
        const result = await manager.run(params, signal);
        return {
          content: [{ type: "text" as const, text: renderResult(result) }],
          details: result,
        };
      } catch (error) {
        if (!(error instanceof HatchFailure)) throw error;
        throw new Error(renderHatchFailure(error));
      }
    },
  });
}
