const RESULT_STATUSES = new Set(["succeeded", "failed", "interrupted", "unsupported"]);
const SUMMARY_STATUSES = new Set([
  "accepted",
  "exposing",
  "running",
  "finalizing",
  ...RESULT_STATUSES,
]);
const FAILURE_CODES = new Set([
  "assertion_mismatch",
  "artifact_invalid",
  "artifact_over_budget",
  "artifact_put_unknown",
  "deadline",
  "interrupted",
  "unsupported",
]);
const ACTIONS = new Set(["goto", "click", "fill", "press"]);
const ASSERTIONS = new Set(["visible", "textExact", "count", "urlPath"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SESSION_ID = /^[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_STEPS = 12;
const MAX_ASSERTIONS = 4;
const MAX_FRAME_BYTES = 5 * 1_024 * 1_024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function validFailure(value, maximumStep) {
  return (
    isObject(value) &&
    exactKeys(value, ["code"], ["step"]) &&
    FAILURE_CODES.has(value.code) &&
    (value.step === undefined ||
      (isNonNegativeInteger(value.step) &&
        (maximumStep === undefined || value.step <= maximumStep)))
  );
}

export function browserEvidencePaths(sessionId, jobId) {
  if (!SESSION_ID.test(sessionId) || !IDENTIFIER.test(jobId)) return undefined;
  const session = encodeURIComponent(sessionId);
  const job = encodeURIComponent(jobId);
  return {
    summary: `/api/sessions/${session}/evidence/${job}`,
    replay: `/s/${session}/evidence/${job}`,
    frame(frameId) {
      return IDENTIFIER.test(frameId)
        ? `/s/${session}/evidence/${job}/frames/${encodeURIComponent(frameId)}.png`
        : undefined;
    },
  };
}

function resultDetails(tool) {
  const candidates = [tool?.details, tool?.result?.details, tool?.output?.details];
  return candidates.find(isObject);
}

export function browserEvidenceAttachment(tool, sessionId) {
  const toolName = tool?.name ?? tool?.toolName;
  if (toolName !== "scotty_browser_test") return undefined;
  const value = resultDetails(tool);
  if (!value && tool?.status === "running") return undefined;
  if (
    !value ||
    !exactKeys(
      value,
      ["version", "jobId", "status", "summaryUrl", "completedSteps", "frameCount"],
      ["failure"],
    ) ||
    value.version !== 1 ||
    !IDENTIFIER.test(value.jobId) ||
    !RESULT_STATUSES.has(value.status) ||
    !isBoundedInteger(value.completedSteps, MAX_STEPS) ||
    !isBoundedInteger(value.frameCount, MAX_STEPS) ||
    (value.failure !== undefined && !validFailure(value.failure, MAX_STEPS - 1))
  ) {
    return { kind: "unavailable" };
  }
  const paths = browserEvidencePaths(sessionId, value.jobId);
  if (!paths || value.summaryUrl !== paths.replay) return { kind: "unavailable" };
  return {
    kind: "evidence",
    version: 1,
    jobId: value.jobId,
    status: value.status,
    completedSteps: value.completedSteps,
    frameCount: value.frameCount,
    ...(value.failure === undefined ? {} : { failure: { ...value.failure } }),
    paths,
  };
}

function validAssertion(value) {
  return (
    isObject(value) &&
    exactKeys(value, ["kind", "passed"]) &&
    ASSERTIONS.has(value.kind) &&
    typeof value.passed === "boolean"
  );
}

function normalizeStep(value) {
  if (
    !isObject(value) ||
    !exactKeys(
      value,
      [
        "index",
        "name",
        "action",
        "status",
        "assertions",
        "startedAt",
        "completedAt",
        "offsetMillis",
      ],
      ["frame"],
    ) ||
    !isNonNegativeInteger(value.index) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 120 ||
    !ACTIONS.has(value.action) ||
    !["passed", "failed"].includes(value.status) ||
    !Array.isArray(value.assertions) ||
    value.assertions.length < 1 ||
    value.assertions.length > MAX_ASSERTIONS ||
    !value.assertions.every(validAssertion) ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !isBoundedInteger(value.offsetMillis, Number.MAX_SAFE_INTEGER)
  )
    return undefined;

  let frame;
  if (value.frame !== undefined) {
    if (
      !isObject(value.frame) ||
      !exactKeys(value.frame, ["frameId", "sha256", "bytes", "capturedAt", "offsetMillis"]) ||
      !IDENTIFIER.test(value.frame.frameId) ||
      !SHA256.test(value.frame.sha256) ||
      !Number.isInteger(value.frame.bytes) ||
      value.frame.bytes < 1 ||
      value.frame.bytes > MAX_FRAME_BYTES ||
      typeof value.frame.capturedAt !== "string" ||
      !isBoundedInteger(value.frame.offsetMillis, Number.MAX_SAFE_INTEGER)
    )
      return undefined;
    frame = { frameId: value.frame.frameId };
  }

  return {
    index: value.index,
    name: value.name,
    status: value.status,
    assertions: value.assertions.map(({ kind, passed }) => ({ kind, passed })),
    ...(frame === undefined ? {} : { frame }),
  };
}

export function browserEvidenceSummary(value, attachment) {
  if (
    attachment?.kind !== "evidence" ||
    !isObject(value) ||
    !exactKeys(
      value,
      [
        "version",
        "sequence",
        "jobId",
        "status",
        "acceptedAt",
        "totalSteps",
        "completedSteps",
        "replay",
        "steps",
        "frameCount",
      ],
      ["startedAt", "completedAt", "failure"],
    ) ||
    value.version !== 1 ||
    value.jobId !== attachment.jobId ||
    !SUMMARY_STATUSES.has(value.status) ||
    !isBoundedInteger(value.sequence, Number.MAX_SAFE_INTEGER) ||
    typeof value.acceptedAt !== "string" ||
    (value.startedAt !== undefined && typeof value.startedAt !== "string") ||
    (value.completedAt !== undefined && typeof value.completedAt !== "string") ||
    !Number.isInteger(value.totalSteps) ||
    value.totalSteps < 1 ||
    value.totalSteps > MAX_STEPS ||
    !isNonNegativeInteger(value.completedSteps) ||
    typeof value.replay !== "boolean" ||
    !Array.isArray(value.steps) ||
    value.steps.length > MAX_STEPS ||
    !isNonNegativeInteger(value.frameCount) ||
    (value.failure !== undefined && !validFailure(value.failure))
  )
    return undefined;

  const steps = value.steps.map(normalizeStep);
  if (steps.some((step) => step === undefined)) return undefined;
  const frames = steps.flatMap((step) =>
    step.frame === undefined
      ? []
      : [{ frameId: step.frame.frameId, stepIndex: step.index, stepName: step.name }],
  );
  if (frames.length !== value.frameCount) return undefined;
  const assertions = steps.flatMap((step) => step.assertions);
  return {
    status: value.status,
    passedAssertions: assertions.filter((assertion) => assertion.passed).length,
    totalAssertions: assertions.length,
    frames,
  };
}

export function browserEvidenceStatusLabel(status) {
  return (
    {
      accepted: "Accepted",
      exposing: "Preparing",
      running: "Running",
      finalizing: "Finalizing",
      succeeded: "Passed",
      failed: "Failed",
      interrupted: "Interrupted",
      unsupported: "Unsupported",
    }[status] ?? "Unavailable"
  );
}

export function browserEvidenceNoFrameCopy(status) {
  return (
    {
      succeeded: "The run passed, but no screenshots were published.",
      failed: "The run failed before a screenshot was available.",
      interrupted: "The run ended before a screenshot was available.",
      unsupported: "This browser could not publish a screenshot for the run.",
    }[status] ?? "No screenshots were published."
  );
}
