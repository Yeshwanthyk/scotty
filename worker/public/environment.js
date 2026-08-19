const elements = {
  form: document.querySelector("#environment-form"),
  formError: document.querySelector("#form-error"),
  listError: document.querySelector("#list-error"),
  loading: document.querySelector("#loading"),
  name: document.querySelector("#name"),
  protected: document.querySelector("#protected"),
  refresh: document.querySelector("#refresh"),
  repository: document.querySelector("#repository"),
  revision: document.querySelector("#revision"),
  scopeTitle: document.querySelector("#scope-title"),
  secret: document.querySelector("#secret"),
  sessionList: document.querySelector("#environment-sessions"),
  sessionsError: document.querySelector("#sessions-error"),
  sessionsLoading: document.querySelector("#sessions-loading"),
  value: document.querySelector("#value"),
  approvalContent: document.querySelector("#approvals-content"),
  approvalDecisions: document.querySelector("#approvals-decisions"),
  approvalDecisionsEmpty: document.querySelector("#approvals-decisions-empty"),
  approvalError: document.querySelector("#approvals-error"),
  approvalErrorMessage: document.querySelector("#approvals-error-message"),
  approvalLoading: document.querySelector("#approvals-loading"),
  approvalPending: document.querySelector("#approvals-pending"),
  approvalPendingEmpty: document.querySelector("#approvals-pending-empty"),
  approvalRetry: document.querySelector("#approvals-retry"),
  variables: document.querySelector("#variables"),
};

const approvalBusy = new Set();
let approvalData = { approvals: [], pending: [] };

async function errorMessage(response, fallback) {
  const body = await response.json().catch(() => undefined);
  return body?.error?.message || fallback;
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

function row(title, detail, action) {
  const item = document.createElement("li");
  item.className = "client";
  const identity = document.createElement("div");
  const heading = document.createElement("p");
  heading.className = "client-label";
  heading.textContent = title;
  const meta = document.createElement("div");
  meta.className = "client-meta";
  meta.textContent = detail;
  identity.append(heading, meta);
  item.append(identity);
  if (action) item.append(action);
  return item;
}

function actionButton(name, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "remove" ? "button button-danger" : "button";
  button.dataset[action] = name;
  button.textContent = action === "remove" ? "Remove" : "Override";
  return button;
}

function environmentPath(path = "/api/environment") {
  return elements.repository.value
    ? `${path}?repo=${encodeURIComponent(elements.repository.value)}`
    : path;
}

function isApprovalEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.sourceScope === "string" &&
    typeof entry.name === "string" &&
    typeof entry.origin === "string"
  );
}

function approvalKey(entry) {
  return `${entry.sourceScope}\u0000${entry.name}\u0000${entry.origin}`;
}

function approvalActionButton(entry, action, label, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button${danger ? " button-danger" : ""}`;
  button.dataset.approvalAction = action;
  button.dataset.sourceScope = entry.sourceScope;
  button.dataset.name = entry.name;
  button.dataset.origin = entry.origin;
  button.disabled = approvalBusy.has(approvalKey(entry));
  button.textContent = button.disabled ? "Working…" : label;
  return button;
}

function approvalRow(entry, pending) {
  const actions = document.createElement("div");
  actions.className = "client-actions";
  if (pending) {
    actions.append(
      approvalActionButton(entry, "approve", "Approve"),
      approvalActionButton(entry, "reject", "Reject", true),
    );
  } else if (entry.decision !== "revoked") {
    actions.append(approvalActionButton(entry, "revoke", "Revoke", true));
  } else {
    const status = document.createElement("span");
    status.className = "client-meta";
    status.textContent = "Already revoked";
    actions.append(status);
  }
  const detail = pending
    ? `Observed ${entry.origin} · first ${entry.firstObservedAt} · last ${entry.lastObservedAt}`
    : `${entry.origin} · ${entry.decision} · updated ${entry.updatedAt}`;
  return row(`${entry.name} · ${entry.sourceScope}`, detail, actions);
}

function renderApprovals(body) {
  const pending = (Array.isArray(body?.pending) ? body.pending : []).filter(isApprovalEntry);
  const approvals = (Array.isArray(body?.approvals) ? body.approvals : []).filter(
    (entry) =>
      isApprovalEntry(entry) && ["approved", "rejected", "revoked"].includes(entry.decision),
  );
  approvalData = { approvals, pending };
  elements.approvalPending.replaceChildren(...pending.map((entry) => approvalRow(entry, true)));
  elements.approvalPendingEmpty.hidden = pending.length !== 0;
  elements.approvalDecisions.replaceChildren(
    ...approvals.map((entry) => approvalRow(entry, false)),
  );
  elements.approvalDecisionsEmpty.hidden = approvals.length !== 0;
}

function setApprovalLoading() {
  elements.approvalLoading.hidden = false;
  elements.approvalContent.hidden = true;
  elements.approvalError.hidden = true;
  elements.approvalRetry.disabled = true;
}

function showApprovalError(error, hideContent = true) {
  elements.approvalErrorMessage.textContent =
    error instanceof Error ? error.message : "Couldn't load environment approvals.";
  elements.approvalError.hidden = false;
  elements.approvalRetry.disabled = false;
  if (hideContent) elements.approvalContent.hidden = true;
}

async function loadApprovals() {
  setApprovalLoading();
  try {
    const body = await fetchJson(
      environmentPath("/api/environment/approvals"),
      undefined,
      "Couldn't load environment approvals.",
    );
    renderApprovals(body);
    elements.approvalContent.hidden = false;
  } catch (error) {
    showApprovalError(error);
  } finally {
    elements.approvalLoading.hidden = true;
  }
}

function render(body) {
  const variables = Array.isArray(body?.variables) ? body.variables : [];
  const protectedBindings = Array.isArray(body?.protectedBindings) ? body.protectedBindings : [];
  const repositoryScope = elements.repository.value !== "";
  elements.scopeTitle.textContent = repositoryScope
    ? `${elements.repository.value} environment`
    : "Global environment";
  elements.revision.textContent = `Revision ${Number.isInteger(body?.revision) ? body.revision : "unknown"}`;
  elements.variables.replaceChildren(
    ...variables.map((variable) => {
      const inherited = repositoryScope && variable.source !== "repo";
      const value = variable.secret
        ? "Secret · configured · value hidden"
        : `Plain · ${variable.value ?? ""}`;
      const source = repositoryScope
        ? inherited
          ? " · inherited from global"
          : " · repository override"
        : "";
      return row(
        variable.name,
        `${value}${source}`,
        actionButton(variable.name, inherited ? "override" : "remove"),
      );
    }),
  );
  if (variables.length === 0) elements.variables.append(row("No user variables", "Set one above."));
  elements.protected.replaceChildren(
    ...protectedBindings.map((binding) =>
      row(
        binding.name,
        `${binding.destination === "file" ? `File ${binding.path}` : "Process environment"} · ${binding.source} · value hidden`,
      ),
    ),
  );
  elements.loading.hidden = true;
}

async function loadSessionStatuses() {
  elements.sessionsError.hidden = true;
  elements.sessionsLoading.hidden = false;
  try {
    const sessions = await fetchJson("/api/sessions", undefined, "Couldn't load sessions.");
    const relevant = (Array.isArray(sessions) ? sessions : []).filter(
      (session) => !elements.repository.value || session.repo === elements.repository.value,
    );
    const statuses = await Promise.all(
      relevant.map((session) =>
        fetchJson(
          `/api/sessions/${encodeURIComponent(session.id)}/environment`,
          undefined,
          `Couldn't load environment status for ${session.id}.`,
        ),
      ),
    );
    elements.sessionList.replaceChildren(
      ...statuses.map((status) => {
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "button";
        refresh.dataset.refreshSession = status.id;
        refresh.textContent = "Refresh";
        refresh.disabled = !status.refreshable || !status.stale;
        return row(
          status.title,
          `${status.repo} · ${status.status} · applied ${status.appliedRevision ?? "none"} · current ${status.currentEffectiveRevision} · ${status.stale ? "stale" : "current"}`,
          refresh,
        );
      }),
    );
    if (statuses.length === 0)
      elements.sessionList.append(row("No relevant sessions", "No sessions use this scope."));
  } catch (error) {
    elements.sessionsError.textContent =
      error instanceof Error ? error.message : "Couldn't load session environment status.";
    elements.sessionsError.hidden = false;
  } finally {
    elements.sessionsLoading.hidden = true;
  }
}

async function refreshSession(id, button) {
  button.disabled = true;
  elements.sessionsError.hidden = true;
  try {
    await fetchJson(
      `/api/sessions/${encodeURIComponent(id)}/environment/refresh`,
      { method: "POST" },
      `Couldn't refresh environment for ${id}.`,
    );
    await loadSessionStatuses();
  } catch (error) {
    elements.sessionsError.textContent =
      error instanceof Error ? error.message : "Couldn't refresh the session environment.";
    elements.sessionsError.hidden = false;
    button.disabled = false;
  }
}

async function performApproval(button) {
  const { approvalAction: action, sourceScope, name, origin } = button.dataset;
  if (
    !action ||
    !["approve", "reject", "revoke"].includes(action) ||
    !sourceScope ||
    !name ||
    !origin
  )
    return;
  const key = `${sourceScope}\u0000${name}\u0000${origin}`;
  if (approvalBusy.has(key)) return;
  approvalBusy.add(key);
  renderApprovals(approvalData);
  try {
    await fetchJson(
      `/api/environment/approvals/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceScope, name, origin }),
      },
      `Couldn't ${action} environment approval.`,
    );
    await loadApprovals();
  } catch (error) {
    showApprovalError(error, false);
  } finally {
    approvalBusy.delete(key);
    renderApprovals(approvalData);
  }
}

async function load() {
  elements.refresh.disabled = true;
  elements.listError.hidden = true;
  try {
    render(await fetchJson(environmentPath(), undefined, "Couldn't load the environment."));
    await Promise.all([loadSessionStatuses(), loadApprovals()]);
  } catch (error) {
    elements.listError.textContent =
      error instanceof Error ? error.message : "Couldn't load the environment.";
    elements.listError.hidden = false;
  } finally {
    elements.refresh.disabled = false;
  }
}

async function setVariable(event) {
  event.preventDefault();
  elements.formError.hidden = true;
  const submit = elements.form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await fetchJson(
      environmentPath(`/api/environment/${encodeURIComponent(elements.name.value.trim())}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: elements.value.value, secret: elements.secret.checked }),
      },
      "Couldn't set the variable.",
    );
    elements.value.value = "";
    await load();
  } catch (error) {
    elements.formError.textContent =
      error instanceof Error ? error.message : "Couldn't set the variable.";
    elements.formError.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

async function removeVariable(name, button) {
  button.disabled = true;
  try {
    await fetchJson(
      environmentPath(`/api/environment/${encodeURIComponent(name)}`),
      { method: "DELETE" },
      "Couldn't remove the variable.",
    );
    await load();
  } catch (error) {
    elements.listError.textContent =
      error instanceof Error ? error.message : "Couldn't remove the variable.";
    elements.listError.hidden = false;
    button.disabled = false;
  }
}

async function loadRepositories() {
  try {
    const repositories = await fetchJson("/api/repos", undefined, "Couldn't load repositories.");
    for (const entry of Array.isArray(repositories) ? repositories : []) {
      if (typeof entry?.repo !== "string") continue;
      const option = document.createElement("option");
      option.value = entry.repo;
      option.textContent = entry.repo;
      elements.repository.append(option);
    }
  } catch (error) {
    elements.listError.textContent =
      error instanceof Error ? error.message : "Couldn't load repositories.";
    elements.listError.hidden = false;
  }
}

elements.secret.addEventListener("change", () => {
  elements.value.type = elements.secret.checked ? "password" : "text";
});
elements.form.addEventListener("submit", (event) => void setVariable(event));
elements.refresh.addEventListener("click", () => void load());
elements.repository.addEventListener("change", () => void load());
elements.approvalRetry.addEventListener("click", () => void loadApprovals());
elements.approvalContent.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-approval-action]");
  if (button) void performApproval(button);
});
elements.variables.addEventListener("click", (event) => {
  const remove = event.target.closest("button[data-remove]");
  if (remove) void removeVariable(remove.dataset.remove, remove);
  const override = event.target.closest("button[data-override]");
  if (override) {
    elements.name.value = override.dataset.override;
    elements.value.value = "";
    elements.value.focus();
  }
});
elements.sessionList.addEventListener("click", (event) => {
  const refresh = event.target.closest("button[data-refresh-session]");
  if (refresh) void refreshSession(refresh.dataset.refreshSession, refresh);
});
void loadRepositories().then(load);
