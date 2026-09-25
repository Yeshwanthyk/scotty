import { Match, Predicate } from "effect";
import type { SessionAuthority, Transition } from "./authority";
import { AuthorityStateSchema } from "./authority";
import { reject } from "./control";
import { handleActivity } from "./activity";
import { handleCommand, handleRename, isCommand } from "./admission";
import { handleCompleted, handleProgress } from "./progress";
import { handleRecoveryInput, isRecoveryInput } from "./recovery";
import { handleDeadline, handleFailure, handleUnknown } from "./settlement";
import type { Decision } from "./decision";
import type { SessionActorInput } from "./input";
import { validateAuthority } from "./validity";

type TransitionFencedInput = Extract<
  SessionActorInput,
  {
    _tag:
      | "ActorFact"
      | "RuntimeObservation"
      | "ProviderObservation"
      | "TransitionCompleted"
      | "TransitionFailed"
      | "DeadlineAlarm"
      | "UnknownProviderOutcome";
  }
>;

const factFence = (
  authority: SessionAuthority,
  input: TransitionFencedInput,
): Decision | Transition => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return reject("duplicate");
  const transition = authority.state.transition;
  if (input.revision !== authority.revision)
    return reject(input.revision < authority.revision ? "duplicate" : "revision_mismatch");
  if (input.transitionNonce !== transition.nonce) return reject("stale_nonce");
  if (input.attempt !== transition.attempt) return reject("stale_attempt");
  if (input.expectedPhase !== transition.phase) return reject("stale_phase");
  return transition;
};

const handleFenced = (current: SessionAuthority, input: TransitionFencedInput): Decision => {
  const fenced = factFence(current, input);
  if (!("nonce" in fenced)) return fenced;
  return Match.valueTags(input, {
    DeadlineAlarm: (value) => handleDeadline(current, value, fenced),
    UnknownProviderOutcome: (value) => handleUnknown(current, value, fenced),
    TransitionFailed: (value) => handleFailure(current, value, fenced),
    TransitionCompleted: (value) => handleCompleted(current, value, fenced),
    ActorFact: (value) => handleProgress(current, value, fenced),
    RuntimeObservation: (value) => handleProgress(current, value, fenced),
    ProviderObservation: (value) => handleProgress(current, value, fenced),
  });
};

export const decide = (
  current: SessionAuthority | undefined,
  input: SessionActorInput,
): Decision => {
  if (current !== undefined && !validateAuthority(current)) return reject("invalid_authority");
  if (Predicate.isTagged(input, "RenameCommand")) return handleRename(current, input);
  if (isCommand(input)) return handleCommand(current, input);
  if (current === undefined) return reject("duplicate");
  if (isRecoveryInput(input)) return handleRecoveryInput(current, input);
  if (Predicate.isTagged(input, "ActivityObserved")) return handleActivity(current, input);
  return handleFenced(current, input);
};
