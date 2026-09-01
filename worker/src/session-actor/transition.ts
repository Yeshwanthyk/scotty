import { Match } from "effect";
import type { Transition } from "./authority";

export const phases = {
  Create: [
    "IntentCommitted",
    "WorkspacePreparing",
    "RuntimeMaterializing",
    "RuntimeReady",
    "SupervisorStarting",
    "SupervisorReady",
    "TransportVerifying",
  ],
  Checkpoint: [
    "Quiescing",
    "PiStopped",
    "Syncing",
    "BackupPrepared",
    "BackupConfirmed",
    "SupervisorRestarting",
    "TransportReady",
  ],
  Sleep: [
    "Quiescing",
    "PiStopped",
    "Syncing",
    "BackupConfirmed",
    "StopRequested",
    "RuntimeStopped",
  ],
  Resume: [
    "WatchdogArmed",
    "BackupRestoring",
    "RuntimeReady",
    "SupervisorStarting",
    "SupervisorReady",
    "TransportReady",
  ],
  WarmWork: ["Admitted", "Running", "Settling"],
  Vaporize: [
    "Admitted",
    "RuntimeAccessRevoked",
    "HatchClosing",
    "EvidenceInterrupting",
    "RuntimeDestroying",
    "BackupsDeleting",
    "EvidenceDeleting",
    "GrantsReleasing",
    "AbsenceConfirming",
  ],
} as const;

export type TransitionKind = keyof typeof phases;
export type TransitionPhase = Transition["phase"];

export const transitionKind = (transition: Transition): TransitionKind =>
  Match.valueTags(transition, {
    Create: (): TransitionKind => "Create",
    Checkpoint: (): TransitionKind => "Checkpoint",
    Sleep: (): TransitionKind => "Sleep",
    Resume: (): TransitionKind => "Resume",
    WarmWork: (): TransitionKind => "WarmWork",
    Vaporize: (): TransitionKind => "Vaporize",
  });

export const transitionPhases = (transition: Transition): ReadonlyArray<string> =>
  Match.valueTags(transition, {
    Create: () => phases.Create,
    Checkpoint: () => phases.Checkpoint,
    Sleep: () => phases.Sleep,
    Resume: () => phases.Resume,
    WarmWork: () => phases.WarmWork,
    Vaporize: () => phases.Vaporize,
  });

export const phaseIndex = (transition: Transition): number =>
  transitionPhases(transition).indexOf(transition.phase);

export const isNextPhase = (transition: Transition, nextPhase: string): boolean =>
  transitionPhases(transition)[phaseIndex(transition) + 1] === nextPhase;

export const isTerminalPhase = (transition: Transition): boolean =>
  phaseIndex(transition) === transitionPhases(transition).length - 1;
