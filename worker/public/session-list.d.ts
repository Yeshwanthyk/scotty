export interface SessionListItem {
  readonly revision: number;
  readonly id: string;
  readonly title?: string;
  readonly branch?: string;
  readonly provider?: string;
  readonly runner?: string;
  readonly status: "provisioning" | "warm" | "stopped" | "gone";
  readonly deleting?: boolean;
  readonly backupId?: string;
  readonly capRemainingSeconds?: number;
  readonly hardCapAt?: string;
  readonly createdAt?: string;
  readonly repo?: string;
  readonly operationResult?: {
    readonly kind:
      | "create"
      | "snapshot"
      | "resume"
      | "refresh"
      | "evidence"
      | "hatch"
      | "down"
      | "vaporize";
    readonly stage:
      | "acquired"
      | "setup"
      | "runtime"
      | "checkpoint"
      | "stop"
      | "restore"
      | "refresh"
      | "evidence"
      | "hatch"
      | "publish"
      | "cleanup"
      | "reconcile"
      | "commit";
    readonly progress: "pending" | "running" | "completed";
    readonly lastProvenEffect:
      | "none"
      | "session_created"
      | "runtime_ready"
      | "checkpoint_committed"
      | "runtime_stopped"
      | "resources_absent";
    readonly retainedState:
      | "session"
      | "runtime"
      | "checkpoint"
      | "operation_lease"
      | "cleanup_authority";
    readonly ambiguity: "none" | "provider_effect_unknown";
    readonly safeRetry: "none" | "retry_operation" | "reconcile_first";
    readonly humanAction: "none" | "retry" | "inspect" | "resume" | "vaporize";
    readonly outcome:
      | { readonly status: "pending" | "succeeded" }
      | {
          readonly status: "failed";
          readonly failure: { readonly code: string; readonly message: string };
        };
    readonly stoppedReason?: "snapshot" | "inactivity" | "hard_cap" | "runtime_exit";
    readonly recoveryAction: "none" | "resume" | "retry" | "reconcile" | "vaporize";
    readonly startedAt: string;
    readonly updatedAt: string;
  };
}

export type SessionAction = "sleep" | "resume" | "delete" | "rename";

export function normalizeSessionListItem(value: unknown): SessionListItem | undefined;

export interface SessionListRenderState {
  readonly content: HTMLElement;
  readonly summary: HTMLElement;
  readonly sessions: ReadonlyArray<SessionListItem>;
  readonly loaded: boolean;
  readonly fetching: boolean;
  readonly busy: ReadonlyMap<string, SessionAction>;
  readonly confirmations: ReadonlySet<string>;
  readonly expandedSessionDetails: ReadonlySet<string>;
  readonly rowErrors: ReadonlyMap<string, string>;
  readonly renamingId?: string;
  readonly renameDraft: string;
  readonly preserveFocusedDraft: boolean;
}

export function formatSessionDuration(value: unknown): string;
export function sessionPrimaryTiming(
  session: SessionListItem,
  status: string,
  pendingAction?: unknown,
): string;
export function focusKeyNeedsStableDraft(value: unknown): boolean;
export function sessionsRenderSignature(
  sessions: ReadonlyArray<SessionListItem>,
  loaded: boolean,
  now?: number,
): string;
export function renderSessionsView(state: SessionListRenderState): {
  readonly preservedDraft: boolean;
};
