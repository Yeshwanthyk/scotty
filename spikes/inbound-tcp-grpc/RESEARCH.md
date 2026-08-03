# Inbound TCP and gRPC transport research

**Research cutoff:** 2026-08-03

**Decision status:** architecture exploration only; no production code or deployment

## Executive decision

**A native gRPC transport could make Scotty feel more direct for the terminal TUI and desktop sidecar, but the publicly verifiable Cloudflare contract is not ready to build on. Raw TCP is not a better product transport.**

Recommended split:

- **Browser:** keep authenticated HTTP snapshot + SSE events + POST commands.
- **Normal terminal / `pi-scotty` TUI:** retain HTTP/SSE now; later prefer one native gRPC channel using unary calls plus a server stream only after the beta gates in this document pass.
- **Desktop:** use the same optional native gRPC implementation in the credential-owning Bun sidecar, not in Rust; retain HTTP/SSE fallback.
- **Lifecycle:** preserve the current HTTP API and its JSON/exit contracts. A future unary gRPC mirror is optional, not a replacement contract.
- **Runner link:** keep the outbound, authenticated, hibernatable WebSocket multiplex.
- **Pi RPC:** keep it loopback-only inside the sandbox.
- **Raw PTY / SSH-like access:** do not expose it. The retired terminal route should stay retired.
- **Raw TCP:** at most run a synthetic framed canary terminating at a Worker gateway. Never connect a client directly to the Container.

The potential native-client gain is one reusable HTTP/2 connection, binary framing, per-stream cancellation, and transport-level flow control. It does **not** remove Scotty's application-level epoch/sequence resume, command receipts, revision fencing, authentication, or Sandbox Durable Object authority.

### Review the executable policy

The spike models selection only; it calls no Cloudflare API and defines no production wire contract.

```sh
bun spikes/inbound-tcp-grpc/select-transport.ts current
bun spikes/inbound-tcp-grpc/select-transport.ts grpc-canary
bun spikes/inbound-tcp-grpc/select-transport.ts tcp-blocked
bun spikes/inbound-tcp-grpc/select-transport.ts tcp-canary
```

`current` falls back to HTTP/SSE. The canary scenarios demonstrate that native gRPC needs every auth/resume gate, raw TCP can only target a Worker authorization gateway, and raw PTY remains rejected.

## Evidence standard

Capability claims below use only primary Cloudflare documentation, repositories, generated types, commits, and examples. Detailed line-level citations and pinned source snapshots are in [SOURCE_NOTES.md](./SOURCE_NOTES.md).

Public evidence is internally transitional at the cutoff:

- Public `workerd` source and generated types contain an experimental inbound `connect(socket)` handler.
- Public Workers docs still say inbound TCP is impossible / “coming soon.”
- Public Spectrum docs describe TCP/UDP forwarding to an origin, not to a Worker.
- Public Worker and Container docs do not specify the announced gRPC serving contracts.

Therefore source presence proves implementation work, **not account availability or a production API contract**. No beta entitlement was available or tested, and nothing was deployed.

Pinned research snapshots:

- [`cloudflare/cloudflare-docs@a809ff0`](https://github.com/cloudflare/cloudflare-docs/tree/a809ff05841f6abbcfe0c185cbd5225ef9572d21), 2026-08-03.
- [`cloudflare/workerd@05e8689`](https://github.com/cloudflare/workerd/tree/05e868985ed7496ee7e162c22bce4f8a3f206038), 2026-08-03.
- [`cloudflare/containers@788237a`](https://github.com/cloudflare/containers/tree/788237af2d89396eb47b8ba974f7c3ccc16f53d0), 2026-06-18.

## Capability claims: verified versus unverified

| Claim                                                                             | Verified public evidence                                                                                                                             | Not publicly verified                                                                                                                                                                                             | Status for Scotty                                                                                                                          |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A Worker receives inbound TCP through `connect(socket)`, reached through Spectrum | Exact Worker and Durable Object handler types; `Socket` streams; runtime dispatch; local `workerd --experimental` sample. Handler landed 2026-03-23. | Spectrum-to-Worker target configuration, entitlement, TLS/client IP behavior, production compatibility flag/date, limits, billing, deploy/reconnect semantics. Current docs still say inbound TCP is unavailable. | **Private-beta/unverified product route. Do not depend on it.**                                                                            |
| A Container serves full-duplex bidirectional gRPC                                 | `workerd` contains generic simultaneous request/response streaming plumbing. Containers expose HTTP Fetch forwarding.                                | Native gRPC mapping, HTTP/2/trailers/status, API signature, bidi cancellation/half-close/backpressure, Container sleep behavior, config, SDK/types, entitlement and limits.                                       | **Private-beta/unverified.** Generic stream plumbing is not a Container gRPC contract.                                                     |
| A Worker serves unary and server-streaming gRPC                                   | Generic Worker Fetch and streaming responses exist. Cloudflare documents reverse proxying gRPC origins.                                              | Worker gRPC server mapping, trailers/status, routing, zone toggle behavior, compatibility, auth, limits, SDK/example.                                                                                             | **Private-beta/unverified.** Proxied-origin gRPC docs do not prove Worker serving.                                                         |
| A Worker calls a gRPC server                                                      | `cf.grpcWeb?: "passthrough"                                                                                                                          | "convert"`and experimental`auto_grpc_convert` describe edge conversion of an outbound gRPC-Web subrequest. Added 2026-06-12.                                                                                      | Public enablement, compatibility date, implementation example, supported streaming modes/destinations, failures, account scope and limits. | **Experimental, not a supported Scotty dependency.** It is conversion, not a native gRPC client API. |

### Exact public surfaces and prerequisites

Inbound handler type from generated Worker types:

```ts
type ExportedHandlerConnectHandler<Env = unknown, Props = unknown> = (
  socket: Socket,
  env: Env,
  ctx: ExecutionContext<Props>,
) => void | Promise<void>;

interface ExportedHandler<Env = unknown, Props = unknown> {
  connect?: ExportedHandlerConnectHandler<Env, Props>;
}
```

The delivered `Socket` has `readable`, `writable`, `opened`, `closed`, `close()`, and `startTls()`. See the [generated types](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L495-L542) and [Socket definition](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L3782-L3807).

The local TCP ingress sample uses compatibility date `2026-03-01`, the catch-all `experimental` flag, and `workerd --experimental`. That date is a sample setting, **not** a production enable date. Runtime source describes the flag as “Experimental, do not use,” requires module syntax, ties socket lifetime to the handler promise, and rejects inbound CONNECT TLS in this path. See the [sample](https://github.com/cloudflare/workerd/tree/05e868985ed7496ee7e162c22bce4f8a3f206038/samples/tcp-ingress) and [dispatch implementation](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/global-scope.c%2B%2B#L184-L239).

Cloudflare's documented generic Spectrum creation API is `POST /zones/{zone_id}/spectrum/apps`; the documented model supplies a TCP/UDP protocol, edge DNS, and an origin. It does not document a Worker target. Custom TCP/UDP requires Enterprise plus the paid Spectrum add-on. Universal SSL is not compatible with Spectrum, custom WAF rules do not apply, and IP Access rules are the documented filtering alternative. See [Spectrum](https://developers.cloudflare.com/spectrum/), [get started](https://developers.cloudflare.com/spectrum/get-started/), [configuration options](https://developers.cloudflare.com/spectrum/reference/configuration-options/), and [limitations](https://developers.cloudflare.com/spectrum/reference/limitations/). Public Worker docs simultaneously say inbound TCP is [coming soon](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations).

The public Container helper remains an HTTP API:

```ts
containerFetch(
  requestOrUrl: Request | string | URL,
  portOrInit?: number | RequestInit,
  portParam?: number,
): Promise<Response>
```

It calls `container.getTcpPort(port).fetch(...)`; it is not raw public TCP or a documented gRPC API. See [`container.ts`](https://github.com/cloudflare/containers/blob/788237af2d89396eb47b8ba974f7c3ccc16f53d0/src/lib/container.ts#L1151-L1206). Container architecture says all end-user requests pass through a Worker and users cannot make non-HTTP TCP/UDP requests directly to a Container: [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/).

The outbound experimental request property is:

```ts
grpcWeb?: "passthrough" | "convert";
```

It is gated by explicit, `$experimental` compatibility flag `auto_grpc_convert`, with no compatibility enable date. See [`cf.d.ts`](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/defines/cf.d.ts#L78-L88) and the [compatibility schema](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/io/compatibility-date.capnp#L1563-L1569).

For ordinary proxied gRPC origins, Cloudflare requires port 443, TLS, HTTP/2 advertised with ALPN, `application/grpc` content type, a proxied hostname, Full SSL mode, and the zone gRPC toggle. Cloudflare Access does not support that reverse-proxy gRPC path; another authentication mechanism is required. WAF inspects headers at connection establishment, not stream contents. These facts are baseline canary questions, not proof that Worker/Container beta gRPC shares the same contract. See [gRPC connections](https://developers.cloudflare.com/network/grpc-connections/).

## Current Scotty transport map

| Surface                       | Current path                                                                                                                | Security and state behavior                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser console               | `GET /s/:id/console/v1/snapshot`, SSE `GET .../events`, `POST .../command`                                                  | Worker authenticates client cookie and same-origin mutation; Session DO remains authority; events resume by epoch/sequence; commands carry expected revision, epoch, command ID/digest and return a verifiable receipt. |
| `pi-scotty` TUI / terminal UI | `HttpConsoleTransport` uses the same snapshot/SSE/POST projection                                                           | Bounded decode/timeouts and authenticated client credential flow; no direct shell or container credential.                                                                                                              |
| Desktop                       | Rust launches a Bun sidecar; sidecar uses `HttpConsoleTransport`; Rust-sidecar messages are NDJSON over stdio               | The sidecar owns the paired client credential. It is not put in Rust process state, environment, or messages.                                                                                                           |
| Lifecycle control             | Authenticated `/api/sessions/*` HTTP JSON routes                                                                            | Session DO serializes lifecycle operations and owns persisted state. Existing CLI JSON shapes and exit codes depend on these routes.                                                                                    |
| Warm sandbox Pi RPC           | `pi --mode rpc` on loopback; Session DO proxies a constrained HTTP/SSE projection to it with a session transport capability | Pi RPC is not public. The DO checks provider/status/revision and uses a sentinel only at the Container boundary.                                                                                                        |
| Cloudflare runner             | Runner initiates authenticated WSS to `/api/runners/:name/connect`; Runner DO owns hibernatable sockets                     | Custom v2 frames multiplex requests, probes, cancels, 32 KiB base64 chunks, explicit 128 KiB credits, and stream limits. Pending RPC state is activation-local.                                                         |
| Raw terminal                  | `/s/:id/terminal` returns `410 terminal_retired` after authentication                                                       | There is deliberately no shell/PTY product surface.                                                                                                                                                                     |

The current path costs a snapshot request, a long-lived SSE response, and independent command POSTs. That is more connection and JSON machinery than a native multiplexed channel, but it already has the hard correctness properties: resumability, command idempotency, browser reachability, and DO authorization.

## Proposed target map

| Client or link                 | Target transport                                                                                          | Why / condition                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser                        | **Keep HTTP snapshot + SSE + POST**                                                                       | Native browser gRPC is not universal; gRPC-Web does not supply the desired native server/bidi contract. Preserve same-origin cookie auth and public routes. |
| Normal terminal                | Use `scotty` / `pi-scotty`; **optionally native gRPC**, never generic `ssh`/`nc`                          | A native binary can carry auth metadata and reconnect cursors. The product remains the Pi worklog, not a shell.                                             |
| `pi-scotty` TUI                | Prefer native gRPC unary + server stream only when all capability gates pass; otherwise current transport | One channel could combine snapshot/commands/events while retaining the existing protocol semantics.                                                         |
| Desktop                        | Same optional gRPC client in the Bun sidecar, with HTTP fallback                                          | Maximizes code sharing with the TUI while keeping paired credentials out of Rust.                                                                           |
| Lifecycle                      | Keep existing HTTP contract; optionally mirror individual operations as unary gRPC later                  | Avoids breaking CLI JSON/exit behavior. Every mutating call still includes expected revision and idempotency identity.                                      |
| Browser-to-session runner view | Keep browser HTTP/SSE                                                                                     | A native transport behind the Worker must not leak into the browser contract.                                                                               |
| Runner link                    | **Keep outbound hibernatable WebSocket multiplex**                                                        | Worker unary/server streaming is not bidi. Container bidi terminates at the wrong trust/lifecycle boundary and does not prove Runner DO hibernation.        |
| Pi RPC                         | **Keep loopback-only**                                                                                    | Exposing it would bypass the constrained console projection and credential boundary.                                                                        |
| Raw PTY / SSH-like access      | **None**                                                                                                  | A shell broadens authority and invalidates command validation, receipts, audit boundaries, and credential isolation.                                        |
| Raw TCP beta probe             | Synthetic framed protocol to a **Worker gateway only**, isolated stage                                    | Measures the beta. It must not forward unauthenticated bytes or become a shell.                                                                             |

### Native gRPC gateway shape

If public beta documentation eventually verifies the path, native TUI/desktop traffic should terminate at a Worker/Session-DO-aware gateway:

```text
native client
  -> TLS + client authentication metadata
  -> Worker gateway
  -> Session DO authorization + authoritative revision/status check
  -> existing constrained Pi console projection
  -> loopback Pi RPC inside Container
```

The stream protocol must preserve these application fields even if protobuf encodes them:

- session ID and authenticated client scope;
- expected session revision on every operation;
- epoch and sequence cursor on observation/reconnect;
- command ID and intent digest for mutation deduplication;
- cancellation/deadline identity;
- typed command receipt or typed stale/conflict result.

A long-lived stream is not a permanent authorization lease. Reauthorize each mutating operation against the Session DO, and close/reconnect when revision, provider, status, operation, or client revocation changes.

### Raw TCP termination decision

**Do not terminate user TCP at a Container.** It would put routing ahead of Worker authentication and tempt the Container to become a session authority. It also has no documented public ingress path.

A canary may terminate at a Worker gateway only. Its first bounded frame must carry a short-lived, session-bound capability reference; before forwarding any application frame, the Worker must authenticate it and ask the Session DO to verify session ID, scope, expiry, revision, status, and inactive lifecycle operation. Every mutation remains revision-fenced and DO-authorized. The capability is never a real GitHub/Codex credential or Container sentinel.

Even with those controls, raw TCP should not ship as Scotty's console transport: it lacks standardized application resume, is commonly blocked outside ports 80/443, needs custom multiplex/framing/cancellation, depends on Spectrum Enterprise routing, and cannot serve browsers.

## Transport comparison

| Dimension                     | Current HTTP snapshot + SSE + POST                                                                                         | Unary + server-streaming gRPC at Worker                                                                                                                                                                                 | Bidirectional Container gRPC                                                                                                            | Raw TCP through Spectrum                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latency                       | Extra snapshot/POST requests; SSE stays warm. Cloudflare edge and DO work dominate many operations.                        | Reused HTTP/2 connection can reduce handshakes and command/event channel setup. Unary alone does not accelerate sandbox wake or DO checks.                                                                              | One full-duplex stream could reduce channel setup, but still must traverse Worker/DO authority; direct Container would be unacceptable. | Lowest framing overhead in principle; Spectrum and mandatory gateway still add hops. Difference is unlikely to dominate interactive model latency. |
| Streaming/backpressure        | SSE is one-way; browser streams provide bounded reads, while command POSTs are independent. App-level queues still matter. | HTTP/2 stream flow control and native client libraries improve per-stream backpressure; server queues still need explicit bounds.                                                                                       | Natural full duplex and flow control if trailers/half-close are correctly supported—currently unverified.                               | Byte-stream backpressure only. Message boundaries, credits, queue bounds, and fairness become Scotty code.                                         |
| Reconnect/resume              | Already explicit: snapshot plus epoch/sequence SSE resume and idempotent commands.                                         | Must carry the same epoch/sequence and command IDs. gRPC reconnect does not replay application state automatically.                                                                                                     | Same requirement; one broken bidi stream otherwise loses both directions.                                                               | No standardized resume. Scotty would have to invent and test it.                                                                                   |
| Multiplexing                  | Logically separate fetches; HTTP/2 may share a browser connection but app channels remain separate.                        | Multiple unary and server streams share one HTTP/2 connection. Good fit for several sessions/views.                                                                                                                     | One or multiple bidi streams can multiplex, but application-level fairness may still be needed.                                         | One stream unless Scotty invents channel framing and fairness.                                                                                     |
| Binary overhead               | JSON/SSE text. Runner's separate protocol base64-encodes binary chunks.                                                    | Protobuf avoids JSON and base64 for native clients; small console messages mean modest absolute savings.                                                                                                                | Same potential saving.                                                                                                                  | Minimal framing, but a safe protocol must add lengths, types, IDs, auth, and checksums/limits.                                                     |
| Hibernation                   | Current runner WebSockets have a known DO hibernation model. SSE/session behavior is established in Scotty tests.          | Worker/DO server-stream hibernation behavior is not publicly specified. A live stream may hold execution/client resources.                                                                                              | Container sleep/relocation with an active bidi stream is unverified.                                                                    | Experimental handler promise owns socket lifetime; no public DO/Spectrum hibernation contract.                                                     |
| Cancellation                  | Fetch abort and explicit command semantics; runner has explicit cancel frames.                                             | gRPC deadlines and per-stream cancellation could simplify native clients if propagated through Worker, DO, and Pi.                                                                                                      | Potentially strongest full-duplex cancel, but propagation and half-close are unverified.                                                | Must invent cancellation frames or close the whole connection.                                                                                     |
| Observability                 | Existing request IDs, route logs, typed responses, and bounded no-secret logging.                                          | Method/status/deadline metrics are useful, but message bodies and auth metadata must never be logged. Cloudflare trailer visibility is unknown.                                                                         | Requires correlation across edge, Worker, DO, Container and Pi; beta telemetry unknown.                                                 | Harder method attribution without parsing custom frames; connection logs can leak capability or terminal bytes.                                    |
| Auth / mTLS                   | Paired client credential/cookie and same-origin rules are implemented. DO reauthorization is explicit.                     | Metadata can carry a paired credential or short-lived capability over TLS. mTLS may strengthen device identity but is not a replacement for session scope/revision checks. Cloudflare Access support cannot be assumed. | Container must never receive root client or real provider credentials; Worker/DO must authenticate first.                               | Spectrum TLS/mTLS details for Worker targets are undocumented. First-frame auth occurs after TCP accept and must precede forwarding.               |
| Mobile/corporate reachability | Best: HTTPS/SSE on 443 traverses common proxies and captive networks.                                                      | Usually good on 443, but some proxies break HTTP/2, gRPC trailers, or long streams. Mandatory HTTP fallback remains valuable.                                                                                           | Same external gRPC constraints plus beta path risk.                                                                                     | Weakest: arbitrary TCP ports are often blocked; TLS interception and captive portals complicate it.                                                |
| Cost                          | Existing known Worker/DO/Container traffic model.                                                                          | Beta pricing, duration accounting, and stream limits are unknown. Potentially fewer requests, potentially longer billed connections.                                                                                    | Container uptime and stream billing are unknown; could inhibit sleep.                                                                   | Custom TCP/UDP requires Enterprise + paid Spectrum add-on; connection/egress pricing and beta terms need written confirmation.                     |
| Lock-in                       | Standard web primitives and portable application resume semantics.                                                         | Protobuf is portable, but Worker serving/conversion flags and edge behavior are Cloudflare-specific private beta.                                                                                                       | Strongest lock-in to undocumented Worker-to-Container behavior.                                                                         | Strong lock-in to Spectrum target routing and experimental `connect` semantics.                                                                    |

## Could one gRPC transport serve both TUI and desktop?

**Yes, architecturally. Not yet operationally.** Both native clients need the same three logical operations: snapshot/unary reads, command/unary mutations, and a resumable server event stream. A shared TypeScript transport package could run directly in `pi-scotty` and in the desktop Bun sidecar, with the existing `HttpConsoleTransport` behind the same interface as fallback.

This could simplify:

- connection management and keepalive;
- binary encoding/decoding;
- per-call deadlines and cancellation;
- concurrent session streams on one native connection;
- duplicated event/command retry plumbing in native clients.

It must **not** simplify away:

- public HTTP routes or browser behavior;
- paired-client auth and revocation;
- Session DO state ownership;
- session revision, epoch/sequence resume, and command receipts;
- no-secret logging and Container sentinel isolation;
- fallback when beta/account/network capability is absent.

The selector in [`transport-selection.ts`](./transport-selection.ts) encodes those gates. Current public evidence intentionally produces HTTP/SSE fallback.

## Could gRPC replace runner WebSocket framing?

Not from the announced evidence.

The current runner protocol is more than serialization: it provides an outbound trust direction, Runner DO socket ownership, hibernation attachments, probe correlation, request/response cancellation, bounded stream counts, and explicit byte credits. Replacing JSON/base64 framing with protobuf could reduce CPU/wire overhead, but only a verified **bidirectional Worker/Runner-DO transport** with equivalent hibernation and reconnect semantics could remove the framing machinery.

- Worker unary + server streaming cannot carry runner-to-Worker client streaming.
- Container bidirectional gRPC terminates at the Container, not the Runner DO, and would invert or bypass the existing authority/routing boundary.
- Outbound gRPC-Web conversion does not prove a hibernatable inbound gRPC server.

Keep the runner WebSocket. A later, separate codec-only experiment could compare protobuf binary WebSocket frames while preserving credits, cancellation, and attachments.

## Threat model

### Assets and trust boundaries

Assets: paired client credentials, authoritative session record/revision, Pi worklog, command receipts, real GitHub/Codex credentials, Container sentinels, backups, and logs.

Trust boundaries:

1. native/browser client to Cloudflare edge;
2. edge/Spectrum to Worker gateway;
3. Worker/Auth DO to Session DO;
4. Session DO to Container constrained transport;
5. Container loopback to Pi RPC;
6. Runner to Runner DO outbound WebSocket.

### Threats and required controls

| Threat                                                          | Control                                                                                                                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated TCP becomes a shell                             | No raw PTY. TCP canary accepts only a bounded protocol preface, authenticates before forwarding, and has no shell command.                                                                      |
| Stolen capability is replayed                                   | Short expiry, random opaque value, digest-only server persistence, session/client/scope/revision binding, replay accounting, TLS; mTLS/channel binding if the beta supports it.                 |
| Stale stream mutates a replaced/restarted session               | Reauthorize every mutation against Session DO; require expected revision and epoch; close stream on lifecycle change.                                                                           |
| Cross-session confused deputy                                   | Route by authenticated session ID, not client-provided Container address; capability and request IDs are session-bound.                                                                         |
| Direct Container path bypasses authority                        | No public Container address; all ingress terminates at Worker/DO gateway; Container memory never owns session state.                                                                            |
| Real credentials or sentinels cross the transport               | Carry only client auth or a scoped capability reference. Never serialize provider credentials or Container sentinels into gRPC/TCP messages, metadata, URLs, logs, files, or process arguments. |
| Protocol downgrade silently loses safety                        | Server advertises accepted transport version and gates; client falls back to current HTTPS, never to unauthenticated TCP.                                                                       |
| Slow reader / oversized frame exhausts Worker, DO, or Container | Bounded preface/message sizes, stream/connection quotas, idle/deadline limits, flow-control tests, cancellation propagation, and per-client rate limits.                                        |
| Reconnect duplicates commands or loses output                   | Preserve command ID/digest receipts and snapshot + epoch/sequence replay; test gap/duplicate detection across disconnect/restart.                                                               |
| Beta change breaks routing or auth                              | Pin account entitlement/config, use isolated DNS/stage, contract-test every boundary, and retain automatic HTTP fallback.                                                                       |
| Logs leak tokens or terminal content                            | Structured allowlist logs only; hash stable identifiers; prohibit metadata/body/capability/sentinel logging; run the secret scanner.                                                            |

## Fit recommendation

### Adopt now

- Keep the current transport as the only production path.
- Keep the protocol-level fields transport-neutral so a future protobuf codec can represent them.
- Keep browser, lifecycle API, runner, Pi RPC, and credential boundaries unchanged.
- Use the executable policy spike to review routing and fallback behavior.

### Canary only after documented enrollment

1. Worker unary + server-streaming gRPC to a synthetic service, then the constrained console projection.
2. Shared native client adapter for TUI and desktop sidecar, with forced fallback tests.
3. A separate synthetic TCP framed echo/authorization probe at the Worker gateway.
4. Container bidi only after the exact Worker-to-Container HTTP/2/trailer/cancellation contract is supplied.

### Do not adopt

- raw shell, PTY, SSH, or `netcat` access;
- direct client-to-Container routing;
- TCP as lifecycle control;
- Container memory as resume/session authority;
- gRPC as a reason to delete HTTP routes or runner WebSocket framing prematurely.

## Explicit private-beta blockers

- No public enrollment or account entitlement instructions for any claimed ingress/gRPC beta.
- No documented Spectrum application field that targets a Worker/DO.
- No production compatibility date/flag for inbound `connect`.
- No documented edge TLS, mTLS, client IP, Proxy Protocol, port, duration, deployment, hibernation, billing, or abuse behavior for Spectrum-to-Worker.
- No Worker gRPC server API for frames, trailers, status, unary/server stream mapping, limits, cancellation, auth, or observability.
- No Container bidirectional gRPC API/config/example or verified sleep/relocation behavior.
- `auto_grpc_convert` is experimental, with no public enable date or supported-mode contract.
- No verified Alchemy v2 public resource/binding support for the beta; adding a second reconciler is prohibited.
- No account beta access in this sandbox, so no live endpoint, latency, backpressure, reconnect, or cost result exists.

See [RUNBOOK.md](./RUNBOOK.md) for the smallest safe canary once those blockers are resolved.
