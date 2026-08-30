import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const SCOTTY_HATCH_ROUTE = "https://scotty.internal/api/hatch";
export const SCOTTY_HATCH_RESTORE_ROUTE = "https://scotty.internal/api/hatch/restore";
export const SCOTTY_HATCH_MAX_BYTES = 64 * 1_024;
export const SCOTTY_HATCH_LOG_TAIL_BYTES = 4 * 1_024;
export const SCOTTY_HATCH_READY_TIMEOUT_MILLIS = 30_000;
export const SCOTTY_HATCH_AUTHORITY_TIMEOUT_MILLIS = 30_000;

const MAX_NAME_LENGTH = 120;
const MAX_ARG_LENGTH = 4_096;
const MAX_ARGV_LENGTH = 64;
const MAX_CWD_LENGTH = 1_024;
const MAX_HEALTH_PATH_LENGTH = 2_048;
const RESERVED_PORTS = [3_000, 43_117] as const;
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

const EnsureParameters = Type.Object(
  {
    operation: Type.Literal("ensure"),
    service: ServiceNameSchema,
    argv: Type.Array(ArgSchema, { minItems: 1, maxItems: MAX_ARGV_LENGTH }),
    cwd: RelativeCwdSchema,
    port: PortSchema,
    healthPath: HealthPathSchema,
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
  EnsureParameters,
  StatusParameters,
  CloseParameters,
]);
export type ScottyHatchInput = Static<typeof ScottyHatchParameters>;
type EnsureInput = Static<typeof EnsureParameters>;

const TimestampSchema = Type.String({ minLength: 20, maxLength: 64 });
const ConfiguredStatusSchema = Type.Object(
  {
    version: Type.Literal(1),
    status: Type.Literal("configured"),
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
    { version: Type.Literal(1), status: Type.Literal("not_configured") },
    { additionalProperties: false },
  ),
  ConfiguredStatusSchema,
]);
const RestoreDescriptorSchema = Type.Object(
  {
    version: Type.Literal(1),
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
  readonly version: 1;
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
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
): Promise<RestoreDescriptor | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOTTY_HATCH_AUTHORITY_TIMEOUT_MILLIS);
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
    throw new Error("Scotty Hatch restore request did not complete");
  } finally {
    clearTimeout(timeout);
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
    throw new Error("Hatch cwd must be a workspace-relative path without parent traversal");
  const normalized = normalize(relativeCwd);
  if (normalized === ".." || normalized.startsWith(`..${sep}`))
    throw new Error("Hatch cwd must stay inside the workspace");
  const candidate = await realpath(resolve(workspaceRoot, normalized));
  const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (candidate !== workspaceRoot && !candidate.startsWith(rootPrefix))
    throw new Error("Hatch cwd resolves outside the workspace");
  if (!(await stat(candidate)).isDirectory())
    throw new Error("Hatch cwd must resolve to a directory");
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
    throw new Error("Hatch restore cwd must stay inside the workspace");
  const candidate = await realpath(absoluteCwd);
  if (
    candidate !== absoluteCwd ||
    (candidate !== workspaceRoot && !candidate.startsWith(rootPrefix)) ||
    !(await stat(candidate)).isDirectory()
  )
    throw new Error("Hatch restore cwd must resolve exactly inside the workspace");
  return candidate;
}

function checkedInput(value: unknown): ScottyHatchInput {
  if (!Check(ScottyHatchParameters, value))
    throw new Error("scotty_hatch input does not match the bounded v1 operation schema");
  if (value.operation === "ensure" && value.argv[0]?.length === 0)
    throw new Error("scotty_hatch argv[0] must not be empty");
  return value;
}

function statusReference(status: HatchStatus): string | undefined {
  return status.status === "configured" ? `scotty-hatch:${status.hatchId}` : undefined;
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
    version: 1,
    service: {
      name: input.service,
      argv: input.argv,
      workingDirectory,
      port: input.port,
      healthPath: input.healthPath,
    },
  });
  if (byteLength(body) > SCOTTY_HATCH_MAX_BYTES)
    throw new Error("scotty_hatch ensure request exceeds the 64 KiB limit");
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
      const input = checkedInput(value);
      if (input.operation === "status") return this.#status(signal);
      if (input.operation === "close") return this.#close(signal);
      return this.#ensure(input, signal);
    });
  }

  restore(): Promise<void> {
    return this.#exclusive(() => this.#restore());
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

  async #ensure(input: EnsureInput, signal?: AbortSignal): Promise<ScottyHatchResult> {
    const workspaceRoot = await this.#workspaceRoot;
    const workingDirectory = await resolveWorkingDirectory(workspaceRoot, input.cwd);
    const [command, ...args] = input.argv;
    if (command === undefined || command.length === 0)
      throw new Error("scotty_hatch argv[0] must not be empty");
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
      throw new Error("A different primary Hatch service is already owned by this Pi session");

    let owned = this.#owned;
    if (owned === undefined || processExited(owned.child))
      owned = this.#startOwned(service, input.service);

    try {
      await waitForLoopbackReadiness(
        service,
        owned.child,
        signal,
        this.#localTransport,
        this.#readyTimeoutMillis,
      );
      if (owned.spawnFailed.value) throw new Error("Hatch service process failed to start");
      const status = await requestAuthority(
        "ensure",
        authorityBody,
        signal,
        this.#authorityTransport,
      );
      if (
        status.status !== "configured" ||
        status.service.name !== input.service ||
        status.service.port !== input.port ||
        status.desiredStatus !== "open" ||
        status.observedStatus !== "running" ||
        status.exposure !== "active"
      )
        throw new Error("Scotty Hatch did not confirm the requested running service");
      return this.#result("ensure", status, owned);
    } catch (error) {
      try {
        await this.#stopOwned(owned);
      } catch {
        throw new Error("Scotty Hatch ensure failed and its child process could not be stopped");
      }
      if (this.#owned === owned) this.#owned = undefined;
      throw error;
    }
  }

  async #restore(): Promise<void> {
    const descriptor = await requestRestoreDescriptor(this.#authorityTransport);
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
      throw new Error("A different primary Hatch service is already owned by this Pi session");
    let owned = this.#owned;
    if (owned === undefined || processExited(owned.child))
      owned = this.#startOwned(service, descriptor.service.name);
    try {
      await waitForLoopbackReadiness(
        service,
        owned.child,
        undefined,
        this.#localTransport,
        this.#readyTimeoutMillis,
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
      throw new Error("Hatch service process could not be started");
    }
    const stdout = new LogTail();
    const stderr = new LogTail();
    const spawnFailed = { value: false };
    child.once("error", () => {
      spawnFailed.value = true;
    });
    if (child.pid === undefined || child.pid <= 0)
      throw new Error("Hatch service process did not provide a process-group identifier");
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
      version: 1,
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
  if (result.reference === undefined) return "Hatch is not configured.";
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
      "Ensure, inspect, or close the one bounded application Hatch for the current warm Scotty session. Ensure requires an explicit service name, argv, workspace-relative cwd, approved port, and health path.",
    promptSnippet: "Manage the current session's bounded authenticated application Hatch",
    promptGuidelines: [
      "Use scotty_hatch ensure only with an explicit argv array and workspace-relative cwd. Do not pass shell commands, environment variables, credentials, URLs, or inferred service identity.",
      "In the next meaningful progress or final update, include the returned exact scotty-hatch:<hatchId> reference once. Never invent or repeat a reference, and do not publish ports, paths, argv, authority values, or URLs.",
    ],
    parameters: ScottyHatchParameters,
    async execute(_toolCallId, params, signal) {
      const result = await manager.run(params, signal);
      return {
        content: [{ type: "text" as const, text: renderResult(result) }],
        details: result,
      };
    },
  });
}
