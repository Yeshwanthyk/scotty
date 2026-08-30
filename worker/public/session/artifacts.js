const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SESSION_ID = /^[0-9a-f]{12}$/u;
const EVIDENCE_STATUSES = new Set(["succeeded", "failed", "interrupted", "unsupported"]);
const EVIDENCE_FAILURE_CODES = new Set([
  "assertion_mismatch",
  "artifact_invalid",
  "artifact_over_budget",
  "artifact_put_unknown",
  "deadline",
  "interrupted",
  "port_conflict",
  "unsupported",
]);
const HATCH_STATES = new Set(["starting", "running", "sleeping", "unhealthy", "stopped", "failed"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function resultDetails(tool) {
  return [tool?.details, tool?.result?.details, tool?.output?.details].find(isObject);
}

function isEvidenceFailure(failure) {
  return (
    isObject(failure) &&
    EVIDENCE_FAILURE_CODES.has(failure.code) &&
    (failure.step === undefined ||
      (Number.isSafeInteger(failure.step) && failure.step >= 0 && failure.step < 12))
  );
}

function isEvidenceDetails(details) {
  return (
    isObject(details) &&
    IDENTIFIER.test(details.jobId) &&
    EVIDENCE_STATUSES.has(details.status) &&
    Number.isSafeInteger(details.completedSteps) &&
    details.completedSteps >= 0 &&
    Number.isSafeInteger(details.frameCount) &&
    details.frameCount >= 0 &&
    typeof details.video === "boolean" &&
    (details.failure === undefined || isEvidenceFailure(details.failure))
  );
}

function isHatchDetails(details) {
  const hatch = details?.hatch;
  return (
    isObject(hatch) &&
    hatch.status === "configured" &&
    IDENTIFIER.test(hatch.hatchId) &&
    isObject(hatch.service) &&
    typeof hatch.service.name === "string" &&
    HATCH_STATES.has(hatch.observedStatus) &&
    ["open", "closed"].includes(hatch.desiredStatus) &&
    ["not_exposed", "active", "unexpose_pending", "closed"].includes(hatch.exposure) &&
    details.reference === `scotty-hatch:${hatch.hatchId}`
  );
}

function evidenceArtifact(details, sessionId) {
  const href = `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(details.jobId)}`;
  if (details.summaryUrl !== href) return { kind: "unavailable", label: "Evidence unavailable" };
  const failure =
    details.failure === undefined
      ? {}
      : {
          failure: {
            code: details.failure.code,
            ...(details.failure.step === undefined ? {} : { step: details.failure.step }),
          },
        };
  return {
    kind: "evidence",
    reference: `scotty-evidence:${details.jobId}`,
    jobId: details.jobId,
    label: "Browser evidence",
    status: details.status,
    completedSteps: details.completedSteps,
    frameCount: details.frameCount,
    video: details.video,
    ...failure,
    href,
  };
}

export function artifactForTool(tool, sessionId) {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const name = tool?.name ?? tool?.toolName;
  const details = resultDetails(tool);
  if (name === "scotty_browser_test") {
    if (!details && tool?.status === "running") return undefined;
    if (!isEvidenceDetails(details)) return { kind: "unavailable", label: "Evidence unavailable" };
    return evidenceArtifact(details, sessionId);
  }

  if (name !== "scotty_hatch") return undefined;
  if (!details && tool?.status === "running") return undefined;
  if (!isHatchDetails(details)) return { kind: "unavailable", label: "Hatch unavailable" };
  const hatch = details.hatch;
  const available =
    hatch.desiredStatus === "open" &&
    hatch.observedStatus === "running" &&
    hatch.exposure === "active";
  return {
    kind: "hatch",
    reference: details.reference,
    hatchId: hatch.hatchId,
    label: hatch.service.name,
    status: hatch.observedStatus,
    available,
    ...(available ? { href: `/s/${encodeURIComponent(sessionId)}/hatch/open` } : {}),
  };
}

export function renderArtifactCard(document, artifact) {
  const card = document.createElement("section");
  card.className = `artifact-card artifact-${artifact.kind}`;
  const marker = document.createElement("span");
  marker.className = "artifact-marker";
  marker.textContent = artifact.kind === "evidence" ? "E" : artifact.kind === "hatch" ? "H" : "—";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = artifact.label;
  const meta = document.createElement("span");
  if (artifact.kind === "evidence") {
    meta.textContent = `${artifact.status} · ${artifact.completedSteps} steps · ${artifact.frameCount} frames${artifact.video ? " · video" : ""}${artifact.failure === undefined ? "" : ` · ${artifact.failure.code.replaceAll("_", " ")}`}`;
  } else if (artifact.kind === "hatch") {
    meta.textContent = artifact.available ? `${artifact.status} · authenticated` : artifact.status;
  } else meta.textContent = "The structured result could not be verified.";
  copy.append(title, meta);
  card.append(marker, copy);
  if (artifact.href) {
    const link = document.createElement("a");
    link.className = "artifact-link";
    link.href = artifact.href;
    link.textContent = artifact.kind === "evidence" ? "View evidence" : "Open Hatch";
    card.append(link);
  }
  return card;
}
