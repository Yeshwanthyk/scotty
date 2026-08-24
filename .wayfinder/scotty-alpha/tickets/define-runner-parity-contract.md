---
title: Define the trusted-runner parity contract
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the canonical Session lifecycle
  - Define the Mirror, Fork, and Publish state machine
  - Define the thin Sandbox setup
---

## Question

Which lifecycle, isolation, repository, credential, backup, Hatch, health, recovery, and deletion guarantees must a trusted runner prove before Scotty may offer it for Session creation?

## Inherited lifecycle contract

Every offered provider implements `provisioning`, `warm`, `stopped`, and `gone`; complete checkpoint
and same-Session Resume; bounded Warm activations; dormant but activatable Hatch and screenshot or
video capture; provider-local model, Git, and scoped HTTPS brokers; one-operation plaintext handling;
credential-generation isolation; operation-bound Artifacts tokens; Publish coordination; and
proven Vaporize cleanup. Connection alone is insufficient.

## Inherited repository operation contract

Every offered runner must give the agent normal Git work on the same deterministic Session Fork.
It must prepare the same exact commit, base, check policy, configuration snapshot, and evidence; use
the same no-force-push controlled pull-request flow; inspect ambiguous writes; preserve human pull-
request state; and prove Fork cleanup. Runner-local Git state is never Publish authority.


## Inherited thin-Sandbox contract

Every offered runner must use the same pinned Pi release, one RPC supervisor, sanitized Pi behavior
settings, selected standard and administrator Plugins, dormant Hatch and capture capabilities,
sentinel brokers, readiness probes, staged failures, and Resume behavior as Cloudflare. A local
binary, connected runner, or separate dev image is not parity proof.


## Inherited local-state contract

A Runner uses a separate private root and may persist only its registration identity, workspace,
secret-free receipts, and recovery fences. Session sentinels exist only in broker memory for the
current epoch. Unresolved records never age out. Acknowledged terminal receipts retain at most
seven days or 250 records. Runner cleanup must prove each remote and local effect separately.


## Resolution

A trusted Runner is user-controlled Linux infrastructure that implements the same Session product
contract as Cloudflare through a different host adapter. Registration or a live socket is not
parity. A Runner remains unavailable for Session Create until it has a certified release, current
light health, orchestrator capacity, and deployed proof of every required lifecycle and security
capability.

### Authority and derived readiness

The Runner Registry owns user-supplied names, registration-identity digests, immutable Session
assignments, and provisional capacity reservations. Each Runner Durable Object owns its desired
mode, certified release and capability proof, current connection observation, light health facts,
and Runner operations. The Session Durable Object continues to own Session lifecycle, operation
lease, runtime epoch, checkpoint, grant, and cleanup duty. Runner files and processes never become
control-plane authority.

Runner readiness is derived freshly. A Runner is create-capable only when:

- its registration identity is valid;
- its desired mode is `accepting`;
- its current outbound connection is authenticated;
- its exact protocol, Runner binary, OCI image, Pi release, capability manifest, and setup snapshot
  match its full setup or update certification;
- light checks prove Docker isolation, brokers, disk, and orchestrator resource facts healthy; and
- the control-plane orchestrator can atomically reserve capacity.

Full lifecycle, Hatch, screenshot, and video proof runs at setup and update, not on every
connection. A current connection attests the certified digests and runs bounded light health. A
changed digest, failed health check, stale connection, or unavailable capacity removes create
capability without deleting registration.

### Registration and identity

Any authenticated paired terminal may authorize Runner setup. It requests a short-lived one-use
setup grant without copying its paired-client credential to the target. The target stages the
Scotty binary, system service, exact image, Docker isolation, local root, and probes first. It then
consumes the grant, receives its own Runner identity credential once, connects, and activates
registration only after capability proof succeeds.

Setup uses one idempotent operation. Failure before activation creates no active registration.
Ambiguity after a possible write inspects the exact Runner name, identity generation, connection,
and proof before retry. Identity replacement disconnects and invalidates the old Runner. The
Runner host persists only that registration identity under the local-state contract.

### Isolation and image

Docker is the only alpha production isolation mode. Direct host-process execution remains a
loopback development adapter and can never become create-capable.

Each Session uses one unprivileged container with:

- the exact versioned production OCI image selected by digest, never a mutable tag or arbitrary
  administrator image;
- no Docker socket, host home, host credentials, privileged mode, or broad host filesystem mount;
- a read-only base, bounded writable workspace and temporary storage, dropped capabilities,
  no-new-privileges, process and resource limits, and exact Session identity;
- one supervised Pi RPC process and the pinned deployed setup; and
- no direct Internet interface.

All container egress crosses the Runner host policy. Model, Artifacts Git, scoped HTTPS credentials,
and ordinary allowed HTTPS use provider-host brokers or the egress proxy. No real credential,
token, grant, or wrapping key enters the container, workspace, environment, arguments, Git config,
logs, receipts, checkpoint, or image.

The exact image manifest declares the resource profile for one Warm Session and the required host
reserve. The Runner reports bounded CPU, memory, disk, and current reservation facts. The control-
plane orchestrator decides slot capacity from those facts and profile, then owns reservations. It
does not trust a Runner-provided `available` boolean or infer a different provider.

Several Stopped Sessions may remain assigned. Warm concurrency is the orchestrator's current slot
decision. A full selected Runner returns typed `runner_capacity` with current reservations and
retry guidance. Scotty does not queue or fall back to Cloudflare silently.

### Assignment and Session Create

The user explicitly selects `runner:NAME`. The orchestrator rechecks readiness, reserves one slot
with the Session ID, operation nonce, resource profile, and expiry, and obtains an exact Runner
acknowledgement. Session Create then pins that Runner, image release, deployed snapshot, repository
commit, deterministic Fork, credential generations, and resource profile. Assignment is immutable;
Scotty never migrates the Session to another Runner or Cloudflare.

Create arms the Session hard cap before commit, provisions the exact container and setup, starts
the brokers and Pi RPC, creates the baseline Fork-plus-R2 checkpoint, and only then commits Warm.
A failed pre-commit reservation or runtime is released or retained as an exact retryable orphan.
A committed Session whose projection fails still exists. Cross-object replay uses the same Session
ID, nonce, assignment, runtime epoch, and reservation rather than creating a second runtime.

Stopped Sessions consume no Warm slot. Resume on the same Runner obtains a fresh slot, restores the
same pinned image/setup and exact checkpoint, advances runtime epoch, starts a new bounded hard-cap
activation, and proves readiness before Warm.

### Desired modes

Runner desired mode is separate from connection and Session lifecycle:

| Mode | Contract |
|---|---|
| `accepting` | Create and Resume may reserve capacity. |
| `draining` | Create and Resume are blocked. Existing Warm Sessions may finish or stop cleanly. Snapshot, stop, inspection, and cleanup remain available. |
| `disabled` | New broker authority is fenced and active compute is stopped through the safety path. Only inspection, reconciliation, and cleanup remain available. |

Changing mode never retargets a Session or claims its runtime stopped before proof.

### Brokers and protocol

The authenticated outbound Runner link carries typed, bounded operations for attestation,
reservation, provisioning, Pi RPC, broker streams, checkpoint, restore, Hatch, capture, quiesce,
stop, inspect, and remove. The production protocol has no general host command execution and no
administrator host shell. Pi may run ordinary shell work only inside its assigned Session
container.

The Runner host broker validates Runner identity, assignment, Session grant, pinned credential
generation, runtime epoch, operation, adapter, target, and scope. The Credential object decrypts
only the required generation. Plaintext travels over the authenticated link and remains in Runner
broker memory for one logical operation or stream, then clears. Disconnect, cancellation,
revocation, epoch change, Stop, or Vaporize closes streams and clears plaintext.

The Session sentinel may exist in Runner broker memory for the current assignment and runtime epoch
only. It never enters Runner files, receipts, logs, service configuration, or workspace. Artifacts
tokens remain operation-bound. Git reaches only the Session's deterministic Fork. Publish remains
the Config-owned repository operation and uses the same exact checked point and GitHub rules as
Cloudflare.

### Connection loss and local watchdog

An active assignment uses a persisted local control-lease deadline and the earlier Session hard-
cap deadline. The control plane renews the lease while the authenticated connection and assignment
remain current.

On connection loss, remote broker authority stops immediately and in-flight plaintext clears. If
the same identity, assignment, epoch, certified digests, and health recover before five minutes,
the control plane may renew the lease. Otherwise the local watchdog quiesces Pi and stops the
container without waiting for the Worker. A shorter hard-cap deadline wins.

An offline forced stop cannot create a remote checkpoint. It preserves the local workspace for
reconciliation but leaves the last proven Fork-plus-R2 checkpoint current. On reconnect, Scotty
reports the exact local observation and warns that newer work may be unretained. Local files never
become an authoritative checkpoint or authorize Resume.

### Checkpoint and Resume

Runner checkpoints use the same complete product meaning as Cloudflare. The Runner quiesces Pi,
synchronizes existing commits to the Fork without creating hidden commits, pins the exact Fork
revision, creates a canonical bounded workspace archive, and streams it through the authenticated
Runner link. The Worker writes immutable R2 bytes and verifies size and digest. Only then does the
Session owner atomically commit the checkpoint reference.

The Runner receives no R2 credential. Partial archives, uploads, or Fork writes do not become a
checkpoint. Restore streams and verifies the exact current archive, restores the Fork revision and
workspace, restarts the same Pi Session state, and retains the prior checkpoint until the new
activation is proven.

### Hatch, screenshots, and video

A normal Linux or VPS Runner implements Hatch and capture locally with the exact product image,
Chromium, Playwright, Xvfb, and ffmpeg. It does not depend on the Cloudflare Sandbox runtime or
`cloudflared`.

Browser Hatch HTTP and WebSocket traffic crosses the Worker Hatch gateway and multiplexes over the
Runner's existing authenticated outbound link to the assigned Session port. The Runner opens no
inbound public port. Screenshot and video jobs execute inside the Runner Session boundary and
stream bounded chunks through the link; the Worker stores immutable R2 evidence and the Session
owns metadata. Backend work leaves these capabilities dormant.

A Runner may register and connect without passing browser proof, but it cannot become Session
create-capable until Hatch, screenshot, and video parity pass. Cloudflare Tunnel may be added later
only as an explicit typed transport Plugin with its own credential and cleanup proof; it is not an
alpha path.

### Update and removal

Runner controls are `setup`, `list`, `show`, `drain`, `enable`, `disable`, `update`, and `remove`,
plus internal service `serve`. Update first drains, waits for Warm work to stop, stages the exact
binary and OCI digest, runs full parity proof, atomically switches the service, reconnects, and
returns to accepting only after light health succeeds. Old images and setup inputs remain while a
pinned Warm or Stopped Session needs them.

Normal removal drains and requires every assigned Session to be Vaporized. It then proves service
stop and removal, broker shutdown, container and workspace absence, receipt disposition, Runner
identity revocation and local removal, connection closure, and Registry removal. Remote absence or
disconnection alone does not prove host cleanup.

If a host is permanently lost, an explicit abandon operation revokes Runner identity and prevents
reconnection. Assigned Sessions must be reconciled and Vaporized from their remote owners where
possible. Scotty retains typed host-cleanup debt and never reports proven local deletion. Abandon
is not normal removal success and cannot silently discard possible local work.

Acknowledged terminal Runner receipts retain at most seven days or 250 records. Unacknowledged,
open, corrupt, or ambiguous receipts and recovery fences have no age expiry.

### Failure and proof contract

Every Runner result uses the common staged envelope: code, stage, Runner and Session target, exact
release and capability digest, operation ID, assignment and epoch, last proven effect, retained
state, ambiguity, safe retry, human action, and sanitized cause. Stages include registration,
preflight, image, certify, connect, attest, reserve, provision, broker, checkpoint, restore, Hatch,
capture, quiesce, stop, update, removal, and abandon. No result exposes a credential, sentinel,
token, raw provider response, unsafe URL, host secret path, prompt, or workspace content.

Deterministic local tests and a guarded real-Linux Runner canary must prove registration and
identity replacement, setup crash recovery, certified digest mismatch, light health loss,
orchestrator capacity races, reservation replay, strict modes, Docker escape boundaries, egress
policy, Pi RPC, every broker, exact Fork Git and Publish, atomic checkpoint and Resume, idle and
hard caps, five-minute offline lease, Hatch HTTP/WebSocket, screenshot and video, drain and update,
normal removal, lost-host abandon, receipt retention, and forbidden credential surfaces. Runner-
backed Session creation remains disabled until the full deployed canary passes.

This decision defines the product and parity contract. It does not implement it.

## Decision trail

- Use Docker only for production Runner Sessions.
- Let any paired terminal authorize a one-use Runner setup grant.
- Let the control-plane orchestrator derive and reserve machine capacity.
- Keep strict accepting, draining, and disabled modes.
- Use the exact production OCI image by digest.
- Revoke brokers immediately on disconnect and stop locally after a five-minute lease.
- Keep the last proven remote checkpoint authoritative after an offline stop.
- Hold decrypted credentials in Runner broker memory for one operation only.
- Stream checkpoints through the Worker to R2 without Runner R2 credentials.
- Run Hatch and capture on Linux and relay them through the existing outbound Runner link.
- Certify full parity at setup/update and verify digests plus light health on each connection.
- Return a typed capacity blocker rather than queueing or switching providers.
- Use typed Runner operations and remove general host command execution.
- Require no assigned Sessions for normal removal and use explicit abandon for a lost host.
