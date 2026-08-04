export function evictableSessions(entries, currentSessionId, hasPendingCommands) {
  return [...entries]
    .filter(([sessionId]) => sessionId !== currentSessionId && !hasPendingCommands(sessionId))
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
}
