import {
  evidenceStatusLabel,
  orderedReplayFrames,
  replayDelayMillis,
  shouldPollEvidence,
} from "/evidence-view.js";

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
let pollTimer;
let playTimer;
let playing = false;
let selectedFrameId;
let currentFrames = [];
let currentFrameIndex = 0;

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
  pauseReplay();
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
  for (const step of summary.steps) {
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
    addText(list, "replay-empty", "Waiting for the first completed step.");
  parent.append(list);
}

function selectFrame(index) {
  if (currentFrames.length === 0) return;
  currentFrameIndex = Math.max(0, Math.min(currentFrames.length - 1, index));
  selectedFrameId = currentFrames[currentFrameIndex].frameId;
  const frame = currentFrames[currentFrameIndex];
  const image = document.querySelector("#replay-image");
  if (image) {
    image.src = framePath(frame.frameId);
    image.alt = `${frame.stepName}, checkpoint ${currentFrameIndex + 1} of ${currentFrames.length}`;
  }
  const scrubber = document.querySelector("#replay-scrubber");
  if (scrubber) scrubber.value = String(currentFrameIndex);
  const time = document.querySelector("#replay-time");
  if (time)
    time.textContent = `${formatOffset(frame.offsetMillis)} / ${formatOffset(
      currentFrames.at(-1)?.offsetMillis ?? 0,
    )}`;
  const caption = document.querySelector("#replay-caption-name");
  if (caption) caption.textContent = frame.stepName;
  for (const [buttonIndex, button] of [...document.querySelectorAll(".replay-frame")].entries()) {
    button.setAttribute("aria-current", buttonIndex === currentFrameIndex ? "true" : "false");
  }
}

function scheduleReplay() {
  clearTimeout(playTimer);
  if (!playing || currentFrameIndex >= currentFrames.length - 1) {
    if (currentFrameIndex >= currentFrames.length - 1) pauseReplay();
    return;
  }
  playTimer = setTimeout(
    () => {
      selectFrame(currentFrameIndex + 1);
      scheduleReplay();
    },
    replayDelayMillis(currentFrames, currentFrameIndex),
  );
}

function pauseReplay() {
  playing = false;
  clearTimeout(playTimer);
  const button = document.querySelector("#replay-toggle");
  if (button) button.textContent = "Play";
}

function toggleReplay() {
  if (currentFrames.length < 2) return;
  playing = !playing;
  const button = document.querySelector("#replay-toggle");
  if (button) button.textContent = playing ? "Pause" : "Play";
  if (playing && currentFrameIndex >= currentFrames.length - 1) selectFrame(0);
  scheduleReplay();
}

function renderReplay(parent, summary) {
  currentFrames = orderedReplayFrames(summary);
  const previousIndex = currentFrames.findIndex((frame) => frame.frameId === selectedFrameId);
  currentFrameIndex = previousIndex >= 0 ? previousIndex : Math.max(0, currentFrames.length - 1);

  const panel = document.createElement("section");
  panel.className = "replay-panel";
  panel.setAttribute("aria-label", "Screenshot replay");
  const stage = document.createElement("div");
  stage.className = "replay-stage";
  if (currentFrames.length === 0) {
    addText(
      stage,
      "replay-empty",
      "Replay begins when the first verified screenshot is available.",
    );
    panel.append(stage);
    parent.append(panel);
    return;
  }

  const image = document.createElement("img");
  image.id = "replay-image";
  image.decoding = "async";
  stage.append(image);
  panel.append(stage);

  const toolbar = document.createElement("div");
  toolbar.className = "replay-toolbar";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "replay-toggle";
  toggle.className = "button";
  toggle.textContent = playing ? "Pause" : "Play";
  toggle.disabled = currentFrames.length < 2;
  toggle.addEventListener("click", toggleReplay);
  const scrubber = document.createElement("input");
  scrubber.id = "replay-scrubber";
  scrubber.className = "replay-scrubber";
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.max = String(currentFrames.length - 1);
  scrubber.step = "1";
  scrubber.setAttribute("aria-label", "Replay frame");
  scrubber.addEventListener("input", () => {
    pauseReplay();
    selectFrame(Number(scrubber.value));
  });
  const time = document.createElement("span");
  time.id = "replay-time";
  time.className = "replay-time";
  toolbar.append(toggle, scrubber, time);
  panel.append(toolbar);

  const caption = document.createElement("div");
  caption.className = "replay-caption";
  addText(caption, "", "", "span").id = "replay-caption-name";
  addText(caption, "", `${currentFrames.length} verified frames`, "span");
  panel.append(caption);

  const strip = document.createElement("div");
  strip.className = "replay-strip";
  strip.setAttribute("aria-label", "Replay frames");
  currentFrames.forEach((frame, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "replay-frame";
    button.setAttribute("aria-label", `Show checkpoint ${index + 1}: ${frame.stepName}`);
    const thumbnail = document.createElement("img");
    thumbnail.src = framePath(frame.frameId);
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    button.append(thumbnail);
    button.addEventListener("click", () => {
      pauseReplay();
      selectFrame(index);
    });
    strip.append(button);
  });
  panel.append(strip);
  parent.append(panel);
  selectFrame(currentFrameIndex);
  if (playing) scheduleReplay();
}

function renderSummary(summary) {
  pageTitle.textContent = `Evidence run ${summary.sequence + 1}`;
  pageSubtitle.textContent =
    summary.failure?.code === "assertion_mismatch"
      ? `A required assertion failed at step ${(summary.failure.step ?? 0) + 1}.`
      : "Ordered screenshots are review evidence, not continuous video.";
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
  renderReplay(workspace, summary);
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
  sessionLink.href = `/s/${encodeURIComponent(sessionId)}`;
  evidenceListLink.href = `/s/${encodeURIComponent(sessionId)}/evidence`;
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
