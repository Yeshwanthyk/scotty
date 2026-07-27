# Fixed execution locations for Scotty

Research snapshot: 2026-07-25. Scotty was inspected at
`bbda2839ff7ec5972e7d8836f5c7de97189555dd`. External claims use current
first-party documentation. This is an architecture research note, not approval
to change Scotty's public routes, CLI shapes, lifecycle semantics, or
credential boundary.

## Decision

Do not add `auto`, `prefer`, or `require` placement policies.

Choose one exact execution location when a session is created and make it
immutable for that session. Resume, reconnect, stop, and restart always address
the same provider resource. If it is unavailable, the operation fails visibly;
Scotty does not silently move the session.

The minimal model is:

```ts
type ExecutionLocation =
  | { venue: "cloudflare" }
  | { venue: "box"; boxId: string }
  | { venue: "slumbers"; containerId: string }
  | { venue: "exe"; vmName: string };
```

The implementation schema will need a provisioning state because a provider
resource ID is returned after creation. The important invariant is simpler than
the exact shape: the venue is committed before provisioning and never changes.

`auto`, `prefer`, and `require` would only answer questions Scotty does not need
to answer yet:

- `auto`: Scotty chooses a venue.
- `prefer`: Scotty tries one venue and falls back to another.
- `require`: Scotty must use one venue or fail.

A fixed location already has `require` semantics without introducing a policy
language, scheduling, fallback, or cross-provider migration.

The first release does not need a public placement option. A deployment default
can select the venue for new sessions while existing sessions remain on
Cloudflare. If explicit spawning becomes useful, add one exact `--on
cloudflare|box|slumbers|exe` option rather than a policy system.

## Recommended shape

Keep Cloudflare as the control plane and make only execution replaceable:

```text
browser / CLI
      |
Cloudflare Worker
      |
authoritative session Durable Object
  - fixed execution location and provider resource ID
  - lifecycle state and operation lease
  - credential vault
  - hard-cap and cleanup scheduling
  - terminal attachment leases
      |
      +-- current Cloudflare Sandbox adapter
      |
      `-- authenticated host connection
              |
       Box / Slumbers / exe.dev
       scotty host bridge
       Sheppard + Codex + workspace
              |
       Scotty checkpoint -> R2
```

This preserves the public product and its authority model. It does not attempt
to make the control plane portable.

## Is a resident runner necessary?

The earlier general-purpose `scotty-runnerd` was broader than the first
external backend needs.

No daemon is needed for lifecycle calls, file upload/download, SSH, or
one-shot commands. Box and exe.dev already provide enough API or SSH surface
for those operations.

A small resident host bridge is needed to preserve Scotty's actual interactive
contract:

- a live PTY rather than buffered command output;
- terminal input, output, resize, and cancellation;
- independent temporary `scotty-attach` PTYs;
- browser disconnect and reconnect without killing the Sheppard-owned agent;
- health, hard-cap, checkpoint, and cleanup coordination.

Box's own platform guide recommends exactly this daemon pattern when a platform
needs streaming, concurrency, or lower latency than one-shot commands provide
([Box platform guide](https://docs.ascii.dev/box/platform-guide)). exe.dev's
HTTPS command API explicitly has no stdin or PTY and a 30-second timeout
([exe.dev HTTPS API](https://exe.dev/docs/https-api)).

Keep the bridge narrow. It needs an authenticated outbound connection to the
session Durable Object, heartbeat and identity, PTY attachment messages,
Sheppard lifecycle calls, and checkpoint streaming. It does not need provider
selection, a scheduler, migration logic, or an abstraction for every possible
sandbox feature.

The outbound connection is the common path for all external locations. It lets
Slumbers remain private on Tailscale and avoids depending on undocumented
WebSocket behavior in provider HTTPS proxies.

## Candidate 1: Box by ASCII

Box is the best first managed external location.

It provides persistent Ubuntu VMs, SSH/SCP, Docker, a TypeScript SDK and HTTP
API, stop/resume, snapshots, and template-box forking. Files, installed
packages, and enabled systemd services survive stop/resume, while hand-run
processes do not. That fits a systemd-managed host bridge and Sheppard restart
path
([platform guide](https://docs.ascii.dev/box/platform-guide),
[long-running tasks](https://docs.ascii.dev/box/long-running-tasks),
[snapshots](https://docs.ascii.dev/box/snapshots)).

Use one Box per Scotty session:

1. Build a stopped template Box containing the pinned Scotty host bridge,
   Sheppard, Codex, and the execution container image.
2. Fork it with `noEnv: true`.
3. Persist the returned `boxId` in the authoritative session record.
4. Let the systemd host bridge connect outward to that session's Durable
   Object.
5. On managed stop, checkpoint to R2 and stop the Box.
6. On resume, resume the same `boxId`; systemd restores the bridge and Scotty
   resumes the logical agent from its workspace and thread state.

`noEnv: true` is mandatory. A normal Box can receive account, GitHub, and model
credentials; a no-env Box receives none of those
([Box secrets](https://docs.ascii.dev/box/secrets)). Keep the Box API key and
private route tokens in Cloudflare, never in the Box.

Box snapshots cannot replace R2. The product documentation describes automatic
and final filesystem snapshots, but the controlling Terms say snapshots are
generally retained only up to approximately 30 days, may be deleted earlier,
and have no data-retention or data-loss guarantee
([Box Terms](https://box.ascii.dev/terms)). Scotty should continue to commit its
own current and previous checkpoint generations to R2.

The largest unresolved issue is credential-safe egress. Box documents a
sudo-capable VM and in-guest firewall controls, but the reviewed first-party
documentation does not expose a provider-enforced outbound domain/CIDR policy.
Arbitrary repository code cannot be trusted with host root.

The viable design is therefore to treat the Box VM as the host and run the
actual Scotty workload in an unprivileged container with no Docker socket,
Tailscale state, host filesystem, or network-administration capability. A
root-owned host firewall must force that container through Scotty's
credential/egress broker. Prove DNS, IPv6, raw TCP, redirect, logging, process,
snapshot, and archive negatives before using real Codex or GitHub credentials.

## Candidate 2: Slumbers plus Cloudflare

Slumbers is the fastest owned-machine proof of the host bridge.

Tailscale supplies private operator access and SSH policy, but it is not a
provisioner, scheduler, snapshot system, or execution sandbox
([Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)). Tailscale
Serve is tailnet-only, so the Cloudflare control plane should not try to dial
Slumbers through it
([Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)).

Run one root-owned `scotty-host` systemd service on Slumbers. It creates one
locked-down container per session and maintains the outbound Cloudflare
connection. The session record is pinned to `slumbers` plus that container ID.

This avoids provider integration and is ideal for proving PTY reconnect,
Sheppard persistence, checkpointing, host reboot recovery, and hard-cap
cleanup. It is not the easiest supported production backend because Scotty
must own capacity, isolation, image updates, firewalling, disk health,
snapshots, orphan reconciliation, and host failure.

Use Slumbers as the development target for the host bridge, then run the same
bridge inside a Box template.

## Candidate 3: exe.dev

Do not start with exe.dev.

exe.dev provides persistent root Linux VMs, SSH, systemd, Docker, persistent
disk, and custom OCI images
([overview](https://exe.dev/docs/what-is-exe),
[customization](https://exe.dev/docs/customization)). Its main automation
surface is SSH, and its HTTPS command endpoint is deliberately too narrow for
Scotty's terminal.

The reviewed public docs also do not establish the stop/snapshot/export,
outbound-deny, hard-cap, lifecycle-event, or WebSocket contracts Scotty needs.
The same host bridge could make it work later, but it offers less lifecycle
leverage than Box and less prototyping simplicity than Slumbers.

## What stays on Cloudflare

The first external location should keep:

1. The Worker for public HTTP routes, UI/assets, CLI transport, browser auth,
   and terminal WebSocket ingress.
2. The session Durable Object for authoritative lifecycle state, immutable
   execution location, provider resource ID, operation leases, terminal leases,
   schedules, and credentials.
3. The Auth Durable Object for owner and device authority.
4. KV as the non-secret, eventually consistent session-list projection.
5. R2 as Scotty's immutable current/previous backup store.
6. Alchemy for Cloudflare infrastructure and deployment.
7. The Cloudflare credential and egress broker. External workloads receive only
   a session-bound sentinel/capability, never the real Codex or GitHub token.

Cloudflare Sandbox becomes one execution adapter, not the system's authority.
Provider state, provider snapshots, host heartbeats, and runner observations
cannot supersede the Durable Object record.

The main code seam is still `worker/src/session.ts`. The class both extends the
official Cloudflare Sandbox host and owns session lifecycle, scheduling,
backup, credential, and terminal workflows
([Sandbox host](../../worker/src/session.ts)). `SandboxRuntime`,
`SessionStore`, `CredentialVault`, `TerminalAttachments`, and
`SessionProjection` already provide useful partial seams, but the runtime and
backup capability types still expose Cloudflare SDK shapes
([runtime service](../../worker/src/sandbox-runtime.ts),
[backup service](../../worker/src/backup-store.ts)).

The first refactor should separate "authoritative session coordinator" from
"where commands and PTYs run" without moving authority out of Durable Object
storage.

## Smallest proof

1. Add an internal fixed execution-location record. Do not add public policies
   or automatic fallback.
2. Build the narrow outbound host bridge and run it on Slumbers with a fake
   agent. Prove terminal attach, disconnect/reconnect, resize, cancellation,
   host reboot, checkpoint, hard cap, and cleanup.
3. Put the same bridge in a stopped Box template and provision one no-env Box
   per session.
4. Prove Box stop/resume uses the same `boxId` and that R2 can restore the
   workspace after the Box snapshot is unavailable.
5. Only then build the non-bypassable egress container and run the credential
   negative matrix. Do not use real Codex/GitHub credentials before that gate.

The fastest useful experiment is Slumbers plus Cloudflare because it isolates
the host-bridge question. The first backend worth supporting as a product is
Box plus Cloudflare. exe.dev can wait.
