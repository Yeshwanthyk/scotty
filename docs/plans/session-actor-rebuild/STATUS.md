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
  - [ ] lifecycle `create-and-ready` lab scenario (exact disposable repository not supplied)
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 4 commit

The new actor path is the Slice 4 proof boundary. The old `SessionRecord` create authority and later
legacy lifecycle tests are not compatibility gates for this rebuild; Slices 5–9 replace those
surfaces in order.

## In progress

- [x] Slice 5 — checkpoint, sleep, and resume (local implementation and focused proof)
  - [x] typed provider algebras and fenced phase executors
  - [x] prepared/current/owned backup invariants
  - [x] real Sandbox backup, Pi, runtime-stop, and readiness adapters
  - [x] source and target runtime-generation separation on resume
  - [x] single provider dispatcher for Create, Checkpoint, Sleep, and Resume
  - [x] actor-backed public snapshot, sleep, resume, read, and Sandbox callbacks
  - [x] old public checkpoint/sleep/resume programs removed
  - [x] host create → checkpoint → sleep → resume flow proof with no legacy record
  - [ ] lifecycle lab scenario (exact disposable repository not supplied)
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
  - [x] old hard-cap, managed-stop, checkpoint, idle, and legacy authority fallback removed
  - [x] focused actor/provider/host tests, worker typecheck/lint, and local lab doctor proof
  - [ ] guarded deployed canary (explicit deployment inputs remain incomplete)
  - [x] Slice 6 commit

## Remaining

- [ ] Slice 7 — vaporize
- [ ] Slice 8 — evidence, Hatch, and other warm work
- [ ] Slice 9 — cutover and delete old lifecycle
- [ ] Slice 10 — Quint alignment and complete proof

## Deployment inputs

A deployed canary is blocked until all of these are explicit and unambiguous:

- exact canary installation name;
- exact disposable repository;
- exact Cloudflare stage/account target through existing configuration;
- whether canary resources may be reset between slices.

Never operate on session `6ffa0a512819`.
