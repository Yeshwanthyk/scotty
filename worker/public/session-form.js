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
  return titleText(session.title) || "";
}

export function mergeRepositorySuggestions(tracked, suppressed) {
  const merged = [];
  const seen = new Set();
  const suppressedIdentities = new Set();

  for (const candidate of arrayOrEmpty(suppressed)) {
    const repo = repositoryName(candidate);
    if (repo) suppressedIdentities.add(repo.toLocaleLowerCase("en-US"));
  }

  for (const candidate of arrayOrEmpty(tracked)) {
    const repo = repositoryName(candidate?.repo);
    if (!repo) continue;
    const identity = repo.toLocaleLowerCase("en-US");
    if (seen.has(identity) || suppressedIdentities.has(identity)) continue;
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

export function sessionKeyboardAction(key, focusedIndex, sessionCount) {
  if (!Number.isInteger(sessionCount) || sessionCount < 1) return undefined;

  const digit = typeof key === "string" ? /^[1-9]$/u.exec(key) : undefined;
  if (digit) {
    const index = Number(digit[0]) - 1;
    return index < sessionCount ? { type: "open", index } : undefined;
  }

  if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
  const hasFocusedSession =
    Number.isInteger(focusedIndex) && focusedIndex >= 0 && focusedIndex < sessionCount;
  if (!hasFocusedSession) {
    return { type: "focus", index: key === "ArrowDown" ? 0 : sessionCount - 1 };
  }

  const index = focusedIndex + (key === "ArrowDown" ? 1 : -1);
  return index >= 0 && index < sessionCount ? { type: "focus", index } : undefined;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function compareProjectGroups(left, right) {
  const leftWarm = left.sessions.some((session) => session?.status === "warm");
  const rightWarm = right.sessions.some((session) => session?.status === "warm");
  if (leftWarm && !rightWarm) return -1;
  if (!leftWarm && rightWarm) return 1;
  return compareSessionsOldestFirst(left.sessions[0], right.sessions[0]);
}

function compareSessionsOldestFirst(left, right) {
  const leftCreatedAt = Date.parse(left?.createdAt);
  const rightCreatedAt = Date.parse(right?.createdAt);
  const leftOrder = Number.isFinite(leftCreatedAt) ? leftCreatedAt : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(rightCreatedAt) ? rightCreatedAt : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}
