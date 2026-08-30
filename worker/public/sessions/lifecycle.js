const SESSION_ID = /^[a-z0-9][a-z0-9-]{5,31}$/u;

export function focusedSessionId(search) {
  const value = new URLSearchParams(search).get("focus");
  return typeof value === "string" && SESSION_ID.test(value) ? value : undefined;
}

export function reconcileCleanupProjection(sessions, cleanupIds) {
  const visibleIds = new Set(sessions.map((session) => session.id));
  const pendingIds = cleanupIds.filter((id) => visibleIds.has(id));
  const completedIds = cleanupIds.filter((id) => !visibleIds.has(id));
  const pending = new Set(pendingIds);
  return {
    sessions: sessions.map((session) =>
      pending.has(session.id) ? { ...session, deleting: true } : session,
    ),
    pendingIds,
    completedIds,
  };
}
