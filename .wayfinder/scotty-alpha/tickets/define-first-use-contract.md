---
title: Define the first-use and readiness contract
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

What exact journey takes a new user or their agent from no Scotty installation to a proven ready installation and a first connected Session, and what must each step show?

## Resolution

Start after the Scotty executable is installed. Use one resumable, human-led CLI journey with
stable machine-readable stage results. Browser and OAuth work are explicit human handoffs; every
other step remains safe for an agent to drive.

The canonical journey is:

1. **Declare intent.** Require the user-chosen Installation name and explicit Cloudflare account.
   Discover candidates when useful, but never infer deployment identity.
2. **Preflight, plan, and approve.** Check required host tools, account authentication, and
   permissions. Missing prerequisites stop safely with remediation and a rerun point. Before the
   first mutation, show one plan naming every target and effect; require interactive confirmation
   or explicit noninteractive approval. Material plan changes require approval again.
3. **Deploy.** Deploy the named Installation and establish local root authority. Show the
   Installation identity, Cloudflare target, public origin, deployment result, retained state, and
   next action.
4. **Establish ownership and pair this machine.** Establish the browser owner, then pair this
   machine's terminal client. Browser-only work returns a typed `human_action_required` result with
   purpose, safe URL or code, expiry, completion condition, and resume instruction. Root authority
   never enters a URL or browser credential.
5. **Configure and synchronize.** Establish one usable Pi login through Pi's API-key or Codex
   OAuth behavior, establish usable GitHub authentication, synchronize the validated deployed
   configuration and Sandbox setup, and prove the Cloudflare compute and Artifacts service paths.
   No repository is required for Installation readiness.
6. **Evaluate readiness.** Readiness is a fresh, non-mutating evaluation of underlying facts, not
   an authoritative stored state. Each capability reports `ready`, `blocked`, `unavailable`,
   `stale`, or `not_configured`, together with its target, check time, evidence, and remediation.
   The Installation is Ready when the control plane is reachable, the browser owner exists, this
   terminal client is paired, the deployed snapshot is current, one Pi login is usable, GitHub
   authentication is usable, Cloudflare Artifacts is reachable, and Cloudflare compute is usable.
   Other configured capabilities report independently and do not defeat overall readiness while a
   complete usable route remains.
7. **Create the first Session.** After Ready, require an explicit GitHub repository. Verify access,
   synchronize its Mirror, use its default branch unless the user explicitly chooses another base,
   and create the isolated Session Fork. Show the exact repository, base, Fork, and explicit
   `cloudflare` compute route before creation. Revalidate that route at create time. Create a usable
   Session without dispatching an initial prompt.
8. **Connect and prove.** Verify the paired client and hand directly into the live TUI. The user
   sends the first prompt there and receives a real Pi model response from the Session. Show a
   brief proof banner naming the Installation, provider, repository and Fork, Session, live
   connection, and response evidence, then leave the user in the normal live Session.

Every stage has a stable identity and shows its named target, progress or result, retained valid
state, and exact next action; JSON exposes the same typed outcomes. A late failure preserves
verified progress and resumes without duplicating completed effects or rolling back healthy
resources. Session creation revalidates readiness facts that can change.

`Connected` describes the live authenticated TUI input and event relationship. It is not a
persisted Session lifecycle state. Scotty stores no separate first-use-completed milestone; the
evidence remains in current readiness and the Session event or worklog history.

Executable distribution, exact command names and JSON envelopes, configuration fields, credential
ownership, readiness fact ownership, and the canonical Session lifecycle remain with their
existing downstream tickets.

## Refined standard-setup entry

Local Pi is not a prerequisite. `scotty init` generates the standard config, asks for Pi provider,
model, and thinking choices, and writes only allowed non-secret Pi behavior settings. Sync pins
them in the deployed snapshot. Pi login remains a separate protected credential operation.

## Refined local identity flow

Setup stores root recovery in the OS credential store or the private state fallback, establishes
one browser owner through the Worker and Auth object, and pairs the current terminal as a standard
client. The browser owner issues pairing grants; a terminal client cannot pair another device or
change ownership. Setup journals are secret-free hints and always reconcile with deployed owners.
