// Seed model of the session actor lease, replayed against
// worker/src/session-actor/reducer.ts by session-lease.replay.test.ts.
//
// Scope: Create and Vaporize walked phase by phase, Vaporize preemption,
// deadline and provider failure, stale fact redelivery, and command revision
// fences. Checkpoint, Sleep, Resume, WarmWork and unknown outcomes belong to
// the full lifecycle model (M-01).
module session_lease {
  // Kind is "Create" | "Vaporize"; mode is "Executing" | "Reconciling";
  // origin is the stable kind the lease started from, or "Absent".
  type Transition = { kind: str, phase: int, mode: str, origin: str, nonce: int }
  type Auth = Absent | Stable(str) | Transitioning(Transition)
  type Fence = { revision: int, kind: str, nonce: int, phase: int }
  type Outcome = Init | Accepted | Rejected(str)

  // Index of the terminal phase in transition.ts `phases`.
  pure def lastPhase(kind: str): int = if (kind == "Create") 6 else 8

  var auth: Auth
  var revision: int
  var prevRevision: int
  var nonceSeq: int
  // Every lease fence the actor has ever committed, for stale redelivery.
  var issued: Set[Fence]
  var outcome: Outcome

  action init = all {
    auth' = Absent,
    revision' = 0,
    prevRevision' = 0,
    nonceSeq' = 0,
    issued' = Set(),
    outcome' = Init,
  }

  action commit(target: Auth, nextNonceSeq: int): bool = all {
    auth' = target,
    revision' = revision + 1,
    prevRevision' = revision,
    nonceSeq' = nextNonceSeq,
    issued' = match target {
      | Transitioning(t) =>
        issued.union(Set({ revision: revision + 1, kind: t.kind, nonce: t.nonce, phase: t.phase }))
      | _ => issued
    },
    outcome' = Accepted,
  }

  action reject(code: str): bool = all {
    auth' = auth,
    revision' = revision,
    prevRevision' = revision,
    nonceSeq' = nonceSeq,
    issued' = issued,
    outcome' = Rejected(code),
  }

  action admit(kind: str, origin: str): bool =
    commit(
      Transitioning({ kind: kind, phase: 0, mode: "Executing", origin: origin, nonce: nonceSeq }),
      nonceSeq + 1,
    )

  action createCommand = {
    nondet staleRevision = Set(false, true).oneOf()
    if (staleRevision) reject("revision_mismatch")
    else match auth {
      | Absent => admit("Create", "Absent")
      | Transitioning(_) => reject("transition_owned")
      | Stable(_) => reject("not_admissible")
    }
  }

  action vaporizeCommand = {
    nondet staleRevision = Set(false, true).oneOf()
    if (staleRevision) reject("revision_mismatch")
    else match auth {
      | Absent => reject("duplicate")
      | Stable(s) => if (s == "Gone") reject("duplicate") else admit("Vaporize", s)
      | Transitioning(t) => if (t.kind == "Vaporize") reject("duplicate") else admit("Vaporize", t.origin)
    }
  }

  val leased = match auth {
    | Transitioning(_) => true
    | _ => false
  }

  // The current lease; meaningful only when `leased` holds.
  val lease = match auth {
    | Transitioning(t) => t
    | _ => { kind: "", phase: -1, mode: "", origin: "", nonce: -1 }
  }

  action advance = all {
    leased,
    lease.phase < lastPhase(lease.kind),
    commit(Transitioning({ ...lease, phase: lease.phase + 1, mode: "Executing" }), nonceSeq),
  }

  action complete = all {
    leased,
    lease.phase == lastPhase(lease.kind),
    commit(Stable(if (lease.kind == "Create") "Warm" else "Gone"), nonceSeq),
  }

  action completeEarly = all {
    leased,
    lease.phase < lastPhase(lease.kind),
    reject("not_terminal"),
  }

  // Vaporize never gives up its lease: deadline and failure reconcile it.
  action settleOrReconcile = all {
    leased,
    if (lease.kind == "Vaporize") commit(Transitioning({ ...lease, mode: "Reconciling" }), nonceSeq)
    else commit(Stable("Failed"), nonceSeq),
  }

  action deadline = {
    nondet early = Set(false, true).oneOf()
    all { leased, if (early) reject("stale_phase") else settleOrReconcile }
  }

  action providerFailure = settleOrReconcile

  // Replays a progress fact from an earlier lease fence. Every fence but the
  // current one carries a lower revision, so the actor must discard it.
  action redeliver = all {
    issued.exists(f => f.revision < revision),
    {
      nondet fence = issued.filter(f => f.revision < revision).oneOf()
      reject("duplicate")
    },
  }

  action interfere = any {
    createCommand,
    vaporizeCommand,
    completeEarly,
    deadline,
    providerFailure,
    redeliver,
  }

  // Uniform choice among seven actions almost never lets a lease walk all of
  // its phases, so the lease holder progresses with probability 3/4.
  action step = {
    nondet roll = 0.to(3).oneOf()
    if (leased and roll > 0) any { advance, complete } else interfere
  }

  // At most one lease fence exists per committed revision.
  val singleLease = issued.forall(a => issued.forall(b => a.revision == b.revision implies a == b))

  // Every accepted input commits exactly one revision; a rejection commits none.
  val revisionStep = match outcome {
    | Accepted => revision == prevRevision + 1
    | _ => revision == prevRevision
  }

  // The current lease owns the newest nonce.
  val leaseFresh = leased implies lease.nonce == nonceSeq - 1

  val safety = singleLease and revisionStep and leaseFresh

  // Witnesses: `npm run spec` requires each to hold in some sampled trace, so
  // the replay provably reaches the behavior it is meant to check.
  val reachesWarm = auth == Stable("Warm")
  val reachesGone = auth == Stable("Gone")
  val reachesFailed = auth == Stable("Failed")
  val reachesPreemptedCreate = leased and lease.kind == "Vaporize" and lease.origin == "Absent"
  val reachesVaporizeReconciling = leased and lease.kind == "Vaporize" and lease.mode == "Reconciling"
  val reachesStaleRedelivery = outcome == Rejected("duplicate") and issued.exists(f => f.revision < revision)
}
