---
shaping: true
status: active
---

# Portable execution plan

## Current position

Cloudflare is the production session provider. It runs Pi through the Sandbox native terminal and
bundled Ghostty Web. The control plane also supports user-named trusted runners: registration,
credential rotation, outbound connection health, desired state, Docker compute operations, and
removal are implemented.

Runner-backed session creation is deliberately disabled. The next runner milestone is a native Pi
terminal transport with the same user-visible session contract as Cloudflare. Registration must not
be mistaken for execution readiness.

## Requirements

- A session keeps one immutable provider binding.
- The Session Durable Object owns lifecycle, operation leases, credential policy, and checkpoints.
- Provider unavailability fails visibly; there is no silent fallback or migration.
- Runner name and installation name are required user inputs, never code constants.
- A runner initiates one authenticated outbound connection; no inbound host port is required.
- Docker workloads use digest-pinned images, bounded resources, dropped capabilities, and isolated
  per-session workspaces.
- Runner host credentials stay inside the owner trust boundary and never enter Cloudflare state,
  prompts, URLs, process arguments, logs, KV, R2, or API responses.
- Cloudflare sessions retain sentinel-only credential isolation.
- The container always includes the pinned Pi extensions and bundled skills.

## Shipped runner control plane

The standalone CLI can:

1. register a required runner name;
2. receive a one-time runner credential;
3. validate the local GitHub and agent credential sources;
4. install a hardened systemd user service;
5. connect outbound and answer correlated liveness probes;
6. list desired state, observed connection state, and assigned-session count;
7. rotate an existing registration with `--replace`;
8. disable, disconnect, and remove an unassigned runner.

The typed runner protocol supports ensure, inspect, argv-based exec, stop, remove, bounded output,
durable operation receipts, same-session serialization, cross-session concurrency, and ambiguous
exec fencing.

## Native Pi runner milestone

The runner provider reopens for session creation only after these slices pass:

1. Add a binary-safe, backpressured terminal stream to the runner protocol with resize,
   interruption, disconnect cleanup, and per-session limits.
2. Launch Pi from the same image-local `scotty-pi-shell` contract used by Cloudflare, including
   the configured extension set and initial-prompt consumption.
3. Authenticate the browser at the public Worker, then bridge terminal frames through the Session
   and Runner Durable Objects without exposing the runner credential.
4. Define checkpoint quiescence, workspace export/import, stop, resume, hard-cap, and host-reboot
   reconciliation with durable receipts.
5. Prove credential containment for a trusted runner and document the trust difference from
   Cloudflare sentinel isolation.
6. Run a real second-machine installation and simultaneous Cloudflare/runner canary.
7. Enable `--provider runner --runner NAME` only after the full gate is green.

## Extension packaging

The Pi extensions are image inputs, not optional developer checkouts. Seven source-based extensions
are stored as ordinary vendored directories under
`worker/container/pi-packages/sources/`; one extension is installed from its locked npm artifact.
The manifest records upstream repository, commit, load order, and image path. The package pin check
validates metadata, lockfiles, settings order, and container-auth order without requiring nested Git
repositories.

Upgrades are intentional dependency updates: replace the vendored source from the declared
upstream commit, refresh its lockfile if needed, update the manifest commit, run the package pin
check, and rebuild the image.
