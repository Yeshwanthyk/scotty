import { Match } from "effect";
import type { SessionAuthority, Transition } from "./authority";
import {
  AuthorityStateSchema,
  StableStateSchema,
  TransitionSchema,
  emptyCleanupProof,
} from "./authority";
import { accept, intentsFor, journal, reject, warmFrom } from "./control";
import type { Decision } from "./decision";
import type { SessionActorInput, SessionCommand } from "./input";
import { RenameCommandSchema, SessionCommandSchema } from "./input";
import type { StableCase } from "./validity";
import { nonEmpty, validHardCap, validTransitionProof } from "./validity";

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

export const isCommand = (input: SessionActorInput): input is SessionCommand =>
  Match.valueTags(input, {
    CreateCommand: () => true,
    CheckpointCommand: () => true,
    SleepCommand: () => true,
    ResumeCommand: () => true,
    WarmWorkCommand: () => true,
    VaporizeCommand: () => true,
    RenameCommand: () => false,
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

export const handleCommand = (
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
    intentsFor(transition),
  );
};

export const handleRename = (
  current: SessionAuthority | undefined,
  input: typeof RenameCommandSchema.Type,
): Decision => {
  if (current === undefined) return reject("not_admissible");
  if (input.expectedRevision !== current.revision) return reject("revision_mismatch");
  if (AuthorityStateSchema.guards.Transitioning(current.state)) return reject("transition_owned");
  if (StableStateSchema.guards.Gone(current.state.stable)) return reject("not_admissible");
  if (!nonEmpty(input.title)) return reject("not_admissible");
  if (current.session.title === input.title) return reject("duplicate");
  return {
    _tag: "Accepted",
    nextAuthority: {
      ...current,
      revision: current.revision + 1,
      session: { ...current.session, title: input.title },
    },
    journalEvent: {
      timestamp: input.timestamp,
      correlationId: input.correlationId,
      transitionNonce: null,
      eventType: "renamed",
      transitionKind: null,
      transitionPhase: null,
      resultCode: "renamed",
      causeAttempt: null,
    },
    effectIntents: [],
  };
};
