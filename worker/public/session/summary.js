import { artifactForTool } from "./artifacts.js";
import { conversationTurns, renderSafeMarkdown, sanitizeText } from "./chat.js";
import { orderedEvidenceFrames } from "../evidence/view.js";

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
const HATCH_STATES = new Set(["starting", "running", "sleeping", "unhealthy", "stopped", "failed"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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
  const video = value.video;
  if (video !== undefined && !isSummaryVideo(video)) return undefined;
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
    ...(video === undefined
      ? {}
      : {
          video: {
            artifactId: video.artifactId,
            sha256: video.sha256,
            bytes: video.bytes,
            capturedAt: video.capturedAt,
            offsetMillis: video.offsetMillis,
          },
        }),
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
    observedStatus: value.observedStatus,
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
  target.replaceChildren(sectionHeading(document, "Browser evidence", "Verified run"), meta);
  if (frames.childNodes.length > 0) target.append(frames);
  target.append(link);
}

function renderHatch(document, target, sessionId, hatch) {
  if (!hatch.configured) {
    target.replaceChildren(
      sectionHeading(document, "Hatch", "Not configured"),
      summaryState(document, "No Hatch is configured for this session."),
    );
    return;
  }
  const meta = document.createElement("p");
  meta.className = "summary-meta";
  meta.textContent = hatch.available
    ? `${hatch.observedStatus} · public HTTPS ready`
    : `${hatch.observedStatus} · public HTTPS unavailable`;
  target.replaceChildren(sectionHeading(document, "Hatch", hatch.serviceName), meta);
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

export function createSummaryView({ document, root, baseUrl, fetch }) {
  let generation = 0;
  let renderedSignature = "";
  return {
    render(projection, sessionId) {
      const summary = summaryProjection(projection, sessionId);
      const signature = JSON.stringify([sessionId, projection.sequence, summary]);
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
      hatchTarget.dataset.currentHatch = "";
      hatchTarget.append(
        sectionHeading(document, "Hatch", "Loading…"),
        summaryState(document, "Checking the current authenticated session state…"),
      );
      fragment.append(hatchTarget);
      void fetchJson(fetch, `/api/sessions/${encodeURIComponent(sessionId)}/hatch`)
        .then((value) => {
          if (generation !== currentGeneration) return;
          const hatch = decodeSummaryHatch(value);
          if (hatch) renderHatch(document, hatchTarget, sessionId, hatch);
          else
            hatchTarget.replaceChildren(
              sectionHeading(document, "Hatch", "Unavailable"),
              summaryState(document, "Current Hatch status could not be verified."),
            );
        })
        .catch(() => {
          if (generation === currentGeneration)
            hatchTarget.replaceChildren(
              sectionHeading(document, "Hatch", "Unavailable"),
              summaryState(document, "Current Hatch status could not be loaded."),
            );
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
        target.append(
          sectionHeading(
            document,
            artifact.kind === "evidence" ? "Browser evidence" : "Hatch",
            "Loading…",
          ),
          summaryState(document, "Checking the authenticated session state…"),
        );
        fragment.append(target);
        const path = `/api/sessions/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(artifact.jobId)}`;
        void fetchJson(fetch, path)
          .then((value) => {
            if (generation !== currentGeneration) return;
            const evidence = decodeSummaryEvidence(value, artifact.jobId);
            if (evidence) renderEvidence(document, target, sessionId, evidence);
            else renderUnavailable(document, target, artifact);
          })
          .catch(() => {
            if (generation === currentGeneration) renderUnavailable(document, target, artifact);
          });
      }
      root.replaceChildren(fragment);
    },
    reset() {
      generation += 1;
      renderedSignature = "";
      root.replaceChildren(summaryState(document, "Loading the latest agent update…"));
    },
  };
}
