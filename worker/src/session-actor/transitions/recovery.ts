import { Match, Predicate } from "effect";
import type {
  BackupIdentity,
  BackupProof,
  Origin,
  ReadinessProgress,
  SessionAuthority,
  StableState,
  Transition,
} from "../authority";
import { AuthorityStateSchema, StableStateSchema, TransitionSchema } from "../authority";
import { accept, reject } from "../control";
import type { Decision, JournalEvent } from "../decision";
import type { SessionActorInput } from "../input";
import { transitionKind } from "../transition";

export type RecoveryInput = Extract<
  SessionActorInput,
  {
    _tag:
      | "RuntimeLifecycleObserved"
      | "SupervisorUnavailableObserved"
      | "TransportUnavailableObserved"
      | "HardCapDeadlineAlarm";
  }
>;

export const isRecoveryInput = (input: SessionActorInput): input is RecoveryInput =>
  Predicate.isTagged(input, "RuntimeLifecycleObserved") ||
  Predicate.isTagged(input, "SupervisorUnavailableObserved") ||
  Predicate.isTagged(input, "TransportUnavailableObserved") ||
  Predicate.isTagged(input, "HardCapDeadlineAlarm");

const transitionReadiness = (transition: Transition): ReadinessProgress | undefined =>
  "readiness" in transition.proof ? transition.proof.readiness : undefined;

const readinessOf = (authority: SessionAuthority): ReadinessProgress | undefined => {
  if (AuthorityStateSchema.guards.Transitioning(authority.state))
    return transitionReadiness(authority.state.transition);
  const stable = authority.state.stable;
  return StableStateSchema.guards.Warm(stable) ? stable.readiness : undefined;
};

const journal = (
  authority: SessionAuthority,
  input: RecoveryInput,
  eventType: JournalEvent["eventType"],
  resultCode: string,
): JournalEvent => {
  const transition = AuthorityStateSchema.guards.Transitioning(authority.state)
    ? authority.state.transition
    : undefined;
  return {
    timestamp: input.timestamp,
    correlationId: input.correlationId,
    transitionNonce: transition?.nonce ?? null,
    eventType,
    transitionKind: transition === undefined ? null : transitionKind(transition),
    transitionPhase: transition?.phase ?? null,
    resultCode,
    causeAttempt: transition?.attempt ?? null,
  };
};

const confirmedBackup = (
  backup: BackupIdentity | null,
  ownedBackupIds: ReadonlyArray<string>,
  currentBackupId: string | null,
): {
  readonly backup: BackupIdentity | null;
  readonly ownedBackupIds: ReadonlyArray<string>;
  readonly wakeSource: { readonly backupId: string; readonly confirmedAt: string } | null;
} => {
  if (
    backup === null ||
    backup.confirmedAt === null ||
    currentBackupId !== backup.backupId ||
    !ownedBackupIds.includes(backup.backupId)
  )
    return { backup: null, ownedBackupIds, wakeSource: null };
  return {
    backup,
    ownedBackupIds,
    wakeSource: { backupId: backup.backupId, confirmedAt: backup.confirmedAt },
  };
};

const fromBackupProof = (proof: BackupProof) =>
  confirmedBackup(proof.confirmed ?? proof.prepared, proof.ownedBackupIds, proof.currentBackupId);

const recoveryBackup = (authority: SessionAuthority) => {
  if (AuthorityStateSchema.guards.Stable(authority.state)) {
    const stable = authority.state.stable;
    if (StableStateSchema.guards.Warm(stable)) return fromBackupProof(stable.backups);
    if (StableStateSchema.guards.Sleeping(stable))
      return confirmedBackup(stable.backup, stable.ownedBackupIds, stable.backup.backupId);
    if (StableStateSchema.guards.Failed(stable))
      return confirmedBackup(stable.backup, stable.ownedBackupIds, stable.backup?.backupId ?? null);
    return confirmedBackup(null, [], null);
  }
  return Match.valueTags(authority.state.transition, {
    Create: () => confirmedBackup(null, [], null),
    Checkpoint: ({ proof }) => fromBackupProof(proof.backup),
    Sleep: ({ proof }) => fromBackupProof(proof.backup),
    Resume: ({ proof }) =>
      confirmedBackup(proof.backup, proof.ownedBackupIds, proof.backup.backupId),
    WarmWork: ({ proof }) => fromBackupProof(proof.backups),
    Vaporize: () => confirmedBackup(null, [], null),
  });
};

const failureOrigin = (
  authority: SessionAuthority,
): {
  readonly origin: Origin;
  readonly lastStable: "Warm" | "Sleeping" | null;
} => {
  if (AuthorityStateSchema.guards.Stable(authority.state)) {
    return Match.valueTags(authority.state.stable, {
      Warm: () => ({ origin: "Warm" as const, lastStable: "Warm" as const }),
      Sleeping: () => ({ origin: "Sleeping" as const, lastStable: "Sleeping" as const }),
      Failed: (stable) => ({ origin: "Failed" as const, lastStable: stable.lastStable }),
      Gone: () => ({ origin: "Gone" as const, lastStable: null }),
    });
  }
  return Match.valueTags(authority.state.transition, {
    Create: () => ({ origin: "Absent" as const, lastStable: null }),
    Checkpoint: () => ({ origin: "Warm" as const, lastStable: "Warm" as const }),
    Sleep: () => ({ origin: "Warm" as const, lastStable: "Warm" as const }),
    Resume: (transition) => ({
      origin: transition.origin,
      lastStable: transition.proof.lastStable,
    }),
    WarmWork: () => ({ origin: "Warm" as const, lastStable: "Warm" as const }),
    Vaporize: (transition) => ({ origin: transition.origin, lastStable: null }),
  });
};

const fail = (
  authority: SessionAuthority,
  input: RecoveryInput,
  failureCode: string,
  eventType: "availability_lost" | "hard_cap_elapsed",
): Decision => {
  const backup = recoveryBackup(authority);
  const origin = failureOrigin(authority);
  const actionable = backup.backup !== null && origin.lastStable !== null;
  const failed: StableState = {
    _tag: "Failed",
    code: failureCode,
    actionable,
    origin: origin.origin,
    lastStable: origin.lastStable,
    backup: actionable ? backup.backup : null,
    ownedBackupIds: backup.ownedBackupIds,
    wakeSource: actionable ? backup.wakeSource : null,
  };
  return accept(
    authority.revision,
    authority.session,
    authority.hardCap,
    { _tag: "Stable", stable: failed },
    journal(authority, input, eventType, failureCode),
    [],
  );
};

const reconcileTransition = (
  authority: SessionAuthority,
  input: Exclude<RecoveryInput, { readonly _tag: "HardCapDeadlineAlarm" }>,
): Decision => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return reject("not_admissible");
  const transition = authority.state.transition;
  if (TransitionSchema.guards.Vaporize(transition)) return reject("duplicate");
  if (transition.mode === "reconciling") return reject("duplicate");
  const reconciling = {
    ...transition,
    mode: "reconciling" as const,
    lastProgressAt: input.timestamp,
  };
  return accept(
    authority.revision,
    authority.session,
    authority.hardCap,
    { _tag: "Transitioning", transition: reconciling },
    journal(authority, input, "availability_lost", input.resultCode),
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

const settleStoppedSleep = (
  authority: SessionAuthority,
  input: Extract<RecoveryInput, { readonly _tag: "RuntimeLifecycleObserved" }>,
): Decision | undefined => {
  if (!AuthorityStateSchema.guards.Transitioning(authority.state)) return undefined;
  const transition = authority.state.transition;
  if (
    !TransitionSchema.guards.Sleep(transition) ||
    input.lifecycle !== "stopped" ||
    transition.mode !== "reconciling" ||
    (transition.phase !== "StopRequested" && transition.phase !== "RuntimeStopped")
  )
    return undefined;
  const prepared = transition.proof.backup.prepared;
  const requestedAt = transition.proof.stopRequestedAt ?? transition.proof.stop?.requestedAt;
  if (
    prepared === null ||
    prepared.confirmedAt === null ||
    transition.proof.backup.currentBackupId !== prepared.backupId ||
    !transition.proof.backup.ownedBackupIds.includes(prepared.backupId) ||
    requestedAt === undefined ||
    Date.parse(input.timestamp) < Date.parse(requestedAt)
  )
    return undefined;
  const stable: StableState = {
    _tag: "Sleeping",
    backup: prepared,
    ownedBackupIds: transition.proof.backup.ownedBackupIds,
    stop: {
      requestedAt,
      observedAt: input.timestamp,
      runtimeGeneration: input.expectedRuntimeGeneration,
    },
    wakeSource: { backupId: prepared.backupId, confirmedAt: prepared.confirmedAt },
  };
  return accept(
    authority.revision,
    authority.session,
    authority.hardCap,
    { _tag: "Stable", stable },
    journal(authority, input, "runtime_observed", input.resultCode),
    [],
  );
};

const handleRuntime = (
  authority: SessionAuthority,
  input: Extract<RecoveryInput, { readonly _tag: "RuntimeLifecycleObserved" }>,
): Decision => {
  const readiness = readinessOf(authority);
  const runtime = readiness?.runtime ?? null;
  if (
    runtime === null ||
    input.expectedProviderRuntimeId !== runtime.providerRuntimeId ||
    input.expectedRuntimeGeneration !== runtime.runtimeGeneration
  )
    return reject("stale_generation");
  if (AuthorityStateSchema.guards.Transitioning(authority.state)) {
    const transition = authority.state.transition;
    if (
      TransitionSchema.guards.Sleep(transition) &&
      input.lifecycle === "stopped" &&
      transition.mode === "executing" &&
      (transition.phase === "StopRequested" || transition.phase === "RuntimeStopped")
    )
      return reject("duplicate");
    const settledSleep = settleStoppedSleep(authority, input);
    if (settledSleep !== undefined) return settledSleep;
    return reconcileTransition(authority, input);
  }
  if (!StableStateSchema.guards.Warm(authority.state.stable)) return reject("not_admissible");
  if (
    input.lifecycle === "started" &&
    input.runtime !== null &&
    input.runtime.providerRuntimeId === runtime.providerRuntimeId &&
    input.runtime.runtimeGeneration === runtime.runtimeGeneration &&
    input.runtime.containerIncarnation === runtime.containerIncarnation
  )
    return accept(
      authority.revision,
      authority.session,
      authority.hardCap,
      authority.state,
      journal(authority, input, "runtime_observed", input.resultCode),
      [],
    );
  return fail(
    authority,
    input,
    input.lifecycle === "stopped" ? "runtime_stopped" : "runtime_replaced",
    "availability_lost",
  );
};

const handleSupervisor = (
  authority: SessionAuthority,
  input: Extract<RecoveryInput, { readonly _tag: "SupervisorUnavailableObserved" }>,
): Decision => {
  const readiness = readinessOf(authority);
  if (
    readiness?.runtime === null ||
    readiness?.runtime === undefined ||
    readiness.supervisor === null ||
    input.expectedRuntimeGeneration !== readiness.runtime.runtimeGeneration ||
    input.expectedSupervisorEpoch !== readiness.supervisor.supervisorEpoch
  )
    return reject("stale_generation");
  return AuthorityStateSchema.guards.Transitioning(authority.state)
    ? reconcileTransition(authority, input)
    : StableStateSchema.guards.Warm(authority.state.stable)
      ? fail(authority, input, "supervisor_unavailable", "availability_lost")
      : reject("not_admissible");
};

const handleTransport = (
  authority: SessionAuthority,
  input: Extract<RecoveryInput, { readonly _tag: "TransportUnavailableObserved" }>,
): Decision => {
  const readiness = readinessOf(authority);
  if (
    readiness?.runtime === null ||
    readiness?.runtime === undefined ||
    readiness.supervisor === null ||
    readiness.transport === null ||
    input.expectedRuntimeGeneration !== readiness.runtime.runtimeGeneration ||
    input.expectedSupervisorEpoch !== readiness.supervisor.supervisorEpoch ||
    input.expectedTransportId !== readiness.transport.transportId
  )
    return reject("stale_generation");
  return AuthorityStateSchema.guards.Transitioning(authority.state)
    ? reconcileTransition(authority, input)
    : StableStateSchema.guards.Warm(authority.state.stable)
      ? fail(authority, input, "transport_unavailable", "availability_lost")
      : reject("not_admissible");
};

const handleHardCap = (
  authority: SessionAuthority,
  input: Extract<RecoveryInput, { readonly _tag: "HardCapDeadlineAlarm" }>,
): Decision => {
  if (
    input.expectedGeneration !== authority.hardCap.generation ||
    input.expectedDeadlineAt !== authority.hardCap.deadlineAt
  )
    return reject("stale_generation");
  if (Date.parse(input.timestamp) < Date.parse(authority.hardCap.deadlineAt))
    return reject("stale_phase");
  if (
    (AuthorityStateSchema.guards.Stable(authority.state) &&
      (StableStateSchema.guards.Failed(authority.state.stable) ||
        StableStateSchema.guards.Gone(authority.state.stable))) ||
    (AuthorityStateSchema.guards.Transitioning(authority.state) &&
      TransitionSchema.guards.Vaporize(authority.state.transition))
  )
    return reject("duplicate");
  return fail(authority, input, "hard_cap_elapsed", "hard_cap_elapsed");
};

export const handleRecoveryInput = (authority: SessionAuthority, input: RecoveryInput): Decision =>
  Match.valueTags(input, {
    RuntimeLifecycleObserved: (value) => handleRuntime(authority, value),
    SupervisorUnavailableObserved: (value) => handleSupervisor(authority, value),
    TransportUnavailableObserved: (value) => handleTransport(authority, value),
    HardCapDeadlineAlarm: (value) => handleHardCap(authority, value),
  });
