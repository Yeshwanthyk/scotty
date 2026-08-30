import {
  evidenceFailurePresentation,
  evidenceStatusLabel,
  orderedEvidenceFrames,
  orderedEvidenceSteps,
  shouldPollEvidence,
} from "./view.js";

const POLL_INTERVAL = 1_000;
const route = window.location.pathname.match(
  /^\/s\/([a-z0-9][a-z0-9-]{5,31})\/evidence(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,127}))?$/u,
);
const sessionId = route?.[1];
const jobId = route?.[2];
const content = document.querySelector("#content");
const pageTitle = document.querySelector("#page-title");
const pageSubtitle = document.querySelector("#page-subtitle");
const jobStatus = document.querySelector("#job-status");
const notice = document.querySelector("#notice");
const noticeText = document.querySelector("#notice-text");
const retry = document.querySelector("#retry");
const sessionLink = document.querySelector("#session-link");
const evidenceListLink = document.querySelector("#evidence-list-link");
const mobileSessionLink = document.querySelector("#session-link-mobile");
const mobileEvidenceListLink = document.querySelector("#evidence-list-link-mobile");
let pollTimer;

function addText(parent, className, text, tag = "div") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function apiPath() {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/evidence`;
  return jobId ? `${base}/${encodeURIComponent(jobId)}` : base;
}

function framePath(frameId) {
  return `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(
    jobId,
  )}/frames/${encodeURIComponent(frameId)}.png`;
}

function formatOffset(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function statusElement(status) {
  const element = document.createElement("span");
  element.className = "evidence-list-count";
  element.dataset.status = status;
  element.textContent = evidenceStatusLabel(status);
  return element;
}

function renderList(jobs) {
  pageTitle.textContent = "Browser evidence";
  pageSubtitle.textContent = jobs.length
    ? `${jobs.length} retained ${jobs.length === 1 ? "run" : "runs"}`
    : "Verified browser checkpoints will appear here.";
  jobStatus.hidden = true;
  content.replaceChildren();
  if (jobs.length === 0) {
    const state = addText(content, "state", "", "div");
    addText(state, "", "No evidence yet", "strong");
    state.append(document.createTextNode("Run a browser evidence job from this session to begin."));
    return;
  }
  const list = document.createElement("div");
  list.className = "evidence-list";
  for (const job of jobs) {
    const link = document.createElement("a");
    link.className = "evidence-list-item";
    link.href = `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(job.jobId)}`;
    addText(link, "evidence-list-title", `Evidence run ${job.sequence + 1}`);
    addText(link, "evidence-list-meta", formatDate(job.acceptedAt));
    const result = document.createElement("span");
    result.className = "evidence-list-count";
    result.append(statusElement(job.status));
    result.append(document.createTextNode(` · ${job.frameCount} frames`));
    link.append(result);
    list.append(link);
  }
  content.append(list);
}

function assertionText(assertion) {
  if (assertion.passed) return `${assertion.kind} passed`;
  const expected = assertion.expected === undefined ? "" : ` · expected ${assertion.expected}`;
  const actual = assertion.actual === undefined ? "" : ` · received ${assertion.actual}`;
  return `${assertion.kind} failed${expected}${actual}`;
}

function renderSteps(parent, summary) {
  const list = document.createElement("div");
  list.className = "evidence-step-list";
  for (const step of orderedEvidenceSteps(summary)) {
    const row = document.createElement("article");
    row.className = "evidence-step";
    row.dataset.status = step.status;
    addText(row, "evidence-step-index", String(step.index + 1).padStart(2, "0"));
    const body = document.createElement("div");
    addText(body, "evidence-step-name", step.name);
    addText(body, "evidence-step-action", step.action);
    for (const assertion of step.assertions) {
      const result = addText(body, "evidence-assertion", assertionText(assertion));
      result.dataset.passed = String(assertion.passed);
    }
    row.append(body);
    addText(row, "evidence-step-result", step.status === "passed" ? "Passed" : "Failed");
    list.append(row);
  }
  if (summary.steps.length === 0)
    addText(list, "evidence-frames-empty", "Waiting for the first completed step.");
  parent.append(list);
}

function renderScreenshots(parent, summary) {
  const frames = orderedEvidenceFrames(summary);
  const panel = document.createElement("section");
  panel.className = "evidence-frames-panel";
  panel.setAttribute("aria-label", "Verified screenshots");
  addText(panel, "evidence-frames-title", "Verified screenshots", "h2");
  if (frames.length === 0) {
    addText(
      panel,
      "evidence-frames-empty",
      "Screenshots appear after verified checkpoints complete.",
    );
    parent.append(panel);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "evidence-frames-grid";
  for (const frame of frames) {
    const figure = document.createElement("figure");
    const link = document.createElement("a");
    link.className = "evidence-frame-link";
    link.href = framePath(frame.frameId);
    link.setAttribute("aria-label", `Open ${frame.stepName} screenshot full size`);
    const image = document.createElement("img");
    image.src = framePath(frame.frameId);
    image.alt = frame.stepName;
    image.loading = "lazy";
    image.decoding = "async";
    link.append(image);
    figure.append(
      link,
      textCaption(
        `${frame.stepIndex + 1}. ${frame.stepName} · ${formatOffset(frame.offsetMillis)}`,
      ),
    );
    grid.append(figure);
  }
  panel.append(grid);
  parent.append(panel);
}

function textCaption(value) {
  const caption = document.createElement("figcaption");
  caption.textContent = value;
  return caption;
}

function renderSummary(summary) {
  pageTitle.textContent = `Evidence run ${summary.sequence + 1}`;
  const failure = evidenceFailurePresentation(summary.failure);
  pageSubtitle.textContent =
    failure === undefined
      ? summary.video
        ? "Verified screenshots and a real browser recording are available."
        : "Verified screenshots are available for this baseline run."
      : `${failure.detail}${failure.hint === undefined ? "" : ` ${failure.hint}`}`;
  jobStatus.hidden = false;
  jobStatus.dataset.status = summary.status;
  jobStatus.textContent = evidenceStatusLabel(summary.status);
  content.replaceChildren();

  const workspace = document.createElement("div");
  workspace.className = "evidence-workspace";
  const detail = document.createElement("section");
  detail.className = "evidence-detail";
  const summaryLine = document.createElement("p");
  summaryLine.className = "evidence-summary-line";
  addText(summaryLine, "", `${summary.completedSteps} / ${summary.totalSteps} steps`, "span");
  addText(summaryLine, "", `${summary.frameCount} frames`, "span");
  addText(summaryLine, "", formatDate(summary.acceptedAt), "span");
  detail.append(summaryLine);
  renderSteps(detail, summary);
  workspace.append(detail);
  renderScreenshots(workspace, summary);
  content.append(workspace);
}

function schedulePoll(active) {
  clearTimeout(pollTimer);
  if (active && !document.hidden) pollTimer = setTimeout(() => void refresh(), POLL_INTERVAL);
}

async function refresh() {
  if (!sessionId) return;
  content.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(apiPath(), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Evidence could not be loaded.");
    const payload = await response.json();
    notice.hidden = true;
    if (jobId) {
      renderSummary(payload);
      schedulePoll(shouldPollEvidence(payload, true));
    } else {
      const jobs = Array.isArray(payload) ? payload : [];
      renderList(jobs);
      schedulePoll(shouldPollEvidence(jobs, false));
    }
  } catch (error) {
    noticeText.textContent =
      error instanceof Error ? error.message : "Evidence could not be loaded.";
    notice.hidden = false;
    schedulePoll(true);
  } finally {
    content.setAttribute("aria-busy", "false");
  }
}

if (sessionId) {
  const sessionPath = `/s/${encodeURIComponent(sessionId)}`;
  const evidenceListPath = `${sessionPath}/evidence`;
  sessionLink.href = sessionPath;
  mobileSessionLink.href = sessionPath;
  evidenceListLink.href = evidenceListPath;
  mobileEvidenceListLink.href = evidenceListPath;
} else {
  noticeText.textContent = "Evidence route is invalid.";
  notice.hidden = false;
}
retry.addEventListener("click", () => void refresh());
document.addEventListener("visibilitychange", () => {
  schedulePoll(false);
  if (!document.hidden) void refresh();
});
void refresh();
