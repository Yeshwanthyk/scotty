import type { SessionListItem } from "./list.js";

export function focusedSessionId(search: string): string | undefined;
export function unavailableSessionId(search: string): string | undefined;
export function focusedSessionPath(id: string): string;
export function reconcileFocusedSession(
  sessions: ReadonlyArray<SessionListItem>,
  focusedSession: SessionListItem,
): ReadonlyArray<SessionListItem>;
export function reconcileCleanupProjection(
  sessions: ReadonlyArray<SessionListItem>,
  cleanupIds: ReadonlyArray<string>,
): {
  readonly sessions: ReadonlyArray<SessionListItem>;
  readonly pendingIds: ReadonlyArray<string>;
  readonly completedIds: ReadonlyArray<string>;
};

export interface RefreshOptions {
  readonly actionId?: string;
  readonly afterActive?: boolean;
}

export function createRefreshCoordinator(
  runRefresh: (options: RefreshOptions) => Promise<boolean>,
): {
  readonly refresh: (options?: RefreshOptions) => Promise<boolean>;
  readonly waitForIdle: () => Promise<void>;
};
