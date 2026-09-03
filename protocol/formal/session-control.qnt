/*
 * Scotty session actor control model.
 *
 * This model mirrors worker/src/session-actor/{authority,input,reducer,public-view}.ts after the
 * Slice 9 cutover. Identifiers and timestamps are reduced to bounded integers and proof payloads
 * are reduced to the relationships the reducer validates. The lifecycle variants, phases,
 * admission rules, fences, proof requirements, public mapping, and cleanup categories are exact.
 *
 * Checked with Quint 0.32.0:
 *   npx --yes @informalsystems/quint@0.32.0 parse protocol/formal/session-control.qnt
 *   npx --yes @informalsystems/quint@0.32.0 typecheck protocol/formal/session-control.qnt
 *   npx --yes @informalsystems/quint@0.32.0 run protocol/formal/session-control.qnt \
 *     --init=init --step=step --max-steps=60 --max-samples=20000 \
 *     --invariants=safety
 *
 * Progress claims are conditional. They require logical time to advance, fair actor execution,
 * eventual alarm delivery, and decisive provider observations for Vaporize to reach Gone.
 * Repeated ordinary ambiguity and ordinary deadlines terminate as Failed; ambiguous Vaporize
 * retains cleanup authority until absence is confirmed.
 */
module session_control {
  type StableKind = NoStable | Warm | Sleeping | Failed | Gone
  type Origin = Absent | OriginWarm | OriginSleeping | OriginFailed | OriginGone
  type TransitionKind =
    | NoTransition
    | Create
    | Checkpoint
    | Sleep
    | Resume
    | WarmWork
    | Vaporize
  type Phase =
    | NoPhase
    | CreateIntentCommitted
    | CreateWorkspacePreparing
    | CreateRuntimeMaterializing
    | CreateRuntimeReady
    | CreateSupervisorStarting
    | CreateSupervisorReady
    | CreateTransportVerifying
    | CheckpointQuiescing
    | CheckpointPiStopped
    | CheckpointSyncing
    | CheckpointBackupPrepared
    | CheckpointBackupConfirmed
    | CheckpointSupervisorRestarting
    | CheckpointTransportReady
    | SleepQuiescing
    | SleepPiStopped
    | SleepSyncing
    | SleepBackupConfirmed
    | SleepStopRequested
    | SleepRuntimeStopped
    | ResumeWatchdogArmed
    | ResumeBackupRestoring
    | ResumeRuntimeReady
    | ResumeSupervisorStarting
    | ResumeSupervisorReady
    | ResumeTransportReady
    | WarmWorkAdmitted
    | WarmWorkRunning
    | WarmWorkSettling
    | VaporizeAdmitted
    | VaporizeRuntimeAccessRevoked
    | VaporizeHatchClosing
    | VaporizeEvidenceInterrupting
    | VaporizeRuntimeDestroying
    | VaporizeBackupsDeleting
    | VaporizeEvidenceDeleting
    | VaporizeGrantsReleasing
    | VaporizeAbsenceConfirming
  type Mode = NoMode | Executing | Reconciling
  type AbsenceCategory = Runtime | Backups | Evidence | Grants | Hatch | Idempotency | Schedules
  type PublicStatus = NoPublicStatus | Booting | PublicWarm | PublicSleeping | PublicFailed | PublicGone
  type PublicAction = PublicCheckpoint | PublicSleep | PublicResume | PublicWork | PublicVaporize
  type JournalEvent =
    | NoJournalEvent
    | AdmittedEvent
    | ProgressedEvent
    | CompletedEvent
    | DeadlineReconcilingEvent
    | ProviderReconcilingEvent
    | ActivityObservedEvent
    | AvailabilityLostEvent
    | HardCapElapsedEvent
    | RenamedEvent
  type InputClass =
    | NoInput
    | CommandInput
    | FencedFact
    | StaleFact
    | DeadlineInput
    | ProviderUnknownInput
    | RecoveryInput
    | ActivityInput
  type Outcome = NoOutcome | Committed | Rejected

  type Authority = {
    present: bool,
    revision: int,
    journalRevision: int,
    journalEvent: JournalEvent,
    stable: StableKind,
    origin: Origin,
    transition: TransitionKind,
    phase: Phase,
    mode: Mode,
    nonce: int,
    attempt: int,
    hardCapGeneration: int,
    runtimeReady: bool,
    runtimeGeneration: int,
    runtimeContainer: int,
    supervisorReady: bool,
    supervisorRuntimeGeneration: int,
    supervisorContainer: int,
    supervisorEpoch: int,
    transportReady: bool,
    transportRuntimeGeneration: int,
    transportContainer: int,
    transportSupervisorEpoch: int,
    workspaceReady: bool,
    piStopped: bool,
    backupPrepared: bool,
    backupConfirmed: bool,
    backupOwned: bool,
    backupCurrent: bool,
    stopRequested: bool,
    runtimeStopped: bool,
    wakeSource: bool,
    actionableFailure: bool,
    activityPresent: bool,
    activitySupervisorEpoch: int,
    activitySequence: int,
    activityFresh: bool,
    runtimeAccessRevoked: bool,
    absent: Set[AbsenceCategory],
  }

  pure val allAbsent = Set(Runtime, Backups, Evidence, Grants, Hatch, Idempotency, Schedules)

  var authority: Authority
  var previousRevision: int
  var lastInput: InputClass
  var lastOutcome: Outcome

  pure def emptyAuthority: Authority = {
    present: false,
    revision: 0,
    journalRevision: 0,
    journalEvent: NoJournalEvent,
    stable: NoStable,
    origin: Absent,
    transition: NoTransition,
    phase: NoPhase,
    mode: NoMode,
    nonce: 0,
    attempt: 0,
    hardCapGeneration: 0,
    runtimeReady: false,
    runtimeGeneration: 0,
    runtimeContainer: 0,
    supervisorReady: false,
    supervisorRuntimeGeneration: 0,
    supervisorContainer: 0,
    supervisorEpoch: 0,
    transportReady: false,
    transportRuntimeGeneration: 0,
    transportContainer: 0,
    transportSupervisorEpoch: 0,
    workspaceReady: false,
    piStopped: false,
    backupPrepared: false,
    backupConfirmed: false,
    backupOwned: false,
    backupCurrent: false,
    stopRequested: false,
    runtimeStopped: false,
    wakeSource: false,
    actionableFailure: false,
    activityPresent: false,
    activitySupervisorEpoch: 0,
    activitySequence: 0,
    activityFresh: false,
    runtimeAccessRevoked: false,
    absent: Set(),
  }

  pure def committed(candidate: Authority, event: JournalEvent): Authority = {
    ...candidate,
    revision: candidate.revision + 1,
    journalRevision: candidate.revision + 1,
    journalEvent: event,
    mode: if (event == ProgressedEvent) Executing else candidate.mode,
  }

  action accept(candidate: Authority, event: JournalEvent, input: InputClass): bool = all {
    authority' = committed(candidate, event),
    previousRevision' = authority.revision,
    lastInput' = input,
    lastOutcome' = Committed,
  }

  action reject(input: InputClass): bool = all {
    authority' = authority,
    previousRevision' = previousRevision,
    lastInput' = input,
    lastOutcome' = Rejected,
  }

  action init = all {
    authority' = emptyAuthority,
    previousRevision' = 0,
    lastInput' = NoInput,
    lastOutcome' = NoOutcome,
  }

  pure def isStable(a: Authority): bool = a.present and a.transition == NoTransition
  pure def isTransitioning(a: Authority): bool = a.present and a.transition != NoTransition
  pure def isWarm(a: Authority): bool = isStable(a) and a.stable == Warm
  pure def isSleeping(a: Authority): bool = isStable(a) and a.stable == Sleeping
  pure def isFailed(a: Authority): bool = isStable(a) and a.stable == Failed
  pure def isGone(a: Authority): bool = isStable(a) and a.stable == Gone

  pure def coherentReadiness(a: Authority): bool = and {
    a.runtimeReady,
    a.supervisorReady,
    a.transportReady,
    a.runtimeGeneration > 0,
    a.runtimeContainer > 0,
    a.supervisorEpoch > 0,
    a.supervisorRuntimeGeneration == a.runtimeGeneration,
    a.supervisorContainer == a.runtimeContainer,
    a.transportRuntimeGeneration == a.runtimeGeneration,
    a.transportContainer == a.runtimeContainer,
    a.transportSupervisorEpoch == a.supervisorEpoch,
  }

  pure def validBackupOwnership(a: Authority): bool = and {
    a.backupPrepared implies a.backupOwned,
    a.backupConfirmed implies and { a.backupPrepared, a.backupOwned, a.backupCurrent },
    a.backupCurrent implies and { a.backupPrepared, a.backupConfirmed, a.backupOwned },
  }

  pure def originStatus(origin: Origin): PublicStatus = match origin {
    | Absent => Booting
    | OriginWarm => PublicWarm
    | OriginSleeping => PublicSleeping
    | OriginFailed => PublicFailed
    | OriginGone => PublicGone
  }

  pure def publicStatus(a: Authority): PublicStatus =
    if (not(a.present)) NoPublicStatus
    else if (isStable(a)) match a.stable {
      | NoStable => NoPublicStatus
      | Warm => PublicWarm
      | Sleeping => PublicSleeping
      | Failed => PublicFailed
      | Gone => PublicGone
    }
    else match a.transition {
      | Create => Booting
      | Resume => Booting
      | Checkpoint => originStatus(a.origin)
      | Sleep => originStatus(a.origin)
      | WarmWork => originStatus(a.origin)
      | Vaporize => originStatus(a.origin)
      | NoTransition => NoPublicStatus
    }

  pure def deleting(a: Authority): bool = isTransitioning(a) and a.transition == Vaporize

  pure def publicActions(a: Authority): Set[PublicAction] = {
    val status = publicStatus(a)
    if (isTransitioning(a) or status == PublicGone or status == Booting or status == NoPublicStatus) Set()
    else if (status == PublicWarm)
      Set(PublicCheckpoint, PublicSleep, PublicWork, PublicVaporize)
    else if (status == PublicSleeping)
      Set(PublicResume, PublicVaporize)
    else if (a.actionableFailure)
      Set(PublicResume, PublicVaporize)
    else
      Set(PublicVaporize)
  }

  pure def stableOrigin(a: Authority): Origin = match a.stable {
    | Warm => OriginWarm
    | Sleeping => OriginSleeping
    | Failed => OriginFailed
    | Gone => OriginGone
    | NoStable => Absent
  }

  pure val createPhases = Set(
    CreateIntentCommitted,
    CreateWorkspacePreparing,
    CreateRuntimeMaterializing,
    CreateRuntimeReady,
    CreateSupervisorStarting,
    CreateSupervisorReady,
    CreateTransportVerifying
  )
  pure val checkpointPhases = Set(
    CheckpointQuiescing,
    CheckpointPiStopped,
    CheckpointSyncing,
    CheckpointBackupPrepared,
    CheckpointBackupConfirmed,
    CheckpointSupervisorRestarting,
    CheckpointTransportReady
  )
  pure val sleepPhases = Set(
    SleepQuiescing,
    SleepPiStopped,
    SleepSyncing,
    SleepBackupConfirmed,
    SleepStopRequested,
    SleepRuntimeStopped
  )
  pure val resumePhases = Set(
    ResumeWatchdogArmed,
    ResumeBackupRestoring,
    ResumeRuntimeReady,
    ResumeSupervisorStarting,
    ResumeSupervisorReady,
    ResumeTransportReady
  )
  pure val warmWorkPhases = Set(WarmWorkAdmitted, WarmWorkRunning, WarmWorkSettling)
  pure val vaporizePhases = Set(
    VaporizeAdmitted,
    VaporizeRuntimeAccessRevoked,
    VaporizeHatchClosing,
    VaporizeEvidenceInterrupting,
    VaporizeRuntimeDestroying,
    VaporizeBackupsDeleting,
    VaporizeEvidenceDeleting,
    VaporizeGrantsReleasing,
    VaporizeAbsenceConfirming
  )

  pure def phaseBelongs(kind: TransitionKind, phase: Phase): bool = match kind {
    | NoTransition => phase == NoPhase
    | Create => createPhases.contains(phase)
    | Checkpoint => checkpointPhases.contains(phase)
    | Sleep => sleepPhases.contains(phase)
    | Resume => resumePhases.contains(phase)
    | WarmWork => warmWorkPhases.contains(phase)
    | Vaporize => vaporizePhases.contains(phase)
  }

  pure def transitionOriginValid(a: Authority): bool = match a.transition {
    | NoTransition => true
    | Create => a.origin == Absent
    | Checkpoint => a.origin == OriginWarm
    | Sleep => a.origin == OriginWarm
    | Resume => a.origin == OriginSleeping or a.origin == OriginFailed
    | WarmWork => a.origin == OriginWarm
    | Vaporize => true
  }

  pure def transitionProofValid(a: Authority): bool = match a.transition {
    | NoTransition => true
    | Create => and {
        a.phase == CreateIntentCommitted or a.workspaceReady,
        not(Set(CreateRuntimeReady, CreateSupervisorStarting, CreateSupervisorReady, CreateTransportVerifying).contains(a.phase)) or a.runtimeReady,
        not(Set(CreateSupervisorReady, CreateTransportVerifying).contains(a.phase)) or a.supervisorReady,
        a.phase != CreateTransportVerifying or coherentReadiness(a),
      }
    | Checkpoint => and {
        coherentReadiness(a),
        a.phase == CheckpointQuiescing or a.piStopped,
        not(Set(CheckpointBackupPrepared, CheckpointBackupConfirmed, CheckpointSupervisorRestarting, CheckpointTransportReady).contains(a.phase)) or (a.backupPrepared and a.backupOwned),
        not(Set(CheckpointBackupConfirmed, CheckpointSupervisorRestarting, CheckpointTransportReady).contains(a.phase)) or a.backupCurrent,
      }
    | Sleep => and {
        coherentReadiness(a),
        a.phase == SleepQuiescing or a.piStopped,
        not(Set(SleepBackupConfirmed, SleepStopRequested, SleepRuntimeStopped).contains(a.phase)) or a.backupCurrent,
        not(Set(SleepStopRequested, SleepRuntimeStopped).contains(a.phase)) or a.stopRequested,
        a.phase != SleepRuntimeStopped or a.runtimeStopped,
      }
    | Resume => and {
        a.backupCurrent,
        a.wakeSource,
        not(Set(ResumeRuntimeReady, ResumeSupervisorStarting, ResumeSupervisorReady, ResumeTransportReady).contains(a.phase)) or a.runtimeReady,
        not(Set(ResumeSupervisorReady, ResumeTransportReady).contains(a.phase)) or a.supervisorReady,
        a.phase != ResumeTransportReady or coherentReadiness(a),
      }
    | WarmWork => coherentReadiness(a)
    | Vaporize => and {
        a.phase == VaporizeAdmitted or a.runtimeAccessRevoked,
        not(Set(VaporizeHatchClosing, VaporizeEvidenceInterrupting, VaporizeRuntimeDestroying, VaporizeBackupsDeleting, VaporizeEvidenceDeleting, VaporizeGrantsReleasing, VaporizeAbsenceConfirming).contains(a.phase)) or a.absent.contains(Hatch),
        not(Set(VaporizeRuntimeDestroying, VaporizeBackupsDeleting, VaporizeEvidenceDeleting, VaporizeGrantsReleasing, VaporizeAbsenceConfirming).contains(a.phase)) or a.absent.contains(Runtime),
        not(Set(VaporizeBackupsDeleting, VaporizeEvidenceDeleting, VaporizeGrantsReleasing, VaporizeAbsenceConfirming).contains(a.phase)) or a.absent.contains(Backups),
        not(Set(VaporizeEvidenceDeleting, VaporizeGrantsReleasing, VaporizeAbsenceConfirming).contains(a.phase)) or a.absent.contains(Evidence),
        not(Set(VaporizeGrantsReleasing, VaporizeAbsenceConfirming).contains(a.phase)) or (a.absent.contains(Grants) and a.absent.contains(Idempotency)),
      }
  }

  action admitCreate = all {
    not(authority.present),
    accept({
      ...emptyAuthority,
      present: true,
      hardCapGeneration: 1,
      transition: Create,
      phase: CreateIntentCommitted,
      mode: Executing,
      nonce: 1,
      attempt: 1,
    }, AdmittedEvent, CommandInput),
  }

  action admitCheckpoint = all {
    isWarm(authority),
    accept({
      ...authority,
      stable: NoStable,
      origin: OriginWarm,
      transition: Checkpoint,
      phase: CheckpointQuiescing,
      mode: Executing,
      nonce: authority.revision + 1,
      attempt: authority.revision + 1,
      piStopped: false,
      activityPresent: false,
      activityFresh: false,
    }, AdmittedEvent, CommandInput),
  }

  action admitSleep = all {
    isWarm(authority),
    accept({
      ...authority,
      stable: NoStable,
      origin: OriginWarm,
      transition: Sleep,
      phase: SleepQuiescing,
      mode: Executing,
      nonce: authority.revision + 1,
      attempt: authority.revision + 1,
      piStopped: false,
      stopRequested: false,
      runtimeStopped: false,
      activityPresent: false,
      activityFresh: false,
    }, AdmittedEvent, CommandInput),
  }

  action admitResume = all {
    isSleeping(authority) or (isFailed(authority) and authority.actionableFailure),
    authority.backupCurrent,
    authority.wakeSource,
    accept({
      ...authority,
      stable: NoStable,
      origin: if (isSleeping(authority)) OriginSleeping else OriginFailed,
      transition: Resume,
      phase: ResumeWatchdogArmed,
      mode: Executing,
      nonce: authority.revision + 1,
      attempt: authority.revision + 1,
      hardCapGeneration: authority.hardCapGeneration + 1,
      runtimeReady: false,
      supervisorReady: false,
      transportReady: false,
      activityPresent: false,
      activityFresh: false,
    }, AdmittedEvent, CommandInput),
  }

  action admitWarmWork = all {
    isWarm(authority),
    accept({
      ...authority,
      stable: NoStable,
      origin: OriginWarm,
      transition: WarmWork,
      phase: WarmWorkAdmitted,
      mode: Executing,
      nonce: authority.revision + 1,
      attempt: authority.revision + 1,
    }, AdmittedEvent, CommandInput),
  }

  action admitVaporize = all {
    authority.present,
    not(isGone(authority)),
    authority.transition != Vaporize,
    accept({
      ...authority,
      stable: NoStable,
      origin: if (isStable(authority)) stableOrigin(authority) else authority.origin,
      transition: Vaporize,
      phase: VaporizeAdmitted,
      mode: Executing,
      nonce: authority.revision + 1,
      attempt: authority.revision + 1,
      runtimeAccessRevoked: false,
      absent: Set(),
      activityPresent: false,
      activityFresh: false,
    }, AdmittedEvent, CommandInput),
  }

  action rename = all {
    isStable(authority),
    not(isGone(authority)),
    accept(authority, RenamedEvent, CommandInput),
  }

  action progressCreate = match authority.phase {
    | CreateIntentCommitted => accept({ ...authority, phase: CreateWorkspacePreparing, workspaceReady: true }, ProgressedEvent, FencedFact)
    | CreateWorkspacePreparing => accept({ ...authority, phase: CreateRuntimeMaterializing }, ProgressedEvent, FencedFact)
    | CreateRuntimeMaterializing => accept({
        ...authority,
        phase: CreateRuntimeReady,
        runtimeReady: true,
        runtimeGeneration: authority.revision + 1,
        runtimeContainer: authority.revision + 1,
      }, ProgressedEvent, FencedFact)
    | CreateRuntimeReady => accept({ ...authority, phase: CreateSupervisorStarting }, ProgressedEvent, FencedFact)
    | CreateSupervisorStarting => accept({
        ...authority,
        phase: CreateSupervisorReady,
        supervisorReady: true,
        supervisorRuntimeGeneration: authority.runtimeGeneration,
        supervisorContainer: authority.runtimeContainer,
        supervisorEpoch: authority.revision + 1,
      }, ProgressedEvent, FencedFact)
    | CreateSupervisorReady => accept({
        ...authority,
        phase: CreateTransportVerifying,
        transportReady: true,
        transportRuntimeGeneration: authority.runtimeGeneration,
        transportContainer: authority.runtimeContainer,
        transportSupervisorEpoch: authority.supervisorEpoch,
      }, ProgressedEvent, FencedFact)
    | _ => reject(StaleFact)
  }

  action progressCheckpoint = match authority.phase {
    | CheckpointQuiescing => accept({ ...authority, phase: CheckpointPiStopped, piStopped: true }, ProgressedEvent, FencedFact)
    | CheckpointPiStopped => accept({ ...authority, phase: CheckpointSyncing, backupOwned: true }, ProgressedEvent, FencedFact)
    | CheckpointSyncing => accept({
        ...authority,
        phase: CheckpointBackupPrepared,
        backupPrepared: true,
        backupOwned: true,
      }, ProgressedEvent, FencedFact)
    | CheckpointBackupPrepared => accept({
        ...authority,
        phase: CheckpointBackupConfirmed,
        backupConfirmed: true,
        backupCurrent: true,
      }, ProgressedEvent, FencedFact)
    | CheckpointBackupConfirmed => accept({ ...authority, phase: CheckpointSupervisorRestarting }, ProgressedEvent, FencedFact)
    | CheckpointSupervisorRestarting => accept({ ...authority, phase: CheckpointTransportReady }, ProgressedEvent, FencedFact)
    | _ => reject(StaleFact)
  }

  action progressSleep = match authority.phase {
    | SleepQuiescing => accept({ ...authority, phase: SleepPiStopped, piStopped: true }, ProgressedEvent, FencedFact)
    | SleepPiStopped => accept({ ...authority, phase: SleepSyncing, backupOwned: true }, ProgressedEvent, FencedFact)
    | SleepSyncing => accept({
        ...authority,
        phase: SleepBackupConfirmed,
        backupPrepared: true,
        backupConfirmed: true,
        backupOwned: true,
        backupCurrent: true,
      }, ProgressedEvent, FencedFact)
    | SleepBackupConfirmed => accept({ ...authority, phase: SleepStopRequested, stopRequested: true }, ProgressedEvent, FencedFact)
    | SleepStopRequested => accept({ ...authority, phase: SleepRuntimeStopped, runtimeStopped: true }, ProgressedEvent, FencedFact)
    | _ => reject(StaleFact)
  }

  action progressResume = match authority.phase {
    | ResumeWatchdogArmed => accept({ ...authority, phase: ResumeBackupRestoring }, ProgressedEvent, FencedFact)
    | ResumeBackupRestoring => accept({
        ...authority,
        phase: ResumeRuntimeReady,
        runtimeReady: true,
        runtimeGeneration: authority.revision + 1,
        runtimeContainer: authority.revision + 1,
      }, ProgressedEvent, FencedFact)
    | ResumeRuntimeReady => accept({ ...authority, phase: ResumeSupervisorStarting }, ProgressedEvent, FencedFact)
    | ResumeSupervisorStarting => accept({
        ...authority,
        phase: ResumeSupervisorReady,
        supervisorReady: true,
        supervisorRuntimeGeneration: authority.runtimeGeneration,
        supervisorContainer: authority.runtimeContainer,
        supervisorEpoch: authority.revision + 1,
      }, ProgressedEvent, FencedFact)
    | ResumeSupervisorReady => accept({
        ...authority,
        phase: ResumeTransportReady,
        transportReady: true,
        transportRuntimeGeneration: authority.runtimeGeneration,
        transportContainer: authority.runtimeContainer,
        transportSupervisorEpoch: authority.supervisorEpoch,
      }, ProgressedEvent, FencedFact)
    | _ => reject(StaleFact)
  }

  action progressWarmWork = match authority.phase {
    | WarmWorkAdmitted => accept({ ...authority, phase: WarmWorkRunning }, ProgressedEvent, FencedFact)
    | WarmWorkRunning => accept({ ...authority, phase: WarmWorkSettling }, ProgressedEvent, FencedFact)
    | _ => reject(StaleFact)
  }

  action progressVaporize = match authority.phase {
    | VaporizeAdmitted => accept({
        ...authority,
        phase: VaporizeRuntimeAccessRevoked,
        runtimeAccessRevoked: true,
      }, ProgressedEvent, FencedFact)
    | VaporizeRuntimeAccessRevoked => accept({
        ...authority,
        phase: VaporizeHatchClosing,
        absent: authority.absent.union(Set(Hatch)),
      }, ProgressedEvent, FencedFact)
    | VaporizeHatchClosing => accept({ ...authority, phase: VaporizeEvidenceInterrupting }, ProgressedEvent, FencedFact)
    | VaporizeEvidenceInterrupting => accept({
        ...authority,
        phase: VaporizeRuntimeDestroying,
        runtimeReady: false,
        supervisorReady: false,
        transportReady: false,
        absent: authority.absent.union(Set(Runtime)),
      }, ProgressedEvent, FencedFact)
    | VaporizeRuntimeDestroying => accept({
        ...authority,
        phase: VaporizeBackupsDeleting,
        backupPrepared: false,
        backupConfirmed: false,
        backupOwned: false,
        backupCurrent: false,
        wakeSource: false,
        absent: authority.absent.union(Set(Backups)),
      }, ProgressedEvent, FencedFact)
    | VaporizeBackupsDeleting => accept({
        ...authority,
        phase: VaporizeEvidenceDeleting,
        absent: authority.absent.union(Set(Evidence)),
      }, ProgressedEvent, FencedFact)
    | VaporizeEvidenceDeleting => accept({
        ...authority,
        phase: VaporizeGrantsReleasing,
        absent: authority.absent.union(Set(Grants, Idempotency)),
      }, ProgressedEvent, FencedFact)
    | VaporizeGrantsReleasing => accept({ ...authority, phase: VaporizeAbsenceConfirming }, ProgressedEvent, FencedFact)
    | _ => reject(StaleFact)
  }

  action progress = match authority.transition {
    | Create => progressCreate
    | Checkpoint => progressCheckpoint
    | Sleep => progressSleep
    | Resume => progressResume
    | WarmWork => progressWarmWork
    | Vaporize => progressVaporize
    | NoTransition => reject(StaleFact)
  }

  action submitProgress = {
    nondet inputRevision = Set(authority.revision - 1, authority.revision, authority.revision + 1).oneOf()
    nondet inputNonce = Set(authority.nonce, authority.nonce + 1).oneOf()
    nondet inputAttempt = Set(authority.attempt, authority.attempt + 1).oneOf()
    nondet inputPhase = Set(authority.phase, NoPhase).oneOf()
    if (and {
      isTransitioning(authority),
      inputRevision == authority.revision,
      inputNonce == authority.nonce,
      inputAttempt == authority.attempt,
      inputPhase == authority.phase,
    }) progress else reject(StaleFact)
  }

  action complete = match authority.transition {
    | Create => all {
        authority.phase == CreateTransportVerifying,
        coherentReadiness(authority),
        accept({
          ...authority,
          stable: Warm,
          origin: OriginWarm,
          transition: NoTransition,
          phase: NoPhase,
          mode: NoMode,
          nonce: 0,
          attempt: 0,
        }, CompletedEvent, FencedFact),
      }
    | Checkpoint => all {
        authority.phase == CheckpointTransportReady,
        authority.backupCurrent,
        accept({
          ...authority,
          stable: Warm,
          origin: OriginWarm,
          transition: NoTransition,
          phase: NoPhase,
          mode: NoMode,
          nonce: 0,
          attempt: 0,
          activityPresent: false,
          activityFresh: false,
        }, CompletedEvent, FencedFact),
      }
    | Sleep => all {
        authority.phase == SleepRuntimeStopped,
        authority.backupCurrent,
        authority.runtimeStopped,
        accept({
          ...authority,
          stable: Sleeping,
          origin: OriginSleeping,
          transition: NoTransition,
          phase: NoPhase,
          mode: NoMode,
          nonce: 0,
          attempt: 0,
          runtimeReady: false,
          supervisorReady: false,
          transportReady: false,
          wakeSource: true,
          activityPresent: false,
          activityFresh: false,
        }, CompletedEvent, FencedFact),
      }
    | Resume => all {
        authority.phase == ResumeTransportReady,
        coherentReadiness(authority),
        accept({
          ...authority,
          stable: Warm,
          origin: OriginWarm,
          transition: NoTransition,
          phase: NoPhase,
          mode: NoMode,
          nonce: 0,
          attempt: 0,
          runtimeStopped: false,
          activityPresent: false,
          activityFresh: false,
        }, CompletedEvent, FencedFact),
      }
    | WarmWork => all {
        authority.phase == WarmWorkSettling,
        accept({
          ...authority,
          stable: Warm,
          origin: OriginWarm,
          transition: NoTransition,
          phase: NoPhase,
          mode: NoMode,
          nonce: 0,
          attempt: 0,
        }, CompletedEvent, FencedFact),
      }
    | Vaporize => all {
        authority.phase == VaporizeAbsenceConfirming,
        accept({
          ...authority,
          stable: Gone,
          origin: OriginGone,
          transition: NoTransition,
          phase: NoPhase,
          mode: NoMode,
          nonce: 0,
          attempt: 0,
          runtimeReady: false,
          supervisorReady: false,
          transportReady: false,
          workspaceReady: false,
          backupPrepared: false,
          backupConfirmed: false,
          backupOwned: false,
          backupCurrent: false,
          wakeSource: false,
          actionableFailure: false,
          activityPresent: false,
          activityFresh: false,
          absent: allAbsent,
        }, CompletedEvent, FencedFact),
      }
    | NoTransition => reject(StaleFact)
  }

  action submitCompletion = {
    nondet inputRevision = Set(authority.revision - 1, authority.revision, authority.revision + 1).oneOf()
    nondet inputNonce = Set(authority.nonce, authority.nonce + 1).oneOf()
    nondet inputAttempt = Set(authority.attempt, authority.attempt + 1).oneOf()
    nondet inputPhase = Set(authority.phase, NoPhase).oneOf()
    if (and {
      isTransitioning(authority),
      inputRevision == authority.revision,
      inputNonce == authority.nonce,
      inputAttempt == authority.attempt,
      inputPhase == authority.phase,
    }) complete else reject(StaleFact)
  }

  action deadlineElapsed = all {
    isTransitioning(authority),
    if (authority.transition == Vaporize)
      accept({ ...authority, mode: Reconciling }, DeadlineReconcilingEvent, DeadlineInput)
    else transitionFailure,
  }

  action providerOutcomeUnknown = all {
    isTransitioning(authority),
    if (authority.mode == Executing)
      accept({ ...authority, mode: Reconciling }, ProviderReconcilingEvent, ProviderUnknownInput)
    else if (authority.transition == Vaporize)
      accept(authority, ProviderReconcilingEvent, ProviderUnknownInput)
    else transitionFailure,
  }

  action transitionFailure = all {
    isTransitioning(authority),
    authority.transition != Vaporize,
    val resumable = authority.backupCurrent and authority.origin != Absent
    accept({
      ...authority,
      stable: Failed,
      transition: NoTransition,
      phase: NoPhase,
      mode: NoMode,
      nonce: 0,
      attempt: 0,
      runtimeReady: false,
      supervisorReady: false,
      transportReady: false,
      actionableFailure: resumable,
      wakeSource: resumable,
      activityPresent: false,
      activityFresh: false,
    }, CompletedEvent, FencedFact),
  }

  action transitionFailureNonActionable = all {
    isTransitioning(authority),
    authority.transition != Vaporize,
    accept({
      ...authority,
      stable: Failed,
      transition: NoTransition,
      phase: NoPhase,
      mode: NoMode,
      nonce: 0,
      attempt: 0,
      runtimeReady: false,
      supervisorReady: false,
      transportReady: false,
      actionableFailure: false,
      wakeSource: false,
      activityPresent: false,
      activityFresh: false,
    }, CompletedEvent, FencedFact),
  }

  action vaporizeFailure = all {
    authority.transition == Vaporize,
    accept({ ...authority, mode: Reconciling }, ProviderReconcilingEvent, ProviderUnknownInput),
  }

  action observeActivity = all {
    isWarm(authority),
    coherentReadiness(authority),
    accept({
      ...authority,
      activityPresent: true,
      activitySupervisorEpoch: authority.supervisorEpoch,
      activitySequence: authority.activitySequence + 1,
      activityFresh: true,
    }, ActivityObservedEvent, ActivityInput),
  }

  action availabilityLost = all {
    isWarm(authority),
    val resumable = authority.backupCurrent
    accept({
      ...authority,
      stable: Failed,
      origin: OriginWarm,
      runtimeReady: false,
      supervisorReady: false,
      transportReady: false,
      actionableFailure: resumable,
      wakeSource: resumable,
      activityPresent: false,
      activityFresh: false,
    }, AvailabilityLostEvent, RecoveryInput),
  }

  action transitionAvailabilityLost = all {
    isTransitioning(authority),
    authority.transition != Vaporize,
    authority.mode == Executing,
    accept({ ...authority, mode: Reconciling }, AvailabilityLostEvent, RecoveryInput),
  }

  action transitionRuntimeObserved = all {
    isTransitioning(authority),
    authority.transition != Vaporize,
    not(authority.transition == Sleep and Set(SleepStopRequested, SleepRuntimeStopped).contains(authority.phase)),
    authority.runtimeReady,
    reject(RecoveryInput),
  }

  action hardCapElapsed = all {
    authority.present,
    not(isFailed(authority)),
    not(isGone(authority)),
    authority.transition != Vaporize,
    val resumable = authority.backupCurrent and authority.origin != Absent
    accept({
      ...authority,
      stable: Failed,
      transition: NoTransition,
      phase: NoPhase,
      mode: NoMode,
      nonce: 0,
      attempt: 0,
      runtimeReady: false,
      supervisorReady: false,
      transportReady: false,
      actionableFailure: resumable,
      wakeSource: resumable,
      activityPresent: false,
      activityFresh: false,
    }, HardCapElapsedEvent, RecoveryInput),
  }

  action submitHardCapAlarm = {
    nondet inputGeneration = Set(authority.hardCapGeneration, authority.hardCapGeneration + 1).oneOf()
    if (inputGeneration == authority.hardCapGeneration) hardCapElapsed else reject(StaleFact)
  }

  action staleFact = reject(StaleFact)

  action step = any {
    admitCreate,
    admitCheckpoint,
    admitSleep,
    admitResume,
    admitWarmWork,
    admitVaporize,
    rename,
    submitProgress,
    submitCompletion,
    deadlineElapsed,
    providerOutcomeUnknown,
    transitionFailure,
    transitionFailureNonActionable,
    vaporizeFailure,
    observeActivity,
    availabilityLost,
    transitionAvailabilityLost,
    transitionRuntimeObserved,
    submitHardCapAlarm,
    staleFact,
  }

  val oneAuthority = authority.present == (isStable(authority) or isTransitioning(authority))

  val revisionAndJournalAtomic = and {
    authority.revision >= previousRevision,
    authority.revision == authority.journalRevision,
  }

  val transitionFenceOwned =
    if (isTransitioning(authority)) and {
      authority.stable == NoStable,
      authority.mode != NoMode,
      authority.nonce > 0,
      authority.attempt > 0,
      authority.phase != NoPhase,
    } else and {
      authority.transition == NoTransition,
      authority.phase == NoPhase,
      authority.mode == NoMode,
      authority.nonce == 0,
      authority.attempt == 0,
    }

  val phaseAndOriginCoherent = and {
    phaseBelongs(authority.transition, authority.phase),
    transitionOriginValid(authority),
    transitionProofValid(authority),
  }

  val warmReadinessCoherent = isWarm(authority) implies coherentReadiness(authority)

  val readinessDependencies = and {
    authority.supervisorReady implies authority.runtimeReady,
    authority.transportReady implies authority.supervisorReady,
    authority.supervisorReady implies and {
      authority.supervisorRuntimeGeneration == authority.runtimeGeneration,
      authority.supervisorContainer == authority.runtimeContainer,
    },
    authority.transportReady implies and {
      authority.transportRuntimeGeneration == authority.runtimeGeneration,
      authority.transportContainer == authority.runtimeContainer,
      authority.transportSupervisorEpoch == authority.supervisorEpoch,
    },
  }

  val activityFreshness = authority.activityPresent implies and {
    isWarm(authority) or (isTransitioning(authority) and authority.transition == WarmWork),
    authority.activityFresh,
    authority.activitySupervisorEpoch == authority.supervisorEpoch,
  }

  val backupOwnershipCoherent = validBackupOwnership(authority)

  val backupReservedBeforeDispatch =
    (isTransitioning(authority) and
      ((authority.transition == Checkpoint and authority.phase == CheckpointSyncing) or
       (authority.transition == Sleep and authority.phase == SleepSyncing)))
    implies authority.backupOwned

  val sleepingWakeSource = isSleeping(authority) implies and {
    authority.backupCurrent,
    authority.wakeSource,
    authority.runtimeStopped,
    not(authority.runtimeReady),
  }

  val actionableFailureHasWakeSource =
    (isFailed(authority) and authority.actionableFailure) implies and {
      authority.backupCurrent,
      authority.wakeSource,
    }

  val goneIsClean = isGone(authority) implies and {
    authority.absent == allAbsent,
    not(authority.runtimeReady),
    not(authority.supervisorReady),
    not(authority.transportReady),
    not(authority.backupOwned),
    not(authority.backupCurrent),
    not(authority.wakeSource),
    not(authority.activityPresent),
  }

  val vaporizeRetainsAuthority = deleting(authority) implies and {
    authority.present,
    authority.transition == Vaporize,
    authority.nonce > 0,
    publicActions(authority) == Set(),
    (not(authority.absent.contains(Backups)) and authority.backupPrepared) implies authority.backupOwned,
  }

  val transitioningHasNoPublicActions =
    isTransitioning(authority) implies publicActions(authority) == Set()

  val staleFactsNeverCommit = lastInput == StaleFact implies lastOutcome == Rejected

  val publicMappingTotal =
    authority.present implies publicStatus(authority) != NoPublicStatus

  val hardCapIdentityPresent = authority.present implies authority.hardCapGeneration > 0

  val safety = and {
    oneAuthority,
    revisionAndJournalAtomic,
    transitionFenceOwned,
    phaseAndOriginCoherent,
    warmReadinessCoherent,
    readinessDependencies,
    activityFreshness,
    backupOwnershipCoherent,
    backupReservedBeforeDispatch,
    sleepingWakeSource,
    actionableFailureHasWakeSource,
    goneIsClean,
    vaporizeRetainsAuthority,
    transitioningHasNoPublicActions,
    staleFactsNeverCommit,
    publicMappingTotal,
    hardCapIdentityPresent,
  }


  run fullLifecycle = init
    .then(admitCreate)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitCheckpoint)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitWarmWork).then(progress).then(progress).then(complete)
    .then(admitSleep)
    .then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitResume)
    .then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitVaporize)
    .then(progress).then(progress).then(progress).then(progress)
    .then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .expect(safety)
    .expect(isGone(authority))

  run actionableRecovery = init
    .then(admitCreate)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitCheckpoint)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(availabilityLost)
    .expect(authority.actionableFailure)
    .then(admitResume)
    .then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .expect(safety)
    .expect(isWarm(authority))

  run ambiguityRetainsFence = init
    .then(admitCreate)
    .then(providerOutcomeUnknown)
    .expect(isTransitioning(authority) and authority.mode == Reconciling)
    .then(staleFact)
    .expect(isTransitioning(authority) and lastOutcome == Rejected)
    .then(transitionFailureNonActionable)
    .expect(safety)
    .expect(isFailed(authority))

  run repeatedOrdinaryAmbiguityTerminates = init
    .then(admitCreate)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitCheckpoint)
    .then(providerOutcomeUnknown)
    .expect(isTransitioning(authority) and authority.mode == Reconciling)
    .then(providerOutcomeUnknown)
    .expect(safety)
    .expect(isFailed(authority))

  run ordinaryDeadlineTerminates = init
    .then(admitCreate)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitSleep)
    .then(deadlineElapsed)
    .expect(safety)
    .expect(isFailed(authority))

  run matchingRuntimeObservationPreservesSleep = init
    .then(admitCreate)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitSleep)
    .then(transitionRuntimeObserved)
    .expect(authority.transition == Sleep and authority.phase == SleepQuiescing and authority.mode == Executing and lastOutcome == Rejected)
    .then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .expect(safety)
    .expect(isSleeping(authority))

  run vaporizeAmbiguityRetainsCleanup = init
    .then(admitCreate)
    .then(progress).then(progress).then(progress).then(progress).then(progress).then(progress)
    .then(complete)
    .then(admitVaporize)
    .then(providerOutcomeUnknown)
    .then(providerOutcomeUnknown)
    .then(deadlineElapsed)
    .expect(safety)
    .expect(deleting(authority))

  // These properties require the fairness and provider-settlement assumptions documented above.
  temporal eventualSettlement = always(isTransitioning(authority) implies eventually(isStable(authority)))
  temporal eventualGoneAfterVaporize = always(deleting(authority) implies eventually(isGone(authority)))
}
