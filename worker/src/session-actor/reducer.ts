import { Match, Predicate, Schema } from "effect";
import type {
  BackupIdentity,
  BackupProof,
  CleanupProof,
  HardCapProof,
  ReadinessProof,
  ReadinessProgress,
  SessionAuthority,
  StableState,
  Transition,
} from "./authority";
import {
  AuthorityStateSchema,
  CheckpointPhaseSchema,
  CheckpointProofSchema,
  CreatePhaseSchema,
  CreateProofSchema,
  emptyBackupProof,
  emptyCleanupProof,
  ResumePhaseSchema,
  ResumeProofSchema,
  SleepPhaseSchema,
  SleepProofSchema,
  StableStateSchema,
  TransitionSchema,
  VaporizePhaseSchema,
  VaporizeProofSchema,
  WarmWorkPhaseSchema,
  WarmWorkProofSchema,
} from "./authority";
import { accept, reject } from "./control";
import type { Decision, EffectIntent, JournalEvent } from "./decision";
import type { SessionActorInput, SessionCommand, TransitionProof } from "./input";
import { SessionCommandSchema } from "./input";
import { isNextPhase, isTerminalPhase, phaseIndex } from "./transition";
import { transitionKind } from "./transition";
import { handleRecoveryInput, isRecoveryInput } from "./transitions/recovery";

const isCreateProof = Schema.is(CreateProofSchema);
const isCheckpointProof = Schema.is(CheckpointProofSchema);
const isSleepProof = Schema.is(SleepProofSchema);
const isResumeProof = Schema.is(ResumeProofSchema);
const isWarmWorkProof = Schema.is(WarmWorkProofSchema);
const isVaporizeProof = Schema.is(VaporizeProofSchema);
const isCreatePhase = Schema.is(CreatePhaseSchema);
const isCheckpointPhase = Schema.is(CheckpointPhaseSchema);
const isSleepPhase = Schema.is(SleepPhaseSchema);
const isResumePhase = Schema.is(ResumePhaseSchema);
const isWarmWorkPhase = Schema.is(WarmWorkPhaseSchema);
const isVaporizePhase = Schema.is(VaporizePhaseSchema);

const requiredAbsence = [
  "runtime",
  "backups",
  "evidence",
  "grants",
  "hatch",
  "idempotency",
  "schedules",
] as const;

const nonEmpty = (value: string): boolean => value.length > 0;
const validTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));
const orderedTimestamps = (transition: Transition): boolean => {
  const startedAt = Date.parse(transition.startedAt);
  const lastProgressAt = Date.parse(transition.lastProgressAt);
  const deadlineAt = Date.parse(transition.deadlineAt);
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(lastProgressAt) &&
    Number.isFinite(deadlineAt) &&
    startedAt <= lastProgressAt &&
    startedAt <= deadlineAt
  );
};

const validReadiness = (readiness: ReadinessProof): boolean =>
  [
    readiness.runtime.providerRuntimeId,
    readiness.runtime.runtimeGeneration,
    readiness.runtime.containerIncarnation,
    readiness.supervisor.processId,
    readiness.supervisor.supervisorEpoch,
    readiness.transport.transportId,
  ].every(nonEmpty) &&
  readiness.supervisor.runtimeGeneration === readiness.runtime.runtimeGeneration &&
  readiness.supervisor.containerIncarnation === readiness.runtime.containerIncarnation &&
  readiness.transport.runtimeGeneration === readiness.runtime.runtimeGeneration &&
  readiness.transport.containerIncarnation === readiness.runtime.containerIncarnation &&
  readiness.transport.supervisorEpoch === readiness.supervisor.supervisorEpoch;

const validReadinessProgress = (readiness: ReadinessProgress): boolean => {
  const { runtime, supervisor, transport } = readiness;
  if (supervisor !== null && runtime === null) return false;
  if (transport !== null && (runtime === null || supervisor === null)) return false;
  if (
    runtime !== null &&
    ![runtime.providerRuntimeId, runtime.runtimeGeneration, runtime.containerIncarnation].every(
      nonEmpty,
    )
  )
    return false;
  if (
    runtime !== null &&
    supervisor !== null &&
    (![supervisor.processId, supervisor.supervisorEpoch].every(nonEmpty) ||
      supervisor.runtimeGeneration !== runtime.runtimeGeneration ||
      supervisor.containerIncarnation !== runtime.containerIncarnation)
  )
    return false;
  return (
    transport === null ||
    (runtime !== null &&
      supervisor !== null &&
      nonEmpty(transport.transportId) &&
      transport.runtimeGeneration === runtime.runtimeGeneration &&
      transport.containerIncarnation === runtime.containerIncarnation &&
      transport.supervisorEpoch === supervisor.supervisorEpoch)
  );
};

const completeReadiness = (progress: ReadinessProgress): ReadinessProof | undefined =>
  progress.runtime !== null && progress.supervisor !== null && progress.transport !== null
    ? { runtime: progress.runtime, supervisor: progress.supervisor, transport: progress.transport }
    : undefined;

const validBackupIdentity = (backup: BackupIdentity): boolean =>
  nonEmpty(backup.backupId) &&
  nonEmpty(backup.sourceRuntimeGeneration) &&
  validTimestamp(backup.preparedAt) &&
  (backup.confirmedAt === null ||
    (validTimestamp(backup.confirmedAt) &&
      Date.parse(backup.preparedAt) <= Date.parse(backup.confirmedAt)));

const validBackup = (backup: BackupProof, currentRequired: boolean): boolean => {
  if (new Set(backup.ownedBackupIds).size !== backup.ownedBackupIds.length) return false;
  if (backup.prepared !== null && !validBackupIdentity(backup.prepared)) return false;
  if (backup.currentBackupId === null) return !currentRequired;
  return (
    backup.prepared !== null &&
    backup.prepared.confirmedAt !== null &&
    backup.prepared.backupId === backup.currentBackupId &&
    backup.ownedBackupIds.includes(backup.currentBackupId)
  );
};

const validCleanup = (cleanup: CleanupProof, complete: boolean): boolean =>
  validTimestamp(cleanup.lastObservedAt) &&
  new Set(cleanup.absent).size === cleanup.absent.length &&
  (!complete ||
    (cleanup.absent.length === requiredAbsence.length &&
      requiredAbsence.every((category) => cleanup.absent.includes(category))));

const validHardCap = (hardCap: HardCapProof): boolean =>
  Number.isInteger(hardCap.durationSeconds) &&
  hardCap.durationSeconds > 0 &&
  nonEmpty(hardCap.generation) &&
  validTimestamp(hardCap.deadlineAt);

const validActivity = (activity: NonNullable<StableCase<"Warm">["activity"]>): boolean =>
  nonEmpty(activity.supervisorEpoch) &&
  Number.isInteger(activity.piSequence) &&
  activity.piSequence >= 0 &&
  validTimestamp(activity.observedAt) &&
  validTimestamp(activity.expiresAt) &&
  Date.parse(activity.observedAt) <= Date.parse(activity.expiresAt);

type StableCase<Tag extends StableState["_tag"]> = Extract<StableState, { _tag: Tag }>;

const validWarm = (stable: StableCase<"Warm">): boolean =>
  validReadiness(stable.readiness) &&
  validBackup(stable.backups, stable.backups.currentBackupId !== null) &&
  (stable.activity === null ||
    (stable.activity.supervisorEpoch === stable.readiness.supervisor.supervisorEpoch &&
      validActivity(stable.activity)));

const validSleeping = (stable: StableCase<"Sleeping">): boolean =>
  validBackupIdentity(stable.backup) &&
  stable.backup.confirmedAt !== null &&
  stable.ownedBackupIds.includes(stable.backup.backupId) &&
  stable.wakeSource.backupId === stable.backup.backupId &&
  stable.wakeSource.confirmedAt === stable.backup.confirmedAt &&
  stable.stop.runtimeGeneration === stable.backup.sourceRuntimeGeneration &&
  validTimestamp(stable.stop.requestedAt) &&
  validTimestamp(stable.stop.observedAt) &&
  stable.stop.requestedAt <= stable.stop.observedAt;

const validFailedBackup = (stable: StableCase<"Failed">): boolean =>
  (stable.backup === null && stable.ownedBackupIds.length === 0 && stable.wakeSource === null) ||
  (stable.backup !== null &&
    stable.backup.confirmedAt !== null &&
    validBackupIdentity(stable.backup) &&
    stable.ownedBackupIds.includes(stable.backup.backupId));

const validFailed = (stable: StableCase<"Failed">): boolean =>
  nonEmpty(stable.code) &&
  ((stable.origin === "Absent" && stable.lastStable === null) ||
    (stable.origin !== "Absent" && stable.lastStable !== null)) &&
  validFailedBackup(stable) &&
  (!stable.actionable ||
    (stable.backup !== null &&
      stable.wakeSource !== null &&
      stable.wakeSource.backupId === stable.backup.backupId &&
      stable.wakeSource.confirmedAt === stable.backup.confirmedAt));

const validStable = (stable: StableState): boolean =>
  Match.valueTags(stable, {
    Warm: validWarm,
    Sleeping: validSleeping,
    Failed: validFailed,
    Gone: ({ cleanup }) => validCleanup(cleanup, true),
  });

type TransitionCase<Tag extends Transition["_tag"]> = Extract<Transition, { _tag: Tag }>;

const validCreateTransition = (transition: TransitionCase<"Create">, index: number): boolean =>
  transition.origin === "Absent" &&
  validReadinessProgress(transition.proof.readiness) &&
  (index < 3 || transition.proof.readiness.runtime !== null) &&
  (index < 6 || transition.proof.readiness.supervisor !== null);

const validCheckpointTransition = (
  transition: TransitionCase<"Checkpoint">,
  index: number,
): boolean =>
  transition.origin === "Warm" &&
  validReadiness(transition.proof.readiness) &&
  validBackup(transition.proof.backup, index >= 4) &&
  (index < 1 || transition.proof.piStoppedAt !== null);

const validSleepTransition = (transition: TransitionCase<"Sleep">, index: number): boolean => {
  const stopRequestedAt = transition.proof.stopRequestedAt ?? transition.proof.stop?.requestedAt;
  return (
    transition.origin === "Warm" &&
    validReadiness(transition.proof.readiness) &&
    validBackup(transition.proof.backup, index >= 3) &&
    (index < 1 || transition.proof.piStoppedAt !== null) &&
    (index < 4 || (stopRequestedAt !== undefined && validTimestamp(stopRequestedAt))) &&
    (index < 5 || transition.proof.stop !== null) &&
    (transition.proof.stop === null || stopRequestedAt === transition.proof.stop.requestedAt)
  );
};

const validResumeTransition = (transition: TransitionCase<"Resume">, index: number): boolean =>
  (transition.origin === "Sleeping" || transition.origin === "Failed") &&
  validBackupIdentity(transition.proof.backup) &&
  transition.proof.backup.confirmedAt !== null &&
  transition.proof.ownedBackupIds.includes(transition.proof.backup.backupId) &&
  validTimestamp(transition.proof.watchdogArmedAt) &&
  validReadinessProgress(transition.proof.readiness) &&
  (index < 2 || transition.proof.readiness.runtime !== null) &&
  (index < 4 || transition.proof.readiness.supervisor !== null) &&
  (index < 5 || transition.proof.readiness.transport !== null);

const validWarmWorkTransition = (transition: TransitionCase<"WarmWork">, index: number): boolean =>
  transition.origin === "Warm" &&
  validReadiness(transition.proof.readiness) &&
  validBackup(transition.proof.backups, transition.proof.backups.currentBackupId !== null) &&
  (transition.proof.activity === null ||
    (transition.proof.activity.supervisorEpoch ===
      transition.proof.readiness.supervisor.supervisorEpoch &&
      validActivity(transition.proof.activity))) &&
  nonEmpty(transition.proof.activityGeneration) &&
  (index < 2 || transition.proof.resultCode !== null);

const validVaporizeTransition = (transition: TransitionCase<"Vaporize">, index: number): boolean =>
  validCleanup(transition.proof.cleanup, false) &&
  new Set(transition.proof.ownedBackupIds).size === transition.proof.ownedBackupIds.length &&
  (index < 1 || transition.proof.revokedAt !== null);

const validTransitionProof = (transition: Transition): boolean => {
  const index = phaseIndex(transition);
  if (
    index < 0 ||
    !orderedTimestamps(transition) ||
    !nonEmpty(transition.nonce) ||
    !nonEmpty(transition.attempt)
  )
    return false;
  return Match.valueTags(transition, {
    Create: (value) => validCreateTransition(value, index),
    Checkpoint: (value) => validCheckpointTransition(value, index),
    Sleep: (value) => validSleepTransition(value, index),
    Resume: (value) => validResumeTransition(value, index),
    WarmWork: (value) => validWarmWorkTransition(value, index),
    Vaporize: (value) => validVaporizeTransition(value, index),
  });
};

export const validateAuthority = (authority: SessionAuthority): boolean =>
  [
    authority.session.id,
    authority.session.title,
    authority.session.repository,
    authority.session.createdAt,
  ].every(nonEmpty) &&
  validTimestamp(authority.session.createdAt) &&
  validHardCap(authority.hardCap) &&
  Number.isInteger(authority.revision) &&
  authority.revision >= 1 &&
  Match.valueTags(authority.state, {
    Stable: ({ stable }) => validStable(stable),
    Transitioning: ({ transition }) => validTransitionProof(transition),
  });

const commandRevision = (current: SessionAuthority | undefined): number => current?.revision ?? 0;

const originOf = (current: SessionAuthority): Transition["origin"] =>
  Match.valueTags(current.state, {
    Stable: ({ stable }) =>
      Match.valueTags(stable, {
        Warm: () => "Warm" as const,
        Sleeping: () => "Sleeping" as const,
        Failed: () => "Failed" as const,
        Gone: () => "Gone" as const,
      }),
    Transitioning: ({ transition }) => transition.origin,
  });

const ownedBackupsOf = (current: SessionAuthority): ReadonlyArray<string> =>
  Match.valueTags(current.state, {
    Stable: ({ stable }) =>
      Match.valueTags(stable, {
        Warm: ({ backups }) => backups.ownedBackupIds,
        Sleeping: ({ ownedBackupIds }) => ownedBackupIds,
        Failed: ({ ownedBackupIds }) => ownedBackupIds,
        Gone: () => [],
      }),
    Transitioning: ({ transition }) =>
      Match.valueTags(transition, {
        Create: () => [],
        Checkpoint: ({ proof }) => proof.backup.ownedBackupIds,
        Sleep: ({ proof }) => proof.backup.ownedBackupIds,
        Resume: ({ proof }) => proof.ownedBackupIds,
        WarmWork: ({ proof }) => proof.backups.ownedBackupIds,
        Vaporize: ({ proof }) => proof.ownedBackupIds,
      }),
  });

const base = (command: SessionCommand, origin: Transition["origin"]) => ({
  nonce: command.nonce,
  origin,
  attempt: command.attempt,
  startedAt: command.timestamp,
  lastProgressAt: command.timestamp,
  deadlineAt: command.deadlineAt,
  mode: "executing" as const,
});

const warmFrom = (current: SessionAuthority | undefined): StableCase<"Warm"> | undefined =>
  current !== undefined &&
  AuthorityStateSchema.guards.Stable(current.state) &&
  StableStateSchema.guards.Warm(current.state.stable)
    ? current.state.stable
    : undefined;

const resumableFrom = (
  current: SessionAuthority | undefined,
): StableCase<"Sleeping"> | StableCase<"Failed"> | undefined => {
  if (current === undefined || !AuthorityStateSchema.guards.Stable(current.state)) return undefined;
  const stable = current.state.stable;
  if (StableStateSchema.guards.Sleeping(stable)) return stable;
  return StableStateSchema.guards.Failed(stable) && stable.actionable ? stable : undefined;
};

const commandTransition = (
  current: SessionAuthority | undefined,
  command: SessionCommand,
): Transition | undefined => {
  return Match.valueTags(command, {
    CreateCommand: (value) => {
      if (current !== undefined) return undefined;
      return {
        _tag: "Create",
        ...base(value, "Absent"),
        phase: "IntentCommitted",
        proof: {
          workspaceId: null,
          readiness: { runtime: null, supervisor: null, transport: null },
        },
      } satisfies Transition;
    },
    CheckpointCommand: (value) => {
      const warm = warmFrom(current);
      if (warm === undefined) return undefined;
      return {
        _tag: "Checkpoint",
        ...base(value, "Warm"),
        phase: "Quiescing",
        proof: {
          readiness: warm.readiness,
          piStoppedAt: null,
          backup: warm.backups,
        },
      } satisfies Transition;
    },
    SleepCommand: (value) => {
      const warm = warmFrom(current);
      if (warm === undefined) return undefined;
      return {
        _tag: "Sleep",
        ...base(value, "Warm"),
        phase: "Quiescing",
        proof: {
          readiness: warm.readiness,
          piStoppedAt: null,
          backup: warm.backups,
          stopRequestedAt: null,
          stop: null,
        },
      } satisfies Transition;
    },
    ResumeCommand: (value) => {
      const stable = resumableFrom(current);
      if (stable === undefined) return undefined;
      const backup = stable.backup;
      if (backup === null || backup.confirmedAt === null) return undefined;
      const ownedBackupIds = stable.ownedBackupIds;
      const lastStable = StableStateSchema.guards.Sleeping(stable) ? "Sleeping" : stable.lastStable;
      if (lastStable === null) return undefined;
      return {
        _tag: "Resume",
        ...base(value, StableStateSchema.guards.Sleeping(stable) ? "Sleeping" : "Failed"),
        phase: "WatchdogArmed",
        proof: {
          backup,
          ownedBackupIds,
          lastStable,
          watchdogArmedAt: value.timestamp,
          readiness: { runtime: null, supervisor: null, transport: null },
        },
      } satisfies Transition;
    },
    WarmWorkCommand: (value) => {
      const warm = warmFrom(current);
      if (warm === undefined) return undefined;
      return {
        _tag: "WarmWork",
        ...base(value, "Warm"),
        phase: "Admitted",
        workKind: value.workKind,
        proof: {
          readiness: warm.readiness,
          backups: warm.backups,
          activity: warm.activity,
          activityGeneration: value.attempt,
          resultCode: null,
        },
      } satisfies Transition;
    },
    VaporizeCommand: (value) => {
      if (
        current !== undefined &&
        AuthorityStateSchema.guards.Transitioning(current.state) &&
        TransitionSchema.guards.Vaporize(current.state.transition)
      )
        return undefined;
      if (current === undefined) return undefined;
      if (
        AuthorityStateSchema.guards.Stable(current.state) &&
        StableStateSchema.guards.Gone(current.state.stable)
      )
        return undefined;
      return {
        _tag: "Vaporize",
        ...base(value, originOf(current)),
        phase: "Admitted",
        proof: {
          revokedAt: null,
          ownedBackupIds: [...ownedBackupsOf(current)],
          cleanup: emptyCleanupProof(value.timestamp),
        },
      } satisfies Transition;
    },
  });
};

const journal = (
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

const intentsFor = (transition: Transition): ReadonlyArray<EffectIntent> => [
  {
    _tag: "ExecutePhase",
    transitionKind: transitionKind(transition),
    phase: transition.phase,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
  },
];

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

const isCommand = (input: SessionActorInput): input is SessionCommand =>
  Match.valueTags(input, {
    CreateCommand: () => true,
    CheckpointCommand: () => true,
    SleepCommand: () => true,
    ResumeCommand: () => true,
    WarmWorkCommand: () => true,
    VaporizeCommand: () => true,
    ActorFact: () => false,
    RuntimeObservation: () => false,
    ProviderObservation: () => false,
    TransitionCompleted: () => false,
    TransitionFailed: () => false,
    DeadlineAlarm: () => false,
    UnknownProviderOutcome: () => false,
    ActivityObserved: () => false,
    RuntimeLifecycleObserved: () => false,
    SupervisorUnavailableObserved: () => false,
    TransportUnavailableObserved: () => false,
    HardCapDeadlineAlarm: () => false,
  });

const handleCommand = (
  current: SessionAuthority | undefined,
  command: SessionCommand,
): Decision => {
  if (command.expectedRevision !== commandRevision(current)) return reject("revision_mismatch");
  if (
    current !== undefined &&
    AuthorityStateSchema.guards.Transitioning(current.state) &&
    !SessionCommandSchema.guards.VaporizeCommand(command)
  )
    return reject("transition_owned");
  const transition = commandTransition(current, command);
  if (transition === undefined)
    return reject(
      SessionCommandSchema.guards.VaporizeCommand(command) ? "duplicate" : "not_admissible",
    );
  if (!validTransitionProof(transition)) return reject("invalid_progress");
  const session = SessionCommandSchema.guards.CreateCommand(command)
    ? command.session
    : current?.session;
  if (session === undefined) return reject("not_admissible");
  const hardCap = SessionCommandSchema.guards.CreateCommand(command)
    ? command.hardCap
    : SessionCommandSchema.guards.ResumeCommand(command)
      ? command.nextHardCap
      : current?.hardCap;
  if (hardCap === undefined || !validHardCap(hardCap)) return reject("not_admissible");
  return accept(
    commandRevision(current),
    session,
    hardCap,
    { _tag: "Transitioning", transition },
    journal(command, transition, "admitted", "admitted"),
    [
      {
        _tag: "ArmDeadline",
        deadlineAt: transition.deadlineAt,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
      },
      ...intentsFor(transition),
    ],
  );
};

type ActivityInput = Extract<SessionActorInput, { _tag: "ActivityObserved" }>;

const handleActivity = (current: SessionAuthority, input: ActivityInput): Decision => {
  if (input.revision !== current.revision)
    return reject(input.revision < current.revision ? "duplicate" : "revision_mismatch");
  const warm = warmFrom(current);
  if (warm === undefined) return reject("not_admissible");
  if (
    input.expectedRuntimeGeneration !== warm.readiness.runtime.runtimeGeneration ||
    input.expectedSupervisorEpoch !== warm.readiness.supervisor.supervisorEpoch ||
    input.activity.supervisorEpoch !== warm.readiness.supervisor.supervisorEpoch
  )
    return reject("stale_generation");
  if (
    warm.activity !== null &&
    warm.activity.supervisorEpoch === input.activity.supervisorEpoch &&
    input.activity.piSequence <= warm.activity.piSequence
  )
    return reject("duplicate");
  if (
    Date.parse(input.activity.observedAt) > Date.parse(input.timestamp) ||
    Date.parse(input.activity.expiresAt) <= Date.parse(input.timestamp)
  )
    return reject("invalid_progress");
  const stable: StableState = { ...warm, activity: input.activity };
  if (!validStable(stable)) return reject("invalid_progress");
  return accept(
    current.revision,
    current.session,
    current.hardCap,
    { _tag: "Stable", stable },
    {
      timestamp: input.timestamp,
      correlationId: input.correlationId,
      transitionNonce: null,
      eventType: "activity_observed",
      transitionKind: null,
      transitionPhase: null,
      resultCode: "observed",
      causeAttempt: null,
    },
    [],
  );
};

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
    lastProgressAt: input.timestamp,
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
        _tag: "ArmDeadline",
        deadlineAt: transition.deadlineAt,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
      },
      {
        _tag: "ReconcileTransition",
        transitionKind: transitionKind(transition),
        phase: transition.phase,
        transitionNonce: transition.nonce,
        attempt: transition.attempt,
      },
    ],
  );
};

type DeadlineInput = Extract<SessionActorInput, { _tag: "DeadlineAlarm" }>;
const handleDeadline = (
  current: SessionAuthority,
  input: DeadlineInput,
  transition: Transition,
): Decision => {
  if (transition.mode === "reconciling") return reject("duplicate");
  if (
    input.expectedDeadlineAt !== transition.deadlineAt ||
    Date.parse(input.timestamp) < Date.parse(transition.deadlineAt)
  )
    return reject("stale_phase");
  return reconcile(current, input, transition, "deadline_reconciling", "deadline_elapsed");
};

type UnknownInput = Extract<SessionActorInput, { _tag: "UnknownProviderOutcome" }>;
const runtimeProof = (transition: Transition) =>
  "readiness" in transition.proof ? transition.proof.readiness.runtime : null;

const handleUnknown = (
  current: SessionAuthority,
  input: UnknownInput,
  transition: Transition,
): Decision => {
  if (transition.mode === "reconciling") return reject("duplicate");
  const runtime = runtimeProof(transition);
  if (
    input.expectedProviderRuntimeId !== null &&
    (runtime === null || input.expectedProviderRuntimeId !== runtime.providerRuntimeId)
  )
    return reject("stale_generation");
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

const handleFailure = (
  current: SessionAuthority,
  input: FailedInput,
  transition: Transition,
): Decision => {
  if (TransitionSchema.guards.Vaporize(transition))
    return reconcile(current, input, transition, "provider_reconciling", input.resultCode);
  const failed: StableState = {
    _tag: "Failed",
    code: input.failureCode,
    actionable: input.actionable,
    origin: transition.origin,
    lastStable: failedLastStable(transition),
    backup: input.backup,
    ownedBackupIds: input.ownedBackupIds,
    wakeSource: input.wakeSource,
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

const handleProgress = (
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
const handleCompleted = (
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

type FencedInput = TransitionFencedInput;
const handleFenced = (current: SessionAuthority, input: FencedInput): Decision => {
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
  if (isCommand(input)) return handleCommand(current, input);
  if (current === undefined) return reject("duplicate");
  if (isRecoveryInput(input)) return handleRecoveryInput(current, input);
  if (Predicate.isTagged(input, "ActivityObserved")) return handleActivity(current, input);
  return handleFenced(current, input);
};
