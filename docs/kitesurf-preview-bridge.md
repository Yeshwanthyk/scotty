# Kitesurf preview bridge

## Status

This document maps the current implementation and selects the smallest secure bridge that would let a **remote Cloudflare Kitesurf browser** reach one HTTP application port in one warm Scotty Sandbox container.

This is a target design, not a description of an already deployed route. Scotty has no preview ingress today. The bridge does **not** put a browser in the container, add `agent-browser`, or change the container image. Kitesurf remains a remote Browser Run client of a public HTTPS origin.

## Decision

Add an installation-scoped wildcard preview origin handled by the existing Worker:

```text
https://p<port>-<session-id>-<capability>.preview.<installation-domain>/<app-path>?<app-query>
```

The Worker recognizes that host before normal Hono routing and forwards the request to the one Sandbox Durable Object named by `<session-id>`. The Sandbox DO validates a short-lived, digest-stored capability for one exact port, verifies that the current container runtime is already warm, then uses `ctx.container.getTcpPort(port).fetch()` to stream the request to the application.

The capability is also an exclusive `preview` session operation lease. Snapshot, sleep, down, and resume cannot race an application request that can mutate the workspace. Expiry, revocation, hard cap, stop, and vaporize invalidate the capability and close active streams or WebSockets. Preview traffic never starts or resumes a container.

This shape is selected over a path prefix or the SDK's public preview-token facility because it preserves ordinary web origin behavior while keeping Scotty's authentication and lifecycle invariants authoritative.

## Current implementation map

### Public Worker surface

`worker/src/index.ts` exports one Hono application. Its relevant current routes are:

- `POST /api/sessions` and the session read/mutation routes under `/api/sessions/:id` (`worker/src/index.ts:420-579`).
- `/s/:id` for the authenticated worklog (`worker/src/index.ts:660-666`).
- `/s/:id/console/v1/:action` for the allowlisted Pi console relay (`worker/src/index.ts:611-658`).
- `/s/:id/*`, which authenticates and resolves the session but deliberately returns a fixed JSON 404 (`worker/src/index.ts:668-674`, `worker/src/index.ts:968-980`).
- Browser UI routes such as `/sessions`, `/stats`, `/devices`, and `/providers`.

All `/api/*` requests accept a root bearer or an authenticated browser client according to scope. Unsafe browser-client mutations additionally pass the same-origin/fetch-metadata check (`worker/src/index.ts:170-183`, `worker/src/index.ts:900-907`). A global guard rejects root tokens in `?t=` (`worker/src/index.ts:120-124`, `worker/src/index.ts:924-930`). Errors use the existing `{ "error": { "code", "message", "hint" } }` envelope.

The retired PTY ticket and PTY routes intentionally return 404 and are covered by route tests (`worker/test/routes.test.ts:2620+`). Deployed route tests also prove that `/s/:id` rejects a root token in a query, cookie, or bearer position and requires the browser client cookie (`e2e/tests/deployed-routes.test.mjs`). A preview must not revive those routes or reinterpret `/s/:id/*`.

### Browser clients, cookies, and tickets

`worker/src/auth.ts` defines the browser cookie as `__Host-scotty`. It is `Secure`, `HttpOnly`, `SameSite=Strict`, and host-only with `Path=/` (`worker/src/auth.ts:17`, `worker/src/auth.ts:136-148`). The root token remains bearer and recovery authority only.

The Auth DO owns pairing, browser ownership, standard clients, transfers, recovery, revocation, and authentication. It stores client credential digests, not raw browser credentials (`worker/src/auth-object.ts`, `worker/src/auth-registry.ts`). Standard clients have session read/write scopes; owner checks are separate.

`AuthPrincipal.source` still mentions `"ticket"`, but the live authentication path only creates root-bearer or client-cookie principals (`worker/src/auth.ts:31-71`). The Auth DO exposes no terminal-ticket registry and the old ticket routes are gone. A preview capability therefore must be a new, narrowly scoped Sandbox capability—not a browser client, cookie, root token, or resurrected terminal ticket.

### Sandbox DO and container transport

`ScottySandbox` extends the SDK `Sandbox` class, locally aliased as `BaseSandbox` (`worker/src/session.ts:1`, `worker/src/session.ts:250+`). It configures:

- `sleepAfter = "60m"`;
- HTTPS interception;
- disabled general Internet access; and
- an explicit outbound host allowlist (`worker/src/session.ts:260+`).

The DO retains the native `ctx.container` handle. Scotty's own `SandboxRuntime.fetchPort` adapter is currently a readiness/status convenience that calls `this.containerFetch(...)`; it is not a general external proxy contract (`worker/src/sandbox-runtime.ts:32-52`, `worker/src/session.ts:291-306`).

The existing passive Pi console relay is the closest ingress analogue. It first checks `ctx.container.running`, obtains `getTcpPort(43117)`, and calls `.fetch()` directly. It does not wake a sleeping container (`worker/src/session.ts:1556-1604`). The bridge should follow that passive transport property while applying a different port and header policy.

### Authoritative session lifecycle

The Sandbox DO owns the durable session record, current operation lease, hard-cap metadata, credentials, and backup handles. KV is only a non-secret list projection and R2 stores immutable backups.

Session states are `booting`, `warm`, `sleeping`, `failed`, and `gone`; current operation kinds are `create`, `snapshot`, `resume`, `down`, and `vaporize` (`worker/src/contracts.ts:65-80`). Hard caps default to four hours and are bounded to one minute through 24 hours (`worker/src/contracts.ts:6-8`). Create schedules the hard cap before committing the new session.

Only one operation may mutate a session. Snapshot and sleep stop Pi before sync and backup. Resume requires the current backup and installs a new hard-cap deadline. Idle expiry checkpoints then stops the container. Hard-cap enforcement checkpoints or destroys according to the current state. Vaporize persists retry state and continues until the container, backups, credentials, idempotency state, and projections are gone (`worker/src/session.ts`, `worker/src/session-lifecycle.ts`).

Preview HTTP methods are not inherently read-only: the repository application can write its workspace. Letting preview traffic bypass the operation gate would permit snapshot/sleep/vaporize races and ambiguous backups.

### Egress and credentials

Container egress is mediated by `ContainerProxy`. It permits only the configured OpenAI, GitHub, package-registry, and `scotty.internal` destinations; its catch-all denies arbitrary Internet access (`worker/src/egress.ts`). Real Codex and GitHub credentials are injected only at that boundary in exchange for session sentinels. The internal inspect/steer endpoint derives the source from the Cloudflare container identity and rejects ambient authorization, cookies, and proxy headers (`worker/src/container-session-egress.ts`).

A preview is ingress, so it does not weaken this egress boundary. Kitesurf receives only the preview URL. It must never receive the Scotty root token, `__Host-scotty`, Browser Run API credentials, GitHub credentials, Codex credentials, or container sentinels from the bridge.

### Infrastructure today

The Alchemy stack provisions the Worker, Auth/Runner/Sandbox DOs, KV, R2, assets, and Sandbox container (`infra/cloudflare-stack.ts`). There is no Browser Run binding, preview hostname, wildcard DNS record, or preview Worker Route. `worker/src/bindings.ts` likewise has no preview-domain setting.

Cloudflare Custom Domains do not provide wildcard DNS. Production preview ingress therefore needs an installation-supplied preview base, a proxied wildcard DNS record, and a Worker Route such as:

```text
*.preview.scotty.example.com/*
```

The name is installation configuration. It must not be inferred from a user, machine, repository, or Cloudflare account. `workers.dev` alone cannot provide this wildcard preview scheme.

## Verified Sandbox SDK behavior

Scotty pins `@cloudflare/sandbox` 0.12.3; it resolves `@cloudflare/containers` 0.3.7 through that package (`package-lock.json:457-466`). The installed source and types establish the following:

- `Sandbox.containerFetch(request, port)` starts a stopped container, waits for health and port readiness, and honors `request.signal` during startup (`node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js:7949-8056`). That wake behavior is wrong for Scotty preview lifecycle.
- Native container forwarding accepts a streaming request and pipes the response through an `IdentityTransformStream`, retaining the in-flight activity count until the response body completes (`node_modules/@cloudflare/containers/dist/lib/container.js:864-963`).
- `ctx.container.getTcpPort(port).fetch()` bypasses the SDK wake/readiness/activity wrapper. Scotty already uses it behind an explicit running check.
- The SDK preview implementation streams HTTP/SSE and bridges WebSockets with a `WebSocketPair`, forwarding text, binary, close, and error events (`node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js:4514-4598`). It uses ordinary accepted sockets, not DO WebSocket hibernation.
- Direct `containerFetch()` WebSocket behavior exists in the resolved Containers implementation, but its README still says that surface does not support WebSockets. It is not a stable contract to build on. The SDK's explicit preview relay is the implementation reference.
- SDK preview forwarding refuses stale/sleeping runtime activation rather than waking it (`node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js:8191-8204`). Stop clears runtime activation but leaves its durable port token until re-exposure.
- SDK preview ports are 1024-65535 except control port 3000. The transport is HTTP, SSE, and WebSocket—not arbitrary TCP or UDP.

Kitesurf itself is remote and ephemeral. A controller requests the Kitesurf browser type and connects to its authenticated remote CDP WebSocket; the page then navigates to the preview HTTPS URL like any other Internet origin. It is not an authenticated Scotty browser client. Browser Run's default idle timeout is 60 seconds and its keepalive is bounded to ten minutes, so a short bridge grant and explicit teardown fit the product lifecycle better than a durable preview URL.

Relevant Cloudflare documentation:

- [Sandbox preview URLs](https://developers.cloudflare.com/sandbox/concepts/preview-urls/)
- [Sandbox ports API](https://developers.cloudflare.com/sandbox/api/ports/)
- [Workers RPC streams](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)
- [Browser Run CDP](https://developers.cloudflare.com/browser-run/cdp/)
- [Browser Run limits](https://developers.cloudflare.com/browser-run/platform/limits/)
- [Worker Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

Cloudflare's built-in `exposePort()`/`proxyToSandbox()` is intentionally public-preview oriented. In the pinned release its compact token remains durable across stops, its activation lifecycle is separate from Scotty's session record, and its policy does not know Scotty's operation lease, hard cap, reserved Pi port, or owner authorization. Its forwarding code is useful evidence, but its capability registry should not become a second source of truth.

## Target contract

### Control routes

Add two API routes without changing existing routes or envelopes:

```http
POST /api/sessions/:id/previews
Content-Type: application/json
Idempotency-Key: <opaque request key>

{"port":5173}
```

```json
{
  "preview": {
    "id": "7dd510c40c95",
    "port": 5173,
    "url": "https://p5173-a81f50ca9d22-<capability>.preview.scotty.example.com/",
    "expiresAt": "2026-04-01T12:02:00.000Z"
  }
}
```

```http
DELETE /api/sessions/:id/previews/:previewId
```

Issuance and revocation require either:

1. the root bearer in its existing Authorization position; or
2. an owner browser-client cookie plus the existing unsafe-request origin/fetch-metadata check.

Standard paired clients cannot expose a port. The raw preview token is returned once and is never accepted in a query parameter, request header, or cookie by the control origin. An ambiguous issuance response is not reported as success. A retry replaces any still-active grant owned by that issuance request; the short expiry repairs an orphaned lease.

The initial policy is one active preview per session, a 120-second default lifetime, and a 300-second absolute maximum. `expiresAt` is also bounded by `hardCapAt`. These values cover a Kitesurf navigation/assertion/screenshot pass without creating a general hosting service.

### Preview URL and routing

For the Cloudflare-container provider, current session IDs are 12 lowercase hex characters. Version 1 accepts that exact form and no runner-backed session. The host label is:

```text
p<decimal-port>-<12-hex-session-id>-<39-char-lowercase-base32-token>
```

A 24-byte random token produces 192 bits of entropy and a 39-character unpadded base32 encoding. The maximum label is 59 characters, below DNS's 63-character limit. Parsing is anchored and canonical: no alternate case, percent-encoding, extra labels, leading-zero port, or Unicode normalization is accepted.

The Worker dispatches an exact configured `.<preview-base>` suffix **before** the normal Hono application. A preview host can reach only the preview handler; it cannot reach `/api`, `/s`, assets, or authentication pages on that host. Conversely, the normal Worker hostname does not interpret preview labels or capabilities.

The full path and query belong to the repository application. There is no preview path prefix and no token query. For example:

```text
Kitesurf
  -> GET https://p5173-a81f50ca9d22-<token>.preview.example.test/dashboard?mode=test
  -> Worker preview-host dispatcher
  -> SANDBOX.getByName("a81f50ca9d22").proxyPreview(request, parsed grant)
  -> Sandbox DO capability/lifecycle checks
  -> ctx.container.getTcpPort(5173).fetch(forwardedRequest)
  -> repository app on 0.0.0.0:5173
```

The application must listen on `0.0.0.0`, not only loopback, as required by the Sandbox port transport.

### Capability ownership and persisted state

The Sandbox DO owns a single `PreviewGrantV1` record alongside the authoritative session record:

```text
PreviewGrantV1
  id                 non-secret random identifier
  operationNonce     nonce of the matching preview operation lease
  runtimeEpoch       current container-runtime generation
  port               one exact allowed port
  tokenDigest        SHA-256 digest of the 192-bit token
  issuedAt
  expiresAt
  hardCapAt          captured deadline; must still equal the session deadline
  issuerKind         root | owner-client
  issuerClientId?    non-secret audit identity
  state              active | closing
```

The raw token is never persisted, projected to KV, placed in R2, included in Alchemy state/outputs, or logged. Validation uses a constant-time digest comparison. The preview record is not part of a workspace backup.

Issuance atomically writes the preview grant and a new `SessionOperation { kind: "preview", nonce, ... }` in the same DO storage transaction after the expiry schedule is armed. It requires:

- provider `cloudflare`;
- status `warm`;
- no current operation;
- `ctx.container.running === true`;
- a current runtime epoch; and
- an expiry strictly before the session hard cap.

The runtime epoch rotates on container start. Stop, failed start, resume into a new runtime, and vaporize revoke any grant for the old epoch. Every preview request revalidates the digest, exact port/session, operation nonce, runtime epoch, warm state, running container, expiry, and unchanged hard-cap deadline before touching the port.

The expiry callback releases only the matching nonce. Every control transition also lazily reconciles an expired grant, so a lost schedule cannot strand the session. Vaporize deletes the grant with the rest of owned state.

### Target port policy

Version 1 applies all of these checks:

- Port is an integer in 1024-65535.
- Port 3000, the Sandbox SDK control port, is denied.
- Port 43117, Scotty's Pi supervisor/console port, is denied.
- Any future internal control or credential port is added to one central deny set before use.
- The grant binds one exact port; neither path, query, Host, nor a forwarded header can select another port.
- Only a Cloudflare Sandbox session can receive a grant. Runner-backed creation remains disabled.
- Issuance does not start a process or infer a port from repository contents.

No readiness probe may use `containerFetch()`, because that could wake the container. Issuance may make a short, abortable raw port probe only after the running/warm checks; failure is a typed `preview_port_unavailable`. A service that starts after issuance may instead return the same error on its first request. This detail should be settled by a deployed test because a generic HTTP probe can itself have application side effects.

### HTTP request proxy

For each authorized request, the Sandbox DO:

1. Rejects `CONNECT`, `TRACE`, malformed upgrade requests, over-limit URL/headers/body, and a capability mismatch before container access.
2. Requires the container to remain running and the session to remain warm with the matching preview operation.
3. Creates a new request whose URL keeps the public preview host, path, and query while changing only `https:` to `http:` for the internal TCP port fetch.
4. Streams the original body with `duplex: "half"`; it does not clone, tee, inspect, or buffer application content.
5. Removes hop-by-hop headers, all inbound `Forwarded`/`X-Forwarded-*` values, Cloudflare identity headers that should not be trusted by the app, Sandbox internal preview headers, and any `__Host-scotty` cookie residue.
6. Sets one trusted forwarding view: public preview host, `proto=https`, and public port 443. It does not add an original URL containing the capability.
7. Preserves application `Authorization`, `Origin`, `Referer`, content headers, and WebSocket subprotocol negotiation. These are application data, not Scotty control credentials.
8. Calls only `ctx.container.getTcpPort(grant.port).fetch(request)` and propagates cancellation.

The fixed-port handle, not a client-controlled URL, is the SSRF boundary. The bridge never calls `fetch()` on an arbitrary hostname and never calls `containerFetch()`.

Initial per-grant limits should be explicit constants:

- 16 concurrent HTTP requests;
- 1,024 total requests;
- 8 KiB URL and 32 KiB aggregate request headers;
- 16 MiB request body;
- 128 MiB response body;
- 30 seconds to response headers; and
- no stream beyond grant expiry or hard cap.

Limits are enforced while streaming, with cancellation in both directions. They are installation policy, not application-controlled query options.

### HTTP response proxy

The bridge returns the application's status, status text, content type, cache validators, and streamed body. It removes hop-by-hop and internal transport headers. It adds:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow, noarchive
```

`Set-Cookie` is preserved without Domain rewriting. Host-only application cookies are scoped to this one capability origin. `Domain=localhost` remains invalid rather than being silently broadened. Scotty never sets `__Host-scotty` on a preview host.

The bridge does not follow redirects. It performs one narrow `Location` rewrite:

- a redirect to `http://localhost:<granted-port>`, `http://127.0.0.1:<granted-port>`, or `http://[::1]:<granted-port>` becomes the current HTTPS preview origin with path/query/fragment preserved;
- a same-preview-host `http:` redirect is upgraded to `https:`; and
- relative redirects, different hosts, and different ports are unchanged.

### URL rewriting and origin semantics

There is **no HTML, JavaScript, CSS, source-map, form-action, or response-body rewriting**. Such rewriting cannot reliably preserve arbitrary applications, streaming, CSP, modules, workers, signed content, or WebSocket endpoints.

A dedicated origin is what makes these work naturally:

- `/assets/app.js` resolves through the same grant;
- relative and root-relative navigation remains valid;
- same-origin `fetch`, EventSource, and `ws(s)://location.host` remain same-origin;
- application cookies and storage stay isolated from Scotty's control origin; and
- service workers, if the app registers one, are confined to the short-lived capability origin.

A new grant gets a new origin, so it does not inherit cookies, local storage, cache, or service-worker control from a previous run. Code that hard-codes `localhost`, another port, or a production hostname is outside the transparent contract, apart from the narrow redirect rule above. Applications should use relative URLs or honor the trusted forwarded host/proto.

The capability necessarily appears in the browser-visible hostname and DNS/TLS request. `Referrer-Policy: no-referrer`, no-store, log redaction, short lifetime, and exact-port scope limit disclosure. It is still a bearer secret and must not be pasted into durable logs or reports.

### WebSockets, SSE, and long responses

An Upgrade request is accepted only when it is a valid WebSocket GET and the grant is active. The bridge uses the installed SDK preview relay as the behavior reference: obtain the exact TCP port, receive the upstream WebSocket response, create a `WebSocketPair`, and relay text, binary, close, and error events in both directions.

Version 1 limits are:

- at most two simultaneous WebSockets per grant;
- no raw TCP/UDP and no HTTP `CONNECT`;
- 1 MiB maximum logical message;
- 32 MiB maximum bytes in each direction per socket;
- 60 seconds idle;
- absolute close at grant expiry or hard cap; and
- no promise of compression, fragmentation preservation, hibernation, or reconnect/resume.

Use close code 1008 for policy rejection, 1009 for an oversized message, 1011 for bridge failure, and 1001 when lifecycle shutdown expires the preview. Preserve an allowed `Sec-WebSocket-Protocol` selected by the upstream. Do not reflect a protocol that the app did not select.

The ordinary accepted-socket bridge keeps the Durable Object active. WebSocket messages and response-stream progress may renew local transport activity, but they **must not extend** the grant, session hard cap, or Kitesurf lease. SSE and other long responses are streamed under the same absolute deadline and byte limits.

## Lifecycle behavior

| Event                         | Required preview behavior                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue while warm              | Atomically acquire `preview` operation and active grant. Do not start a container.                                                                                     |
| Normal HTTP/WS activity       | Keep the current runtime active only for the bounded request; never move `expiresAt` or `hardCapAt`.                                                                   |
| Explicit revoke               | Mark closing, reject new requests, abort/close active transports, delete grant, release matching operation.                                                            |
| Grant expiry                  | Same as revoke; lazy reconciliation covers a missed scheduled callback.                                                                                                |
| Snapshot, sleep, down, resume | Return the existing wrong-state/conflict envelope while a live preview lease exists. Caller revokes or waits for expiry.                                               |
| Idle expiry                   | A live bounded preview counts as in-flight. Once it drains/expires, the existing 60-minute idle path may checkpoint and stop.                                          |
| Hard cap                      | Preempt preview immediately, close transports, release its nonce, then enter the existing hard-cap checkpoint/destroy path. Preview gets no 30-second operation grace. |
| Container stop/restart        | Rotate runtime epoch and revoke. An old URL returns a generic stale/not-found response and never wakes the new runtime.                                                |
| Failed session                | Revoke and reject; never forward to a residual process.                                                                                                                |
| Vaporize                      | Preempt preview before acquiring vaporize, delete grant with authoritative state, and retain existing retry-until-gone semantics.                                      |
| DO eviction only              | Durable grant may continue until expiry if the same running runtime epoch is recovered; active sockets die and are not resumable.                                      |

The preview operation is deliberate. A separate informal “traffic active” flag would create a second mutation gate and could let a backup race a repository write. The one-operation invariant remains the simpler correctness boundary.

## Attack controls

### Authentication and secret isolation

- Mint only after root-or-owner authorization; standard clients cannot mint.
- Use at least 192 random bits, store only SHA-256, compare in constant time, and return raw material only in the issuance response.
- One grant per session, one port per grant, short absolute TTL, explicit revocation, no refresh from preview traffic.
- Never expose root/browser/Browser Run/provider credentials to Kitesurf or the app.
- Never put preview tokens in query parameters, cookies, KV, R2, backups, Alchemy state/outputs, exception text, analytics dimensions, or normal logs.
- Redact the entire preview hostname in access/error logs. Log only preview ID, session ID, port, method, status, byte counts, timing, and a bounded reason code.

### Routing and request smuggling

- Exact configured suffix and anchored single-label parser; reject ambiguous host, port, scheme, and Unicode forms.
- Preview hosts dispatch only to preview code; control hosts dispatch only to existing Hono routes.
- Fixed native TCP-port handle; no user-controlled destination URL or DNS lookup.
- Strip hop-by-hop, duplicate forwarding, internal Sandbox, and Cloudflare trust headers before constructing a canonical request.
- Reject `CONNECT`, `TRACE`, invalid content lengths, conflicting transfer framing, unexpected upgrades, and over-limit bodies/headers.
- Do not follow app redirects server-side.

### Cross-origin and browser controls

- A unique grant is a unique origin; no control-origin cookies or CORS grant are added.
- Preserve app CORS/CSP behavior rather than synthesizing permissive policy.
- Set no-referrer/no-store/noindex defenses and use an installation preview domain that is not a parent of the control origin's cookies.
- Kitesurf's CDP/API credential stays between the remote controller and Browser Run. It is not an HTTP credential for the preview page.
- A malicious repository app can instruct Kitesurf to navigate to public Internet sites. If a test must remain on the preview origin, enforce that in the Kitesurf controller's navigation policy; the ingress bridge cannot make arbitrary browser navigation same-origin.

### Resource and lifecycle controls

- Enforce request, byte, concurrency, stream, WebSocket, and total-request budgets per grant.
- Validate warm/running/runtime epoch on every request and never use a wake-capable API.
- Bind expiry to hard cap and preempt immediately for hard cap/vaporize.
- Abort downstream I/O when Kitesurf disconnects; abort upstream response and close sockets at lifecycle end.
- Preserve existing egress mediation. A preview does not create an alternate outbound fetch path from the container.

## Rejected alternatives

### `/s/:id/preview/<port>/...`

A path prefix is superficially smaller but is not transparent to repository applications. Root-relative assets, redirects, cookies, service workers, router base paths, OAuth callbacks, and Vite-style HMR/WebSockets would target the Scotty origin or wrong path. Correcting arbitrary bodies is unsafe and incomplete. It would also overload the currently reserved `/s/:id/*` 404 contract.

### SDK `exposePort()` plus `proxyToSandbox()` unchanged

This creates a parallel durable token/activation model outside Scotty's session operation, auth, reserved-port, hard-cap, and vaporize rules. Its public-preview defaults and restart semantics are not sufficient authorization. Future SDK guidance also treats this route-based facility as a migration surface. Reuse its proven stream/WebSocket techniques, not its authority model.

### `containerFetch()` as the forwarding call

It can start or wake the container and wait up to its startup/readiness timeouts. A stale preview could therefore resurrect a sleeping session outside resume and backup semantics. Raw `getTcpPort()` after authoritative checks is required.

### A browser inside the Sandbox

This adds browser binaries, credentials, processes, ports, lifecycle, and attack surface to the authoritative workspace container. It is explicitly out of scope and unnecessary because Kitesurf can navigate to public HTTPS remotely.

### Quick tunnels or per-session public tunnel processes

They introduce another process and public capability inside the container, depend on outbound networking, complicate restart/vaporize cleanup, and bypass the Worker/Auth/Sandbox authority boundary.

## Minimal implementation slices

1. **Infrastructure gate**
   - Add an explicit preview-base setting.
   - Provision proxied wildcard DNS and a wildcard Worker Route through Alchemy.
   - Prove TLS and host routing in a disposable installation. Do not infer account/domain identity.

2. **Capability and lifecycle core**
   - Add `preview` to the persisted operation schema and add `PreviewGrantV1` decoding.
   - Implement atomic begin/revoke/expire, runtime epoch rotation, hard-cap preemption, and vaporize cleanup in the Sandbox DO.
   - Add deterministic-clock and interrupted-write tests before networking.

3. **Owner control API**
   - Add the two routes with existing error envelopes, root/owner authorization, fetch-metadata checks, bounded JSON decoding, and issuance redaction.
   - Keep current CLI JSON and exit behavior unchanged; no CLI command is required for the first deployed proof.

4. **HTTP vertical slice**
   - Dispatch the wildcard host separately from Hono's control surface.
   - Forward one exact port with streaming request/response bodies, canonical headers, cancellation, narrow `Location` rewriting, and limits.
   - Prove root-relative assets, POST upload, streaming/SSE, app cookies, redirects, and client abort.

5. **WebSocket slice**
   - Add the explicit relay and limits.
   - Prove text, binary, selected subprotocol, close propagation, oversize rejection, idle close, expiry, and hard-cap close.

6. **Remote Kitesurf canary**
   - Start a test app on `0.0.0.0:<allowed-port>` in one deployed warm Sandbox.
   - Mint a grant, connect remote Kitesurf, assert DOM/network behavior, and take a screenshot.
   - Revoke and prove HTTP and WebSocket access fails without waking the container.
   - Sleep/resume and prove the old URL remains stale; mint a new origin for the new runtime.

## Proof required before enabling production

Local fakes cannot prove wildcard DNS/TLS, Cloudflare port forwarding, backpressure, Browser Run reachability, or stop/restart behavior. The deployment gate requires:

- focused unit tests for host parsing, auth matrix, digest/expiry, operation races, reserved ports, header sanitation, limits, and redirect rewriting;
- Effect tests with `TestClock` for expiry, hard cap, sleep conflict, stop, resume epoch, and vaporize retry;
- adapter tests that execute production stream and WebSocket forwarding code;
- existing route-contract tests to prove `/api`, `/s`, retired PTY routes, cookies, envelopes, CLI shapes, and exit codes are unchanged;
- a deployed Sandbox canary for uploads, large streamed downloads, SSE, WebSockets, cancellation, expiry, stop, hard cap, and vaporize; and
- a remote Kitesurf canary. No colocated browser result substitutes for this final proof.

## Residual risks and explicit non-goals

- A repository app is code executing in the same workspace container. Preview ingress does not make that code trusted or remove its existing access to workspace files and session sentinels.
- The public capability URL is visible to the app and remote browser. Short scope and lifetime reduce, but do not eliminate, bearer-URL leakage risk.
- Direct WebSocket behavior, client-abort propagation, and backpressure are verified from installed implementation but still require deployed tests; package README/source disagree on direct `containerFetch()` WebSockets, which is why the design uses an explicit relay.
- Version 1 does not support runner sessions, multiple simultaneous ports, public sharing, stable URLs, custom domains per app, raw TCP/UDP, browser persistence, or automatic process discovery.
- Kitesurf is stateless/ephemeral. Scotty must not treat it as a durable authenticated browser session or store its remote CDP credential in the Sandbox.
