---
shaping: true
status: decision-needed
---

# Scotty frontend sandbox previews — decision and implementation plan

## Orientation

Scotty can run a frontend development server inside a Cloudflare Sandbox, but it cannot yet show that server in a user's browser. The missing piece is not just an HTTP proxy: normal frontend development needs root-path behavior, streaming responses, WebSocket/HMR upgrades, browser authentication, and revocation tied to the session runtime.

The strongest full-product candidate is a **separate-origin authenticated preview gateway** on a dedicated wildcard preview domain. Untrusted repository JavaScript would run on that unprivileged origin, while a short-lived preview-only cookie would authorize exactly one registered port in one Sandbox runtime epoch. The Session Durable Object (DO) would remain authoritative for preview grants, while the Auth DO would remain authoritative for browser-client status. A gateway relay DO would have to own live browser sockets if Scotty promises immediate revocation.

That direction has several hard live-provider and cross-DO unknowns, so the decision is deliberately two-step:

1. Run a disposable-stage feasibility and security spike for wildcard routing/TLS, cookie bootstrap, direct Container HTTP/WS forwarding, stream lifetime, and WebSocket ownership.
2. Build **Shape B** only if that spike passes and a dedicated wildcard preview domain is acceptable. Otherwise choose **Shape A** as an explicit local-only product, not as hidden work inside B.

Relative effort uses **S / M / L**. These are comparison bands, not calendar promises.

## Decision at a glance

| Choice                                | Position                                             | Relative effort | Why                                                                              |
| ------------------------------------- | ---------------------------------------------------- | :-------------: | -------------------------------------------------------------------------------- |
| **A. Local CLI loopback proxy**       | Private local-only fallback                          |        M        | Strong credential isolation and no DNS work, but no remote/mobile product UX     |
| **B. Separate-origin Scotty gateway** | **Preferred candidate if its security spike passes** |        L        | Best potential product UX, but runtime fencing and revocation are not yet proven |
| **C. Sandbox quick/named tunnels**    | Public or user-managed escape hatch only             |        M        | HMR-capable, but conflicts with current egress and private lifecycle guarantees  |
| **D. External static/PR publication** | Publishing workflow only                             |        M        | Useful for immutable review artifacts, not a live general dev-server preview     |

**Explicit non-option:** do not add same-origin `/s/:id/preview/*`. A path does not create a new origin. Hostile preview JavaScript would inherit Scotty's browser origin and could make credentialed API calls with the user's session read/write authority.

## Current gap and source-grounded constraints

### What exists

- The session-specific browser surface is `/s/:id` and `/s/:id/terminal`. Every other `/s/:id/*` request is deliberately authenticated and returned as `404`; there is no preview route or port registry (`worker/src/index.ts:576-614`, `worker/src/index.ts:908-920`).
- Terminal WebSockets require a browser-client cookie, exact same origin, a warm Cloudflare session, and the native Sandbox terminal proxy (`worker/src/index.ts:576-597`, `worker/src/index.ts:822-842`).
- The root token is accepted as a bearer credential, not as browser authority. Browser clients use `__Host-scotty`, set `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/` (`worker/src/auth.ts:17-23`, `worker/src/auth.ts:46-70`, `worker/src/auth.ts:136-148`, `worker/src/auth.ts:209-215`). Standard browser clients have both `sessions:read` and `sessions:write` (`worker/src/auth-registry.ts:14-16`).
- Same-origin and Fetch Metadata checks protect cookie-authenticated mutations, but hostile same-origin preview code would satisfy those checks (`worker/src/index.ts:822-846`). This is why the same-origin path is rejected, not merely deferred.
- The Session DO owns authoritative session state and credentials. KV is only a non-secret list projection, R2 stores immutable backups, and runtime memory/container files are not authority (`AGENTS.md`; `PLAN.md`; `IMPLEMENTATION_DAG.md`). `SessionRecord` is schema-version `1` and must remain compatible (`worker/src/contracts.ts:104-134`).
- The current Sandbox disables general internet access and uses a finite allowlist (`worker/src/session.ts:212-216`, `worker/src/egress.ts:26-44`). Cloudflare Tunnel destinations are not included.
- The current Sandbox client uses RPC transport (`worker/src/index.ts:887-892`). The infrastructure Worker currently receives Auth, runner, Sandbox, KV, R2, assets, and inherited `GH_TOKEN`, `PI_AUTH_JSON`, and `SCOTTY_TOKEN` bindings (`infra/cloudflare-stack.ts:127-198`, `worker/src/bindings.ts:6-21`). A new preview Worker must not inherit that privilege set.
- Session idle stop, hard cap, snapshot/sleep, runtime stop, and vaporize are authoritative lifecycle paths (`worker/src/session.ts:875-926`, `worker/src/session.ts:1109-1264`, `worker/src/session.ts:1523-1632`). Managed transitions can revoke before runtime mutation; unexpected `onStop` is observed only after provider stop and must invalidate previews immediately afterward. Preview activation must be fenced into both cases.
- Secure control-plane assets currently deny framing and set `form-action 'none'` in a narrow CSP (`worker/src/index.ts:1068-1078`). The proposed cross-origin bootstrap cannot originate from that page until a page-specific CSP mechanism is proven; globally weakening `secureAsset` is not acceptable.
- Containers intentionally receive session-bound Pi and GitHub sentinels (`worker/src/container-auth.ts:133-179`). A dev server in that same container can read and publish those sentinel strings. The preview gateway can prevent injecting credentials and control headers, but it cannot promise that hostile sandbox code will not disclose container-visible data.

### What the pinned SDK supports

Scotty pins `@cloudflare/sandbox` and its image to **0.12.3** (`worker/package.json:13`, `worker/container/Dockerfile:4,20`). In that pin:

- `containerFetch(request, port)` handles HTTP.
- `wsConnect(request, port)` handles WebSocket upgrades to a selected non-default port.
- Neither API accepts a runtime identity; `containerFetch()` may start/restart the Container. The SDK's adjacent runtime fence is private to deprecated preview forwarding, so the proposed direct gateway has a known restart race until B0 proves a non-deprecated fence.
- Valid application ports are `1024..65535`, excluding reserved port `3000`.
- Frontend servers must listen on `0.0.0.0`, not only `127.0.0.1`, to be reachable through the Container binding.
- `exposePort()` exists, but Cloudflare deprecated expose ports in June 2026 and directs users to tunnels. It must not become Scotty's product foundation.
- Quick tunnels support WebSockets but have public URLs, SSE buffering, restart/propagation limits, and changing URLs. Named tunnels add Cloudflare credentials and managed tunnel/DNS resources.

External evidence and pinned source links are consolidated in [`docs/research/frontend-sandbox-preview.md`](research/frontend-sandbox-preview.md), especially **“What pinned Sandbox SDK 0.12.3 supports,” “Option B,” and “Option D.”** This plan cites that research rather than repeating its external URLs.

### Future runner reuse is not current scope

Runner protocol v2 already has bounded, backpressured HTTP framing (`protocol/runner.ts:3-15`, `protocol/runner.ts:111-174`), but Docker mounted-app delivery currently returns `404` for every request (`cli/src/runner-docker.ts:409-432`) and the protocol has no WebSocket `101` transport. Build Cloudflare preview first. Keep the preview authority and gateway contracts provider-neutral enough for later runner adapters, but do not expand this effort into runner app delivery or WS framing.

## Requirements (R)

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                     | Status                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **R0** | A browser can use a live HTTP frontend dev server with representative WebSocket/HMR support, without publishing the repository by default.                                                                                                                                                                                                                                      | Core goal                  |
| **R1** | Untrusted preview JavaScript receives no Scotty control-plane authority, root token, real provider credential, or unrelated user access; private previews are not bearer URLs. The gateway never sources sentinels from privileged state or injects them into upstream requests/headers; it does not inspect opaque app bodies, which may disclose container-visible sentinels. | Must-have                  |
| **R2** | The full product direction works from remote and mobile browsers with framework-natural root paths, redirects, SPA navigation, single-use origins for service-worker isolation, and subresources.                                                                                                                                                                               | Must-have for full product |
| **R3** | The bridge preserves methods, paths, queries, safe headers, request/response streaming, cancellation, backpressure, redirects, SSE, WebSocket upgrades, and HMR reconnects.                                                                                                                                                                                                     | Must-have                  |
| **R4** | Preview stop, Auth-DO client revocation, sleep, hard cap, runtime replacement, and vaporize revoke access under explicit freshness semantics; any immediate-WS claim includes an owner that closes existing sockets.                                                                                                                                                            | Must-have                  |
| **R5** | The Auth DO remains authoritative for client status and the Session DO for the exact session, port, grant, and runtime generation; no public request chooses a URL, host, IP, or arbitrary port, and KV/runtime memory never becomes authority.                                                                                                                                 | Must-have                  |
| **R6** | Existing credential isolation and data boundaries remain intact: no real credentials in browser/container/log/KV/R2/Alchemy surfaces, and no new privileged preview-Worker bindings.                                                                                                                                                                                            | Must-have                  |
| **R7** | Existing HTTP routes, CLI JSON/exit behavior, `SessionRecord` v1, and provider binding stay compatible; additions are explicit and Cloudflare-first without blocking future runner reuse.                                                                                                                                                                                       | Must-have                  |
| **R8** | The chosen foundation avoids deprecated expose ports, generic egress widening, hidden public exposure, and cleanup claims Scotty cannot prove.                                                                                                                                                                                                                                  | Must-have                  |

## Rejected non-option — same-origin `/s/:id/preview/*`

This is not a fifth shape.

| Mechanism considered                                                                                        | Rejection                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticate `/s/:id/preview/<id>/*` with `__Host-scotty`, strip the prefix, and proxy to a registered port | Preview code would execute on the Scotty control-plane origin. `HttpOnly` stops cookie reads, not credentialed same-origin requests. The app could call session APIs with the browser client's `sessions:read` and `sessions:write` scopes. Prefix rewriting also breaks root-relative assets, redirects, HMR URLs, service-worker scope, and SPA navigation. |

See [`docs/research/frontend-sandbox-preview.md`](research/frontend-sandbox-preview.md), **“Option A — authenticated same-origin reverse proxy.”** Stripping cookies before forwarding does not solve browser-origin authority.

## Shapes (S)

The four shapes below are mutually exclusive product directions. C and D may remain documented escape hatches after another shape is chosen, but they are not implementation layers inside A or B.

### A: Local CLI loopback reverse proxy

Command: `scotty preview SESSION --port 5173`

| Part   | Mechanism                                                                                                                                                                                                                                       | Flag |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--: |
| **A1** | Add an authenticated, additive control-plane bridge that accepts only a validated session ID plus one port in `1024..65535` excluding `3000`; it resolves the selected Sandbox server-side and checks warm state.                               |      |
| **A2** | The local CLI holds the root bearer token and opens separate HTTP and WebSocket bridge streams. The browser connects only to a loopback listener; the root token is never placed in a URL, cookie, page, response, or browser request.          |  ⚠️  |
| **A3** | Bind only `127.0.0.1` and `::1`, choose/validate the requested local listener port, reject non-loopback peers and unexpected `Host`/`Origin`/Fetch Metadata, prevent DNS rebinding, and expose no control/admin endpoint on the preview origin. |  ⚠️  |
| **A4** | Proxy root-path HTTP and WS/HMR through the CLI with bounded headers/body handling, streaming, cancellation, backpressure, and hop-by-hop/credential header stripping. Closing the CLI closes both legs.                                        |  ⚠️  |
| **A5** | Require the dev server to bind `0.0.0.0:<sandbox-port>`. Show a local URL and an explicit “local-only” label; no mobile/remote claim.                                                                                                           |      |

**Security boundary:** hostile preview JS shares the loopback preview origin only with its own proxy. It cannot access an admin route there, does not know the root token, and cannot send Scotty cookies cross-site. The remote bridge still must reject arbitrary destinations and recheck Session DO state.

**Trade-off:** A is a real fallback product, not a stepping stone hidden inside B. Its local HTTP/WS transport, loopback hardening, and CLI lifecycle are separate work that B does not need.

### B: Dedicated-domain authenticated Scotty gateway

Example origin: `https://p-<opaque-handle>.preview.example.net/`, preferably on a dedicated registrable preview domain rather than a sibling of the control-plane host.

| Part   | Mechanism                                                                                                                                                                                                                                                                                                                                                                           | Flag |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--: |
| **B1** | An authenticated control-plane action registers one validated port for one warm Cloudflare session. The Session DO persists preview authority under a separate versioned storage key, including opaque preview ID, runtime epoch, port, expiry, status, creator client ID, and optional recorded dev-process ID. `SessionRecord` remains version `1`.                               |      |
| **B2** | Alchemy provisions a separate preview Worker, wildcard DNS/TLS route, and gateway relay DO. The preview Worker receives **only** a narrow preview service/DO bridge—no `SCOTTY_TOKEN`, `PI_AUTH_JSON`, `GH_TOKEN`, KV, R2, Auth DO, assets, runner, or unrestricted control-plane binding.                                                                                          |  ⚠️  |
| **B3** | The control plane issues a one-use, short-TTL ticket bound to `{previewId, clientId, runtimeEpoch}`. A top-level form POST redeems it on the preview host, verifies the expected control-plane origin, stores only digests, sets an exact-host `Secure; HttpOnly; SameSite=Strict; Path=/` preview-only cookie, and redirects without putting credentials in URL/history/referrers. |  ⚠️  |
| **B4** | Every request and upgrade resolves the opaque hostname. Composite authorization checks Auth-DO client status and Session-DO grant/session state with explicit race and freshness semantics. The routing handle alone grants nothing.                                                                                                                                                |  ⚠️  |
| **B5** | The privileged Session/Sandbox side uses a yet-to-be-proven adjacent runtime fence before direct HTTP/WS dispatch. Pinned `containerFetch(request, port)` and `wsConnect(request, port)` do not accept a runtime identity and may restart the Container, so a detached “check epoch, then fetch” sequence is insufficient.                                                          |  ⚠️  |
| **B6** | If immediate revocation is promised, a gateway relay DO terminates the browser socket and owns the non-hibernatable outbound Sandbox socket while active. It must define eviction/reconnect behavior and close propagation from both Auth and Session authorities.                                                                                                                  |  ⚠️  |
| **B7** | Managed lifecycle transitions first revoke preview grants and close relays, then stop/destroy runtime. Unexpected `onStop` invalidates grants immediately after observation. Resume increments a durable epoch only if B0 proves an adjacent dispatch fence.                                                                                                                        |  ⚠️  |
| **B8** | The terminal page gets bounded port input, “Open preview,” status, and “Stop preview” controls. The preview opens in a new tab with a clear “sandbox code—isolated from Scotty controls” label; embedding is out initially.                                                                                                                                                         |      |

The flags are the reason for the spike. Under shaping rules, an unresolved mechanism cannot be treated as proven fit.

### C: Sandbox quick or named tunnel escape hatch

| Part   | Mechanism                                                                                                                                                                                        | Flag |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--: |
| **C1** | A user explicitly requests a tunnel for one registered sandbox port; Scotty labels the returned URL public/user-managed and never auto-starts it from arbitrary repository code.                 |      |
| **C2** | Quick mode uses a random `*.trycloudflare.com` URL. It supports WebSockets, but the URL can change on restart, propagation may lag, SSE is buffered, and Quick Tunnel limits apply.              |      |
| **C3** | Named mode creates a stable tunnel/DNS route but requires narrowly provisioned Cloudflare credentials, durable resource ownership, restart reconciliation, explicit teardown, and orphan checks. |  ⚠️  |
| **C4** | Either mode requires a separately approved change to `enableInternet=false` and the finite egress allowlist. No generic Cloudflare or arbitrary-host egress widening is allowed.                 |  ⚠️  |

This remains a public/user-managed escape hatch even if made operable. It is not Scotty's private preview UX. See the research doc's **“Option B2 — Quick or named tunnel.”**

### D: External immutable/static or PR preview publication

| Part   | Mechanism                                                                                                                                                                                                                                  | Flag |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--: |
| **D1** | A user or agent builds an immutable static artifact or explicitly pushes a branch/PR to an external preview provider after informed user action. Scotty does not own this workflow unless a separate public-contract change is approved.   |      |
| **D2** | Provider-specific authentication, logs, retention, access policy, and cleanup remain explicit; Scotty does not claim session vaporize removes an external deployment unless an owned adapter proves it.                                    |      |
| **D3** | The user-owned tool returns only publication URL/status. Any future Scotty-owned adapter requires separate approval and must keep provider credentials out of container environment, files, args, output, logs, KV, R2, and API responses. |  ⚠️  |
| **D4** | Document this as publication: it is suitable for immutable/static or PR review, not a live/general dev server, arbitrary backend, or dependable HMR loop.                                                                                  |      |

## Full binary fit check: R × S

A check means the shape has a concrete mechanism that meets the complete requirement. A flagged or conditional mechanism is a failure until the spike resolves it.

| Req    | Requirement                                                                                                                                                                                                                                                                                                                                                                     | Status    |  A  |  B  |  C  |  D  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | :-: | :-: | :-: | :-: |
| **R0** | A browser can use a live HTTP frontend dev server with representative WebSocket/HMR support, without publishing the repository by default.                                                                                                                                                                                                                                      | Core goal | ❌  | ❌  | ❌  | ❌  |
| **R1** | Untrusted preview JavaScript receives no Scotty control-plane authority, root token, real provider credential, or unrelated user access; private previews are not bearer URLs. The gateway never sources sentinels from privileged state or injects them into upstream requests/headers; it does not inspect opaque app bodies, which may disclose container-visible sentinels. | Must-have | ❌  | ❌  | ❌  | ❌  |
| **R2** | The full product direction works from remote and mobile browsers with framework-natural root paths, redirects, SPA navigation, single-use origins for service-worker isolation, and subresources.                                                                                                                                                                               | Must-have | ❌  | ❌  | ❌  | ❌  |
| **R3** | The bridge preserves methods, paths, queries, safe headers, request/response streaming, cancellation, backpressure, redirects, SSE, WebSocket upgrades, and HMR reconnects.                                                                                                                                                                                                     | Must-have | ❌  | ❌  | ❌  | ❌  |
| **R4** | Preview stop, Auth-DO client revocation, sleep, hard cap, runtime replacement, and vaporize revoke access under explicit freshness semantics; any immediate-WS claim includes an owner that closes existing sockets.                                                                                                                                                            | Must-have | ❌  | ❌  | ❌  | ❌  |
| **R5** | The Auth DO remains authoritative for client status and the Session DO for the exact session, port, grant, and runtime generation; no public request chooses a URL, host, IP, or arbitrary port, and KV/runtime memory never becomes authority.                                                                                                                                 | Must-have | ❌  | ❌  | ❌  | ❌  |
| **R6** | Existing credential isolation and data boundaries remain intact: no real credentials in browser/container/log/KV/R2/Alchemy surfaces, and no new privileged preview-Worker bindings.                                                                                                                                                                                            | Must-have | ❌  | ❌  | ❌  | ❌  |
| **R7** | Existing HTTP routes, CLI JSON/exit behavior, `SessionRecord` v1, and provider binding stay compatible; additions are explicit and Cloudflare-first without blocking future runner reuse.                                                                                                                                                                                       | Must-have | ✅  | ✅  | ❌  | ❌  |
| **R8** | The chosen foundation avoids deprecated expose ports, generic egress widening, hidden public exposure, and cleanup claims Scotty cannot prove.                                                                                                                                                                                                                                  | Must-have | ✅  | ✅  | ❌  | ❌  |

**Failure notes:**

- **A / R0-R6:** the conceptual local shape is plausible, but the CLI HTTP/WS bridge, loopback hardening, credential/header isolation, lifecycle closure, and runtime fence are flagged until A0-A3 prove them; it intentionally fails remote/mobile R2.
- **B / R0-R6:** wildcard DNS/TLS, least-privilege bindings, CSP-compatible cookie bootstrap, composite Auth/Session authorization, adjacent runtime fencing, direct stream/WS ownership, service-worker isolation, and revocation freshness are unproven. B remains the preferred spike target, not a selected implementation.
- **C / R0-R8:** the tunnel publishes a bearer-like URL, Quick Tunnel buffers SSE and changes on restart, named mode adds credentials/resources, current egress blocks it, and authority/cleanup do not match Scotty's lifecycle.
- **D / R0-R8:** publication is not a private live general proxy and is currently user/agent-owned. Any Scotty-owned publishing adapter would be a separate contract and credential review.

## Recommendation

### Recommended decision rule

1. **Approve an M-sized disposable-stage spike, not the full build.** The spike must resolve every B flag with deployed evidence and leave no persistent production resources.
2. **If the spike passes and a dedicated wildcard preview domain is acceptable, select B.** Re-run the fit check; B must become all ✅ before implementation begins.
3. **If the domain is rejected or the near-term need is private local-only preview, select A.** Scope it honestly as local-only.
4. Keep C as a documented, explicit public/user-managed escape hatch and D as an external publication workflow. Do not market either as private live preview.

### Why B is preferred

B is the only shape with the potential to combine full browser UX with root-path framework compatibility, Scotty authentication, split Auth/Session authority, runtime fencing, and lifecycle revocation. The spike must prove that potential; the current SDK APIs do not yet supply the required adjacent runtime fence. B also avoids dependence on deprecated `exposePort()` and avoids widening container egress for `cloudflared`.

The additional Worker is justified here by a strict least-privilege and origin boundary, unlike a cosmetic topology split. The preview Worker must be safe to expose to hostile app traffic without carrying Scotty's secrets or storage bindings.

## Candidate scope, constraints, and contracts for B

### In scope

- Cloudflare Sandbox sessions only.
- One explicitly registered port per preview; bounded previews per session.
- HTTP, streaming, WebSocket/HMR, new-tab opening, one-use cookie bootstrap, stop/revoke, runtime epoch fencing, and deployed canary proof.
- Additive control-plane API/UI contracts and dedicated preview infrastructure.

### Out of scope

- Same-origin path proxying, HTML/base-path rewriting, iframe embedding, automatic port exposure, general TCP/UDP, arbitrary URL proxying, public sharing, collaborative multi-user grants, preview app cookies, and automatic framework configuration.
- Runner preview delivery. Future reuse may implement the provider-neutral authority/forwarding interface after mounted HTTP and WS `101` transport exist.
- Building on `exposePort()` or automatically provisioning tunnels.

### Compatibility commitments

- Keep all current routes and their envelopes/statuses unchanged; `/s/:id/*` continues returning `404` unless an already-defined terminal path matches.
- Add new `/api/sessions/:id/previews...` control routes rather than repurposing `/s/:id/*`.
- Preserve CLI JSON keys and exit codes. Shape B does not require `scotty preview`; if a CLI opener is later added, it is a new command with a separately reviewed stable JSON shape.
- Keep `SessionRecordSchema` at version `1`. Preview authority uses a separately versioned Session DO storage key such as `scotty:preview-authority:1`.
- Keep provider binding immutable. A Cloudflare preview does not imply runner support or provider fallback.

## Candidate architecture and flow for B

### Places and trust boundaries

```text
Control browser (__Host-scotty)
  -> existing Scotty Worker /api/sessions/:id/previews
  -> Auth DO validates client + Session DO registers authority
  -> one-use form POST ticket

Preview browser (exact-host __Host-scotty-preview only)
  -> dedicated wildcard Preview Worker
  -> Preview Relay DO (routing projection + live socket ownership only)
  -> narrow Preview Bridge
  -> authoritative Session/Sandbox DO
  -> containerFetch(request, port) or wsConnect(request, port)
  -> 0.0.0.0:<registered-port> in selected Container
```

The gateway never sends the preview browser `__Host-scotty`, the root token, a real provider credential, a Sandbox SDK token, the registered numeric port as routing authority, or a destination URL. This does **not** guarantee sentinel secrecy: hostile code in the same container can read and deliberately return the already container-visible sentinels.

### Registration and bootstrap flow

1. A user starts the dev server on `0.0.0.0:5173`.
2. The authenticated control page submits port `5173` to `POST /api/sessions/:id/previews`.
3. The existing Worker validates JSON, browser mutation security, `sessions:write`, current client identity, session/provider/warm state, port range, preview count, and no conflicting destructive operation.
4. The Session DO transaction writes a preview record and candidate Scotty runtime epoch, then returns an opaque preview handle plus non-secret status. It never accepts a destination URL/host/IP. Registration is not safe to dispatch until B0 proves how that epoch is fenced against SDK-driven restart.
5. `POST /api/sessions/:id/previews/:previewId/tickets` stores only a one-use ticket digest bound to preview, client, epoch, and short expiry.
6. A dedicated control-page response with an exact preview-host `form-action` creates a top-level form POST to a permanently single-use hostname such as `https://p-<handle>.<preview-domain>/_scotty/bootstrap`. The generic `secureAsset` CSP remains unchanged. The ticket is in the POST body, never the URL.
7. The preview gateway validates host syntax and expected control-plane `Origin`; the narrow bridge atomically redeems the digest in the Session DO.
8. The preview host sets `__Host-scotty-preview=<random credential>` as exact-host `Secure; HttpOnly; SameSite=Strict; Path=/`, stores only its digest, and redirects to `/` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

The spike must prove page-specific CSP, cross-site form POST, cookie acceptance, redirect, browser history, referrer behavior, and service-worker behavior on the actual chosen domains. A hostname that has ever served app code is never reused for a ticket or later runtime, so a stale service worker cannot intercept a new bootstrap. If browser policy requires a same-host bootstrap document, that document must retain one-use redemption and never expose the ticket to script.

### HTTP request flow

1. Preview Worker parses only the expected wildcard hostname; malformed/unknown handles fail before container access.
2. Relay/bridge resolves the handle to a routing projection. The Auth DO checks the bound browser client; the Session DO separately checks the preview grant, cookie digest, expiry, lifecycle, provider, port, and runtime generation. Neither DO claims the other's authority.
3. The spike defines ordering and freshness. At minimum, Auth status is checked first and Session authority is checked immediately before dispatch; revocation racing after the Auth check may permit one already-authorized request unless a stronger cross-DO protocol is proven.
4. The Session/Sandbox host creates a new upstream request for the same path/query/method/body. It strips `Cookie`, `Authorization`, Scotty/internal proxy headers, hop-by-hop headers, and unapproved Cloudflare metadata; it sets intentional `Forwarded`/`X-Forwarded-*` values.
5. Dispatch occurs only if B0 proves a non-deprecated public API or narrow subclass adapter that fences the authorized runtime generation adjacent to the actual HTTP/WS send. Pinned `containerFetch`/`wsConnect` alone do not provide that fence and may start a replacement Container.
6. The native streamed response returns without buffering, with manual redirects and upstream `Set-Cookie` removed by default. Errors expose no session existence, port, credentials, or internal causes.

### WebSocket flow and the hard revocation choice

**Preferred contract: immediate revocation, if proven.** The gateway relay DO terminates the browser WebSocket, opens the Sandbox leg through an adjacent runtime-fenced dispatch, pumps frames with bounded queues/backpressure, and owns both sockets while active. Only the browser-facing server socket can use DO hibernation; the outbound/client Sandbox socket cannot. B0 must determine whether the relay stays active, forces browser reconnect after eviction, or cannot support this contract within platform limits.

Preview stop and managed session transitions originate in the Session DO. Client revocation originates in the Auth DO and therefore requires a durable fan-out or bounded reauthorization protocol; the Session DO cannot emit a close merely because another DO changed. Each authority commits its own revocation before close delivery. If the spike cannot prove relay ownership, Auth-to-relay discovery, close delivery, and eviction behavior, the user must choose one of two explicit contracts:

- **Block B** until immediate revocation is implementable; or
- approve **bounded/non-immediate revocation**, where new requests/upgrades fail immediately but an existing WS may remain until container stop or a documented short maximum lifetime.

There is no acceptable plan that says “revoked” while silently leaving an unbounded HMR socket alive.

## State ownership and persistence

| State                                                     | Authority             | Stored form                                                                     | Notes                                                                                                     |
| --------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Browser client registration/revocation                    | Existing Auth DO      | Existing auth authority                                                         | Composite preview authorization must query or receive revocation from this owner                          |
| Session lifecycle, operation lease, provider, credentials | Existing Session DO   | Existing keys and `SessionRecord` v1                                            | Unchanged                                                                                                 |
| Preview registry and runtime epoch                        | Session DO            | `scotty:preview-authority:1` schema                                             | Separate version; not added to `SessionRecord` v1                                                         |
| Bootstrap tickets                                         | Session DO            | Digest, preview/client/epoch binding, issued/expiry/redeemed/revoked timestamps | One use; plaintext returned once only to control flow                                                     |
| Preview cookies/grants                                    | Session DO            | Credential digest, preview/client/epoch binding, expiry/revocation              | Exact-host cookie value never logged or returned after issue                                              |
| Hostname-to-session routing                               | Relay DO              | Opaque routing projection only                                                  | Cannot authorize; stale/missing authority fails closed                                                    |
| Live browser WebSocket ownership                          | Relay DO              | Browser-side hibernation attachment with opaque IDs only                        | Outbound Sandbox WebSocket cannot hibernate; Auth and Session revocations remain separately authoritative |
| Session list                                              | KV                    | Existing non-secret projection                                                  | No preview authorization or routing                                                                       |
| Backups                                                   | R2                    | Existing immutable generations                                                  | No preview grants, tickets, cookies, or routing records                                                   |
| Effect/runtime memory                                     | Request/socket scoped | Disposable                                                                      | Never sole authority                                                                                      |

### Runtime epoch rule

A preview should be valid only for the exact runtime generation in which its port was registered. Managed sleep, hard cap, and vaporize can mark grants inactive before stopping/destruction; unexpected `onStop` can only invalidate immediately after provider stop is observed. Old epochs must never become valid after resume.

This is currently a known blocker, not an available mechanism. Pinned `containerFetch()` can start/restart a Container and accepts no runtime identity; `wsConnect()` only switches the port and fetches. The SDK's stronger adjacent runtime check is private to deprecated preview forwarding. B0 must prove a non-deprecated public `fetch-if-current-runtime` equivalent or the smallest source-verified subclass adapter with an adjacent fence. If none exists, B fails R5 and stops; “check epoch, then call `containerFetch`” is not sufficient.

## Security policy

### Preview Worker binding allowlist

The new preview Worker may receive only:

- its own relay DO namespace; and
- one narrow Preview Bridge service/DO binding exposing only bootstrap, authorize, HTTP-forward, WS-open/relay-control, and revoke operations.

It must receive **none** of:

- `SCOTTY_TOKEN`, `PI_AUTH_JSON`, or `GH_TOKEN`;
- `SESSIONS` KV or `BACKUP_BUCKET` R2;
- Auth DO, runner DO/registry, assets, or account-wide Cloudflare credentials;
- unrestricted fetch access to the control-plane Worker or raw unrestricted Sandbox methods.

The privileged bridge stays on the Session/Sandbox side and may perform narrow Auth-DO client introspection without exposing the Auth binding to the preview Worker. Its request/response schemas contain opaque IDs, bounded metadata, native stream/socket ownership where required, and no credentials. Client revocation authority never moves out of Auth DO. Alchemy plan tests must assert the exact binding set.

### Request and browser controls

- Dedicated preview registrable domain preferred. Never set a parent-domain cookie.
- No credentialed CORS from preview origins to Scotty APIs. Cross-origin Scotty API requests fail normally.
- Routing handle is not authorization; copied URLs require a valid exact-host preview cookie. Every preview grant/runtime gets a permanently single-use hostname; never bootstrap a new grant on an origin that may retain an app service worker, Cache Storage, cookies, or browser storage.
- Reject absolute-form targets, malformed wildcard hosts, unknown/cross-session handles, direct ports, port `3000`, stale epochs, spoofed internal headers, and redirects that try to retarget the proxy.
- Strip upstream `Set-Cookie` initially. Preview application cookie support requires a separate decision because it can conflict with gateway auth.
- Do not impose the terminal CSP on app responses. Add only safe gateway headers that do not break dev servers; bootstrap/error documents use strict no-store/no-referrer policy.
- Log event metadata only: request/trace ID, session/preview opaque IDs, registered port, epoch, status, bytes, duration, and sanitized close reason. Never log query strings, bodies, cookies, tickets, authorization, sentinels, app headers, or container output by default.

## Failure behavior

| Failure                                                        | Required behavior                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unknown/malformed preview host or cookie                       | Generic `404`/`401`; no session/port disclosure and no container access                                                                                                        |
| Session not warm, destructive operation active, or stale epoch | `410 Gone` or typed preview-stale response; revoke grant and close relay                                                                                                       |
| Dev server not listening                                       | Bounded `502`/`503` with “start on `0.0.0.0:<port>`” guidance; never auto-expose another port                                                                                  |
| Container restarts or bridge loses runtime identity            | No dispatch unless an adjacent runtime fence is proven; otherwise B is blocked. After observed replacement, revoke the old epoch and require explicit re-registration.         |
| Ticket replay/expiry                                           | Reject atomically; do not issue a cookie                                                                                                                                       |
| HTTP client abort                                              | Cancel upstream stream without mutating durable lifecycle state                                                                                                                |
| Relay/WS failure                                               | Close both legs, release scoped resources, and emit a sanitized event. Do not extend the hard cap; activity/idle behavior follows O7 and is visible to the user.               |
| Lifecycle revocation cannot reach relay                        | New traffic denied by committed authority; retry close command and surface degraded revocation telemetry. Product contract follows the explicit immediate-vs-bounded decision. |

## Conditional implementation slices for candidate Shape B

All slices are vertical and independently demonstrable. File names are likely targets; implementation must verify pinned Effect/Alchemy/Sandbox APIs before coding.

### B0 — disposable feasibility and security spike (M)

**Behavior delivered:** evidence only—not a production feature. A stage-isolated Vite fixture attempts a wildcard preview host, HTTP/SSE and WS/HMR forwarding, CSP-compatible one-use cookie bootstrap, adjacent runtime fencing, composite Auth/Session authorization, and the selected socket-revocation contract.

**Likely files/symbols:**

- new `spikes/infra/frontend-preview.run.ts` and `spikes/infra/frontend-preview.md`;
- new minimal `spikes/frontend-preview/` fixture;
- `infra/cloudflare-stack.ts` patterns and pinned Alchemy source for Worker routes/custom domains/DO bindings;
- pinned `Sandbox.containerFetch`, `Sandbox.wsConnect`, and runtime identity source cited by the research doc.

**Questions that must be answered:**

1. What exact Alchemy resources produce stage-isolated wildcard DNS/TLS and route the host to a separate Worker?
2. What page-specific CSP permits only the intended bootstrap form without weakening generic `secureAsset`, and does cross-site POST set the exact-host Strict cookie without leakage?
3. Which native object owns HTTP stream, client abort, and WS scope across Worker → service/DO bridge → Sandbox DO?
4. Given that the outbound Sandbox WebSocket cannot hibernate, can a relay own both legs within connection/time limits, close active sockets, and recover through forced reconnect after eviction?
5. What non-deprecated public API or narrow subclass adapter fences runtime generation adjacent to dispatch, despite `containerFetch()` being able to restart the Container?
6. How are Auth-DO client status and Session-DO grant status composed, with what freshness/race contract, and how does client revocation discover and close relay sockets?
7. Do permanently single-use hostnames prevent stale service workers, Cache Storage, and prior app state from intercepting a later bootstrap or presenting stale content as live?
8. Does preview HTTP/HMR count as session activity? If not, what independent durable idle policy prevents SDK activity renewal from extending the session?

**Gate:** all questions have concrete source/deployed answers; teardown proves Worker, routes, DNS records, DO instances, and containers are absent. In particular, missing adjacent runtime fencing blocks B rather than being documented away. Any failed B requirement remains ❌ and blocks the build.

### B1 — authoritative registration plus one HTTP preview (M)

**Behavior delivered:** an authenticated control action registers a port in Session DO storage and a disposable preview host serves one fixture request only after authoritative validation.

**Likely files/symbols:**

- new `worker/src/preview-contracts.ts`: `PreviewAuthoritySchema`, request/view/error schemas, port/host validation;
- new `worker/src/preview-authority.ts`: Effect service/layer over separate Session DO keys;
- `worker/src/session.ts`: thin RPC methods such as `registerPreview`, `authorizePreview`, `revokePreview`; runtime epoch lifecycle hooks;
- `worker/src/index.ts`: additive `POST/GET/DELETE /api/sessions/:id/previews...` routes;
- `worker/src/contracts.ts`: public API schemas only—do **not** modify `SessionRecordSchema`;
- tests: new `worker/test/preview-authority.test.ts`, plus `worker/test/routes.test.ts` and lifecycle fault injection.

**Execution/state boundary:** browser cookie auth → control Worker → Auth identity → Session DO transaction → preview authority v1. KV/R2 untouched.

**Verification:** malformed ports/hosts, port `3000`, cross-session IDs, duplicate/replayed operations, stale epochs, DO reconstruction, operation conflicts, and `SessionRecord` v1 golden fixtures.

**Risk:** runtime epoch semantics. If B0 did not prove them, this slice must not start.

### B2 — least-privilege gateway and cookie bootstrap (M)

**Behavior delivered:** “Open preview” performs one-use form redemption on a dedicated preview host and lands at `/` with only a preview cookie.

**Likely files/symbols:**

- new `worker/src/preview-gateway.ts`: host parsing, bootstrap/error documents, cookie handling;
- new `worker/src/preview-bridge.ts`: narrow typed service/DO facade;
- new `worker/src/preview-relay-object.ts`: `ScottyPreviewRelay` routing projection and socket-ready skeleton;
- new `worker/src/preview-bindings.ts`: exact minimal binding type, separate from privileged `Bindings`;
- `infra/cloudflare-stack.ts` and `infra/installation.ts`: preview Worker, relay DO migration, wildcard domain/route, narrow binding;
- `worker/src/index.ts`: ticket issue route and a dedicated control response with exact bootstrap `form-action`, without changing generic `secureAsset`;
- `worker/public/terminal.html`, `terminal.js`, and `terminal.css`: bounded port form, Open/Stop/status, new-tab bootstrap;
- tests: new `worker/test/preview-gateway.test.ts`, infrastructure plan/binding tests, route/browser security tests.

**Execution/state boundary:** control cookie stays on control host; one-use ticket crosses only in form body; exact-host preview cookie is separately digest-backed.

**Verification:** replay, expiry, wrong origin, wrong host, copied URL, exact CSP, no parent-domain cookie, no credentialed CORS, history/referrer/log scan, permanently single-use hostnames, stale service-worker/Cache Storage isolation, and exact preview Worker binding allowlist.

**Risk:** browser cookie policy varies with domain relationship. B0 is the hard dependency.

### B3 — production HTTP streaming bridge (M)

**Behavior delivered:** Vite root document, module graph, root-relative assets, redirects, SPA fallback, large upload, chunked stream, and SSE traverse the production adapter without buffering.

**Likely files/symbols:**

- `worker/src/preview-gateway.ts`: request normalization and response sanitization;
- `worker/src/preview-bridge.ts`: native HTTP stream handoff;
- `worker/src/session.ts`: preview HTTP host island using the B0-proven adjacent runtime-fenced dispatch; direct check-then-`containerFetch` is forbidden;
- new `worker/test/preview-http-contract.test.ts`; extend deployed fixture/canary.

**Execution/state boundary:** preview cookie digest → Auth DO client check → Session DO grant check → adjacent runtime-fenced exact port dispatch → native Container stream. No target comes from request path/query/header. The tests define the unavoidable cross-DO race contract.

**Verification:** method/path/query preservation, manual redirect behavior, hop-by-hop/internal/auth/cookie stripping, upstream `Set-Cookie` removal, cancellation/backpressure, limits, SSRF matrix, and secret honeypots.

**Risk:** stream scope can outlive an Effect/DO RPC event. Follow the established native-host-island rule and B0 evidence; do not serialize or buffer the response as a workaround.

### B4 — owned WebSocket/HMR relay (L)

**Behavior delivered:** WebSocket echo and Vite HMR reconnect through a relay DO; preview stop closes an existing socket within the selected contract.

**Likely files/symbols:**

- `worker/src/preview-relay-object.ts`: browser-side hibernation metadata, non-hibernatable outbound socket lifetime, bounded frame pump, close/reconnect;
- `worker/src/preview-bridge.ts`: WS-open and revocation operations only;
- `worker/src/session.ts`: authorized `wsConnect(request, port)` host island and relay close notifications;
- infrastructure export/migration for `ScottyPreviewRelay`;
- new `worker/test/preview-websocket.test.ts` and deployed WS/HMR canary.

**Execution/state boundary:** relay owns both native sockets; Session DO owns authorization/revocation; attachments contain opaque IDs, not credentials.

**Verification:** non-upgrade rejection, external `Origin`, binary/text frames, ordering, bounded queues, backpressure, abnormal close, relay eviction and forced reconnect, outbound connection/time limits, Auth-DO client revoke, Session-DO preview revoke, epoch change, and no orphan socket.

**Risk:** immediate revocation may be infeasible across the exact native bridge. Do not downgrade silently; return to the open decision.

### B5 — lifecycle fencing and user-visible status (M)

**Behavior delivered:** preview status moves through `starting`, `ready`, `stale`, `sleeping`, and `revoked`; managed stop, sleep, hard cap, resume, and vaporize revoke before runtime mutation, while unexpected `onStop` invalidates immediately after observation.

**Likely files/symbols:**

- `worker/src/preview-authority.ts`: transition functions and idempotent revoke-all;
- `worker/src/session.ts`: compose revocation into snapshot/sleep, hard-cap, `onActivityExpired`, `onStop`, resume, and vaporize programs;
- `worker/public/terminal.js`: status/retry/stop UX;
- lifecycle tests in `worker/test/preview-authority.test.ts`, `session-lifecycle-machine.test.ts`, `session-down-vaporize.test.ts`, and `session-resume.test.ts`.

**Execution/state boundary:** for managed transitions, Session DO commits inactive/next epoch first, relay close follows, then container stop/destroy. Unexpected provider stop reverses what can be guaranteed: `onStop` observes the stop, invalidates authority, and closes relays afterward. Projection never authorizes.

**Verification:** injected failure at every ordering point, stale callback/nonce, repeated revoke, DO reconstruction, crash/restart, resume re-registration, vaporize retry, and hard-cap canary.

**Risk:** close notification can fail after durable revocation. Keep denial authoritative, retry closure, and expose degraded telemetry.

### B6 — product hardening, canary, and guarded rollout (M/L)

**Behavior delivered:** the full protocol/security matrix passes against fake and production adapters; a stage deployment is usable from desktop/mobile and leaves no resources after teardown.

**Likely files/symbols:**

- `spikes/infra/full-stack-canary.run.ts`: add preview lifecycle without weakening existing session proof;
- `e2e/` preview browser/protocol cases and `e2e/scripts/scan.mjs` honeypots;
- `infra/cloudflare-stack.ts` plan assertions, observability, retention/removal policy;
- operator docs for wildcard DNS, preview domain, rollout, incident revoke, and destroy.

**Verification:** the complete matrix below plus the repository baseline gates.

**Risk:** production DNS/cookie behavior can differ from a local fake; deployed stage proof is mandatory.

## Fallback implementation slices for Shape A

Do these only if A is selected. They are not prerequisites for B.

| Slice                             | Relative effort | Behavior                                                                                                                                                                                                          | Likely files and proof                                                                                                           |
| --------------------------------- | :-------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **A0 — bridge contract**          |       S/M       | Spike and add root-bearer HTTP/WS bridge endpoints that validate session/warm state, one exact port, and an adjacent runtime fence; no public destination fields.                                                 | `worker/src/index.ts`, `worker/src/session.ts`, new `worker/src/preview-contracts.ts`, route/SSRF/restart-race tests             |
| **A1 — loopback proxy**           |        M        | Add `scotty preview SESSION --port 5173`; bind only loopback, keep bearer server-side, stream HTTP and WS, close on interruption.                                                                                 | `cli/src/commands.ts`, `cli/src/services.ts`, `cli/src/transport.ts`, new `cli/src/preview-proxy.ts`, CLI JSON/exit golden tests |
| **A2 — localhost hardening**      |        M        | Reject non-loopback peers, unexpected Host/Origin/Fetch Metadata, DNS rebinding, bridge/admin path access, and drive-by browser requests; use a short-lived loopback bootstrap cookie if tests show it is needed. | `cli/src/preview-proxy.ts`, dedicated adversarial loopback/WS tests, browser canary                                              |
| **A3 — protocol/lifecycle proof** |        M        | Vite HTTP/SSE/HMR works; CLI exit and session lifecycle close streams; docs state local-only and `0.0.0.0` sandbox binding.                                                                                       | CLI/Worker integration tests and a deployed Sandbox canary                                                                       |

## Verification matrix

| Area                    | Local/fake contract                                                                                                                                                                                      | Production adapter                                                                                                                                              | Deployed stage acceptance                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Routing and SSRF**    | Reject malformed host, unknown/cross-session ID, direct numeric port, `3000`, absolute-form URL, stale epoch, spoofed headers, internal redirect target                                                  | Exact registered-port call only; no request-selected URL/host/IP                                                                                                | Wildcard route reaches only intended stage/session/container                                                                |
| **Browser authority**   | Preview origin cannot authenticate to Scotty API; copied URL lacks grant; no credentialed CORS; parent-domain cookie rejected                                                                            | Binding plan proves no Auth/secrets/KV/R2 in preview Worker                                                                                                     | Real browser proves control cookie absent from preview requests and preview JS cannot mutate sessions                       |
| **Ticket/cookie**       | One use, short TTL, digest-only storage, client/preview/epoch binding, replay and wrong-origin denial                                                                                                    | DO reconstruction preserves consumed/revoked state                                                                                                              | Form POST → exact-host Strict cookie → clean redirect; no ticket in URL/history/referrer/log                                |
| **HTTP parity**         | Methods, path/query, headers, large body, redirect, SPA fallback, stream, SSE, abort, backpressure                                                                                                       | Native `containerFetch` adapter contract                                                                                                                        | Vite module graph and long-lived stream through actual Worker/Container                                                     |
| **WebSocket parity**    | Text/binary echo, ordering, limits, backpressure, reconnect, abnormal close                                                                                                                              | Runtime-fenced WS open; browser-side hibernation only; outbound lifetime/eviction contract                                                                      | Vite HMR, forced reconnect, and selected revocation guarantee                                                               |
| **Lifecycle**           | Stop, client revoke, sleep, hard cap, crash, `onStop`, resume epoch, vaporize, retries                                                                                                                   | Production Session DO/relay contracts with fault injection                                                                                                      | Shortened hard cap and vaporize leave no active preview/socket/runtime authority                                            |
| **Credentials/logging** | Honeypot root, real Pi/GitHub credentials, ticket, cookie, and SDK token never appear in forbidden surfaces; gateway never sources sentinels from privileged state or injects them into requests/headers | Alchemy plan/state/output/bundle and DO/KV/R2 scans; opaque app bodies are not inspected and container-visible sentinels remain an explicit existing capability | Runtime logs/resources pass scan; adversarial app documents possible sentinel disclosure without real-credential disclosure |
| **Compatibility**       | Existing route, CLI, auth, `SessionRecord` v1, terminal, runner, backup suites unchanged                                                                                                                 | Existing production adapters still pass shared contracts                                                                                                        | Current session canary plus preview canary both pass; next Alchemy plan is no-op                                            |
| **Operations**          | Rate/size/concurrency limits, sanitized events, typed failures                                                                                                                                           | Alert/revoke/teardown procedures exercise real bindings                                                                                                         | Wildcard DNS/TLS, rollout settlement, rollback, and zero-orphan audit pass                                                  |

Per repository policy, implementation runs formatting before lint, then focused tests, affected typechecks, full tests, secret scan, standalone CLI build, container build, and the isolated deployed canary. A local fake cannot prove DNS/TLS, cookie policy, Container port reachability, stream lifetime, or socket ownership.

## Rollout and rollback

### Rollout

1. Deploy **B0 only** to fresh random stage names and a disposable wildcard subdomain. Destroy it after evidence capture.
2. Build B1–B5 behind an installation-level preview feature flag defaulting off. Existing routes and assets continue unchanged.
3. Deploy a shadow stage with synthetic credentials and the exact least-privilege binding audit. Run desktop/mobile, HTTP/WS, lifecycle, and secret scans.
4. Enable for one disposable production-like installation, cap previews/TTL/concurrency conservatively, and observe revocation/orphan telemetry.
5. Enable for production only after explicit plan review and approval. Remove the feature flag only after a stable observation window and a no-op Alchemy plan.

### Rollback

- Traffic rollback disables preview registration first, commits all preview grants revoked, closes relay sockets, and then removes the wildcard route/preview Worker. Existing session/terminal APIs remain available.
- Keep preview authority storage versioned and readable during rollback so cleanup can revoke/delete it idempotently; do not roll back by pretending records do not exist.
- Never delete or transfer the authoritative existing Sandbox DO namespace, KV, R2, or `SessionRecord` state as part of preview rollback.
- Infrastructure destroy must remove only preview Worker/relay/routes/domain records owned by the stage. Retained Session DO preview keys are cleaned by an idempotent migration after all old gateway traffic is gone.
- If B is abandoned after the spike, A requires a new explicit selection and its own slices; do not retain half of B as an undocumented local bridge.

## Risks and mitigations

| Risk                                                                               | Impact                                            | Mitigation / gate                                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Wildcard domain or cookie bootstrap does not work across the desired site boundary | B cannot provide seamless private UX              | B0 deployed browser proof; choose A rather than weaken origin isolation                                                  |
| Long-lived stream/WS objects cannot safely cross the proposed narrow bridge        | Buffering, broken HMR, leaked scopes              | B0 native ownership trace; move ownership into the relay/Session host island or block B                                  |
| Immediate WS close cannot be guaranteed                                            | Revoked user retains an existing HMR channel      | Explicit immediate-vs-bounded decision; no unbounded claim                                                               |
| Runtime restart is not reliably observable                                         | Old grant reaches a replacement process/port      | Durable epoch, fail-closed stale state, explicit re-registration; block if no reliable fence                             |
| Preview Worker gains privileged bindings over time                                 | Hostile traffic reaches credentials/control state | Separate binding type, Alchemy exact-set tests, plan diff gate, no inheritance                                           |
| Dev server trusts forwarded host/origin incorrectly                                | Host-header or WS-origin abuse                    | Gateway sanitization, explicit external host/proto, framework guidance, adversarial tests                                |
| Preview traffic renews SDK activity and keeps sessions alive invisibly             | Cost/lifecycle contract regression                | O7 decides whether preview counts as activity; otherwise use an independent durable idle policy. Hard cap never extends. |
| Quick workaround becomes permanent                                                 | Public exposure or deprecated dependency          | No `exposePort()` product path; C remains labelled escape hatch and requires separate approval                           |
| Runner reuse broadens scope                                                        | Delays Cloudflare feature and weakens proof       | Provider-neutral contracts only; runner mounted HTTP/WS implementation remains a future packet                           |

## Open decisions

| ID     | Decision                                                      | Options                                                                                                            | What it gates                                              |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **O1** | Is a dedicated wildcard preview DNS/domain acceptable?        | Dedicated registrable domain (preferred) / sibling wildcard domain / no domain                                     | B0 and all of B; “no domain” selects A for private preview |
| **O2** | What revocation contract is required for existing WebSockets? | Immediate via relay DO if proven / bounded non-immediate with explicit maximum / block until immediate is possible | B0 success criteria and B4 design                          |
| **O3** | What is tomorrow's near-term product target?                  | Full remote/mobile product B / private local-only A                                                                | Prevents implementing A as hidden scaffolding for B        |
| **O4** | Where should preview controls live initially?                 | Terminal page port form (recommended) / sessions page / additive CLI opener after B                                | B2 UI files and public contract surface                    |
| **O5** | Are preview app cookies needed in v1?                         | Strip all upstream `Set-Cookie` (recommended) / design namespaced app-cookie policy                                | Gateway response policy and browser tests                  |
| **O6** | Should C and D be documented now?                             | Document as unsupported escape hatches / omit until separately requested                                           | User guidance only; neither gates A or B                   |
| **O7** | Does preview traffic count as session activity?               | Yes, while visible in UI / no, enforce an independent durable idle deadline                                        | Idle-stop semantics and B5                                 |
| **O8** | Is same-container sentinel disclosure acceptable?             | Accept existing capability boundary / require a separate credentialless preview execution boundary                 | R1 scope and whether A/B are viable without redesign       |

## Decision for tomorrow

- [ ] Choose **full remote/mobile B** or **local-only A** as the target.
- [ ] If B: approve or reject a **dedicated wildcard preview domain** and disposable B0 spike.
- [ ] Choose **immediate relay-owned WS revocation if proven** or an explicit bounded/non-immediate contract.
- [ ] Choose initial controls: **terminal page** or **sessions page**.
- [ ] Decide whether same-container sentinel disclosure is acceptable and whether preview traffic counts as idle activity.
- [ ] Confirm v1 strips all preview-app `Set-Cookie` headers and keeps C/D as labelled escape hatches only.
