import { displayDate, statsResponse } from "/stats-view.js";

const elements = {
  content: document.querySelector("#project-content"),
  devices: document.querySelector("#devices"),
  devicesMobile: document.querySelector("#devices-mobile"),
  metrics: document.querySelector("#overall-stats"),
  projects: document.querySelector("#projects"),
  providers: document.querySelector("#providers"),
  providersMobile: document.querySelector("#providers-mobile"),
  status: document.querySelector("#load-status"),
  tracking: document.querySelector("#tracking"),
  values: {
    workspacesCreated: document.querySelector('[data-stat="workspaces-created"]'),
    projects: document.querySelector('[data-stat="projects"]'),
    warmNow: document.querySelector('[data-stat="warm-now"]'),
    stoppedNow: document.querySelector('[data-stat="stopped-now"]'),
  },
};

function addText(parent, className, value, tag = "div") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function setLoading() {
  elements.metrics.setAttribute("aria-busy", "true");
  elements.content.setAttribute("aria-busy", "true");
  elements.status.textContent = "Loading workspace stats…";
  elements.tracking.textContent = "Loading tracking history…";
  for (const value of Object.values(elements.values)) {
    value.textContent = "—";
    value.classList.add("is-loading");
  }
  elements.content.replaceChildren();
  for (let index = 0; index < 2; index += 1) {
    const row = document.createElement("div");
    row.className = "project-skeleton";
    row.setAttribute("aria-hidden", "true");
    row.append(document.createElement("span"), document.createElement("span"));
    elements.content.append(row);
  }
}

function setMetricValues(overall) {
  elements.values.workspacesCreated.textContent = String(overall.workspacesCreated);
  elements.values.projects.textContent = String(overall.projects);
  elements.values.warmNow.textContent = String(overall.warmNow);
  elements.values.stoppedNow.textContent = String(overall.stoppedNow);
  for (const value of Object.values(elements.values)) value.classList.remove("is-loading");
  elements.metrics.setAttribute("aria-busy", "false");
}

function projectRow(project) {
  const item = document.createElement("li");
  item.className = "project-row";
  addText(item, "project-repository", project.repository, "h3");

  const details = document.createElement("dl");
  const fields = [
    ["Workspaces created", project.workspacesCreated],
    ["Warm now", project.warmNow],
    ["Stopped now", project.stoppedNow],
    ["Last created", displayDate(project.lastCreated) ?? "Unknown"],
  ];
  for (const [label, value] of fields) {
    const field = document.createElement("div");
    addText(field, "project-label", label, "dt");
    addText(field, "project-value", String(value), "dd");
    details.append(field);
  }
  item.append(details);
  return item;
}

function render(stats) {
  setMetricValues(stats.overall);
  elements.status.textContent = "Workspace stats loaded.";
  elements.tracking.textContent = stats.trackingSince
    ? `Tracking since ${displayDate(stats.trackingSince) ?? "the first retained workspace"}`
    : "Tracking starts with your next workspace.";
  elements.content.replaceChildren();
  elements.content.setAttribute("aria-busy", "false");
  if (stats.projects.length === 0) {
    const empty = addText(elements.content, "empty-state", "", "div");
    addText(empty, "empty-title", "No workspace history yet", "strong");
    addText(
      empty,
      "empty-copy",
      "New workspaces will appear here after they first reach warm.",
      "p",
    );
    return;
  }
  elements.projects.replaceChildren(...stats.projects.map(projectRow));
  elements.content.append(elements.projects);
}

function renderError(message) {
  elements.metrics.setAttribute("aria-busy", "false");
  elements.content.setAttribute("aria-busy", "false");
  elements.status.textContent = "Workspace stats failed to load.";
  elements.tracking.textContent = "Tracking history unavailable.";
  for (const value of Object.values(elements.values)) {
    value.textContent = "—";
    value.classList.remove("is-loading");
  }
  const error = document.createElement("div");
  error.className = "error-state";
  error.setAttribute("role", "alert");
  addText(error, "error-title", "Stats could not be loaded", "strong");
  addText(error, "error-copy", message, "p");
  const retry = addText(error, "button", "Retry", "button");
  retry.type = "button";
  retry.addEventListener("click", () => void load());
  elements.content.replaceChildren(error);
}

async function load() {
  setLoading();
  try {
    const response = await fetch("/api/stats", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body?.error?.message || "Scotty could not load workspace stats.");
    const stats = statsResponse(body);
    if (!stats) throw new Error("Scotty returned an unexpected stats response.");
    render(stats);
  } catch (error) {
    renderError(error instanceof Error ? error.message : "Scotty could not load workspace stats.");
  }
}

async function loadOwnerNavigation() {
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const me = await response.json();
    const owner = me?.client?.role === "owner";
    elements.devices.hidden = !owner;
    elements.devicesMobile.hidden = !owner;
    elements.providers.hidden = !owner;
    elements.providersMobile.hidden = !owner;
  } catch {
    // Navigation remains limited to non-owner pages when role lookup is unavailable.
  }
}

void loadOwnerNavigation();
void load();
