# Session actor rebuild: source and deletion map

This packet pins Slice 0 to Scotty commit `7fe8ea030bc81161332a011976249f08c6c12173`.
It records current implementation facts and provider semantics that constrain the rebuild. It does
not claim that the proposed actor exists yet.

## Baseline

The isolated implementation lane is branch `session-actor-rebuild` at
`.lane/trees/session-actor-rebuild`. The primary `main` checkout was clean when the lane was
created and was not changed.

The initial live-lab attempt stopped at its dependency preflight. After installing the lane-local
dependencies, the existing baseline passed:

```text
npm run test:lab
  4 tests passed

npm run lab -- start
  run lab-a1935874-32a8-4340-9ad7-855ed02cadb2 started

npm run lab -- exec lab-a1935874-32a8-4340-9ad7-855ed02cadb2 -- doctor --json
  {"ok":true,"mode":"connected","host":"http://127.0.0.1:8791"}

npm run lab -- stop lab-a1935874-32a8-4340-9ad7-855ed02cadb2
  stopped; process owned; no cleanup errors
```

No session was created. The protected session `6ffa0a512819` was not addressed. That identifier
does not occur in the tracked source, so protection must live in the new lab and canary guards as
well as operator inputs.

## Effect execution contract

- Reusable Effect operations use `Effect.fnUntraced`; the generator is suspended and invoked per
  execution (`vendor/effect/packages/effect/src/Effect.ts:13355-13448`,
  `vendor/effect/packages/effect/src/internal/effect.ts:1198-1213`).
- `Effect.tryPromise` turns synchronous throws and Promise rejection into typed failure. Its
  `AbortSignal` is aborted on interruption, but a provider stops only when it observes and honors
  that signal (`vendor/effect/packages/effect/src/Effect.ts:890-939`,
  `vendor/effect/packages/effect/src/internal/effect.ts:1061-1157`).
- Effect timeout races the operation with `sleep` and interrupts the loser. That confirms local
  interruption, not remote cancellation (`vendor/effect/packages/effect/src/internal/effect.ts:3676-3703`,
  `vendor/effect/packages/effect/test/Effect.test.ts:1507-1524`).
- Scope closure is exactly-once and finalizers run in reverse registration order by default.
  `Effect.scoped` closes on success, typed failure, defect, or interruption
  (`vendor/effect/packages/effect/src/internal/effect.ts:3774-3815`,
  `vendor/effect/packages/effect/src/internal/effect.ts:3902-3910`).
- Retry applies to typed failures, not defects or interruption. `Schedule.recurs(3)` means four
  total attempts, including the first execution
  (`vendor/effect/packages/effect/src/Effect.ts:3987-4008`,
  `vendor/effect/packages/effect/src/internal/schedule.ts:51-80`). Ambiguous mutations are not
  retryable until reconciliation establishes a safe next action.
- Actor time comes from `Clock`; deterministic deadline, retry, and alarm tests use `TestClock`
  (`vendor/effect/packages/effect/src/Clock.ts:40-145`,
  `vendor/effect/packages/effect/src/testing/TestClock.ts:1-110`). Effect-returning tests use
  `it.effect` and `assert` from `@effect/vitest`; the harness supplies a scope and `TestClock`
  (`vendor/effect/packages/vitest/src/internal/internal.ts:24-44`,
  `vendor/effect/.patterns/testing.md:3-38`).

The actor therefore distinguishes five outcomes at every provider boundary:

| Boundary result                                            | Actor meaning            |
| ---------------------------------------------------------- | ------------------------ |
| provider rejected before admission                         | confirmed typed failure  |
| provider returned a fenced success receipt                 | confirmed success        |
| provider returned a fenced failure receipt                 | confirmed failure        |
| local timeout or interruption after admission              | unknown provider outcome |
| explicit provider cancellation plus confirming observation | confirmed cancellation   |

Stopping an await, aborting an Effect fiber, or observing a caller timeout never implies that a
remote mutation stopped.

## Cloudflare, Alchemy, and Sandbox contract

Durable Objects are single-threaded, globally name-addressed, SQLite-backed authorities
(`vendor/alchemy/website/src/content/docs/cloudflare/compute/durable-objects.mdx:6-19`). Alchemy's
public state includes storage, alarms, hibernating WebSockets, `waitUntil`, and
`blockConcurrencyWhile`
(`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObjectState.ts:11-61`).

Three implementation constraints follow:

1. `waitUntil` registers un-awaited work, and tested responses can precede background completion
   (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObjectState.ts:71-85`,
   `vendor/alchemy/packages/alchemy/test/Cloudflare/Workers/WaitUntil.test.ts:54-90`). Authority
   commit cannot be delegated to un-awaited work.
2. Alchemy runs a storage transaction callback through detached `Effect.runPromise`
   (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObjectStorage.ts:252-259`). If
   the outer Effect is interrupted after admission, commit versus rollback is unknown. The actor
   must reread authority revision and journal sequence before dispatching or reporting a result.
3. Cloudflare exposes one native alarm timestamp per Durable Object. Alchemy multiplexes named
   scheduled events in SQLite and reconciles the earliest alarm
   (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObject.ts:801-806`,
   `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/ScheduledEvents.ts:133-188`). Actor alarm
   inputs therefore carry their own nonce, attempt, phase, and deadline fence.

Alchemy container start is not itself a readiness proof. The native start issues a start request,
while Alchemy's adapter calls it synchronously without awaiting a native completion
(`node_modules/@cloudflare/containers/dist/lib/container.d.ts:154-185`,
`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerPlatform.ts:172-178`). Warm
requires later runtime, supervisor, and Pi transport observations for the current generations.

The installed Sandbox SDK is `0.12.3` (`node_modules/@cloudflare/sandbox/package.json:1-4`). Its
important boundaries are:

- `exec` exposes timeout and signal options, but non-streaming execution checks the signal before
  dispatch rather than transmitting cancellation to the command client
  (`node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts:358-405`; source-map
  `../src/sandbox.ts:3867-3895`).
- HTTP process kill discards its signal, and WebSocket cancellation is only a best-effort cancel
  message (source-map `../src/sandbox.ts:4656-4665`,
  `../src/clients/transport/ws-transport.ts:539-557`).
- `destroy()` coalesces concurrent calls but can hang indefinitely; callers must bound their wait
  (`node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts:2885-2910`). Scotty already treats
  this as ambiguous and retains retry authority (`worker/src/session/object.ts:2972-2989`).
- Backup restore has the strongest existing provider fence: it persists phases and marks
  `verified/committed` only after fence checks (Sandbox source-map
  `../src/backup/restore-lifecycle.ts:54-171,224-281`). Transport or lifetime replacement can
  yield `admitted: "unknown"` (`../src/backup/restore-lifecycle.ts:332-388`).

## Current authority and call paths

Public routes enter the lifecycle from `worker/src/index.ts:604-626,731-834`. CLI snapshot,
resume, and vaporize map to those routes in `cli/src/commands.ts:2128-2183`. The Sandbox host class
remains `worker/src/session/object.ts`.

Current create is:

```text
worker/src/index.ts:1483-1514
-> Sandbox.createScottySession (worker/src/session/object.ts:3742-3774)
-> createScottySessionProgram (worker/src/session/object.ts:2512-2642)
```

Current snapshot, sleep, resume, down, and vaporize programs are in
`worker/src/session/object.ts:2866-3140,4993-5231`. Runtime callbacks and hard-cap/idle inputs are
handled separately in `worker/src/session/object.ts:3296-3431,4895-4987`.

Session authority writes currently converge on one transaction in
`worker/src/session/store.ts:205-218`, which writes `scotty:session` and
`scotty:session-control-revision`. Authority-changing operations are nevertheless distributed
across create, lease/status methods, hard-cap, runtime-stop, operation failure, and activity
(`worker/src/session/store.ts:320-345,417-613`). Evidence is a second caller of that transaction
and changes Session operation state atomically with evidence state
(`worker/src/evidence/store.ts:597-679,763-846`). Hatch has separate `scotty:hatch` authority and
must be fenced by the actor even though it does not directly write Session authority
(`worker/src/hatch/store.ts:46-63,982-1070`).

KV remains projection-only (`worker/src/session/projection.ts:57-105`). Backup deletion is already
scoped to owned `backups/<id>/` prefixes (`worker/src/backups/store.ts:74-90`); shared sandbox
bundle objects are outside Session deletion.

## Retain and replace

Retain through the rebuild:

- the required Sandbox subclass and native callback signatures;
- typed workspace, runtime, backup, credential, Evidence, and Hatch adapters;
- credential isolation and session-bound sentinels;
- immutable owned backup handles and the restore lifecycle fence;
- Pi supervisor/live-event protocol and transport verification;
- KV projection and explicit projection removal;
- current public route, CLI JSON, browser, and error contracts;
- cleanup retry schedules, gone tombstone semantics, runtime epoch observations, and create
  idempotency concepts until equivalent actor phases are proved.

Replace, then delete only after caller and structural proof:

- stored independent public status;
- generic nullable operation and inferred phase flags;
- caller-provided allowed-status arrays;
- acquire/update/release lifecycle APIs;
- old create, checkpoint/snapshot, sleep, resume, down, and vaporize programs;
- direct Session lifecycle decisions in Evidence and Hatch;
- in-memory create coalescing as a lifecycle correctness mechanism;
- obsolete tests that assert implementation structure rather than public or authority contracts.

Do not delete the current retry callbacks, revision key, gone tombstone, preview/Hatch cancellation
maps, or shared adapter behavior until the actor has equivalent restart and cleanup proof.

## Existing lab extension boundary

The current grammar is only `start`, `setup`, `exec`, and `stop`
(`scripts/scotty-lab.ts:316-362`). `exec` validates the recorded process and forwards directly to
the real CLI (`scripts/scotty-lab.mjs:443-450,490-500`). The lab manifest records only its exact
run, worker, private temp paths, process identity, and fixed loopback endpoint
(`scripts/scotty-lab.mjs:115-122,238-257`). Cleanup stops the owned process group, removes only
containers for the exact worker, and retains `cleanup-pending` evidence on failure
(`scripts/scotty-lab.ts:81-128,243-285`).

Slice 1 may add `lifecycle` orchestration and durable evidence artifacts, but it must remain a thin
driver of public CLI/HTTP/debug-observation paths. It must never write actor storage, choose a
desired state, repair a session, or delete a resource it did not record as owned.

The live plan needs these corrections:

- source ownership includes `scripts/scotty-lab.mjs` and `scripts/scotty-lab.test.mjs`, not only
  the TypeScript command file and tests;
- the lab uses fixed ports 8791/8792;
- no actor fault controls exist yet; current failure handling is process supervision only;
- the lab currently retains no per-run command transcript or evidence directory;
- local setup needs an explicit repository plus Docker, `gh`, Bun, private Pi auth, and GitHub CLI
  authentication (`e2e/support/local-worker.mjs:108-145`).

## Deployed-canary boundary

The canary is a separate disposable Alchemy stack, not production
`alchemy.run.ts` (`e2e/canary/full-stack-canary.run.ts:10-25`). Its stage must match
`scotty-e2e-` plus 32 lowercase hexadecimal characters, and deploy/destroy require exact
stage-scoped approval values (`e2e/canary/full-stack-canary.ts:64-96`).

Before first deployment the operator must explicitly provide:

- canary installation/stage identity;
- disposable repository;
- configured Cloudflare account target;
- whether the disposable stage may be reset between slices.

No value may be inferred. No deployment is authorized by this packet.

The current canary probes runtime, KV projection, credential grant, backups, schedules, lease,
alarm, idempotency, and registry listing
(`e2e/canary/full-stack-canary-worker.ts:150-194`). Its `noOrphans` assertion is incomplete: it
does not require an empty registry, an absent current GitHub grant, or peer authority `gone`
(`e2e/tests/deployed.test.mjs:202-210,544-568`). Those checks must be added before the rebuild can
claim complete deployed cleanup proof.

Guarded canary shape after explicit inputs:

```sh
export SCOTTY_E2E_APPROVE_DEPLOY="deploy:$stage"
npx alchemy deploy e2e/canary/full-stack-canary.run.ts --stage "$stage" --yes

# Run the stage-authenticated deployed test using the explicit disposable repository.

npx alchemy plan e2e/canary/full-stack-canary.run.ts --stage "$stage"
export SCOTTY_E2E_APPROVE_CLEANUP="destroy:$stage:disposable"
npx alchemy destroy e2e/canary/full-stack-canary.run.ts --stage "$stage" --yes
```

The exact environment and test command remain the documented commands in `e2e/README.md:59-69,
116-157`. Production deployment remains a different guarded workflow requiring clean local
`main == origin/main`, explicit installation topology, and exact resource approval
(`scripts/deploy-production.mjs:665-695,785-844,960-988`). This lane does not satisfy that guard
and must not be deployed over production.

## Slice gates derived from the source

Every behavioral slice must prove:

1. authority commit and journal event are all-old or all-new;
2. no provider dispatch occurs without a confirmed intent commit;
3. interruption of a commit is reconciled before dispatch;
4. every fact, alarm, activity observation, and callback is fenced by current revision, nonce,
   attempt, phase, and relevant provider generation;
5. unknown provider outcome retains transition ownership;
6. public state is exhaustively derived from authority;
7. local lab commands and cleanup are captured as evidence;
8. deployed proof is reported separately and only after explicit inputs;
9. `6ffa0a512819` is rejected before any session mutation or cleanup path.

Quint remains deferred until the implemented TypeScript reducer and transition set are complete.
