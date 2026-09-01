# Slice 10 formal alignment

The maintained model is `protocol/formal/session-control.qnt`. It mirrors the reducer implemented
after Slice 9; it is not a model of the deleted lifecycle.

## TypeScript correspondence

| Implemented source                                                | Quint model                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `authority.ts` stable and transition algebra                      | `StableKind`, `TransitionKind`, `Phase`, `Mode`, and `Authority`                                              |
| `input.ts` revision, nonce, attempt, phase, and generation fences | fenced submit actions, `InputClass`, and rejected `staleFact`                                                 |
| `reducer.ts` command admission                                    | `admitCreate`, `admitCheckpoint`, `admitSleep`, `admitResume`, `admitWarmWork`, `admitVaporize`, and `rename` |
| `reducer.ts` progress, completion, failure, and reconciliation    | `progress*`, `complete`, `transitionFailure*`, `deadlineElapsed`, and `providerOutcomeUnknown`                |
| `transitions/recovery.ts`                                         | activity, availability-loss, transition reconciliation, and hard-cap actions                                  |
| `public-view.ts`                                                  | `publicStatus`, `deleting`, and `publicActions`                                                               |
| actor store transaction                                           | paired authority and `journalRevision` commit                                                                 |

String identities are represented by bounded integers, and timestamp ordering is collapsed into
the enabled deadline/alarm actions. Proof payloads retain the relationships validated by the
reducer: readiness-generation coherence, activity freshness, backup
prepared/confirmed/owned/current ordering, wake-source ownership, and vaporize absence categories.

## Safety checked

- one present authority is either stable or transitioning;
- authority revision and journal revision commit together;
- every transition owns a non-zero nonce and stable attempt identity;
- every phase belongs to its transition and satisfies its proof prerequisites;
- Warm has coherent runtime, container, supervisor, and transport generations;
- activity belongs to the current supervisor epoch;
- a current backup is prepared, confirmed, and owned;
- Sleeping and actionable Failed have an owned wake source;
- stale facts reject without committing;
- Vaporize retains authority and publishes no actions;
- Gone contains every required absence category and no owned runtime, backup, activity, or wake
  source;
- public state and actions are total;
- every present authority has an armed hard-cap generation.

## Witnesses and exploration

Quint `0.32.0` passed:

```text
parse
typecheck
fullLifecycle
actionableRecovery
ambiguityRetainsFence
50,000 randomized samples x 80 steps: no safety violation
```

The full witness executes Create, Checkpoint, WarmWork, Sleep, Resume, and Vaporize through every
implemented phase and ends in clean Gone.

## Liveness boundary

`eventualSettlement` and `eventualGoneAfterVaporize` are conditional properties, not unconditional
claims. They require:

- logical time progresses;
- actor execution is fair;
- alarms are eventually delivered;
- providers eventually return decisive observations wherever settlement is claimed;
- vaporize cleanup eventually succeeds wherever Gone is claimed.

Permanent provider ambiguity may retain Reconciling forever, matching the implemented reducer.

## Proof limit

Formal alignment and repository-local proof are complete. A live local lifecycle and real
Cloudflare canary were not run because the exact disposable repository, Cloudflare stage/account
authorization, and reset permission were not supplied. The installation pointer in local config is
not deployment authority. Session `6ffa0a512819` was not addressed.
