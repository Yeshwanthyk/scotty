import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
const TERMINATION_GRACE_MS = 10_000;
const activeChildren = new Set();
const forcedTerminationTimers = new Map();
const signaledChildren = new WeakSet();
let interruptedSignal;

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
  await runCommand(step.command, step.args, { env, timeoutMs: step.timeoutMs, ...options });
}

export async function executeProductionDeploySteps(
  execute = runStep,
  revalidate = assertLocalReleaseState,
) {
  const verificationEnv = sanitizedLocalEnvironment();
  const productionEnv = productionEnvironment();
  await execute(PRODUCTION_DEPLOY_STEPS[0], verificationEnv);
  await execute(PRODUCTION_DEPLOY_STEPS[1], productionEnv);
  await revalidate();

  let deployError;
  try {
    await execute(PRODUCTION_DEPLOY_STEPS[2], productionEnv);
  } catch (error) {
    deployError = error;
  }

  let auditError;
  try {
    await execute(PRODUCTION_DEPLOY_STEPS[3], productionEnv, { allowAfterSignal: true });
  } catch (error) {
    auditError = error;
  }

  if (deployError && auditError) {
    throw new AggregateError(
      [deployError, auditError],
      "Production deploy and post-deploy inventory audit both failed.",
    );
  }
  if (deployError) throw deployError;
  if (auditError) throw auditError;
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
