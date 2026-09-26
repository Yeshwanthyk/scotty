# Scotty quality and structure review

Reviewed at `c87ee823ed72e7af6cf5267df07de87ae4f48920`, with a clean initial working tree. Analysis first: no product implementation, deployment, or test deletion in this pass. Luna high scouts covered lifecycle/state, storage/authentication, verification, UI, runtime protocols, and CLI/deployment; the parent checked consequential claims and reconciled counterevidence.

The target is a clean, working new product. Old wire formats, storage shapes, and command behavior are not requirements merely because they exist today. Correctness requirements still need explicit proof: credential isolation, operation ownership, recoverable state, and truthful outcomes.

## Judgment

Scotty has a sound core direction: Durable Objects own state; the session actor has explicit transitions, revisions, operation identities, and a journal; R2 owns artifacts/backups; KV supplies projections. Keep that foundation.

The main weaknesses are the large amount of application logic inside host adapters, contracts independently reconstructed by different clients, incomplete failure verification through real entrypoints, and growing collections persisted as whole records. There are also concrete recovery and session-isolation problems. A file-splitting campaign would leave these problems largely intact.

Start with four correctness slices: create reservation replay, Pi command replay, complete deployment admission, and browser session isolation. Build reusable scenarios around those slices, then use them to extract domain boundaries. Do not start with a mass rewrite or blanket test deletion.

## Concrete findings

### 1. Create replay can arm a different cap from the one it admits — P1, reproduced at controller/reducer boundary

The host creates a fresh deadline/generation on each request in [session/object.ts](/Users/yesh/code/personal/scotty/worker/src/session/object.ts:3444). When a previous reservation exists without actor authority, [create-controller.ts](/Users/yesh/code/personal/scotty/worker/src/session-actor/create-controller.ts:398) arms the reservation's old cap. It then dispatches `command(request, activeMetadata.createAttempt)` at line 430. The command builder takes `request.hardCap`, not the reserved cap, at line 246.

Sequence: persist the create reservation; stop before authority admission; retry the same idempotency key. The retry arms generation A, admits generation B, and the scheduled A alarm is rejected as `stale_generation`. The creation path also uses reservation metadata for workspace preparation, so the mismatch crosses a real application boundary.

An isolated [reproducer](/tmp/scotty-quality-audit-20260922/create-reservation-replay.ts) executes the production create controller and reducer with controlled metadata/actor adapters. Result: `InProgress`, `original-cap` armed, `retry-cap` admitted, original alarm rejected. This is not a deployed alarm test.

**Target:** make the durable create intent own the exact admitted identity/configuration/cap. Use that same intent for scheduling and admission on every retry. Separate the original create reservation from the active runtime cap after resume; those represent different facts. Verify interruption after each admission boundary and reconstruction with fresh process memory.

### 2. Deployment readiness cannot prove it discovered every session — P1, source-confirmed gap

[The readiness route](/Users/yesh/code/personal/scotty/worker/src/index.ts:957) discovers candidates exclusively from KV, then reads each candidate's authoritative DO. [Projection publication](/Users/yesh/code/personal/scotty/worker/src/session/object.ts:3258) ignores write failures. Missing or undecodable projections therefore omit sessions entirely. [The CLI gate](/Users/yesh/code/personal/scotty/cli/src/installation-deployment.ts:265) accepts an empty readiness array.

The CLI's [container baseline check](/Users/yesh/code/personal/scotty/cli/src/installation-deployment.ts:284) rejects active rollouts, but not active session instances. The maintainer script has a separate [active-instance check](/Users/yesh/code/personal/scotty/scripts/release/deploy-production.mjs:254). These deployment paths enforce different policies. A preflight also needs protection against new admission after inspection; a point-in-time list alone is not a deployment fence.

**Target:** one deployment safety service shared by the CLI and maintainer flow. Give it an authoritative membership/admission contract, a deployment admission fence, per-session readiness, and provider inventory reconciliation. Unknown or incomplete inventory must not certify safety. Keep KV as a display projection. Provider rollout settlement is a separate condition from session safety.

**Proof:** a live authoritative session absent from KV; corrupt/stale KV entries; empty projection list with active provider inventory; create/resume racing the deployment fence; identical decisions through both deployment entrypoints. No production deployment was attempted here.

### 3. Browser session changes can carry composer state and late completions across identities — P1 candidate, strong source inference

[The route](/Users/yesh/code/personal/scotty/ui/src/routes/s.$sessionId.tsx:59) and [router](/Users/yesh/code/personal/scotty/ui/src/router.tsx:8) configure no remount identity. The installed router's [implementation](/Users/yesh/code/personal/scotty/node_modules/@tanstack/react-router/src/Match.tsx:192) supplies no component key without it. The session workspace and live conversation are unkeyed.

[The composer](/Users/yesh/code/personal/scotty/ui/src/components/LiveConversation.tsx:694) keeps draft, attachments, queue intent, and delivery state without a session reset. Its submit/interrupt completions update that state without checking the session that initiated the operation. By contrast, lifecycle controls already have a [request serial and session reset](/Users/yesh/code/personal/scotty/ui/src/routes/s.$sessionId.tsx:621).

**Target:** an explicit keyed session scope, with session-owned conversation/composer state and generation-checked asynchronous completions. Share the conversation snapshot with Summary instead of independently polling it in [SessionWorkbench](/Users/yesh/code/personal/scotty/ui/src/components/SessionWorkbench.tsx:516). Cancellation alone must not imply a server-side mutation was undone.

**Proof:** mounted A-to-B navigation with deferred conversation, image-read, submit, and interrupt responses. B must never receive A's draft, attachments, receipt, or transcript. This pass traced the mounted component identity path but did not run that browser scenario.

### 4. The lab's most important failure scenarios are placeholders — high-priority proof gap

[Requested faults](/Users/yesh/code/personal/scotty/scripts/lab/scotty-lab.ts:499) return `not-available`. [Runtime-loss and hard-cap scenarios](/Users/yesh/code/personal/scotty/scripts/lab/scotty-lab.ts:925) do the same even without a requested fault. Provider snapshots are initialized as unavailable in [the evidence manifest](/Users/yesh/code/personal/scotty/scripts/lab/scotty-lab.mjs:158). Actor authority and journal snapshots do have a real recording path; do not discard that work.

**Target:** extend the existing lab and actor harness with named failure scenarios and actual observations. Deterministic controls belong in test/local adapters, not an unrestricted production fault endpoint. Native runtime and deployed lanes must report their own evidence separately.

`test:all` does not run local-live or deployed scenarios, which is a reasonable separation of cost and authority. The important missing guarantee is an explicit required proof matrix. CI already has path-gated container-image and native Codex checks in [ci.yml](/Users/yesh/code/personal/scotty/.github/workflows/ci.yml:63); it is inaccurate to describe all current CI as simulated proof.

### 5. Persistent collection growth and access patterns need an explicit data model — P2, confirmed structure; capacity failures not measured

| State owner           | Current shape                                                                                                                                                                                                                                                            | Improvement                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential Registry   | One authority record containing unbounded credentials, versions, grants, and issued-session arrays ([schema](/Users/yesh/code/personal/scotty/worker/src/credentials/contracts.ts:300), [adapter](/Users/yesh/code/personal/scotty/worker/src/credentials/store.ts:110)) | Key credentials/versions/grants by their identities; index by session and credential; make grant/replay tombstone retention explicit. Preserve encryption and release semantics. |
| Hatch                 | Permits are bounded; active request records are not ([admission](/Users/yesh/code/personal/scotty/worker/src/hatch/store.ts:935))                                                                                                                                        | Bound simultaneous admission and encoded state; store requests by identity if they need independent expiry/settlement. Reject overload before mutating authority.                |
| Repository registry   | Append to an array and rewrite the full record ([store](/Users/yesh/code/personal/scotty/worker/src/repos/installation-store.ts:175))                                                                                                                                    | Canonical repository-keyed entries and explicit count/byte budgets; bound branch text at its boundary.                                                                           |
| Runner registry       | Whole-record runner array ([registry](/Users/yesh/code/personal/scotty/worker/src/runner/registry.ts:23))                                                                                                                                                                | Key by normalized runner identity; explicit registration limits and removal semantics. Lower urgency while runner-backed creation remains disabled.                              |
| Session journal       | Immutable key per commit; diagnostics reads only the latest 256 ([store](/Users/yesh/code/personal/scotty/worker/src/session/store.ts:242))                                                                                                                              | Define retention/archive policy and storage budget. A bounded diagnostic read is not bounded retention. Do not delete recovery/audit evidence merely to reduce line count.       |
| List/stat projections | Scan every page, fetch each key, collect and sort; per-page concurrency is unbounded ([reader](/Users/yesh/code/personal/scotty/worker/src/shared/projection-list.ts:21), [stats](/Users/yesh/code/personal/scotty/worker/src/projections/stats.ts:79))                  | Bounded concurrency, cursor-based queries, and purpose-built aggregation/indexes where needed. Stop recomputing all historical creation statistics for every read.               |

This does not establish a need for a separate database service. Use the existing authoritative DO storage with keyed records, or DO SQLite tables where indexes/constraints/querying materially simplify the owner. Small bounded aggregates can remain single records. R2 remains the home for large immutable data. Decide retention and idempotency horizons together: deleting a receipt can turn a retry into a new mutation.

Other candidates worth proving: expiration time is sampled before transaction admission in [Auth](/Users/yesh/code/personal/scotty/worker/src/auth/registry.ts:377) and similar stores; controlled queueing across expiry should establish the intended semantics. KV publications have no actor revision or centralized publisher, so delayed writes can regress displayed state. Neither candidate was reproduced against Cloudflare in this pass.

### 6. Pi receipt eviction permits duplicate dispatch — P1 contract gap, reproduced through the supervisor

[The supervisor](/Users/yesh/code/personal/scotty/worker/container/scotty-pi-session.mjs:137) retains only 200 receipts. Its [command handler](/Users/yesh/code/personal/scotty/worker/container/scotty-pi-session.mjs:493) dispatches any ID absent from receipts and in-flight commands. An isolated [supervisor reproducer](/tmp/pi-eviction-proof.mjs) submitted one command, 201 later commands, and the original again in the same epoch. Both original submissions returned 202/accepted; the child saw that command ID twice, with 203 total dispatches.

This ran the actual Node supervisor with a scripted Pi child and synthetic transport token. It did not exercise a deployed Worker or real Pi. The outer Worker still enforces revision checks and holds its control gate through command relay; the missing second revision authority inside the child is not itself a bug. The reproduced problem is the receipt window. No documented 200-command idempotency horizon was found.

**Target:** choose explicit command identity and retention semantics. An ordered command sequence with a retained lower bound can reject old requests; alternatively use durable receipts with a declared replay horizon. A finite cache of arbitrary UUIDs cannot forget an ID and still distinguish its replay from a new command. Preserve the distinction between accepted, rejected, unknown, and expired outcomes across process loss.

### 7. Runtime history/export and failed-save state need clearer limits — P2 structure/policy work

[Codex saved history](/Users/yesh/code/personal/scotty/worker/src/agent/codex/persistence-format.ts:24) and [rollout export](/Users/yesh/code/personal/scotty/worker/src/agent/codex/persistence.ts:30) lack aggregate file/count/byte budgets. Runtime history and operation collections grow for the generation. Establish export limits before allocation, stream large native artifacts where appropriate, and preserve transcript completeness explicitly. Do not silently truncate data required to resume or fence retries.

[Save](/Users/yesh/code/personal/scotty/worker/src/agent/codex/runtime.ts:600) is cached and sets `saving` before interrupting/stopping/exporting. Early failure leaves subsequent mutation admission closed. This is not a falsely healthy runtime: [snapshot readiness](/Users/yesh/code/personal/scotty/worker/src/agent/codex/runtime.ts:313) includes `!saving`. Replace the loose boolean/failure combination with explicit saving/saved/save-failed lifecycle state and define reconciliation or shutdown for each failure point. Resetting it to ready blindly would be unsafe after partial stop/export.

### 8. A committed create can become an HTTP failure because statistics publication fails — P2, source-confirmed

[Public create](/Users/yesh/code/personal/scotty/worker/src/index.ts:1823) creates the session, then awaits the non-authoritative statistics write. [Internal peer create](/Users/yesh/code/personal/scotty/worker/src/session/object.ts:5043) repeats that workflow. Statistics failure can therefore reject the request after the session exists. Idempotency can reconcile a retry using the same key; it does not make the initial result truthful or guarantee that a caller without a retained key will avoid duplication.

**Target:** one application create operation with an authoritative result and explicitly pending/retryable projection work. Put statistics/repository follow-up ownership there, with observable repair. Public and peer routes should adapt that result rather than each inventing its own post-commit workflow.

## Structural extraction map

### Additional CLI and deployment findings

- **P2, typed recovery gap:** [session creation recovery](/Users/yesh/code/personal/scotty/cli/src/dependencies.ts:329) extracts the existing session ID using a [regular expression over error prose](/Users/yesh/code/personal/scotty/cli/src/pure.ts:146). Changing the message can disable reconciliation and clear the pending idempotency key. Put the existing session identity and conflict reason in a shared error schema; verify recovery with arbitrary human-readable prose. No current server/message mismatch was reproduced.
- **P2, incomplete deployment precondition:** [the production secret check](/Users/yesh/code/personal/scotty/scripts/release/deploy-production.mjs:768) verifies only the wrapping key, while [the stack's required list](/Users/yesh/code/personal/scotty/infra/cloudflare-stack.ts:27) also includes `SCOTTY_TOKEN`. This check cannot establish that root bearer/recovery authority is available. Derive the check from one required-binding contract and validate root authentication in the appropriate canary. The audit did not establish that deployment itself removes a token or that the deployed token is missing.
- **P2, duplicated deployment authority:** [release resource naming](/Users/yesh/code/personal/scotty/scripts/release/deploy-production.mjs:823) repeats [installation naming](/Users/yesh/code/personal/scotty/infra/installation.ts:44); release confirmation text independently repeats the stack's confirmation builder. Share serializable topology and deployment policy, with entrypoint-level decision checks. Drift is a future risk, not a demonstrated current mismatch.
- **P2, path-dependent packaging gap:** [the archive manifest](/Users/yesh/code/personal/scotty/cli/src/deployment-packaging.ts:19) includes the maintainer deploy runner but omits its [directly invoked image/account helper](/Users/yesh/code/personal/scotty/scripts/release/deploy-production.mjs:974). Either exclude that runner from the standalone artifact contract or package its executable dependency closure. Prove the supported entrypoint from an unpacked archive. This does not establish that the ordinary standalone CLI deployment path is broken.

Existing deployment locks, plan/account fences, digest-pinned image checks, atomic private-file writes, and post-failure rollout handling are useful foundations. Consolidation should preserve their claims while removing duplicated policy.

### File and responsibility inventory

Line counts are signals, not acceptance criteria. The inventory covers tracked TS/TSX/JS/MJS/Python/shell files, excluding vendor, work, docs, hidden paths, and generated/public assets: 190 test files / 73,989 lines; 318 other files / 91,303 lines. Fixtures and support files are included in those categories.

| Concentration                                                |                     Lines | Cohesive target                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/src/session/object.ts`                               |                     6,728 | Native Sandbox host adapter and composition root; separate lifecycle application commands, conversation control, Hatch exposure, evidence workflow, internal peer API, and alarm coordination. Keep one actor/storage owner. |
| `cli/src/commands.ts`                                        |                     2,919 | Command families for installation, session, identity, resources, and runner; handlers call application services. Root grammar only composes them.                                                                            |
| `scripts/lab/scotty-lab.ts`                                  |                     2,129 | Lab resource lifecycle, scenario registry/drivers, semantic observations, evidence output, and command grammar. The existing `.mjs` host helpers are not automatically a duplicate implementation.                           |
| `worker/src/index.ts`                                        |                     2,044 | HTTP route groups plus shared application operations and admission/error policy. Public and internal peer routes call the same operations.                                                                                   |
| `cli/src/installation-deployment.ts`                         |                     1,733 | Deployment planning, provider application, session safety, rollout settlement, and local installation bookkeeping as explicit stages.                                                                                        |
| `worker/src/evidence/store.ts`                               |                     1,423 | Admission/lease transitions, artifact accounting, preview admission, and retention; preserve atomic actor/evidence boundaries.                                                                                               |
| `session-actor/transitions/backup-lifecycle-sandbox.ts`      |                     1,398 | Backup preparation/confirmation, runtime quiesce, restore/readiness, and provider reconciliation behind narrow ports.                                                                                                        |
| `worker/container/pi-packages/sources/scotty-hatch/index.ts` |                     1,392 | Extension registration, process supervision, restoration, and tool protocol; keep container process authority distinct from session authority.                                                                               |
| `worker/src/auth/registry.ts`                                |                     1,328 | Bounded ownership, client, pairing, transfer, recovery, and handoff transitions sharing one transaction owner.                                                                                                               |
| `scripts/release/deploy-production.mjs`                      |                     1,241 | Maintainer policy/approval wrapper around the same deployment service used by the CLI.                                                                                                                                       |
| `worker/src/hatch/store.ts`                                  |                     1,150 | Hatch lifecycle plus bounded permit/request admission and expiry.                                                                                                                                                            |
| `worker/src/agent/codex/session.ts`                          |                     1,131 | RPC request ownership, turn/thread tracking, tool dispatch, and shutdown; resource scopes stay explicit.                                                                                                                     |
| `worker/src/runner/transport.ts`                             |                     1,112 | Registration/connection state, command receipts, heartbeat/probes, terminal streams. Preserve existing bounds.                                                                                                               |
| `worker/src/session-actor/reducer.ts`                        |                     1,089 | A deliberate central state machine is reasonable. Extract invariant helpers and per-transition decisions only where that makes the state graph clearer.                                                                      |
| UI workbench / settings / live conversation / session route  | 1,009 / 1,003 / 959 / 924 | Session-scoped data ownership and feature components; keep styles/views separate from mutation and polling lifecycles.                                                                                                       |

The 2,044-line session test harness and 5,290-line route suite mirror the wide host boundary. Extract production capabilities first, then give each capability a small fixture/driver. Merely moving methods into files that still take the entire Sandbox object preserves the coupling.

Move public wire schemas into `protocol/` and derive their types there. [Worker session schemas](/Users/yesh/code/personal/scotty/worker/src/ui/session-view.ts:8) and [browser manual decoding](/Users/yesh/code/personal/scotty/ui/src/data/session-reader.ts:104) currently maintain the same contract independently. Preserve client-specific view models only when they actually transform the wire data.

## Verification architecture

Extend the existing tools; do not build another general testing framework. Use a typed scenario registry with stable scenario names, deterministic controls, independent semantic assertions, and a shared evidence format. Keep different drivers for pure state decisions, production adapters, local native runtime, and deployed runtime.

Controls needed: deterministic clock and IDs; explicit alarm queue; delayed provider responses; failure before dispatch, after dispatch, and after commit; durable-state reconstruction; stale/duplicate callbacks; observable cleanup. A fake provider must implement provider behavior only, never a second copy of the actor's lifecycle decisions. Concurrency proof needs controlled interleavings, not just random sequential commands.

Each run should emit `scenario`, `seed`, source revision and dirty status, `proofTier`, real entrypoint, assertions, journal/state references, runtime/provider evidence availability, and cleanup outcome. Distinguish `passed`, `failed`, `not-available`, and `not-run`. A missing observation cannot count as proof. Keep output concise for agents, with detailed artifacts on failure.

| Scenario family                        | Required claim                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Create reservation interruption/replay | Scheduled cap, admitted authority, and reserved intent have the same generation/deadline.                                   |
| Duplicate or stale command             | At most one admitted effect for the declared replay horizon; stale revision/nonce/generation cannot mutate state.           |
| Checkpoint / sleep / resume            | Confirmed backup precedes sleeping; restore uses that backup; new runtime generation fences late callbacks.                 |
| Provider acted, response lost          | Reconciliation observes outcome before redispatch; no invented success.                                                     |
| Hard cap / runtime loss                | Matching and stale alarms, competing provider completion, restart, and runtime destruction have explicit terminal outcomes. |
| Vaporize                               | Retry ownership survives until all owned resources are confirmed absent.                                                    |
| Deployment admission                   | Complete membership plus provider reconciliation; create/resume cannot bypass an active deployment fence.                   |
| Browser A-to-B navigation              | No draft, attachment, response, or transcript crosses session identity.                                                     |
| Storage growth / expiry                | Count and byte budgets hold; failed writes preserve prior state; expiry semantics hold across queued transactions.          |
| Credential isolation                   | Canary credentials do not appear in container material, public responses, artifacts, logs, or deployment state.             |

### What to keep, replace, and remove

- **Keep:** reducer, atomic storage, command race, restart, production adapter, credential, parser, and protocol boundary tests with substantive assertions. A short pure test is often the cheapest strong proof.
- **Consolidate:** repeated lifecycle setup and assertion boilerplate into named scenario builders and semantic observers. Keep separate claims even when they share setup.
- **Replace:** source-spelling tests such as [deployment guard regex checks](/Users/yesh/code/personal/scotty/scripts/deployment-safety.test.mjs:1307), [scheduled callback regex inventory](/Users/yesh/code/personal/scotty/scripts/deployment-safety.test.mjs:1331), and [UI boundary source checks](/Users/yesh/code/personal/scotty/e2e/tests/protocol-security.test.mjs:33) with executed guard behavior or typed registration where practical. Static secret/artifact absence checks can still be valuable; they prove a different claim.
- **Remove with the obsolete behavior:** acceptance tests that exist solely for old formats or old Worker responses, once the canonical path replaces them. Do not build migration scaffolding solely to keep those tests green.
- **Do not misclassify:** [rejecting malformed/legacy/wrong-session input](/Users/yesh/code/personal/scotty/ui/src/data/session-reader.test.ts:65) is current boundary validation. [Inline chunked-storage values](/Users/yesh/code/personal/scotty/worker/src/session/chunked-storage.ts:81) remain an active encoding, regardless of a test calling them “legacy.” Neither is established junk.

Measure scenario coverage, replayability, production boundary coverage, and time to diagnose a failure. Test count and percentage coverage alone are poor goals. Do not replace many understandable tests with one enormous opaque scenario.

## Delivery order

1. Fix reserved create intent replay and land its controlled interruption/reconstruction proof.
2. Set and implement Pi receipt replay semantics, with the reproduced eviction scenario and process-loss cases.
3. Unify deployment safety and establish authoritative membership/admission fencing, with missing-projection and concurrent-admission scenarios.
4. Introduce keyed browser session scope and one mounted navigation/late-response scenario; centralize session wire schemas.
5. Turn the existing lifecycle harness/lab into the scenario/evidence system above. Implement the currently unavailable fault paths and retain native/deployed proof tiers. Extract the Sandbox host responsibilities one capability at a time; route public/internal operations through shared application commands, including create-result and projection ownership.
6. Replace whole-record growing registries where justified, adding explicit capacity, retention, expiry, and replay policies. Keep each state owner authoritative.
7. Converge CLI/release deployment stages and narrow CLI dependency surfaces; fix structured conflict recovery and packaging closure; remove superseded paths and their obsolete tests.

Each slice must leave a usable product path and an executable proof command. Sol medium is appropriate for implementation once the slice's ownership, intended behavior, and validation are settled. No compatibility layer is required solely to preserve the current design.

## Evidence and limitations

The parent ran five focused Vitest suites: `store-atomicity`, `native-storage-adapter`, `command-races`, `restart`, and `installation-container-settlement`: **51/51 passed**. Scouts additionally reported passing targeted reducer/lab/canary, route, auth, runner/config/credential, and static/helper checks, plus **36/36** deployment-safety checks; these overlap and are not presented as one unique test total.

The create replay reproducer exposed a real controller/reducer mismatch despite those green suites. Existing create-controller tests use a [stub actor returning prebuilt authority](/Users/yesh/code/personal/scotty/worker/test/session-actor/create-controller.test.ts:206); that seam does not by itself check that the admitted cap equals the armed cap.

The runtime scout also reproduced Pi receipt eviction through the actual supervisor with a scripted child. Neither reproducer changes production code or proves deployed behavior.

No full repository gate, mounted browser scenario, local-live lab, image build, or deployed canary was run by this review. Semantic review was risk-based across domains, not a proof that every line is correct. Capacity failure thresholds and Cloudflare interleavings remain to be measured in their respective proof tiers.
