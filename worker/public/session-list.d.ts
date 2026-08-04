export interface SessionListItem {
  readonly id: string;
  readonly title?: unknown;
  readonly branch?: unknown;
  readonly provider?: unknown;
  readonly runner?: unknown;
  readonly status?: unknown;
  readonly deleting?: unknown;
  readonly backupId?: unknown;
  readonly capRemainingSeconds?: unknown;
  readonly hardCapAt?: unknown;
  readonly createdAt?: unknown;
}

export function formatSessionDuration(value: unknown): string;
export function sessionPrimaryTiming(
  session: SessionListItem,
  status: string,
  pendingAction?: unknown,
): string;
export function focusKeyNeedsStableDraft(value: unknown): boolean;
export function renderSessionsView(state: Record<string, unknown>): {
  readonly preservedDraft: boolean;
};
