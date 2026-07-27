# Pican remote connections through the T3 Code model

Research snapshot: 2026-07-26. T3 Code was inspected at upstream commit
[`5719e8ac4020dda0e375ef61d044b61f55a0df8a`](https://github.com/pingdotgg/t3code/commit/5719e8ac4020dda0e375ef61d044b61f55a0df8a).
Only official T3 Code documentation and source are used below.

## Conclusion

The idea is viable if “work on remote sessions locally” means using the local
Pican UI to control a session whose execution and durable state remain on the
remote Pican host.

That is what T3 Code does. It does not download a remote session into a second
local T3 server or move provider execution to the laptop. Its desktop, web, and
mobile clients keep a catalog of environments. Each environment resolves to an
HTTP/WebSocket endpoint, and every session operation is sent to the selected
environment's server. The remote host continues to own provider processes,
projects, files, git state, terminals, and session state.

For Pican, the corresponding product shape is:

```text
local Pican shell
  - local environment
  - Cloudflare Pican
  - Slumbers Pican
  - Box Pican
          |
          | authenticated HTTP plus WebSocket or SSE
          v
selected remote Pican
  - authoritative sessions and transcript
  - Codex app-server process
  - workspace and git state
```

The local executable can still provide the whole UI. “Connection” should be a
client-side environment record, not another Pican profile and not a replicated
session database.

## What Pican already has

The current Pican checkout already implements the first half of this model.
[`internal/server/peers.go`](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/server/peers.go)
stores named remote Pican endpoints and an optional token, fans out
`GET /api/sessions?limit=50` to them concurrently with a three-second
per-peer timeout, and returns each host independently as online, unauthorized,
or unreachable. The token is used server-to-server and is never returned by
`GET /api/peers`.

The UI already exposes this under Settings → Machines and aggregates remote
sessions on the home page. A remote card is deliberately read-only and opens
the remote Pican's `/session?id=...` page in a new tab. The behavior and its
identity caveat are explicit in
[`docs/sequence-flows/peers.md`](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/docs/sequence-flows/peers.md):
session IDs are not globally unique, so a remote reference needs both the
machine and session identity. Pican can already publish its loopback server
through Tailscale Serve via
[`internal/app/tailscale.go`](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/app/tailscale.go).

This is a useful phase-one implementation, not yet a T3-style connection:

- It calls remote endpoints only to list sessions.
- Clicking a session leaves the local origin and uses the remote Pican UI.
- It does not proxy session snapshots, chat, cancel, files, git, or SSE.
- It identifies a peer by editable `name` and `baseUrl`, not a stable server
  identity.
- It stores a reusable shared token in local SQLite. That is tolerable for a
  personal Tailnet prototype, but it is not the credential model Scotty should
  expose to end users.
- Its URL validator accepts any absolute HTTP(S) URL. A hosted or multi-user
  deployment would need an egress/SSRF policy.

Pican's frontend currently makes same-origin, root-relative requests such as
`/api/session`, `/api/chat`, and `/events`. Therefore a path proxy such as
`/connections/:id/*` cannot transparently host the existing UI today. The
planned base-path work for `/s/:id` would remove that constraint. Until then, a
direct remote origin or a dedicated loopback reverse-proxy origin is simpler.

## T3 Code current architecture

### Discovery and connection

T3 Code models one running server as an execution environment with a stable
`environmentId`. A client-side saved environment records how that device can
reach it. The official architecture explicitly keeps remote support at the
environment connection layer and keeps the T3 server as the execution boundary
([`docs/architecture/remote.md`, `ExecutionEnvironment`, `KnownEnvironment`,
and `AccessEndpoint`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/docs/architecture/remote.md)).

There are four concrete connection targets in the current client runtime:
primary/local, saved bearer endpoint, managed relay, and desktop-managed SSH.
[`ConnectionResolver.prepare`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/connection/resolver.ts)
resolves all four into the same `PreparedConnection` shape containing the
environment identity, HTTP base URL, socket URL, and HTTP authorization.

Discovery is deliberately user- or platform-assisted rather than a global
daemon search:

- Direct pairing accepts a pairing URL or host plus pairing code.
  [`preparePairingRegistration`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/connection/onboarding.ts)
  resolves the URL, fetches the server's environment descriptor, exchanges the
  bootstrap credential, and creates a saved bearer registration keyed by the
  returned `environmentId`.
- The desktop SSH path can discover entries from the user's SSH configuration.
  [`DesktopSshEnvironment.discoverHosts` and `ensureEnvironment`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/desktop/src/ssh/DesktopSshEnvironment.ts)
  delegate to the shared SSH package. The SSH manager probes the host, launches
  or reuses a remote T3 server, and opens a loopback port forward.
- Direct LAN, Tailnet, HTTPS, and relay endpoints all become ordinary saved
  environments after onboarding. The hosted web app does not proxy them; the
  browser connects directly to the backend in the pairing link
  ([`docs/user/remote-access.md`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/docs/user/remote-access.md)).

SSH changes only launch and reachability. The renderer still uses normal
HTTP/WebSocket against the forwarded loopback port. The remote host remains
authoritative. [`startSshTunnel`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/ssh/src/tunnel.ts)
uses `ssh -L <local>:127.0.0.1:<remote>`, verifies forward establishment, keeps
the tunnel alive, and waits for HTTP readiness.

Saved environments are local device state. On web, the catalog and shell/thread
caches live in IndexedDB in
[`apps/web/src/connection/storage.ts`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/src/connection/storage.ts).
On desktop, environment records are file-backed and bearer secrets are
protected separately through Electron safe storage in
[`DesktopSavedEnvironments`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/desktop/src/settings/DesktopSavedEnvironments.ts).

### Authentication

Pairing is bootstrap-only. `t3 serve` or the desktop host creates a pairing
credential; a new client exchanges it at `POST /oauth/token` for its own
revocable authenticated session. Subsequent connections use that session
credential, not the pairing code. The full supported flow and revocation model
are documented in
[`docs/user/remote-access.md`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/docs/user/remote-access.md).

Authorization is scope-based. An ordinary paired client receives
`orchestration:read`, `orchestration:operate`, `terminal:operate`,
`review:write`, and `relay:read`; administrative desktop/CLI bootstraps also
receive access-management scopes. The official contract is in
[`docs/cloud/environment-auth.md`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/docs/cloud/environment-auth.md).

The bearer token is not placed in the WebSocket URL. Before opening a socket,
[`resolveRemoteWebSocketConnectionUrl`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/authorization/remote.ts)
uses the bearer token to request a short-lived WebSocket ticket, then connects
to `/ws?wsTicket=...`. Relay-managed connections use the same environment
boundary with DPoP-bound access tokens; they are another endpoint resolution
path, not a second session protocol.

Each WebSocket RPC is checked against its required scope in
[`apps/server/src/ws.ts`, `wsMethodRequiredScopes`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/ws.ts).

### Transport

The transport is ordinary HTTP plus one JSON RPC WebSocket:

- HTTP fetches the environment descriptor, exchanges credentials, issues
  WebSocket tickets, and can load initial shell/thread snapshots.
- The WebSocket carries finite RPC requests, durable subscriptions, and
  commands.

[`RpcSessionFactory.connect`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/rpc/session.ts)
opens the socket, constructs the Effect RPC client, and does not retry itself.
It considers a session ready only after the socket opens and
`server.getConfig` succeeds. Retry policy belongs to the environment
supervisor.

### Listing and opening sessions

The client does not ask every provider to enumerate native sessions. The T3
server exposes its own environment-wide orchestration read model.

[`OrchestrationShellSnapshot`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/contracts/src/orchestration.ts)
contains the environment's projects and thread summaries, including session
status and latest-turn metadata. `orchestration.subscribeShell` sends an
initial snapshot or replays events after the client's sequence cursor, then
streams live thread/project changes.

[`EnvironmentShellState.make`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/state/shell.ts)
hydrates the local cache first, loads a fresh HTTP snapshot when possible, and
subscribes with `afterSequence`. This is the data behind the environment's
thread/session list.

Opening a thread means routing by `(environmentId, threadId)` and subscribing
to `orchestration.subscribeThread`. The server sends an
`OrchestrationThreadDetailSnapshot` or catch-up events after the client's
cursor, then live events. The gap-free snapshot/replay/live handoff is
implemented by
[`apps/server/src/ws.ts`, `ORCHESTRATION_WS_METHODS.subscribeThread`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/ws.ts).

### Sending, steering, interrupting, and resuming

Client mutations resolve the currently active environment runtime at execution
time. [`startThreadTurn` and `interruptThreadTurn`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/operations/commands.ts)
dispatch `thread.turn.start` and `thread.turn.interrupt` through
`orchestration.dispatchCommand`. The command carries a client-generated
`commandId`, thread ID, and timestamp.

Steering is expressed through the same `thread.turn.start` command while a turn
is active. It is not a separate client-to-server transport. Provider adapters
decide how to realize it. Current Cursor, OpenCode, and Claude adapters
explicitly retain the active turn when a second prompt arrives. The Codex
adapter currently sends `turn/start` through
[`CodexSessionRuntime.sendTurn`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/provider/Layers/CodexSessionRuntime.ts);
there is no separate T3 WebSocket `steer` RPC.

Provider resume state is server-owned. The
[`ProviderSessionRuntimeRepository`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/persistence/ProviderSessionRuntime.ts)
persists each T3 thread's provider binding, status, opaque `resumeCursor`, and
runtime payload. When a provider process must be recreated,
[`ProviderCommandReactor.ensureSessionForThread`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)
recovers that cursor and passes it back into `startSession`. For Codex,
[`openCodexThread`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/provider/Layers/CodexSessionRuntime.ts)
uses `thread/resume` and falls back to `thread/start` only for recognized
missing-thread failures.

This resume is entirely remote. A local client reconnecting to a remote T3
environment does not launch a local provider process for that thread.

### Source of truth

The remote T3 server is authoritative for orchestration state and execution.
Its derived paths put the main database at
`<baseDir>/userdata/state.sqlite`
([`deriveServerPaths`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/config.ts)).
[`OrchestrationEventStore`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/server/src/persistence/Layers/OrchestrationEventStore.ts)
appends ordered events to SQLite, while projection queries produce shell and
thread snapshots. Provider resume cursors are also stored in that server
database.

Projects, files, git state, terminals, and provider processes remain on that
same execution host. The client-side IndexedDB or desktop persistence is a
catalog, credential store, and reconnect/offline cache. It is not an
authoritative replica.

### Reconnect and offline behavior

[`EnvironmentSupervisor`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/packages/client-runtime/src/connection/supervisor.ts)
is the only retry owner. Its current behavior is summarized precisely in
[`docs/architecture/connection-runtime.md`](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/docs/architecture/connection-runtime.md):

- Offline state closes the active transport and waits without consuming retry
  attempts.
- Transient failures retry indefinitely with exponential delay capped at 16
  seconds.
- Network changes, app activation, credential changes, and explicit retry wake
  the supervisor.
- Authentication and configuration failures remain blocked until an external
  input changes.
- Involuntary close preserves the environment registration and caches, then
  reconnects.
- Explicit removal closes the session and removes registration, credentials,
  and shell/thread caches.

Subscriptions switch to the replacement RPC session after reconnect. Cached
shell and thread snapshots remain visible offline, then resume from their
sequence cursors. The server attaches its live subscription before snapshot or
catch-up reads so events arriving during synchronization are buffered rather
than lost.

For SSH environments, reconnect first re-establishes or reuses the SSH bridge,
then follows the same WebSocket connection path. It does not introduce a
separate SSH session API.

## Implication for Pican

The smallest faithful adaptation is a multi-environment client layer in Pican:

1. Give every running Pican server a stable environment identity and a
   descriptor endpoint.
2. Save connections locally as
   `(environmentId, label, endpoint, access method, credential reference)`.
3. Route every UI selection and mutation by `(environmentId, sessionId)`.
4. Keep session lists, transcript details, send/steer/cancel, filesystem, and
   git operations server-owned.
5. Cache remote session summaries and transcripts locally only for fast startup
   and offline reading.
6. On reconnect, obtain a fresh authenticated stream and resume from a
   revision/sequence cursor or fetch a canonical snapshot.

Cloudflare, Slumbers, and Box should differ only in how Scotty starts and
publishes the Pican server and how the client reaches it. They should not
produce different Pican session protocols.

There are two viable network shapes:

- The local UI connects directly to each remote Pican endpoint. This matches
  T3 most closely but requires browser-reachable HTTPS/WSS, correct CORS/origin
  handling, and client-side secret storage.
- The local Pican backend connects to remote Pican and exposes one same-origin
  local UI. This avoids browser mixed-content and CORS constraints and can keep
  credentials outside JavaScript, but the local backend becomes an explicit
  authenticated proxy. It still must not become session authority.

The second shape is probably the better desktop experience for Pican, while a
hosted browser can use the first when each remote endpoint is already HTTPS.

## Recommended shape

Use the local-backend-proxied shape first:

```text
local browser
    |
    v
local Pican connection shell
    |
    | remote Pican device credential; never Codex/GitHub credentials
    v
remote Pican on Cloudflare, Slumbers, Box, or a VPS
    |
    v
remote workspace + app-server + git
```

The local Pican stores the connection catalog and protects the connection
credential. The selected remote Pican remains authoritative for the session,
transcript, workspace, provider binding, and live execution. The local instance
may cache read models, but it must never create a shadow local session or start
a local Codex process for a remote session.

This also keeps Scotty's provider boundary clean. Cloudflare, Slumbers, Box,
and a Hetzner VPS only determine how the remote Pican process is provisioned,
reached, stopped, and resumed. The local client always speaks Pican. Prefer a
stable Scotty session URL over a raw provider URL so a stopped Box can be
resumed and a session can move between backends without changing its connection
identity.

Start with direct Pican connections rather than a Scotty-wide aggregate
gateway. `scotty beam up` can return an **Open in Pican** pairing URL for the
new remote Pican. If managing many individual connections becomes noisy,
Scotty can later expose a discoverable catalog without changing the
Pican-to-Pican session protocol.

Authentication should copy T3's boundary, not Pican's current shared-token
storage:

1. The remote Pican issues a short-lived, one-use pairing code.
2. The local Pican exchanges it for a revocable, device-specific credential.
3. That credential is scoped to normal session operations and stored outside
   browser JavaScript.
4. The browser never receives the remote Pican credential, Codex auth, GitHub
   auth, or a Box API key.
5. Scotty or the remote Pican can revoke the device without rotating the
   sandbox's model credentials.

For reconnect, use canonical snapshot plus live stream first. Pican's current
SSE stream is a notification mechanism, not a durable replay log, so the local
client should refetch the remote session after reconnect before accepting new
events. A sequence cursor and offline transcript cache can come later if the
simple reconnect path proves insufficient. Do not queue prompts while offline
until command IDs make retries idempotent.

## Small vertical slices

1. **Prove the existing direct path.** Run Pican on Slumbers through Tailscale,
   register it in local Pican, aggregate its sessions, and open one through the
   existing deep link. No new protocol.
2. **Rename the concept.** Hard-cut `peers`, `peer_hosts`, and UI “Machines” to
   one term: `connections`. Add a stable `connectionId`; route remote
   references by `(connectionId, sessionId)`.
3. **Pair a device.** Add one-use pairing and revocable device credentials.
   Keep the credential server-side in local Pican.
4. **Open remotely in the local shell.** Add an active connection context and
   proxy only session read, SSE, send/steer, and cancel. After `/s/:id`
   base-path support lands, mount the remote Pican UI through the connection
   route rather than duplicating it.
5. **Add workspace operations.** Proxy the Pican file, diff, Git, model, and
   extension operations needed by the existing session UI. Do not expose
   remote update, restart, peer-management, or admin routes through a normal
   session credential.
6. **Hand off from Scotty.** Have `scotty beam up` print or open a pairing URL
   for the provisioned Pican. Use the same flow for Cloudflare first,
   Slumbers second, and Box third.

The acceptance proof for slice 4 is deliberately small: start a remote turn,
watch its streamed output in the local Pican shell, reconnect the local
browser, recover the canonical transcript, steer or send a follow-up, and
confirm that only the remote workspace changed.

## Not part of the connection feature

Moving execution from the remote host to the laptop is a separate handoff
feature. It would require transferring or recreating the Git worktree,
uncommitted files, provider resume state, runtime projections, and appropriate
credentials, then atomically changing session authority. T3 Code does not do
this, and Pican should not hide it behind “connect.”

Similarly, do not add a new lightweight Codex UI, a second app-server gateway,
or provider-specific client protocols. The remote Pican executable already
owns those responsibilities.

## Decisions still to make

1. What stable identity names one Pican environment across process restarts and
   Scotty stop/resume?
2. How will multiple remote Pican versions negotiate protocol compatibility
   with one local client?
3. If a remote Pican host is frozen and restored elsewhere, does it retain the
   same environment identity and credential/session database?
4. Should the home page merge all connections by default, or show the selected
   connection prominently while still offering an aggregate view?
