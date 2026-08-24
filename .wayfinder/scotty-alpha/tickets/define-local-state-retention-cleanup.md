---
title: Define local state retention and cleanup
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the authoritative state model
  - Define the config and Plugin contract
---

## Question

What may Scotty store under `~/.scotty`, how does it distinguish active pointers, resumable operation journals, diagnostics, and disposable history, and what automatic and user-driven retention and cleanup rules keep that state clear and bounded?

## Inherited state contract

The local private configuration is desired input. The private local credential store owns the
usable root value. Deployment locators, operation convenience data, diagnostics, and prior views
are non-authoritative. Local cleanup must never delete or reconstruct deployed authority. A Gone
Session may retain only a minimal tombstone and policy-bounded backup or evidence references; they
cannot authorize Resume or recreate active Session state.

## Inherited credential contract

Local Pi or GitHub login import is explicit and leaves the source tool's login unchanged. Scotty
local state may retain only sanitized metadata, keyed digests, operation IDs, and retry journals.
It must remove temporary plaintext input after the guarded Credential-object operation settles.

## Inherited Pi configuration contract

The private Scotty config owns desired Pi behavior settings. Scotty does not copy or track local
Pi settings, auth, package stores, sessions, or update state. Local build caches and diagnostics
for the production Sandbox image are non-authoritative and must be bounded and safe to delete.

## Resolution

Local Scotty state is a private operational aid, never a second control plane. Desired input,
usable device credentials, resumable hints, diagnostics, and disposable caches use separate roots.
A local file may help locate or resume an owner operation, but it cannot prove a deployed fact,
authorize from cached state, reconstruct deleted authority, or replace a fresh owner read.

### Canonical local roots

Scotty honors `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`. The default layout is:

```text
~/.config/scotty/
└── config.json

~/.local/state/scotty/
├── credentials/          # private-file fallback when no OS credential store exists
│   ├── root
│   ├── client
│   └── runner            # only on a trusted-Runner host
├── installation.json     # rebuildable locator
├── operations/           # secret-free resume hints
├── diagnostics/          # bounded redacted records
├── locks/                # live writer coordination only
└── tui/                  # bounded crash diagnostics only

~/.cache/scotty/
├── bundles/
├── images/
└── tmp/
```

`~/.scotty`, `~/.scotty.json`, `~/.scotty/sandbox.json`, `~/.config/pi-scotty`, and other parallel
host stores do not exist in the alpha target. A Session-container `.scotty` directory may exist as
disposable runtime material, but it is not host-local authority and disappears with provider
cleanup.

`config.json` remains the sole desired-input file. The state root contains no desired config or
deployed snapshot. The cache root is always safe to remove. The Installation locator may contain
the explicit Installation identity, public origin, sanitized coordinates, last observed revision,
and check time. Every mutation and readiness result re-reads the authoritative owner and performs
the required fresh provider checks. A missing locator triggers rediscovery; it never recreates or
deletes an Installation.

### Local credential boundary

Scotty prefers the operating system credential store. When none is available, it stores credentials
under the private state fallback with `0700` directories and `0600` files.

The administrator machine may persist only:

- the root recovery bearer; and
- that machine's paired-terminal client credential.

A trusted Runner may separately persist one Runner registration identity credential in its
configured private root. It never persists Session Pi, GitHub, or custom credentials; Credential-
object ciphertext; a Session grant; provider or operation token; wrapping key; or Session sentinel.
The Runner broker may hold the assigned Session sentinel in memory for the current runtime epoch
only. Stop, reassignment, epoch change, or process exit clears it.

Pi, GitHub, and custom credential input streams from protected TTY or standard input through
process memory to the guarded remote operation. The alpha product never stages that plaintext in a
local file. An interrupted operation before remote commit requires re-entry. A private temporary-
file path is allowed only as a current development-machine exception and is not a product contract.
Scotty never reads, rewrites, tracks, or deletes the source tool's local login.

### Pairing and recovery

The Worker transports pairing requests; the Auth Durable Object remains authority. It owns one
browser owner, one-use pairing grants, client IDs and credential digests, scopes, owner epoch, and
revocation. The browser owner may issue pairing grants and revoke standard clients. A paired
terminal cannot pair another device, remove the browser owner, revoke another client, or use root
authority.

`client unpair` revokes only the calling terminal client through Auth and deletes its local client
credential after revocation is proven. An ambiguous result retains the credential and retry state.
The browser owner can revoke a lost client. Root recovery replaces ownership and revokes all
browser and terminal credentials.

Normal cleanup never removes root or client credentials. The local root recovery bearer remains
through failed or ambiguous uninstall and is removed only after exact remote Installation deletion
is proven.

### Resumable operation hints

Before the first external mutation, Scotty atomically writes a journal containing only:

- schema version, Installation identity, operation kind, and stable operation ID;
- target owner and expected revision;
- keyed intent and plan digests;
- current stage, last proven effect, sanitized references, and check time;
- open or ambiguous outcome and required reconciliation; and
- safe retry, human action, and sanitized terminal result when known.

Journals never contain credentials, ciphertext, tokens, sentinels, secret input, raw provider
responses, prompts, transcripts, repository contents, or workspace data. They are resume hints,
not replay authority. Every retry re-reads the remote owner and exact provider target. Age, a
missing local file, projection absence, or a timeout never proves success, failure, or deletion.

Open and ambiguous journals have no age expiry. After the authoritative owner proves a terminal
result, Scotty removes the journal. Session-create idempotency entries use the same rule. A
sanitized failure summary may remain as a bounded diagnostic.

### Retention and automatic pruning

Per Installation, diagnostics retain at most 14 days, 20 files, and 10 MiB. Crossing any bound
prunes the oldest terminal diagnostic first. Each record is structured, redacted, depth-bounded,
and size-bounded and contains only operation identity, stage, time, last proven effect, and a
sanitized cause. TUI crash diagnostics share this boundary. Scotty persists no TUI transcript,
draft, worklog, Session list history, or Gone-Session tombstone.

Disposable cache entries retain at most seven idle days and 2 GiB in total, using least-recently-
used pruning. Cache deletion never removes administrator Plugin sources or any remotely referenced
snapshot body. Released locks and temporary files may be removed only after Scotty proves that no
live writer owns them.

Scotty prunes at safe command boundaries after startup safety checks and after an operation
settles. It removes only reconciled journals, expired diagnostics, released locks, proven-dead
temporary files, and disposable cache entries. A pruning failure returns a typed warning and retry
point but never changes a proven remote result. Unresolved records never disappear to satisfy an
age, count, or size limit.

Alpha adds no broad `local inspect`, `local prune`, or `local reset` command tree. `doctor` reports
local roots, permissions, size, retention, stale or blocked cleanup, and required reconciliation.
Automatic pruning handles safe disposal. `uninstall` remains the explicit full cleanup path.

### Uninstall and clean cutover

`uninstall` performs remote owner operations first. Only exact proven Installation deletion permits
removal of its local locator, settled journals, diagnostics, cache, paired-client credential,
Runner identity when applicable, and root recovery bearer. Failed or ambiguous remote cleanup
retains recovery credentials and operation hints. The private desired config is removed only as an
explicit final uninstall effect shown in the approved plan.

The current development machine may discard all unshipped legacy local Scotty state and start from
the canonical roots. The cutover shows the exact legacy targets, checks that no useful input must
be extracted, removes duplicate credentials and stores without keeping a secret backup, and then
creates fresh canonical setup state. This is a development cutover, not a shipped compatibility
reader or product reset command. Alpha never reads old and new stores in parallel.

### Trusted Runner retention

The Runner has a separate configured root for its identity credential, runtime workspace, operation
receipts, and recovery fences. Active, incomplete, corrupt, unacknowledged, or ambiguous receipts
and fences have no age expiry. Once the control plane acknowledges the exact terminal operation,
Scotty retains the receipt for at most seven days or 250 acknowledged receipts per Runner, pruning
the oldest acknowledged receipt first. No limit may remove unresolved correctness state.

Runner removal separately proves control-plane deregistration, service removal, runtime workspace
cleanup, broker shutdown, identity-credential removal, and receipt disposition. Local absence never
proves remote deregistration or Session cleanup.

### Filesystem and proof boundary

Private directories use `0700`; private files use `0600`. Reads reject symlinks, wrong owners,
non-regular files, unsafe parents, and group or world permissions. Writes use private same-directory
temporaries, atomic replacement, file and parent fsync, and scoped live-writer locks.

Deterministic tests must cover XDG overrides, keychain and file fallback, atomic writes and crash
points, symlink and owner rejection, secret-free journals and diagnostics, open-operation retention,
remote reconciliation, every retention bound, safe opportunistic pruning, `doctor` reporting,
narrow self-unpair, uninstall ambiguity, clean legacy removal, Runner acknowledgement and caps,
memory-only sentinel handling, and the invariant that local cleanup never deletes or recreates
deployed authority.

This decision defines the product and local-state contract. It does not implement it or delete any
current file.

## Decision trail

- Use the config, state, and cache XDG roots and remove host `~/.scotty` from the alpha target.
- Persist only root, paired-client, and separate Runner identity credentials locally.
- Treat local journals as secret-free resume hints and always reconcile with remote authority.
- Keep unresolved journals and recovery fences without age expiry.
- Prune diagnostics, caches, and acknowledged Runner receipts with the selected bounds.
- Use automatic safe pruning and `doctor`; do not add a broad local-reset command tree.
- Make paired-client unpair a narrow self-revocation through Auth.
- Remove root recovery only after proven remote uninstall.
- Permit current-epoch Runner sentinel use in broker memory only.
- Keep temporary plaintext files as a development-machine exception, not an alpha product behavior.
- Perform a clean unshipped-machine cutover without a legacy compatibility reader or secret backup.
