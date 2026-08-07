# Kitesurf-first browser evidence architecture

- **Status:** target architecture
- **Scope:** one-shot browser tests against one warm Cloudflare Sandbox session
- **Supersedes for this decision:** `docs/kitesurf-worker-native-runtime.md`, `docs/kitesurf-preview-bridge.md`, and `docs/kitesurf-evidence-lifecycle.md`

## Decision

Scotty needs two separate session-bound capabilities:

1. A **portal** is a stable, authenticated HTTPS route to a live development service in the session container. Humans open it in their own browser and get the working application, including HTTP streaming, SSE, WebSockets, and live reload. A portal is durable desired state attached to the session, but it does not hold the session's global operation lease while people use it.
2. An **evidence job** is a short, one-shot Kitesurf automation run against that same portal origin. It holds the session's global `evidence` operation lease only while its bounded test graph executes and stores screenshots and assertions for later review.

This split follows Amp Portals' useful product shape without making Kitesurf responsible for the human preview. It also isolates Kitesurf's beta compatibility from the portal: the working version is rendered by the reviewer's real browser, while Kitesurf provides optional automated evidence.

Scotty will execute a **single-request, one-shot, declarative browser test job** in Worker/Durable Object code. The job launches Kitesurf through the native Browser Run binding:

```ts
const browser = await launch(env.BROWSER, { browser: "kitesurf" });
```

The exact package is `@cloudflare/playwright@1.3.5`. Its published types return `SessionlessBrowser` for this overload, and `browser.sessionId()` is `undefined`. Its implementation connects directly to the sessionless Kitesurf endpoint rather than acquiring a reusable Browser Run session. This removes provider-session acquisition, session IDs, reconnect, session listing/history, close reconciliation, and the proposed installation acquisition broker from Scotty's Kitesurf design.

One request carries the whole test graph: approved port, relative paths, bounded locator actions, explicit assertions, and PNG timeline policy. The Sandbox Durable Object (DO) holds the sole `evidence` operation lease for the entire job. It exposes the approved port only while that lease is current, executes every step, writes screenshot bytes directly to private R2, unexposes the port, closes the sessionless browser connection, and only then commits success.

The app is reached through an installation-supplied production wildcard preview origin. Scotty uses the pinned Sandbox SDK's `exposePort()` and `proxyToSandbox()` forwarding implementation, but does **not** treat the SDK route token as authorization. The Worker first validates a separate 256-bit, `HttpOnly`, `Secure`, exact-host preview cookie against a digest in the authoritative DO evidence lease. It strips that cookie and all Scotty credentials before calling `proxyToSandbox()`. The SDK token is only a short route nonce. Finalization always calls `unexposePort()`.

There is no `agent-browser`, container Chromium, Browser Run REST/CDP token, Cloudflare account ID in runtime requests, persistent Kitesurf session, rrweb recording, or WebM. Kitesurf screenshots are review evidence, not pixel-regression truth. Motion evidence is a bounded sequence of step-indexed PNGs. Live View is an optional, deployed capability probe and is not part of the initial job contract.

## Conflicts resolved

| Earlier proposal                                                                          | Resolution                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquire and reconcile a persistent Kitesurf Browser Session through REST/CDP.             | Rejected. Published `@cloudflare/playwright@1.3.5` supports native `launch(env.BROWSER, { browser: "kitesurf" })` and returns a sessionless browser with no provider session ID.            |
| Persist `providerBrowserSessionId`, query active/history, and add an acquisition journal. | Removed from the Kitesurf architecture. There is no Kitesurf provider handle to persist or reconcile.                                                                                       |
| Give the Worker a Browser Run API token/account ID.                                       | Rejected. Use only Alchemy's native `Cloudflare.Browser("BROWSER")` binding. Deployment credentials remain outside runtime resource props and outputs.                                      |
| Build a Scotty-owned raw `getTcpPort().fetch()` preview implementation.                   | Narrowed. Wrap the pinned SDK's `exposePort()`/`proxyToSandbox()` streaming and WebSocket implementation, while keeping Scotty's DO lease and cookie digest as the authorization authority. |
| Treat the capability in the preview hostname as the bearer secret.                        | Rejected. The hostname token is an SDK route nonce. A distinct high-entropy exact-host cookie authorizes each request.                                                                      |
| Hold a durable browser run between agent commands.                                        | Rejected. The whole declarative test is one request and one global operation lease.                                                                                                         |
| Enable Browser Run recording or call it video.                                            | Rejected. Recording is rrweb retained by Cloudflare for 30 days, has no documented early-delete contract, and is not proved for sessionless Kitesurf.                                       |
| Produce WebM from Kitesurf.                                                               | Unsupported. Use a bounded PNG timeline; a true-video backend would be a separate architecture.                                                                                             |

## Grounding in the pinned repository

The target preserves these live Scotty contracts:

- `SessionRecord` and its one `operation` are authoritative in the Sandbox DO (`worker/src/contracts.ts:65-162`). `SessionStore` writes the record and monotonic control revision together (`worker/src/session-store.ts:21-23`, `worker/src/session-store.ts:171-198`).
- The current operation vocabulary is `create | snapshot | resume | down | vaporize`; `evidence` is the only new kind (`worker/src/contracts.ts:74-99`).
- The hard-cap and vaporize callbacks are centrally registered in `worker/src/session-lifecycle.ts:3-12`.
- `Sandbox` extends `@cloudflare/sandbox` and already receives Worker bindings in its environment (`worker/src/session.ts:260-315`). Container state and Effect memory are not authority.
- Container-originated Scotty calls already cross the reserved `https://scotty.internal` egress boundary, where the source DO is derived from the Cloudflare container identity rather than ambient credentials (`worker/src/container-session-egress.ts`). The evidence tool extends this boundary rather than adding a token to the container.
- Real GitHub/Codex credentials remain behind the existing sentinel egress boundary. The container has no Browser Run or R2 authority (`worker/src/container-auth.ts:278-299`; `worker/src/egress.ts`).
- `BACKUP_BUCKET` is for immutable directory backups. Browser evidence gets a separate private R2 binding (`worker/src/bindings.ts:6-22`; `worker/src/backup-store.ts`).
- The current deployment creates the Worker, DOs, container, KV, and backup R2 bucket through pinned Alchemy (`infra/cloudflare-stack.ts`).

Exact external/package grounding:

- `@cloudflare/playwright@1.3.5`, npm git head `7d48aa7781d6ab7041340a9b3f556d668bea5291`, declares `SessionlessBrowser.sessionId(): undefined`, a Kitesurf launch overload, and a `browser?: "kitesurf"` launch option ([published source](https://github.com/cloudflare/playwright/blob/7d48aa7781d6ab7041340a9b3f556d668bea5291/packages/playwright-cloudflare/index.d.ts#L25-L31), [launch options and overload](https://github.com/cloudflare/playwright/blob/7d48aa7781d6ab7041340a9b3f556d668bea5291/packages/playwright-cloudflare/index.d.ts#L101-L129)).
- Pinned Alchemy `2.0.0-beta.67` emits `{ type: "browser", name }` for `Cloudflare.Browser` and exposes the native `BrowserRun` binding (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Browser.ts:118-185`; async lowering in `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerAsyncBindings.ts:318-323`). `browser.raw` is the escape hatch intended for Playwright/Puppeteer (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/BrowserBinding.ts:30-88`; `vendor/alchemy/website/src/content/docs/cloudflare/compute/browser-rendering.mdx`).
- Scotty pins `@cloudflare/sandbox@0.12.3`; the lock resolves `@cloudflare/containers@0.3.7` (`package-lock.json:441-466`). The SDK's exact `exposePort`/`unexposePort` contract is in `node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts:3183-3237`.
- In the installed SDK, `proxyToSandbox()` parses `<port>-<sandbox>-<token>.<hostname>`, removes spoofed SDK proxy headers, and routes to the named Sandbox DO (`node_modules/@cloudflare/sandbox/dist/index.js:13-60`). The DO validates token plus current-runtime activation and refuses stale/stopped runtimes before `getTcpPort(port).fetch()` (`node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js:8191-8242,9286-9339`). Its forwarding implementation streams response bodies and explicitly bridges WebSockets (`node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js:4513-4598`).
- `exposePort()` rejects `workers.dev`, creates durable route-token and current-runtime activation state, and `unexposePort()` removes both without waking the container (`node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js:9058-9153`).

## Session-bound portal

A portal is owned by the same Sandbox DO as its session. The authoritative DO stores a separate `scotty:portals:v1` record containing the session ID, service name, approved port, stable non-secret route token, desired state, current runtime epoch, and last readiness result. Container process state is observational, never authoritative.

The stable portal host uses the Sandbox SDK's documented custom-token form:

```text
https://<port>-<session-id>-<portal-token>.<preview-base>/
```

The portal token is a route identifier, not authorization. An authenticated Scotty browser client opens `/s/:id/portals/:portal/open`; the control origin issues a short-lived, one-time handoff, and the portal origin exchanges it for its own exact-host `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Unauthenticated knowledge of the stable URL is insufficient. The Worker validates the browser client and current portal record before forwarding, strips Scotty credentials, and delegates streaming and WebSocket transport to `proxyToSandbox()`.

Portal lifecycle follows the owning session:

- `warm`: ensure the declared service is ready and call `exposePort()` with the same custom token;
- hard-cap or managed sleep: revoke portal authorization before stopping the runtime and show an authenticated sleeping page;
- resume: restore the session, reconcile the declared service, and re-run `exposePort()` with the same token so the URL remains stable;
- vaporize: revoke, unexpose, and delete the portal record before committing `gone`.

The smallest reliable slice is warm-session-only: opening a sleeping portal directs the user to resume the session. Amp-style wake-on-request is a later extension that coalesces authenticated requests behind the existing `resume` operation and shows a bounded waking page. It must not silently change Scotty's hard-cap or billing semantics.

A repository may later declare supervised services in `.scotty/services.yaml`, analogous to Amp's `.amp/services.yaml`, with a command plus optional title. The first vertical slice only needs an agent tool that registers an already-running port; supervision and restart reconciliation can follow after the portal transport and lifecycle are deployed and proved.

## Target evidence production graph

```text
Pi in the warm Sandbox container
  -> scotty_browser_test(jobV1)
  -> POST https://scotty.internal/api/evidence/jobs
     (no Authorization/cookie; ContainerProxy derives the source Sandbox DO)
  -> Sandbox DO transaction
     - require cloudflare + warm + running + no operation
     - acquire SessionOperation(kind="evidence")
     - persist EvidenceJob + deadline + cookie digest
     - arm evidence deadline before external work
  -> Sandbox.exposePort(approvedPort, previewBaseDomain, routeNonce)
  -> @cloudflare/playwright launch(env.BROWSER, { browser: "kitesurf" })
  -> new isolated browser context
     - fixed viewport
     - exact-host __Host-scotty-preview cookie
     - no Scotty/browser/provider credentials
  -> execute the complete decoded step graph
     -> https://<port>-<session>-<routeNonce>.<previewBase>/<relative path>
        -> Worker preview dispatcher (before Hono/assets)
        -> validate host + evidence lease + cookie digest with Sandbox DO
        -> strip preview cookie/Scotty/internal headers
        -> proxyToSandbox(sanitizedRequest, { Sandbox: env.SANDBOX })
        -> pinned SDK validates exposed route/current runtime
        -> app on the exact exposed container port
     -> assertion(s)
     -> page.screenshot() returns PNG bytes in Worker memory
     -> validate/hash -> private ARTIFACT_BUCKET.put -> head
     -> commit frame manifest under the same operation nonce
  -> finalizer
     - revoke cookie digest first
     - browser.close()
     - Sandbox.unexposePort(port)
     - clear active preview state
  -> Sandbox DO terminal transaction
     - require the same operation nonce
     - commit succeeded or typed failed result
     - release SessionOperation
  -> bounded result returned to the Pi tool
```

Screenshot bytes never cross the preview bridge, enter the container filesystem, appear in `/workspace/<id>`, or enter a backup. The only retained bytes are private R2 objects written through the Worker binding.

## One-shot job contract

The initial tool submits one JSON value. There are no separate `start`, `act`, `screenshot`, `finish`, reconnect, or session-reuse calls.

```ts
type BrowserTestJobV1 = {
  readonly version: 1;
  readonly port: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly steps: readonly BrowserTestStepV1[];
  readonly timeline: { readonly capture: "after-each-step" };
};

type LocatorV1 =
  | { readonly kind: "testId"; readonly value: string }
  | { readonly kind: "css"; readonly value: string };

type ActionV1 =
  | { readonly kind: "goto"; readonly path: string }
  | { readonly kind: "click"; readonly locator: LocatorV1 }
  | { readonly kind: "fill"; readonly locator: LocatorV1; readonly value: string }
  | { readonly kind: "press"; readonly locator: LocatorV1; readonly key: AllowedKey };

type AssertionV1 =
  | { readonly kind: "visible"; readonly locator: LocatorV1 }
  | { readonly kind: "textExact"; readonly locator: LocatorV1; readonly value: string }
  | { readonly kind: "count"; readonly locator: LocatorV1; readonly value: number }
  | { readonly kind: "urlPath"; readonly value: string };

type BrowserTestStepV1 = {
  readonly name: string;
  readonly action: ActionV1;
  readonly expect: readonly [AssertionV1, ...AssertionV1[]];
};
```

Example:

```json
{
  "version": 1,
  "port": 5173,
  "viewport": { "width": 1280, "height": 720 },
  "timeline": { "capture": "after-each-step" },
  "steps": [
    {
      "name": "open form",
      "action": { "kind": "goto", "path": "/" },
      "expect": [{ "kind": "visible", "locator": { "kind": "testId", "value": "signup" } }]
    },
    {
      "name": "submit name",
      "action": {
        "kind": "fill",
        "locator": { "kind": "testId", "value": "name" },
        "value": "Scotty"
      },
      "expect": [
        {
          "kind": "textExact",
          "locator": { "kind": "testId", "value": "preview" },
          "value": "Scotty"
        }
      ]
    }
  ]
}
```

Initial hard bounds:

- request body: 64 KiB UTF-8 JSON;
- one active job per Scotty session and one `evidence` operation for its whole lifetime;
- 1-12 steps, 1-4 assertions per step, and one required PNG after every successful step;
- port 1024-65535, excluding SDK control port 3000, Pi supervisor port 43117, and one central reserved-port set;
- fixed viewport range 320x240 through 1920x1080; default 1280x720; no full-page capture;
- relative same-origin path/query only, at most 2 KiB, with no scheme, authority, credentials, fragment, backslash, or protocol-relative form;
- test ID at most 128 UTF-8 bytes; CSS at most 512; names/text/value at most 1 KiB each;
- allowed keys: `Enter`, `Escape`, `Tab`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, and `ArrowRight`;
- five seconds per action/assertion, 30 seconds per step, and five minutes per job, always reduced to the remaining session hard cap;
- PNG only, at most 5 MiB per frame and 40 MiB per job;
- no sensitive fill values in v1. The schema rejects a `sensitive` field rather than persisting or replaying secrets.

At least one assertion is mandatory per action. Functional assertions decide pass/fail; a valid screenshot cannot turn a failed assertion into success. The result contains job/step/frame IDs, statuses, bounded durations, assertion summaries, and artifact hashes—not raw cookies, URLs, page HTML/text beyond declared non-sensitive expected/actual values, or provider errors.

Not in the DSL: arbitrary URL navigation, JavaScript `evaluate`, raw CDP, arbitrary Playwright, cookies, headers, request interception, file upload/download, popups, multiple pages/tabs, geolocation, permissions, authentication persistence, Live View, handoff, recording, or video.

## Preview bridge: smallest safe SDK wrapper

### Installation requirement

Every installation must explicitly supply a preview base such as `preview.scotty.example.com` and the owning Cloudflare zone. Scotty must never infer it from a username, repository, machine, installation name, Worker name, or Cloudflare account.

Production requires all of the following before Kitesurf is enabled:

1. a proxied wildcard DNS record for `*.preview.scotty.example.com`;
2. a Worker Route `*.preview.scotty.example.com/*` targeting the Scotty Worker;
3. an edge certificate that actually covers `*.preview.scotty.example.com`; and
4. a deployed TLS/host-routing probe from outside the account.

`workers.dev` cannot satisfy the SDK wildcard-host contract. Cloudflare Universal SSL commonly covers only the zone apex and first-level wildcard, so an installation using a nested preview base must explicitly provide/prove suitable certificate coverage (for example Advanced Certificate Manager, Total TLS where applicable, or an uploaded certificate). Deployment fails closed when DNS, route, or TLS proof is absent.

Pinned Alchemy has public resources for the DNS record and Worker route (`Cloudflare.DNS.Record`; `Cloudflare.Workers.WorkerRoute` in `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Route.ts`, with guides in `vendor/alchemy/website/src/content/docs/cloudflare/networking/domains.mdx` and `custom-domains.mdx`). TLS availability remains an installation precondition and canary, not an inferred Alchemy secret or output.

### Two independent values

For every job the DO creates:

- **Route nonce:** a fresh 16-character lowercase SDK-compatible token passed to `exposePort()`. It appears in the hostname and may be stored in evidence state. It has no Scotty authorization meaning.
- **Preview cookie secret:** 32 cryptographically random bytes encoded without padding. Only its SHA-256 digest is stored in the evidence record. Plaintext exists only in the active Worker request and Kitesurf context.
- **Runtime epoch:** a non-secret Scotty generation that changes whenever the container starts or is replaced. The exposure and every preview authorization must match it.

`exposePort()` is not used as a readiness or resume primitive. The installed implementation calls `ensureDefaultSession()`, so invoking it against a stopped or racing runtime could start work outside Scotty's lifecycle. The wrapper therefore acquires the evidence lease first, requires `status === "warm"` and `ctx.container.running === true`, captures the current runtime epoch, calls `exposePort()`, then transactionally rechecks the same lease, hard cap, running state, and epoch before publishing the cookie digest. A mismatch immediately calls `unexposePort()` and fails the job; no browser is launched. Normal lifecycle transitions cannot stop the runtime while evidence owns the lease, and hard cap/vaporize revoke authority before cleanup. This pre/post fence is the smallest safe use of the SDK without duplicating its forwarding stack.

The browser context receives:

```text
Name: __Host-scotty-preview
Value: <256-bit secret>
Secure: true
HttpOnly: true
SameSite: Strict
Path: /
Domain: absent (exact generated preview host)
```

The cookie is added with Playwright's context API before the first navigation. It is not emitted by the control origin, placed in a URL/header supplied by the agent, persisted, logged, projected to KV, written to R2 metadata, or forwarded to the app.

### Request path

A preview-host dispatcher runs before Hono and assets. It:

1. matches the exact configured suffix and canonical SDK label `<port>-<12-hex-session-id>-<routeNonce>`;
2. rejects malformed hosts, unknown ports, `CONNECT`, `TRACE`, conflicting framing, invalid upgrades, and bounded header/body violations;
3. extracts exactly one `__Host-scotty-preview` cookie and asks the named Sandbox DO to authorize `{ sessionId, port, routeNonce, cookieSecret }`;
4. the DO constant-time compares the cookie digest and requires a warm Cloudflare session, `operation.kind === "evidence"`, matching operation nonce, active job, exact port/route nonce, unexpired deadline, unchanged hard cap, and active SDK exposure;
5. removes the preview cookie, `__Host-scotty`, `Authorization`, proxy authorization, Cloudflare identity/trust headers, inbound forwarding headers, and all `x-sandbox-*`/`x-scotty-*` headers;
6. calls `proxyToSandbox(sanitizedRequest, { Sandbox: env.SANDBOX })`;
7. removes hop-by-hop/internal response headers and every `Set-Cookie` that targets either reserved Scotty cookie name; and
8. adds `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Robots-Tag: noindex, nofollow, noarchive`.

The wrapper does not reimplement SDK port routing, streaming, current-runtime activation checks, or WebSocket bridging. It adds the missing Scotty authorization/lifecycle check and credential sanitation around those pinned SDK behaviors.

The SDK may put the route hostname in `X-Original-URL`; this is acceptable because the route nonce is explicitly non-secret. The app still never receives the high-entropy preview cookie or any Scotty credential. The generated host is a fresh origin per job, isolating app cookies, cache, storage, service workers, and root-relative assets.

The first production slice supports ordinary HTTP needed by the declarative graph. SDK SSE/WebSocket forwarding remains available but is enabled only after request/byte/deadline tests; a browser test does not require HMR to pass. All preview traffic is bounded by the job deadline and cannot extend the session hard cap.

A deployed Kitesurf capability test must prove same-origin request interception. If Kitesurf cannot abort off-origin navigations/subresources, production repository jobs remain disabled rather than silently granting arbitrary Browser Run egress. The declarative DSL itself never accepts an external origin.

### Revocation and cleanup order

Normal, failed, timed-out, hard-cap, and vaporize finalization all use this order:

1. atomically invalidate the cookie digest and mark exposure `unexpose_pending`;
2. abort the in-memory executor when one exists;
3. call idempotent `unexposePort(port)`;
4. commit exposure `closed` only after that call succeeds; and
5. release or transfer the global operation lease according to the owning lifecycle transition.

Revoking the digest denies new requests even if SDK cleanup is interrupted. An `unexpose_pending` record is durable retry work and blocks a new evidence job. Vaporize does not commit `gone` until unexpose and owned-artifact deletion are confirmed.

## Worker-native Kitesurf executor

`KitesurfClient` is an Effect service whose production adapter is a small Promise host island around the official library. It receives the native `BrowserRun` binding; it never receives an account ID, API token, REST endpoint, container handle, or R2 binding.

```ts
interface KitesurfClient {
  readonly run: (
    job: DecodedBrowserTestJob,
    preview: AuthorizedPreview,
  ) => Effect.Effect<ExecutedTimeline, KitesurfFailure, Scope.Scope>;
}
```

The scoped adapter:

1. calls `launch(browserRun, { browser: "kitesurf" })`;
2. verifies `browser.sessionId() === undefined` as a package/deployment contract;
3. creates one isolated context and page;
4. installs the exact-host preview cookie and same-origin network guard;
5. executes the already-decoded graph in sequence with per-step timeouts;
6. evaluates every declared postcondition;
7. captures one PNG after each successful step and an optional best-effort failure PNG if budget remains;
8. closes context/browser in the scope finalizer; and
9. returns no browser object or provider identifier.

There is no automatic replay after an ambiguous mutating action. Because the graph runs in one request, transport ambiguity fails the job at that step. Scotty does not reconnect and continue against unknown page state.

A `429`/`Retry-After` before browser launch may produce one delayed admission retry only if it fits within the job and hard-cap deadline. No step is replayed and no retry is scheduled after launch.

## Authoritative state and invariants

Add schema-decoded `scotty:evidence:v1` storage, but read/write it in the same DO transaction and control-revision increment as `scotty:session`. It is not a second authority.

```ts
type EvidenceStateV1 = {
  readonly version: 1;
  readonly nextJobSequence: number;
  readonly activeJob?: EvidenceJobRecordV1;
  readonly artifacts: readonly EvidenceArtifactV1[];
  readonly pendingDeletes: readonly PendingArtifactDeleteV1[];
  readonly retainedBytes: number;
};

type EvidenceJobRecordV1 = {
  readonly id: string;
  readonly sequence: number;
  readonly operationNonce: string;
  readonly phase:
    | "accepted"
    | "exposing"
    | "running"
    | "finalizing"
    | "unexpose_pending"
    | "succeeded"
    | "failed"
    | "interrupted";
  readonly port: number;
  readonly routeNonce: string;
  readonly runtimeEpoch: string;
  readonly exposure: "not_exposed" | "active" | "unexpose_pending" | "closed";
  readonly previewCookieDigest: string | null;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly steps: readonly EvidenceStepResultV1[];
  readonly failure?: EvidenceFailureRecordV1;
};
```

The exact schema should keep terminal job summaries bounded; immutable frame manifests remain in the artifact collection and old terminal step detail can be compacted after retention.

Invariants:

1. At most one nonterminal evidence job exists per Scotty session.
2. A nonterminal job always matches the sole `SessionOperation { kind: "evidence", nonce }`; the lease is held for the whole request.
3. `deadlineAt <= hardCapAt`; retries, preview activity, and optional Live View never extend either deadline.
4. Preview forwarding requires the current operation, active job, exact port/route nonce/runtime epoch, non-null cookie digest, and active SDK exposure.
5. The route nonce is not authorization. Knowing the full preview URL without the exact-host cookie yields a generic 404.
6. `succeeded` requires every assertion, every required frame's verified R2 manifest, browser close return, successful `unexposePort`, and a same-nonce terminal commit.
7. A Worker/request interruption never becomes success. Deadline maintenance changes the job to `interrupted`, revokes preview authority, unexposes, and releases/fails the evidence lease.
8. No Kitesurf provider session ID, CDP URL, API token, account ID, Live View URL, or browser cookie plaintext is persisted.
9. `available` artifacts require a matching R2 `head` observation for key, owner, media type, length, and SHA-256.
10. Snapshot, sleep, down, and resume conflict while `evidence` is active. Hard cap and vaporize may preempt it.
11. KV remains the current non-secret session projection; evidence detail is not added by default.
12. Container files/process memory never become evidence authority or artifact storage.

### State transitions

```text
none
  -> accepted -> exposing -> running -> finalizing -> succeeded
       |           |          |            |
       +-----------+----------+------------+-> failed
                              |
                              +-- request loss/deadline --> interrupted

finalizing|interrupted
  -> unexpose_pending -> failed
```

Each R2 effect uses begin/effect/commit:

1. persist `putting` with deterministic owner/frame identity and expected metadata;
2. upload the already-validated bytes outside the transaction;
3. `head` the object and commit `available` under the same nonce; or
4. retain `put_unknown` for `head` reconciliation.

Browser launch/actions do not use provider reconciliation because sessionless Kitesurf supplies no durable handle. Request interruption is a typed failed/interrupted job, not an unknown provider-session state.

## Artifact and timeline contract

Each completed step produces one immutable PNG object:

```text
evidence/v1/<session-id>/<job-id>/<step-index>-<sha256>.png
```

The Worker validates the PNG signature, byte cap, fixed job viewport expectation, and SHA-256 before `ARTIFACT_BUCKET.put()`, then verifies R2 metadata with `head`. Object metadata contains only session/job/frame IDs, media type, byte length, and hash.

Initial retention is seven days, bounded by installation policy. Expiry becomes `delete_pending` until absence is confirmed. Snapshot/sleep preserve remaining retention; resume does not extend it; vaporize deletes immediately. The artifact bucket is private, has no public domain, and is separate from `BACKUP_BUCKET`.

Authenticated review routes stream manifests/PNG bytes only to a registered Scotty browser client:

```text
GET /s/:id/evidence/:jobId
GET /s/:id/evidence/:jobId/frames/:step.png
```

They are registered before the existing `/s/:id/*` fallback, reject root-token query/cookie/bearer handoff, validate artifact ownership with the Sandbox DO, and return `Cache-Control: private, no-store`. No public R2 URL or presigned bearer URL is created. Existing API envelopes, CLI JSON, and exit codes remain unchanged.

The timeline is not called video. It is an ordered manifest of at most 12 PNGs with step names, action kinds, assertion summaries, hashes, and monotonic offsets. A UI may play it as a stepper/slideshow, but no WebM is fabricated.

## Lifecycle behavior

| Event                              | Required behavior                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal completion                  | Revoke cookie, close browser, unexpose port, verify frames, commit terminal result, release evidence operation.                                                                                                                                           |
| Step/assertion failure             | Capture a best-effort bounded failure frame, then perform the same finalization and commit typed failure.                                                                                                                                                 |
| Request/DO interruption            | Deadline callback treats the uncommitted job as `interrupted`; never resumes the graph. Revoke/unexpose and reconcile only R2 state.                                                                                                                      |
| Snapshot/sleep/down/resume request | Return the existing conflict/wrong-state envelope while evidence owns the operation. Caller waits for bounded completion or hard cap.                                                                                                                     |
| Hard cap                           | Atomically preempt evidence, revoke cookie, abort live executor, unexpose, and continue the existing checkpoint/destroy path without evidence grace. Preserve `unexpose_pending`/artifact maintenance if local cleanup is interrupted.                    |
| Runtime stop/replacement           | SDK current-runtime activation becomes stale; Scotty also invalidates the evidence digest. Old preview requests never wake the new runtime.                                                                                                               |
| Vaporize                           | Acquire/reuse durable vaporize authority, revoke/unexpose, delete/reconcile every evidence object, then continue current compute/backup/credential/projection cleanup. `gone` requires no exposure, cookie digest, artifact, pending delete, or schedule. |
| Artifact expiry                    | Mark delete intent, delete exact keys, verify absence, decrement retained bytes. It does not affect an unrelated warm session operation.                                                                                                                  |

Evidence adds one deadline/maintenance callback to `SESSION_SCHEDULE_CALLBACKS`. Vaporize owns retries after it preempts evidence. An in-memory `AbortController` accelerates cancellation but is never authoritative; durable nonce/deadline checks repair eviction.

## Typed failure surface

Internally use tagged Effect failures and persist only bounded failure records. At existing HTTP boundaries map them to today's `bad_request`, `wrong_state`, `conflict`, `upstream`, or `internal` envelopes.

| Failure                                  | Meaning / retry                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `EvidenceJobInvalid`                     | DSL or bound violation; never retry unchanged input.                                                                                       |
| `EvidenceLeaseConflict`                  | Session not warm/running or another operation exists; caller refreshes/waits.                                                              |
| `PreviewDomainUnavailable`               | Installation wildcard DNS/route/TLS proof absent; deployment/configuration failure.                                                        |
| `PreviewAuthorizationFailed`             | Host/cookie/lease/port/deadline mismatch; generic 404 externally, no retry.                                                                |
| `PreviewExposureFailed`                  | SDK expose failed before running; one policy-bounded retry only before deadline.                                                           |
| `KitesurfCapabilityUnsupported`          | Required launch/action/assertion/screenshot/interception contract failed the deployed package probe; disable Kitesurf for that deployment. |
| `ProviderAdmissionLimited`               | 429; honor `Retry-After` once only before launch and deadlines.                                                                            |
| `EvidenceActionAmbiguous`                | Transport failed after dispatch; fail the one-shot job and never replay the step.                                                          |
| `EvidenceAssertionFailed`                | Explicit postcondition failed; functional failure.                                                                                         |
| `ScreenshotInvalid` / `ArtifactTooLarge` | Invalid or over-budget bytes; fail that required frame/job.                                                                                |
| `ArtifactPutUnknown`                     | Reconcile the exact deterministic key with R2 `head`; never claim availability early.                                                      |
| `PreviewUnexposePending`                 | Digest is already revoked; retry SDK state cleanup and block a new job/vaporize completion.                                                |
| `EvidenceDeadlineExceeded`               | Abort, revoke, unexpose, and fail; no graph resume.                                                                                        |

Logs contain job/session/frame IDs, step index/kind, bounded reason code, durations, status, and byte counts. They exclude generated preview hosts, all cookies, paths/query strings, fill values, selectors marked by policy, page text, CDP/provider payloads, and artifact contents.

## Live View, rrweb, and true video

### Optional Live View

Live View is **off in v1**. A later phase may enable observe-only `mode: "tab"` only if a deployed test proves `Cloudflare.getLiveView` works with this exact sessionless Kitesurf launch. It exists only while the one-shot request and page are live, is issued on demand to an authenticated owner, expires within the remaining job deadline, and is never persisted or logged. It cannot pause the graph, become HITL, or convert Kitesurf into a durable session. Failure of the probe leaves Live View unavailable without affecting PNG evidence.

### rrweb recording

Browser Run recording remains disabled because:

- it is rrweb event data, not video;
- Cloudflare documents 30-day provider retention and no early-delete API;
- sessionless Kitesurf support is not established; and
- provider-retained recording would violate immediate Scotty vaporization.

### WebM

Actual WebM is unsupported by Kitesurf and not fully supported by Cloudflare's Playwright integration. If pixel-time video becomes a product requirement, choose and threat-model another backend. Do not add Chromium/FFmpeg to the Scotty Sandbox under this architecture.

## Production and test dependency graphs

Production dependency direction:

```text
BrowserTestWorkflow (Effect domain)
  -> EvidenceStore + Clock
  -> KitesurfClient
  -> PreviewExposure
  -> ArtifactStore

Worker/DO host adapters
  -> native BrowserRun BROWSER binding
  -> Sandbox SDK exposePort/unexposePort/proxyToSandbox
  -> native private R2 ARTIFACT_BUCKET binding
  -> native Request/Response/WebSocket boundaries
```

Test substitutions:

```text
Decoded fixed job
  -> BrowserTestWorkflow
     -> FakeKitesurfClient (scripted actions/assertions/PNG/failures)
     -> FakePreviewExposure (records expose/revoke/unexpose)
     -> FakeArtifactStore (put/head/delete ambiguity)
     -> TestClock
  -> real EvidenceStore transition assertions

Deployed canary
  -> real Alchemy Worker + Sandbox DO + Container + private R2
  -> real wildcard DNS/Worker Route/TLS
  -> real native BROWSER binding
  -> real @cloudflare/playwright@1.3.5 Kitesurf launch
```

Required proof graph:

| Node                        | Test files / proof                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSL and result schemas      | New `worker/test/evidence-contracts.test.ts`: excess properties, every bound, relative paths, reserved ports, non-sensitive values, graph size.                                                                                                                         |
| State/lease machine         | New `worker/test/evidence-store.test.ts` plus existing `worker/test/session-store.test.ts`: same-transaction session/evidence/revision writes, nonce races, one active job.                                                                                             |
| Workflow                    | New `worker/test/evidence-workflow.test.ts` with `@effect/vitest` and `TestClock`: success, assertion red, action ambiguity, deadline, 429 timing, finalizer ordering.                                                                                                  |
| Native adapter contract     | New `worker/test/kitesurf-client.test.ts`: fake BrowserRun/Playwright boundary, sessionId undefined assertion, close finalizer, PNG bytes, unsupported feature mapping.                                                                                                 |
| Preview wrapper             | New `worker/test/evidence-preview.test.ts`: canonical host parser, missing/wrong/duplicate/expired cookie, route nonce without cookie, cross-session/port replay, header/cookie stripping, reserved `Set-Cookie`, stopped runtime, HTTP/SSE/WS cancellation and limits. |
| Artifact adapter            | New `worker/test/artifact-store.test.ts`: PNG/hash/size, immutable key, put/head ambiguity, corrupt collision, delete/absence.                                                                                                                                          |
| Container tool ingress      | Extend `worker/test/container-session-egress.test.ts`: source derived from container identity, exact route/method/content type, no ambient auth, bounded response.                                                                                                      |
| HTTP review contract        | Extend `worker/test/routes.test.ts` and `e2e/tests/deployed-routes.test.mjs`: registered cookie only, root query rejected, private/no-store PNG, existing `/s/:id/*` behavior unchanged.                                                                                |
| Hard cap/resume/vaporize    | New `worker/test/session-evidence-lifecycle.test.ts` plus existing lifecycle suites: preemption, unexpose pending, R2 delete retry, no false `gone`, no resume with cleanup pending.                                                                                    |
| Infrastructure shape        | Extend `spikes/infra/cloudflare-stack.test.ts`: exact Browser/R2/DNS/WorkerRoute bindings and no Browser Run secret/account prop/output.                                                                                                                                |
| Package/container isolation | Extend `cli/test/cli.test.ts`, `scripts/check-pi-packages.test.mjs`, and image scans: bounded tool present, no `agent-browser`, Chromium executable/process, Browser Run token, or R2 credential.                                                                       |
| Real capability             | New guarded deployed canary: launch exact Kitesurf overload, prove `sessionId() === undefined`, same-origin interception, every allowed action/assertion, PNG timeline, cookie denial, unexpose, hard cap, and vaporize.                                                |
| Existing regression graph   | Run current route, protocol, CLI, projection, backup, egress, and no-orphans tests unchanged.                                                                                                                                                                           |

Local fakes cannot prove Browser Run, wildcard TLS, SDK preview routing, backpressure, or runtime activation. Production enablement requires the guarded deployed canary and the existing no-orphans probe extended with evidence exposure/artifacts/schedules.

## Exact implementation change set

The implementation should be delivered in the phases below. No parallel Wrangler/manual Cloudflare model is introduced.

### Existing files to modify

- `worker/package.json`, `package-lock.json` — pin `@cloudflare/playwright` exactly to `1.3.5` and lock its optional peer resolution deliberately.
- `infra/installation.ts` — add explicit installation-supplied preview base/zone and artifact bucket names; never derive domain/account identity.
- `infra/cloudflare-stack.ts` — add `Cloudflare.Browser("BROWSER")`, private artifact R2, preview vars, proxied wildcard DNS, and `Cloudflare.Workers.WorkerRoute`; keep credentials out of props/outputs/state.
- `worker/src/bindings.ts` — add typed `BROWSER: BrowserRun`, `ARTIFACT_BUCKET: R2Bucket`, and `PREVIEW_BASE_DOMAIN`.
- `worker/src/contracts.ts` — add `evidence` to `OperationKindSchema`; keep evidence schemas in their owning module.
- `worker/src/session-store.ts` — extend the existing transaction boundary so session record, evidence state, and control revision commit atomically.
- `worker/src/session-lifecycle.ts` — register the evidence deadline/maintenance callback and vaporize conflicts.
- `worker/src/session.ts` — wire evidence services/RPC, SDK expose/unexpose, hard-cap abort, stop/resume guards, and vaporize cleanup into the authoritative Sandbox DO.
- `worker/src/index.ts` — dispatch preview hosts before Hono/assets and add authenticated evidence manifest/frame reads before `/s/:id/*`.
- `worker/src/container-session-egress.ts` — add the exact bounded `POST https://scotty.internal/api/evidence/jobs` route and source-DO dispatch.
- `worker/src/container-auth.ts`, `worker/container/pi-packages/settings.json`, `worker/container/pi-packages/manifest.json`, `worker/container/Dockerfile` — install the bounded Scotty browser-test Pi extension only; do not install a browser.
- `.oxlintrc.json` — add newly migrated Effect domain modules to Scotty's strict override in the same implementation change.
- Existing tests named in the proof graph — extend contract/lifecycle/isolation coverage.
- `e2e/scripts/scan.mjs` — include preview cookie, Live View, Browser Run credential, and artifact metadata leak probes without recording secret values in fixtures.

Installation CLI plumbing will also need the existing topology/deployment surfaces that serialize and inspect installation resources: `cli/src/commands.ts`, `cli/src/services.ts`, and `cli/src/installation-deployment.ts`, with `cli/test/cli.test.ts` preserving current JSON shapes and exit codes unless a separately versioned output field is approved.

### New files

- `worker/src/evidence-contracts.ts` — Schema-owned DSL, result, state, artifact, and failure types.
- `worker/src/evidence-store.ts` — atomic evidence/session authority operations.
- `worker/src/evidence-workflow.ts` — one-shot Effect orchestration and finalization.
- `worker/src/kitesurf-client.ts` — scoped native-binding Playwright adapter.
- `worker/src/evidence-preview.ts` — host parser, cookie authorization, sanitation, and `proxyToSandbox` wrapper.
- `worker/src/artifact-store.ts` — private R2 put/head/open/delete service.
- `worker/container/pi-packages/sources/scotty-browser-test/` — Pi extension exposing only `scotty_browser_test` and the v1 schema.
- Test files listed in the proof graph.
- A guarded deployed Kitesurf evidence canary under `e2e/` following the existing disposable deployment/no-orphans conventions.

Generated `.alchemy/**` container context is not edited by hand; it continues to be produced from source by the existing preparation flow.

## Delivery phases

1. **Pinned capability and installation gate**
   - Pin `@cloudflare/playwright@1.3.5`.
   - Add only the native `BROWSER` binding and disposable public-page canary.
   - Prove Kitesurf selection and `sessionId() === undefined` without any account/API token.
   - Validate installation-supplied wildcard DNS, Worker Route, and TLS before preview work.

2. **Domain/state/artifact vertical slice**
   - Land DSL schemas, one-operation state machine, atomic evidence/session storage, private artifact R2, fake adapters, retention, and review authorization.
   - Prove interruption and R2 ambiguity without Browser Run or a preview port.

3. **Authorized SDK preview bridge**
   - Add expose/unexpose and the pre-Hono cookie-authenticated `proxyToSandbox` wrapper.
   - Prove URL knowledge alone is insufficient, cookie/Scotty headers never reach the app, stopped runtimes do not wake, and finalization removes SDK state.

4. **Real one-shot Kitesurf workflow**
   - Execute the fixed bounded graph against a deterministic app on `0.0.0.0:<approved-port>`.
   - Produce the direct-to-R2 PNG timeline and fail red on a wrong assertion.
   - Prove same-origin interception and all supported DSL operations on the exact deployed package.

5. **Agent and lifecycle integration**
   - Add the bounded Pi extension and internal egress route.
   - Integrate hard-cap preemption, snapshot/down/resume conflicts, vaporize deletion/retry, artifact review, secret scans, and deployed no-orphans proof.
   - Do not enable runner-backed sessions.

6. **Optional observe-only Live View**
   - Run a Kitesurf-specific capability probe.
   - If and only if it passes, add ephemeral owner-authorized tab Live View during an active one-shot job. Keep HITL, rrweb, and persistence out.

## Non-goals and remaining gates

- No persistent browser state, provider session reuse, reconnect, action-by-action RPC, acquisition broker, browser pool, or multiple tabs.
- No agent-selected external URL, raw browser protocol, arbitrary JavaScript, or arbitrary request headers.
- No browser, Xvfb, FFmpeg, `agent-browser`, or browser credential in the Sandbox container.
- No Quick Actions dependency; their native Kitesurf selector remains irrelevant to this Playwright job.
- No pixel baseline shared with Chromium. Kitesurf is not pixel-perfect.
- No runner-backed preview/evidence until runner session creation and native Pi transport are separately enabled and proved.
- Enable production repository jobs only after the exact Kitesurf package proves every allowed action, screenshot, same-origin guard, wildcard ingress, and finalizer behavior in a deployed canary.

## Official sources

- [Cloudflare Browser Run: Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)
- [Cloudflare Browser Run: Playwright](https://developers.cloudflare.com/browser-run/playwright/)
- [Cloudflare Browser Run: limits](https://developers.cloudflare.com/browser-run/limits/)
- [Cloudflare Browser Run: Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
- [Cloudflare Browser Run: session recording](https://developers.cloudflare.com/browser-run/features/session-recording/)
- [Cloudflare Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/)
- [Cloudflare Sandbox preview URLs](https://developers.cloudflare.com/sandbox/concepts/preview-urls/)
- [Cloudflare Sandbox ports API](https://developers.cloudflare.com/sandbox/api/ports/)
- [Cloudflare Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Cloudflare Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)
- [Cloudflare Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
- [Cloudflare Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [`@cloudflare/playwright@1.3.5` Kitesurf types](https://github.com/cloudflare/playwright/blob/7d48aa7781d6ab7041340a9b3f556d668bea5291/packages/playwright-cloudflare/index.d.ts#L25-L31)
- [`@cloudflare/playwright@1.3.5` launch overload](https://github.com/cloudflare/playwright/blob/7d48aa7781d6ab7041340a9b3f556d668bea5291/packages/playwright-cloudflare/index.d.ts#L101-L129)
