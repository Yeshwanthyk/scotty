# OpenClaw cloud-agent lifecycle vs Scotty

**Research-only comparison.** This review uses the supplied OpenClaw archive at
`/tmp/openclaw-provenance.8W7wWd/openclaw-openclaw-1482bf1`, identified by the
requested SHA `1482bf19a763acc59470faf3425b3cf559018b2c`, and Scotty at SHA
`709f04e3c8720021fe1073ce8ffd61cfa712ccb2`. The archive has no Git metadata;
the OpenClaw SHA is therefore provenance supplied for the snapshot, not
independently verified here. `~/.opensrc` was not used. No tests, deployment,
credential, or reference-source changes were performed.

## Executive judgment

OpenClaw has the more complete **multi-agent and cloud-turn control plane**:
durable subagent/task records, cloud placement and turn claims, a closed worker
WebSocket protocol, reconnect-aware client state, and restart recovery. The
strongest reusable ideas are exact ownership claims, fencing epochs, durable
idempotency, replay cursors, and separating admission from completion.

Scotty has the stronger and more explicit **session authority and secret
boundary** for its implemented surface. The Session Sandbox Durable Object and
actor journal own lifecycle state, leases, generations, backups, hard caps, and
unknown provider outcomes. The Codex adapter persists managed handles/sentinels
rather than real credentials and deliberately refuses runner-backed creation.
That refusal is a lifecycle proof gate, not a missing validation detail.

The main gap is therefore not “add OpenClaw’s worker code.” It is an unimplemented
product slice: native Pi/Codex RPC over a remote runner, durable cloud turn and
child-agent ownership, and deployed recovery proof. Until that slice exists,
Scotty should keep its current cloudflare-only Codex creation path and treat the
runner as a runtime-operation transport, not an agent-session backend.

## Evidence grading

- **[D] Documented:** behavior stated in a checked-in document.
- **[I] Implemented:** behavior visible in checked-in source.
- **[T] Test present:** a checked-in test exercises the claim. This review did not
  run the test suite, so [T] does not mean a fresh pass.
- A claim can have more than one grade. Docs are not treated as implementation
  proof, and tests are not treated as deployed proof.

## Comparison by lifecycle concern

| Concern                          | OpenClaw evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Scotty evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Assessment / implication                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime ownership**            | [I] A worker turn is admitted against a placement claim and run ID; the launcher retains the claim through setup and execution, and releases or reconciles it according to whether handoff occurred (`src/gateway/worker-environments/worker-turn-launcher.ts:L147-L180`, `L238-L359`, `L392-L525`). [I] Execution rechecks attached environment, owner epoch, bundle, session, and capability before launch (`src/gateway/worker-environments/worker-turn-execution.ts:L54-L91`, `L207-L225`). [T] Tests cover claim admission and retaining an active placement after failure (`src/gateway/worker-environments/worker-turn-launcher-claim-admission.test.ts:L388-L455`, `L725-L860`).                                                                                                    | [I] The Session actor is the lifecycle authority; it commits a decision, runs effect intents, consumes observations, and loops until settled (`worker/src/session-actor/actor.ts:L160-L230`). The lifecycle controller arms Resume’s hard cap before actor handling and classifies only after rereading authority (`worker/src/session-actor/lifecycle-controller.ts:L119-L148`). [D] Runtime process/native IDs are projections, not Session authority (`docs/codex-runtime-recovery.md:L1-L13`).                                                                                                           | Scotty’s single-session ownership is sound. It does not yet have an implemented remote agent-turn owner equivalent to OpenClaw’s worker claim.                                                                                                          |
| **Subagents**                    | [D] Subagent rows survive restart with original task context; child recovery precedes a yielded parent wake (`docs/gateway/restart-recovery.md:L461-L487`). [I] Spawn prepares child session/context/attachments, builds a launch, records lineage, and makes accepted-run ownership explicit (`src/agents/subagents/spawn/subagent-spawn.ts:L172-L235`, `L329-L455`). [I] Registration persists queued/accepted launch identity, requester turn, lifecycle generation, cleanup, delivery, and collector state (`src/agents/subagents/registry/subagent-registry.types.ts:L49-L69`, `L145-L215`). [T] Interrupted recovery is persisted before task projection; late provider/yield activity is rejected (`src/agents/subagents/registry/subagent-registry-lifecycle.test.ts:L1869-L1911`). | [I] Scotty’s container session control can create another same-repository Session only after the source is warm and is restricted to the cloudflare provider (`worker/src/session/object.ts:L4916-L4958`, `L4981-L5009`). [I/T] Runner creation is rejected before actor or metadata reservation (`worker/src/session-actor/create-controller.ts:L381-L383`; `worker/test/session/session-create.test.ts:L600-L616`).                                                                                                                                                                                        | Scotty has session orchestration, not a delegated child-agent registry, requester wake protocol, or subagent recovery implementation. This is the largest functional gap for “cloud agent” parity.                                                      |
| **Long-running/background jobs** | [D] `exec` background sessions retain output, support poll/write/kill, notify-on-exit, and remain scoped to an agent (`docs/gateway/background-process.md:L9-L41`, `L113-L147`). [I] The process handle is a live in-memory session with bounded output and a promise (`src/agents/bash-tools.exec-runtime.ts:L158-L167`, `L697-L729`). [D] These process handles are not on disk and are lost on process restart; separate SQLite-backed background task records are reconciled on boot (`docs/gateway/background-process.md:L63-L84`, `L130-L139`; `docs/gateway/restart-recovery.md:L498-L503`).                                                                                                                                                                                         | [I] Codex follow-ups are a durable DO queue with a five-second alarm; the queue records the generation/thread attempt before sending and confirms only after revalidation (`worker/src/session/object.ts:L5828-L5837`, `L5839-L5917`). [I/T] Hatch is actor-owned warm work and its service is closed on sleep/restored on Resume (`worker/src/session-actor/transitions/warm-work.ts:L78-L99`, `L157-L210`; `worker/test/session/session-actor-lifecycle.test.ts:L1205-L1272`).                                                                                                                             | Scotty has durable follow-up and lifecycle-work patterns, but no generic durable cloud-agent job/task record. Do not mistake a process handle or a live container for job authority.                                                                    |
| **Cloud placement and RPC**      | [D] Cloud dispatch creates/provisions a worker, sends the first task after placement, and supports OpenClaw `worker-turn` versus Codex `remote-exec` (`docs/gateway/cloud-workers/dispatching-a-session.md:L9-L25`, `L29-L42`). [D/I] The closed worker protocol is allowlisted, bound to environment/build/owner epoch/RPC version/expiry/session, and treats connection success as distinct from action success (`docs/gateway/protocol/handshake.md:L216-L247`).                                                                                                                                                                                                                                                                                                                         | [I] Scotty’s public runner operation union is only Ensure/Inspect/Exec/Stop/Remove; its separate HTTP stream protocol has credit and cancellation frames (`protocol/runner.ts:L25-L57`, `L102-L148`). [I] Runner socket attachments survive hibernation, but pending RPC correlations are activation-local and must be retried by durable operation identity (`worker/src/runner/object.ts:L41-L70`).                                                                                                                                                                                                        | The runner transport is bounded and useful, but it is not native Pi/Codex agent RPC. Enabling runner session creation would change the lifecycle contract and requires the proof gate in project instructions.                                          |
| **Transcript/event transport**   | [I] Worker requests are revalidated for placement, credential hash, epoch, attachment, and terminal fences; transcript commits run under an environment lock and assert current before and after the adapter (`src/gateway/worker-environments/worker-turn-rpc.ts:L310-L417`). [I] Terminal live-event ACKs become a durable placement fence; later non-replay traffic is rejected (`src/gateway/worker-environments/worker-turn-rpc.ts:L512-L579`). [T] Tests cover epoch/credential fencing and sequenced replays (`src/gateway/worker-environments/worker-turn-rpc.test.ts:L45-L73`, `L749-L817`).                                                                                                                                                                                       | [I] The Codex runtime validates generation/thread/turn, uses a private HTTP bridge, and separates `accepted`, `rejected`, and `ambiguous` outcomes (`worker/src/agent/codex/runtime.ts:L23-L70`, `L124-L144`). [I] Scotty checks container incarnation and Session authority before and after conversation reads, sends, and interrupts (`worker/src/session/object.ts:L5763-L5815`, `L5972-L6047`).                                                                                                                                                                                                         | Both separate admission from terminal truth. OpenClaw has a remote sequenced event channel; Scotty has a local private bridge plus DO revalidation.                                                                                                     |
| **Disconnect/reconnect**         | [I] The Gateway client has per-socket generations, stale-frame rejection, pending-request flushing, challenge/connect timers, gap detection, and policy-controlled exponential reconnect (`packages/gateway-client/src/protocol-client.ts:L42-L123`, `L184-L238`, `L382-L503`, `L513-L555`). [T] Tests prove fresh sequence baselines, retired-socket rejection, handshake timeout reconnect, and retirement of async connect preparation (`packages/gateway-client/src/protocol-client.sequence.test.ts:L51-L110`, `packages/gateway-client/src/protocol-client.handshake.test.ts:L227-L245`, `L355-L378`).                                                                                                                                                                                | [I/T] Runner transport probes the exact attachment, drops pending work on replacement/close, and allows a same-identity retry; the CLI supervisor reconnects after missed probes (`worker/src/runner/transport.ts:L178-L258`, `L262-L289`; `worker/test/runner/runner-transport.test.ts:L210-L300`; `cli/effect-test/runner-link.test.ts:L374-L405`). [I/T] Codex HTTP admission loss is reported as unknown and the same message ID is reconciled through the DO queue, not blindly replayed (`worker/src/session/object.ts:L5999-L6070`; `worker/test/session/session-codex-follow-up.test.ts:L204-L233`). | Scotty’s runner reconnect is transport-level. Its Codex client recovery is receipt/inspection-based, not a resumable public event/RPC session. A future remote agent protocol needs both layers.                                                        |
| **Cancellation**                 | [I] Flow cancellation first verifies authoritative child backing, writes cancellation intent, cancels children, waits for remaining active tasks, then terminalizes the flow (`src/tasks/task-executor.ts:L473-L588`). [I] Detached recovery hooks are bounded/best-effort and invalid or slow hooks proceed to mark-lost (`src/tasks/detached-task-runtime.ts:L149-L185`). [T] Tests keep accepted cancellation canonical over a late provider result (`src/agents/subagents/registry/subagent-registry-lifecycle.test.ts:L2829-L2893`).                                                                                                                                                                                                                                                   | [I] Interrupt requires the observed Session revision, current incarnation, exact thread and running turn; after native interrupt it rereads authority and returns stale if the Session changed (`worker/src/session/object.ts:L6074-L6222`). [T] Tests prove no native contact for stale revision/incarnation and stale-after-dispatch behavior (`worker/test/session/session-codex-interrupt.test.ts:L99-L190`).                                                                                                                                                                                            | Scotty’s cancellation semantics are appropriately fail-closed. It lacks OpenClaw’s parent/child cancellation graph because it has no subagent graph.                                                                                                    |
| **Turn/session durability**      | [D] Main turns, subagents, task rows, deliveries, and restart sentinels are durable; auto-resume has bounded charged attempts and durable dispatch IDs (`docs/gateway/restart-recovery.md:L10-L52`, `L344-L404`). [I] Subagent records include recovery receipts, lifecycle generations, terminal ownership, requester wake state, and launch replay identity (`src/agents/subagents/registry/subagent-registry.types.ts:L49-L123`, `L145-L215`).                                                                                                                                                                                                                                                                                                                                           | [I] Actor storage uses DO transactions, immutable journal sequence/tail, revision, decoded authority, and a durable follow-up key (`worker/src/session/store.ts:L225-L279`, `L320-L324`). [D/T] Sleep requires a confirmed immutable backup and Resume requires the same native thread; saved failed turns are never automatically replayed (`docs/codex-runtime-recovery.md:L5-L13`, `L19`; `worker/src/agent/codex/runtime.ts:L566-L629`).                                                                                                                                                                 | Scotty’s Session durability is stronger than its runtime’s durability: runtime state is saved during lifecycle operations, not a general durable live-turn journal. This is deliberate because ambiguous provider work must not be replayed as success. |
| **Lifecycle concurrency**        | [I] Worker placement records encode states from requested through active/draining/reconciling/reclaimed/failed, with a turn claim containing session, run, claim, generation, and owner (`src/gateway/worker-environments/placement-record.ts:L21-L67`, `L191-L244`). [I] Subagent registry has separate lifecycle, requester-settle, kill, cleanup, and scheduler ownership (`src/agents/subagents/registry/subagent-registry.types.ts:L101-L215`).                                                                                                                                                                                                                                                                                                                                        | [I] `SessionControlGate` serializes Session operations and releases on both success and failure; actor transactions use the same gate (`worker/src/session/store.ts:L40-L62`, `L265-L318`). [T] Overlapping lifecycle requests are rejected without changing the current transition, and a different transition kind is not recovered (`worker/test/session/session-actor-lifecycle.test.ts:L981-L1040`).                                                                                                                                                                                                    | Scotty already has the correct one-operation lease shape for a Session. Do not add parallel in-memory ownership around it.                                                                                                                              |
| **Observability**                | [D] Restart recovery exposes a crash-loop breaker, attempt budget, Prometheus counters/gauge, recovery-specific logs, and a verification distinction between execution recovery and reply delivery (`docs/gateway/restart-recovery.md:L537-L596`, `L598-L609`). [D/I] Session observer digests are run-scoped and gated by exact active run IDs (`docs/gateway/protocol/rpc-bootstrap-and-events.md:L76-L98`).                                                                                                                                                                                                                                                                                                                                                                              | [I] Scotty keeps an actor diagnostic journal and emits explicit unknown runtime-observation logs; lifecycle callbacks are fed back through the actor (`worker/src/session/store.ts:L281-L300`; `worker/src/session/object.ts:L6473-L6522`). [T] Lifecycle tests cover recovery, stale fences, and unknown scheduling outcomes (`worker/test/session/session-actor-lifecycle.test.ts:L634-L676`, `L869-L930`).                                                                                                                                                                                                | Scotty has good forensic authority, but a comparable published recovery metric/event vocabulary was not found in the reviewed scope. Treat this as an observability gap to verify, not proof that no metric exists elsewhere.                           |

## Ranked actionable gaps

### Future runner prerequisite — Native remote agent lifecycle is not implemented

Scotty’s runner creation path is deliberately rejected before authority reservation,
and the runner protocol only carries runtime operations. The missing vertical slice
is: native Pi/Codex RPC transport, remote process/session admission, transcript and
live-event sequencing, exact turn claims, cancellation, placement teardown, and
deployed lifecycle proof. Keep runner-backed session creation disabled until all of
those exist. Evidence: `worker/src/session-actor/create-controller.ts:L381-L383`,
`worker/test/session/session-create.test.ts:L600-L616`, `protocol/runner.ts:L25-L57`,
and OpenClaw’s corresponding closed turn surface at
`src/gateway/worker-environments/worker-turn-rpc.ts:L310-L417`.

### Future subagent prerequisite — Add durable cloud-agent/job ownership

If Scotty gains child agents or cloud jobs, define a DO-owned record for parent
attempt, child/session identity, task identity, owner generation, placement claim,
requester delivery obligation, cancellation intent, cleanup status, and terminal
outcome. Add a reconciler that can distinguish “never admitted,” “accepted but
unknown,” “terminal,” and “cleanup uncertain.” OpenClaw’s useful reference is the
subagent record shape and restart path, not its process-global registry:
`src/agents/subagents/registry/subagent-registry.types.ts:L145-L215` and
`src/agents/subagents/registry/subagent-registry.ts:L248-L378`.

### P1 — Define a public reconnect contract for Scotty session clients

The current runner link has probes/reconnect and the Codex bridge has same-ID
reconciliation, but Scotty has no public, resumable agent event stream equivalent to
OpenClaw’s subscribe/snapshot/gap contract. A future contract should specify
session/run identity, monotone cursors, stale-generation behavior, admission
receipts, terminal receipts, reconnect catch-up, and what remains unknown. Preserve
Scotty’s existing HTTP routes, error envelopes, and “inspect before retry” behavior.
OpenClaw’s documented shape is `docs/gateway/protocol/rpc-bootstrap-and-events.md:L16-L29`
and `docs/gateway/protocol/rpc-session-control.md:L31-L45`; its client fencing is
`packages/gateway-client/src/protocol-client.ts:L382-L503`.

### P1 — Prove descendant cleanup, not just transport disconnect

A remote agent/job feature must retain placement ownership until the exact process
and workspace descendants are confirmed stopped or a typed reconciliation state is
published. OpenClaw explicitly keeps a worker ownership record for unconfirmed
cleanup (`docs/gateway/background-process.md:L77-L100`, `L132-L138`). Scotty’s
existing actor and backup transitions provide the right authority boundary; they do
not yet prove remote runner descendant cleanup for agent sessions.

### P2 — Establish recovery metrics and run-scoped lifecycle events

Expose bounded counts and ages for recovery, unknown outcomes, cancellation
reconciliation, placement fencing, cleanup uncertainty, and pending requester
settlement. Keep the actor journal authoritative and publish only sanitized
projections. OpenClaw’s metric/log split is a useful checklist
(`docs/gateway/restart-recovery.md:L584-L609`); Scotty’s current diagnostic journal and
unknown-observation logging are the source-side foundation
(`worker/src/session/store.ts:L281-L300`, `worker/src/session/object.ts:L6495-L6519`).

### P3 — Add quotas only when the child-agent product exists

OpenClaw has scheduler slots, collector launches, spawn depth, and requester wake
bookkeeping. Scotty should not import that complexity into the current one-turn
Codex surface. If child concurrency becomes a product requirement, make limits and
admission durable and actor-owned, then add property/contract tests for parent
cancellation, child completion races, replacement run IDs, and restart ordering.

## What not to copy

1. **Do not copy a remote credential projection.** OpenClaw’s worker GitHub binding
   reads `identity.env.GH_TOKEN` and includes the token in a worker launch binding
   (`src/gateway/worker-environments/worker-github-binding.ts:L21-L96`), and the
   cloud worker launch descriptor carries that binding (`src/gateway/worker-environments/worker-turn-execution.ts:L332-L358`).
   This conflicts with Scotty’s invariant that real Codex/GitHub credentials never
   enter container env/files/args/logs/Git/KV/R2/API responses. Scotty must send only
   session-bound sentinels/managed handles and keep the credential registry in its
   owning boundary (`worker/src/credentials/managed.ts:L76-L119`).

2. **Do not copy automatic continuation as proof of safe replay.** OpenClaw resumes
   interrupted turns and reconciles unknown tools with restricted tools
   (`docs/gateway/restart-recovery.md:L344-L385`, `L433-L459`). Scotty must retain
   `ambiguous` provider outcomes, never claim an unknown Codex turn completed, and
   never automatically replay the failed user turn (`docs/codex-runtime-recovery.md:L7-L13`).

3. **Do not make in-memory process handles authoritative.** OpenClaw explicitly loses
   `exec/process` handles on process restart (`docs/gateway/background-process.md:L130-L138`).
   A Scotty cloud job needs a durable DO record plus provider reconciliation; a
   container PID, runner socket, or Effect runtime value is only an observation.

4. **Do not replace Session DO authority with a shared process registry.** OpenClaw’s
   shared SQLite subagent registry is appropriate to its Gateway process, but Scotty
   already assigns authority to the Session Sandbox DO, actor revision, operation
   lease, backup proof, and hard cap (`docs/codex-runtime-recovery.md:L1-L10`; `worker/src/session/store.ts:L265-L279`).
   A registry may be a projection or adapter, never the authority that can mutate a
   session behind the DO.

5. **Do not import the whole Gateway protocol or scope model.** OpenClaw’s public
   Gateway subscribe/list/send/abort surface is broad and has its own compatibility
   contract (`docs/gateway/protocol/rpc-session-control.md:L16-L45`). Scotty must
   preserve its current routes, response envelopes, CLI shapes, browser handoff,
   and credential isolation. Reuse protocol ideas only behind an explicitly scoped
   Scotty contract.

6. **Do not treat kill/close/exit as confirmed cleanup.** OpenClaw’s own docs require
   descendant confirmation and retain uncertainty (`docs/gateway/background-process.md:L90-L111`).
   Scotty should keep the same standard for runner teardown, backup deletion, and
   vaporize, rather than converting a socket close or process signal into success.

## Unknowns and limits

- No OpenClaw or Scotty tests were run. The [T] labels mean test coverage exists in
  the reviewed snapshot, not that it passed in this environment.
- The OpenClaw archive is a filesystem snapshot without Git metadata. The requested
  OpenClaw SHA is recorded above as provenance, but cannot be checked with `git` from
  this archive.
- OpenClaw documentation distinguishes durable background task records from
  in-memory `exec/process` handles. The latter are not restart durable; this review
  did not trace every task-registry adapter or provider implementation.
- Source review cannot establish physical cloud-provider teardown, whether every
  remote descendant has exited, or deployed canary behavior. Those require the
  project’s guarded deployment proof.
- Scotty’s checked-in docs explicitly say deployed backup/resume proof is still
  required (`docs/codex-runtime-recovery.md:L17-L19`). This research did not perform
  that proof.
- The comparison does not establish that Scotty lacks metrics or other adapters
  outside the reviewed paths; it identifies the absence of an equivalent metric/event
  contract in the inspected lifecycle surface.
