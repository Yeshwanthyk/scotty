---
shaping: true
---

# Hatch and Summary target architecture

## Outcome

A configured Scotty Session can expose one authenticated, interactive application service through a Hatch. The session UI has a separate Summary surface that shows the latest agent update, real evidence screenshots, assertion status, Replay, and the current Hatch state.

## Canonical language

- **Service**: the repository application process listening on an approved port.
- **Hatch**: authenticated interactive access to that Service while its Session runtime is available.
- **Evidence**: retained screenshots and browser-test results.

A Hatch is not the Session runtime, a deployment, or retained evidence. Do not use Portal, preview, or live view for this product concept.

## Requirements

| ID  | Requirement                                                                         | Status    |
| --- | ----------------------------------------------------------------------------------- | --------- |
| R0  | A configured Session can provide an authenticated interactive Hatch                 | Core goal |
| R1  | Summary shows the latest agent update without opening tool activity                 | Must-have |
| R2  | Summary displays actual authenticated evidence screenshots                          | Must-have |
| R3  | Summary reconstruction survives refresh from the Pi transcript and durable evidence | Must-have |
| R4  | Hatch supports normal HTTP interaction and same-origin Vite HMR                     | Must-have |
| R5  | Session, browser, credential, and artifact isolation remain intact                  | Must-have |
| R6  | Hatch cleanup orders correctly with snapshot, sleep, resume, hard cap, and vaporize | Must-have |
| R7  | Evidence remains available when Hatch is offline                                    | Must-have |
| R8  | Summary is a desktop side surface and a coordinated compact drawer                  | Must-have |
| R9  | V1 has at most one primary Hatch per Session                                        | Must-have |

## Selected shape

Use a transcript-projected Summary and a distinct Sandbox-Durable-Object-owned Hatch record.

- Summary is derived. Pi messages and structured tool results remain its persisted source.
- Evidence state and R2 remain authoritative for screenshots.
- The Sandbox Durable Object owns Hatch desired state, runtime fencing, exposure, browser permits, cleanup, and retries.
- The Pi extension owns the local child process only as a scoped host adapter. Process memory and files are never authoritative.
- Hatch state is separate from `SessionRecord` and `EvidenceState`; do not migrate `SessionRecord` merely to add the application view.
- A Hatch holds the global session operation lease only during bounded mutations such as ensure, expose, close, or restore. An open Hatch does not hold the lease.

## Summary projection

The browser rebuilds Summary from the current session projection:

1. Select the latest conversation containing assistant text.
2. Render the latest update through the existing safe Markdown renderer.
3. Parse only exact `scotty-evidence:<jobId>` and `scotty-hatch:<hatchId>` references.
4. Cross-check evidence references against structured `scotty_browser_test` results from the same conversation.
5. Fetch evidence summaries and frame bytes through existing browser-cookie-authenticated routes.
6. Fetch public Hatch status through a browser-cookie-authenticated session route.
7. Construct all same-origin routes locally. Never trust a URL, R2 key, cookie, route nonce, or frame path in assistant text.

A syntactically valid reference without same-conversation provenance renders as unavailable.

## Hatch state

Use a dedicated strict store key such as `scotty:hatch:v1`.

```ts
interface HatchStateV1 {
  readonly version: 1;
  readonly primary?: HatchRecordV1;
}

interface HatchRecordV1 {
  readonly hatchId: string;
  readonly generation: number;
  readonly service: {
    readonly name: string;
    readonly argv: readonly [string, ...string[]];
    readonly workingDirectory: string;
    readonly port: number;
    readonly healthPath: string;
  };
  readonly desiredStatus: "open" | "closed";
  readonly observedStatus: "starting" | "running" | "sleeping" | "unhealthy" | "stopped" | "failed";
  readonly runtimeEpoch?: string;
  readonly exposure: "not_exposed" | "active" | "unexpose_pending" | "closed";
  readonly routeNonce: string;
  readonly permits: readonly HatchBrowserPermitV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHealthyAt?: string;
}
```

Persist only a secret digest for each exact-host Hatch cookie. Raw cookies and handoff values never enter Durable Object storage, KV, R2, logs, Alchemy state, or API output.

## Hatch transitions

| Transition     | Preconditions                                                        | Authoritative effect                                      | External effect                                 | Terminal result                                             |
| -------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Ensure         | warm Cloudflare Session, current runtime epoch, no conflicting lease | reserve generation and launch intent                      | local service start, health check, `exposePort` | running and active, or typed failed state with compensation |
| Open           | registered browser with `sessions:read`, current active Hatch        | create one-use handoff and permit digest                  | exact-host cookie handoff                       | Hatch application route                                     |
| Close          | matching Hatch, no conflicting lifecycle owner                       | desired closed, revoke permits                            | close sockets, unexpose, stop service           | stopped/closed or durable cleanup pending                   |
| Snapshot/sleep | current lifecycle lease                                              | revoke Hatch before runtime quiescence                    | close sockets and unexpose                      | sleeping after committed managed stop                       |
| Resume         | current backup and new runtime epoch                                 | generation increment, starting                            | restart service, health check, re-expose        | running or unhealthy/failed                                 |
| Hard cap       | exact hard-cap authority                                             | revoke permits and retain cleanup retry state             | close/unexpose/destroy                          | sleeping or failed according to existing hard-cap rules     |
| Vaporize       | vaporize lease                                                       | deleting then remove Hatch state only after owned cleanup | close/unexpose/destroy                          | gone                                                        |

Every asynchronous completion compares session ID, Hatch ID, generation, operation nonce, and runtime epoch. Stale completions cannot publish authority.

## Browser handoff

The control cookie cannot be reused on the custom Hatch host. Use a one-use, short-lived handoff owned by the Auth Durable Object and bound to the authenticated browser, Session, and Hatch.

1. `Open Hatch` calls a control-origin route with the registered browser cookie.
2. The Worker verifies `sessions:read` and current Hatch ownership.
3. Auth stores only a handoff digest with a short deadline.
4. The control route returns an auto-submitting top-level HTML form that POSTs the one-use value to the exact Hatch host. The value never enters the URL.
5. The Hatch host consumes the handoff once, installs an exact-host `Secure`, `HttpOnly`, `SameSite=Strict` cookie, and redirects to `/`.
6. The gateway validates the cookie digest, current runtime epoch, active exposure, and request budget before every forward.

The root token and registered-browser cookie never reach the Hatch host or application.

## Gateway

Reuse the existing installation-owned wildcard DNS, Worker Route, Sandbox SDK `exposePort`/`unexposePort`, and `proxyToSandbox` seam. Keep Hatch and evidence policies separate.

Shared transport code may cover canonical host parsing, header sanitation, streaming, private claimed markers, and bounded accounting. Evidence remains HTTP-only. Hatch may enable a valid same-origin WebSocket upgrade only after separate admission.

For Hatch WebSockets:

- authorize before upgrade;
- cap concurrent sockets, message bytes, aggregate bytes, idle duration, and absolute duration;
- preserve only the selected application subprotocol;
- close all tracked sockets on revoke, sleep, hard cap, runtime epoch change, or vaporize;
- use bounded policy close codes;
- never let traffic extend authority.

## Service process adapter

The first-party `scotty_hatch` Pi package has one session-local manager. It starts process groups, waits for loopback readiness, captures bounded sanitized log tails, and performs TERM-then-KILL cleanup. It calls a source-derived internal Scotty route to register or close the authoritative Hatch exposure.

`ensure` is idempotent for the exact normalized service fingerprint. A different command, directory, port, or health policy conflicts rather than silently replacing the Service. The package never infers a command or service name from repository, account, username, or machine identity.

## Summary places

- **Session work log**: current messages and composer.
- **Summary side surface**: latest update, Hatch status/actions, evidence screenshots, assertion totals, Replay.
- **Hatch application**: separate exact-host application origin.
- **Activity drawer**: existing tasks, subagents, and workflows; remains independent.

Desktop Summary is a collapsible right column. Compact Summary is coordinated through one modal-surface owner so workspace, Activity, and Summary cannot compete over focus, inertness, backdrop, or Escape handling.

## Delivery slices

1. Summary sidebar with current evidence and safe custom references.
2. Authoritative warm-session HTTP Hatch with one primary service and browser handoff.
3. First-party `scotty_hatch` process tool and image/CLI registry wiring.
4. Same-origin bounded WebSocket/HMR plus sleep/resume restoration.
5. Summary/Hatch integration and agent checkpoint instructions.
6. Full integration and deployed-canary preparation. Deployment requires explicit approval.

## Required proof

- Summary appears without opening Worked or Activity.
- Actual frame bytes load only through browser-cookie-authenticated routes.
- Refresh and session switching preserve Summary and focus.
- Cross-session and cross-conversation references fail closed.
- Hatch URL knowledge alone grants no access.
- HTTP, streaming, redirects, cookies, and HMR work through the exact host.
- Snapshot, sleep, resume, hard cap, rollout, and vaporize revoke old runtime access.
- Evidence remains readable while Hatch is stopped.
- Container files, environment, process args, logs, Worker responses, KV, R2, and Alchemy state contain no real credentials.
