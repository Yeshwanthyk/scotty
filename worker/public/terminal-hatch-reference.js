const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SESSION_ID = /^[0-9a-f]{12}$/u;
const PORTS = new Set([3_000, 43_117]);
const OPERATIONS = new Set(["ensure", "status", "close"]);
const PROCESS_STATUSES = new Set(["running", "stopped", "not_owned"]);
const DESIRED_STATUSES = new Set(["open", "closed"]);
const OBSERVED_STATUSES = new Set([
  "starting",
  "running",
  "sleeping",
  "unhealthy",
  "stopped",
  "failed",
]);
const EXPOSURES = new Set(["not_exposed", "active", "unexpose_pending", "closed"]);
const MAX_LOG_TAIL_BYTES = 4 * 1_024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function isTimestamp(value) {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function isPort(value) {
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 65_535 && !PORTS.has(value);
}

function configuredStatus(value) {
  return (
    exactKeys(
      value,
      [
        "version",
        "status",
        "hatchId",
        "generation",
        "service",
        "desiredStatus",
        "observedStatus",
        "exposure",
        "createdAt",
        "updatedAt",
      ],
      ["lastHealthyAt"],
    ) &&
    value.version === 1 &&
    value.status === "configured" &&
    typeof value.hatchId === "string" &&
    IDENTIFIER.test(value.hatchId) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    isObject(value.service) &&
    exactKeys(value.service, ["name", "port"]) &&
    typeof value.service.name === "string" &&
    value.service.name.length > 0 &&
    value.service.name.length <= 120 &&
    isPort(value.service.port) &&
    DESIRED_STATUSES.has(value.desiredStatus) &&
    OBSERVED_STATUSES.has(value.observedStatus) &&
    EXPOSURES.has(value.exposure) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
    (value.lastHealthyAt === undefined ||
      (isTimestamp(value.lastHealthyAt) &&
        Date.parse(value.createdAt) <= Date.parse(value.lastHealthyAt)))
  );
}

function hatchStatus(value) {
  if (!isObject(value)) return undefined;
  if (
    exactKeys(value, ["version", "status"]) &&
    value.version === 1 &&
    value.status === "not_configured"
  )
    return { version: 1, status: "not_configured" };
  if (!configuredStatus(value)) return undefined;
  return {
    version: 1,
    status: "configured",
    hatchId: value.hatchId,
    generation: value.generation,
    service: { name: value.service.name, port: value.service.port },
    desiredStatus: value.desiredStatus,
    observedStatus: value.observedStatus,
    exposure: value.exposure,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.lastHealthyAt === undefined ? {} : { lastHealthyAt: value.lastHealthyAt }),
  };
}

function resultDetails(tool) {
  const candidates = [tool?.details, tool?.result?.details, tool?.output?.details];
  return candidates.find(isObject);
}

export function browserHatchPaths(sessionId, hatchId) {
  if (!SESSION_ID.test(sessionId) || !IDENTIFIER.test(hatchId)) return undefined;
  const session = encodeURIComponent(sessionId);
  return {
    status: `/api/sessions/${session}/hatch`,
    open: `/s/${session}/hatch/open`,
    stop: `/api/sessions/${session}/hatch`,
    wake: `/api/sessions/${session}/resume`,
  };
}

export function browserHatchReference(tool, sessionId) {
  const toolName = tool?.name ?? tool?.toolName;
  if (toolName !== "scotty_hatch") return undefined;
  const value = resultDetails(tool);
  if (!value && tool?.status === "running") return undefined;
  if (
    !value ||
    !exactKeys(value, ["version", "operation", "hatch", "process"], ["reference"]) ||
    value.version !== 1 ||
    !OPERATIONS.has(value.operation) ||
    !isObject(value.process) ||
    !exactKeys(value.process, ["status", "stdoutTail", "stderrTail"]) ||
    !PROCESS_STATUSES.has(value.process.status) ||
    typeof value.process.stdoutTail !== "string" ||
    new TextEncoder().encode(value.process.stdoutTail).byteLength > MAX_LOG_TAIL_BYTES ||
    typeof value.process.stderrTail !== "string" ||
    new TextEncoder().encode(value.process.stderrTail).byteLength > MAX_LOG_TAIL_BYTES
  )
    return { kind: "unavailable" };
  const status = hatchStatus(value.hatch);
  if (status === undefined) return { kind: "unavailable" };
  if (status.status === "not_configured")
    return value.reference === undefined ? undefined : { kind: "unavailable" };
  if (value.reference !== `scotty-hatch:${status.hatchId}`) return { kind: "unavailable" };
  const paths = browserHatchPaths(sessionId, status.hatchId);
  if (paths === undefined) return { kind: "unavailable" };
  return { kind: "hatch", version: 1, hatchId: status.hatchId, paths };
}

export function browserHatchStatus(value, reference) {
  if (reference?.kind !== "hatch") return undefined;
  const status = hatchStatus(value);
  if (status?.status !== "configured" || status.hatchId !== reference.hatchId) return undefined;
  return status;
}

export function hatchStatusLabel(status) {
  return (
    {
      starting: "Starting",
      running: "Running",
      sleeping: "Sleeping",
      unhealthy: "Unhealthy",
      stopped: "Stopped",
      failed: "Failed",
    }[status?.observedStatus] ?? "Unavailable"
  );
}

export function hatchStatusCopy(status) {
  if (status.desiredStatus === "closed") return "This Hatch is stopped and no longer exposed.";
  return (
    {
      starting: "The service is starting and is not ready to open yet.",
      running:
        status.exposure === "active"
          ? "The authenticated application service is ready to open."
          : "The service is running, but authenticated access is not active.",
      sleeping: "The Session runtime is asleep. Wake it before opening this Hatch.",
      unhealthy: "The service did not pass its latest health check.",
      stopped: "The service is not running in the current runtime.",
      failed: "Scotty could not restore authenticated access to this Hatch.",
    }[status.observedStatus] ?? "The current Hatch state is unavailable."
  );
}

export function hatchActions(status) {
  const open =
    status.desiredStatus === "open" &&
    status.observedStatus === "running" &&
    status.exposure === "active";
  const wakeAndOpen =
    status.desiredStatus === "open" &&
    (status.observedStatus === "sleeping" || status.observedStatus === "failed") &&
    status.exposure === "closed";
  const stop =
    status.desiredStatus === "open" &&
    ["running", "unhealthy", "stopped"].includes(status.observedStatus);
  return { open, verify: true, wakeAndOpen, stop };
}
