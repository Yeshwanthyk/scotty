import { Match } from "effect";
import type { BackupIdentity, SessionAuthority, StableState, Transition } from "./authority";
import { recoveryFor, TransitionSchema } from "./authority";
import { confirmedBackup } from "./backup";
import { accept, journal, reject, runtimeProof } from "./control";
import type { Decision } from "./decision";
import type { SessionActorInput } from "./input";
import type { StableCase } from "./validity";
import { validStable, validTransitionProof } from "./validity";
import { transitionKind } from "./transition";

const reconcile = (
  current: SessionAuthority,
  input: SessionActorInput,
  transition: Transition,
  eventType: "deadline_reconciling" | "provider_reconciling",
  resultCode: string,
): Decision => {
  const reconciling = {
    ...transition,
    mode: "reconciling" as const,
    lastProgressAt:
      Date.parse(input.timestamp) > Date.parse(transition.deadlineAt)
        ? transition.deadlineAt
        : input.timestamp,
  };
  if (!validTransitionProof(reconciling)) return reject("invalid_progress");
  return accept(
    current.revision,
    current.session,
    current.hardCap,
    { _tag: "Transitioning", transition: reconciling },
    journal(input, reconciling, eventType, resultCode),
    [
      {
        _tag: "ArmReconciliation",
        deadlineAt: transition.deadlineAt,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
      },
    ],
  );
};

const confirmedBackupOf = (transition: Transition): BackupIdentity | null =>
  Match.valueTags(transition, {
    Create: () => null,
    Checkpoint: ({ proof }) => confirmedBackup(proof.backup),
    Sleep: ({ proof }) => confirmedBackup(proof.backup),
    Resume: ({ proof }) => proof.backup,
    WarmWork: ({ proof }) => confirmedBackup(proof.backups),
    Vaporize: () => null,
  });

const ownedBackupsOfTransition = (transition: Transition): ReadonlyArray<string> =>
  Match.valueTags(transition, {
    Create: () => [],
    Checkpoint: ({ proof }) => proof.backup.ownedBackupIds,
    Sleep: ({ proof }) => proof.backup.ownedBackupIds,
    Resume: ({ proof }) => proof.ownedBackupIds,
    WarmWork: ({ proof }) => proof.backups.ownedBackupIds,
    Vaporize: ({ proof }) => proof.ownedBackupIds,
  });

const failedFrom = (transition: Transition, code: string): StableCase<"Failed"> => {
  const backup = confirmedBackupOf(transition);
  const lastStable = failedLastStable(transition);
  return {
    _tag: "Failed",
    code,
    origin: transition.origin,
    lastStable,
    ownedBackupIds: [...ownedBackupsOfTransition(transition)],
    recovery: recoveryFor(backup, lastStable, transitionKind(transition), transition.origin),
  };
};

type DeadlineInput = Extract<SessionActorInput, { _tag: "DeadlineAlarm" }>;
export const handleDeadline = (
  current: SessionAuthority,
  input: DeadlineInput,
  transition: Transition,
): Decision => {
  if (
    input.expectedDeadlineAt !== transition.deadlineAt ||
    Date.parse(input.timestamp) < Date.parse(transition.deadlineAt)
  )
    return reject("stale_phase");
  if (!TransitionSchema.guards.Vaporize(transition)) {
    const failed = failedFrom(transition, "transition_deadline_elapsed");
    if (!validStable(failed)) return reject("invalid_progress");
    return accept(
      current.revision,
      current.session,
      current.hardCap,
      { _tag: "Stable", stable: failed },
      journal(input, transition, "completed", "transition_deadline_elapsed"),
      [],
    );
  }
  return reconcile(current, input, transition, "deadline_reconciling", "deadline_elapsed");
};

type UnknownInput = Extract<SessionActorInput, { _tag: "UnknownProviderOutcome" }>;

export const handleUnknown = (
  current: SessionAuthority,
  input: UnknownInput,
  transition: Transition,
): Decision => {
  const runtime = runtimeProof(transition);
  if (
    input.expectedProviderRuntimeId !== null &&
    (runtime === null || input.expectedProviderRuntimeId !== runtime.providerRuntimeId)
  )
    return reject("stale_generation");
  if (transition.mode === "reconciling" && !TransitionSchema.guards.Vaporize(transition)) {
    const failed = failedFrom(transition, "reconciliation_outcome_unknown");
    if (!validStable(failed)) return reject("invalid_progress");
    return accept(
      current.revision,
      current.session,
      current.hardCap,
      { _tag: "Stable", stable: failed },
      journal(input, transition, "completed", "reconciliation_outcome_unknown"),
      [],
    );
  }
  return reconcile(current, input, transition, "provider_reconciling", input.resultCode);
};

type FailedInput = Extract<SessionActorInput, { _tag: "TransitionFailed" }>;
const failedLastStable = (transition: Transition): "Warm" | "Sleeping" | null =>
  Match.valueTags(transition, {
    Create: () => null,
    Checkpoint: () => "Warm" as const,
    Sleep: () => "Warm" as const,
    Resume: (value) => value.proof.lastStable,
    WarmWork: () => "Warm" as const,
    Vaporize: () => null,
  });

export const handleFailure = (
  current: SessionAuthority,
  input: FailedInput,
  transition: Transition,
): Decision => {
  if (TransitionSchema.guards.Vaporize(transition))
    return reconcile(current, input, transition, "provider_reconciling", input.resultCode);
  const retained = failedFrom(transition, input.failureCode);
  const failed: StableState = {
    ...retained,
    ownedBackupIds: [...new Set([...retained.ownedBackupIds, ...input.ownedBackupIds])],
  };
  if (!validStable(failed)) return reject("invalid_progress");
  return accept(
    current.revision,
    current.session,
    current.hardCap,
    { _tag: "Stable", stable: failed },
    journal(input, transition, "completed", input.resultCode),
    [],
  );
};
