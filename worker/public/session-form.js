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

export function submissionIdentity(previous, payload, createKey) {
  const fingerprint = JSON.stringify([payload.repo, payload.prompt, payload.hardCapSeconds]);
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
