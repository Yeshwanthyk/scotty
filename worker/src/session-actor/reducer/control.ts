import type { HardCapProof, SessionAuthority, SessionIdentity, Transition } from "./authority";
import { AuthorityStateSchema, StableStateSchema, TransitionSchema } from "./authority";
import type {
  AcceptedDecision,
  EffectIntent,
  JournalEvent,
  RejectedDecision,
  RejectionCode,
} from "./decision";
import type { SessionActorInput } from "./input";
import { transitionKind } from "./transition";
import type { StableCase } from "./validity";

export const reject = (code: RejectionCode): RejectedDecision => ({ _tag: "Rejected", code });

export const accept = (
  currentRevision: number,
  session: SessionIdentity,
  hardCap: HardCapProof,
  state: SessionAuthority["state"],
  journalEvent: JournalEvent,
  effectIntents: ReadonlyArray<EffectIntent>,
): AcceptedDecision => ({
  _tag: "Accepted",
  nextAuthority: { session, hardCap, revision: currentRevision + 1, state },
  journalEvent,
  effectIntents,
});

export const transitionOf = (authority: SessionAuthority): Transition | undefined =>
  AuthorityStateSchema.guards.Transitioning(authority.state)
    ? authority.state.transition
    : undefined;

export const journal = (
  input: SessionActorInput,
  transition: Transition,
  eventType: JournalEvent["eventType"],
  resultCode: string,
): JournalEvent => ({
  timestamp: input.timestamp,
  correlationId: input.correlationId,
  transitionNonce: transition.nonce,
  eventType,
  transitionKind: transitionKind(transition),
  transitionPhase: transition.phase,
  resultCode,
  causeAttempt: transition.attempt,
});

export const intentsFor = (transition: Transition): ReadonlyArray<EffectIntent> => [
  {
    _tag: "ArmDeadline",
    deadlineAt: transition.deadlineAt,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
  },
  ...(TransitionSchema.guards.WarmWork(transition)
    ? []
    : [
        {
          _tag: "ExecutePhase" as const,
          transitionKind: transitionKind(transition),
          phase: transition.phase,
          transitionNonce: transition.nonce,
          attempt: transition.attempt,
        },
      ]),
];

export const warmFrom = (current: SessionAuthority | undefined): StableCase<"Warm"> | undefined =>
  current !== undefined &&
  AuthorityStateSchema.guards.Stable(current.state) &&
  StableStateSchema.guards.Warm(current.state.stable)
    ? current.state.stable
    : undefined;

export const runtimeProof = (transition: Transition) =>
  "readiness" in transition.proof ? transition.proof.readiness.runtime : null;
