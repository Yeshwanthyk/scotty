---
title: Define the Mirror, Fork, and Publish state machine
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the canonical Session lifecycle
  - Define the credential and login state machine
  - Choose the GitHub–Artifacts bridge and Session Git boundary
---

## Question

What states and guarded transitions control GitHub-to-Mirror Sync, Session Fork creation, Session Git access, validation, Publish to a GitHub pull request, retry, conflict, cleanup, and recovery from ambiguous provider results?

## Inherited lifecycle contract

Publish preparation runs only for a Warm Session. It pins one exact checked checkpoint and then
releases the Session lease. Later Session work cannot change that Publish point. An already
prepared Publish may finish after the Session stops. Vaporize waits for a terminal Publish result
before deleting the Fork. Config also serializes one exact-commit Mirror refresh per repository and
base ref, activates only verified commits, recovers one deterministic Session Fork, and retains the
Installation Mirror until explicit unregister or Installation deletion. Checkpoints push existing
commits but do not create hidden Git commits.

## Refined credential contract

Each Session pins the `github` generation selected at Create. Publish uses that exact generation;
Installation replacement affects future Sessions only. External expiry blocks Publish and never
switches the Session to a newer generation. Provider-local Git uses the Session sentinel and
Artifacts operation tokens, not the GitHub generation.

## Resolution

Scotty uses small authoritative records and operation overlays. It does not use one large Mirror,
Fork, or Publish lifecycle enum. Failures, conflicts, retries, and ambiguous provider results belong
to the operation that observed them. They are not durable repository states.

### Owned records

The installation Config object owns one repository control record. It contains the immutable
GitHub repository ID, current slug metadata, approved base refs, activated verified source commits,
Mirror identity, default ordered check policy, and current refresh, unregister, and Publish
operations. GitHub owns source branches, commits, controlled Publish branches, pull requests, and
their human review state. Artifacts owns Mirror and Fork Git bytes.

Each Session owns its source pin, deterministic Fork identity, current Fork revision, checkpoint
references, and pinned `github` credential generation. A Publish operation references the Session
but is owned by the repository control record. It contains the exact prepared point, deterministic
branch sequence, pull-request identity, last expected GitHub head, idempotency key, phase, evidence,
last proven effect, retry state, and terminal result.

### Mirror refresh and Fork creation

One refresh operation per repository and base ref stages GitHub data, verifies the exact commit,
re-reads the moving GitHub ref, and atomically activates the verified commit. Staged bytes do not
change authority. A changed ref causes a bounded restart or `source_changed`; it never activates a
stale commit. An ambiguous write is inspected before retry.

Session Create uses the activated exact commit and deterministically creates or recovers one Fork.
Replay accepts only the expected Fork and source commit. A different object at the deterministic
identity is a typed conflict. Existing Sessions never move when the Mirror refreshes.

Warm Session Git reaches only its own Fork through the provider-local sentinel broker. The agent
owns edits, checks, commits, and commit messages. Scotty does not choose files, create hidden
commits, rewrite history, force-push, or infer intended work from a dirty workspace.

### Publish preparation

Publish starts only from a Warm Session and selects an existing committed revision. If the
workspace is dirty, Scotty lists the dirty paths and requires confirmation that they are excluded.
If required work is not committed, preparation returns `publish_not_committed`.

Preparation creates a temporary merge preview against the freshly verified GitHub base. It does
not merge, rebase, or rewrite the Session branch. A merge conflict returns a typed conflict. Scotty
rechecks the base before any GitHub write. A moved base causes a bounded reprepare or
`base_changed`; stale integration proof cannot Publish.

The repository control record may define the default ordered check policy. A Publish request may
provide one explicit reviewed override. Scotty never infers commands from repository files. The
prepared point pins:

- the exact Session head and Fork revision;
- the exact verified base commit;
- the ordered commands, arguments, timeouts, and policy revision;
- the deployed configuration snapshot digest;
- the check exit results and redacted evidence; and
- the pinned GitHub credential generation.

All required checks must exit successfully. They run against the isolated merge preview. Any files
they change are discarded. A change to any pinned input invalidates the result and requires a new
preparation. Failed checks do not push. The Publish record keeps a bounded redacted summary, and
full policy-bounded logs may be retained as immutable evidence in R2.

Preparation commits the exact checked point while holding the Session lease, then releases the
lease. Later Session work cannot enter that Publish. A prepared Publish may finish while the
Session is Stopped because it needs no mutable Session workspace.

### Controlled branch and pull request

Scotty allocates a deterministic internal branch from immutable Installation identity, Session
identity, and a per-Session Publish sequence. It proves ownership from the repository control
record, expected head, and pull-request identity. A matching name alone never proves ownership.

Scotty never force-pushes. The guarded behavior is:

- replay of the same prepared point returns the existing result;
- a newer fast-forward prepared point updates the same Scotty-owned open pull request;
- an external branch change, base change, or rewritten history returns a typed conflict; and
- after the pull request merges or closes, the next Publish uses the next sequence and creates a
  new controlled branch and pull request.

Publish preserves human changes to the pull-request title, body, labels, reviewers, comments, and
review state unless the request explicitly asks to change a supported field. Publish succeeds only
after Scotty verifies the exact controlled branch head and the expected open pull request. Merge is
not part of Publish success.

### Retry and ambiguous results

Scotty automatically retries only bounded safe reads and clear transient failures. After any
possible GitHub or Artifacts write, it inspects the exact target before retry:

- after an ambiguous push, it reads the exact controlled branch head;
- after ambiguous pull-request creation, it queries the exact head and base and reuses the one
  matching pull request rather than creating a duplicate;
- after ambiguous Fork or Mirror work, it verifies exact identity and content; and
- unknown foreign resources, failed checks, permission failures, conflicts, or changed sources
  require explicit action.

Every failure reports the code, stage, target, last proven effect, retained state, ambiguity, safe
retry, required human action, operation ID, and sanitized cause. Scotty never reports success from
an unknown provider result.

### Cleanup and recovery

Vaporize waits for every Publish to become terminal. It fences Git access, revokes operation
tokens, deletes the exact deterministic Fork, and proves absence before Session cleanup completes.
An ambiguous delete stays retryable. KV or list absence is not deletion proof.

A controlled GitHub branch remains while its pull request is open. After merge or close, cleanup
may delete it only after Scotty proves the branch is recorded as owned, its head is the exact last
expected Scotty head, and no open pull request uses it. Otherwise cleanup retains it and reports the
conflict. A successful open pull request holds the published commit in GitHub, so Vaporize may then
delete the Session Fork.

Repository unregister or Installation deletion waits until no Session, Fork, checkpoint, refresh,
or Publish references the Mirror. It then removes exact staging objects and the exact Mirror and
proves their absence before removing the control record. It never discovers deletion targets by a
loose prefix.

### Required proof

Tests and deployed canaries must cover public and private refresh, moving refs, concurrent refresh,
deterministic Fork replay, dirty-work exclusion, missing commits, check mutation isolation, failed
checks, base drift and merge conflict, repeated Publish, fast-forward update, closed and merged pull
requests, preserved human metadata, external branch edits, ambiguous push and pull-request
creation, GitHub credential expiry, Publish and Vaporize races, exact Fork and branch cleanup,
unregister retention, staged failure evidence, and every forbidden credential surface.

This decision defines the product and state contract. It does not implement it.

## Decision trail

- Use small records and operation overlays instead of large repository state enums.
- Let the agent own normal edits, checks, commits, and commit messages.
- Publish only an explicit existing commit; never create a hidden commit.
- Require an explicit check policy and an exact fresh merge preview.
- Reuse an open controlled pull request only for a fast-forward prepared point.
- Preserve human pull-request changes and never force-push.
- Inspect exact provider state after an ambiguous write before retry.
- Delete branches, Forks, and Mirrors only after exact ownership and absence proof.
