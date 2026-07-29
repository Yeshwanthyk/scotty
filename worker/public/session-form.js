export function repositoryName(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[^/\s]+\/[^/\s]+$/u.test(normalized) ? normalized : undefined;
}

export function promptText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.trim().length > 0 ? normalized : undefined;
}

export function titleText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 120 ? normalized : undefined;
}

export function sessionTitle(session) {
  return titleText(session?.title) || `Session ${session?.id || "unknown"}`;
}

export function mergeRepositorySuggestions(tracked, sessions) {
  const merged = [];
  const seen = new Set();

  for (const candidate of [...arrayOrEmpty(tracked), ...arrayOrEmpty(sessions)]) {
    const repo = repositoryName(candidate?.repo);
    if (!repo) continue;
    const identity = repo.toLocaleLowerCase("en-US");
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push({
      repo,
      defaultBranch:
        typeof candidate?.defaultBranch === "string" ? candidate.defaultBranch : undefined,
      lastUsedAt: typeof candidate?.lastUsedAt === "string" ? candidate.lastUsedAt : undefined,
    });
  }

  return merged;
}

export function groupSessionsByRepository(sessions) {
  const groups = [];
  const groupsByRepository = new Map();

  for (const session of arrayOrEmpty(sessions)) {
    const repo = repositoryName(session?.repo) || "Unknown repository";
    const identity = repo.toLocaleLowerCase("en-US");
    let group = groupsByRepository.get(identity);
    if (!group) {
      group = { repo, sessions: [] };
      groupsByRepository.set(identity, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }

  for (const group of groups) {
    group.sessions.sort(compareSessionsOldestFirst);
  }
  return groups.sort(compareProjectGroups);
}

export function submissionIdentity(previous, payload, createKey) {
  const fingerprint = JSON.stringify([
    payload.title,
    payload.repo,
    payload.prompt,
    payload.hardCapSeconds,
    payload.provider,
    payload.runner,
  ]);
  if (previous?.fingerprint === fingerprint && typeof previous.key === "string") return previous;
  return { fingerprint, key: createKey() };
}

export function safeSessionPath(value, id, origin) {
  if (typeof value !== "string" || typeof id !== "string") return undefined;
  try {
    const url = new URL(value, origin);
    const expectedPath = `/s/${encodeURIComponent(id)}`;
    if (
      url.origin !== origin ||
      url.pathname !== expectedPath ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return expectedPath;
  } catch {
    return undefined;
  }
}

export function sessionDisplayStatus(value, pendingAction) {
  const status = typeof value === "string" ? value : "unknown";
  return pendingAction === "sleep" && status === "warm" ? "stopping" : status;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function compareProjectGroups(left, right) {
  const leftActive = left.sessions.filter((session) => session?.status !== "sleeping");
  const rightActive = right.sessions.filter((session) => session?.status !== "sleeping");
  if (leftActive.length > 0 && rightActive.length === 0) return -1;
  if (leftActive.length === 0 && rightActive.length > 0) return 1;

  const leftWarm = left.sessions.filter((session) => session?.status === "warm");
  const rightWarm = right.sessions.filter((session) => session?.status === "warm");
  const leftOrder = leftWarm[0] || leftActive[0] || left.sessions[0];
  const rightOrder = rightWarm[0] || rightActive[0] || right.sessions[0];
  return compareSessionsOldestFirst(leftOrder, rightOrder);
}

function compareSessionsOldestFirst(left, right) {
  const leftCreatedAt = Date.parse(left?.createdAt);
  const rightCreatedAt = Date.parse(right?.createdAt);
  const leftOrder = Number.isFinite(leftCreatedAt) ? leftCreatedAt : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(rightCreatedAt) ? rightCreatedAt : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}
