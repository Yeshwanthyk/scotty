# Secure browser preview for frontend dev servers in Scotty sandboxes

**Status:** research recommendation
**Date:** 2026-07-30
**Scope:** browser access to an HTTP/WebSocket development server running in a Cloudflare Sandbox SDK Container

## Recommendation

Spike **a Scotty-authenticated, separate-origin preview gateway**—Option D in this research and Shape B in the decision plan—on a wildcard hostname such as `p-<opaque-handle>.preview.<installation-domain>`. Build it only if deployed evidence proves composite Auth/Session authorization, adjacent runtime fencing, CSP-compatible cookie bootstrap, HTTP/WS ownership, and the selected revocation contract. The Auth Durable Object must remain authoritative for browser-client status and the Session Durable Object for preview grants and lifecycle. A relay DO is only a candidate for immediate WebSocket revocation; its outbound Sandbox socket cannot hibernate and requires a proven lifetime/reconnect design.

Do **not** make untrusted preview content same-origin with Scotty's control plane. Today the browser cookie
has `sessions:read` and `sessions:write`; an application rendered below a same-origin path could issue
credentialed requests to Scotty APIs even though the cookie is `HttpOnly`. Scotty's origin and Fetch Metadata
checks would accept such script as same-origin. These are repository facts in `worker/src/auth.ts`,
`worker/src/auth-registry.ts`, and `worker/src/index.ts`.

Also do not describe the target as a literal **loopback-only** service. Cloudflare's Sandbox guidance requires
an exposed service to listen on `0.0.0.0:<port>` rather than `127.0.0.1`; the official pinned Vite example does
that too. The gateway still reaches only the selected port of the selected container through the Container
binding, not a user-supplied network URL. [Cloudflare expose-services guide](https://developers.cloudflare.com/sandbox/guides/expose-services/),
[pinned Vite configuration](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/vite-sandbox/sandbox-app/vite.config.js)

### Decision summary

| Option                                            | HTTP / HMR                                                                | Authentication and isolation                                                             | Revocation                                                                        | Fit for Scotty                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A. Authenticated same-origin path proxy**       | Technically possible; base-path and absolute-URL breakage are substantial | Reuses Scotty cookie but gives untrusted app code Scotty's origin                        | New requests can be denied; existing sockets need relay/closure                   | **Reject as default**: control-plane origin is too privileged                      |
| **B1. SDK `exposePort()` preview hostname**       | SDK forwards HTTP, streaming bodies, and WebSocket upgrades               | URL-host token is the authorization capability; not Scotty user auth                     | `unexposePort()` revokes; runtime restart makes forwarding stale until re-exposed | Useful primitive/canary, not sufficient product boundary                           |
| **B2. SDK quick/named tunnel**                    | WebSockets work; quick tunnels buffer SSE                                 | Public URL unless separately protected; named mode adds Cloudflare credentials/resources | Quick URL changes on restart; explicit destroy cleans up                          | Escape hatch only; conflicts with Scotty's default-deny egress and lifecycle proof |
| **C. User tunnel or external preview deployment** | Provider-dependent; usually root-path-friendly                            | Security, logs, and revocation move outside Scotty                                       | Provider-dependent and easy to orphan                                             | Explicit user-owned escape hatch, never automatic                                  |
| **D. Separate-origin Scotty gateway**             | Root-path semantics; explicit HTTP streaming and WS relay                 | Preview-only cookie/ticket; no Scotty control cookie on preview host                     | Auth + Session authority; relay contract unproven                                 | **Preferred spike candidate; not yet selected**                                    |

## Ground truth

### Scotty's current contracts

- `worker/package.json` pins `@cloudflare/sandbox` to `0.12.3`; `worker/container/Dockerfile` pins the matching
  `cloudflare/sandbox:0.12.3` image digest.
- `worker/src/index.ts` calls `getSandbox(..., { sleepAfter: "60m", transport: "rpc",
enableDefaultSession: false, normalizeId: true })`. It currently imports `ContainerProxy`, `getSandbox`, and
  `proxyTerminal`, but **not** `proxyToSandbox`; no preview route or port registry exists.
- The authenticated browser surface is `/s/:id` plus `/s/:id/terminal`. Both require a browser client cookie;
  terminal WebSockets additionally require an exact same `Origin` and a warm Cloudflare session
  (`worker/src/index.ts`). Unknown `/s/:id/*` paths deliberately return 404, so a path preview would be a new
  public route contract, not latent behavior.
- `__Host-scotty` is `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/` (`worker/src/auth.ts`). Standard
  browser clients have both `sessions:read` and `sessions:write` (`worker/src/auth-registry.ts`). Unsafe API
  methods require same-origin and Fetch Metadata checks, but same-origin preview JavaScript would satisfy
  them (`worker/src/index.ts`).
- The Sandbox DO is authoritative for lifecycle and credentials; KV is a non-secret projection and the
  container filesystem is disposable (`AGENTS.md`, `PLAN.md`, `EFFECT_V4_MIGRATION.md`). Preview registries,
  runtime epochs, and Session-owned preview-grant revocation markers belong in the Session DO, not Worker memory
  or KV. Browser-client revocation remains authoritative in the Auth DO.
- Scotty's Sandbox subclass sets `enableInternet = false`, intercepts HTTPS, and has a finite outbound host
  allowlist that does not include Cloudflare Tunnel endpoints (`worker/src/session.ts`, `worker/src/egress.ts`).
  A user-started `cloudflared` process is consequently **not proven compatible** with current egress policy.
- Sleep/checkpoint, resume, hard-cap, and vaporize are authoritative transitions; vaporize destroys runtime,
  credentials, backups, projection, and authority (`worker/src/session.ts`, `PLAN.md`). Preview activation must
  be revoked/closed as part of those transitions, and must not keep a session warm invisibly.
- Current secure assets set `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, and a narrow
  `connect-src` (`worker/src/index.ts`). Embedding requires an intentional CSP change, and the proposed
  cross-origin form bootstrap requires a dedicated page-specific `form-action`; opening a new tab alone does
  not solve the POST bootstrap.
- Real Codex/GitHub credentials may exist only at approved Worker/DO boundaries; containers receive sentinels
  (`AGENTS.md`, `PLAN.md`, `worker/src/container-auth.ts`, `worker/src/egress.ts`). The gateway must never source
  sentinels or real credentials from privileged state or inject them, internal proxy headers, or authenticated
  upstream headers into container requests. It does not inspect opaque app bodies, so hostile same-container
  code can return sentinels already present in files/environment. That existing capability boundary must be
  explicit in the product decision.

### What pinned Sandbox SDK 0.12.3 supports

The npm tarball named by `package-lock.json` was checked against official tag
[`@cloudflare/sandbox@0.12.3`](https://github.com/cloudflare/sandbox-sdk/tree/696388b24c1c59a19b484a9e8066dc431addf617).
The tag resolves to commit `696388b24c1c59a19b484a9e8066dc431addf617`.

1. **Direct Container forwarding.** `sandbox.containerFetch(request, port)` supports HTTP to a selected port.
   WebSockets use `sandbox.wsConnect(request, port)`, whose client-side wrapper applies Containers'
   `switchPort()` before `stub.fetch()`. Cloudflare's Containers docs independently state that
   `containerFetch()` is HTTP-only and non-default-port WebSockets use `switchPort(request, port)` with
   `container.fetch()`. [Pinned `containerFetch()` source](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L3023-L3177),
   [pinned `wsConnect()` source](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L920-L944),
   [Cloudflare Containers WebSocket example](https://developers.cloudflare.com/containers/examples/websocket/)
2. **Worker-fronted preview hostnames.** `exposePort(port, { hostname, name?, token? })` accepts ports
   `1024..65535` except reserved port `3000`, persists a per-port token and current-runtime activation in DO
   storage, and returns a host of the form `<port>-<sandbox>-<token>.<hostname>`. `.workers.dev` is rejected
   because wildcard subdomains require a custom domain. `proxyToSandbox()` parses that host, strips spoofed
   internal preview headers, selects the sandbox and port, and calls `sandbox.fetch()`.
   [Pinned `exposePort()` source](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L4950-L5084),
   [pinned proxy router](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/request-handler.ts#L32-L109),
   [pinned port validation](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/security.ts#L20-L36)
3. **HTTP, WebSocket, and streaming behavior.** The preview forwarder preserves request method/body/path/query,
   supplies `X-Forwarded-Host` and `X-Forwarded-Proto`, uses manual redirects, passes upgrade requests through
   the WebSocket path, and returns the forwarded response rather than buffering it in application code.
   [Pinned preview forwarding](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L3330-L3529),
   [Cloudflare Workers Streams API](https://developers.cloudflare.com/workers/runtime-apis/streams/)
4. **Preview URL lifecycle.** The port token remains durable across a transient container restart, but
   forwarding is scoped to the runtime in which `exposePort()` was called. A stale runtime returns `410` and
   must be explicitly re-exposed. `unexposePort()` transactionally clears authorization and activation without
   waking the container. [Pinned preview lifecycle source](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L4950-L5155)
5. **Quick and named tunnels.** `sandbox.tunnels.get(port)` can create a random `*.trycloudflare.com` quick
   tunnel; calls are cached/idempotent per port. Quick URLs change on container restart, can take time to
   propagate, buffer `text/event-stream`, and support WebSockets. Named tunnels use a Cloudflare API token,
   create tunnel/DNS resources, and can retain a stable hostname; `sandbox.destroy()` attempts cleanup.
   Tunnels require RPC transport. [Pinned SDK README](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/README.md#L101-L140),
   [pinned named-tunnel example](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/websocket-tunnel/README.md#L12-L100),
   [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
6. **A working HMR example exists.** Cloudflare's pinned example starts Vite as a background process, waits for
   port 5173, obtains a tunnel URL, embeds it in an iframe, permits `.trycloudflare.com`, and configures HMR's
   browser port as 443. This proves a representative Vite/HMR shape, not Scotty authentication or lifecycle.
   [Pinned Vite Worker](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/vite-sandbox/src/worker.js),
   [pinned Vite config](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/vite-sandbox/sandbox-app/vite.config.js),
   [pinned example notes](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/vite-sandbox/README.md)
7. **`exposePort()` is not a durable product foundation.** Cloudflare deprecated the expose-ports feature on
   June 9, 2026 and directs users to Cloudflare Tunnel; deprecated features were scheduled for removal from SDK
   versions released after July 9, 2026. Scotty's exact 0.12.3 pin still contains `exposePort()` and
   `proxyToSandbox()`, so they remain useful for a version-pinned comparison or canary, but new Scotty product
   architecture should use the non-deprecated direct `containerFetch()` / `wsConnect()` primitives or tunnels.
   [Cloudflare deprecation notice](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/),
   [Cloudflare migration guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/)

## Option A — authenticated same-origin reverse proxy

Example shape: `https://scotty.example/s/<id>/preview/<opaque-registration>/...` authenticates with the existing
Scotty browser cookie, strips the route prefix, and uses `containerFetch` for HTTP or `wsConnect` for an upgrade.
The port is looked up server-side, never accepted directly from the URL.

### Strengths

- Existing browser authentication and device revocation apply to each new request (`worker/src/auth.ts`,
  `worker/src/auth-registry.ts`).
- No public tunnel, wildcard DNS, Cloudflare tunnel token, or external deployment credential is required.
- The Worker can preserve HTTP response streaming through a `ReadableStream`, and the Sandbox API has an
  explicit non-default-port WebSocket path. [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/),
  [Containers WebSocket example](https://developers.cloudflare.com/containers/examples/websocket/)
- Scotty can log a single edge request ID with session/preview/port metadata while keeping bodies, cookies,
  query strings, and headers out of logs.

### Blocking security problem

A path does not create a new origin: scheme, host, and port define the origin, not the path. Preview JavaScript
would therefore run with Scotty's origin. `HttpOnly` prevents JavaScript from reading the cookie, but it does not
prevent the browser from attaching that cookie to same-origin requests. The app could call `/api/sessions`,
mutate sessions, initiate snapshots/sleeps, or attempt vaporization with the user's `sessions:write` authority.
[HTML origin definition](https://html.spec.whatwg.org/multipage/browsers.html#origin),
[Fetch credentials model](https://fetch.spec.whatwg.org/#credentials),
[HTTP cookie specification](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis)

Stripping `Cookie` before forwarding to the container is necessary but does not fix this: the malicious script's
separate fetch to Scotty's API is made by the browser. Stripping upstream `Set-Cookie` also remains necessary so
the untrusted server cannot alter same-host cookies through its proxied response.

### Compatibility costs

- The gateway must strip `/s/<id>/preview/<registration>` before forwarding. Relative subresources can work,
  but root-relative URLs (`/src/main.tsx`), redirects (`Location: /login`), module imports, source maps,
  WebSocket endpoints, service-worker scope, and SPA navigations can escape the prefix. HTML's URL resolution
  rules make this a dev-server-specific configuration problem rather than a transparent proxy.
  [HTML document base URLs](https://html.spec.whatwg.org/multipage/urls-and-fetching.html#document-base-urls)
- Vite-like servers need explicit base/HMR configuration, trusted proxy/host settings, and external
  `wss:`/port information. Cloudflare's own Vite example sets `allowedHosts` and HMR `clientPort: 443`.
  [Pinned Vite config](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/vite-sandbox/sandbox-app/vite.config.js)
- The upstream app controls redirects, cache headers, CSP, CORS, cookies, and content types unless the gateway
  sanitizes them. Imposing Scotty's terminal CSP would break ordinary frontend tooling; accepting arbitrary app
  CSP is correct only on an unprivileged origin. CSP governs script/connect/frame capabilities but is not a
  substitute for origin isolation. [CSP Level 3](https://www.w3.org/TR/CSP3/)
- Denying future requests does not close an already-upgraded HMR WebSocket. Immediate client or preview
  revocation requires a relay that owns both WebSocket legs and closes them, or stopping the container.
  Cloudflare Durable Objects can own/hibernate WebSockets and receive close events.
  [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

**Verdict:** acceptable only for trusted static output or a heavily sandboxed renderer with no control-plane
origin authority. It is not appropriate for arbitrary repository dev servers.

## Option B — direct/public preview URL or hostname

### B1. SDK `exposePort()`

This exists in pinned 0.12.3, but Cloudflare deprecated it in June 2026 and directs new exposure flows to
Cloudflare Tunnel. Scotty does not currently wire it. Adoption would require a custom domain with wildcard
DNS/routing, calling `proxyToSandbox()` before ordinary application routing, and adding durable Scotty policy
around exposure (`worker/src/index.ts`, `alchemy.run.ts`). The built-in URL token is a bearer capability embedded
in the hostname; possession, not a Scotty client identity/scope check, grants access. Treat this as pinned-version
evidence for forwarding behavior, not as a recommended new Scotty dependency.
[Pinned preview router](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/request-handler.ts#L32-L109),
[Cloudflare preview URL docs](https://developers.cloudflare.com/sandbox/concepts/preview-urls/)

**Protocol behavior:** root paths and subresources are natural because the preview gets its own host. The SDK
preserves path/query/body, supports upgrade forwarding, and streams the response. Same-origin app cookies are
isolated from Scotty if the preview is a different host and Scotty's `__Host-` cookie remains host-only.
[Pinned preview source](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L3330-L3529),
[HTTP cookie specification](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis)

**Security/lifecycle:** the SDK validates the port range and token in constant time, strips spoofed control
headers, and scopes activation to a runtime. `unexposePort()` revokes future requests. It does not provide
Scotty roles, per-device policy, expiry, one-use tickets, audit identity, or guaranteed closure of an already
open socket. The capability appears in DNS/hostnames, browser history, screenshots, and any copied URL, so it
must not be treated like authenticated private preview.
[Pinned validation and revocation](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L4950-L5155)

**Verdict:** good underlying routing code and a useful deployed canary; insufficient as Scotty's authorization
model without an additional gateway.

### B2. Quick or named tunnel

A quick tunnel gives the best zero-config UX and Cloudflare's pinned Vite example demonstrates HMR. It is also a
public random URL, changes after restart, buffers SSE, has Quick Tunnel limits, and is documented for testing and
development rather than production. WebSockets are supported. [Pinned SDK README](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/README.md#L101-L140),
[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/),
[Cloudflare Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)

A named tunnel supplies a stable hostname but requires an API token capable of managing Tunnel and DNS resources.
The pinned SDK passes a derived tunnel token to the container's `cloudflared` run and owns cleanup. That adds a
new infrastructure credential/capability surface and cloud resources outside Scotty's current session record.
It would need write-only provisioning, exact-resource ownership, redacted logs/errors, restart reconciliation,
and orphan checks at vaporize. [Pinned named-tunnel example and permissions](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/websocket-tunnel/README.md#L34-L100)

Neither mode is currently proven under Scotty's `enableInternet = false` and host allowlist. Cloudflare Tunnel
uses outbound `cloudflared` connections; official guidance describes outbound-only connectivity and firewall
egress requirements. Changing Scotty egress to permit it would be a security-contract change needing an explicit
destination/protocol design and deployed canary, not a convenience toggle.
[Cloudflare Tunnel architecture](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
[Cloudflare tunnel firewall guidance](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

Cloudflare Access can protect a tunnel hostname and issues an application authorization cookie, but this creates
a second identity/session system and login UX; it does not automatically map to Scotty device revocation.
[Cloudflare Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/),
[Cloudflare self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

**Verdict:** offer only as an explicit, visibly public/user-managed escape hatch. Never auto-start it from an
arbitrary repo command.

## Option C — user-run tunnel or external preview provider

This option moves preview serving outside Scotty: the user can deliberately start `cloudflared`, deploy a branch
or build artifact, or ask an existing external provider to create a preview. It usually provides root-path
semantics and provider-native HTTPS/HMR, but every security property becomes provider-specific.

Scotty should treat this as **publishing**, not preview plumbing:

- require an explicit user action and show that code/assets leave the sandbox;
- do not inject a real provider token into container environment, files, process arguments, logs, or command
  output; Scotty's credential invariant forbids doing that for its real Codex/GitHub credentials
  (`AGENTS.md`, `PLAN.md`, `EFFECT_V4_MIGRATION.md`);
- do not widen default-deny egress generically; add exact destinations only through a separately approved
  adapter (`worker/src/egress.ts`);
- return only a provider URL/status, never credentials, and make teardown/revocation responsibility explicit;
- do not claim vaporize removes an external deployment unless Scotty owns and verifies the provider cleanup.

Cloudflare's tunnel model avoids an inbound public origin IP because `cloudflared` makes outbound connections,
but the tunnel still publishes the selected application through Cloudflare and needs an explicit access policy
if it is private. [Cloudflare Tunnel overview](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
[Cloudflare self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

The repository already says source-control publishing is outside Scotty orchestration; an agent may commit/push
only when the user asks (`EFFECT_V4_MIGRATION.md`). That boundary should remain.

**Verdict:** valid advanced escape hatch, poor default preview UX, and not a substitute for a secure in-product
gateway.

## Option D — separate-origin authenticated gateway (Shape B in the decision plan)

### Proposed request flow

1. **Register, do not discover from the public request.** An authenticated Scotty action asks the Sandbox DO to
   register one valid non-reserved port for a warm session. Persist `{ previewId, port, processId?, runtimeEpoch,
createdAt, expiresAt, status }` in authoritative DO storage. Validate `1024..65535`, reject `3000`, cap the
   number of previews, and never accept a destination URL/hostname/IP. The SDK uses the same port constraints.
   [Pinned port validation](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/security.ts#L20-L36)
2. **Use an unprivileged host.** Route `p-<opaque-preview-id>.preview.<domain>/*` to Scotty. The ID is a routing
   handle, not sufficient authorization. Keep the control plane on a different host; ideally use a dedicated
   registrable preview domain for the clearest site boundary. Origins are host-sensitive.
   [HTML origin definition](https://html.spec.whatwg.org/multipage/browsers.html#origin)
3. **Redeem a narrow ticket without putting it in a URL.** From the authenticated control plane, issue a
   one-use, short-lived ticket bound to `{ previewId, Scotty client id, runtimeEpoch }`. The current terminal CSP
   has `form-action 'none'`, so a dedicated response must permit only the exact preview bootstrap target without
   weakening generic assets. Submit the ticket in a top-level form POST, require the expected Scotty `Origin`,
   redeem it once, set an exact-host `Secure; HttpOnly; SameSite=Strict; Path=/` preview cookie, and redirect.
   Never reuse a hostname after it has served app code: a stale service worker must not intercept a later
   bootstrap. Verify CSP, POST/set-cookie/redirect, history, referrer, service-worker, and Cache Storage behavior
   in the deployed browser canary.
4. **Compose authorization without moving authority.** Resolve the hostname to one preview record. The Auth DO
   checks client/device status; the Session DO checks cookie/grant, expiry, `warm`, operation, port, and runtime
   state. Define ordering, failure, and freshness because this cross-DO check is not atomic. Client revocation
   needs durable relay discovery/fan-out or a bounded reauthorization contract.
5. **Require an adjacent runtime fence before native proxying.** Pinned `containerFetch()` can start/restart the
   Container and accepts no runtime identity; `wsConnect()` only switches port and fetches. A detached epoch
   check followed by either call has a restart race. The spike must prove a non-deprecated public
   fetch-if-current-runtime API or a smallest source-verified subclass adapter with an adjacent fence. If none
   exists, reject the gateway. Only then preserve method, path, query, request/response streams, status, and safe
   headers without buffering HTML or SSE.
   [Containers class](https://developers.cloudflare.com/containers/container-class/),
   [Containers WebSocket example](https://developers.cloudflare.com/containers/examples/websocket/),
   [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)
6. **Sanitize the trust boundary.** Strip hop-by-hop headers, all SDK internal preview headers, inbound
   `Authorization`, Scotty cookies, Cloudflare client metadata not intentionally forwarded, and upstream
   `Set-Cookie` by default. Supply explicit `Forwarded`/`X-Forwarded-*` values. Preserve the browser's external
   `Origin` for WebSocket origin checks, or configure the dev server to trust only the preview hostname; RFC 6455
   requires browsers to send `Origin` in the opening handshake.
   [WebSocket RFC 6455 §10.2](https://datatracker.ietf.org/doc/html/rfc6455#section-10.2)
7. **Own live socket revocation.** If revocation must be immediate, terminate browser WS at a gateway DO and
   relay to the Sandbox socket. Only the browser-facing server socket can hibernate; the outbound/client socket
   cannot. The spike must prove active lifetime, outbound connection limits, eviction/reconnect behavior, and
   close delivery from both Auth and Session authorities. Otherwise document a bounded non-immediate contract.
   [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
8. **Fence lifecycle honestly.** Managed snapshot/sleep/hard-cap transitions first mark previews inactive and
   close relays, then stop runtime. Unexpected `onStop` can invalidate only after provider stop is observed.
   Resume requires explicit re-registration. Vaporize deletes preview records/ticket digests and proves no
   active socket/registration remains (`worker/src/session.ts`).

### Browser behavior

- A separate preview host lets frameworks use `/`, absolute subresources, redirects, SPA navigation, cookies,
  and service workers without prefix rewriting. It also confines those capabilities to the preview origin, but
  that hostname must be permanently single-use so retained service workers/storage cannot affect a later grant.
- HMR needs the externally visible `wss:` hostname and port 443. Scotty can provide environment hints, but
  framework-specific configuration remains the user's responsibility; the official Vite example demonstrates
  `host: 0.0.0.0`, allowed hosts, and `hmr.clientPort: 443`.
  [Pinned Vite config](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/vite-sandbox/sandbox-app/vite.config.js)
- CORS is unnecessary for the preview's own assets/HMR. Calls from preview code to Scotty APIs remain
  cross-origin and should receive no credentialed CORS grant. Fetch defines CORS and credential behavior.
  [Fetch standard](https://fetch.spec.whatwg.org/#http-cors-protocol)
- Do not impose the terminal page's restrictive CSP on arbitrary app content. The gateway may enforce a narrow
  `frame-ancestors` policy and security headers only where they do not overwrite the app's own response
  semantics. The Scotty host page must explicitly allow the preview origin in `frame-src` if embedding; otherwise
  open a new tab. [CSP Level 3](https://www.w3.org/TR/CSP3/)
- Strip upstream `Set-Cookie` by default. If preview app cookies are later allowed, namespace or policy them so
  they cannot overwrite the gateway auth cookie, and never set a parent-domain cookie.
  [HTTP cookie specification](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis)

### Observability and credentials

Log structured events such as `preview.register`, `preview.http`, `preview.ws.open/close`, `preview.revoke`, and
`preview.stale`, with request/trace ID, session ID, opaque preview ID, registered port, runtime epoch, status,
byte counts, and duration. Do not log URL queries, cookies, ticket/token values, request/response bodies,
`Authorization`, application headers, or container output by default. The pinned SDK already uses structured
trace context and canonical port expose/unexpose events; Scotty should correlate rather than duplicate secrets.
[Pinned SDK logging/context](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L4979-L5138)

The proxy requires no Codex/GitHub credential. The container keeps its existing session sentinels and
allowlisted egress path (`worker/src/egress.ts`). The gateway never sources sentinels from privileged state or
injects them into upstream requests/headers. It does not inspect opaque app response bodies, so hostile code in
the shared container can publish a container-visible sentinel. A preview ticket is a new narrow browser capability: digest at
rest, short TTL, one use for cookie bootstrap, bound to one client/preview/runtime epoch, separately revocable,
and absent from API responses after redemption.

### Developer UX

A safe minimal flow is:

1. The user starts a server with a visible command such as `npm run dev -- --host 0.0.0.0`.
2. Scotty shows observed/listening candidate ports or accepts one bounded numeric port, then persists the exact
   registration. `Process.waitForPort()` can provide readiness without publishing it.
   [Pinned process readiness API/example](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts#L4030-L4265)
3. **Open preview** issues/redeems the one-use ticket and opens the separate host. The UI labels it “sandbox
   code — isolated from Scotty controls.”
4. Status distinguishes `starting`, `ready`, `stale after restart`, `sleeping`, and `revoked`; no silent tunnel
   recreation occurs.
5. **Stop preview** revokes tickets/cookies, closes sockets, and optionally kills only the recorded dev process;
   it does not snapshot or vaporize the whole session.

## Required proof before implementation is called secure

1. **Routing/SSRF:** reject malformed hosts, unknown preview IDs, direct numeric ports, port 3000, cross-session
   IDs, stale epochs, spoofed proxy headers, absolute-form URLs, and redirect attempts to internal/control hosts.
2. **Browser security:** prove preview JavaScript cannot call Scotty APIs with `__Host-scotty`; no credentialed
   CORS; no parent-domain cookie; upstream `Set-Cookie` cannot replace preview auth; no ticket remains in history,
   referrers, logs, or error pages.
3. **Protocol parity:** Vite HTTP, module graph, root-relative assets, SPA fallback, redirects, chunked/SSE stream,
   large upload, WebSocket echo, HMR reconnect, cancellation, and backpressure through the production adapter.
4. **Lifecycle/revocation:** client revoke, preview stop, sleep, hard cap, container crash, DO reconstruction,
   resume epoch change, and vaporize all deny new traffic; the WebSocket relay closes existing traffic where that
   guarantee is claimed.
5. **Credential/observability scan:** synthetic ticket, cookie, SDK token, and real Codex/GitHub honeypots never
   appear in logs, KV, R2, API bodies, Alchemy state/outputs, process args, or unapproved files. Verify the gateway
   never sources sentinels from privileged state or injects them into upstream requests/headers. Opaque app
   response bodies are not inspected; an adversarial app test explicitly demonstrates that same-container code
   can return a container-visible sentinel (`AGENTS.md`, `EFFECT_V4_MIGRATION.md`).

Run these as shared fake/production adapter contracts plus an isolated deployed Cloudflare canary. A local test
cannot prove wildcard DNS/TLS, Container port reachability, streaming lifetime, WebSocket upgrade ownership, or
runtime-restart fencing (`EFFECT_V4_MIGRATION.md`).

## Bottom line

- **Reject A as the default:** same-origin convenience gives untrusted repository code the control plane's
  browser authority.
- **Do not ship B as “private”:** pinned `exposePort()` and tunnels are real and HMR-capable, but their URLs are
  capabilities/public endpoints rather than Scotty-authenticated previews; `exposePort()` is also deprecated.
- **Keep C explicit and user-owned:** it is publication with external credentials, policy, logs, and cleanup.
- **Spike D / plan Shape B:** proceed only if composite Auth/Session authorization, adjacent runtime fencing,
  CSP/service-worker-safe bootstrap, native stream ownership, and the selected WebSocket revocation contract all
  pass in a disposable deployed stage. Otherwise choose the explicitly local fallback or stop.
