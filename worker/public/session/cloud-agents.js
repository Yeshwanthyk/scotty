const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeCloudAgent(value) {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : value.id,
    repo:
      typeof value.repo === "string" && value.repo.trim()
        ? value.repo.trim()
        : "Unknown repository",
    branch: typeof value.branch === "string" ? value.branch : "",
    status: typeof value.status === "string" ? value.status : "unknown",
    provider: typeof value.provider === "string" ? value.provider : "unknown",
  };
}

export function groupCloudAgents(agents) {
  const groups = new Map();
  for (const agent of agents) {
    const group = groups.get(agent.repo) ?? [];
    group.push(agent);
    groups.set(agent.repo, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repo, items]) => ({
      repo,
      agents: items.sort((left, right) => left.title.localeCompare(right.title)),
    }));
}

export function cloudAgentSignature(agents, currentSessionId) {
  return JSON.stringify([
    currentSessionId,
    agents.map(({ id, title, repo, branch, status, provider }) => [
      id,
      title,
      repo,
      branch,
      status,
      provider,
    ]),
  ]);
}

function appendText(document, parent, tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

export function renderCloudAgents(document, target, agents, currentSessionId) {
  const fragment = document.createDocumentFragment();
  for (const group of groupCloudAgents(agents)) {
    const section = document.createElement("section");
    section.className = "agent-group";
    appendText(document, section, "h3", "agent-group-title", group.repo);
    const list = document.createElement("div");
    list.className = "agent-group-list";
    for (const agent of group.agents) {
      const warm = agent.status === "warm" && agent.provider !== "runner";
      const row = document.createElement(warm ? "button" : "a");
      row.className = `agent-row status-${agent.status}`;
      if (warm) {
        row.type = "button";
        row.dataset.sessionId = agent.id;
      } else {
        row.href = "/sessions";
        row.title = "Manage this agent from Sessions";
      }
      if (agent.id === currentSessionId) row.setAttribute("aria-current", "page");
      const signal = document.createElement("span");
      signal.className = "agent-signal";
      signal.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "agent-row-copy";
      appendText(document, copy, "strong", "agent-row-title", agent.title);
      appendText(
        document,
        copy,
        "small",
        "agent-row-meta",
        [agent.branch, agent.status].filter(Boolean).join(" · "),
      );
      row.append(signal, copy);
      list.append(row);
    }
    section.append(list);
    fragment.append(section);
  }
  if (agents.length === 0) {
    appendText(
      document,
      fragment,
      "p",
      "directory-state",
      "No cloud agents yet. Start one from Sessions.",
    );
  }
  target.replaceChildren(fragment);
}

export function createCloudAgentDirectory({
  document,
  target,
  count,
  fetch,
  onSelect,
  onChange = () => {},
  interval = 15_000,
}) {
  let agents = [];
  let currentSessionId;
  let signature = "";
  let timer;
  let fetching = false;

  const render = () => {
    const next = cloudAgentSignature(agents, currentSessionId);
    if (next === signature) return false;
    signature = next;
    renderCloudAgents(document, target, agents, currentSessionId);
    count.textContent = String(agents.length);
    return true;
  };

  const refresh = async () => {
    if (fetching || document.hidden) return agents;
    fetching = true;
    try {
      const response = await fetch("/api/sessions", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Cloud agents could not be loaded (${response.status})`);
      const body = await response.json();
      const values = Array.isArray(body) ? body : body?.sessions;
      if (!Array.isArray(values)) throw new Error("Scotty returned an unexpected cloud-agent list");
      agents = values.map(normalizeCloudAgent).filter((agent) => agent !== undefined);
      render();
      onChange(agents);
      return agents;
    } finally {
      fetching = false;
    }
  };

  const schedule = () => {
    clearInterval(timer);
    timer = setInterval(() => void refresh(), interval);
  };

  const visibility = () => {
    if (!document.hidden) void refresh();
  };
  const click = (event) => {
    const row = event.target.closest?.("[data-session-id]");
    if (!row || !target.contains(row)) return;
    onSelect(row.dataset.sessionId);
  };
  target.addEventListener("click", click);
  document.addEventListener("visibilitychange", visibility);
  schedule();

  return {
    refresh,
    setCurrent(sessionId) {
      currentSessionId = sessionId;
      render();
    },
    find(sessionId) {
      return agents.find((agent) => agent.id === sessionId);
    },
    agents() {
      return [...agents];
    },
    dispose() {
      clearInterval(timer);
      target.removeEventListener("click", click);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
