import type { SessionAuthority, SessionIdentity, Transition } from "./authority";
import { AuthorityStateSchema } from "./authority";
import type {
  AcceptedDecision,
  EffectIntent,
  JournalEvent,
  RejectedDecision,
  RejectionCode,
} from "./decision";

export const reject = (code: RejectionCode): RejectedDecision => ({ _tag: "Rejected", code });

export const accept = (
  currentRevision: number,
  session: SessionIdentity,
  state: SessionAuthority["state"],
  journalEvent: JournalEvent,
  effectIntents: ReadonlyArray<EffectIntent>,
): AcceptedDecision => ({
  _tag: "Accepted",
  nextAuthority: { session, revision: currentRevision + 1, state },
  journalEvent,
  effectIntents,
});

export const transitionOf = (authority: SessionAuthority): Transition | undefined =>
  AuthorityStateSchema.guards.Transitioning(authority.state)
    ? authority.state.transition
    : undefined;
