import { Match } from "effect";
import type { SessionAuthority, StableState, Transition } from "./authority";
import { emptyBackupProof } from "./authority";
import { accept, intentsFor, journal, reject, runtimeProof } from "./control";
import type { Decision } from "./decision";
import type { SessionActorInput, TransitionProof } from "./input";
import { isNextPhase, isTerminalPhase } from "./transition";
import {
  completeReadiness,
  isCheckpointPhase,
  isCheckpointProof,
  isCreatePhase,
  isCreateProof,
  isResumePhase,
  isResumeProof,
  isSleepPhase,
  isSleepProof,
  isVaporizePhase,
  isVaporizeProof,
  isWarmWorkPhase,
  isWarmWorkProof,
  validCleanup,
  validStable,
  validTransitionProof,
} from "./validity";

const proofMatches = (transition: Transition, proof: TransitionProof): boolean =>
  Match.valueTags(transition, {
    Create: () => isCreateProof(proof),
    Checkpoint: () => isCheckpointProof(proof),
    Sleep: () => isSleepProof(proof),
    Resume: () => isResumeProof(proof),
    WarmWork: () => isWarmWorkProof(proof),
    Vaporize: () => isVaporizeProof(proof),
  });

const withProgress = (
  transition: Transition,
  nextPhase: string,
  proof: TransitionProof,
  timestamp: string,
): Transition | undefined =>
  Match.valueTags(transition, {
    Create: (value): Transition | undefined =>
      isCreateProof(proof) && isCreatePhase(nextPhase)
        ? {
            ...value,
            phase: nextPhase,
            proof,
            lastProgressAt: timestamp,
            mode: "executing",
          }
        : undefined,
    Checkpoint: (value): Transition | undefined =>
      isCheckpointProof(proof) && isCheckpointPhase(nextPhase)
        ? {
            ...value,
            phase: nextPhase,
            proof,
            lastProgressAt: timestamp,
            mode: "executing",
          }
        : undefined,
    Sleep: (value): Transition | undefined =>
      isSleepProof(proof) && isSleepPhase(nextPhase)
        ? {
            ...value,
            phase: nextPhase,
            proof,
            lastProgressAt: timestamp,
            mode: "executing",
          }
        : undefined,
    Resume: (value): Transition | undefined =>
      isResumeProof(proof) && isResumePhase(nextPhase)
        ? {
            ...value,
            phase: nextPhase,
            proof,
            lastProgressAt: timestamp,
            mode: "executing",
          }
        : undefined,
    WarmWork: (value): Transition | undefined =>
      isWarmWorkProof(proof) && isWarmWorkPhase(nextPhase)
        ? {
            ...value,
            phase: nextPhase,
            proof,
            lastProgressAt: timestamp,
            mode: "executing",
          }
        : undefined,
    Vaporize: (value): Transition | undefined =>
      isVaporizeProof(proof) && isVaporizePhase(nextPhase)
        ? {
            ...value,
            phase: nextPhase,
            proof,
            lastProgressAt: timestamp,
            mode: "executing",
          }
        : undefined,
  });

const completeCreate = (proof: TransitionProof): StableState | undefined => {
  if (!isCreateProof(proof)) return undefined;
  const readiness = completeReadiness(proof.readiness);
  return readiness === undefined
    ? undefined
    : { _tag: "Warm", readiness, backups: emptyBackupProof(), activity: null };
};

const completeSleep = (proof: TransitionProof): StableState | undefined => {
  if (!isSleepProof(proof) || proof.backup.prepared === null || proof.stop === null)
    return undefined;
  const backup = proof.backup.prepared;
  if (backup.confirmedAt === null) return undefined;
  return {
    _tag: "Sleeping",
    backup,
    ownedBackupIds: proof.backup.ownedBackupIds,
    stop: proof.stop,
    wakeSource: { backupId: backup.backupId, confirmedAt: backup.confirmedAt },
  };
};

const completeResume = (proof: TransitionProof): StableState | undefined => {
  if (!isResumeProof(proof)) return undefined;
  const readiness = completeReadiness(proof.readiness);
  return readiness === undefined
    ? undefined
    : {
        _tag: "Warm",
        readiness,
        backups: {
          ownedBackupIds: proof.ownedBackupIds,
          prepared: proof.backup,
          confirmed: proof.backup.confirmedAt !== null ? proof.backup : null,
          currentBackupId: proof.backup.backupId,
        },
        activity: null,
      };
};

const completedStable = (transition: Transition, proof: TransitionProof): StableState | undefined =>
  Match.valueTags(transition, {
    Create: () => completeCreate(proof),
    Checkpoint: (): StableState | undefined =>
      isCheckpointProof(proof)
        ? { _tag: "Warm", readiness: proof.readiness, backups: proof.backup, activity: null }
        : undefined,
    Sleep: () => completeSleep(proof),
    Resume: () => completeResume(proof),
    WarmWork: (): StableState | undefined =>
      isWarmWorkProof(proof) && proof.resultCode !== null
        ? {
            _tag: "Warm",
            readiness: proof.readiness,
            backups: proof.backups,
            activity: proof.activity,
          }
        : undefined,
    Vaporize: (): StableState | undefined =>
      isVaporizeProof(proof) && validCleanup(proof.cleanup, true)
        ? { _tag: "Gone", cleanup: proof.cleanup }
        : undefined,
  });

type ProgressInput = Extract<
  SessionActorInput,
  { _tag: "ActorFact" | "RuntimeObservation" | "ProviderObservation" }
>;
const progressFence = (input: ProgressInput, transition: Transition): Decision | undefined => {
  if (!proofMatches(transition, input.proof)) return reject("invalid_progress");
  const runtime = runtimeProof(transition);
  return Match.valueTags(input, {
    ActorFact: () => undefined,
    RuntimeObservation: (value) =>
      value.expectedRuntimeGeneration !== null &&
      (runtime === null || value.expectedRuntimeGeneration !== runtime.runtimeGeneration)
        ? reject("stale_generation")
        : undefined,
    ProviderObservation: (value) =>
      value.expectedProviderRuntimeId !== null &&
      (runtime === null || value.expectedProviderRuntimeId !== runtime.providerRuntimeId)
        ? reject("stale_generation")
        : undefined,
  });
};

export const handleProgress = (
  current: SessionAuthority,
  input: ProgressInput,
  transition: Transition,
): Decision => {
  const fence = progressFence(input, transition);
  if (fence !== undefined) return fence;
  if (!isNextPhase(transition, input.nextPhase)) return reject("stale_phase");
  const progressed = withProgress(transition, input.nextPhase, input.proof, input.timestamp);
  if (progressed === undefined || !validTransitionProof(progressed))
    return reject("invalid_progress");
  return accept(
    current.revision,
    current.session,
    current.hardCap,
    { _tag: "Transitioning", transition: progressed },
    journal(input, progressed, "progressed", input.resultCode),
    intentsFor(progressed),
  );
};

type CompletedInput = Extract<SessionActorInput, { _tag: "TransitionCompleted" }>;
export const handleCompleted = (
  current: SessionAuthority,
  input: CompletedInput,
  transition: Transition,
): Decision => {
  if (!isTerminalPhase(transition)) return reject("not_terminal");
  const stable = completedStable(transition, input.proof);
  if (stable === undefined || !validStable(stable)) return reject("invalid_progress");
  return accept(
    current.revision,
    current.session,
    current.hardCap,
    { _tag: "Stable", stable },
    journal(input, transition, "completed", input.resultCode),
    [],
  );
};
