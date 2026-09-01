# Slice 9 cutover review

This review applies the stateful-systems and structure-review checks to the implementation after
Slices 0 through 9. It does not claim Slice 10 formal-model or deployed-canary proof.

## Stateful review by slice

| Slice | Authority and transition result                                                                                                                                                                                  | Failure, replay, and restart result                                                                                                                                              | Proof                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | The source/deletion map identifies the Sandbox Durable Object as the only lifecycle authority and KV/R2 as projections or immutable artifacts.                                                                   | Caller timeout, interruption, provider cancellation, and confirmed or unknown provider outcome are distinct.                                                                     | Source packet remains in `00-source-and-deletion-map.md`.                                                                |
| 1     | The lab drives public CLI/HTTP paths and records ownership; it never repairs actor state.                                                                                                                        | Protected and unowned sessions fail closed. Requested fault cuts remain unavailable instead of synthesizing state.                                                               | Lab parser/ownership tests pass. The supported `full` scenario now runs create, checkpoint, sleep, resume, and vaporize. |
| 2     | `SessionAuthority` is the sole persisted lifecycle algebra. `decide` is the sole reducer entry and `publicView` is the exhaustive public-state mapper.                                                           | Revision, nonce, attempt, phase, deadline, generation, and duplicate fences reject stale inputs. Unreachable authority fails validation.                                         | Reducer, reachability, public-view, and command-race tests pass.                                                         |
| 3     | Actor authority, revision, journal sequence/tail/event, and included evidence mutation commit through one Durable Object transaction plan. Effects are returned only after commit.                               | Failed commits dispatch no provider work. Unknown post-dispatch outcomes retain transition ownership and reconcile. Every phase has restart proof.                               | Atomicity, native-storage, restart, and race tests pass.                                                                 |
| 4     | Create owns authority from `Absent` through transport verification; metadata owns only private create inputs and observations. Warm requires coherent runtime, container, supervisor, and transport generations. | Hard cap is armed before Create admission. Provider ambiguity stays fenced; matching idempotency replays from actor metadata. Private prompt data is scrubbed after settlement.  | Create reducer/provider/host/read/steer and route tests pass.                                                            |
| 5     | Checkpoint, Sleep, and Resume are typed actor transitions. Prepared backup is not current until confirmed, and current backup must be owned.                                                                     | Stop/restore ambiguity reconciles without publishing success. Resume uses the confirmed wake source and establishes a new cap generation.                                        | Reducer, Sandbox provider, host create-checkpoint-sleep-resume, and route tests pass.                                    |
| 6     | Runtime, supervisor, transport, activity, deadline, and hard-cap observations are actor inputs. Activity is bounded by readiness generations.                                                                    | Stale callbacks and alarms do nothing. Runtime/provider ambiguity retains exact reconciliation ownership. Hard-cap failure commits before cleanup.                               | Recovery, deadline, hard-cap, callback, activity-expiry, and restart tests pass.                                         |
| 7     | Vaporize preempts ordinary work and retains its nonce until all owned categories are confirmed absent. `Gone` is actor state, not deletion of authority.                                                         | Cleanup phases are idempotent. Unknown cleanup outcomes reconcile. Metadata, schedules, projections, evidence, Hatch, grants, backups, and runtime have explicit absence checks. | Reducer/provider/restart/host/route vaporize tests pass.                                                                 |
| 8     | Evidence, Hatch, Down, and manual/runtime preparation use `WarmWork` actor admission. Evidence admission/finalization can include evidence mutation in the actor commit.                                         | Warm-work provider ambiguity reconciles; stale settlement cannot release another transition. Hatch/runtime generations remain explicit.                                          | Warm-work reducer, Evidence store, Hatch gateway, Down, race, and integrated host tests pass.                            |
| 9     | The old stored record, control revision, runtime-epoch key, `SessionStore`, operation acquire/release APIs, and old lifecycle programs are deleted. Rename now mutates identity through the reducer and journal. | Actor-derived host context is read-only; no fallback can revive deleted authority. Obsolete tests were removed and retained product tests now seed or create actor authority.    | Full repository test gate, typecheck, formatting, lint, secret scan, CLI build, and structural searches pass locally.    |

## Structure review

### Act now — resolved

- Removed the parallel production state path and its direct mutation APIs.
- Removed duplicate runtime, backup, materializer, and workspace layers that existed only for the old
  path.
- Moved rename from a direct record mutation into the revision-fenced reducer and causal journal.
- Removed the dead record-based create-idempotency decision module; actor metadata owns the digest
  schema and replay decision.
- Deleted implementation-specific lifecycle suites and adapters that asserted removed storage keys;
  retained HTTP, Pi, Evidence, Hatch, egress, and change-review tests now prove actor-backed paths.
- Changed the lab `full` scenario so the supported lifecycle reaches owned cleanup instead of
  deliberately stopping before vaporize.

### Keep

- `SessionRecord` remains a derived, non-persisted host/provider context. Evidence, Hatch, workspace,
  projections, and provider adapters consume this bounded shape, while only actor authority can
  produce it.
- `SessionControlGate` remains a local serialization boundary shared by actor transactions and
  command relay. It does not own lifecycle state.
- Native Cloudflare Sandbox callbacks remain thin Promise host islands and feed observations back
  into actor Effects.

### Defer by explicit scope

- The exact Quint model and model checking are Slice 10 work.
- Runtime-loss and hard-cap lab commands remain recorded `not-available` until guarded public fault
  controls exist; the lab does not mutate internal state to fake them.
- A real Cloudflare canary remains blocked on the exact installation, disposable repository,
  stage/account target, and reset permission. No primary or protected session was touched.

## Structural search result

Production lifecycle code contains one actor authority key, one reducer entry, one actor commit
adapter, and one actor public-state mapper. It contains no old session-record key, old control or
runtime-epoch key, `SessionStore`, acquire/release operation API, actor-record fallback, or old
hard-cap/vaporize callback. The forbidden old key appears only as source text in the lint rule's own
negative fixture.
