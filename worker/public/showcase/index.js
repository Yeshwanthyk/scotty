import { formatShowcaseDuration, showcaseLoadFailure, showcaseVideoState } from "./view.js";

const route = window.location.pathname.match(
  /^\/s\/([a-z0-9][a-z0-9-]{5,31})\/showcase\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u,
);
const sessionId = route?.[1];
const beforeJobId = route?.[2];
const afterJobId = route?.[3];
const content = document.querySelector("#content");
const subtitle = document.querySelector("#subtitle");
const status = document.querySelector("#status");
const notice = document.querySelector("#notice");
const noticeTitle = document.querySelector("#notice-title");
const noticeText = document.querySelector("#notice-text");
const sessionLink = document.querySelector("#session-link");
const hatchLink = document.querySelector("#hatch-link");
const retry = document.querySelector("#retry");

function text(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function framePath(jobId, frameId) {
  return `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(jobId)}/frames/${encodeURIComponent(frameId)}.png`;
}

function validJob(job) {
  return (
    job &&
    job.version === 2 &&
    job.status === "succeeded" &&
    typeof job.jobId === "string" &&
    Array.isArray(job.steps) &&
    job.steps.length > 0 &&
    job.steps.every(
      (step) =>
        step?.status === "passed" &&
        typeof step?.name === "string" &&
        typeof step?.frame?.frameId === "string" &&
        Array.isArray(step.assertions) &&
        step.assertions.every((assertion) => assertion?.passed === true),
    )
  );
}

function validShowcase(value) {
  return (
    value?.version === 2 &&
    validJob(value.before) &&
    validJob(value.after) &&
    value.before.jobId === beforeJobId &&
    value.after.jobId === afterJobId &&
    value.before.steps.length === value.after.steps.length &&
    value.after.video?.artifactId === "recording" &&
    typeof value.paths?.video === "string" &&
    typeof value.paths?.hatch === "string"
  );
}

function assertionCount(job) {
  return job.steps.reduce((total, step) => total + step.assertions.length, 0);
}

function stateMessage(title, detail) {
  const state = document.createElement("div");
  state.className = "state";
  state.append(text("strong", "", title), document.createTextNode(detail));
  return state;
}

function downloadLink(path, jobId) {
  const link = document.createElement("a");
  link.className = "button button-primary";
  link.textContent = "Download recording";
  link.href = path;
  link.download = `scotty-${jobId}-recording.webm`;
  link.setAttribute("aria-label", "Download browser recording (WebM)");
  return link;
}

function proofImage(label, job, step) {
  const figure = document.createElement("figure");
  figure.className = "showcase-proof";
  const image = document.createElement("img");
  image.src = framePath(job.jobId, step.frame.frameId);
  image.alt = `${label}: ${step.name}`;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "same-origin";
  figure.append(image, text("figcaption", "", label));
  return figure;
}

function render(showcase) {
  const viewport = showcase.after.viewport;
  const assertions = assertionCount(showcase.after);
  subtitle.textContent = `${showcase.after.steps.length} matched checkpoints · ${viewport.width} × ${viewport.height}`;
  status.textContent = `${assertions}/${assertions} assertions passed`;
  status.dataset.state = "passed";
  hatchLink.href = showcase.paths.hatch;
  content.replaceChildren();

  const videoSection = document.createElement("section");
  videoSection.className = "showcase-video-section";
  const heading = document.createElement("div");
  heading.className = "showcase-section-heading";
  heading.append(
    text("div", "", "AFTER FLOW"),
    text("h2", "", "Real browser recording"),
    text("p", "", "Recorded by the same browser run that passed the after assertions."),
  );
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.src = showcase.paths.video;
  video.setAttribute("aria-label", "Real browser recording");
  const lastStep = showcase.after.steps.at(-1);
  if (lastStep) video.poster = framePath(showcase.after.jobId, lastStep.frame.frameId);
  const videoFrame = document.createElement("div");
  videoFrame.className = "showcase-video-frame";
  videoFrame.append(video);

  const videoMeta = document.createElement("div");
  videoMeta.className = "showcase-video-meta";
  videoMeta.append(
    text("span", "showcase-video-kind", "WebM recording"),
    text("span", "showcase-video-duration", "Duration loading…"),
  );
  const videoActions = document.createElement("div");
  videoActions.className = "showcase-video-actions";
  videoActions.append(downloadLink(showcase.paths.video, showcase.after.jobId));

  const playbackError = document.createElement("div");
  playbackError.className = "showcase-video-error";
  playbackError.id = "showcase-video-error";
  playbackError.setAttribute("role", "alert");
  playbackError.hidden = true;
  const playbackState = showcaseVideoState("error");
  const playbackCopy = document.createElement("div");
  playbackCopy.append(
    text("strong", "", playbackState.label),
    text("span", "", playbackState.detail),
  );
  const playbackActions = document.createElement("div");
  playbackActions.className = "showcase-video-error-actions";
  const retryVideo = document.createElement("button");
  retryVideo.className = "button";
  retryVideo.textContent = "Retry recording";
  retryVideo.type = "button";
  playbackActions.append(retryVideo, downloadLink(showcase.paths.video, showcase.after.jobId));
  playbackError.append(playbackCopy, playbackActions);

  const duration = videoMeta.querySelector(".showcase-video-duration");
  const showPlaybackError = () => {
    playbackError.hidden = false;
    video.setAttribute("aria-describedby", playbackError.id);
    duration.textContent = "Duration unavailable";
  };
  video.addEventListener("loadedmetadata", () => {
    duration.textContent = formatShowcaseDuration(video.duration);
  });
  video.addEventListener("error", showPlaybackError);
  retryVideo.addEventListener("click", () => {
    playbackError.hidden = true;
    video.removeAttribute("aria-describedby");
    video.load();
    video.focus();
  });
  videoSection.append(heading, videoFrame, videoMeta, videoActions, playbackError);
  content.append(videoSection);

  const slices = document.createElement("section");
  slices.className = "showcase-slices";
  const sliceHeading = document.createElement("div");
  sliceHeading.className = "showcase-section-heading";
  sliceHeading.append(
    text("div", "", "MATCHED CHECKPOINTS"),
    text("h2", "", "What changed"),
    text("p", "", "Each pair uses the same viewport, action flow, and assertion set."),
  );
  slices.append(sliceHeading);
  showcase.after.steps.forEach((afterStep, index) => {
    const beforeStep = showcase.before.steps[index];
    const row = document.createElement("article");
    row.className = "showcase-slice";
    const rowHeading = document.createElement("div");
    rowHeading.className = "showcase-slice-heading";
    rowHeading.append(
      text("span", "showcase-step-number", String(index + 1).padStart(2, "0")),
      text("h3", "", afterStep.name),
      text("span", "showcase-step-pass", `${afterStep.assertions.length} checks passed`),
    );
    const pair = document.createElement("div");
    pair.className = "showcase-pair";
    pair.append(
      proofImage("Before", showcase.before, beforeStep),
      proofImage("After", showcase.after, afterStep),
    );
    row.append(rowHeading, pair);
    slices.append(row);
  });
  content.append(slices);
  content.setAttribute("aria-busy", "false");
}

function showLoadFailure(failure) {
  status.textContent = failure.title;
  status.dataset.state = "error";
  noticeTitle.textContent = failure.title;
  noticeText.textContent = failure.detail;
  retry.hidden = !failure.retry;
  notice.hidden = false;
  content.replaceChildren(stateMessage(failure.title, failure.detail));
  content.setAttribute("aria-busy", "false");
}

async function responseFailure(response) {
  let code;
  try {
    const payload = await response.json();
    code = payload?.error?.code;
  } catch {
    // The HTTP status is still a useful boundary signal when the body is not JSON.
  }
  return showcaseLoadFailure({ status: response.status, code });
}

async function load() {
  notice.hidden = true;
  retry.hidden = true;
  content.setAttribute("aria-busy", "true");
  try {
    if (!sessionId || !beforeJobId || !afterJobId) {
      showLoadFailure(showcaseLoadFailure({ code: "malformed" }));
      return;
    }
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/showcase/${encodeURIComponent(beforeJobId)}/${encodeURIComponent(afterJobId)}`,
      { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      showLoadFailure(await responseFailure(response));
      return;
    }
    let showcase;
    try {
      showcase = await response.json();
    } catch {
      showLoadFailure(showcaseLoadFailure({ status: response.status, code: "malformed" }));
      return;
    }
    if (!validShowcase(showcase)) {
      showLoadFailure(showcaseLoadFailure({ status: response.status, code: "malformed" }));
      return;
    }
    render(showcase);
  } catch {
    showLoadFailure(showcaseLoadFailure());
  }
}

sessionLink.href = sessionId ? `/s/${encodeURIComponent(sessionId)}` : "/sessions";
retry.addEventListener("click", () => void load());
void load();
