import type { SessionListItem } from "./list.js";

export function focusedSessionId(search: string): string | undefined;
export function reconcileCleanupProjection(
  sessions: ReadonlyArray<SessionListItem>,
  cleanupIds: ReadonlyArray<string>,
): {
  readonly sessions: ReadonlyArray<SessionListItem>;
  readonly pendingIds: ReadonlyArray<string>;
  readonly completedIds: ReadonlyArray<string>;
};
