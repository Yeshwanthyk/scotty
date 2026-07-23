import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseContainerControlPlaneSnapshot } from "./container-control-plane.mjs";
import { PRODUCTION_CONTAINER_APPLICATION_ID } from "./reconcile-containers.mjs";

export const PRODUCTION_CLOUDFLARE_ACCOUNT_ID = "9953c9d9989f69068510072b215beab9";
export const PRODUCTION_SCOTTY_HOST = "https://scotty-worker.yeshwanth-yk.workers.dev";
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
  },
  {
    name: "Deploy production through Alchemy",
    command: "npx",
    args: ["--no-install", "alchemy", "deploy", "alchemy.run.ts", "--stage", "production", "--yes"],
    capture: true,
    tee: true,
    timeoutMs: 45 * 60 * 1_000,
  },
  {
    name: "Audit deployed runtime inventory",
    command: "npm",
    args: ["run", "audit:containers"],
  },
];

const PRODUCTION_WORKER_NAME = "scotty-worker";
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
const stripAnsi = (value) => value.replaceAll("\r", "\n").replaceAll(ANSI_ESCAPE, "");

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
        message: `Alchemy reported a Container no-op but rollout ${rollout.id} appeared.`,
      };
    }
    if (["pending", "progressing"].includes(rollout.status)) {
      return {
        status: "waiting",
        message: `Container rollout ${rollout.id} is ${rollout.status}.`,
      };
    }
    if (rollout.status !== "completed") {
      return {
        status: "failed",
        message: `Container rollout ${rollout.id} finished as ${rollout.status}.`,
      };
    }
    const health = current.application.health;
    const rolloutHealth = rollout.health;
    const rolloutComplete =
      rollout.currentVersion === before.application.version &&
      rollout.targetVersion > rollout.currentVersion &&
      current.application.version === rollout.targetVersion &&
      current.application.activeRolloutId === null &&
      rollout.progress.totalInstances > 0 &&
      rollout.progress.updatedInstances === rollout.progress.totalInstances &&
      rolloutHealth.healthy === rollout.progress.totalInstances &&
      rolloutHealth.failed === 0 &&
      rolloutHealth.scheduling === 0 &&
      rolloutHealth.starting === 0 &&
      health.healthy === rollout.progress.totalInstances &&
      health.assigned === 0 &&
      health.stopped === 0 &&
      health.failed === 0 &&
      health.scheduling === 0 &&
      health.starting === 0;
    if (!rolloutComplete) {
      return {
        status: "waiting",
        message: `Container rollout ${rollout.id} is completed but its target version or health has not converged.`,
      };
    }
    return {
      status: "settled",
      outcome: "rollout",
      message: `Container rollout ${rollout.id} completed at version ${rollout.targetVersion}.`,
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
  } = {},
) {
  if (interruptedSignal && !allowAfterSignal) {
    return Promise.reject(
      new Error(`Production deployment was interrupted by ${interruptedSignal}.`),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    activeChildren.add(child);
    let stdout = "";
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signaledChildren.add(child);
      terminateProcessTree(child, "SIGTERM");
      scheduleForcedTermination(child);
    }, timeoutMs);
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (tee) process.stdout.write(chunk);
      });
    }
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
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
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
      reject(new Error(`${command} ${args.join(" ")} failed with ${result}.`));
    });
  });
}

async function readProductionContainerControlPlane(env, { allowAfterSignal = false } = {}) {
  const output = await runCommand(
    process.execPath,
    ["scripts/container-control-plane.mjs", PRODUCTION_CONTAINER_APPLICATION_ID],
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

function sanitizedLocalEnvironment() {
  const localEnvironment = { ...process.env };
  for (const key of Object.keys(localEnvironment)) {
    if (
      key.startsWith("CLOUDFLARE_") ||
      key.startsWith("SCOTTY_") ||
      [
        "CODEX_AUTH_JSON",
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

function productionEnvironment() {
  const accountId = PRODUCTION_CLOUDFLARE_ACCOUNT_ID;
  return {
    ...sanitizedLocalEnvironment(),
    ALCHEMY_TELEMETRY_DISABLED: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    SCOTTY_CLOUDFLARE_ACCOUNT_ID: accountId,
    SCOTTY_CHUNK2_ABSENCE_CONFIRMED: `absent:${accountId}:${PRODUCTION_WORKER_NAME}`,
    SCOTTY_CHUNK2_APPROVE_GREENFIELD: `greenfield:${accountId}:${PRODUCTION_WORKER_NAME}`,
    SCOTTY_HOST: PRODUCTION_SCOTTY_HOST,
  };
}

async function runStep(step, env = process.env, options = {}) {
  process.stdout.write(`\n==> ${step.name}\n`);
  return runCommand(step.command, step.args, {
    env,
    capture: step.capture,
    tee: step.tee,
    timeoutMs: step.timeoutMs,
    ...options,
  });
}

export async function executeProductionDeploySteps(
  execute = runStep,
  revalidate = assertLocalReleaseState,
  {
    readControlPlane = readProductionContainerControlPlane,
    waitForRollout = waitForProductionContainerRollout,
  } = {},
) {
  const verificationEnv = sanitizedLocalEnvironment();
  const productionEnv = productionEnvironment();
  await execute(PRODUCTION_DEPLOY_STEPS[0], verificationEnv);
  await execute(PRODUCTION_DEPLOY_STEPS[1], productionEnv);
  await revalidate();
  const controlPlaneBeforeDeploy = await readControlPlane(productionEnv);
  assertSettledContainerBaseline(controlPlaneBeforeDeploy);

  let deployError;
  let containerAction = "unknown";
  try {
    const deployOutput = await execute(PRODUCTION_DEPLOY_STEPS[2], productionEnv);
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
    await execute(PRODUCTION_DEPLOY_STEPS[3], productionEnv, { allowAfterSignal: true });
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
