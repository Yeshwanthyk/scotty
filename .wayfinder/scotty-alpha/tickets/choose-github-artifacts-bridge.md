---
title: Choose the GitHub–Artifacts bridge and Session Git boundary
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the authoritative state model
---

## Question

How does the control plane refresh public and private GitHub repositories into an Artifacts Mirror, pin the exact source commit for each Session Fork, and give Session Git narrow sentinel-based access without placing GitHub or Artifacts credentials in Session compute?

## Inherited state contract

The installation Config object owns the repository control record for alpha. GitHub owns source
and pull requests. Cloudflare Artifacts owns Mirror and Fork Git content. Each Session owns its
pinned source commit and Fork reference. A complete Session checkpoint pairs one exact Fork
revision with one immutable R2 workspace backup. This ticket must define that synchronization
boundary without creating a second authority for any fact.

## Resolution

Scotty owns one provider-neutral repository bridge contract. Public and private GitHub repositories
use the same refresh, verification, activation, Fork, and recovery rules. Public refresh may use
anonymous GitHub access. Private refresh resolves the real GitHub credential from the installation
secret boundary. The credential never enters Cloudflare Artifacts, Session compute, a Runner
workspace, R2, KV, Git configuration, process arguments, logs, API output, or Alchemy state.

GitHub is source authority. Cloudflare Artifacts owns Mirror and Fork Git content. The installation
Config object owns one repository control record. Each Session owns its pinned source commit and
Fork reference. R2 backups retain working state that Git does not.

### Repository identity and supported refs

The stable repository identity is GitHub's immutable repository ID. Config also records the
current owner/name slug for display and routing. A GitHub rename or transfer updates that metadata
without creating a second Mirror. A different repository later appearing at the old slug cannot
inherit authority.

Alpha refreshes the repository default branch or one explicitly selected base branch. For each
supported ref, Config records the last verified GitHub commit, corresponding Artifacts commit,
check time, refresh operation, and current result. Alpha does not promise continuous mirroring,
every branch, tags, Git LFS, or submodule materialization.

### Mirror refresh

Mirror refresh runs:

- on first repository registration;
- on explicit repository Sync; and
- immediately before Session Create for the requested base ref.

There is no background polling in alpha. If a fresh GitHub read already matches the verified
Artifacts commit, refresh may skip transfer and update its evidence.

One Config-owned operation serializes refresh for a repository and ref. Concurrent Session Creates
for the same ref wait for or reuse the same verified result, then create separate Forks. Different
requested refs keep separate verified commit records.

A refresh follows this order:

1. Resolve the immutable GitHub repository identity, requested ref, and exact source commit.
2. Resolve an installation GitHub credential only when the source requires one.
3. Transfer the complete reachable ordinary Git history for that commit through the Scotty bridge.
4. Write through a staging ref or equivalent non-active Artifacts location.
5. Verify the exact commit and required objects inside Artifacts.
6. Read the GitHub ref again. If it moved, retry a bounded number of times, then return a typed
   `source_changed` result with both observed commits.
7. Atomically commit Config's verified active commit for that ref.

Uploading objects or moving a staging ref does not activate a Mirror commit. Failed staging work
is an orphan for cleanup. A crash after Artifacts changes but before Config activation leaves the
prior verified commit active. A stale refresh completion cannot advance the record.

The documented Artifacts public-import path may remain a proof tool, but it is not a second product
path. Scotty does not claim authenticated Artifacts import for private GitHub repositories until a
separate deployed proof establishes that contract.

### Session Fork creation

Session Create freshly verifies the requested base ref, then creates the Session Fork from the
exact verified commit rather than a moving branch. The internal Fork identity is deterministic
from the Installation and Session IDs. Retrying the Create idempotency key must inspect and recover
that same Fork. A conflicting Fork fails safely. A successfully created but unreferenced Fork is a
proven orphan for cleanup.

The Session atomically pins the immutable GitHub repository ID, requested base ref, exact source
commit, Mirror record revision, and Fork identity. Later Mirror refresh never changes an existing
Session or Fork.

### Session Git boundary

Session Git uses a provider-local broker. Cloudflare and trusted runners have host adapters behind
one shared contract. Large Git traffic streams directly between that broker and Artifacts; it does
not pass through the public Worker as a central data plane.

Session compute receives only its stable Session sentinel. A Scotty credential helper or protected
local broker protocol presents the sentinel at request time. The sentinel never appears in a
remote URL, Git config, process argument, log, or repository file.

The sentinel is not a standalone network bearer. Authorization requires both:

- the stable sentinel and active Session grant; and
- an authenticated provider-broker binding for the assigned Session and current runtime epoch.

A copied sentinel is therefore useless from the internet, another Runner, another Session, or an
old runtime. The broker rejects Git while the Session is not Warm.

After a fresh authority check, the broker may mint one short-lived Artifacts token for one logical
Git operation. It binds the token to the Session, current runtime epoch, exact Fork, and either read
or write scope. It keeps the real token only in broker memory and never returns it to Session
compute. Multi-request smart-HTTP traffic may reuse that operation token.

The Session may read and write only its own Fork. It cannot write the Mirror, access another
Session Fork, push GitHub, list installation repositories, or mint tokens. Publish uses the
separate control-plane repository bridge.

The broker revokes the operation token on completion, Session stop, runtime-epoch change, Session
grant revocation, or Vaporize. If a token expires during Git, the broker may revalidate authority
and mint a replacement with the same operation, Fork, epoch, and scope. It revokes the old token.

Revocation rejects new requests, closes tracked streams, and revokes active tokens. If a write may
have reached Artifacts, the broker inspects the exact target ref before retrying or reporting a
result. It reports success only when the intended ref update is proven. Otherwise it retains an
ambiguous operation result. Scotty does not assume that closing a stream undid a Git write.

### Checkpoint and Publish integration

Snapshot and Sleep push existing Session commits to the Fork but do not create hidden Git commits.
The checkpoint records the exact Fork revision. Its R2 workspace backup retains uncommitted,
untracked, and ignored files plus Pi continuation state. The Fork revision and backup together
restore the exact Session state.

Publish preparation runs only for a Warm Session. It creates or selects an exact checkpoint, runs
the required checks, and pins the checked Fork revision and proof. The repository bridge then uses
installation GitHub authority to push only that controlled revision and create or update its pull
request. Later Session work cannot enter an already prepared Publish.

Vaporize waits for open or ambiguous Publish, fences broker traffic, revokes tokens, proves the
Fork absent, and only then completes Session cleanup. Vaporize does not delete the installation
Mirror.

### Failure, fallback, and retention

The bridge never falls back to direct GitHub access from Session compute, another Session Fork, a
local clone, or stale unverified Mirror state. An unavailable credential, bridge, Mirror, Fork, or
Artifacts service returns a typed blocking or retryable result.

Missing referenced Mirror or Fork content is corruption, not permission to recreate or retarget
silently. Every refresh, token, Fork, push, and deletion operation keeps its idempotency key,
expected revision, provider references, last proven effect, and retry state until the result is
clear.

An Installation retains its Mirror across Sessions. Mirror removal requires explicit repository
unregister or Installation deletion and must wait until no Session, Fork, refresh, checkpoint, or
Publish references it.

Alpha supports ordinary Git objects only. If required checkout needs Git LFS or submodule
materialization, Scotty returns a typed unsupported-feature result. It does not leak credentials or
bypass the Mirror. Those protocols require their own future bridge and deployed proof.

### Proof boundary

Deterministic tests must cover public and private refresh, exact-commit verification, a moving
branch, concurrent refresh reuse, staging failure, stale activation, deterministic Fork replay,
orphan cleanup, broker scope, copied sentinels, old runtime epochs, read/write separation, token
expiry and replacement, revocation during clone and push, ambiguous ref updates, checkpoint
pairing, Publish isolation, Vaporize races, Mirror retention, and every forbidden credential
surface.

The guarded deployed canary must prove real public and private GitHub transfer, Artifacts Fork Git,
provider-local broker streaming, sentinel-only Session compute, revocation, absence of credential
leakage, and the same behavior on Cloudflare and trusted runners before either provider is offered.

## Refined Runner-local boundary

A trusted Runner may persist its registration identity but no Session sentinel, grant, GitHub
credential, Artifacts token, or Git credential. Its broker may hold the assigned Session sentinel
in memory for the current runtime epoch only. Runner receipts and recovery fences contain no
credential material.
