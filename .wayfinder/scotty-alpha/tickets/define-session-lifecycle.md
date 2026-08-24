---
title: Define the canonical Session lifecycle
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the authoritative state model
---

## Question

What is the one canonical Session state machine for Create, Warm, Snapshot, Sleep, Resume, failure recovery, hard-cap handling, and Vaporize across Cloudflare and trusted runners, including coordination with the separately owned Publish operation?

## Inherited state contract

Each Session owns its immutable provider, pinned snapshot and repository facts, lifecycle,
operation lease, hard cap, backup handles, runtime epoch, Hatch record, evidence records, and
cleanup retry state. A runtime-generation change revokes old Hatch access. Provider observations
are evidence only. Ambiguous results keep the owning operation open.

## Resolution

Scotty uses four stable Session lifecycle states:

| State | Meaning |
|---|---|
| `provisioning` | The Session record exists, its immutable identity is pinned, and Create has not yet committed the first usable runtime and baseline checkpoint. |
| `warm` | Provider compute, the restored workspace, Session Fork, Pi RPC, and credential broker are usable. Hatch, screenshot, and video capabilities are available but dormant until requested. A client connection and an open Hatch are not required. |
| `stopped` | Session compute and old Hatch access are stopped. The record states why it stopped, the current checkpoint when one exists, and which recovery action is allowed. |
| `gone` | Active Session authority is terminal. No runtime, Fork, Hatch access, Session grant, schedule, active operation, or list projection remains. Only a minimal tombstone and policy-retained backup or evidence references may remain. |

Create is the only transition from no record to `provisioning`. A successful Create moves to
`warm`. Snapshot leaves the Session `warm`. Explicit Sleep, inactivity, hard cap, runtime loss, and
Vaporize move active compute to `stopped`. Resume moves the same Session from `stopped` to `warm`.
Vaporize reaches `gone` from `stopped` only after required absence is proven.

There is no `failed`, `booting`, `resuming`, or `vaporizing` lifecycle state. In-progress work,
failure, provider ambiguity, cleanup progress, and recovery live in the authoritative operation
record. Human views may display labels such as Creating, Snapshotting, Resuming, or Vaporizing from
the stable state plus that operation record.

### Session and operation records

The Session keeps its immutable Session ID, Installation, compute provider, named Runner when
used, deployed snapshot revision and digest, repository, base commit, and Fork identity for its
whole life. Resume never changes them.

Each lifecycle operation records its kind, stable idempotency key, expected Session revision,
lease nonce, phase, provider references, last proven effect, retry state, result, and recovery
action. A stopped record also stores one reason:

- `explicit_sleep`;
- `inactivity`;
- `hard_cap`;
- `runtime_loss`;
- `operation_failure`; or
- `vaporize`.

The allowed recovery action is exactly one of `resume`, `retry`, `cleanup`, or `none`. The UI and
API must show the stopped reason, current operation, current checkpoint, last fresh provider
evidence, and next safe action. Logs do not decide recovery.

Only one lifecycle lease mutates a Session. A second ordinary operation returns conflict rather
than queuing. Hard-cap handling may fence an active operation after one short product-owned grace
period. Vaporize waits for an active operation unless it is proven abandoned, then takes over with
a new nonce. A stale completion can never release the current lease or change Session authority.

### Create

Create has this order:

1. Select the immutable provider, snapshot, repository, and source pins.
2. Arm the first hard-cap deadline.
3. Commit the `provisioning` Session record and Create operation with that deadline.
4. Create or recover the exact Session Fork.
5. Start the selected provider runtime and materialize the pinned setup.
6. Start Pi and prove the provider-neutral Warm contract.
7. Create and atomically commit a baseline checkpoint.
8. Commit `warm`, then publish the rebuildable projection.

Create does not dispatch an initial prompt. Every visible Warm Session therefore has a current
restorable checkpoint. A projection failure does not undo a committed Session. A clear Create
failure records the next recovery action. An ambiguous provider result keeps Create open for
inspection or retry and never reports success.

If hard-cap handling fences Create before the baseline checkpoint commits, Scotty stops provider
compute and moves to `stopped` with no current checkpoint and recovery `retry` or `cleanup`.

### Checkpoints and Snapshot

A checkpoint pairs one exact Artifacts Fork revision with one immutable R2 workspace backup. It
retains all workspace files, including uncommitted and untracked work, Pi Session and worklog state
needed for continuation, and pinned setup and repository metadata. It excludes live processes,
sockets, Hatch permits, runtime memory, and real credential values.

A checkpoint becomes current only after Scotty:

1. revokes old Hatch access and fences capture for the current runtime epoch;
2. stops Pi;
3. synchronizes workspace and Fork state;
4. writes and proves the immutable R2 backup; and
5. atomically commits the backup reference and exact Fork revision to the Session.

Until that commit, the prior checkpoint remains current. Partial backup or Fork state never forms
a checkpoint.

Snapshot acquires the Session lease, creates a checkpoint, restores Pi, restores any desired Hatch
definition under a new generation, and remains `warm`. It reports success only after Warm is
restored. If checkpointing fails, Scotty keeps the prior checkpoint and tries to restore Warm. If
that restoration fails or provider state is ambiguous, the Session becomes `stopped` with the
exact recovery action.

### Sleep and inactivity

Explicit Sleep and inactivity Sleep use the normal checkpoint contract. They commit `stopped`
only after a new checkpoint succeeds and compute is proven stopped. A failed checkpoint keeps the
prior checkpoint and attempts to restore Warm; Scotty does not claim Sleep success from an old
checkpoint.

Accepted terminal input, active Pi work, bounded Session operations, authenticated Hatch use, and
active capture postpone inactivity Sleep. Arbitrary background processes do not. Runtime reports
activity through checked events; the Session stores the authoritative idle deadline. An open but
unused Hatch does not keep compute alive forever.

### Hard cap

The hard cap bounds one provider-compute activation, including provisioning or restoration before
Warm commits. It does not bound the lifetime of the Session or its backup. Create and every
explicit Resume must arm a new fixed deadline before provider mutation. Nothing resumes
automatically.

At the deadline Scotty rejects new work, revokes Hatch and capture access, gives the active
operation one bounded grace period, attempts one final checkpoint, and stops compute. If the
checkpoint succeeds, it becomes current. If it fails, Scotty still stops compute and keeps the
prior current checkpoint, with an explicit warning that newer work may not have been retained. The
Session commits `stopped` with reason `hard_cap`.

When a current checkpoint exists, the same Session may Resume from it. Resume arms a new idle and
mandatory hard-cap deadline, then starts a new runtime epoch and Hatch generation.

### Resume and runtime loss

Resume is allowed only from `stopped`. Before mutation it freshly proves:

- a current complete checkpoint;
- the pinned deployed snapshot and immutable content;
- the Session Fork and pinned repository identity;
- that the original provider route is create-capable; and
- every pinned credential generation, the immutable Session grant, and the current provider-broker binding.

Resume never changes provider or Session identity. It arms the new deadlines before provider
mutation, restores the exact checkpoint, starts Pi, creates a new runtime epoch and Hatch
generation, and commits `warm` only after the Warm contract passes.

A failure before provider mutation leaves the Session `stopped` with the failed operation result.
A partial or ambiguous provider mutation leaves it `stopped` with `retry` or `cleanup`. The prior
checkpoint stays current until Warm commits.

Unexpected ambiguous runtime state stops authority with recovery `retry`. Proven runtime loss with
a current checkpoint stops with recovery `resume`. Proven loss without a usable checkpoint stops
with recovery `none`. Unexpected loss is never described as a clean Sleep.

### Hatch, screenshots, and video

Every provider offered for Session creation must prove Hatch and screenshot/video capture support,
even for backend Sessions that leave those capabilities dormant. A Warm Session does not consume
Hatch or capture resources until requested.

Opening, closing, and starting capture use bounded lease steps. An open Hatch and a long video
recording do not hold the global Session lease. Their live work is pinned to the current runtime
epoch and Hatch generation. Snapshot, Sleep, Resume, hard cap, and Vaporize cancel or fence that
work. Stale results cannot commit.

A screenshot or video is visible only after both its immutable R2 bytes and Session-owned evidence
metadata commit. Interrupted or partial capture is not evidence. Unreferenced uploaded bytes are
orphans for later cleanup.

### Publish coordination

Publish remains a repository operation, not a Session lifecycle state. Publish preparation is
allowed only while `warm`. It takes the Session lease for a bounded step that creates or selects
an exact checkpoint and pins the Fork revision, required-check result, check definition, deployed
snapshot digest, and preparation time. The lease then releases. Later Session work or Resume does
not change that prepared Publish point; publishing newer work requires a new preparation.

An already prepared Publish may finish after the Session stops because it uses the exact checked
Fork revision and needs no new Session compute. Vaporize waits while Publish is open or its GitHub
result is ambiguous. It never deletes the only Fork source while Publish outcome is unknown.

### Vaporize and retained state

Vaporize first revokes Hatch access, capture jobs, and the Session grant; stops provider compute;
and commits the truthful `stopped` boundary with reason `vaporize`. It then resolves or waits for
Publish, removes provider compute, deletes the Session Fork, removes active idempotency and
projection state, and proves required absence. Failure or ambiguity leaves `stopped` plus the
Vaporize operation and cleanup retry authority. Only proven completion commits `gone`.

Bounded backup and evidence references may remain on the `gone` tombstone under the retention
contract. They cannot Resume, authorize compute, recreate a Fork, or recreate the Session.

### Provider parity and proof

Cloudflare and trusted runners implement this same state machine and operation contract. A
connected Runner is not create-capable until it proves checkpoint/restore, repository, credentials,
Hatch, capture, idle Sleep, hard cap, Publish coordination, recovery, and proven deletion. Provider
details may differ behind those boundaries; user-visible lifecycle meaning may not.

Deterministic tests must cover every transition, stale nonce, operation conflict, checkpoint commit
boundary, restart, ambiguous provider result, inactivity race, hard-cap grace and failed final
checkpoint, runtime loss, stale Hatch generation, interrupted capture, Publish/Vaporize race,
projection repair, retained evidence, and orphan cleanup. The guarded deployed canary must prove
the same lifecycle on each offered provider.

## Refined credential contract

A Session grant and its pinned credential generations are immutable until Vaporize. Installation
credential replacement or removal affects future Sessions only. Resume checks the same pinned
generations; it never switches to a newer one. Codex OAuth refresh may maintain a pinned generation.
Vaporize ends the grant and releases generation references after Publish settles.

## Refined Runner retention boundary

Runner workspaces, checkpoints, receipts, and recovery fences never persist real credentials,
provider tokens, grants, or sentinels. The broker may hold the current-epoch Session sentinel in
memory. Unresolved correctness records survive without age expiry; acknowledged terminal receipts
retain at most seven days or 250 records per Runner.
