import type { SessionAuthority } from "./authority";
import type { TransitionKind, TransitionPhase } from "./transition";

export type RejectionCode =
  | "invalid_authority"
  | "revision_mismatch"
  | "not_admissible"
  | "transition_owned"
  | "duplicate"
  | "stale_nonce"
  | "stale_attempt"
  | "stale_phase"
  | "stale_generation"
  | "invalid_progress"
  | "not_terminal";

export interface RejectedDecision {
  readonly _tag: "Rejected";
  readonly code: RejectionCode;
}

export interface JournalEvent {
  readonly timestamp: string;
  readonly correlationId: string;
  readonly transitionNonce: string | null;
  readonly eventType:
    | "admitted"
    | "progressed"
    | "completed"
    | "deadline_reconciling"
    | "provider_reconciling"
    | "activity_observed"
    | "runtime_observed"
    | "availability_lost"
    | "hard_cap_elapsed"
    | "renamed";
  readonly transitionKind: TransitionKind | null;
  readonly transitionPhase: TransitionPhase | null;
  readonly resultCode: string;
  readonly causeAttempt: string | null;
}

export type EffectIntent =
  | {
      readonly _tag: "ArmDeadline";
      readonly deadlineAt: string;
      readonly transitionNonce: string;
      readonly attempt: string;
    }
  | {
      readonly _tag: "ArmReconciliation";
      readonly deadlineAt: string;
      readonly transitionNonce: string;
      readonly attempt: string;
    }
  | {
      readonly _tag: "ExecutePhase";
      readonly transitionKind: TransitionKind;
      readonly phase: TransitionPhase;
      readonly transitionNonce: string;
      readonly attempt: string;
    }
  | {
      readonly _tag: "ReconcileTransition";
      readonly transitionKind: TransitionKind;
      readonly phase: TransitionPhase;
      readonly transitionNonce: string;
      readonly attempt: string;
    };

export interface AcceptedDecision {
  readonly _tag: "Accepted";
  readonly nextAuthority: SessionAuthority;
  readonly journalEvent: JournalEvent;
  readonly effectIntents: ReadonlyArray<EffectIntent>;
}

export type Decision = AcceptedDecision | RejectedDecision;
