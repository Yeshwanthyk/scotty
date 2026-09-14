# Litter Codex app-server audit

Scope: Litter checkout `8703cedb9cb36f92fab07a656ae93846ab198aac`, with
comparison against Scotty's current `worker/src/agent/codex` and
`worker/src/session-actor`. This is a source audit; no Litter or Scotty runtime
was started. Litter's `AGENTS.md` identifies
`shared/rust-bridge/codex-mobile-client` as the single owner of mobile
transport, session, state, and reconnect behavior; the native clients are thin
projections.

## Findings

### Litter has separate local and remote startup paths

- The architecture map describes a Rust `MobileClient`/`AppStore` facade over
  patched upstream app-server code, with direct, SSH, Alleycat, local, and
  Slingshot transports. Notifications are reduced first and targeted reads
  repair gaps ([`docs/ARCHITECTURE.md` L7-L30](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/docs/ARCHITECTURE.md#L7-L30),
  [`docs/ARCHITECTURE.md` L37-L56](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/docs/ARCHITECTURE.md#L37-L56)).
- The shipping mobile local path is in-process: `ServerSession::connect_local`
  builds Codex config/auth, supplies `InProcessStartArgs` (client `Litter`,
  experimental API, channel capacity), calls
  `codex_app_server::in_process::start`, and routes `request`/`notify` plus
  `next_event` through a Tokio worker ([`connection.rs` L578-L719](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L578-L719),
  [`connection.rs` L721-L805](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L721-L805)).
  This is not a child-process protocol boundary.
- A separate direct-dist Mac Catalyst helper can attach to an existing
  `127.0.0.1` listener or resolve and spawn `codex app-server --listen
ws://127.0.0.1:{port}`. It probes TCP first, then polls WebSocket readiness
  for 20 x 250 ms; a returned handle owns only a child started by this call
  ([`local_server/mod.rs` L1-L17](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/local_server/mod.rs#L1-L17),
  [`local_server/mod.rs` L183-L221](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/local_server/mod.rs#L183-L221),
  [`local_server/mod.rs` L224-L306](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/local_server/mod.rs#L224-L306)).
  The module explicitly excludes sandboxed/App Store Mac and iOS.
- Plain remote startup constructs `RemoteAppServerConnectArgs` with a WebSocket
  endpoint, client metadata, experimental API, and capacity 256, then delegates
  to upstream `RemoteAppServerClient::connect`; Litter's wrapper comment says
  that client owns initialize/initialized, request routing, and event streaming
  ([`connection.rs` L808-L821](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L808-L821),
  [`connection.rs` L1166-L1204](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L1166-L1204)).
  The checked-out upstream Codex submodule is not initialized (`git submodule
status` reports `-13595c...`), so the exact upstream handshake frames could
  not be independently inspected here.
- SSH prefers `codex app-server proxy` over a Unix socket (daemon start,
  existing proxy probe, or detached Unix app-server launch); otherwise it tries
  consecutive remote ports, probes/reuses only a healthy WebSocket, launches a
  detached server with logs, forwards a local port, and waits for forwarded
  WebSocket readiness ([`ssh/bootstrap.rs` L1-L18](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/ssh/bootstrap.rs#L1-L18),
  [`ssh/bootstrap.rs` L71-L107](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/ssh/bootstrap.rs#L71-L107),
  [`ssh/bootstrap.rs` L110-L242](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/ssh/bootstrap.rs#L110-L242),
  [`ssh/bootstrap.rs` L438-L523](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/ssh/bootstrap.rs#L438-L523)).
  The proxy path uses a synthetic WebSocket URL while preserving any endpoint
  auth token when constructing the stream client ([`connection.rs` L1206-L1236](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L1206-L1236)).

### Reconnect is transport recovery, followed by UI/session resubscription

- Each remote runtime has a worker. A transport error on a request triggers up
  to five reconnect attempts with one-second delay and retries that same request
  once; a dropped event stream follows the same reconnect path. Notify and
  server-request replies are not retried ([`connection.rs` L1248-L1311](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L1248-L1311),
  [`connection.rs` L1597-L1696](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/connection.rs#L1597-L1696)).
- A transport is abstracted as `RemoteTransport::reconnect`, returning a fresh
  client and optional transport keepalive. The old keepalive is retained until
  the replacement is installed, and teardown closes it before drop
  ([`remote_transport.rs` L16-L89](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/session/remote_transport.rs#L16-L89)).
- On `Disconnected → Connected`, the health reader runs warmup and explicitly
  re-subscribes per-thread listeners because the server-side `ConnectionId`
  changed; otherwise turn-stream events would be silently dropped
  ([`mobile_client/event_loop.rs` L172-L235](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/mobile_client/event_loop.rs#L172-L235)).
  Saved-server reconnect chooses a plan from persisted mode/URL/SSH/Alleycat/
  Slingshot/local fields and skips already-connected records
  ([`reconnect.rs` L287-L416](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/shared/rust-bridge/codex-mobile-client/src/reconnect.rs#L287-L416)).
- iOS persists saved-server records in `UserDefaults`, reconnects remembered
  records on lifecycle resume, sends a network-change hint, then refreshes the
  snapshot and restores local auth state where required
  ([`SavedServerStore.swift` L8-L44](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/apps/ios/Sources/Litter/Models/SavedServerStore.swift#L8-L44),
  [`SavedServerStore.swift` L103-L138](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/apps/ios/Sources/Litter/Models/SavedServerStore.swift#L103-L138),
  [`AppLifecycleController.swift` L54-L80](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/apps/ios/Sources/Litter/Models/AppLifecycleController.swift#L54-L80)).

### State and persistence are not equivalent to Scotty's session authority

- Litter's architecture says `AppStoreReducer` owns canonical _mobile runtime_
  snapshots (servers, threads, summaries, live items, terminal, health, voice),
  while native models own platform-only persistence. This is an in-memory UI/
  client projection, with upstream reads repairing event gaps; it is not a
  durable lifecycle journal ([`docs/ARCHITECTURE.md` L37-L56](https://github.com/0xSero/litter/blob/8703cedb9cb36f92fab07a656ae93846ab198aac/docs/ARCHITECTURE.md#L37-L56)).
- Therefore Litter reconnect re-establishes a transport and rehydrates from the
  app server; evidence here does not show restoration of an interrupted hosted
  operation, backup ownership, or a provider-effect commit. This is an
  inference from the ownership map and reconnect code, not evidence that the
  upstream server lacks durable history.
- Scotty deliberately makes each process generation non-authoritative:
  `makeSession` says it owns no durable Session state. Its process adapter
  creates isolated `HOME`/`CODEX_HOME`, writes a managed provider config and
  sentinel env, then starts `app-server --listen stdio://` with a bounded input
  queue and no ambient environment (`worker/src/agent/codex/process.ts:208-287`).
  Its protocol startup validates `initialize` identity, sends `initialized`,
  performs `thread/start` or `thread/resume`, and on resume performs a
  `thread/read` durability readback (`worker/src/agent/codex/session.ts:1051-1159`).
- Scotty's durable authority is the Session Actor store (revision, journal
  sequence/tail, authority, and evidence with coherence checks), not the Codex
  process (`worker/src/session-actor/store.ts:16-29,151-212`). Resume is an
  ordered proof chain—restore current backup, confirm runtime, start/confirm
  supervisor, verify/confirm transport—and stale revision/nonce/phase results
  are rejected (`worker/src/session-actor/transitions/resume.ts:196-315`).
  This is materially stronger and differently scoped than Litter's mobile
  transport reconnect.

## Test evidence and limits

- Litter has unit coverage for local resolver/TOML escaping and an unused-port
  probe, but no test in `local_server/mod.rs` that launches a real Codex binary
  and completes readiness (`local_server/mod.rs:357-391`).
- Litter does have a deterministic JSON-line fake test proving a dropped stream
  reconnects and retries one request, including one reconnect and Connected
  health (`connection.rs:2074-2129`). The transport trait tests explicitly say
  they cannot construct a real public `AppServerClient` and therefore cover
  keepalive/drop ordering and trait-object shape only
  (`remote_transport.rs:92-100`).
- No live SSH proxy/daemon, remote shell, mobile lifecycle, or real upstream
  app-server handshake was exercised in this audit. The absent Codex submodule
  also limits protocol claims to Litter's call sites and comments.

## Direct evidence, inference, unknowns

**Direct evidence:** the cited Litter code has multiple startup transports,
bounded remote reconnect with one request retry, explicit listener resubscribe,
and platform saved-server persistence. Scotty code has isolated stdio process
generations, strict handshake/readback sequencing, and a durable actor proof
chain.

**Inference:** Litter's reconnect is continuity of a mobile client view over
server-owned threads, not recovery of a hosted sandbox lifecycle. Its saved
server record is a locator/credential reference, not proof that a particular
runtime generation or interrupted operation was recovered.

**Unknown:** the exact initialize/initialized JSON and reconnect semantics of
the patched upstream `RemoteAppServerClient` require initializing and inspecting
Litter's `shared/third_party/codex` submodule (not done, per scope); neither
repository comparison establishes equivalence of Litter's mobile auth/keychain
model with Scotty's session-bound credential sentinels.
