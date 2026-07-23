import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PRODUCTION_CONTAINER_APPLICATION_NAME =
  "scotty-sandboxcontainer-production-ytkhty6mswuofjo5";

const HARD_CAP_GRACE_MS = 30_000;
const SESSION_ID = /^[0-9a-f]{12}$/u;
const ACTIVE_SESSION_STATUSES = new Set(["booting", "warm"]);
const HEALTHY_APPLICATION_STATES = new Set(["active", "ready"]);
const KNOWN_ACTIVE_INSTANCE_STATES = new Set(["running", "scheduling", "starting"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function reconcileContainerInventory({
  applications,
  instances,
  sessions,
  now = Date.now(),
}) {
  const issues = [];
  const scottyApplications = applications.filter(
    (application) => isObject(application) && String(application.name).startsWith("scotty-"),
  );
  const productionApplications = scottyApplications.filter(
    (application) => application.name === PRODUCTION_CONTAINER_APPLICATION_NAME,
  );
  if (productionApplications.length !== 1) {
    issues.push({
      code: "production_application_count",
      message: `Expected one pinned production Container application; found ${productionApplications.length}.`,
    });
  }
  if (scottyApplications.length !== 1) {
    issues.push({
      code: "scotty_application_count",
      message: `Expected no duplicate Scotty Container applications; found ${scottyApplications.length}.`,
    });
  }

  const application = productionApplications[0];
  if (application && !HEALTHY_APPLICATION_STATES.has(String(application.state))) {
    issues.push({
      code: "production_application_inactive",
      message: `Production Container application is ${String(application.state)}.`,
    });
  }

  const activeInstances = instances.filter(
    (instance) => isObject(instance) && instance.state !== "inactive",
  );
  const inactiveInstances = instances.filter(
    (instance) => isObject(instance) && instance.state === "inactive",
  );
  const sessionById = new Map(
    sessions
      .filter((session) => isObject(session) && typeof session.id === "string")
      .map((session) => [session.id, session]),
  );
  const activeInstanceByName = new Map();

  for (const instance of activeInstances) {
    const name = String(instance.name);
    activeInstanceByName.set(name, instance);
    if (!KNOWN_ACTIVE_INSTANCE_STATES.has(String(instance.state))) {
      issues.push({
        code: "unknown_active_instance_state",
        message: `Instance ${name} has unrecognized active state ${String(instance.state)}.`,
      });
    }
    if (!SESSION_ID.test(name)) {
      issues.push({
        code: "unowned_active_instance",
        message: `Active instance ${name} is not a Scotty session identity.`,
      });
      continue;
    }
    const session = sessionById.get(name);
    if (!session) {
      issues.push({
        code: "active_instance_without_session",
        message: `Active instance ${name} has no authoritative session projection.`,
      });
      continue;
    }
    if (!ACTIVE_SESSION_STATUSES.has(String(session.status))) {
      issues.push({
        code: "active_instance_for_terminal_session",
        message: `Active instance ${name} belongs to ${String(session.status)} session state.`,
      });
    }
    const hardCap = Date.parse(String(session.hardCapAt));
    if (!Number.isFinite(hardCap) || hardCap + HARD_CAP_GRACE_MS < now) {
      issues.push({
        code: "active_instance_past_hard_cap",
        message: `Active instance ${name} is past its session hard cap.`,
      });
    }
  }

  for (const session of sessions) {
    if (!isObject(session) || typeof session.id !== "string") continue;
    if (
      ACTIVE_SESSION_STATUSES.has(String(session.status)) &&
      !activeInstanceByName.has(session.id)
    ) {
      issues.push({
        code: "active_session_without_instance",
        message: `${String(session.status)} session ${session.id} has no active Container instance.`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    checkedAt: new Date(now).toISOString(),
    application: application
      ? {
          id: application.id,
          name: application.name,
          state: application.state,
          summaryInstances: application.instances,
        }
      : null,
    counts: {
      scottyApplications: scottyApplications.length,
      activeInstances: activeInstances.length,
      inactiveIdentityRows: inactiveInstances.length,
      projectedSessions: sessions.length,
    },
    activeInstances: activeInstances.map((instance) => ({
      name: instance.name,
      state: instance.state,
      location: instance.location,
      version: instance.version,
    })),
    sessions: sessions.map((session) => ({
      id: session.id,
      status: session.status,
      hardCapAt: session.hardCapAt,
    })),
    issues,
    notes: [
      "Inactive instance rows are historical Durable Object identities, not running compute.",
      "The application summary instance count can include platform-prewarmed capacity; reconciliation uses per-instance active states.",
    ],
  };
}

function execJson(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`${command} ${args.join(" ")} returned non-JSON output.`));
        }
      },
    );
  });
}

async function readSessions() {
  const host = process.env.SCOTTY_HOST;
  const token = process.env.SCOTTY_TOKEN;
  if (host && token) {
    const response = await fetch(new URL("/api/sessions", host), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Scotty session inventory failed with HTTP ${response.status}.`);
    }
    return response.json();
  }
  return execJson("bun", ["cli/scotty.ts", "ls", "--json"]);
}

async function main() {
  const applications = await execJson("npx", [
    "--no-install",
    "wrangler",
    "containers",
    "list",
    "--json",
  ]);
  if (!Array.isArray(applications)) {
    throw new Error("Wrangler Container application inventory was not an array.");
  }
  const application = applications.find(
    (candidate) => isObject(candidate) && candidate.name === PRODUCTION_CONTAINER_APPLICATION_NAME,
  );
  const [instances, sessions] = await Promise.all([
    application
      ? execJson("npx", [
          "--no-install",
          "wrangler",
          "containers",
          "instances",
          String(application.id),
          "--json",
        ])
      : Promise.resolve([]),
    readSessions(),
  ]);
  if (!Array.isArray(instances) || !Array.isArray(sessions)) {
    throw new Error("Container instance or Scotty session inventory was not an array.");
  }
  const report = reconcileContainerInventory({ applications, instances, sessions });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Container reconciliation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
