export declare function createTerminalSessionCacheEntry<Projection>(
  projection: Projection,
  touchedAt?: number,
): {
  projection: Projection;
  draft: string;
  scrollTop: number;
  subagentScrollTop: number;
  subagentSelectedId: string | undefined;
  subagentSnapshot: unknown;
  touchedAt: number;
};

export function hasBlockingCommands(items: ReadonlyArray<{ readonly state: string }>): boolean;

export function evictableSessions<Entry extends { readonly touchedAt: number }>(
  entries: Iterable<readonly [string, Entry]>,
  currentSessionId: string,
  hasPendingCommands: (sessionId: string) => boolean,
): Array<readonly [string, Entry]>;
