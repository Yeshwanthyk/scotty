const elements = {
  form: document.querySelector("#environment-form"),
  formError: document.querySelector("#form-error"),
  listError: document.querySelector("#list-error"),
  loading: document.querySelector("#loading"),
  name: document.querySelector("#name"),
  protected: document.querySelector("#protected"),
  refresh: document.querySelector("#refresh"),
  revision: document.querySelector("#revision"),
  secret: document.querySelector("#secret"),
  value: document.querySelector("#value"),
  variables: document.querySelector("#variables"),
};

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

function removeButton(name) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-danger";
  button.dataset.name = name;
  button.textContent = "Remove";
  return button;
}

function render(body) {
  const variables = Array.isArray(body?.variables) ? body.variables : [];
  const protectedBindings = Array.isArray(body?.protectedBindings) ? body.protectedBindings : [];
  elements.revision.textContent = `Revision ${Number.isInteger(body?.revision) ? body.revision : "unknown"}`;
  elements.variables.replaceChildren(
    ...variables.map((variable) =>
      row(
        variable.name,
        variable.secret ? "Secret · configured · value hidden" : `Plain · ${variable.value ?? ""}`,
        removeButton(variable.name),
      ),
    ),
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

async function load() {
  elements.refresh.disabled = true;
  elements.listError.hidden = true;
  try {
    render(await fetchJson("/api/environment", undefined, "Couldn't load the environment."));
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
      `/api/environment/${encodeURIComponent(elements.name.value.trim())}`,
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
      `/api/environment/${encodeURIComponent(name)}`,
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

elements.secret.addEventListener("change", () => {
  elements.value.type = elements.secret.checked ? "password" : "text";
});
elements.form.addEventListener("submit", (event) => void setVariable(event));
elements.refresh.addEventListener("click", () => void load());
elements.variables.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-name]");
  if (button) void removeVariable(button.dataset.name, button);
});
void load();
