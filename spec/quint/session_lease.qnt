// Session lifecycle abstraction of the current reducer. Backup is a confirmed
// owned current backup. ITF traces replay each reducer input through decide.
module session_lease {
  type StableState = {
    kind: str,
    backup: bool,
    lastStable: str,
    actionable: bool,
    ownedBackups: bool,
  }
  type Transition = {
    kind: str,
    phase: int,
    mode: str,
    origin: str,
    nonce: int,
    attempt: int,
    backup: bool,
    lastStable: str,
  }
  type Auth = Absent | Stable(StableState) | Transitioning(Transition)
  type Fence = { revision: int, kind: str, nonce: int, attempt: int, phase: int }
  type Outcome = Init | Accepted | Rejected(str)

  pure def lastPhase(kind: str): int =
    if (kind == "Resume") 5
    else if (kind == "WarmWork") 2
    else if (kind == "Vaporize") 8
    else 6
  pure def stable(kind: str, backup: bool, lastStable: str, actionable: bool,
      ownedBackups: bool): Auth =
    Stable({
      kind: kind,
      backup: backup,
      lastStable: lastStable,
      actionable: actionable,
      ownedBackups: ownedBackups,
    })
  pure def ownsBackup(t: Transition): bool =
    t.backup or ((t.kind == "Checkpoint" or t.kind == "Sleep") and t.phase >= 3)
  pure def failed(t: Transition, recovery: bool): Auth = {
    val actionable = t.backup and (not(recovery) or t.lastStable != "None")
    stable("Failed", actionable, t.lastStable, actionable, ownsBackup(t))
  }
  pure def admissible(kind: str, current: Auth): bool = match current {
    | Absent => kind == "Create"
    | Transitioning(_) => false
    | Stable(s) =>
      (s.kind == "Warm" and Set("Checkpoint", "Sleep", "WarmWork").contains(kind)) or
      (kind == "Resume" and (s.kind == "Sleeping" or
        (s.kind == "Failed" and s.actionable and s.backup and s.lastStable != "None")))
  }

  var auth: Auth
  var revision: int
  var nonceSeq: int
  var issued: Set[Fence]
  var outcome: Outcome
  var lastAction: str
  var scenarioKind: str
  var scenarioOutcome: str
  type Cell = { kind: str, outcome: str, reason: str, lease: str }
  var cell: Cell
  var hardCapGeneration: int

  action init = {
    nondet kind = Set("Create", "Checkpoint", "Sleep", "Resume", "WarmWork", "Random", "StoppedSleep", "RestartVaporize", "InvalidSleep", "InvalidVaporize", "Availability", "CompleteEarly", "RestartExecuting", "SleepProviderFailure", "ResumeHardCap").oneOf()
    nondet result = Set("deadline", "providerFailure", "unknown", "hardCap").oneOf()
    all {
      auth' = Absent,
      revision' = 0,
      nonceSeq' = 0,
      issued' = Set(),
      outcome' = Init,
      lastAction' = "init",
      scenarioKind' = kind,
      scenarioOutcome' = result,
      cell' = emptyCell,
      hardCapGeneration' = 0,
    }
  }
  pure def emptyCell: Cell = { kind: "", outcome: "", reason: "", lease: "" }
  pure def namedCell(kind: str, outcome: str, reason: str, lease: str): Cell =
    { kind: kind, outcome: outcome, reason: reason, lease: lease }
  def coverageCell(before: Auth, after: Auth, name: str, accepted: bool, code: str): Cell = {
    val beforeLease = match before { | Transitioning(t) => t.kind | _ => "" }
    val beforeMode = match before { | Transitioning(t) => t.mode | _ => "" }
    val afterKind = match after { | Stable(s) => s.kind | _ => "" }
    if (name == "complete" and accepted and (afterKind == "Gone" or afterKind == "Sleeping"))
      namedCell(name, "Accepted", afterKind, "")
    else if (name == "completeEarly" and not(accepted))
      namedCell(name, "Rejected", "", "")
    else if (name == "settleStoppedSleep" and accepted)
      namedCell(name, "Accepted", "Sleeping", "")
    else if (name == "resumeCommand" and accepted and match before { | Stable(s) => s.kind == "Failed" | _ => false })
      namedCell(name, "Accepted", "Failed", "")
    else if (name == "availabilityLost" and accepted and beforeLease != "")
      namedCell(name, "Accepted", "Executing", "")
    else if (name == "availabilityLost" and not(accepted) and code == "duplicate" and beforeMode == "Reconciling")
      namedCell(name, "Rejected", code, beforeMode)
    else if (accepted and afterKind == "Failed" and Set("deadline", "providerFailure", "hardCapElapsed").contains(name))
      namedCell(name, "Accepted", beforeLease, "")
    else if (accepted and afterKind == "Failed" and name == "unknownOutcome" and beforeMode == "Reconciling")
      namedCell(name, "Accepted", beforeMode, beforeLease)
    else emptyCell
  }
  action commitCell(target: Auth, nextNonceSeq: int, name: str, label: Cell): bool = all {
    auth' = target,
    cell' = if (label.kind != "") label else coverageCell(auth, target, name, true, ""),
    revision' = revision + 1,
    nonceSeq' = nextNonceSeq,
    issued' = match target {
      | Transitioning(t) => issued.union(Set({
          revision: revision + 1,
          kind: t.kind,
          nonce: t.nonce,
          attempt: t.attempt,
          phase: t.phase,
        }))
      | _ => issued
    },
    outcome' = Accepted,
    lastAction' = name,
    scenarioKind' = scenarioKind,
    scenarioOutcome' = scenarioOutcome,
    hardCapGeneration' = if (name == "createCommand" or name == "resumeCommand")
      nextNonceSeq else hardCapGeneration,
  }
  action commit(target: Auth, nextNonceSeq: int, name: str): bool =
    commitCell(target, nextNonceSeq, name, emptyCell)
  action rejectCell(code: str, name: str, label: Cell): bool = all {
    auth' = auth,
    cell' = if (label.kind != "") label else coverageCell(auth, auth, name, false, code),
    revision' = revision,
    nonceSeq' = nonceSeq,
    issued' = issued,
    outcome' = Rejected(code),
    lastAction' = name,
    scenarioKind' = scenarioKind,
    scenarioOutcome' = scenarioOutcome,
    hardCapGeneration' = hardCapGeneration,
  }
  action reject(code: str, name: str): bool = rejectCell(code, name, emptyCell)
  val leased = match auth { | Transitioning(_) => true | _ => false }
  val lease = match auth {
    | Transitioning(t) => t
    | _ => {
        kind: "",
        phase: -1,
        mode: "",
        origin: "",
        nonce: -1,
        attempt: -1,
        backup: false,
        lastStable: "None",
      }
  }
  action fencedCommit(target: Auth, name: str): bool = commit(target, nonceSeq, name)
  action fencedCommitCell(target: Auth, name: str, label: Cell): bool =
    commitCell(target, nonceSeq, name, label)
  action fencedReject(code: str, name: str): bool = reject(code, name)
  action fencedRejectCell(code: str, name: str, label: Cell): bool =
    rejectCell(code, name, label)

  action admit(kind: str, origin: str, backup: bool, lastStable: str, name: str): bool =
    commit(Transitioning({
      kind: kind,
      phase: 0,
      mode: "Executing",
      origin: origin,
      nonce: nonceSeq,
      attempt: nonceSeq,
      backup: backup,
      lastStable: lastStable,
    }), nonceSeq + 1, name)
  action command(kind: str, name: str): bool = {
    nondet staleRevision = Set(false, true).oneOf()
    if (staleRevision) reject("revision_mismatch", name)
    else if (kind == "Vaporize") match auth {
      | Absent => reject("duplicate", name)
      | Stable(s) => if (s.kind == "Gone") reject("duplicate", name)
        else admit(kind, s.kind, false, "None", name)
      | Transitioning(t) => if (t.kind == "Vaporize") reject("duplicate", name)
        else admit(kind, t.origin, false, "None", name)
    }
    else if (admissible(kind, auth)) match auth {
      | Absent => admit(kind, "Absent", false, "None", name)
      | Stable(s) => if (kind == "Resume")
          admit(kind, s.kind, true, if (s.kind == "Sleeping") "Sleeping" else s.lastStable,
            name)
        else admit(kind, "Warm", s.backup, "Warm", name)
      | Transitioning(_) => reject("transition_owned", name)
    }
    else match auth {
      | Transitioning(_) => reject("transition_owned", name)
      | _ => reject("not_admissible", name)
    }
  }
  action createCommand = command("Create", "createCommand")
  action checkpointCommand = command("Checkpoint", "checkpointCommand")
  action sleepCommand = command("Sleep", "sleepCommand")
  action resumeCommand = command("Resume", "resumeCommand")
  action warmWorkCommand = command("WarmWork", "warmWorkCommand")
  action vaporizeCommand = command("Vaporize", "vaporizeCommand")

  pure def advanced(t: Transition): Transition = {
    val nextIndex = t.phase + 1
    val snapshot = t.kind == "Checkpoint" or t.kind == "Sleep"
    { ...t,
      phase: nextIndex,
      mode: "Executing",
      backup: t.backup or (snapshot and nextIndex >= 4),
    }
  }
  pure def completed(t: Transition): Auth =
    if (t.kind == "Vaporize")
      stable("Gone", false, "None", false, false)
    else if (t.kind == "Sleep")
      stable("Sleeping", t.backup, "Sleeping", false, ownsBackup(t))
    else stable("Warm", t.backup, "Warm", false, ownsBackup(t))
  action advance = all {
    leased,
    lease.phase < lastPhase(lease.kind),
    fencedCommit(Transitioning(advanced(lease)), "advance"),
  }
  action complete = all {
    leased,
    lease.phase == lastPhase(lease.kind),
    fencedCommit(completed(lease), "complete"),
  }
  action completeEarly = all {
    leased,
    lease.phase < lastPhase(lease.kind),
    fencedReject("not_terminal", "completeEarly"),
  }
  action unsafeSleepComplete = {
    // Carried for the replay only.
    nondet invalidCase = Set(false, true).oneOf()
    all {
      leased,
      lease.kind == "Sleep",
      lease.phase == lastPhase("Sleep"),
      fencedRejectCell("invalid_progress", "unsafeSleepComplete",
        namedCell("unsafeSleepComplete", "Rejected", if (invalidCase) "backup" else "stop", "")),
    }
  }
  action incompleteVaporizeComplete = {
    // Carried for the replay only.
    nondet missingCategory = Set("runtime", "backups", "evidence", "grants", "hatch", "idempotency", "schedules").oneOf()
    all {
      leased,
      lease.kind == "Vaporize",
      lease.phase == lastPhase("Vaporize"),
      fencedRejectCell("invalid_progress", "incompleteVaporizeComplete",
        namedCell("incompleteVaporizeComplete", "Rejected", missingCategory, "")),
    }
  }
  action settleCell(name: str, label: Cell): bool = all {
    leased,
    if (lease.kind == "Vaporize")
      fencedCommitCell(Transitioning({ ...lease, mode: "Reconciling" }), name, label)
    else fencedCommitCell(failed(lease, false), name, label),
  }
  action settle(name: str): bool = settleCell(name, emptyCell)
  action deadline = {
    nondet early = Set(false, true).oneOf()
    all {
      leased,
      if (early) fencedReject("stale_phase", "deadline") else settle("deadline"),
    }
  }
  action providerFailure = settle("providerFailure")
  action unknownOutcome = all {
    leased,
    if (lease.mode == "Executing" or lease.kind == "Vaporize")
      fencedCommit(Transitioning({ ...lease, mode: "Reconciling" }), "unknownOutcome")
    else fencedCommit(failed(lease, false), "unknownOutcome"),
  }
  // actor.resume dispatches a due alarm when its valid fence calls for one;
  // otherwise it sends UnknownProviderOutcome for executing, or runs
  // ReconcileTransition and dispatches the observation it yields. The replay
  // exercises that selected observation through decide, not runner.run itself.
  action restart = {
    nondet due = Set(false, true).oneOf()
    nondet reconcileFence = Set(false, true).oneOf()
    nondet reconcileResult = Set("progress", "complete", "failure", "unknown").oneOf()
    all {
      leased,
      if (due and not(lease.kind == "Vaporize" and lease.mode == "Reconciling" and reconcileFence))
        settleCell("restart", namedCell("restart", "DueFence", "deadline", ""))
      else if (lease.mode == "Executing")
        fencedCommitCell(Transitioning({ ...lease, mode: "Reconciling" }), "restart", namedCell("restart", "Executing", "unknown", ""))
      else if (reconcileResult == "progress")
        all {
          if (lease.phase < lastPhase(lease.kind))
            fencedCommitCell(Transitioning(advanced(lease)), "restart",
              namedCell("restart", if (due and reconcileFence) "VaporizeReconcileFence" else "Reconciling", "observation", ""))
          else reject("stale_phase", "restart"),
        }
      else if (reconcileResult == "complete")
        all {
          if (lease.phase == lastPhase(lease.kind))
            fencedCommitCell(completed(lease), "restart",
              namedCell("restart", if (due and reconcileFence) "VaporizeReconcileFence" else "Reconciling", "observation", ""))
          else reject("not_terminal", "restart"),
        }
      else if (reconcileResult == "failure")
        settleCell("restart", namedCell("restart", if (due and reconcileFence) "VaporizeReconcileFence" else "Reconciling", "observation", ""))
      else if (lease.kind == "Vaporize")
        fencedCommitCell(Transitioning(lease), "restart", namedCell("restart", if (due and reconcileFence) "VaporizeReconcileFence" else "Reconciling", "observation", ""))
      else fencedCommitCell(failed(lease, false), "restart", namedCell("restart", "Reconciling", "observation", "")),
    }
  }
  // Matching supervisor loss: stable Warm fails; an executing lease with a
  // supervisor proof enters reconciliation. Other generations are separate.
  val hasSupervisor = Set("Checkpoint", "Sleep", "WarmWork").contains(lease.kind) or
    (lease.kind == "Create" and lease.phase >= 6) or
    (lease.kind == "Resume" and lease.phase >= 4)
  action availabilityLost = match auth {
    | Stable(s) => if (s.kind == "Warm")
        commit(stable("Failed", s.backup, "Warm", s.backup, s.ownedBackups), nonceSeq, "availabilityLost")
      else reject("stale_generation", "availabilityLost")
    | Transitioning(t) => if (t.mode == "Executing" and t.kind != "Vaporize" and hasSupervisor)
        commit(Transitioning({ ...t, mode: "Reconciling" }), nonceSeq, "availabilityLost")
      else reject(if (t.mode == "Reconciling" or hasSupervisor) "duplicate" else "stale_generation", "availabilityLost")
    | Absent => reject("duplicate", "availabilityLost")
  }
  action settleStoppedSleep = all {
    leased,
    lease.kind == "Sleep",
    lease.mode == "Reconciling",
    lease.phase >= 5,
    lease.backup,
    commit(stable("Sleeping", lease.backup, "Sleeping", false, ownsBackup(lease)), nonceSeq, "settleStoppedSleep"),
  }
  action hardCapElapsed = match auth {
    | Absent => reject("duplicate", "hardCapElapsed")
    | Stable(s) => if (s.kind == "Warm")
        commit(stable("Failed", s.backup, "Warm", s.backup, s.ownedBackups), nonceSeq, "hardCapElapsed")
      else reject("duplicate", "hardCapElapsed")
    | Transitioning(t) => if (t.kind == "Vaporize") reject("duplicate", "hardCapElapsed")
      else commit(failed(t, true), nonceSeq, "hardCapElapsed")
  }
  action redeliver = all {
    issued.exists(f => f.revision < revision),
    {
      nondet fence = issued.filter(f => f.revision < revision and f.phase < lastPhase(f.kind)).oneOf()
      all { fence.revision < revision, rejectCell("duplicate", "redeliver", namedCell("redeliver", "Rejected", "", "")) }
    },
  }
  action interfere = any {
    createCommand,
    checkpointCommand,
    sleepCommand,
    resumeCommand,
    warmWorkCommand,
    vaporizeCommand,
    completeEarly,
    unsafeSleepComplete,
    incompleteVaporizeComplete,
    deadline,
    providerFailure,
    unknownOutcome,
    restart,
    availabilityLost,
    settleStoppedSleep,
    hardCapElapsed,
    redeliver,
  }
  action stutter = all {
    auth' = auth, revision' = revision,
    nonceSeq' = nonceSeq, issued' = issued, outcome' = outcome, lastAction' = lastAction,
    scenarioKind' = scenarioKind, scenarioOutcome' = scenarioOutcome,
    hardCapGeneration' = hardCapGeneration, cell' = emptyCell,
  }
  action guidedStep = match auth {
    | Stable(s) => if (s.kind == "Gone") stutter else guidedActive
    | Transitioning(t) => if (t.kind == "Vaporize" and t.mode == "Reconciling" and t.phase == lastPhase("Vaporize")) complete else guidedActive
    | _ => guidedActive
  }
  action guidedActive = match auth {
    | Absent => createCommand
    | Stable(s) =>
      if (s.kind == "Warm") {
        if (scenarioKind == "Resume" or scenarioKind == "StoppedSleep" or scenarioKind == "InvalidSleep" or scenarioKind == "SleepProviderFailure" or scenarioKind == "ResumeHardCap") sleepCommand
        else if (scenarioKind == "RestartVaporize" or scenarioKind == "InvalidVaporize") vaporizeCommand
        else if (scenarioKind == "Checkpoint") checkpointCommand
        else if (scenarioKind == "Sleep") sleepCommand
        else warmWorkCommand
      }
      else if (s.kind == "Sleeping" and (scenarioKind == "Resume" or scenarioKind == "ResumeHardCap")) resumeCommand
      else interfere
    | Transitioning(t) =>
      if (scenarioKind == "SleepProviderFailure" and t.kind == "Sleep") providerFailure
      else if (scenarioKind == "ResumeHardCap" and t.kind == "Resume") hardCapElapsed
      else if (scenarioKind == "Random" and t.kind == "Create") unknownOutcome
      else if (scenarioKind == "Availability" and t.kind == "Create") {
        if (t.phase < 6) advance else availabilityLost
      }
      else if (scenarioKind == "CompleteEarly" and t.phase < lastPhase(t.kind)) completeEarly
      else if (scenarioKind == "RestartExecuting" and t.mode == "Executing") restart
      else if ((scenarioKind == "RestartVaporize" or scenarioKind == "InvalidVaporize") and
          t.kind == "Create") vaporizeCommand
      else if (scenarioKind == "RestartVaporize" and t.kind == "Vaporize") {
        if (t.mode == "Executing") unknownOutcome else restart
      }
      else if (scenarioKind == "InvalidSleep" and t.kind == "Sleep" and
          t.phase == lastPhase("Sleep")) unsafeSleepComplete
      else if (scenarioKind == "InvalidVaporize" and t.kind == "Vaporize" and
          t.phase == lastPhase("Vaporize")) incompleteVaporizeComplete
      else if (t.kind == scenarioKind) {
        if (scenarioOutcome == "deadline") settle("deadline")
        else if (scenarioOutcome == "providerFailure") providerFailure
        else if (scenarioOutcome == "hardCap") hardCapElapsed
        else unknownOutcome
      }
      else if (scenarioKind == "StoppedSleep" and t.kind == "Sleep" and t.phase >= 5) {
        if (t.mode == "Executing") unknownOutcome else settleStoppedSleep
      }
      else if (t.phase == lastPhase(t.kind)) complete
      else advance
  }
  action step = match auth {
    | Stable(s) => if (s.kind == "Gone") stutter else any { advance, complete, interfere }
    | _ => any { advance, complete, interfere }
  }
  val sleepingHasBackup = match auth {
    | Stable(s) => s.kind == "Sleeping" implies s.backup
    | _ => true
  }
  val safety = sleepingHasBackup
  val failedHasExit = match auth {
    | Stable(s) => s.kind == "Failed" implies
        Set("Create", "Checkpoint", "Sleep", "Resume", "WarmWork").exists(k => admissible(k, auth))
    | _ => true
  }

  val reachesSleeping = match auth { | Stable(s) => s.kind == "Sleeping" | _ => false }
  val reachesStoppedSleep = reachesSleeping and lastAction == "settleStoppedSleep"
}
