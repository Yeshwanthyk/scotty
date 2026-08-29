import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSecretSet } from "../../cli/src/deployment-redaction.ts";
import { runCli } from "../support/harness.mjs";
import {
  assertPortAvailable,
  dockerContainers,
  formatLocalDevVars,
  removeLocalHarnessContainers,
  requireLocalInputs,
  ROOT,
  startWrangler,
  stopProcessGroup,
  waitForWorker,
} from "../support/local-worker.mjs";
import {
  credentialCanaryValues,
  findCredentialLeaks,
  formatCredentialToml,
  scrubAmbientCredentialEnvironment,
  withoutAmbientCredentialEnvironment,
} from "../support/credential-canary.mjs";

export { formatLocalDevVars, localHarnessContainerIds } from "../support/local-worker.mjs";

const DEFAULT_PORT = 8791;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const formatLocalCredentialToml = formatCredentialToml;

export function localLiveCanaryValues(inputs, source = process.env) {
  return buildSecretSet([
    ...credentialCanaryValues({ ...inputs, wrappingKey: inputs.credentialWrappingKey }),
    inputs.rootToken,
    ...[source.GH_TOKEN, source.PI_AUTH_JSON, source.CREDENTIAL_WRAPPING_KEY].filter(
      (value) => typeof value === "string" && value.length > 0,
    ),
  ]);
}

export function repositoryFromRemote(remote) {
  const match = remote
    .trim()
    .match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/u);
  if (!match?.[1]) throw new Error(`Origin is not a GitHub repository: ${remote}`);
  return match[1];
}

export function messageText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(messageText).join(" ");
  if (!value || typeof value !== "object") return "";
  return messageText(value.text ?? value.content ?? value.message ?? "");
}

const AUTH_FAILURE =
  /\b(?:401|unauthori[sz]ed|authentication failed|invalid[_ -](?:api[_ -])?(?:key|token)|not logged in)\b/iu;

export function promptAttempt(snapshot, marker) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const promptIndex = messages.findIndex(
    (message) => message?.role === "user" && messageText(message.content).includes(marker),
  );
  if (promptIndex < 0) return { status: "pending" };
  const assistant = messages
    .slice(promptIndex + 1)
    .find((message) => message?.role === "assistant");
  if (!assistant) return { status: "pending" };
  if (messageText(assistant.content).includes(marker)) return { status: "success" };
  const error = messageText(assistant.errorMessage ?? assistant.error ?? "");
  if (assistant.stopReason === "error" || error) {
    return { status: AUTH_FAILURE.test(error) ? "auth-failure" : "upstream-failure" };
  }
  return { status: "completed" };
}

export function snapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return { available: false };
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  return {
    available: true,
    sequence: snapshot.sequence,
    modelCount: Array.isArray(snapshot.capabilities?.models)
      ? snapshot.capabilities.models.length
      : 0,
    messageRoles: messages.map((message) => message?.role ?? message?.type ?? "unknown"),
    assistantStops: messages
      .filter((message) => message?.role === "assistant")
      .map((message) => message.stopReason ?? message.stop_reason ?? "unknown"),
    stateKeys:
      snapshot.state && typeof snapshot.state === "object"
        ? Object.keys(snapshot.state).sort()
        : [],
  };
}

function parseArguments(argv) {
  const options = {
    hold: true,
    open: true,
    port: DEFAULT_PORT,
    repo: undefined,
    requireResponse: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-hold") options.hold = false;
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--require-response") options.requireResponse = true;
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--repo") options.repo = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65_534)
    throw new Error("--port must be an integer from 1024 through 65534");
  if (options.repo !== undefined && !/^[^/\s]+\/[^/\s]+$/u.test(options.repo))
    throw new Error("--repo must be OWNER/NAME");
  if (!options.hold) options.open = false;
  return options;
}

async function requireJson(response, label, expectedStatuses = [200]) {
  const text = await response.text();
  if (!expectedStatuses.includes(response.status))
    throw new Error(`${label} returned HTTP ${response.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned unreadable JSON`);
  }
}

async function ownerCookie(host, rootToken) {
  const issued = await fetch(`${host}/api/auth/recovery-grants`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${rootToken}`,
      "idempotency-key": randomUUID(),
    },
  });
  const recovery = await requireJson(issued, "Owner recovery issue");
  const token = new URLSearchParams(new URL(recovery.url).hash.slice(1)).get("token");
  if (!token) throw new Error("Owner recovery response omitted its fragment token");
  const consumed = await fetch(`${host}/api/auth/recovery-grants/consume`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: host,
      "user-agent": "Scotty local live E2E",
    },
    body: JSON.stringify({ token }),
  });
  await requireJson(consumed, "Owner recovery consume");
  const cookie = consumed.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie?.startsWith("__Host-scotty="))
    throw new Error("Owner recovery did not return a Scotty browser cookie");
  return cookie;
}

async function fetchPiSnapshot(host, id, cookie) {
  const response = await fetch(`${host}/s/${encodeURIComponent(id)}/console/v1/snapshot`, {
    headers: { accept: "application/json", cookie },
  });
  if (response.status === 503) return undefined;
  return requireJson(response, "Pi snapshot");
}

async function waitForSnapshot(host, id, cookie, predicate, label, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetchPiSnapshot(host, id, cookie);
    if (last && predicate(last)) return last;
    await delay(1_000);
  }
  throw new Error(
    `${label} did not pass in ${timeoutMs / 60_000} minutes: ${JSON.stringify(snapshotSummary(last))}`,
  );
}

async function waitForPromptAttempt(host, id, cookie, marker, label) {
  const snapshot = await waitForSnapshot(
    host,
    id,
    cookie,
    (candidate) => promptAttempt(candidate, marker).status !== "pending",
    label,
  );
  const attempt = promptAttempt(snapshot, marker);
  if (attempt.status === "auth-failure")
    throw new Error(`${label} reached Pi but the provider rejected its credential`);
  return attempt;
}

async function issueBrowserPairing(host, cookie) {
  const response = await fetch(`${host}/api/auth/pairings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: host,
    },
    body: JSON.stringify({ label: "Local live E2E browser" }),
  });
  return requireJson(response, "Browser pairing issue");
}

function openBrowser(url) {
  try {
    execFileSync("open", [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  await assertPortAvailable(options.port);
  await assertPortAvailable(options.port + 1);
  if (!process.env.SCOTTY_PI_AUTH_FILE || !process.env.SCOTTY_GH_CONFIG_DIR)
    throw new Error(
      "Local live E2E requires SCOTTY_PI_AUTH_FILE and SCOTTY_GH_CONFIG_DIR for disposable credential sources",
    );
  const inputs = requireLocalInputs();
  const baselineContainerIds = new Set(dockerContainers().map(({ id }) => id));
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "scotty-local-live-"));
  const envFile = path.join(temporaryRoot, ".dev.vars");
  const persistPath = path.join(temporaryRoot, "wrangler-state");
  const cliHome = path.join(temporaryRoot, "home");
  mkdirSync(cliHome, { mode: 0o700 });
  writeFileSync(envFile, formatLocalDevVars(inputs), { mode: 0o600 });
  chmodSync(envFile, 0o600);

  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const repo = options.repo ?? repositoryFromRemote(remote);
  const host = `http://127.0.0.1:${options.port}`;
  const canaryValues = localLiveCanaryValues(inputs);
  const isolatedEnv = withoutAmbientCredentialEnvironment({
    ...process.env,
    HOME: cliHome,
    USERPROFILE: cliHome,
    XDG_CONFIG_HOME: path.join(cliHome, ".config"),
    XDG_STATE_HOME: path.join(cliHome, ".local", "state"),
    DOCKER_CONFIG: inputs.dockerConfig,
    DOCKER_HOST: inputs.dockerHost,
  });
  const wrangler = startWrangler({
    envFile,
    persistPath,
    port: options.port,
    env: isolatedEnv,
    secrets: canaryValues,
  });
  let cleaned = false;
  let holding = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopProcessGroup(wrangler.child);
    try {
      removeLocalHarnessContainers(baselineContainerIds);
    } catch {}
    rmSync(temporaryRoot, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    console.log("1/3 Starting isolated Wrangler Worker and Docker Sandbox…");
    await waitForWorker(host, wrangler);
    console.log("2/3 Creating a fresh session through the managed-credential path…");
    const freshMarker = `LOCAL_LIVE_READY_${randomBytes(4).toString("hex")}`;
    const cliEnv = {
      ...scrubAmbientCredentialEnvironment(),
      HOME: cliHome,
      SCOTTY_HOST: host,
      SCOTTY_TOKEN: inputs.rootToken,
      GH_CONFIG_DIR: inputs.githubConfigDir,
    };
    const tomlPath = path.join(cliHome, ".config", "scotty", "scotty.toml");
    mkdirSync(path.dirname(tomlPath), { recursive: true, mode: 0o700 });
    writeFileSync(tomlPath, formatLocalCredentialToml({ repo, piAuthPath: inputs.piAuthPath }), {
      mode: 0o600,
    });
    const synced = await runCli(["sync", "--json"], { env: cliEnv, timeoutMs: 5 * 60_000 });
    if (findCredentialLeaks(`${synced.stdout}\n${synced.stderr}`, canaryValues).length > 0)
      throw new Error("Credential Registry sync disclosed a canary value");
    if (synced.code !== 0) throw new Error(`Credential Registry sync failed:\n${synced.stderr}`);
    const up = await runCli(
      [
        "beam",
        `Reply with exactly ${freshMarker} and do nothing else.`,
        "--title",
        "Local managed-credential E2E",
        "--repo",
        repo,
        "--provider",
        "cloudflare",
        "--cap",
        "30m",
        "--detach",
        "--json",
      ],
      { env: cliEnv, timeoutMs: 5 * 60_000 },
    );
    if (findCredentialLeaks(`${up.stdout}\n${up.stderr}`, canaryValues).length > 0)
      throw new Error("Fresh session creation disclosed a canary value");
    if (up.code !== 0) throw new Error(`Fresh session creation failed:\n${up.stderr}`);
    const id = up.json?.id;
    if (typeof id !== "string") throw new Error("Fresh session response omitted its ID");
    const cookie = await ownerCookie(host, inputs.rootToken);
    await waitForSnapshot(
      host,
      id,
      cookie,
      (snapshot) => (snapshot.capabilities?.models?.length ?? 0) > 0,
      "Fresh Pi model availability",
    );
    const freshAttempt = await waitForPromptAttempt(
      host,
      id,
      cookie,
      freshMarker,
      "Fresh-start auth",
    );
    if (options.requireResponse && freshAttempt.status !== "success")
      throw new Error("Fresh-start Pi auth passed, but strict model response proof did not");
    console.log(
      `    PASS fresh-start auth (${id})${
        freshAttempt.status === "upstream-failure"
          ? " — provider request ran; upstream text generation was blocked"
          : ""
      }`,
    );

    if (
      wrangler.rawSecretDetected() ||
      findCredentialLeaks(wrangler.log.join(""), canaryValues).length > 0
    )
      throw new Error("Local Wrangler logs disclosed a canary value");
    console.log("3/3 Preparing browser access…");
    const pairing = await issueBrowserPairing(host, cookie);
    console.log("");
    console.log("LOCAL LIVE E2E PASSED");
    console.log(`Session: ${host}/s/${id}`);
    if (options.open && openBrowser(pairing.url))
      console.log("The pairing page is open. Finish pairing, then open the session.");
    else if (options.hold) console.log(`Open this one-time local pairing URL: ${pairing.url}`);
    else console.log("Browser pairing issuance passed; temporary access has been discarded.");
    if (options.hold) {
      holding = true;
      console.log("Wrangler is still running. Press Ctrl-C when you are done.");
      await new Promise(() => {});
    }
  } catch (error) {
    await delay(750);
    const message = error instanceof Error ? error.message : String(error);
    const logTail = wrangler.log.slice(-60).join("").trim();
    throw new Error(logTail ? `${message}\n\nLocal Wrangler log tail:\n${logTail}` : message);
  } finally {
    if (!holding) await cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
