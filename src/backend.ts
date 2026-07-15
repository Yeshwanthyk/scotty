import { join } from "node:path";

import type {
  DownInput,
  DownResult,
  ListResult,
  LifecycleBackend,
  ResumeResult,
  SessionSummary,
  StatusResult,
  UpInput,
  UpResult,
  VaporizeResult,
} from "./types";

export class BackendError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;

type Config = {
  apiUrl: string;
  token: string;
  gatewayHost?: string;
};

export type EngineCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BackendDeps = {
  env: Record<string, string | undefined>;
  home: string;
  runBeam(args: string[]): Promise<EngineCommandResult>;
  readText(path: string): Promise<string>;
  fetch(input: string, init: RequestInit): Promise<Response>;
  onProgress(text: string): void;
};

export function createBackend(overrides: Partial<BackendDeps> = {}): LifecycleBackend {
  const env = overrides.env ?? process.env;
  const deps: BackendDeps = {
    env,
    home: overrides.home ?? env.HOME ?? process.env.HOME ?? "",
    runBeam: overrides.runBeam ?? defaultBeamRunner(env),
    readText: overrides.readText ?? (async (path) => await Bun.file(path).text()),
    fetch: overrides.fetch ?? (async (input, init) => await fetch(input, init)),
    onProgress: overrides.onProgress ?? (() => undefined),
  };
  return new ScottyLifecycleBackend(deps);
}

class ScottyLifecycleBackend implements LifecycleBackend {
  constructor(private readonly deps: BackendDeps) {}

  async up(input: UpInput): Promise<UpResult> {
    const args = input.project === undefined
      ? pushArgs(input)
      : newArgs(input);
    const body = await this.runBeamJson(args);
    const id = requiredString(body, "beamId", "Scotty did not return a session id");
    const url = optionalString(body, "sessionUrl") ?? optionalString(body, "url") ?? await this.sessionUrl(id);
    const ssh = optionalString(body, "sshCommand");
    const wakeStatus = isObject(body.wake) ? optionalString(body.wake, "status") : undefined;
    const status = body.wake === false ? "saved" : wakeStatus === "running" ? "active" : "waking";
    return { id, url, status, ...(ssh === undefined ? {} : { ssh }) };
  }

  async down(input: DownInput): Promise<DownResult> {
    const args = ["pull", input.id, "--json"];
    if (input.cwd !== undefined) args.push("--cwd", input.cwd);
    if (input.force) args.push("--force");
    const body = await this.runBeamJson(args);
    const id = optionalString(body, "beamId") ?? input.id;
    const resume = stringArray(body.resume, "Scotty returned an invalid local resume command");
    return { id, status: "down", resume };
  }

  async vaporize(id: string): Promise<VaporizeResult> {
    const config = await this.config();
    const body = await this.apiJson(config, "POST", `/v1/sessions/${encodeURIComponent(id)}/suspend`);
    const status = optionalString(body, "status");
    if (status !== "suspended") throw new BackendError(`Scotty returned unexpected vaporize status: ${status ?? "missing"}`);
    return { id, status: "vaporized", url: sessionUrl(config.apiUrl, id) };
  }

  async resume(id: string): Promise<ResumeResult> {
    const config = await this.config();
    const body = await this.apiJson(config, "POST", `/v1/sessions/${encodeURIComponent(id)}/wake`);
    const status = optionalString(body, "status");
    if (status !== "waking" && status !== "running") {
      throw new BackendError(`Scotty returned unexpected resume status: ${status ?? "missing"}`);
    }
    return { id, status, url: sessionUrl(config.apiUrl, id) };
  }

  async list(all: boolean): Promise<ListResult> {
    const config = await this.config();
    const body = await this.apiJson(config, "GET", `/v1/sessions${all ? "?all=1" : ""}`);
    if (!Array.isArray(body.sessions)) throw new BackendError("Scotty returned an invalid session list");
    const sessions = body.sessions.map((value) => sessionSummary(value, config));
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return { sessions };
  }

  async status(id: string): Promise<StatusResult> {
    const config = await this.config();
    const body = await this.apiJson(config, "GET", `/v1/sessions/${encodeURIComponent(id)}`);
    const summary = sessionSummary(body.session, config);
    return {
      ...summary,
      heartbeatAt: nullableNumber(body.lastHeartbeat, "lastHeartbeat"),
      flushAt: nullableNumber(body.lastFlush, "lastFlush"),
      error: nullableString(asObject(body.session, "Scotty returned invalid session detail").error_reason, "error_reason"),
    };
  }

  private async runBeamJson(args: string[]): Promise<JsonObject> {
    const result = await this.deps.runBeam(args);
    if (result.stderr.length > 0) this.deps.onProgress(result.stderr);
    const parsed = parseJson(result.stdout);
    if (result.exitCode !== 0) {
      const message = parsed === null ? result.stderr.trim() || result.stdout.trim() : errorMessage(parsed);
      throw new BackendError(cleanEngineError(args, message) || `beam ${args[0] ?? "command"} failed`, result.exitCode);
    }
    if (parsed === null) throw new BackendError(`beam ${args[0] ?? "command"} returned invalid JSON`);
    return parsed;
  }

  private async sessionUrl(id: string): Promise<string> {
    return sessionUrl((await this.config()).apiUrl, id);
  }

  private async config(): Promise<Config> {
    const apiUrl = this.deps.env.SCOTTY_API_URL ?? this.deps.env.BEAM_API_URL;
    const token = this.deps.env.SCOTTY_TOKEN ?? this.deps.env.BEAM_TOKEN;
    const gatewayHost = this.deps.env.SCOTTY_GATEWAY_HOST ?? this.deps.env.BEAM_GATEWAY_HOST;
    if (apiUrl !== undefined && token !== undefined) {
      return normalizeConfig({ apiUrl, token, ...(gatewayHost === undefined ? {} : { gatewayHost }) });
    }
    if (this.deps.home.length === 0) throw new BackendError("HOME is unavailable and Scotty configuration cannot be located");

    const paths = [
      join(this.deps.home, ".config", "scotty", "config.json"),
      join(this.deps.home, ".config", "beam", "config.json"),
    ];
    let parsed: unknown;
    for (const path of paths) {
      try {
        parsed = JSON.parse(await this.deps.readText(path));
        break;
      } catch {
        // The Beam path is a compatibility fallback for existing installations.
      }
    }
    if (parsed === undefined) {
      throw new BackendError("Scotty is not configured; set SCOTTY_API_URL and SCOTTY_TOKEN or create ~/.config/scotty/config.json");
    }
    if (!isObject(parsed) || typeof parsed.apiUrl !== "string" || typeof parsed.token !== "string") {
      throw new BackendError("Scotty configuration is invalid; fix ~/.config/scotty/config.json");
    }
    const configuredGateway = typeof parsed.gateway_host === "string" ? parsed.gateway_host : undefined;
    const resolvedGateway = gatewayHost ?? configuredGateway;
    return normalizeConfig({
      apiUrl: apiUrl ?? parsed.apiUrl,
      token: token ?? parsed.token,
      ...(resolvedGateway === undefined ? {} : { gatewayHost: resolvedGateway }),
    });
  }

  private async apiJson(config: Config, method: string, path: string): Promise<JsonObject> {
    const response = await this.deps.fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "X-Request-Id": crypto.randomUUID(),
      },
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      throw new BackendError(parsed === null ? `${method} ${path} failed: ${response.status}` : errorMessage(parsed));
    }
    if (parsed === null) throw new BackendError(`${method} ${path} returned invalid JSON`);
    return parsed;
  }
}

function cleanEngineError(args: string[], message: string): string {
  if (args[0] === "push" && /requires remote\.origin\.url/u.test(message)) {
    return "Scotty can't upload this session because this repository has no origin. Add a reachable private Git remote as origin, then retry `scotty beam up`.";
  }
  return message;
}

function pushArgs(input: UpInput): string[] {
  const args = ["push"];
  if (input.session !== undefined) args.push(input.session);
  args.push("--json");
  if (input.cwd !== undefined) args.push("--cwd", input.cwd);
  if (input.force) args.push("--force");
  return args;
}

function newArgs(input: UpInput): string[] {
  const args = ["new", input.project as string, "--json"];
  for (const [flag, value] of [
    ["provider", input.provider],
    ["prompt", input.prompt],
    ["title", input.title],
    ["branch", input.branch],
  ] as const) {
    if (value !== undefined) args.push(`--${flag}`, value);
  }
  return args;
}

function defaultBeamRunner(env: Record<string, string | undefined>): (args: string[]) => Promise<EngineCommandResult> {
  return async (args) => {
    const child = Bun.spawn([env.SCOTTY_BEAM_BIN ?? "beam", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
}

function normalizeConfig(config: Config): Config {
  return {
    apiUrl: config.apiUrl.replace(/\/$/u, ""),
    token: config.token,
    ...(config.gatewayHost === undefined ? {} : { gatewayHost: config.gatewayHost }),
  };
}

function sessionUrl(apiUrl: string, id: string): string {
  return `${apiUrl.replace(/\/$/u, "")}/sessions/${encodeURIComponent(id)}`;
}

function parseJson(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(body: JsonObject): string {
  for (const key of ["error", "message", "hint"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "Scotty request failed";
}

function requiredString(body: JsonObject, key: string, message: string): string {
  const value = optionalString(body, key);
  if (value === undefined) throw new BackendError(message);
  return value;
}

function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new BackendError(message);
  return value;
}

function sessionSummary(value: unknown, config: Config): SessionSummary {
  const session = asObject(value, "Scotty returned invalid session data");
  const id = requiredString(session, "beam_id", "Scotty session is missing its id");
  return {
    id,
    url: sessionUrl(config.apiUrl, id),
    ...(config.gatewayHost === undefined ? {} : { ssh: sshCommand(id, config.gatewayHost) }),
    status: requiredString(session, "status", "Scotty session is missing its status"),
    provider: requiredString(session, "provider", "Scotty session is missing its provider"),
    project: requiredString(session, "project", "Scotty session is missing its project"),
    title: nullableString(session.title, "title"),
    updatedAt: requiredNumber(session.updated_at, "updated_at"),
    queuedPrompts: requiredNumber(session.queued_prompt_count, "queued_prompt_count"),
    deleted: session.deleted_at !== null && session.deleted_at !== undefined,
  };
}

function sshCommand(id: string, gatewayHost: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`ssh://${gatewayHost}`);
  } catch {
    throw new BackendError("Scotty gateway_host is invalid; expected hostname or hostname:port");
  }
  if (
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new BackendError("Scotty gateway_host is invalid; expected hostname or hostname:port");
  }
  const port = parsed.port.length === 0 ? null : Number(parsed.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new BackendError("Scotty gateway_host is invalid; expected hostname or hostname:port");
  }
  return port === null ? `ssh ${id}@${parsed.hostname}` : `ssh -p ${port} ${id}@${parsed.hostname}`;
}

function asObject(value: unknown, message: string): JsonObject {
  if (!isObject(value)) throw new BackendError(message);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BackendError(`Scotty returned invalid ${name}`);
  return value;
}

function nullableNumber(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : requiredNumber(value, name);
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BackendError(`Scotty returned invalid ${name}`);
  return value;
}
