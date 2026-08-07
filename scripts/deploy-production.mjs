import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseContainerControlPlaneSnapshot } from "./container-control-plane.mjs";
export const PRODUCTION_DEPLOY_STEPS = [
  {
    name: "Check repository",
    command: "npm",
    args: ["run", "check"],
  },
  {
    name: "Audit current runtime inventory",
    command: "npm",
    args: ["run", "audit:containers"],
    redact: true,
  },
  {
    name: "Prepare isolated Container context",
    command: process.execPath,
    args: ["scripts/prepare-container-context.mjs"],
  },
  {
    name: "Deploy production through Alchemy",
    command: "npx",
    args: ["--no-install", "alchemy", "deploy", "alchemy.run.ts", "--stage", "production", "--yes"],
    capture: true,
    tee: true,
    projectOutput: true,
    reportProgress: true,
    explainFailure: true,
    timeoutMs: 45 * 60 * 1_000,
  },
  {
    name: "Audit deployed runtime inventory",
    command: "npm",
    args: ["run", "audit:containers"],
    redact: true,
  },
];

const PRODUCTION_SANDBOX_CLASS_NAME = "ScottySandbox";
const PRODUCTION_AUTH_CLASS_NAME = "ScottyAuthRegistry";
const PRODUCTION_RUNNER_REGISTRY_CLASS_NAME = "ScottyRunnerRegistry";
const PRODUCTION_RUNNER_CLASS_NAME = "ScottyRunner";
const DEPLOY_LOCK_PATH = join(tmpdir(), "scotty-production-deploy.lock");
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const CONTAINER_ROLLOUT_TIMEOUT_MS = 10 * 60 * 1_000;
const CONTAINER_ROLLOUT_POLL_MS = 5_000;
export const CONTAINER_ROLLOUT_ABSENCE_QUIET_MS = 60_000;
const TERMINATION_GRACE_MS = 10_000;
const activeChildren = new Set();
const forcedTerminationTimers = new Map();
const signaledChildren = new WeakSet();
let interruptedSignal;

const ANSI_ESCAPE = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const CLOUDFLARE_ACCOUNT_ID = /\b[0-9a-f]{32}\b/giu;
const CLOUDFLARE_WORKER_URL = /https:\/\/[^\s'"`]+\.workers\.dev(?:\/[^\s'"`]*)?/giu;
const RESOURCE_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const FAILURE_OUTPUT_TAIL_CHARACTERS = 64 * 1_024;
const stripAnsi = (value) => value.replaceAll("\r", "\n").replaceAll(ANSI_ESCAPE, "");

export function redactProductionDeploymentOutput(value, environment = {}) {
  let redacted = String(value);
  const confirmation = environment.SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED ?? "";
  for (const field of confirmation.split(":")) {
    const separator = field.indexOf("=");
    if (separator === -1) continue;
    const key = field.slice(0, separator);
    const resourceName = field.slice(separator + 1);
    if (
      ![
        "worker",
        "runnerWorker",
        "container",
        "kv",
        "r2",
        "artifacts",
        "previewBase",
        "previewZone",
      ].includes(key) ||
      !resourceName
    ) {
      continue;
    }
    redacted = redacted.replaceAll(resourceName, `[redacted-${key}]`);
  }
  return redacted
    .replaceAll(CLOUDFLARE_WORKER_URL, "[redacted-worker-url]")
    .replaceAll(CLOUDFLARE_ACCOUNT_ID, "[redacted-account-id]")
    .replaceAll(RESOURCE_ID, "[redacted-resource-id]");
}

export function projectAlchemyDeploymentOutput(value) {
  const line = stripAnsi(String(value)).trim();
  const safe =
    /^Plan: \d+ to (?:create|update|delete|noop)(?:, \d+ to (?:create|update|delete|noop))*$/u.test(
      line,
    ) ||
    /^\[[A-Za-z][A-Za-z0-9/-]*\] (?:pending|create|creating|created|update|updating|updated|delete|deleting|deleted|noop|failed)$/u.test(
      line,
    ) ||
    /^Done: \d+ succeeded(?:, \d+ failed)?$/u.test(line);
  return safe ? `${line}\n` : "";
}

export function createProductionDeploymentProgressReporter(
  report = (message) => process.stdout.write(`${message}\n`),
) {
  const milestones = [
    {
      pattern: /\[SandboxContainer\] Building container image/u,
      message: "Deployment progress: building Container image.",
    },
    {
      pattern: /\[MonolithWorker\] Uploading worker/u,
      message: "Deployment progress: uploading Worker.",
    },
    {
      pattern: /\[SandboxContainer\] Pushing container image/u,
      message: "Deployment progress: uploading Container image.",
    },
    {
      pattern: /\[SandboxContainer\] Updating container application/u,
      message: "Deployment progress: applying Cloudflare update.",
    },
  ];
  const reported = new Set();
  let observed = "";
  return (chunk) => {
    observed = stripAnsi(`${observed}${chunk}`).slice(-16_384);
    for (const milestone of milestones) {
      if (!reported.has(milestone.message) && milestone.pattern.test(observed)) {
        reported.add(milestone.message);
        report(milestone.message);
      }
    }
  };
}

export function productionDeploymentFailureHint({ stdout = "", stderr = "" } = {}) {
  const output = stripAnsi(`${stdout}\n${stderr}`);
  if (!/(?:Segmentation fault(?: \(core dumped\))?|exit (?:code:? )?139)/iu.test(output)) {
    return "";
  }
  return (
    "The linux/amd64 Container build crashed under local emulation with exit 139. " +
    "Let this guard finish rollout settlement and the final audit. If production remains healthy, " +
    "rerun this same guarded command once. Never retry with direct Alchemy or Wrangler commands."
  );
}

function createBufferedOutputWriter(destination, transform) {
  let pending = "";
  const flushCompleteLines = () => {
    while (true) {
      const carriageReturn = pending.indexOf("\r");
      const newline = pending.indexOf("\n");
      const candidates = [carriageReturn, newline].filter((index) => index !== -1);
      if (candidates.length === 0) return;
      const end = Math.min(...candidates) + 1;
      destination.write(transform(pending.slice(0, end)));
      pending = pending.slice(end);
    }
  };
  return {
    push(chunk) {
      pending += chunk;
      flushCompleteLines();
    },
    flush() {
      if (pending) destination.write(transform(pending));
      pending = "";
    },
  };
}

export function readAlchemyContainerAction(output) {
  const actions = new Set(
    [...stripAnsi(output).matchAll(/^\[SandboxContainer\] (noop|updated)$/gmu)].map(
      (match) => match[1],
    ),
  );
  if (actions.size !== 1) {
    throw new Error("Alchemy did not report one terminal SandboxContainer action.");
  }
  return actions.values().next().value;
}

export function assertSettledContainerBaseline(snapshot) {
  const activeRollouts = snapshot.rollouts.filter((rollout) =>
    ["pending", "progressing"].includes(rollout.status),
  );
  if (snapshot.application.activeRolloutId !== null || activeRollouts.length > 0) {
    throw new Error("Production Container application already has an active rollout.");
  }
}

export function assessContainerSettlement(before, current, containerAction, { quietMs = 0 } = {}) {
  if (
    current.application.id !== before.application.id ||
    current.application.name !== before.application.name
  ) {
    return {
      status: "failed",
      message: "Production Container application identity changed during deployment.",
    };
  }
  if (current.application.version < before.application.version) {
    return {
      status: "failed",
      message: `Production Container application version regressed from ${before.application.version} to ${current.application.version}.`,
    };
  }

  const previousRolloutIds = new Set(before.rollouts.map((rollout) => rollout.id));
  const newRollouts = current.rollouts.filter((rollout) => !previousRolloutIds.has(rollout.id));
  if (newRollouts.length > 1) {
    return {
      status: "failed",
      message: `Expected at most one new Container rollout; found ${newRollouts.length}.`,
    };
  }
  const rollout = newRollouts[0];
  if (rollout) {
    if (containerAction === "noop") {
      return {
        status: "failed",
        message: "Alchemy reported a Container no-op but an unexpected rollout appeared.",
      };
    }
    if (["pending", "progressing"].includes(rollout.status)) {
      return {
        status: "waiting",
        message: `Container rollout is ${rollout.status}.`,
      };
    }
    if (rollout.status !== "completed") {
      return {
        status: "failed",
        message: `Container rollout finished as ${rollout.status}.`,
      };
    }
    const health = current.application.health;
    const rolloutHealth = rollout.health;
    // Cloudflare reports running session instances as application `active`, outside both
    // `healthy` buckets. They are converged only when the rollout also updated every instance.
    const applicationReadyInstances = health.active + health.healthy;
    const rolloutReadyInstances = health.active + rolloutHealth.healthy;
    const rolloutComplete =
      rollout.currentVersion === before.application.version &&
      rollout.targetVersion > rollout.currentVersion &&
      current.application.version === rollout.targetVersion &&
      current.application.activeRolloutId === null &&
      rollout.progress.totalInstances > 0 &&
      rollout.progress.updatedInstances === rollout.progress.totalInstances &&
      rolloutReadyInstances === rollout.progress.totalInstances &&
      rolloutHealth.failed === 0 &&
      rolloutHealth.scheduling === 0 &&
      rolloutHealth.starting === 0 &&
      applicationReadyInstances === rollout.progress.totalInstances &&
      health.assigned === 0 &&
      health.stopped === 0 &&
      health.failed === 0 &&
      health.scheduling === 0 &&
      health.starting === 0;
    if (!rolloutComplete) {
      return {
        status: "waiting",
        message:
          "Container rollout is completed but its target version or health has not converged.",
      };
    }
    return {
      status: "settled",
      outcome: "rollout",
      message: `Container rollout completed at version ${rollout.targetVersion}.`,
    };
  }

  const applicationChanged =
    current.application.configurationDigest !== before.application.configurationDigest ||
    current.application.version !== before.application.version ||
    current.application.activeRolloutId !== before.application.activeRolloutId;
  if (containerAction === "unknown") {
    if (current.application.activeRolloutId !== null) {
      return {
        status: "waiting",
        message: "Container application has an active rollout that is still propagating.",
      };
    }
    if (quietMs < CONTAINER_ROLLOUT_ABSENCE_QUIET_MS) {
      return {
        status: "waiting",
        message: "Proving that the failed Alchemy deployment created no Container rollout.",
      };
    }
    return {
      status: "settled",
      outcome: applicationChanged ? "failed-deploy-application-only" : "failed-deploy-no-rollout",
      message: applicationChanged
        ? "The failed Alchemy deployment changed Container application state but created no rollout."
        : "The failed Alchemy deployment created no Container rollout.",
    };
  }
  if (applicationChanged) {
    return {
      status: "waiting",
      message: "Container application changed while the rollout resource is still propagating.",
    };
  }
  if (containerAction === "noop") {
    return {
      status: "settled",
      outcome: "noop",
      message: `Alchemy reported a Container no-op at version ${current.application.version}.`,
    };
  }
  if (
    containerAction === "updated" &&
    current.application.updatedAt !== before.application.updatedAt
  ) {
    if (quietMs < CONTAINER_ROLLOUT_ABSENCE_QUIET_MS) {
      return {
        status: "waiting",
        message: "Proving that the Container application update created no rollout.",
      };
    }
    return {
      status: "settled",
      outcome: "application-only",
      message: `Container application metadata updated without a rollout at version ${current.application.version}.`,
    };
  }
  return {
    status: "waiting",
    message: "Waiting for the Container application update or rollout resource to appear.",
  };
}

function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError?.code !== "ESRCH") {
        process.stderr.write(
          `Could not send ${signal} to subprocess ${String(child.pid)}: ${fallbackError.message}\n`,
        );
      }
    }
  }
}

function scheduleForcedTermination(child) {
  if (forcedTerminationTimers.has(child)) return;
  const timer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
  forcedTerminationTimers.set(child, timer);
}

export function runCommand(
  command,
  args,
  {
    env = process.env,
    capture = false,
    tee = false,
    allowAfterSignal = false,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    sanitizeOutput,
    onStdout,
    failureHint,
  } = {},
) {
  if (interruptedSignal && !allowAfterSignal) {
    return Promise.reject(
      new Error(`Production deployment was interrupted by ${interruptedSignal}.`),
    );
  }

  return new Promise((resolve, reject) => {
    const pipeStdout = capture || tee || Boolean(sanitizeOutput) || Boolean(onStdout);
    const pipeStderr = Boolean(sanitizeOutput) || Boolean(failureHint);
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", pipeStdout ? "pipe" : "inherit", pipeStderr ? "pipe" : "inherit"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const transformOutput = sanitizeOutput ?? ((value) => value);
    const stdoutWriter = pipeStdout
      ? createBufferedOutputWriter(process.stdout, transformOutput)
      : undefined;
    const stderrWriter = pipeStderr
      ? createBufferedOutputWriter(process.stderr, transformOutput)
      : undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signaledChildren.add(child);
      terminateProcessTree(child, "SIGTERM");
      scheduleForcedTermination(child);
    }, timeoutMs);
    if (pipeStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (capture || failureHint) stdout += chunk;
        onStdout?.(chunk);
        if (tee || sanitizeOutput) stdoutWriter.push(chunk);
      });
    }
    if (pipeStderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-FAILURE_OUTPUT_TAIL_CHARACTERS);
        stderrWriter.push(chunk);
      });
    }
    const flushOutput = () => {
      stdoutWriter?.flush();
      stderrWriter?.flush();
    };
    const cleanup = () => {
      activeChildren.delete(child);
      clearTimeout(timeoutTimer);
      const forcedTerminationTimer = forcedTerminationTimers.get(child);
      if (forcedTerminationTimer) {
        clearTimeout(forcedTerminationTimer);
        forcedTerminationTimers.delete(child);
      }
    };
    child.on("error", (error) => {
      flushOutput();
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      flushOutput();
      const wasSignaled = signaledChildren.has(child);
      if (wasSignaled) {
        terminateProcessTree(child, "SIGKILL");
      }
      cleanup();
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out after ${Math.ceil(timeoutMs / 60_000)} minutes.`,
          ),
        );
        return;
      }
      if (wasSignaled) {
        reject(
          new Error(
            `${command} ${args.join(" ")} was interrupted by ${interruptedSignal ?? "termination"}.`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const result = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      const hint = failureHint?.({ stdout, stderr, code, signal });
      reject(
        new Error(`${command} ${args.join(" ")} failed with ${result}.${hint ? ` ${hint}` : ""}`),
      );
    });
  });
}

async function readProductionContainerControlPlane(env, { allowAfterSignal = false } = {}) {
  const applicationsOutput = await runCommand(
    "npx",
    ["--no-install", "wrangler", "containers", "list", "--json"],
    { env, capture: true, allowAfterSignal, timeoutMs: 60_000 },
  );
  const applications = JSON.parse(applicationsOutput);
  const application = Array.isArray(applications)
    ? applications.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          candidate.name === env.SCOTTY_CONTAINER_APPLICATION_NAME,
      )
    : undefined;
  if (!application?.id) {
    throw new Error(
      `Container application ${env.SCOTTY_CONTAINER_APPLICATION_NAME ?? "(unset)"} was not found.`,
    );
  }
  const output = await runCommand(
    process.execPath,
    ["scripts/container-control-plane.mjs", String(application.id)],
    {
      env,
      capture: true,
      allowAfterSignal,
      timeoutMs: 60_000,
    },
  );
  return parseContainerControlPlaneSnapshot(output);
}

export async function waitForProductionContainerRollout(
  before,
  env,
  {
    containerAction,
    readControlPlane = readProductionContainerControlPlane,
    sleep = delay,
    now = Date.now,
    timeoutMs = CONTAINER_ROLLOUT_TIMEOUT_MS,
    pollMs = CONTAINER_ROLLOUT_POLL_MS,
  } = {},
) {
  const startedAt = now();
  let lastObservation =
    `${before.application.version}:${before.application.updatedAt}:` +
    `${before.application.activeRolloutId}:${before.application.configurationDigest}:` +
    `${JSON.stringify(before.application.health)}`;
  let lastObservationAt = startedAt;
  let lastReportedProgress;
  while (true) {
    if (interruptedSignal) {
      throw new Error(`Container rollout watch was interrupted by ${interruptedSignal}.`);
    }
    const current = await readControlPlane(env, { allowAfterSignal: true });
    const observedAt = now();
    const elapsedMs = observedAt - startedAt;
    const newRollout = current.rollouts.find(
      (rollout) => !before.rollouts.some((previous) => previous.id === rollout.id),
    );
    const observation = newRollout
      ? `${newRollout.id}:${newRollout.status}:${newRollout.lastUpdatedAt}:` +
        `${newRollout.targetVersion}:${newRollout.progress.updatedInstances}:` +
        `${JSON.stringify(newRollout.health)}:${JSON.stringify(current.application.health)}`
      : `${current.application.version}:${current.application.updatedAt}:` +
        `${current.application.activeRolloutId}:${current.application.configurationDigest}:` +
        `${JSON.stringify(current.application.health)}`;
    if (observation !== lastObservation) {
      lastObservation = observation;
      lastObservationAt = observedAt;
    }
    const assessment = assessContainerSettlement(before, current, containerAction, {
      quietMs: observedAt - lastObservationAt,
    });
    if (observation !== lastReportedProgress) {
      process.stdout.write(`Container settlement: ${assessment.message}\n`);
      lastReportedProgress = observation;
    }
    if (assessment.status === "settled") {
      process.stdout.write(`${assessment.message}\n`);
      return current;
    }
    if (assessment.status === "failed") {
      throw new Error(assessment.message);
    }
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Container rollout did not settle within ${Math.ceil(timeoutMs / 60_000)} minutes: ${assessment.message}`,
      );
    }
    await sleep(Math.min(pollMs, timeoutMs - elapsedMs));
  }
}

function installTerminationHandlers() {
  interruptedSignal = undefined;
  const handleSignal = (signal) => {
    interruptedSignal ??= signal;
    for (const child of activeChildren) {
      signaledChildren.add(child);
      terminateProcessTree(child, signal);
      scheduleForcedTermination(child);
    }
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

async function assertLocalReleaseState(expectedHead) {
  if (process.env.CI) {
    throw new Error("Production deployment is local-only and refuses to run in CI.");
  }

  const branch = await runCommand("git", ["branch", "--show-current"], { capture: true });
  if (branch !== "main") {
    throw new Error(`Production deployment requires branch main; current branch is ${branch}.`);
  }

  const status = await runCommand("git", ["status", "--porcelain=v1"], { capture: true });
  if (status) {
    throw new Error("Production deployment requires a clean worktree.");
  }

  await runCommand("git", ["fetch", "--quiet", "origin", "main"]);
  const [localHead, remoteHead] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], { capture: true }),
    runCommand("git", ["rev-parse", "origin/main"], { capture: true }),
  ]);
  if (localHead !== remoteHead) {
    throw new Error(
      `Production deployment requires main to match origin/main exactly (${localHead} != ${remoteHead}).`,
    );
  }
  if (expectedHead && localHead !== expectedHead) {
    throw new Error(
      `Production HEAD changed after verification (${expectedHead} != ${localHead}); rerun the deployment.`,
    );
  }
  return localHead;
}

async function describeExistingLock() {
  try {
    const owner = JSON.parse(await readFile(join(DEPLOY_LOCK_PATH, "owner.json"), "utf8"));
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return "Its owner metadata is invalid.";
    try {
      process.kill(pid, 0);
      return `It belongs to live PID ${pid}.`;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return `It may be stale from dead PID ${pid}; inspect and remove only ${DEPLOY_LOCK_PATH}.`;
      }
      return `Its PID ${pid} could not be inspected.`;
    }
  } catch {
    return "Its owner metadata is missing or unreadable.";
  }
}

async function acquireDeployLock() {
  try {
    await mkdir(DEPLOY_LOCK_PATH);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const detail = await describeExistingLock();
      throw new Error(`Another production deployment owns ${DEPLOY_LOCK_PATH}. ${detail}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await writeFile(
      join(DEPLOY_LOCK_PATH, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    await rm(DEPLOY_LOCK_PATH, { recursive: true, force: true });
    throw error;
  }
}

function sanitizedLocalEnvironment(environment = process.env) {
  const localEnvironment = { ...environment };
  for (const key of Object.keys(localEnvironment)) {
    if (
      key.startsWith("CLOUDFLARE_") ||
      key.startsWith("SCOTTY_") ||
      [
        "PI_AUTH_JSON",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "OPENAI_API_KEY",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
      ].includes(key)
    ) {
      delete localEnvironment[key];
    }
  }
  return localEnvironment;
}

export function resolveProductionTopology(environment = process.env) {
  const installationName = environment.SCOTTY_INSTALLATION_NAME?.trim();
  if (!installationName || !/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u.test(installationName)) {
    throw new Error(
      "Set SCOTTY_INSTALLATION_NAME to a 2-32 character lowercase installation name.",
    );
  }
  const prefix = `scotty-${installationName}`;
  const adoptionPath = environment.SCOTTY_ADOPTION_MANIFEST?.trim();
  const adoption = adoptionPath ? JSON.parse(readFileSync(adoptionPath, "utf8")) : undefined;
  if (adoption && adoption.installationName !== installationName) {
    throw new Error("SCOTTY_ADOPTION_MANIFEST names a different installation.");
  }
  const environmentPreviewBase = environment.SCOTTY_PREVIEW_BASE?.trim();
  const environmentPreviewZoneId = environment.SCOTTY_PREVIEW_ZONE_ID?.trim();
  const hasEnvironmentPreview =
    environmentPreviewBase !== undefined || environmentPreviewZoneId !== undefined;
  const previewBase = hasEnvironmentPreview ? environmentPreviewBase : adoption?.preview?.base;
  const previewZoneId = hasEnvironmentPreview
    ? environmentPreviewZoneId
    : adoption?.preview?.zoneId;
  const evidenceEnabled = environment.SCOTTY_EVIDENCE_ENABLED === "true";
  if (
    (previewBase === undefined) !== (previewZoneId === undefined) ||
    (previewBase !== undefined &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
        previewBase,
      )) ||
    (previewZoneId !== undefined && !/^[0-9a-f]{32}$/u.test(previewZoneId))
  ) {
    throw new Error(
      "SCOTTY_PREVIEW_BASE and SCOTTY_PREVIEW_ZONE_ID must both name the explicit preview topology.",
    );
  }
  if (evidenceEnabled && previewBase === undefined) {
    throw new Error("SCOTTY_EVIDENCE_ENABLED requires the explicit preview topology.");
  }
  return {
    installationName,
    adoptionPath,
    workerName: adoption?.resources?.workerName ?? `${prefix}-worker`,
    runnerWorkerName: adoption?.resources?.runnerWorkerName ?? `${prefix}-runner`,
    containerName: adoption?.resources?.containerName ?? `${prefix}-sandbox`,
    kvTitle: adoption?.resources?.kvTitle ?? `${prefix}-sessions`,
    backupBucketName: adoption?.resources?.backupBucketName ?? `${prefix}-backups`,
    artifactBucketName: adoption?.resources?.artifactBucketName ?? `${prefix}-artifacts`,
    ...(previewBase === undefined ? {} : { previewBase, previewZoneId }),
    ...(evidenceEnabled ? { evidenceEnabled: true } : {}),
  };
}

function productionEnvironment(environment = process.env) {
  const topology = resolveProductionTopology(environment);
  const resourceConfirmation = [
    "confirmed",
    topology.installationName,
    `worker=${topology.workerName}`,
    `runnerWorker=${topology.runnerWorkerName}`,
    `durableObjects=${PRODUCTION_SANDBOX_CLASS_NAME},${PRODUCTION_AUTH_CLASS_NAME},${PRODUCTION_RUNNER_REGISTRY_CLASS_NAME},${PRODUCTION_RUNNER_CLASS_NAME}`,
    `container=${topology.containerName}`,
    `kv=${topology.kvTitle}`,
    `r2=${topology.backupBucketName}`,
    `artifacts=${topology.artifactBucketName}`,
    ...(topology.previewBase === undefined
      ? []
      : [`previewBase=${topology.previewBase}`, `previewZone=${topology.previewZoneId}`]),
    ...(topology.evidenceEnabled === true ? ["evidence=enabled"] : []),
  ].join(":");
  return {
    ...sanitizedLocalEnvironment(environment),
    ALCHEMY_TELEMETRY_DISABLED: "1",
    SCOTTY_INSTALLATION_NAME: topology.installationName,
    ...(topology.adoptionPath ? { SCOTTY_ADOPTION_MANIFEST: topology.adoptionPath } : {}),
    ...(topology.previewBase === undefined
      ? {}
      : {
          SCOTTY_PREVIEW_BASE: topology.previewBase,
          SCOTTY_PREVIEW_ZONE_ID: topology.previewZoneId,
        }),
    ...(topology.evidenceEnabled === true ? { SCOTTY_EVIDENCE_ENABLED: "true" } : {}),
    SCOTTY_CONTAINER_APPLICATION_NAME: topology.containerName,
    SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED: resourceConfirmation,
    SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL: `deploy:${topology.installationName}:${topology.workerName}`,
  };
}

async function runStep(step, env = process.env, options = {}) {
  process.stdout.write(`\n==> ${step.name}\n`);
  return runCommand(step.command, step.args, {
    env,
    capture: step.capture,
    tee: step.tee,
    timeoutMs: step.timeoutMs,
    sanitizeOutput: step.projectOutput
      ? projectAlchemyDeploymentOutput
      : step.redact
        ? (value) => redactProductionDeploymentOutput(value, env)
        : undefined,
    onStdout: step.reportProgress ? createProductionDeploymentProgressReporter() : undefined,
    failureHint: step.explainFailure ? productionDeploymentFailureHint : undefined,
    ...options,
  });
}

export async function executeProductionDeploySteps(
  execute = runStep,
  revalidate = assertLocalReleaseState,
  {
    readControlPlane = readProductionContainerControlPlane,
    waitForRollout = waitForProductionContainerRollout,
    environment = process.env,
  } = {},
) {
  const verificationEnv = sanitizedLocalEnvironment(environment);
  const productionEnv = productionEnvironment(environment);
  await execute(PRODUCTION_DEPLOY_STEPS[0], verificationEnv);
  await execute(PRODUCTION_DEPLOY_STEPS[1], productionEnv);
  await execute(PRODUCTION_DEPLOY_STEPS[2], verificationEnv);
  await revalidate();
  const controlPlaneBeforeDeploy = await readControlPlane(productionEnv);
  assertSettledContainerBaseline(controlPlaneBeforeDeploy);

  let deployError;
  let containerAction = "unknown";
  try {
    const deployOutput = await execute(PRODUCTION_DEPLOY_STEPS[3], productionEnv);
    containerAction = readAlchemyContainerAction(deployOutput);
  } catch (error) {
    deployError = error;
  }

  let rolloutError;
  try {
    process.stdout.write("\n==> Wait for Container rollout to settle\n");
    await waitForRollout(controlPlaneBeforeDeploy, productionEnv, { containerAction });
  } catch (error) {
    rolloutError = error;
  }

  let auditError;
  try {
    await execute(PRODUCTION_DEPLOY_STEPS[4], productionEnv, { allowAfterSignal: true });
  } catch (error) {
    auditError = error;
  }

  const errors = [deployError, rolloutError, auditError].filter(Boolean);
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Production deploy, Container rollout settlement, or post-deploy audit had multiple failures.",
    );
  }
  if (errors.length === 1) throw errors[0];
}

export async function deployProduction() {
  const removeTerminationHandlers = installTerminationHandlers();
  let lockAcquired = false;
  try {
    await acquireDeployLock();
    lockAcquired = true;
    const verifiedHead = await assertLocalReleaseState();
    await executeProductionDeploySteps(runStep, () => assertLocalReleaseState(verifiedHead));
  } finally {
    try {
      if (lockAcquired) {
        await rm(DEPLOY_LOCK_PATH, { recursive: true, force: true });
      }
    } finally {
      removeTerminationHandlers();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployProduction().catch((error) => {
    process.stderr.write(`Production deployment failed: ${error.message}\n`);
    if (error instanceof AggregateError) {
      for (const cause of error.errors) {
        process.stderr.write(`- ${cause.message}\n`);
      }
    }
    process.exitCode = 1;
  });
}
