# Isolated inbound TCP and gRPC beta canary runbook

**Status:** proposed only. This sandbox had no verified beta entitlement, so this runbook was not executed.

**Hard rule:** never target Scotty production, production DNS, production Durable Objects, or real user sessions.

## Goal

Measure four Cloudflare capabilities independently without changing Scotty's public contracts:

1. Worker-served unary gRPC;
2. Worker-served server-streaming gRPC;
3. full-duplex Worker-to-Container gRPC;
4. Spectrum-to-Worker inbound TCP `connect(socket)`.

The canary answers whether native gRPC improves a warm console for terminal/TUI/desktop and whether any new path preserves authentication, Session DO authority, revision fencing, resume, cancellation, backpressure, and credential isolation. Raw TCP is a synthetic protocol probe, **not a shell or PTY**.

## Stop-before-start prerequisites

Do not deploy anything until every applicable box is satisfied.

### Enrollment and contracts

- [ ] Cloudflare has confirmed beta enrollment in writing for the isolated account.
- [ ] The supplied beta documentation names each enabled capability separately; access to one does not imply the others.
- [ ] Exact API/handler signatures, compatibility date/flags, supported Wrangler/types versions, and local-development limitations are recorded.
- [ ] Worker gRPC documentation specifies unary/server-stream mapping, HTTP/2, trailers, status, cancellation, deadlines, limits, and auth metadata behavior.
- [ ] Container documentation specifies request/response streaming, HTTP/2 and h2c/TLS termination, half-close, trailers, cancellation, sleep/relocation, and port binding.
- [ ] Spectrum documentation specifies the Worker/DO target field, edge port/DNS, TLS or passthrough, client address/Proxy Protocol, connection lifetime, deploy behavior, limits, and billing.
- [ ] Account team confirms plan and pricing. Assume custom TCP/UDP needs Enterprise plus the paid Spectrum add-on until told otherwise in beta documentation.
- [ ] The account exposes the required controls/API. Types or public `workerd` source alone do not count.

**Stop condition:** if any tested feature lacks a written contract or entitlement, mark that matrix row `BLOCKED — beta unavailable`. Do not infer configuration from source, social posts, or generic Spectrum/gRPC docs.

### Isolated environment

- [ ] Dedicated non-production Cloudflare account or explicitly isolated non-production stage.
- [ ] Dedicated zone or delegated canary subdomain with no production routes.
- [ ] Dedicated Worker, Session DO namespace, Container application, KV, R2 bucket, logs, and certificates.
- [ ] Synthetic client identities and synthetic session data only.
- [ ] Container image contains a deterministic echo/worklog fixture—no Codex auth, GitHub token, production repositories, or user archives.
- [ ] Spend alert, max instance count, test duration, and teardown owner are set.
- [ ] A second reviewer confirms the stage/account IDs are non-production before apply.

Suggested names, adjusted to the beta's documented syntax:

```text
stage: inbound-tcp-grpc-canary-<date>
gRPC host: grpc-canary.<isolated-zone> on 443
TCP host: tcp-canary.<isolated-zone> on one explicitly approved test port
```

Never reuse `scotty-worker`, production custom domains, production DO namespaces, or production backup buckets.

### Alchemy and source-first gate

Cloudflare resources remain owned by Scotty's single Alchemy v2 model.

- [ ] Read `vendor/alchemy` documentation, provider implementation, and tests for the exact resource before editing a canary stack.
- [ ] Verify the API against pinned Alchemy `2.0.0-beta.63` and Effect `4.0.0-beta.99` source.
- [ ] Use an Alchemy public resource if it supports the beta contract.
- [ ] If it does not, document the gap and implement at most one minimal Scotty-owned Alchemy custom provider storing only resource identifiers/digests.
- [ ] Do not add Wrangler/manual API state as a second reconciler.
- [ ] Review the Alchemy plan before apply and verify it contains only canary resources.

If the beta requires an SDK/type version incompatible with Scotty's pins, stop and record the incompatibility rather than patching production dependencies in the spike.

## DNS, Spectrum, and protocol assumptions to verify

Record actual beta values in a dated canary report; do not pre-fill unknowns.

| Item                 | Public baseline                                                                                        | Must be supplied/verified for beta                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| gRPC edge            | Proxied-origin docs require 443, TLS, HTTP/2 ALPN, `application/grpc`, Full SSL, and zone gRPC enabled | Whether Worker-hosted gRPC uses these controls, route/custom-domain mapping, certificate, trailers, and auth behavior |
| Spectrum plan        | Custom TCP/UDP is documented as Enterprise + paid add-on                                               | Exact beta entitlement and price                                                                                      |
| Spectrum create API  | Generic API is `POST /zones/{zone_id}/spectrum/apps` with DNS/protocol/origin model                    | Documented Worker/DO target field and lifecycle                                                                       |
| TCP DNS/port         | Spectrum application owns edge DNS/protocol                                                            | Approved port/range, CNAME/A behavior, IPv4/IPv6, certificate, SNI, TLS/passthrough                                   |
| Inbound handler      | Experimental type is `connect(socket, env, ctx)`                                                       | Production compatibility date/flag and whether edge TLS is removed before handler                                     |
| Client identity      | Public source does not establish original address delivery                                             | Client address, Proxy Protocol, mTLS identity, revocation, and spoofing guarantees                                    |
| Container service    | Public helper is HTTP `getTcpPort(port).fetch(...)`                                                    | Exact native gRPC/h2/h2c binding and health check                                                                     |
| Hibernation/lifetime | No public beta contract                                                                                | Worker/DO hibernation, max stream duration, code deploy and runtime update behavior                                   |

Capture redacted screenshots or API schemas from the enrolled account as evidence. Do not copy account tokens, certificate private keys, capability values, or proprietary beta text into repository logs.

## Canary architecture

```text
Browser baseline -----------------> current HTTPS snapshot/SSE/POST

Native canary client -- TLS ------> isolated Worker gateway
                                   -> canary Auth/Session DO
                                   -> synthetic unary/server stream
                                   -> optional synthetic Container gRPC service

TCP probe client ----- TLS? ------> isolated Spectrum app
                                   -> Worker connect(socket)
                                   -> canary Auth/Session DO decision
                                   -> bounded framed echo only
```

There is no client-to-Container address. The Container cannot authorize sessions and cannot store authoritative lifecycle state.

## Authentication and per-session capability design

Use synthetic client authentication through the Worker gateway. Do not send a root account token, provider credential, or Container sentinel over gRPC/TCP.

### Capability issuance

1. Client authenticates to an isolated HTTPS issuer using a synthetic paired-client credential.
2. Worker asks the canary Session DO for a short-lived capability.
3. Capability is random and opaque. Persist only a keyed digest and metadata in the DO.
4. Bind it to:
   - client identity;
   - session ID;
   - exact session revision and current epoch;
   - operation scopes (`observe`, `command`, or `tcp-probe`);
   - transport and endpoint;
   - short expiry and optional single-connection nonce.
5. Return the value once over TLS. Keep it only in client memory.
6. Revoke on client revocation, lifecycle transition, revision change, timeout, or canary teardown.

If the beta supports mTLS, use it as an additional device/channel identity. mTLS does not replace the capability, session scope, revision check, or command authorization.

### gRPC use

- Put only the scoped capability in authorization metadata; never put it in the URL.
- Bound metadata and message size before decoding.
- Each request/message carries operation ID, session ID, expected session revision, and protocol version.
- Event subscriptions also carry epoch and last accepted sequence.
- Commands carry command ID and intent digest and return a typed receipt/conflict.
- The Worker asks the Session DO to authorize every mutation. A stream established while revision N was valid cannot mutate revision N+1.
- Propagate deadline/cancel through gateway, DO adapter, Container adapter, and synthetic service.

### TCP probe use

- The first length-bounded frame contains protocol version, capability, session ID, expected revision, and nonce.
- Until the Worker and Session DO accept it, forward **zero** application bytes.
- After acceptance, allow only typed `echo`, `observe`, `cancel`, and `close` canary frames with bounded payloads.
- Reauthorize every mutating frame and terminate immediately on revision/status/operation mismatch.
- Do not support shell commands, terminal control bytes, arbitrary destinations, CONNECT, port selection, filesystem access, or sentinel forwarding.
- Reject timeout, oversized/partial preface, unknown version, replay, cross-session capability, and unauthenticated slow-read attempts.

## Build and review sequence

1. **Freeze baseline.** Run the current HTTP/SSE warm-session benchmark first.
2. **Implement synthetic protocol only** under a new isolated canary directory/stage. Do not edit production routes.
3. **Review Alchemy plan.** Confirm no production names/IDs and no secret values in state/output.
4. **Deploy unary only.** Prove auth/revision/error mapping before streaming.
5. **Add server stream.** Prove cursor resume, cancel, and slow-reader bounds.
6. **Add Container bidi separately.** Do not reuse its result as proof of Worker serving.
7. **Add TCP probe last.** It must have a distinct hostname/port and no Container forwarding.
8. **Run forced fallback.** Remove entitlement/endpoint advertisement and prove native clients return to HTTP/SSE.
9. **Collect sanitized evidence.** Record versions, stage IDs as hashes, timestamps, metrics, and failures.
10. **Destroy the stage.** Complete the cleanup verification before interpreting product fit.

## Functional and security test matrix

| Area                 | Test                                                                             | Required result                                                                       |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| HTTP baseline        | Snapshot, SSE cursor reconnect, command receipt                                  | Existing behavior and latency recorded; no contract changes                           |
| Unary gRPC           | Authenticated snapshot/read                                                      | Same projected data and revision as HTTP baseline                                     |
| Unary gRPC           | Valid command with expected revision and command ID                              | One mutation and verifiable receipt                                                   |
| Unary gRPC           | Duplicate command                                                                | Same receipt/no duplicate side effect                                                 |
| Unary gRPC           | Missing/expired/revoked/cross-session capability                                 | Typed denial before Container/Pi forwarding                                           |
| Unary gRPC           | Stale revision or active lifecycle operation                                     | Typed stale/busy result from Session DO                                               |
| Server stream        | Subscribe from current epoch/sequence                                            | Ordered events, no gaps or duplicates                                                 |
| Server stream        | Disconnect, reconnect from cursor                                                | Exact replay or explicit snapshot-required result                                     |
| Server stream        | Slow reader and paused reader                                                    | Queue/bytes remain bounded; cancellation or typed resource exhaustion                 |
| Server stream        | Client deadline/cancel                                                           | Prompt propagation and resource release                                               |
| Server stream        | Revision/client revocation mid-stream                                            | Stream closes; later command rejected                                                 |
| Container bidi       | Simultaneous request and response messages                                       | Both directions progress without buffering entire bodies                              |
| Container bidi       | Half-close each direction                                                        | Behavior matches supplied beta contract                                               |
| Container bidi       | Trailers/status/error                                                            | Exact client-visible mapping documented and tested                                    |
| Container bidi       | Container sleep/restart/relocation                                               | Defined disconnect; reconnect uses DO cursor, never Container memory                  |
| Container bidi       | Slow client and slow Container                                                   | Bounded queues and visible backpressure in both directions                            |
| Raw TCP              | Valid bounded synthetic capability preface                                       | Worker asks Session DO, then framed echo succeeds                                     |
| Raw TCP              | No/invalid/replayed/stale capability                                             | Connection closes before application forwarding                                       |
| Raw TCP              | Oversized/partial/slow preface                                                   | Bounded memory/time and deterministic close                                           |
| Raw TCP              | Lifecycle transition during connection                                           | Connection closes on revision/status mismatch                                         |
| Raw TCP              | Attempted shell bytes/arbitrary destination                                      | Protocol rejection; no shell or proxy behavior                                        |
| Raw TCP              | Direct Container address attempt                                                 | No routable endpoint exists                                                           |
| Browser              | All beta features advertised                                                     | Browser still uses HTTP/SSE/POST                                                      |
| Native fallback      | Beta DNS/entitlement unavailable, gRPC blocked, HTTP/2 proxy failure             | TUI/desktop select current HTTP/SSE without losing resume/auth                        |
| Runner regression    | Existing runner connect, credit, cancel, hibernation tests                       | Unchanged; beta path is not involved                                                  |
| Credential isolation | Scan messages, metadata, logs, state, outputs, process args, Container env/files | No real credential/sentinel; synthetic capability values absent from persistence/logs |

## Network test matrix

Run each native-client case from:

- low-latency broadband;
- 100 ms RTT plus 1% packet loss traffic shaping;
- mobile hotspot with a forced network change;
- corporate HTTP proxy/VPN that permits HTTPS but may restrict HTTP/2;
- IPv4 and IPv6 where the beta documents both;
- a network that blocks the Spectrum test port.

Expected fallback: gRPC/TCP failure never downgrades authentication. Native clients use HTTPS only when transport selection says the current endpoint is available. Raw TCP has no transparent fallback into a shell; the user returns to the Pi worklog transport.

## Measurements

Use the same warm synthetic session, payload distribution, region pair, and client build for baseline and candidate. Record raw samples outside the repository if they contain account topology; commit only aggregates.

### Latency

For at least 30 connection samples and 200 steady-state operations per network condition, record:

- DNS + TCP + TLS + HTTP/2/channel-ready time;
- authenticated first-byte / first-event time;
- unary snapshot and command receipt RTT;
- event production-to-client latency;
- reconnect-to-first-missing-event time;
- cancel-to-resource-release time;
- Container wake separately from warm transport latency.

Report count, median, p95, p99, min/max, failures, and confidence caveats. Do not combine cold/warm or successful/failed attempts into one percentile.

### Throughput and overhead

Record:

- application bytes and wire bytes in each direction;
- messages/events per second;
- Worker CPU time, wall duration, invocations, and memory where available;
- DO requests/storage and active time;
- Container active time and whether a stream prevents sleep;
- Spectrum connections/bytes and billed units;
- client CPU and memory;
- JSON/SSE, protobuf, base64, and framing overhead separately.

### Backpressure

Send fixed-size messages while progressively slowing the reader. Record:

- maximum observed queue bytes/messages at client, Worker, DO adapter, and Container;
- time until producer blocking/flow-control signal;
- resource-exhausted/cancel threshold;
- fairness with 1, 8, and the documented maximum concurrent streams;
- whether one blocked stream stalls unrelated streams on the same connection.

Fail the canary if any queue grows without a documented bound or cancellation does not release it.

### Reconnect and resume

Inject disconnects at pre-auth, post-auth, mid-message, after command acceptance, before receipt, during event replay, on Worker deployment, and during Container restart. For each, record:

- reconnect duration and attempts;
- last sent/acknowledged epoch and sequence;
- missing, duplicate, and out-of-order event counts;
- duplicate command side effects;
- whether a snapshot was required;
- whether stale revision traffic reached the Container.

Acceptance requires zero unauthorized/stale mutations, zero duplicate side effects, and either exact event replay or an explicit snapshot-required result.

## Product-fit thresholds

A native gRPC candidate advances only if all security/correctness tests pass and it shows a repeatable user-visible benefit over current HTTPS—such as materially lower p95 warm first-event/command latency, simpler cancellation, or lower CPU/wire cost—across realistic networks. A fast lab result with worse proxy reachability or unclear billing does not qualify.

Raw TCP does not become a product candidate based on latency. It would additionally need a unique user need that gRPC/HTTPS cannot satisfy, public contracts, acceptable Spectrum cost/reachability, and a review explicitly approving a non-shell framed protocol. The current recommendation remains **do not ship it**.

Runner replacement is out of scope. Container bidi results do not justify removing Runner DO WebSocket framing or hibernation tests.

## Observability and no-secret logging

Allowlisted structured fields:

- timestamp;
- random request/connection ID;
- hashed stage/session/client identifiers using a canary-only log key;
- protocol/version/method;
- transport selected and fallback reason code;
- byte/message counts and queue depth;
- status class and typed error code;
- duration, cancellation, reconnect, and resume outcome;
- Worker/Container release version.

Never log:

- authorization metadata or cookie;
- capability value, nonce, certificate/private key, or bearer token;
- GitHub/Codex credentials;
- Container sentinel;
- request/response bodies, terminal bytes, command text, repository content, or Pi worklog content;
- raw session/client/account/zone IDs;
- complete DNS/API payloads if they contain account topology;
- environment variables, process arguments, Alchemy secret state, or stack outputs containing secrets.

Use synthetic marker strings and run Scotty's secret scanner over the canary artifacts. Treat unexpected body/metadata capture by tracing products as a stop condition.

## Abort conditions

Immediately stop traffic and begin cleanup if:

- any real credential or sentinel appears outside its authority boundary;
- unauthenticated/stale/cross-session traffic reaches Container/Pi;
- direct Container ingress is possible;
- session state diverges from Session DO authority;
- queues grow without bound;
- beta behavior contradicts supplied documentation;
- production account/resource identifiers appear in the plan;
- cost or traffic exceeds the pre-set cap;
- logs capture metadata or message content;
- the stage cannot be fully represented/destroyed by Alchemy.

## Cleanup

1. Stop clients and revoke all canary capabilities/client identities.
2. Ask Session DOs to close streams; verify no active connection remains.
3. Remove the Spectrum application before releasing its DNS/certificate.
4. Destroy the canary through the same Alchemy stage that created it.
5. Verify deletion of Worker routes/custom domains, Worker version, Container application/instances, DO namespace, KV, R2, certificates, DNS, Spectrum app, log sink, and temporary access policy.
6. Check Cloudflare inventory/API for orphaned resources and active billable connections.
7. Delete local synthetic certificates/tokens and temporary benchmark data.
8. Verify Alchemy state/output contains identifiers/digests only, then archive the sanitized plan/report according to project policy.
9. Run the secret scanner on committed artifacts.
10. Have the second reviewer sign off that no production resource changed and teardown is complete.

If a resource cannot be deleted, revoke routes/credentials first, disable traffic, notify the account owner, and keep the canary report open until inventory is clean.

## Canary report template

```md
Date / operator / reviewer:
Cloudflare account and stage (hashed):
Cloudflare docs/types/runtime versions:
Beta entitlements confirmed:
Alchemy version and plan digest:
Capabilities tested / blocked:
DNS, TLS, Spectrum, gRPC settings (non-secret):
Baseline aggregates:
Candidate aggregates:
Backpressure/reconnect results:
Auth/revision/credential-isolation results:
Unexpected behavior and support case:
Cost observations:
Cleanup inventory and reviewer sign-off:
Decision: reject / repeat / advance to a larger non-production canary
```

The first report should expect blocked rows. “Unavailable in enrolled account” is a valid result; inventing an endpoint or production result is not.
