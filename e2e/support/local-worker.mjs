import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { buildSecretSet, redactWithSecretSet } from "../../cli/src/deployment-redaction.ts";
import { scrubAmbientCredentialEnvironment } from "./credential-canary.mjs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60_000;
const LAB_SYSTEM_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "NO_COLOR",
  "FORCE_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "ComSpec",
];
const PROCESS_GROUP_GRACE_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 100;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function resolveDockerHost(source = process.env) {
  if (source.DOCKER_HOST?.trim()) return source.DOCKER_HOST.trim();
  const context = execFileSync("docker", ["context", "show"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: source,
  }).trim();
  const host = execFileSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", context],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: source },
  ).trim();
  if (!host) throw new Error("The active Docker context has no endpoint");
  return host;
}

function requireExecutable(command, arguments_) {
  try {
    execFileSync(command, arguments_, { stdio: "ignore" });
  } catch {
    throw new Error(`Local Scotty requires a working ${command} command`);
  }
}

export function formatLocalDevVars({
  rootToken,
  credentialWrappingKey,
  installationName = "local",
}) {
  const wrappingKey = credentialWrappingKey ?? randomBytes(32).toString("base64url");
  return [
    `SCOTTY_TOKEN=${JSON.stringify(rootToken)}`,
    `CREDENTIAL_WRAPPING_KEY=${JSON.stringify(wrappingKey)}`,
    `SCOTTY_INSTALLATION_NAME=${JSON.stringify(installationName)}`,
    'SANDBOX_TRANSPORT="http"',
    'SCOTTY_LOCAL_E2E="1"',
    "",
  ].join("\n");
}
export function labSystemEnvironment(home, explicit = {}, source = process.env) {
  const environment = Object.fromEntries(
    LAB_SYSTEM_ENVIRONMENT_KEYS.flatMap((key) =>
      typeof source[key] === "string" ? [[key, source[key]]] : [],
    ),
  );
  const labValues = {};
  if (typeof explicit.SCOTTY_HOST === "string") labValues.SCOTTY_HOST = explicit.SCOTTY_HOST;
  if (typeof explicit.SCOTTY_TOKEN === "string") labValues.SCOTTY_TOKEN = explicit.SCOTTY_TOKEN;
  if (typeof explicit.DOCKER_HOST === "string") labValues.DOCKER_HOST = explicit.DOCKER_HOST;
  if (typeof explicit.DOCKER_CONFIG === "string") labValues.DOCKER_CONFIG = explicit.DOCKER_CONFIG;
  if (typeof explicit.PATH === "string") labValues.PATH = explicit.PATH;
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    ...labValues,
  };
}

export function requireLocalInputs(home = homedir(), source = process.env) {
  const sanitizedSource = scrubAmbientCredentialEnvironment(source);
  requireExecutable("docker", ["info"]);
  requireExecutable("gh", ["--version"]);
  requireExecutable("bun", ["--version"]);

  const piAuthPath =
    source.SCOTTY_PI_AUTH_FILE?.trim() || path.join(home, ".pi", "agent", "auth.json");
  if (!existsSync(piAuthPath))
    throw new Error(`Pi auth is missing at ${piAuthPath}; sign in with Pi first`);
  const mode = statSync(piAuthPath).mode & 0o777;
  if (mode !== 0o600)
    throw new Error(`Pi auth must be mode 0600, received ${mode.toString(8).padStart(3, "0")}`);
  const piAuthJson = readFileSync(piAuthPath, "utf8");
  const githubConfigDir =
    source.SCOTTY_GH_CONFIG_DIR?.trim() ||
    source.GH_CONFIG_DIR?.trim() ||
    path.join(home, ".config", "gh");
  const githubToken = execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...sanitizedSource,
      GH_CONFIG_DIR: githubConfigDir,
    },
  }).trim();
  if (githubToken.length < 8) throw new Error("GitHub returned an invalid auth token");

  return {
    dockerConfig: source.DOCKER_CONFIG?.trim() || path.join(home, ".docker"),
    dockerHost: resolveDockerHost(sanitizedSource),
    rootToken: randomBytes(32).toString("hex"),
    credentialWrappingKey: randomBytes(32).toString("base64url"),
    piAuthPath,
    piAuthJson,
    githubConfigDir,
    githubToken,
  };
}

export async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

export function redact(text, secrets = []) {
  return redactWithSecretSet(text, buildSecretSet(secrets), "[redacted]");
}

export function dockerContainers() {
  const output = execFileSync(
    "docker",
    ["ps", "-a", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"],
    { encoding: "utf8" },
  );
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", image = "", name = ""] = line.split("\t");
      return { id, image, name };
    });
}

export function localHarnessContainerIds(containers, baselineIds) {
  return containers
    .filter(
      ({ id, image, name }) =>
        !baselineIds.has(id) &&
        name.startsWith("workerd-scotty-worker-ScottySandbox-") &&
        (image.startsWith("cloudflare-dev/scottysandbox:") ||
          image.startsWith("cloudflare/proxy-everything:")),
    )
    .map(({ id }) => id);
}
function isLocalHarnessImage(image) {
  return (
    image.startsWith("cloudflare-dev/scottysandbox:") ||
    image.startsWith("cloudflare/proxy-everything:")
  );
}

export function localHarnessContainerIdsForWorker(containers, workerName) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(workerName)) throw new Error("Wrangler worker name is invalid");
  const prefix = `workerd-${workerName}-ScottySandbox-`;
  return containers
    .filter(({ image, name }) => name.startsWith(prefix) && isLocalHarnessImage(image))
    .map(({ id }) => id);
}

export function removeLocalHarnessContainers(baselineIds) {
  const ids = localHarnessContainerIds(dockerContainers(), baselineIds);
  if (ids.length === 0) return [];
  execFileSync("docker", ["rm", "--force", ...ids], { stdio: "ignore" });
  return ids;
}
export function removeLocalHarnessContainersForWorker(workerName) {
  const ids = localHarnessContainerIdsForWorker(dockerContainers(), workerName);
  if (ids.length === 0) return [];
  execFileSync("docker", ["rm", "--force", ...ids], { stdio: "ignore" });
  return ids;
}

export function wranglerInvocation({ envFile, persistPath, port, name }) {
  const command = path.join(ROOT, "node_modules/.bin/wrangler");
  if (!existsSync(command)) throw new Error("Run npm install before starting local Scotty");
  if (name !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(name))
    throw new Error("Wrangler worker name is invalid");
  return {
    command,
    args: [
      "dev",
      "--config",
      "worker/wrangler.jsonc",
      ...(name === undefined ? [] : ["--name", name]),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1),
      "--persist-to",
      persistPath,
      "--env-file",
      envFile,
      "--log-level",
      "info",
    ],
  };
}

export function spawnWrangler({
  envFile,
  persistPath,
  port,
  name,
  env = process.env,
  stdio,
  detached = true,
}) {
  const invocation = wranglerInvocation({ envFile, persistPath, port, name });
  const child = spawn(invocation.command, invocation.args, {
    cwd: ROOT,
    detached,
    env,
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
  });
  return { child, invocation };
}

export function startWrangler({
  envFile,
  persistPath,
  port,
  name,
  secrets = [],
  env = process.env,
  logFile,
  spawnWranglerImpl = spawnWrangler,
}) {
  const log = [];
  const redactionSecrets = buildSecretSet(secrets);
  const maxSecretLength = redactionSecrets[0]?.length ?? 0;
  let pending = "";
  let rawTail = "";
  let rawSecretDetected = false;
  if (logFile) {
    writeFileSync(logFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(logFile, 0o600);
  }
  const rememberSafe = (text) => {
    if (!text) return;
    if (logFile) appendFileSync(logFile, text, { encoding: "utf8" });
    log.push(text);
    if (log.length > 200) log.shift();
  };
  const inspectRaw = (raw) => {
    if (rawSecretDetected || maxSecretLength === 0) return;
    const combined = rawTail + raw;
    if (redactionSecrets.some((secret) => combined.includes(secret))) {
      rawSecretDetected = true;
      rawTail = "";
      return;
    }
    const keep = maxSecretLength - 1;
    rawTail = keep > 0 ? combined.slice(-keep) : "";
  };
  const remember = (chunk) => {
    const raw = chunk.toString();
    inspectRaw(raw);
    const combined = pending + raw;
    const redacted = redactWithSecretSet(combined, redactionSecrets);
    if (maxSecretLength === 0) {
      pending = "";
      rememberSafe(redacted);
      return;
    }
    const keep = Math.min(maxSecretLength - 1, redacted.length);
    rememberSafe(redacted.slice(0, redacted.length - keep));
    pending = redacted.slice(redacted.length - keep);
  };
  const flushLog = () => {
    if (pending) rememberSafe(redactWithSecretSet(pending, redactionSecrets));
    pending = "";
  };
  const finishLog = () => {
    flushLog();
    rawTail = "";
  };
  const { child, invocation } = spawnWranglerImpl({ envFile, persistPath, port, name, env });
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  child.once("close", finishLog);
  child.once("error", finishLog);
  return { child, invocation, log, flushLog, rawSecretDetected: () => rawSecretDetected };
}

export function readStartupLogTail(started) {
  started?.flushLog?.();
  return (started?.log ?? []).slice(-40).join("").trim();
}

export function processGroupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(isAlive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive()) {
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_GROUP_POLL_MS);
  }
  return true;
}

export async function terminateProcessGroup(pid, isAlive = () => processGroupAlive(pid)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Process group ID is invalid");
  if (!isAlive()) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  if (await waitForProcessGroupExit(isAlive, PROCESS_GROUP_GRACE_MS)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  if (!(await waitForProcessGroupExit(isAlive, PROCESS_GROUP_GRACE_MS)))
    throw new Error(`Process group ${pid} did not exit after SIGKILL`);
}

export async function stopProcessGroup(child) {
  if (!child.pid) return;
  await terminateProcessGroup(child.pid);
}

export async function waitForWorker(
  host,
  wrangler,
  { timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, signal, fetchImpl = fetch } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "Worker has not responded";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    if (wrangler.child.exitCode !== null) {
      wrangler.flushLog?.();
      throw new Error(
        `Wrangler exited with ${wrangler.child.exitCode}\n${(wrangler.log ?? []).slice(-40).join("")}`,
      );
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const timeoutSignal = AbortSignal.timeout(Math.min(1_000, remainingMs));
      const response = await fetchImpl(`${host}/health`, {
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      if (response.ok) return;
      lastFailure = `GET /health returned ${response.status}`;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
  }
  wrangler.flushLog?.();
  throw new Error(
    `Wrangler did not become ready in ${timeoutMs / 60_000} minutes: ${lastFailure}\n${(
      wrangler.log ?? []
    )
      .slice(-40)
      .join("")}`,
  );
}
