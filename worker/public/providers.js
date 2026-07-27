const elements = {
  error: document.querySelector("#error"),
  providers: document.querySelector("#providers"),
  refresh: document.querySelector("#refresh"),
  runners: document.querySelector("#runners"),
};

const busy = new Set();
const rowErrors = new Map();
let providers = [];
let runners = [];
let fetching = false;
let pollTimer;

async function errorMessage(response, fallback) {
  try {
    const body = await response.json();
    return body?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

async function fetchJson(path, init, fallback) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) throw new Error(await errorMessage(response, fallback));
  return response.json();
}

function text(parent, className, value, tag = "div") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function state(value) {
  const element = document.createElement("span");
  element.className = `state state-${value}`;
  element.textContent = value;
  return element;
}

function providerDescription(provider) {
  if (provider.name === "cloudflare")
    return "Cloudflare Sandbox sessions use the control plane's native runtime.";
  if (provider.name === "runner")
    return "Portable sessions require an accepting runner with a live connection.";
  return "Provider configuration reported by the Scotty control plane.";
}

function renderProviders() {
  elements.providers.replaceChildren();
  elements.providers.setAttribute("aria-busy", "false");
  for (const provider of providers) {
    const row = document.createElement("div");
    row.className = "provider-row";
    const identity = document.createElement("div");
    text(identity, "provider-name", provider.name);
    text(identity, "provider-description", providerDescription(provider));
    row.append(identity, state(provider.status));
    elements.providers.append(row);
  }
}

function lastSeen(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "never";
}

function actionButton(runner, action, label, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button${danger ? " button-danger" : ""}`;
  button.dataset.runner = runner;
  button.dataset.action = action;
  button.disabled = busy.has(runner);
  button.textContent = busy.has(runner) ? "Working…" : label;
  return button;
}

function renderRunners() {
  elements.runners.replaceChildren();
  elements.runners.setAttribute("aria-busy", "false");
  if (runners.length === 0) {
    text(elements.runners, "empty-row", "No runner is configured for this deployment.");
    return;
  }
  for (const runner of runners) {
    const row = document.createElement("div");
    row.className = "runner-row";
    const identity = document.createElement("div");
    text(identity, "runner-name", runner.name);
    text(
      identity,
      "runner-meta",
      `${runner.assignedSessions} assigned · last seen ${lastSeen(runner.lastSeenAt)}`,
    );
    if (rowErrors.has(runner.name)) {
      const error = text(identity, "page-error", rowErrors.get(runner.name));
      error.setAttribute("role", "alert");
    }

    const controls = document.createElement("div");
    const statuses = document.createElement("div");
    statuses.className = "runner-statuses";
    statuses.append(state(runner.desired), state(runner.connection));
    const actions = document.createElement("div");
    actions.className = "runner-actions";
    if (runner.desired !== "accepting")
      actions.append(actionButton(runner.name, "enable", "Enable"));
    if (runner.desired === "accepting") actions.append(actionButton(runner.name, "drain", "Drain"));
    if (runner.desired !== "disabled")
      actions.append(actionButton(runner.name, "disable", "Disable", true));
    if (runner.connection === "connected")
      actions.append(actionButton(runner.name, "disconnect", "Disconnect"));
    controls.append(statuses, actions);
    row.append(identity, controls);
    elements.runners.append(row);
  }
}

async function refresh() {
  if (fetching) return;
  fetching = true;
  elements.refresh.disabled = true;
  elements.error.hidden = true;
  try {
    const [nextProviders, nextRunners] = await Promise.all([
      fetchJson("/api/providers", undefined, "Provider status could not be loaded."),
      fetchJson("/api/runners", undefined, "Runner status could not be loaded."),
    ]);
    if (!Array.isArray(nextProviders) || !Array.isArray(nextRunners))
      throw new Error("Scotty returned an unexpected provider response.");
    providers = nextProviders;
    runners = nextRunners;
    renderProviders();
    renderRunners();
  } catch (error) {
    elements.error.textContent =
      error instanceof Error ? error.message : "Provider status could not be loaded.";
    elements.error.hidden = false;
  } finally {
    fetching = false;
    elements.refresh.disabled = false;
  }
}

async function perform(runner, action) {
  if (busy.has(runner)) return;
  busy.add(runner);
  rowErrors.delete(runner);
  renderRunners();
  try {
    const updated = await fetchJson(
      `/api/runners/${encodeURIComponent(runner)}/${action}`,
      { method: "POST" },
      `Runner could not ${action}.`,
    );
    runners = runners.map((candidate) => (candidate.name === runner ? updated : candidate));
  } catch (error) {
    rowErrors.set(runner, error instanceof Error ? error.message : `Runner could not ${action}.`);
  } finally {
    busy.delete(runner);
    renderRunners();
    void refresh();
  }
}

elements.runners.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-runner][data-action]");
  if (!button) return;
  void perform(button.dataset.runner, button.dataset.action);
});

function schedulePoll() {
  clearInterval(pollTimer);
  if (!document.hidden) pollTimer = setInterval(() => void refresh(), 5_000);
}

document.addEventListener("visibilitychange", () => {
  schedulePoll();
  if (!document.hidden) void refresh();
});
elements.refresh.addEventListener("click", () => void refresh());

schedulePoll();
void refresh();
