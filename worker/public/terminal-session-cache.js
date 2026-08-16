export function createTerminalSessionCacheEntry(projection, touchedAt = Date.now()) {
  return {
    projection,
    draft: "",
    scrollTop: 0,
    subagentScrollTop: 0,
    subagentSelectedId: undefined,
    subagentSnapshot: undefined,
    touchedAt,
  };
}

const blockingCommandStates = new Set(["queued", "sending", "paused"]);

export function hasBlockingCommands(items) {
  return items.some((item) => blockingCommandStates.has(item.state));
}

export function evictableSessions(entries, currentSessionId, hasPendingCommands) {
  return [...entries]
    .filter(([sessionId]) => sessionId !== currentSessionId && !hasPendingCommands(sessionId))
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
}
