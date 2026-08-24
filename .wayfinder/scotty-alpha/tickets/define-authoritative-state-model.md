---
title: Define the authoritative state model
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the first-use and readiness contract
---

## Question

Which object owns each installation, identity, configuration, repository, credential, Session, operation, backup, and projection fact, and which facts are derived rather than stored?

## Resolution

Scotty uses split aggregate authority. Each fact has one writer. A combined Installation view may
join facts from several owners, but it is derived and must report freshness. Scotty has no
installation-wide master record and no duplicated authority.

### Ownership

| Facts                                                                                                                                                                                                                                                                        | Authoritative owner                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desired Installation name, Cloudflare account, Plugins, and Sandbox setup                                                                                                                                                                                                    | The private configuration at `~/.config/scotty/config.json`. It is desired input only.                                                                                                                                          |
| Deployed Installation name and account binding, active snapshot activation, Sync operation, Pi seed record, repository registry, and repository control records                                                                                                              | The installation-scoped Config Durable Object. The name and account binding are immutable.                                                                                                                                      |
| Deployed Cloudflare resource existence, identifiers, and current provider observations                                                                                                                                                                                       | Cloudflare. Alchemy reconciles them, but neither Alchemy state nor local state becomes product authority.                                                                                                                       |
| Immutable deployed snapshot and Plugin bundle bytes                                                                                                                                                                                                                          | R2. The Config object owns their references and decides which snapshot is active.                                                                                                                                               |
| Browser owner, terminal clients, scopes, pairing, transfer, recovery, credential verifiers, and revocation                                                                                                                                                                   | The Auth Durable Object.                                                                                                                                                                                                        |
| Usable root recovery value                                                                                                                                                                                                                                                   | The administrator's private local credential store. Auth owns its verifier, generation, and revocation facts. The value is never configuration or browser state.                                                                |
| Installation wrapping key                                                                                                                                                                                                                                                    | Cloudflare Account Secrets Store, under one exact Installation binding.                                                                                                                                                         |
| Encrypted Pi, GitHub, and custom credential generations, current pointers, policies, operations, and validation evidence                                                                                                                                                     | The installation Credential Durable Object. Config retains only the sanitized Pi seed and Plugin requirement declarations.                                                                                                      |
| Session record, immutable identity fields, lifecycle, provider assignment, pinned snapshot, pinned repository commit, Fork reference, operation lease, hard cap, runtime epoch, Session grant, sentinel, per-Session vault, backup handles, current backup, and cleanup duty | That Session's Sandbox Durable Object.                                                                                                                                                                                          |
| Runner names and Session assignments                                                                                                                                                                                                                                         | The Runner Registry.                                                                                                                                                                                                            |
| One Runner's desired state and current connection observation                                                                                                                                                                                                                | That Runner's Durable Object. A connection observation does not prove that the Runner can create a Session.                                                                                                                     |
| Git source commits, branches, and pull requests                                                                                                                                                                                                                              | GitHub.                                                                                                                                                                                                                         |
| Mirror and Fork Git content                                                                                                                                                                                                                                                  | Cloudflare Artifacts.                                                                                                                                                                                                           |
| Mirror identity, refresh operation, source commit, and Publish operation                                                                                                                                                                                                     | A repository control record owned by the installation Config object for alpha. This is a logical record, not a required new service. A separate per-repository object is justified only if later concurrency proof requires it. |
| Immutable workspace-backup and evidence bytes                                                                                                                                                                                                                                | R2. The Session owns the references, meaning, retention duty, and cleanup state.                                                                                                                                                |
| Hatch desired state, service identity, exposure, runtime generation, health evidence, access revocation, capture jobs, and evidence metadata and order                                                                                                                       | The Session Durable Object.                                                                                                                                                                                                     |
| Session, repository, and statistics list views                                                                                                                                                                                                                               | KV projections. They are non-secret, rebuildable, and never authoritative.                                                                                                                                                      |
| Processes, sockets, containers, workspaces, live Hatch processes, Pi memory, RPC state, Git processes, and live client connections                                                                                                                                           | Runtime-only state. They never restore or override durable authority.                                                                                                                                                           |

Repository registration means that Scotty knows the stable repository identity. It does not prove
current GitHub access, Mirror freshness, recent use, or readiness.

There is no generic `Artifact` aggregate. Use the precise terms **deployed snapshot bundle**,
**workspace backup**, **evidence artifact**, and **Cloudflare Artifacts Mirror or Fork**.

### Snapshot and activation contract

The Config object owns one current activation record containing the revision, snapshot digest,
normalized config digest, activation time, and completed Sync identifier. R2 owns the immutable
snapshot body. Uploading a body does not activate it. Activation changes only when the Config
object commits the new record with its revision check.

The activation record is current-state authority, not an authoritative history. Old immutable
bodies remain only while a Session or retention rule references them. Rollback restores desired
local configuration and performs a new Sync with a new revision.

New Sessions pin the active snapshot revision and digest. Existing Sessions retain that snapshot
and its immutable content through Resume. A Session also pins its Installation, compute provider,
named Runner when used, repository, base commit, and Fork identity. Scotty never retargets these
fields. A change creates a new Installation or Session.

### Operation ownership

- Auth owns pairing, transfer, recovery, and client revocation operations.
- Config owns Sync and activation operations.
- The Credential object owns credential create, import, future-Session replacement or removal, OAuth refresh, validation, generation retirement, and cleanup operations.
- The repository control record owns Mirror refresh and Publish operations.
- Each Session owns Create, Snapshot, Sleep, Resume, hard-cap handling, Vaporize, bounded Hatch mutations, and evidence capture operations.
- The Runner Registry owns registration and assignment; each Runner owns its connection and desired-state operations.

The initiating owner stores the command's idempotency key, expected revision, progress, provider
references, retry state, and final result. A command that touches another owner does not gain a
global transaction. It uses revision checks, stable operation identifiers, ordered effects, and
repair. Only one Session operation lease may mutate Session state. Publish remains separate from
the Session lifecycle and must coordinate with the Session's lease at the boundaries that need a
stable workspace or Fork.

### State classes

- **Authoritative:** mutable owner records listed above.
- **Immutable:** deployed snapshot bodies, Plugin bundles, workspace-backup bytes, evidence bytes,
  and Git commits. An immutable payload does not decide whether it is active or current.
- **Derived:** readiness, capability status, combined Installation views, age, hard-cap remaining
  time, and Connected Session status.
- **Cached or projected:** KV lists, local deployment locators, remembered display data, and prior
  readiness results.
- **Runtime-only:** container files, process memory, sockets, active Pi state, live Git processes,
  and live connection presence.

Only direct owner reads and fresh provider checks may authorize a mutation or claim readiness.
Cached and derived views must report their check time or revision when shown.

### Disagreement, recovery, and deletion

The owner record wins over a projection or cache. Scotty repairs the copy. A missing immutable
payload that an owner references is typed corruption and blocks the action. Provider observations
are fresh evidence, not authority. An ambiguous provider result keeps the operation open for retry
or inspection; Scotty never guesses success.

Only an owner may mark deletion complete. It does so after every resource for which it has cleanup
duty returns a proven absent result. It keeps a tombstone and retry state while absence is
ambiguous. Projection absence never proves deletion, and provider leftovers never recreate owner
state. A separate cleanup scan may remove proven orphans.

### Hatch and retained media

A Hatch is live authenticated access to a service in Session compute. The live process, sockets,
and rendered view are runtime-only. The Session owns the durable Hatch record and revokes access
when the runtime generation changes, including Sleep, Resume, hard-cap handling, and Vaporize.

A screenshot or video becomes an evidence artifact only after R2 stores the immutable bytes and
the Session commits its metadata and content reference. The browser and TUI may capture, add, list,
and show those artifacts through authenticated reads. R2 bytes alone cannot create evidence state.
The retention ticket decides how long evidence remains after Session cleanup.

Representative outcomes are fixed:

- A snapshot upload followed by a crash before activation leaves the previous snapshot active.
- A committed Session whose Fork creation or KV publication fails still exists and retains retry state.
- Session grants pin exact credential generations. Administrator replacement or removal affects
  future Sessions only; Codex OAuth refresh commits within the pinned generation before use. Cached
  status cannot authorize a broker operation, and the stable Session sentinel does not change.
- A missing referenced backup blocks Resume. Unreferenced R2 bytes are orphans and cannot recreate
  a Session backup handle.

### Proof boundary

The implementation must prove owner invariants and partial failures with deterministic local fault
injection, then prove the real CLI contract offline. Provider-specific behavior must pass the
guarded disposable deployed canary. A local Wrangler environment is optional and should remain
only if it proves a unique boundary. The release-gate ticket will define the exact checks. It must
include projection repair, operation replay, credential generation and OAuth refresh, missing
immutable payloads, Hatch generation revocation, screenshot and video capture, ambiguous provider results,
orphan cleanup, Cloudflare Artifacts, and Runner parity.

This decision assigns ownership only. The downstream lifecycle, credential, repository bridge,
retention, and release-gate tickets still define their guarded transitions and proof details.

## Refined local-state boundary

The only Scotty-owned raw credentials that may persist on an administrator machine are root
recovery and that machine's paired-client value. A Runner may persist only its own registration
identity. Local locators, journals, diagnostics, and caches remain hints or disposable views and
never override owner state. The canonical host roots are the XDG config, state, and cache roots;
host `~/.scotty` is not part of the alpha target.

## Refined Runner authority

The Runner Registry owns immutable Session assignments and provisional capacity reservations in
addition to names. The Runner object owns desired mode, certified release proof, current connection,
and light health observations. The control-plane orchestrator derives slots from the certified
resource profile and observed machine facts. The Runner host owns no Session lifecycle authority.
