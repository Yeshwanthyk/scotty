# Effect v4 alignment — status and agent-ready task breakdown

Companion to `EFFECT_V4_MIGRATION.md`. That packet's contracts, invariants, and proof gates
still govern; this file records the 2026-07-24 audited status and the remaining work as
self-contained tasks suitable for handing to an implementation agent one at a time.

## How to execute a task (instructions for the assigned agent)

- Read `EFFECT_V4_MIGRATION.md` sections "Settled contracts and invariants" and the chunk
  named in the task before writing code. Public HTTP, CLI, persistence, terminal, and
  security contracts must not change unless the task says so.
- Every task ends with the local gate: `npm run fmt && npm run lint && npm run typecheck
&& npm run test:all`. A task is not done if any step fails or if it needed new
  `oxlint-disable` directives it does not justify inline.
- Follow the established idioms: `Context.Service` + `Layer.succeed`, `Data.TaggedError`
  with a `reason` field for internal failures, `ScottyError` for public failures,
  `Clock.currentTimeMillis` for time, `Schema` decode for anything persisted or untrusted.
  Reference implementations: `worker/src/session-store.ts`, `worker/src/credential-vault.ts`,
  `worker/src/egress.ts`, `worker/src/auth-object.ts` (DO boundary pattern).
- One task per branch/commit series; do not fold in neighboring tasks.

## Reconciled chunk status (2026-07-24 implementation update)

WS-A, B1–B4, WS-C, WS-D, WS-E, and WS-F are implemented and locally verified. In particular,
`session.ts` has one host Promise boundary, no direct DO storage outside layer construction,
composed Effect programs using `Clock`, and direct fault-injection coverage. Its lifecycle suite
now passes the outer `TestClock` service through that real boundary instead of aligning a fake clock
to wall time.

B5 is partially complete: shared contracts run against the production SessionRecordStorage and
BackupStore adapters behind explicit deployed gates, and the deployed SessionRecordStorage adapter
now performs the real create-idempotency deletion instead of a test-only no-op. The governing
packet's broader production matrix remains evidence work.

The full-stack disposable canary passed its real Cloudflare lifecycle on 2026-07-24: DO authority,
KV projection, R2 backup/restore, credential isolation, egress, Sandbox runtime, lifecycle
callbacks, HTTP, PTY reconnect, hard-cap sleep, host reconstruction, beam-down, and teardown with
zero orphans. Its immediate following Alchemy plan reported four no-ops. WS-G remains gated only on
one stable Alchemy-managed production release. The task briefs below remain as the audit trail and
acceptance contracts; don't re-dispatch completed tasks.

## Dependency order

```
A2 ∥ B1 ∥ E2a
B1 → B2 → B3, B4          (safety net before refactor)
B2..B4 → C1 → C2 → C3, C4, C5
B1 → D5;  C-late ∥ D1..D4 ∥ E1 ∥ E2b
F1 → F2                    (independent of B–E)
G gated last
```

Delegable as mechanical/bulk: A2, B1, D3, E1, E2a, F1. Needs careful review or explicit
operator approval (core logic): C2, C3, C5, D4. Everything else is standard.

---

## WS-A — Docs

### A2 — Point entry docs at reality

Files: `README.md`, `PLAN.md`, `IMPLEMENTATION_DAG.md`.
Do: README deploy section documents the Alchemy path (`npm run deploy:production`,
stage/approval env vars from `alchemy.run.ts`) and links `EFFECT_V4_MIGRATION.md` and this
file; keep a short Wrangler local-dev note. Add a header banner to `PLAN.md` and
`IMPLEMENTATION_DAG.md`: historical, superseded for architecture by `EFFECT_V4_MIGRATION.md`;
state-machine/invariant content still authoritative.
Accept: no stale Wrangler-deploy instructions remain in README.

## WS-B — Test safety net (before any session.ts refactor)

### B1 — Shared test infrastructure

Files: new `worker/test/support/`; refactor `session-store.test.ts`,
`session-projection.test.ts`, `repo-projection.test.ts`, `session-lifecycle.test.ts`,
`create-idempotency.test.ts`, `credential-vault.test.ts`, `backup-store.test.ts`,
`sandbox-runtime.test.ts`, `rollout-discovery.test.ts` to consume it.
Do: (1) one `SessionRecord` fixture builder replacing the four divergent in-file `record()`
builders; (2) one generic in-memory storage fake with a single fault-injection idiom
(injectable failure per op + optional countdown counter), replacing the bespoke
`Memory*Storage`/`Fake*Capabilities` copies; (3) a contract-suite runner parameterizable
over implementations (used later by B5).
Accept: all existing tests green with unchanged assertions; no test file defines its own
storage fake or record builder.

### B2 — Direct Sandbox DO harness + create/resume tests (Chunk 8 gate)

Depends: B1. Files: new `worker/test/session-harness.ts`, `worker/test/session-create.test.ts`,
`worker/test/session-resume.test.ts`.
Do: instantiate `Sandbox` from `worker/src/session.ts` with a fake `ctx` (storage from B1,
recording `schedule`/`deleteSchedules`/`abort`) and stubbed `BaseSandbox` methods (`exec`,
`createSession`, `deleteSession`, `createBackup`, `restoreBackup`, `writeFile`, `mkdir`,
`setEnvVars`, `stop`, `destroy`, `client.utils.listSessions`), following the existing
`worker/test/cloudflare-workers-stub.ts` aliasing approach. Cover: happy create
(record→projection→schedule ordering, final `warm`), idempotent replay, conflict, and
injected failure at each stage (credential seed, workspace prepare, container-auth seed,
agent launch, hard-cap schedule) asserting `failed` + non-recoverable + destroy attempted;
resume happy path, resume without backup (`wrong_state`), injected failure at each resume
stage asserting `failed` + recoverable-only-with-current-backup.
Accept: tests run in `npm run test:worker`; no `vi.mock` of the `Sandbox` class itself.

### B3 — Lifecycle tests (Chunk 9 gate)

Depends: B2. Files: new `worker/test/session-lifecycle-machine.test.ts`.
Do: hard cap (grace re-schedule, stale `hardCapAt` payload ignored, operation-exceeded-grace
→ failed via `hardCapObservationIsCurrent` guard), idle expiry (`onActivityExpired`),
managed stop (commit → `sleeping` in `onStop`; uncommitted stop → `failed
runtime_stopped`; `finalizeManagedStop` rollback claim + agent resume + lease release;
rollback-failure retry path), 12-attempt `captureThreadId` bound, abandoned-lease recovery
(a lease written by the removed publish endpoint → hard-cap alarm converts to `failed` — this
documents the compatibility backstop). Wall-clock injection is acceptable until C2 lands; convert to
`TestClock` afterwards (tracked in C2 accept).
Accept: every transition in the list has a test naming its trigger and final record state.

### B4 — Beam-down / vaporize tests (Chunk 10 gate)

Depends: B2. Files: new `worker/test/session-down-vaporize.test.ts`.
Do: down-archive manifest/tar member construction and lease release on failure; vaporize full
sequence (schedule cancel order, backup dedupe delete, credential delete, `gone` tombstone,
projection removal), `retryVaporizeSession` idempotent re-entry, lease-changed conflict,
destroy-timeout path (`ctx.abort` + retry armed), gone-tombstone projection repair.
Accept: each stage has an injected-failure case proving durable retry or correct failure.

### B5 — Adapter contract gate

Depends: B1. Files: adapter test files from B1.
Do: run the shared contract suites against the B1 fakes always, and against production
implementations behind the existing deployed-test env gates (`SCOTTY_E2E_*`), mirroring how
`e2e/tests/deployed*.mjs` gate. Start with `SessionRecordStorage` (real DO storage via
deployed harness) and `BackupStore`.
Accept: one contract suite per adapter, two implementations wired, fake path in `test:all`.

## WS-C — session.ts consolidation (core logic — operator approval required before starting)

### C1 — Single DO boundary helper + memoized layers

Files: `worker/src/session.ts`.
Do: replicate the `auth-object.ts:128` `#run` pattern: one private helper executing an
Effect against instance-memoized layers (layers are pure functions of `ctx.storage`/`env`;
build once per DO instance). Delete `runSessionStore`, `runBackupStore`,
`runCredentialVault`, `runSandboxRuntime`, `runRolloutDiscovery`, `runAgent`, and the
inline copies in `prepareWorkspace`/`seedContainerAuth`; drop the decorative
`Effect.scoped` on non-scoped layers.
Accept: exactly one `Effect.runPromise` call site pattern (one disable directive); B2–B4
suites green unchanged.

### C2 — Orchestration methods become composed Effect programs

Depends: C1. Files: `worker/src/session.ts`, touch `worker/src/contracts.ts` only for the
managed-stop error tag.
Do: convert method bodies to `Effect.fnUntraced` programs run once at the RPC boundary,
method-by-method in this commit order: checkpoint/stopAfterCheckpoint → create → resume →
vaporize → down → schedule callbacks. Adopt `Clock` everywhere (34 wall-clock
sites); replace the 20×250ms poll in `stopAfterCheckpoint` with `Effect.retry` +
`Schedule`; replace `ManagedStopArmedError` with a `Data.TaggedError`; remove the raw
throw at `session.ts:436` (typed error → existing envelope). Public RPC signatures,
statuses, lease semantics, and envelope text must not change.
Accept: B2–B4 suites green; B3 converted to `TestClock`; `scotty/no-raw-wall-clock` and
`scotty/no-try-catch-or-throw` enabled for `session.ts` in `.oxlintrc.json`.

### C3 — TerminalAttachments service

Depends: C1 (C2 not required). Files: new `worker/src/terminal-attachments.ts`,
`worker/src/contracts.ts`, `worker/src/session.ts`, new test file.
Do: move `TerminalAttachmentLeaseSchema` into `contracts.ts`; extract the lease CRUD and
release state machine (creating/active/releasing + `createSettled`, expiry conditions)
from `session.ts:90-98,220-316,905-1043` into a `Context.Service` following
`session-store.ts` idiom; log (don't swallow) release-cleanup failures — the bare
`catch {}` at `session.ts:1000` becomes a logged best-effort. Move the create-idempotency
transaction (`session.ts:168-182`) behind `SessionStore`.
Accept: `session.ts` has no direct reads/writes of `scotty:terminal-attachments` or
`scotty:create-idempotency`; lease transitions have their own tests.

### C4 — All record access through SessionStore

Depends: C1. Files: `worker/src/session.ts`, `worker/src/session-store.ts`.
Do: add a non-failing `read` accessor to `SessionStore` for guard reads (current
`requireRecord` throws on absent/gone, which forced the raw reads); replace the ~30
`this.ctx.storage.get(RECORD_KEY)` sites and the direct transactions at
`session.ts:579,655,705,1205`; delete `session.ts`'s duplicate `RECORD_KEY`.
Accept: zero `ctx.storage` references in `session.ts` outside layer construction; enable
the `no-direct-do-storage` rule (E2b) for `session.ts`.

### C5 — Close the stuck-booting crash window

Depends: B2 (test first). Files: `worker/src/session.ts`.
Do: in `createScottySession`, arm the hard-cap alarm before committing the initial record
(orphan alarm is safe: `enforceHardCap` re-reads the record and no-ops on mismatch),
mirroring resume's ordering, so a crash after commit can no longer strand `booting` with a
held lease and no alarm.
Accept: B2 gains a crash-window test (kill between commit and old alarm point → hard cap
still fires → `failed`).

## WS-D — HTTP boundary hardening (Chunk 7 bar)

### D1 — Thin the fat routes

Files: `worker/src/index.ts`, `worker/src/session.ts` (hint enrichment), `worker/src/auth.ts`.
Do: (1) `/api/sessions/:id/pty` (`index.ts:291-326`): drop the pre-flight
`getScottySession` warm-check; catch the DO's own `wrong_state` and attach the friendly
hint. (2) `POST /api/sessions` (`index.ts:161-187`): fold `trackRepoBestEffort` behind a
single call (either into the DO create path's projection step or one worker-side service
helper). (3) Extract the root-browser-registration redirect helper duplicated at
`index.ts:344-377`. (4) Move PTY-ticket credential-resolution policy (`index.ts:274-289`)
into the auth layer.
Accept: every route body is decode → call → encode; `routes.test.ts` green.

### D2 — Error envelope seam

Files: `worker/src/index.ts:574-606`.
Do: `normalizeError` recognizes `ScottyError` via `instanceof`/tag first; add explicit
mappings for `SessionProjectionFailure`/`RepoProjectionFailure` (internal 500 is fine but
must log the tagged reason, not lose it to duck-typing).
Accept: a test proving a projection failure surfaces its reason in logs and a stable envelope.

### D3 — Boundary dedup and Schema parsers

Files: `worker/src/index.ts`, `worker/src/auth.ts`, `worker/src/auth-registry.ts`.
Do: one shared SHA-256/hex+compare utility replacing the three implementations
(`index.ts:496-499`, `auth.ts:220-230`, `auth-registry.ts:515-518`); replace regex/Number
ad-hoc parsers (`index.ts:444-512`) with Schema decoders in `contracts.ts`; one shared
constructor for the per-request projection layers (`index.ts:173,191,207`).
Accept: no duplicate digest code; parsers colocated with the other Schema decoders.

### D4 — WebSocket bridge scope safety

Files: `worker/src/index.ts:514-572`, `worker/src/session.ts`.
Do: log cleanup failures (the silent `waitUntil(cleanup().catch(() => undefined))` at
`index.ts:530`); add a deterministic release backstop beyond close/error events (the
heartbeat expiry remains the durable one — document it as the contract); write down the
scope-ownership contract the packet leaves open for Chunk 7.
Accept: disconnect paths covered by a test; no silent cleanup swallow.

### D5 — Route parity tests against a real DO

Depends: B2 harness. Files: `worker/test/routes.test.ts`.
Do: replace the whole-DO `vi.fn()` stub with the B2 fake-storage-backed `Sandbox` for the
session routes, keeping pure HTTP-layer cases as-is.
Accept: create/resume/vaporize routes exercise real orchestration, and the removed publishing route returns 404.

## WS-E — Shared abstractions and enforced conventions

### E1 — Generic KV projection helper

Files: `worker/src/session-projection.ts`, `worker/src/repo-projection.ts`.
Do: extract the duplicated paginate→decode→filter→sort program
(`session-projection.ts:97-123` vs `repo-projection.ts:84-111`) into one generic helper.
Accept: both services consume it; both test suites green unchanged.

### E2a — Lint config ratchet (behavior-neutral, do now)

Files: `.oxlintrc.json`, `worker/src/auth-object.ts` (boundary disable directives only).
Do: (1) invert the strict override — strict rules apply to `worker/src/**/*.ts` by
default, with a legacy-exception override for exactly `session.ts`, `index.ts`, `auth.ts`
relaxing only the rules they still violate; (2) add `auth-object.ts`, `agent-runtime.ts`,
`bindings.ts` to strict coverage; (3) wire or delete the six orphaned rules
(`no-effect-internal-tags`, `no-instanceof-tagged-error`, `no-promise-catch`,
`no-unknown-error-message`, `no-unknown-shape-probing`, `prefer-yield-tagged-error`) —
enable in the strict set if they pass on migrated files, otherwise delete the rule files.
Accept: `npm run lint` green with no new unjustified disables; lax-by-default is gone.

### E2b — New lint rules

Files: `scripts/oxlint-plugin-scotty/rules/`, `.oxlintrc.json`.
Do: (1) `no-direct-do-storage`: ban `ctx.storage`/`this.ctx.storage` member access outside
`session-store.ts`, `credential-vault.ts`, `auth-object.ts` (enable for `session.ts` after
C4); (2) `no-storage-key-literal`: ban `"scotty:*"` string literals outside store modules;
(3) `no-error-subclass`: ban `class X extends Error` (exception list: `cli/scotty.ts`
until F2). Deferred, post-C2: enable `no-raw-wall-clock` for `worker/test/**`; post-F2:
add `cli/**` to strict coverage.
Accept: rules have unit tests alongside the existing rule tests; lint green.

## WS-F — Effect-native CLI (Chunk 11, independent)

### F1 — Module split (no behavior change)

Files: `cli/scotty.ts` → `cli/src/` modules.
Do: split along the existing pure/impure line: schemas/decoders; pure parse/render
helpers; `CliDependencies` host adapters; HTTP transport; tar/archive; command handlers;
`main`. No logic edits; golden tests (`cli/test/cli.test.ts`) unchanged and green.
Accept: `bun build cli/scotty.ts --compile` (or updated entry) still produces the CLI;
`npm run test:cli` green with zero assertion changes.

### F2 — Effect services and single fold

Depends: F1. Files: `cli/src/**`.
Do: `CliDependencies` becomes Effect services (transport/fs/process/browser); async flows
become Effect programs; `main` becomes the single `Effect.runPromise` + one typed-error →
stderr-envelope/exit-code fold replacing the 13 try/catch mapping sites. Preserve exit
codes 0–5, config precedence, non-TTY JSON, idempotency keys, token non-disclosure,
secure writes, archive verification, compile shape.
Accept: golden tests green unchanged; `CliError` subclass removed; `cli/**` joins strict
lint coverage.

## WS-G — Cutover (Chunk 12, gated — do not start)

Deployed Alchemy canary + one stable release first; then remove `worker/wrangler.jsonc`,
Wrangler dev/probe scripts, finish README. Governed entirely by the packet.
