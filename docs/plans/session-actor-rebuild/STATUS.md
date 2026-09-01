# Session actor rebuild status

This is the maintained execution checklist for the rebuild lane. The detailed acceptance criteria
remain in the approved ten-slice plan. The user resumed the remaining slices and explicitly chose
a clean actor cutover with active legacy removal rather than persisted-record compatibility.

## Completed

- [x] Slice 0 — source and deletion map (`17dbe806`)
- [x] Slice 1 — existing lab extension (`f7908fe9`)
- [x] Slice 2 — pure control kernel (`b90aa35b`)
- [x] Slice 3 — atomic store and actor runtime (`5db3bc26`)

- [x] Slice 4 — create and boot (local implementation and focused proof)
  - [x] typed Create phases and pure reducer proof
  - [x] fenced Create provider executor and focused tests
  - [x] native Durable Object actor-storage adapter and contract tests
  - [x] private companion metadata model and prompt scrubbing
  - [x] production Cloudflare Sandbox provider implementation
  - [x] Sandbox host and create-route cutover
  - [x] actor-derived public projection and create/read/steer path
  - [x] focused actor/provider/host checks and local lab doctor proof
  - [x] lifecycle `create-and-ready` lab driver and retained evidence path
  - [ ] live lifecycle scenario (exact disposable repository not supplied)
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 4 commit

The actor path is the lifecycle proof boundary. `SessionRecord` is now only a derived host/provider
context; it is not persisted authority.

## Completed locally

- [x] Slice 5 — checkpoint, sleep, and resume (local implementation and focused proof)
  - [x] typed provider algebras and fenced phase executors
  - [x] prepared/current/owned backup invariants
  - [x] real Sandbox backup, Pi, runtime-stop, and readiness adapters
  - [x] source and target runtime-generation separation on resume
  - [x] single provider dispatcher for Create, Checkpoint, Sleep, and Resume
  - [x] actor-backed public snapshot, sleep, resume, read, and Sandbox callbacks
  - [x] old public checkpoint/sleep/resume programs removed
  - [x] host create → checkpoint → sleep → resume flow proof through actor authority
  - [x] lifecycle lab driver for checkpoint, sleep, resume, and vaporize
  - [ ] live lifecycle scenario (exact disposable repository not supplied)
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 5 commit

- [x] Slice 6 — runtime loss, activity, deadlines, and hard cap (local implementation and focused proof)
  - [x] authoritative hard-cap generation and deadline in actor state
  - [x] pre-armed Resume cap activated atomically only after actor admission
  - [x] runtime, supervisor, and transport observations fenced by readiness generations
  - [x] exact reconciliation for provider ambiguity and transition availability loss
  - [x] bounded Pi activity persisted from decoded snapshots and invalidated by supervisor epoch
  - [x] deferred Sandbox start/stop/error callbacks with re-entrant stop protection
  - [x] hard-cap failure committed before runtime destruction, with cleanup retry authority
  - [x] actor-backed idle expiry through checkpoint and Sleep
  - [x] old hard-cap, managed-stop, checkpoint, idle, and authority fallback removed
  - [x] focused actor/provider/host tests, worker typecheck/lint, and local lab doctor proof
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 6 commit

- [x] Slice 7 — vaporize (local implementation and focused proof)
  - [x] actor-owned ordered cleanup from admission through absence confirmation
  - [x] owned backup identities retained across Vaporize admission and restart
  - [x] real Sandbox destroy, R2 backup, Hatch, evidence, grant, metadata, schedule, and KV boundaries
  - [x] ambiguous provider outcomes retain the Vaporize nonce and enter reconciliation
  - [x] Gone requires confirmed absence of runtime, backups, evidence, grants, Hatch, idempotency, and schedules
  - [x] old vaporize acquire/release/retry programs and gone-repair lifecycle removed
  - [x] actor create → Warm → vaporize → Gone host flow and idempotent replay proof
  - [x] focused actor/provider/host tests, worker typecheck, and lint
  - [x] full Worker suite
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 7 commit

- [x] Slice 8 — evidence, Hatch, and other warm work (local implementation and focused proof)
  - [x] actor-owned WarmWork admission, execution, settlement, and reconciliation
  - [x] Evidence authority, journal, and evidence state commit in one fenced transaction
  - [x] Hatch, Evidence, and Beam-down use actor authority and actor readiness generations
  - [x] old direct Evidence admission and capacity lifecycle APIs removed
  - [x] actor create → Hatch/Down and create → Evidence host flows
  - [x] focused actor/evidence/host tests, worker typecheck, and lint
  - [x] full Worker suite
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 8 commit

- [x] Slice 9 — cutover and delete old lifecycle (local implementation and proof)
  - [x] one actor authority, reducer, commit adapter, and public-state mapper
  - [x] old stored record, control revision, runtime-epoch key, and lifecycle mutation APIs deleted
  - [x] old create/checkpoint/sleep/resume/vaporize programs and obsolete tests deleted
  - [x] rename moved under reducer revision and journal authority
  - [x] lab `full` runs supported create → checkpoint → sleep → resume → vaporize
  - [x] stateful and structure review recorded in `09-cutover-review.md`
  - [x] full repository test gate, typecheck, formatting, lint, secret scan, and CLI build
  - [ ] live local lifecycle (exact disposable repository not supplied)
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)

## Remaining

- [x] Slice 10 — Quint alignment (local implementation and proof)
  - [x] maintained exact reducer model at `protocol/formal/session-control.qnt`
  - [x] stable states, transition kinds, and every implemented phase mirrored
  - [x] admission, revision/nonce/attempt fences, deadlines, and reconciliation mirrored
  - [x] readiness/activity generations, backup currentness, hard cap, and Vaporize mirrored
  - [x] exhaustive public status, deleting flag, and actions mirrored
  - [x] deterministic full-lifecycle, actionable-recovery, and ambiguity witnesses
  - [x] Quint parse, typecheck, and 50,000-sample safety exploration
  - [x] liveness assumptions and permanent-ambiguity limit stated explicitly
  - [ ] live local lifecycle (exact disposable repository not supplied)
  - [ ] guarded deployed canary and orphan scan (explicit deployment inputs remain incomplete)

## Remaining proof

- [ ] live local create → read/steer → checkpoint → sleep → resume → warm work → vaporize
- [ ] guarded real Cloudflare canary and orphan scan

## Deployment inputs

A deployed canary is blocked until all of these are explicit and unambiguous:

- exact canary installation name;
- exact disposable repository;
- exact Cloudflare stage/account target through existing configuration;
- whether canary resources may be reset between slices.

Never operate on session `6ffa0a512819`.
