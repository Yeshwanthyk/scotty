# Worker-native Kitesurf / Browser Run runtime

**Recommendation:** put Browser Run behind a native `browser` binding on Scotty's Worker. Run browser automation in Worker code with Cloudflare's Playwright fork; keep browser binaries, Cloudflare account IDs, and Cloudflare API tokens out of the Sandbox container. Use **Kitesurf only for bounded, stateless CDP tasks**. Use Browser Run's default Chromium only when a workflow explicitly needs reusable sessions, Live View, human handoff, or recording.

This is a new runtime shape: **no `agent-browser`, no Chromium in the Scotty container, and no direct Browser Run REST/CDP credential in the container.**

## 1. API conclusions

### Kitesurf selection

| Surface           | Exact selection mechanism                                                                                                                                                                    | Native Worker binding verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST Quick Action | Add `?browser=kitesurf`, for example `POST /accounts/{account}/browser-run/screenshot?browser=kitesurf` ([Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)).               | **Not exposed by the supported `quickAction()` API.** Cloudflare documents the selector on the HTTP endpoint, but `BrowserRun.quickAction(action, options)` has no engine argument and its option types have no `browser` field (`node_modules/@cloudflare/workers-types/index.ts:11834-12314`). Pinned Alchemy forwards exactly those options (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/BrowserBinding.ts:30-46`). Whether an undocumented `BrowserRun.fetch()` Quick Action URL can safely select Kitesurf is unknown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CDP endpoint      | Add `?browser=kitesurf` to `/browser-run/devtools/browser` ([Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/), [CDP](https://developers.cloudflare.com/browser-run/cdp/)). | **Yes for browser automation.** Published `@cloudflare/playwright@1.3.5` accepts `launch(env.BROWSER, { browser: "kitesurf" })` and returns a `SessionlessBrowser`; published `@cloudflare/puppeteer@1.3.0` accepts the same engine option. Both use the native binding's authenticated `fetch()` transport, not an account token ([Playwright source](https://github.com/cloudflare/playwright/blob/7d48aa7781d6ab7041340a9b3f556d668bea5291/packages/playwright-cloudflare/index.d.ts#L25-L31), [Playwright launch type](https://github.com/cloudflare/playwright/blob/7d48aa7781d6ab7041340a9b3f556d668bea5291/packages/playwright-cloudflare/index.d.ts#L101-L129), [Puppeteer option](https://github.com/cloudflare/puppeteer/blob/64b32550d3fc506c87ec46d13f71ab1603863a0a/packages/puppeteer-core/src/cloudflare/PuppeteerWorkers.ts#L77-L114), [binding transport](https://github.com/cloudflare/puppeteer/blob/64b32550d3fc506c87ec46d13f71ab1603863a0a/packages/puppeteer-core/src/cloudflare/WorkersWebSocketTransport.ts#L18-L39)). |

**Design consequence:** do not call the public Quick Actions REST API from Scotty merely to obtain Kitesurf. For a Kitesurf one-shot screenshot/content task, launch a bounded Kitesurf CDP connection through the native binding and perform the action with Playwright. Revisit native Quick Actions only when Cloudflare documents and types an engine selector.

### Exact Worker surfaces

Declare the binding as:

```ts
env: {
  BROWSER: Cloudflare.Browser("BROWSER"),
}
// runtime type: BrowserRun
```

The native runtime API is:

```ts
interface BrowserRun {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  quickAction(action, options): Promise<Response>;
}
```

The pinned Worker types expose `quickAction` overloads for `screenshot`, `pdf`, `content`, `scrape`, `links`, `snapshot`, `json`, and `markdown`. Cloudflare's current docs additionally list `accessibilityTree` and REST-only `crawl`; those are not represented by pinned Alchemy's `BrowserClient` (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Browser.ts:58-116`). `quickAction()` requires compatibility date `2026-03-24` or later and remote development; ordinary Playwright/Puppeteer/CDP binding work can use the standard browser binding ([Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/), [Wrangler](https://developers.cloudflare.com/browser-run/reference/wrangler/)).

Pinned Alchemy already has the necessary native seam:

- `Cloudflare.Browser("BROWSER")` emits only `{ type: "browser", name }` and has no backing resource (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Browser.ts:120-181`; async lowering at `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerAsyncBindings.ts:318-323`).
- `BrowserBinding` wraps native Quick Actions; `browser.raw` yields the underlying `cf.BrowserRun` for Playwright/Puppeteer (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/BrowserBinding.ts:30-84`; guide at `vendor/alchemy/website/src/content/docs/cloudflare/compute/browser-rendering.mdx:8-49,108-134`).
- `BrowserLocal` is a deploy-time/current-credential REST adapter, not the target production runtime (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/BrowserLocal.ts:14-22,43-63`). Its `raw`, `fetch`, screenshot, and PDF paths are intentionally unavailable (`vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/BrowserHttpClient.ts:43-52,145-190`).

## 2. Feature and lifecycle facts

| Capability             | Browser Run contract                                                                                                                                                                                                                                                                                                                                                             | Scotty disposition                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kitesurf               | Stateless Workers/V8-isolate browser; materially lower CPU/memory, but slower wall time and non-pixel-perfect rendering. No video, WebGL, real-TLS bot challenge, or long authenticated persistent session ([Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/), [announcement](https://blog.cloudflare.com/kitesurf/)). Free while beta, behind account limits. | Default only for short synthetic/public-preview tasks with DOM assertions. Never use its pixels as a Chromium-equivalent visual baseline.                  |
| Playwright / Puppeteer | Worker-native Cloudflare forks launch from the binding; external clients can connect over CDP. Playwright Test, components, non-Chromium engines, alternate Chrome versions, and video remain incomplete ([Playwright](https://developers.cloudflare.com/browser-run/playwright/), [Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/)).                       | Prefer `@cloudflare/playwright` for locators/assertions. Pin and canary the exact package version.                                                         |
| Session reuse          | Default idle close is 60 seconds; `keep_alive` is documented to 10 minutes. Active sessions have no fixed lifetime but may close on Browser Run releases ([reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/), [limits](https://developers.cloudflare.com/browser-run/limits/)).                                                                     | Do not reuse Kitesurf. Reuse Chromium only behind a DO-owned lease and explicit reconnect/close recovery.                                                  |
| Live View              | Browser Sessions can produce expiring `live.browser.run` URLs in `tab`, `full`, or `devtools` mode. `Cloudflare.getLiveView` defaults to five minutes and caps at one hour ([Live View](https://developers.cloudflare.com/browser-run/features/live-view/)).                                                                                                                     | Chromium-only until Kitesurf support is proved. URLs are transient bearer capabilities: never persist or log them.                                         |
| HITL                   | `Cloudflare.handoff`, `Cloudflare.handoffComplete`, `Cloudflare.getHandoffState`, and `Cloudflare.getLiveView`; structured handoff requires `mode: "tab"`; supplied timeout caps at 30 minutes ([HITL](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)).                                                                                              | Optional Chromium mode. Auth DO authorizes the operator before issuing a fresh Live View URL. No account token is exposed.                                 |
| Recording              | Opt-in (`recording: true` / `recording=true`), Browser Sessions only, rrweb JSON rather than video. Min 1 second, max 2 hours, retained 30 days; inputs masked, but canvas, cross-origin iframe content, media, and WebGL are not captured ([recording](https://developers.cloudflare.com/browser-run/features/session-recording/)).                                             | **Disabled by default and out of the initial architecture.** There is no documented manual delete API, so it cannot satisfy immediate Scotty vaporization. |
| Data retention         | Ordinary Quick Actions and sessions process content ephemerally. Quick Action outputs cache for five seconds by default (`cacheTTL: 0` disables); session/CDP content is not cached. Crawl results persist 14 days; recordings persist 30 days ([FAQ](https://developers.cloudflare.com/browser-run/faq/)).                                                                      | Set `cacheTTL: 0` if native Kitesurf Quick Actions become supported. Do not use crawl or recording for secret-class work.                                  |

### Limits and price

Current documented account limits ([limits](https://developers.cloudflare.com/browser-run/limits/), [pricing](https://developers.cloudflare.com/browser-run/pricing/)):

- **Workers Free:** 10 browser-minutes/day shared across methods; 3 concurrent Browser Sessions; 1 new session/20 seconds; Quick Actions 1 request/10 seconds.
- **Workers Paid:** no technical browser-hour cap; 120 concurrent Browser Sessions; 1 new session/second; Quick Actions 10 requests/second.
- **Billing:** Paid includes 10 browser-hours/month, then `$0.09/hour`. Browser Sessions include 10 concurrent browsers measured as the monthly average of daily peaks, then `$2/month` per additional averaged browser. Quick Actions incur browser-hour charges only.
- A `429` and `Retry-After` are normal typed capacity outcomes. Closing in `finally` matters because idle sessions continue consuming browser time.

Kitesurf is announced as free during beta, but Cloudflare does not define whether its use still contributes to these browser-time, rate, or concurrency limits.

### History, closing, and deletion

- Public HTTP lifecycle: `POST /devtools/browser`; list/get session; list/create/close targets; `DELETE /devtools/browser/{session_id}` closes a live session ([CDP](https://developers.cloudflare.com/browser-run/cdp/), [session list](https://developers.cloudflare.com/api/resources/browser_rendering/subresources/devtools/subresources/session/methods/list/), [session close](https://developers.cloudflare.com/api/resources/browser_rendering/subresources/devtools/subresources/browser/methods/delete/)). Close returns `closing` or `closed`; it is not a history deletion.
- Worker Playwright/Puppeteer add `sessions()`, `history()`, and `limits()`. `history()` returns recent open/closed sessions and close reasons, but Cloudflare does not publish its retention or pagination contract ([Playwright](https://developers.cloudflare.com/browser-run/playwright/), [Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/)).
- Recording retrieval is `GET /accounts/{account}/browser-rendering/recording/{session_id}`. No recording-delete endpoint is documented.
- No API to erase Browser Run session history is documented. Crawl `DELETE` cancels an in-progress crawl; it does not erase completed retained results.

## 3. Target Scotty architecture

```text
Pi in Sandbox container
  -> existing session-bound sentinel transport
  -> Scotty Worker validates bounded browser command
  -> Sandbox DO acquires the sole run lease and records intent
  -> Worker-native BrowserRunExecutor
       -> @cloudflare/playwright launch(env.BROWSER, { browser: "kitesurf" })
       -> browser navigates to short-lived Scotty preview URL
            -> Worker preview relay validates run capability
            -> Sandbox DO validates session/port/lease
            -> Sandbox.fetchPort(...) reaches the app in its container
       -> DOM/network assertions + screenshot bytes
  -> Worker uploads verified artifacts through private R2 binding
  -> Sandbox DO commits terminal run metadata
```

### Boundaries and ownership

1. **Sandbox DO remains authoritative.** Add a run record owned by the existing session record/operation lease, for example `{ id, engine, state, nonce, approvedPort, startedAt, deadlineAt, assertionSummary?, artifactKeys?, providerSessionId?, failure? }`. Container files, Worker memory, and Browser Run state are observations only.
2. **Worker-native executor.** A small Effect service owns Playwright launch, timeout, close/finalizer, assertion decoding, Browser Run errors, and artifact streaming. The production layer receives `browser.raw`; tests substitute a fake CDP/browser adapter. Do not execute this Effect in the container.
3. **Private preview relay.** A remote Browser Run engine cannot navigate to the Sandbox's `127.0.0.1`. Expose only an internal Worker preview path that proxies one approved session and port through the Sandbox SDK. Authenticate it with a short-lived, run-scoped capability; persist only its digest in the Sandbox DO. Inject the raw capability as an HTTP header from the browser context—never in a URL, log, recording, container env, or workspace file.
4. **Bounded agent contract.** The Pi tool should expose intent-level operations such as `run`, approved navigation, locator action/assertion, screenshot, and close. It must not expose arbitrary CDP, the `BrowserRun` binding, Live View JWTs, account IDs, or API tokens.
5. **Artifacts.** The Worker/DO writes screenshot and assertion artifacts through an R2 binding. The container never receives R2 authority. Commit success only after size/type/hash checks; ambiguous upload or browser closure stays retryable/failed, never successful.

Suggested Kitesurf transition:

```text
requested -> leased -> connecting -> running -> finalizing -> succeeded
                                      |              |
                                      +-> failed <---+
interrupted/unknown -> reconcile -> failed (never inferred success)
```

Kitesurf's published Playwright type is deliberately `SessionlessBrowser` with `sessionId(): undefined`. Therefore an interrupted Kitesurf run cannot be reconciled through the documented session lookup API. Keep it one request, deadline-bounded, always close the WebSocket, and treat interruption as failure/unknown. A later Chromium controller may persist a provider session ID and reconcile with list/get/close APIs.

### Live View/HITL and recording

Do not put these in the Kitesurf slice. A later `chromium-session` profile may:

- store only the Cloudflare session ID in the Sandbox DO;
- mint Live View URLs on demand after Auth DO authorization and never persist them;
- model handoff as a lease state with a bounded deadline;
- close/reconcile the provider session before terminal success.

Recording remains off until Cloudflare offers manual deletion or Scotty explicitly accepts provider-side 30-day retention. Browser Run session-history metadata may remain even without recording, so secret-sensitive tasks need a policy decision before rollout.

## 4. Credential model

### Production runtime

Use only the native binding:

```ts
env: {
  BROWSER: Cloudflare.Browser("BROWSER"),
}
```

The binding is ambient Worker authority supplied by Cloudflare. Runtime Browser Run calls require **no API token or account ID** ([Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/)). Containers receive neither the binding nor a proxy to arbitrary Browser Run calls.

Do **not** use any of these in the runtime design:

- public REST/CDP with `Authorization: Bearer ...`;
- `Cloudflare.Workers.BrowserLocal`;
- an Alchemy `AccountApiToken` resource;
- `Config.redacted("CLOUDFLARE_API_TOKEN")` on Worker/container props;
- account ID/token in Alchemy outputs.

Alchemy's browser binding persists only binding metadata (`type` and `name`). In contrast, Alchemy state encoding intentionally unwraps `Redacted` and persists the actual value (`vendor/alchemy/packages/alchemy/src/State/StateEncoding.ts:43-68`); Cloudflare state storage encrypts that encoded state at rest but still retains it (`vendor/alchemy/packages/alchemy/src/Cloudflare/StateStore/Store.ts:39-55,165-178`). Encryption is not credential absence. Native binding authority is therefore the required boundary.

### Deployment authority

Alchemy deployment credentials remain operator/CI credentials in the Alchemy profile or CI environment, never resource props or stack outputs (`vendor/alchemy/website/src/content/docs/cloudflare/setup.mdx:39-103`). Pinned Alchemy knows `Browser Rendering Read/Write` permission groups (`vendor/alchemy/packages/alchemy/src/Cloudflare/ApiToken/PermissionGroups.ts:470-483`) and selectable OAuth scopes `browser:read` / `browser:write`, but those scopes are absent from its default OAuth scope list (`vendor/alchemy/packages/alchemy/src/Cloudflare/Auth/AuthProvider.ts:683-684,769-798`). Native binding deployment may need only Workers script write authority; the exact minimum deployment scope should be proved in a disposable canary.

The Cloudflare account ID is an identifier, not bearer authority. This integration does not add it to the container or Browser Run requests. Scotty/Alchemy already use account identity during deployment; if the policy means **no account identifier anywhere in Alchemy state**, that is a separate pre-existing state audit, not something the Browser binding alone can satisfy.

## 5. Delivery slices and proof

1. **Kitesurf canary:** add only the native Browser binding and Worker-side Playwright adapter; target a deterministic public synthetic page; assert DOM state, take one screenshot, close, and verify no token/account ID reaches container env/files/logs or Alchemy resource state.
2. **Sandbox preview:** add the short-lived header capability and one-port preview relay; prove a Kitesurf browser can execute JavaScript against an app reached through `Sandbox.fetchPort`, while cross-session, wrong-port, expired, replayed, and unauthenticated requests fail.
3. **Agent workflow/artifacts:** expose the bounded Pi tool, private R2 artifacts, interruption/429/timeout handling, hard-cap integration, and vaporize cleanup. Keep recording, crawl, session reuse, and HITL disabled.
4. **Optional Chromium sessions:** only after a separate deployed proof for session ID reconciliation, Live View authorization, handoff timeout, provider close, and accepted provider-history retention.

Minimum checks are contract tests with a fake browser adapter plus a guarded deployed canary using the real binding. Local emulation is insufficient for `quickAction()` and should not be treated as Browser Run lifecycle proof.

## 6. Open unknowns / gates

1. Cloudflare does not document a Kitesurf selector for native `BrowserRun.quickAction()`. `BrowserRun.fetch()` may be capable of forwarding a query-bearing Quick Action request, but this is not a supported contract.
2. Kitesurf support for Live View, `Cloudflare.*` HITL commands, recording, history, close semantics, and usage accounting is not explicitly documented. The published Playwright API calling it sessionless argues against assuming those features.
3. Browser Run session-history retention and history-deletion are undocumented. Recording has automatic 30-day deletion but no manual deletion API.
4. Docs say `keep_alive` caps at 10 minutes, while the generated HTTP API reference currently advertises up to 1,200,000 ms. Use 10 minutes until Cloudflare resolves the conflict.
5. Docs use both `/browser-run/*` and legacy `/browser-rendering/*`; alias longevity is unstated. Native binding avoids depending on either public prefix.
6. Verify the exact Cloudflare Playwright/Puppeteer package version and compatibility date against Scotty's bundle and Worker limits; pinned Alchemy's guide currently demonstrates Puppeteer with an `as any` cast.
7. Prove whether adding a native browser binding requires `browser:write` for Alchemy deploy credentials. Pinned Alchemy's default OAuth scopes do not include it.
8. Browser Run reaches the preview relay from Cloudflare's network and is identified as bot traffic. Validate WAF/Bot behavior and do not weaken site-wide protections to make the canary pass.
9. Strict Scotty vaporization cannot erase Cloudflare's provider-side session history. Decide whether metadata-only provider retention is acceptable before enabling non-synthetic or secret-bearing workflows.
10. Prove the preview relay's required method, redirect, streaming, subresource, and WebSocket behavior against the exact Sandbox `fetchPort` contract; the first slice should support only the smallest explicit subset rather than becoming a general public tunnel.
