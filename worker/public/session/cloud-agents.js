const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ACTIVE_STATUSES = new Set(["booting", "warm"]);

export const isActiveCloudAgent = (agent) => ACTIVE_STATUSES.has(agent.status);

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

export function groupCloudAgents(agents, currentSessionId) {
  const groups = new Map();
  for (const agent of agents) {
    const group = groups.get(agent.repo) ?? [];
    group.push(agent);
    groups.set(agent.repo, group);
  }
  return [...groups.entries()]
    .sort(([left, leftAgents], [right, rightAgents]) => {
      const leftCurrent = leftAgents.some((agent) => agent.id === currentSessionId);
      const rightCurrent = rightAgents.some((agent) => agent.id === currentSessionId);
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return left.localeCompare(right);
    })
    .map(([repo, items]) => ({
      repo,
      agents: items.sort((left, right) => {
        const rank = (agent) =>
          agent.id === currentSessionId ? 0 : agent.status === "warm" ? 1 : 2;
        return rank(left) - rank(right) || left.title.localeCompare(right.title);
      }),
    }));
}

export function cloudAgentGroupWindow(
  agents,
  currentSessionId,
  { expanded = false, maximumSleeping = 6 } = {},
) {
  if (expanded) return { agents: [...agents], hidden: 0 };
  const pinned = agents.filter(
    (agent) => agent.id === currentSessionId || agent.status !== "sleeping",
  );
  const sleeping = agents.filter(
    (agent) => agent.id !== currentSessionId && agent.status === "sleeping",
  );
  const visible = [...pinned, ...sleeping.slice(0, maximumSleeping)];
  return { agents: visible, hidden: Math.max(0, agents.length - visible.length) };
}

export function filterCloudAgents(agents, query) {
  const needle = String(query ?? "")
    .trim()
    .toLocaleLowerCase("en-US");
  if (!needle) return [...agents];
  return agents.filter((agent) =>
    [agent.title, agent.repo, agent.branch]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase("en-US").includes(needle)),
  );
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

export function renderCloudAgents(
  document,
  target,
  agents,
  currentSessionId,
  emptyMessage = "No cloud agents yet. Start one from Sessions.",
  { expandedRepositories = new Set(), maximumSleeping = 6, filtering = false } = {},
) {
  const activeAgents = agents.filter(isActiveCloudAgent);
  const fragment = document.createDocumentFragment();
  for (const group of groupCloudAgents(activeAgents, currentSessionId)) {
    const section = document.createElement("section");
    section.className = "agent-group";
    appendText(document, section, "h3", "agent-group-title", group.repo);
    const list = document.createElement("div");
    list.className = "agent-group-list";
    const window = cloudAgentGroupWindow(group.agents, currentSessionId, {
      expanded: filtering || expandedRepositories.has(group.repo),
      maximumSleeping,
    });
    for (const agent of window.agents) {
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
    if (window.hidden > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "agent-group-more";
      more.dataset.expandRepo = group.repo;
      more.textContent = `Show ${window.hidden} more`;
      list.append(more);
    }
    section.append(list);
    fragment.append(section);
  }
  if (activeAgents.length === 0) {
    appendText(document, fragment, "p", "directory-state", emptyMessage);
  }
  target.replaceChildren(fragment);
}

export function createCloudAgentDirectory({
  document,
  target,
  count,
  filter,
  fetch,
  onSelect,
  onChange = () => {},
  interval = 15_000,
}) {
  let agents = [];
  let currentSessionId;
  let signature = "";
  let filterValue = "";
  const expandedRepositories = new Set();
  let timer;
  let fetching = false;

  const render = () => {
    const activeAgents = agents.filter(isActiveCloudAgent);
    const visibleAgents = filterCloudAgents(activeAgents, filterValue);
    const next = `${filterValue}\n${[...expandedRepositories].sort().join("\n")}\n${cloudAgentSignature(visibleAgents, currentSessionId)}`;
    if (next === signature) return false;
    signature = next;
    renderCloudAgents(
      document,
      target,
      visibleAgents,
      currentSessionId,
      filterValue ? "No sessions match this filter." : undefined,
      { expandedRepositories, filtering: Boolean(filterValue) },
    );
    count.textContent = String(activeAgents.length);
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
    const expander = event.target.closest?.("[data-expand-repo]");
    if (expander && target.contains(expander)) {
      expandedRepositories.add(expander.dataset.expandRepo);
      signature = "";
      render();
      return;
    }
    const row = event.target.closest?.("[data-session-id]");
    if (!row || !target.contains(row)) return;
    onSelect(row.dataset.sessionId);
  };
  const input = () => {
    filterValue = filter?.value ?? "";
    signature = "";
    render();
  };
  target.addEventListener("click", click);
  filter?.addEventListener("input", input);
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
      filter?.removeEventListener("input", input);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
