import { artifactForTool } from "./artifacts.js";
import { conversationTurns, renderSafeMarkdown, sanitizeText } from "./chat.js";
import { evidenceFailurePresentation, orderedEvidenceFrames } from "../evidence/view.js";

const REFERENCE = /\bscotty-(?:evidence|hatch):[A-Za-z0-9][A-Za-z0-9_-]{0,127}\b/gu;
const SESSION_ID = /^[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_EVIDENCE_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_EVIDENCE_STEPS = 12;
const MAX_ASSERTIONS_PER_STEP = 4;
const EVIDENCE_STATUSES = new Set([
  "accepted",
  "exposing",
  "running",
  "finalizing",
  "succeeded",
  "failed",
  "interrupted",
  "unsupported",
]);
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

function isSummaryFailure(value) {
  return (
    isObject(value) &&
    EVIDENCE_FAILURE_CODES.has(value.code) &&
    (value.step === undefined ||
      (Number.isSafeInteger(value.step) && value.step >= 0 && value.step < MAX_EVIDENCE_STEPS))
  );
}

function isSummaryVideo(value) {
  return (
    isObject(value) &&
    value.artifactId === "recording" &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 1 &&
    value.bytes <= MAX_EVIDENCE_VIDEO_BYTES &&
    typeof value.capturedAt === "string" &&
    Number.isSafeInteger(value.offsetMillis) &&
    value.offsetMillis >= 0
  );
}

function messageText(message) {
  const parts = Array.isArray(message?.content)
    ? message.content
    : typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  return sanitizeText(
    parts
      .flatMap((part) => {
        if (typeof part === "string") return [sanitizeText(part)];
        return part?.type === "text" && typeof part.text === "string"
          ? [sanitizeText(part.text)]
          : [];
      })
      .filter(Boolean)
      .join("\n"),
    32 * 1024,
  );
}

export function extractSummaryReferences(text) {
  return [...new Set(String(text ?? "").match(REFERENCE) ?? [])].slice(0, 8);
}

export function summaryProjection(projection, sessionId) {
  if (!SESSION_ID.test(sessionId)) return { update: "", artifacts: [] };
  const turns = conversationTurns(projection);
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    for (let messageIndex = turn.assistants.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const update = messageText(turn.assistants[messageIndex]);
      if (!update) continue;
      const verified = new Map(
        turn.tools
          .map((tool) => artifactForTool(tool, sessionId))
          .filter((artifact) => artifact?.reference)
          .map((artifact) => [artifact.reference, artifact]),
      );
      return {
        update,
        artifacts: extractSummaryReferences(update)
          .filter((reference) => reference.startsWith("scotty-evidence:"))
          .map(
            (reference) =>
              verified.get(reference) ?? {
                kind: "unavailable",
                reference,
                label: "Evidence unavailable",
              },
          ),
      };
    }
  }
  return { update: "", artifacts: [] };
}

function summaryVideoProjection(value) {
  if (value === undefined) return {};
  if (!isSummaryVideo(value)) return undefined;
  return {
    video: {
      artifactId: value.artifactId,
      sha256: value.sha256,
      bytes: value.bytes,
      capturedAt: value.capturedAt,
      offsetMillis: value.offsetMillis,
    },
  };
}

function summaryFailureProjection(value) {
  if (value === undefined) return {};
  if (!isSummaryFailure(value)) return undefined;
  return {
    failure: {
      code: value.code,
      ...(value.step === undefined ? {} : { step: value.step }),
    },
  };
}

export function decodeSummaryEvidence(value, jobId) {
  if (
    !isObject(value) ||
    value.jobId !== jobId ||
    !IDENTIFIER.test(jobId) ||
    !EVIDENCE_STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.totalSteps) ||
    value.totalSteps < 1 ||
    value.totalSteps > MAX_EVIDENCE_STEPS ||
    !Number.isSafeInteger(value.completedSteps) ||
    value.completedSteps < 0 ||
    value.completedSteps > value.totalSteps ||
    !Number.isSafeInteger(value.frameCount) ||
    value.frameCount < 0 ||
    !Array.isArray(value.steps) ||
    value.steps.length > value.totalSteps
  )
    return undefined;
  const video = summaryVideoProjection(value.video);
  if (video === undefined) return undefined;
  const failure = summaryFailureProjection(value.failure);
  if (failure === undefined) return undefined;
  const steps = value.steps.flatMap((step) => {
    if (
      !isObject(step) ||
      !Array.isArray(step.assertions) ||
      step.assertions.length < 1 ||
      step.assertions.length > MAX_ASSERTIONS_PER_STEP
    )
      return [];
    const assertions = step.assertions.flatMap((assertion) =>
      isObject(assertion) && typeof assertion.passed === "boolean"
        ? [{ passed: assertion.passed }]
        : [],
    );
    if (
      assertions.length !== step.assertions.length ||
      !Number.isSafeInteger(step.index) ||
      typeof step.name !== "string" ||
      !["passed", "failed"].includes(step.status)
    )
      return [];
    const frame = step.frame;
    if (
      frame !== undefined &&
      (!isObject(frame) ||
        typeof frame.frameId !== "string" ||
        !IDENTIFIER.test(frame.frameId) ||
        !Number.isSafeInteger(frame.offsetMillis) ||
        frame.offsetMillis < 0)
    )
      return [];
    return [
      {
        index: step.index,
        name: sanitizeText(step.name, 180),
        status: step.status,
        assertions,
        ...(frame === undefined
          ? {}
          : { frame: { frameId: frame.frameId, offsetMillis: frame.offsetMillis } }),
      },
    ];
  });
  if (
    steps.length !== value.steps.length ||
    steps.filter((step) => step.frame !== undefined).length !== value.frameCount
  )
    return undefined;
  return {
    jobId,
    status: value.status,
    totalSteps: value.totalSteps,
    completedSteps: value.completedSteps,
    frameCount: value.frameCount,
    ...video,
    ...failure,
    steps,
  };
}

export function decodeSummaryHatch(value) {
  if (isObject(value) && value.status === "not_configured")
    return { configured: false, available: false };
  if (
    !isObject(value) ||
    value.status !== "configured" ||
    typeof value.hatchId !== "string" ||
    !IDENTIFIER.test(value.hatchId) ||
    !isObject(value.service) ||
    typeof value.service.name !== "string" ||
    !HATCH_STATES.has(value.observedStatus) ||
    !["open", "closed"].includes(value.desiredStatus) ||
    !["not_exposed", "active", "unexpose_pending", "closed"].includes(value.exposure)
  )
    return undefined;
  return {
    configured: true,
    hatchId: value.hatchId,
    serviceName: sanitizeText(value.service.name, 120),
    desiredStatus: value.desiredStatus,
    observedStatus: value.observedStatus,
    exposure: value.exposure,
    available:
      value.desiredStatus === "open" &&
      value.observedStatus === "running" &&
      value.exposure === "active",
  };
}

function sectionHeading(document, eyebrow, title) {
  const heading = document.createElement("div");
  heading.className = "summary-section-heading";
  const label = document.createElement("span");
  label.textContent = eyebrow;
  const strong = document.createElement("strong");
  strong.textContent = title;
  heading.append(label, strong);
  return heading;
}

function summaryState(document, copy) {
  const state = document.createElement("p");
  state.className = "summary-state";
  state.textContent = copy;
  return state;
}

function renderUnavailable(document, target, artifact) {
  target.replaceChildren(
    sectionHeading(document, "Unavailable", artifact.label),
    summaryState(document, "This reference is not backed by a verified result in this update."),
  );
}

function renderEvidence(document, target, sessionId, evidence) {
  const assertions = evidence.steps.flatMap((step) => step.assertions);
  const passed = assertions.filter((assertion) => assertion.passed).length;
  const failure = evidenceFailurePresentation(evidence.failure);
  const meta = document.createElement("p");
  meta.className = "summary-meta";
  meta.textContent = `${evidence.status} · ${evidence.completedSteps}/${evidence.totalSteps} steps · ${passed}/${assertions.length} checks`;
  const frames = document.createElement("div");
  frames.className = "summary-frames";
  for (const frame of orderedEvidenceFrames(evidence)) {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = sanitizeText(`${frame.stepName} browser evidence`, 180);
    image.src = `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(evidence.jobId)}/frames/${encodeURIComponent(frame.frameId)}.png`;
    const caption = document.createElement("figcaption");
    caption.textContent = sanitizeText(frame.stepName, 180);
    figure.append(image, caption);
    frames.append(figure);
  }
  const recordingAvailable = evidence.video !== undefined;
  const link = document.createElement("a");
  link.className = recordingAvailable ? "summary-link summary-link-primary" : "summary-link";
  link.href = recordingAvailable
    ? `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(evidence.jobId)}/video.webm`
    : `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(evidence.jobId)}`;
  link.textContent = recordingAvailable ? "Watch browser recording" : "Open full evidence";
  target.replaceChildren(
    sectionHeading(document, "Browser evidence", failure?.title ?? "Verified run"),
    meta,
  );
  if (failure !== undefined)
    target.append(
      summaryState(
        document,
        `${failure.detail}${failure.hint === undefined ? "" : ` ${failure.hint}`}`,
      ),
    );
  if (frames.childNodes.length > 0) target.append(frames);
  target.append(link);
}

function hatchStateCopy(hatch) {
  if (hatch.observedStatus === "starting")
    return "Hatch is starting. Public access will appear when the service is healthy.";
  if (hatch.observedStatus === "sleeping")
    return "Hatch is asleep. Public access will return when the service wakes.";
  if (hatch.observedStatus === "unhealthy")
    return "Hatch is unhealthy. Public access is paused until the service recovers.";
  if (hatch.observedStatus === "stopped")
    return "Hatch is stopped. Ask Pi to start it when you need public access.";
  if (hatch.observedStatus === "failed")
    return "Hatch failed to start. Ask Pi to inspect the application service before trying again.";
  if (hatch.desiredStatus === "closed" || hatch.exposure === "closed")
    return "Hatch is closed. Ask Pi to open it when you need public access.";
  return "Hatch is configured, but public access is not ready yet.";
}
function renderHatch(document, target, sessionId, hatch) {
  if (!hatch.configured) {
    target.hidden = true;
    target.replaceChildren();
    return;
  }
  target.hidden = false;
  const meta = document.createElement("p");
  meta.className = "summary-meta";
  meta.textContent = hatch.available
    ? `${hatch.observedStatus} · public HTTPS ready`
    : `${hatch.observedStatus} · public HTTPS unavailable`;
  target.replaceChildren(sectionHeading(document, "Hatch", hatch.serviceName), meta);
  if (!hatch.available) target.append(summaryState(document, hatchStateCopy(hatch)));
  if (hatch.available) {
    const link = document.createElement("a");
    link.className = "summary-link summary-link-primary";
    link.href = `/s/${encodeURIComponent(sessionId)}/hatch/open`;
    link.textContent = "Open Hatch";
    target.append(link);
  }
}

async function fetchJson(fetch, path) {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export function createEvidenceLoader(load) {
  let activeSessionId;
  const values = new Map();
  const pending = new Map();
  const select = (sessionId) => {
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    values.clear();
    pending.clear();
  };
  return {
    current(sessionId, jobId) {
      select(sessionId);
      return values.get(jobId);
    },
    load(sessionId, jobId) {
      select(sessionId);
      const value = values.get(jobId);
      if (value !== undefined) return Promise.resolve(value);
      const inFlight = pending.get(jobId);
      if (inFlight) return inFlight;
      const ownedSessionId = sessionId;
      const request = Promise.resolve()
        .then(() => load(sessionId, jobId))
        .then((next) => {
          if (
            next !== undefined &&
            activeSessionId === ownedSessionId &&
            pending.get(jobId) === request
          )
            values.set(jobId, next);
          return next;
        })
        .finally(() => {
          if (activeSessionId === ownedSessionId && pending.get(jobId) === request)
            pending.delete(jobId);
        });
      pending.set(jobId, request);
      return request;
    },
    reset() {
      activeSessionId = undefined;
      values.clear();
      pending.clear();
    },
  };
}

export function createHatchStatusLoader(load) {
  let activeSessionId;
  let value;
  let pending;
  const select = (sessionId) => {
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    value = undefined;
    pending = undefined;
  };
  return {
    current(sessionId) {
      select(sessionId);
      return value;
    },
    refresh(sessionId) {
      select(sessionId);
      if (pending) return pending;
      const ownedSessionId = sessionId;
      const request = Promise.resolve()
        .then(() => load(sessionId))
        .then((next) => {
          if (activeSessionId === ownedSessionId && pending === request) value = next;
          return next;
        })
        .catch((error) => {
          if (activeSessionId === ownedSessionId && pending === request) value = undefined;
          throw error;
        })
        .finally(() => {
          if (activeSessionId === ownedSessionId && pending === request) pending = undefined;
        });
      pending = request;
      return request;
    },
    reset() {
      activeSessionId = undefined;
      value = undefined;
      pending = undefined;
    },
  };
}

export function createSummaryView({ document, root, baseUrl, fetch }) {
  let generation = 0;
  let renderedSignature = "";
  const hatchStatus = createHatchStatusLoader((sessionId) =>
    fetchJson(fetch, `/api/sessions/${encodeURIComponent(sessionId)}/hatch`).then(
      decodeSummaryHatch,
    ),
  );
  const evidenceStatus = createEvidenceLoader((sessionId, jobId) =>
    fetchJson(
      fetch,
      `/api/sessions/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(jobId)}`,
    ).then((value) => decodeSummaryEvidence(value, jobId)),
  );
  return {
    render(projection, sessionId) {
      const summary = summaryProjection(projection, sessionId);
      const signature = JSON.stringify([sessionId, summary]);
      if (signature === renderedSignature) return;
      renderedSignature = signature;
      const currentGeneration = ++generation;
      const fragment = document.createDocumentFragment();
      const update = document.createElement("section");
      update.className = "summary-section summary-update";
      update.append(
        sectionHeading(document, "Latest update", summary.update ? "From Pi" : "Nothing yet"),
      );
      if (summary.update) update.append(renderSafeMarkdown(document, summary.update, baseUrl));
      else update.append(summaryState(document, "Pi's latest completed update will appear here."));
      fragment.append(update);
      const hatchTarget = document.createElement("section");
      hatchTarget.className = "summary-section summary-hatch";
      hatchTarget.hidden = true;
      hatchTarget.dataset.currentHatch = "";
      hatchTarget.setAttribute("role", "status");
      hatchTarget.setAttribute("aria-live", "polite");
      hatchTarget.setAttribute("aria-atomic", "true");
      hatchTarget.setAttribute("aria-busy", "true");
      const currentHatch = hatchStatus.current(sessionId);
      if (currentHatch) renderHatch(document, hatchTarget, sessionId, currentHatch);
      else hatchTarget.replaceChildren();
      fragment.append(hatchTarget);
      void hatchStatus
        .refresh(sessionId)
        .then((hatch) => {
          if (generation !== currentGeneration) return;
          hatchTarget.setAttribute("aria-busy", "false");
          if (hatch) renderHatch(document, hatchTarget, sessionId, hatch);
          else {
            hatchTarget.hidden = false;
            hatchTarget.replaceChildren(
              sectionHeading(document, "Hatch", "Status unavailable"),
              summaryState(
                document,
                "Hatch status could not be verified. No Hatch action was taken.",
              ),
            );
          }
        })
        .catch(() => {
          if (generation === currentGeneration) {
            hatchTarget.setAttribute("aria-busy", "false");
            hatchTarget.hidden = false;
            hatchTarget.replaceChildren(
              sectionHeading(document, "Hatch", "Unavailable"),
              summaryState(
                document,
                "Hatch status could not be loaded. No Hatch action was taken.",
              ),
            );
          }
        });
      for (const artifact of summary.artifacts) {
        const target = document.createElement("section");
        target.className = `summary-section summary-${artifact.kind}`;
        target.dataset.reference = artifact.reference;
        if (artifact.kind === "unavailable") {
          renderUnavailable(document, target, artifact);
          fragment.append(target);
          continue;
        }
        const currentEvidence = evidenceStatus.current(sessionId, artifact.jobId);
        if (currentEvidence) renderEvidence(document, target, sessionId, currentEvidence);
        else
          target.append(
            sectionHeading(
              document,
              artifact.kind === "evidence" ? "Browser evidence" : "Hatch",
              "Loading…",
            ),
            summaryState(document, "Checking the authenticated session state…"),
          );
        fragment.append(target);
        void evidenceStatus
          .load(sessionId, artifact.jobId)
          .then((evidence) => {
            if (generation !== currentGeneration) return;
            if (evidence) renderEvidence(document, target, sessionId, evidence);
            else renderUnavailable(document, target, artifact);
          })
          .catch(() => {
            if (
              generation === currentGeneration &&
              !evidenceStatus.current(sessionId, artifact.jobId)
            )
              renderUnavailable(document, target, artifact);
          });
      }
      root.replaceChildren(fragment);
    },
    reset() {
      generation += 1;
      renderedSignature = "";
      evidenceStatus.reset();
      hatchStatus.reset();
      root.replaceChildren(summaryState(document, "Loading the latest agent update…"));
    },
  };
}
