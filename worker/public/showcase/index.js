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
const noticeText = document.querySelector("#notice-text");
const sessionLink = document.querySelector("#session-link");
const hatchLink = document.querySelector("#hatch-link");

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
  const lastStep = showcase.after.steps.at(-1);
  if (lastStep) video.poster = framePath(showcase.after.jobId, lastStep.frame.frameId);
  videoSection.append(heading, video);
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

async function load() {
  notice.hidden = true;
  content.setAttribute("aria-busy", "true");
  try {
    if (!sessionId || !beforeJobId || !afterJobId) throw new Error("invalid route");
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/showcase/${encodeURIComponent(beforeJobId)}/${encodeURIComponent(afterJobId)}`,
      { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (!response.ok) throw new Error("showcase unavailable");
    const showcase = await response.json();
    if (!validShowcase(showcase)) throw new Error("invalid showcase");
    render(showcase);
  } catch {
    status.textContent = "Unavailable";
    delete status.dataset.state;
    noticeText.textContent = "This matched Showcase is unavailable or has expired.";
    notice.hidden = false;
    content.replaceChildren(text("div", "state", "Scotty could not load this Showcase."));
    content.setAttribute("aria-busy", "false");
  }
}

sessionLink.href = sessionId ? `/s/${encodeURIComponent(sessionId)}` : "/sessions";
document.querySelector("#retry").addEventListener("click", () => void load());
void load();
