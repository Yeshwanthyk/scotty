---
title: Define the single-executable boundary
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the CLI and TUI contract
  - Define the minimum browser surface
---

## Question

Which CLI, TUI, setup Skill, local configuration, update, browser-launch, and support functions must the single Scotty executable own for alpha, and which deployed browser assets remain separate?

## Inherited credential boundary

The executable must own protected credential input, explicit Pi and GitHub import approval,
administrator-named custom Credential operations, Plugin requirement binding, sanitized staged
results, and browser handoff. It must not persist plaintext in argv, environment, local journals,
diagnostics, or update state.

Scotty-owned local raw credentials are limited to root recovery, the calling terminal's paired-
client credential, and a trusted Runner's separate registration identity. Pi, GitHub, and custom
credential input streams from protected TTY or standard input through process memory into one
guarded Credential-object operation; an interrupted pre-commit operation requires re-entry. The
executable never stages those values in an alpha product file. It reads a local Pi or GitHub source
login only for an explicit Import after showing sanitized identity and obtaining approval, and it
never rewrites or deletes the source login.

## Inherited setup boundary

The executable must generate the standard config without requiring local Pi, validate the Pi
behavior allowlist, resolve and plan Plugins, build or select immutable setup inputs, run local
production-image checks, and report staged setup failures. It does not run a second local Pi
authority or silently import the user's Pi directory.

## Inherited local-state contract

The executable owns XDG path resolution, OS credential-store access with private-state fallback,
atomic secret-free journals, bounded diagnostics and caches, safe automatic pruning, `doctor`
inspection, narrow self-unpair, and proven uninstall cleanup. It must not ship a legacy
`~/.scotty` reader or broad local reset authority.


## Resolution

“Single executable” is Scotty's local distribution and operator boundary, not a claim that the
whole product runs in one process. Alpha ships exactly one terminal executable for each supported
target. That file contains the CLI, in-process TUI, embedded canonical operating Skill, release-
matched Worker and browser deployment payloads, schemas, infrastructure descriptors, and the code
needed to operate setup, credentials, local state, update, browser handoff, and trusted Runners.
It requires no adjacent TUI, theme, Skill, deployment archive, sidecar, desktop application, or
source checkout.

`scotty tui` runs inside that same executable. It does not launch local Pi, read the user's Pi
directory, or own a second Session runtime. The current separate desktop application, desktop
sidecar, packaging, checks, compatibility protocol, and artifacts are removed at clean cutover.

### Release and installation boundary

Alpha publishes four executable targets:

- macOS arm64;
- macOS x64;
- Linux arm64; and
- Linux x64.

Windows is not an implied or dormant alpha target. Private alpha does not require macOS Developer
ID signing or notarization, but every release still uses the signed release manifest and exact
asset digest contract. A small verified installer selects the native asset, authenticates its
release metadata, verifies its digest, and installs one executable. GitHub CLI is not an installer
or runtime prerequisite.

Release CI, not the Installation administrator, builds Scotty. Ordinary install and Cloudflare
setup require no local Bun, Node, Pi, Docker, or `gh`. An administrator may explicitly choose a
local Pi or GitHub import when those source tools exist, but no source login is silently required
or discovered.

### Managed Sandbox image

Scotty maintains one canonical production Sandbox image for alpha. Its source remains under
`worker/container/**`. Release CI builds, inventories, secret-scans, contract-tests, and publishes
the image to:

```text
ghcr.io/yeshwanthyk/scotty-sandbox@sha256:<digest>
```

The signed Scotty release manifest binds the executable release, embedded deployment payload, and
exact Sandbox image digest. Normal setup authenticates that manifest, selects only the immutable
digest, lets Alchemy import it into the Installation's Cloudflare Container registry, and proves
the deployed image through readiness and guarded canary probes. It does not pull or build the full
image locally.

The managed image contains the universal base defined by the thin-Sandbox contract. Pi behavior,
Skills, Pi extensions, and Sandbox-tool Plugins remain independently resolved, digest-pinned setup
content; they do not require an administrator-built base image. Replacing the managed foundation
image is deferred beyond alpha. Existing Sessions retain their pinned base release, image, and
setup snapshot while referenced.

### Embedded and deployed pieces

The executable embeds release-matched inputs so setup never requires a Scotty checkout. It owns
strict decoding, planning, immutable preparation, upload, revision checks, and the Alchemy
deployment invocation. It does not make local files authoritative for deployed state.

These remain deployed, separate authorities and runtime resources:

- the Worker and its Assets binding;
- Config, Credential, Auth, Session, and Runner Durable Objects;
- Account Secrets Store wrapping key and write-only provisioning boundary;
- KV projections and R2 backup, evidence, Artifacts, and Plugin-bundle stores;
- Cloudflare Container application and Sandbox association;
- provider-local model, Git, and scoped-HTTPS brokers;
- Session grants, sentinels, workspaces, processes, Forks, Hatch, and capture jobs; and
- the current browser pages and assets preserved by the browser-surface decision.

The browser assets are embedded only as deployment input. After setup they are served by the
deployed Worker Assets binding; the executable does not run a local browser server. No existing
browser workflow moves into the binary merely to satisfy the single-executable label.

### Executable-owned operator functions

The executable owns the complete canonical command tree defined by the CLI/TUI contract,
including:

- one resumable `setup` for config bootstrap, deployment, ownership, pairing, credentials, Sync,
  readiness, first Session, and first-response proof;
- `config`, `credential`, `repository`, `session`, `client`, `owner`, and `runner` operations;
- the in-process `tui` work surface;
- `readiness`, `doctor`, signed `update`, and proven `uninstall`; and
- `skills show` for the embedded canonical operating Skill.

`scotty skills show` prints release-matched Markdown. `scotty skills show --json` uses the universal
terminal envelope and returns the content, executable release identity, and Skill digest in
`data`. The Skill is public agent guidance but not a second execution authority: it delegates all
effects to canonical Scotty commands and owns no journal or state machine.

`doctor` inspects only the local executable, canonical XDG roots, ownership and permissions,
required host capabilities, pointers, bounded diagnostics, blocked safe pruning, and basic network
reachability. `readiness` evaluates fresh deployed capability facts. Alpha adds no support-bundle
archive and no broad local inspect, prune, purge, or reset command family. Safe local pruning is
automatic under the settled retention contract.

Existing-Installation discovery, deployment reconciliation, and interrupted first-use recovery
belong inside resumable `scotty setup`; alpha has no separate top-level Installation `recover`.
`owner recover` remains the explicit browser-ownership recovery path. `client unpair` revokes only
the calling client through Auth before deleting its local credential; ambiguous revocation retains
the credential and retry hint.

### Credentials and browser handoff

Protected TTY or standard-input collection streams Pi, GitHub, and custom plaintext through process
memory into one guarded Credential-object operation. It never enters argv, environment, product
files, journals, diagnostics, update state, Alchemy props/state, browser output, or Session compute.
An interrupted pre-commit operation requires re-entry.

The only Scotty-owned raw credentials persisted locally are root recovery, this terminal's paired-
client credential, and a trusted Runner's separate registration identity. The executable prefers
the OS credential store and uses only the settled private-file fallback. Explicit Pi or GitHub
Import shows sanitized source identity, requires approval, copies through memory, and never rewrites
or deletes the source tool's login.

Interactive browser and OAuth handoffs use the OS browser opener automatically. If opening fails,
the executable prints only the safe fallback URL or code permitted by the owning handoff contract,
with purpose, expiry, completion condition, and resume command. `--json` never opens the browser;
it returns that same typed safe human action. Root authority and unsafe capability URLs never enter
browser state or output.

### Update and version skew

`scotty update --check` authenticates the signed stable release manifest and reports availability
without mutation. `scotty update` selects the exact native asset, verifies signature and digest,
probes the candidate, then atomically replaces only the executable with a same-directory write and
directory fsync. It never mutates deployed resources, stores credentials, or performs a managed
downgrade.

A newer executable may observe an older Installation through `doctor`, `readiness`, and `setup`.
When protocol or release skew makes mutation unsafe, other mutations return a typed blocker until
an approved resumable setup/config plan synchronizes the deployed release. Binary replacement never
silently upgrades Cloudflare resources.

### Trusted Runner boundary

Alpha installs this same executable on a trusted Linux host as one hardened user-systemd service.
There is no separate Runner package or sidecar. Runner registration persists only its dedicated
identity. It never copies local Pi or GitHub credentials into files, environment, service units, or
containers; Session sentinels remain memory-only and runtime-epoch-bound at the provider broker.

The executable may register, serve, inspect, and remove a named Runner. `runner:NAME` becomes
create-capable only after the trusted-runner parity contract proves native Pi RPC, lifecycle,
brokers, repository work, backup/Resume, Hatch, capture, Publish coordination, and deletion. A
connected service alone is not create-capable.

### Proof boundary

The single-executable gate must prove:

- exactly one release file for each of the four native targets and no adjacent runtime asset;
- native `--help`, `--version`, canonical command help, `skills show`, JSON envelopes, and a real
  PTY-driven TUI launch from an empty home without Bun, Node, Pi, Docker, or a source checkout;
- no local Pi process, authority, package store, or hidden user-Pi import;
- fresh and interrupted setup from the embedded release-matched deployment payload;
- signed GHCR image-manifest selection, exact digest deployment, real image probes, and no local
  image build during ordinary setup;
- complete current browser asset deployment with no local browser server;
- protected credential entry and absence from process listings, files, journals, diagnostics,
  updater state, embedded content, Alchemy state, browser output, and Session compute;
- canonical path permissions, secret-free crash recovery, automatic pruning, self-unpair, and
  uninstall ambiguity retention;
- signed check-only update, candidate verification, atomic replacement and interruption safety;
- same-binary Runner service installation with no copied Pi or GitHub credential; and
- deletion of the desktop application, sidecar, Legacy CLI/state authority, and compatibility
  packaging during clean cutover.

This is the selected operator shape:

```text
verified installer
       │
       ▼
one native scotty executable
  ├─ CLI + in-process TUI + canonical Skill
  ├─ embedded Worker/browser/infra deployment payload
  ├─ signed release + managed Sandbox image manifest
  └─ setup, credential input, update, browser handoff, doctor, Runner service
       │
       ├─ deploys Worker + browser assets + state owners
       ├─ selects ghcr.io/.../scotty-sandbox@sha256:...
       └─ connects as terminal client or trusted Runner

deployed owners and provider runtimes remain remote authority
```

## Refined Runner distribution boundary

The signed release manifest binds the exact Runner executable, protocol, production OCI image, Pi
release, and capability manifest. Runner Sessions use the same production image digest as
Cloudflare Sessions. `runner setup` stages the exact executable, service, image, local roots, and
probes before it consumes the one-use setup grant. `runner update` drains, stages, proves, and then
activates the new release. The executable exposes only typed Runner operations. It has no general
host-execution channel and never copies paired-client, Pi, GitHub, or custom credentials into the
Runner root, service, workspace, or container.
