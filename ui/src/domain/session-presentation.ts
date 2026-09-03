import {
  availableActions,
  type SessionAction,
  type SessionAuthority,
  type SessionLifecycle,
  type SessionModel,
  type SessionTransitionAction,
} from "../data/session-reader";

export type SessionReadSource = "actor" | "projection";
export type SessionFreshness = "fresh" | "stale";
export type RuntimeAvailability = "ready" | "checking" | "unavailable";
export type ConversationAvailability = "live" | "retained" | "unavailable" | "terminal";

export interface SessionPresentationOptions {
  readonly now: Date;
  readonly source: SessionReadSource;
  readonly freshness?: SessionFreshness;
  readonly runtimeAvailability?: RuntimeAvailability;
}

export interface OperationPresentation {
  readonly action: SessionTransitionAction;
  readonly mode: "executing" | "reconciling";
  readonly phase: string;
  readonly label: string;
  readonly elapsedSeconds: number;
}

type StableAuthority = Extract<SessionAuthority, { readonly kind: "stable" }>;
type TransitioningAuthority = Extract<SessionAuthority, { readonly kind: "transitioning" }>;

interface PresentationBase {
  readonly id: string;
  readonly railLabel: string;
  readonly shellTitle: string;
  readonly source: SessionReadSource;
  readonly freshness: SessionFreshness;
  readonly activity: null;
  readonly availableActions: ReadonlyArray<SessionAction>;
  readonly conversation: ConversationAvailability;
  readonly composerEnabled: boolean;
  readonly destructiveProgress: boolean;
  readonly hardCapOverdue: boolean;
  readonly failureMessage: string | null;
}

export type SessionPresentation = PresentationBase &
  (
    | {
        readonly authority: { readonly kind: "stable"; readonly lifecycle: SessionLifecycle };
        readonly operation: null;
      }
    | {
        readonly authority: {
          readonly kind: "transitioning";
          readonly origin: "absent" | SessionLifecycle;
        };
        readonly operation: OperationPresentation;
      }
  );

const transitionLabels = {
  create: "Creating",
  checkpoint: "Saving",
  sleep: "Going to sleep",
  resume: "Waking",
  work: "Preparing runtime",
  evidence: "Capturing evidence",
  hatch: "Starting Hatch",
  down: "Preparing download",
  vaporize: "Vaporizing",
} as const satisfies Record<SessionTransitionAction, string>;

const stableRailLabels = {
  warm: "Ready",
  sleeping: "Sleeping",
  failed: "Failed",
  gone: "Vaporized",
} as const satisfies Record<SessionLifecycle, string>;

const stableShellTitles = {
  warm: "",
  sleeping: "Session is sleeping",
  failed: "Session could not recover",
  gone: "Session was vaporized",
} as const satisfies Record<SessionLifecycle, string>;

const failureMessageFor = (session: SessionModel): string | null => {
  const authority = session.authority;
  if (authority.kind !== "stable" || authority.lifecycle !== "failed") return null;
  const code = authority.failure?.code;
  if (code === "runtime_missing")
    return "The runtime stopped, but this session can be restored from its confirmed backup.";
  if (code === "backup_missing") return "This session has no confirmed backup to restore.";
  return authority.failure?.recoverable === true
    ? "This session can be recovered."
    : "This session cannot be recovered.";
};

const stablePresentation = (
  session: SessionModel,
  authority: StableAuthority,
  options: SessionPresentationOptions,
  runtime: RuntimeAvailability,
): SessionPresentation => {
  const lifecycle = authority.lifecycle;
  return {
    id: session.id,
    authority: { kind: "stable", lifecycle },
    railLabel:
      lifecycle === "failed" && authority.failure?.recoverable === true
        ? "Needs attention"
        : stableRailLabels[lifecycle],
    shellTitle:
      lifecycle === "warm"
        ? runtime === "ready"
          ? session.display.title
          : "Connecting to session"
        : lifecycle === "failed" && authority.failure?.recoverable === true
          ? "Session needs attention"
          : stableShellTitles[lifecycle],
    source: options.source,
    freshness: options.freshness ?? "fresh",
    operation: null,
    activity: null,
    availableActions: availableActions(session),
    conversation:
      lifecycle === "gone"
        ? "terminal"
        : lifecycle === "sleeping" || lifecycle === "failed"
          ? "retained"
          : runtime === "ready"
            ? "live"
            : "unavailable",
    composerEnabled: lifecycle === "warm" && runtime === "ready",
    destructiveProgress: false,
    hardCapOverdue: session.times.capRemainingSeconds <= 0,
    failureMessage: failureMessageFor(session),
  };
};

const transitioningPresentation = (
  session: SessionModel,
  authority: TransitioningAuthority,
  options: SessionPresentationOptions,
): SessionPresentation => {
  const operation = {
    action: authority.action,
    mode: authority.mode,
    phase: authority.phase,
    label: transitionLabels[authority.action],
    elapsedSeconds: Math.max(
      0,
      Math.floor((options.now.getTime() - Date.parse(authority.startedAt)) / 1_000),
    ),
  };
  return {
    id: session.id,
    authority: { kind: "transitioning", origin: authority.origin },
    railLabel: operation.label,
    shellTitle: operation.label,
    source: options.source,
    freshness: options.freshness ?? "fresh",
    operation,
    activity: null,
    availableActions: availableActions(session),
    conversation: "unavailable",
    composerEnabled: false,
    destructiveProgress: authority.action === "vaporize",
    hardCapOverdue: session.times.capRemainingSeconds <= 0,
    failureMessage: null,
  };
};

export const presentSession = (
  session: SessionModel,
  options: SessionPresentationOptions,
): SessionPresentation =>
  session.authority.kind === "stable"
    ? stablePresentation(
        session,
        session.authority,
        options,
        options.runtimeAvailability ?? "checking",
      )
    : transitioningPresentation(session, session.authority, options);

export const reconcileRailSession = (
  projected: SessionModel,
  selectedActorRead: SessionModel | undefined,
): SessionModel => (selectedActorRead?.id === projected.id ? selectedActorRead : projected);

export type SessionRequestFailure =
  | {
      readonly kind: "http";
      readonly status: number;
      readonly code?: string;
      readonly reason?: string;
    }
  | { readonly kind: "malformed-response" };

export type SessionFailureClassification =
  | "conflict"
  | "wrong-state"
  | "non-warm"
  | "malformed"
  | "other";

const nonWarmReasons = new Set(["session_not_warm", "session_operation_active", "pi_quiescing"]);

export const classifySessionFailure = (
  failure: SessionRequestFailure,
): SessionFailureClassification => {
  if (failure.kind === "malformed-response") return "malformed";
  if (failure.code === "conflict") return "conflict";
  if (failure.code === "wrong_state") return "wrong-state";
  if (failure.reason !== undefined && nonWarmReasons.has(failure.reason)) return "non-warm";
  return "other";
};
