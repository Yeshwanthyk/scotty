const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SESSION_ID = /^[0-9a-f]{12}$/u;
const EVIDENCE_STATUSES = new Set(["succeeded", "failed", "interrupted", "unsupported"]);
const HATCH_STATES = new Set(["starting", "running", "sleeping", "unhealthy", "stopped", "failed"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function resultDetails(tool) {
  return [tool?.details, tool?.result?.details, tool?.output?.details].find(isObject);
}

export function artifactForTool(tool, sessionId) {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const name = tool?.name ?? tool?.toolName;
  const details = resultDetails(tool);
  if (name === "scotty_browser_test") {
    if (!details && tool?.status === "running") return undefined;
    if (
      !details ||
      details.version !== 2 ||
      !IDENTIFIER.test(details.jobId) ||
      !EVIDENCE_STATUSES.has(details.status) ||
      !Number.isSafeInteger(details.completedSteps) ||
      details.completedSteps < 0 ||
      !Number.isSafeInteger(details.frameCount) ||
      details.frameCount < 0 ||
      typeof details.video !== "boolean"
    )
      return { kind: "unavailable", label: "Evidence unavailable" };
    const href = `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(details.jobId)}`;
    if (details.summaryUrl !== href) return { kind: "unavailable", label: "Evidence unavailable" };
    return {
      kind: "evidence",
      label: "Browser evidence",
      status: details.status,
      completedSteps: details.completedSteps,
      frameCount: details.frameCount,
      video: details.video,
      href,
    };
  }

  if (name !== "scotty_hatch") return undefined;
  if (!details && tool?.status === "running") return undefined;
  const hatch = details?.hatch;
  if (
    details?.version !== 1 ||
    !isObject(hatch) ||
    hatch.version !== 1 ||
    hatch.status !== "configured" ||
    !IDENTIFIER.test(hatch.hatchId) ||
    !isObject(hatch.service) ||
    typeof hatch.service.name !== "string" ||
    !HATCH_STATES.has(hatch.observedStatus) ||
    !["open", "closed"].includes(hatch.desiredStatus) ||
    !["not_exposed", "active", "unexpose_pending", "closed"].includes(hatch.exposure) ||
    details.reference !== `scotty-hatch:${hatch.hatchId}`
  )
    return { kind: "unavailable", label: "Hatch unavailable" };
  const available =
    hatch.desiredStatus === "open" &&
    hatch.observedStatus === "running" &&
    hatch.exposure === "active";
  return {
    kind: "hatch",
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
    meta.textContent = `${artifact.status} · ${artifact.completedSteps} steps · ${artifact.frameCount} frames${artifact.video ? " · video" : ""}`;
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
