export interface SessionListItem {
  readonly id: string;
  readonly title?: string;
  readonly branch?: string;
  readonly provider?: string;
  readonly runner?: string;
  readonly status?: string;
  readonly deleting?: boolean;
  readonly backupId?: string;
  readonly capRemainingSeconds?: number;
  readonly hardCapAt?: string;
  readonly createdAt?: string;
  readonly repo?: string;
  readonly failure?: {
    readonly code?: string;
    readonly message?: string;
    readonly recoverable?: boolean;
    readonly stage?: string;
  };
}

export type SessionAction = "sleep" | "resume" | "delete" | "retry-delete" | "rename";

export function deletionActionLabel(pendingAction: unknown, fallback: string): string;

export function normalizeSessionListItem(value: unknown): SessionListItem | undefined;

export interface SessionListRenderState {
  readonly content: HTMLElement;
  readonly repositoryNav?: HTMLElement;
  readonly summary: HTMLElement;
  readonly sessions: ReadonlyArray<SessionListItem>;
  readonly loaded: boolean;
  readonly fetching: boolean;
  readonly busy: ReadonlyMap<string, SessionAction>;
  readonly confirmations: ReadonlySet<string>;
  readonly expandedSleepingProjects: ReadonlySet<string>;
  readonly expandedSessionDetails: ReadonlySet<string>;
  readonly rowErrors: ReadonlyMap<string, string>;
  readonly renamingId?: string;
  readonly renameDraft: string;
  readonly preserveFocusedDraft: boolean;
  readonly targetSessionId?: string;
  readonly focusTargetSession: boolean;
  readonly selectedSessionId?: string;
  readonly searchQuery?: string;
  readonly archiveVisibleCounts?: ReadonlyMap<string, number>;
}

export function formatSessionDuration(value: unknown): string;
export function sessionPrimaryTiming(
  session: SessionListItem,
  status: string,
  pendingAction?: unknown,
): string;
export function focusKeyNeedsStableDraft(value: unknown): boolean;
export function sleepingProjectFocusKey(repository: string): string;
export function sessionsRenderSignature(
  sessions: ReadonlyArray<SessionListItem>,
  loaded: boolean,
  now?: number,
): string;
export function renderSessionsView(state: SessionListRenderState): {
  readonly preservedDraft: boolean;
};
