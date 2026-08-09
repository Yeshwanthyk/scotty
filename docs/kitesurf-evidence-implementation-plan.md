# Kitesurf evidence implementation plan (superseded)

> Historical design record. Evidence v2 replaced this PNG replay proposal with
> matched before/after screenshots and a real browser-recorded WebM. The current
> contract is documented in `docs/hatch-summary-architecture.md`.

- **Status:** superseded by Evidence v2
- **Scope:** run bounded Kitesurf tests against the real app in one warm Scotty session, retain screenshots and a replay timeline, and update an authenticated session summary page
- **Deferred:** human portals, Live View, true pixel-time video, persistent browser sessions, arbitrary Playwright/CDP, runner-backed sessions
- **Supersedes for delivery:** the broader phase ordering in `docs/kitesurf-first-architecture.md`; that document remains the detailed security and lifecycle reference

## Orientation

The agent should be able to start a web app in its Sandbox, submit a bounded test, and receive one session-owned evidence summary. A Worker-side Kitesurf browser reaches the real app through a private, job-scoped preview bridge, performs locator actions and assertions, and captures PNGs. Each verified artifact appears on the summary page while the job runs. The final tool result links back to that page.

Kitesurf is the only browser engine in this slice. No browser binary, `agent-browser`, Cloudflare account ID, Browser Run token, or R2 credential enters the container.

Kitesurf does not natively emit true video in the selected sessionless launch. `@cloudflare/playwright@1.3.5` accepts `recording`, but its implementation applies that option only while acquiring a provider session; `browser: "kitesurf"` skips acquisition and returns `SessionlessBrowser`. Cloudflare also documents Playwright video as not fully supported and provider recording as rrweb structured events rather than video. Therefore v1 exposes a **Replay**: ordered PNG frames with timing and step metadata, played on the summary page with play/pause/scrub controls. It must not be labeled WebM or pixel-time video. True video remains a later backend decision.

This is not the later human Portal product. The bridge exists only during an evidence job, is authorized only for its Kitesurf context, is never shown as a shareable URL, and is revoked before the job becomes terminal.

## Settled decisions

1. Pin `@cloudflare/playwright` exactly to `1.3.5` and launch `launch(env.BROWSER, { browser: "kitesurf" })` through Alchemy's native browser binding.
2. Execute one complete declarative job per request. Do not expose browser/session handles or action-by-action CDP to the agent.
3. Tie every job to the source Sandbox DO. Container egress derives that DO from `context.containerId`; the agent does not submit or authenticate a session ID.
4. Add `evidence` to the existing sole `SessionOperation`. Hold it from job acceptance through browser close, preview revocation/unexpose, artifact verification, and terminal commit.
5. Store evidence authority under `scotty:evidence:v1` in the same Sandbox DO and update it under the same control gate/DO transaction as `scotty:session` where both must change.
6. Store PNG bytes in a new private `ARTIFACT_BUCKET`, never `BACKUP_BUCKET`, KV, or the container/workspace.
7. Publish artifacts only after validating PNG bytes, hashing them, putting them at a deterministic immutable R2 key, and confirming metadata with `head`.
8. Serve one authenticated summary page at `/s/:id/evidence/:jobId`. It polls a bounded JSON endpoint; no SSE/WebSocket is needed in v1.
9. Capture one PNG after every successful step and one best-effort failure PNG. Replay uses those frames and their monotonic offsets.
10. Initial limits: 1-12 steps, 1-4 assertions per step, 5 seconds per action/assertion, 30 seconds per step, 5 minutes per job, 5 MiB per frame, and 40 MiB per job. The remaining session hard cap always wins.
11. Retain completed evidence for seven days by default. Vaporize deletes it immediately and does not commit `gone` while deletion or preview cleanup remains ambiguous.
12. Keep runner-backed evidence disabled.

## Scope

### Included

- Real application behavior through a repository dev server bound to `0.0.0.0` on an approved port.
- Relative same-origin navigation.
- Test ID and bounded CSS locators.
- `goto`, `click`, `fill`, and approved-key `press` actions.
- `visible`, `textExact`, `count`, and `urlPath` assertions.
- Explicit functional pass/fail independent of screenshots.
- Per-step PNG capture and replay timeline.
- Private R2 artifacts, authenticated review, retention, expiry, and vaporize cleanup.
- Console error summaries if the exact Kitesurf package proves the required Playwright event support in the deployed canary.

### Excluded

- Human-accessible preview URLs, Portal tabs, annotations, Live View, handoff, or multiplayer.
- Arbitrary URLs, JavaScript evaluation, raw CDP, arbitrary Playwright, cookies, headers, request interception controlled by the agent, files, downloads, popups, multiple tabs, permissions, geolocation, or persisted browser state.
- Real secrets or production sign-in. Repositories may expose an explicit development-only login route using synthetic identities.
- True video, audio, rrweb provider recording, trace upload, GIF/WebM encoding, and periodic screenshot capture concurrent with page mutation.
- Pixel-regression claims. Kitesurf screenshots are review evidence.

## Boundary contracts

### Agent job input

```ts
type BrowserEvidenceJobV1 = {
  readonly version: 1;
  readonly port: number;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly steps: readonly BrowserEvidenceStepV1[];
  readonly capture?: {
    readonly screenshots: "after-each-step";
    readonly replay: boolean;
  };
};

type BrowserEvidenceStepV1 = {
  readonly name: string;
  readonly action: ActionV1;
  readonly expect: readonly [AssertionV1, ...AssertionV1[]];
};
```

`replay: true` changes presentation, not capture mechanics: the same ordered per-step PNGs receive timing metadata and are playable. This keeps one artifact model and avoids pretending to create video.

The container tool calls exactly:

```text
POST https://scotty.internal/api/evidence/jobs
Content-Type: application/json
```

It sends no credential, session ID, custom headers, target origin, or artifact destination. `ContainerProxy` resolves the source Sandbox DO from Cloudflare's container identity and dispatches to that same session.

### Tool result

```ts
type BrowserEvidenceResultV1 = {
  readonly version: 1;
  readonly jobId: string;
  readonly status: "succeeded" | "failed" | "interrupted" | "unsupported";
  readonly summaryUrl: string;
  readonly completedSteps: number;
  readonly frameCount: number;
  readonly failure?: { readonly code: string; readonly step?: number };
};
```

The Pi tool returns a concise text block containing status, failed assertion if any, and the authenticated summary URL. It does not inline base64 screenshots into the Pi transcript; the durable session page owns review.

### Read routes

```text
GET /s/:id/evidence
GET /s/:id/evidence/:jobId
GET /api/sessions/:id/evidence/:jobId
GET /s/:id/evidence/:jobId/frames/:frameId.png
```

All routes require the existing browser-client cookie, validate session/job ownership in the Sandbox DO, reject root-token query/cookie/bearer handoff, and return `Cache-Control: private, no-store`. R2 remains private and no presigned URL is returned.

The JSON summary endpoint includes only bounded state, timings, action kinds, assertion summaries, frame IDs/hashes, and typed failure codes. It excludes preview hosts, cookies, fill values, page HTML, undeclared page text, request bodies, provider payloads, and secrets.

## Authoritative state

`SessionRecord` remains the lifecycle authority. Evidence uses a separate schema-owned record in the same DO:

```ts
type EvidenceStateV1 = {
  readonly version: 1;
  readonly nextSequence: number;
  readonly activeJob?: EvidenceJobV1;
  readonly jobs: readonly EvidenceJobSummaryV1[];
  readonly artifacts: readonly EvidenceArtifactV1[];
  readonly pendingDeletes: readonly EvidenceDeleteV1[];
  readonly retainedBytes: number;
};
```

An active job contains the operation nonce, port, runtime epoch, preview route nonce, preview-cookie digest, deadline, phase, completed step results, and frame manifests.

R2 owns artifact bytes. The evidence record owns object identity, availability, retention, and deletion intent. KV receives no evidence detail. Summary-page JSON is derived/display state. In-memory browser/page objects and abort controllers are disposable execution state.

### Transition graph

```text
none
  -> accepted
  -> exposing
  -> running
       -> append step result + verified frame
       -> append step result + verified frame
  -> finalizing
       -> revoke preview cookie digest
       -> close browser
       -> unexpose port
  -> succeeded | failed | interrupted | unsupported

available artifact
  -> delete_pending
  -> deleted
```

### Invariants

1. At most one active evidence job exists per session.
2. Every active job matches `SessionRecord.operation.kind === "evidence"` and the same nonce.
3. `deadlineAt <= hardCapAt` and no browser/preview/replay activity extends either deadline.
4. Preview authorization requires the current session, operation nonce, job, runtime epoch, port, route nonce, unexpired deadline, and cookie digest.
5. A required failed assertion means the job fails even if every screenshot succeeded.
6. A published frame has a verified R2 object with matching owner, media type, length, and SHA-256.
7. Success requires browser close and successful unexpose before terminal commit/release.
8. Interrupted or ambiguous browser execution never becomes success and is never replayed automatically.
9. Snapshot, sleep, down, and resume conflict while evidence owns the lease. Hard cap and vaporize preempt it.
10. Vaporize completion requires no active preview, cookie digest, evidence object, delete intent, or evidence schedule.

## Target production flow

```text
Pi agent in session container
  -> scotty_browser_test(decoded job)
  -> ContainerProxy handles scotty.internal
  -> source Sandbox DO derived from context.containerId
  -> atomic accept
       require warm + Cloudflare + runtime running + no operation
       acquire operation(kind=evidence)
       persist job/deadline/cookie digest
       arm deadline
  -> expose approved port on installation preview domain
  -> launch sessionless Kitesurf through env.BROWSER
  -> isolated context receives exact-host preview cookie
  -> for each step
       execute action
       evaluate every assertion
       page.screenshot()
       validate/hash/put/head private R2 object
       atomically append result/frame to evidence state
       summary polling now sees the frame
  -> finalizer revokes digest, closes browser, unexposes port
  -> terminal atomic commit and operation release
  -> tool receives status + summaryUrl

Authenticated user
  -> summary page shell
  -> polls bounded job JSON
  -> fetches authorized PNG routes
  -> displays progress, assertions, thumbnails, and Replay controls
```

## Typed failure behavior

Domain failures should be tagged Effect values; native Cloudflare/Playwright/R2 Promise failures are translated once in host adapters.

| Failure                                                | Result                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Invalid job/port/path/locator/bounds                   | `400 bad_request`; no job                                                                        |
| Session not warm, runtime stopped, or operation active | existing `wrong_state`/`conflict`; no job                                                        |
| Preview DNS/route/TLS unavailable                      | terminal `unsupported` or deployment-disabled capability                                         |
| Kitesurf action/CDP capability unsupported             | terminal `unsupported`; do not call it an app failure                                            |
| Assertion mismatch                                     | terminal `failed`, with bounded expected/actual summary and failure frame when possible          |
| Screenshot invalid/over budget                         | terminal `failed`; never publish frame                                                           |
| R2 put outcome unknown                                 | retain `put_unknown`, reconcile exact key with `head`, never claim availability early            |
| Worker request interruption/deadline                   | deadline callback marks `interrupted`, revokes/unexposes, and releases/fails the lease           |
| Unexpose outcome unknown                               | retain `unexpose_pending`, keep authorization revoked, block another job and vaporize completion |
| Artifact deletion unknown                              | retain `delete_pending`; retry until absence is proved                                           |

## Implementation chunks

### Chunk 1 — Prove the exact Kitesurf binding

**Behavior delivered:** A deployed synthetic canary can launch sessionless Kitesurf through a native Worker binding, execute JavaScript, assert DOM state, produce a valid PNG, close, and report `sessionId() === undefined`.

**Files and symbols:**

- `worker/package.json`, root `package-lock.json` — exact `@cloudflare/playwright@1.3.5` pin.
- `infra/cloudflare-stack.ts` — `Cloudflare.Browser("BROWSER")` binding.
- `worker/src/bindings.ts` — typed `BROWSER` binding.
- New guarded canary under `e2e/`.

**Dependencies:** none.

**Verification:** worker typecheck, infra typecheck, disposable deployed canary. The canary also proves that `recording: true` does not yield a retrievable Kitesurf recording, locking Replay—not video—as the v1 contract.

**Risk:** beta API drift. Exact pin plus canary fails closed.

### Chunk 2 — Land schemas and authoritative lifecycle

**Behavior delivered:** Jobs can be decoded, accepted under the session's sole operation lease, observed, failed/interrupted, and finalized using fake browser/preview/artifact services.

**Files and symbols:**

- `worker/src/contracts.ts` — add `evidence` to `OperationKindSchema` only.
- New `worker/src/evidence-contracts.ts` — job/result/state/error Schemas and derived types.
- New `worker/src/evidence-store.ts` — `scotty:evidence:v1` transactions.
- `worker/src/session-store.ts` — one transaction/control-gate path for session plus evidence mutations.
- `worker/src/session-lifecycle.ts` — evidence deadline callback.
- `worker/src/session.ts` — evidence RPC entrypoints and hard-cap/vaporize integration.
- `.oxlintrc.json` — strict migrated-production entries.

**Execution/state:** `none -> accepted -> running/finalizing -> terminal`, with nonce checks at every write.

**Dependencies:** Chunk 1 capability shape, but tests use fakes.

**Verification:** `@effect/vitest` tests with `TestClock` for bounds, lease conflicts, interruption, hard-cap races, stale nonces, finalizers, and cleanup retry.

**Risk:** accidental second authority. Evidence and session writes that change operation ownership must share the same DO transaction and control revision.

### Chunk 3 — Add private artifact storage and summary page

**Behavior delivered:** Fake/real PNG artifacts can become available only after verification; authenticated users can watch a job summary update and play its completed frame sequence.

**Files and symbols:**

- `infra/installation.ts` — explicit installation-scoped artifact bucket name.
- `infra/cloudflare-stack.ts` — private retained R2 bucket and Worker binding.
- `worker/src/bindings.ts` — `ARTIFACT_BUCKET`.
- New `worker/src/artifact-store.ts` — put/head/open/delete adapter.
- `worker/src/index.ts` — evidence list/summary/frame routes before `/s/:id/*`.
- New `worker/public/evidence.html`, `evidence.js`, and `evidence.css`.
- Route, artifact-store, and UI projection tests under `worker/test/`.

**Execution/state:** validated bytes -> `putting` -> R2 put/head -> `available`; summary page polls every second while nonterminal and stops at terminal.

**Dependencies:** Chunk 2 state model.

**Verification:** magic-byte/hash/size validation, ambiguous put/head reconciliation, authentication and ownership tests, `no-store`, no public R2 route, Replay ordering/play/pause/scrub tests.

**Risk:** sensitive screenshots. Private access, seven-day retention, no public URL, and immediate vaporize deletion are mandatory, not follow-up hardening.

### Chunk 4 — Build the private job-scoped app bridge

**Behavior delivered:** Kitesurf can reach the real app port without creating a human portal or exposing a bearer URL.

**Files and symbols:**

- `infra/installation.ts` — explicit preview base and zone configuration.
- `infra/cloudflare-stack.ts` — proxied wildcard DNS and Worker route using pinned Alchemy resources.
- `worker/src/bindings.ts` — preview base configuration.
- New `worker/src/evidence-preview.ts` — host parsing, cookie authorization, request/response sanitation, `proxyToSandbox` wrapper.
- `worker/src/index.ts` — preview-host dispatch before Hono/assets.
- `worker/src/session.ts` — fenced `exposePort`/`unexposePort` calls tied to runtime epoch and evidence nonce.

**Execution/state:** evidence lease -> expose -> recheck runtime/nonce -> publish digest -> transactionally admit and reserve each HTTP request -> claim/revalidate at `Sandbox.fetch` -> settle on response EOF/cancel/error -> persistently revoke permits -> abort matching live streams -> unexpose.

**Dependencies:** installation must explicitly provide wildcard DNS/route/TLS; never infer account/domain identity.

**Verification:** deployed wildcard TLS/host-routing probe, exact-host cookie requirement, URL-only denial, header stripping, same-origin app fetch, WebSocket not required for this slice, unexpose and stale-runtime denial.

**Risk:** this is the largest deployment gate. `workers.dev` cannot supply wildcard preview routing; enable evidence only after deployed DNS/route/TLS proof.

The v1 bridge remains ordinary HTTP only: WebSocket/HMR upgrades are denied. Per-job accounting reserves at most four concurrent requests, 16 MiB ingress plus 16 MiB response per request, and 30 seconds per request against 64 MiB aggregate bytes and 120 seconds aggregate request time. Header and cookie parsing precede admission; a canonical declared length or the full 16 MiB ingress cap is persisted before body buffering, the body is read only until permit expiry, and EOF adjusts the reservation to observed bytes before forwarding. Normal EOF or client cancellation settles observed use, while timeout, persisted expiry, and unreconciled authority charge the full reservation and 30 seconds. An unclaimed proxy failure is canceled idempotently so recovery cannot reopen authority.

`Sandbox.fetch(request: Request): Promise<Response>` is a public override in pinned `@cloudflare/sandbox@0.12.3`, but its preview marker/port/token/sandbox-id headers and forwarding implementation are SDK-private contracts. The local suite therefore proves Scotty's narrow boundary with an injected post-claim forwarder while production delegates to `super.fetch`. Before evidence can be enabled on a deployed stage, the canary must prove all of the following against the pinned SDK and actual Workers RPC streaming:

1. `proxyToSandbox` preserves Scotty's Worker-added opaque request header until the subclass `fetch` override, while direct SDK preview requests without that header are denied. Because the pinned adapter converts routing failures to an unmarked synthetic 500, only a response carrying the subclass's private request-bound claimed marker is accepted; the Worker strips that marker externally.
2. The subclass rejects all Upgrade, Connection, and `sec-websocket-*` framing before claim, strips the private request header before `super.fetch`, claims exactly once before any TCP-port fetch, and still receives the SDK's canonical preview route fields.
3. Response EOF, client cancel, upstream error, 16 MiB truncation, and the 30-second deadline each cancel the upstream body as applicable and durably settle exactly once under backpressure.
4. Runtime stop, finalization, hard cap, and vaporize persist revocation before aborting matching live streams and before unexpose/destroy; an old request ID cannot claim after restart or DO reconstruction.
5. Upgrade/WebSocket/HMR requests remain denied at both Worker ingress and the Sandbox forwarding boundary.

No local fake establishes these SDK/header/backpressure properties, and this task does not deploy or relax the gate.

### Chunk 5 — Execute real Kitesurf jobs and append frames

**Behavior delivered:** The decoded graph drives the actual app, assertions decide success, and each completed step updates the summary with a verified screenshot.

**Files and symbols:**

- New `worker/src/kitesurf-client.ts` — scoped launch/context/page adapter.
- New `worker/src/evidence-workflow.ts` — Effect orchestration.
- `worker/src/session.ts` — provide live Kitesurf, preview, artifact, and store layers.
- New focused workflow tests plus deployed deterministic app canary.

**Execution:** launch -> context/cookie/network guard -> sequential action/assertion/capture -> finalizer. No step replay after transport ambiguity.

**Dependencies:** Chunks 1-4.

**Verification:** every action/assertion kind, expected failure, invalid screenshot, Kitesurf unsupported classification, direct-to-R2 frame, summary updates before terminal completion, browser close/unexpose on all exits.

**Risk:** real repository compatibility. Unsupported browser behavior must be a typed capability result, not an assertion failure or false success.

### Chunk 6 — Add the agent tool and session attachment

**Behavior delivered:** Pi agents can call one bounded tool and automatically receive a durable summary link attached to the owning session worklog/tool result.

**Files and symbols:**

- New `worker/container/pi-packages/sources/scotty-browser-test/`.
- `worker/container/pi-packages/manifest.json`, `settings.json`, `THIRD_PARTY_NOTICES.md`, `worker/container/Dockerfile`.
- `worker/src/container-auth.ts` — approved package path.
- `worker/src/container-session-egress.ts` — exact internal evidence POST route and bounded response decoding.
- `scripts/check-pi-packages.mjs` and tests — package inventory/integrity.

**Boundary:** the tool submits no authority and receives no preview/browser/storage credentials. Its result contains the authenticated Scotty summary URL.

**Dependencies:** Chunk 5.

**Verification:** package checks, egress ambient-authority rejection, source-DO ownership, protocol size limits, real Pi canary producing one passed and one failed summary.

**Risk:** generic browser escape. The extension must expose only the v1 job schema, not fetch, CDP, arbitrary Playwright, or artifact upload.

### Chunk 7 — Complete lifecycle proof and guarded rollout

**Behavior delivered:** Evidence is safe under hard cap, sleep conflicts, interruption, expiry, and vaporize; production enablement is gated by the exact deployed stack.

**Files and symbols:**

- Existing lifecycle tests: `session-lifecycle-machine`, `session-down-vaporize`, `session-resume`, `session-store`.
- New evidence lifecycle and artifact tests.
- `e2e/scripts/scan.mjs` — leak/orphan scans for evidence state, preview exposure, schedules, R2 metadata, and credentials.
- Installation/CLI deployment surfaces needed for explicit preview and artifact resources, preserving existing JSON and exit contracts unless separately versioned.

**Dependencies:** all prior chunks.

**Verification:** formatting, skill lint, lint, affected typechecks/tests, full `test:all`, scan, container build, guarded disposable deployed canary, and no-orphans proof.

**Risk:** cleanup ambiguity. The rollout remains disabled if the canary cannot prove preview revocation, R2 deletion, and schedule cleanup.

## Verification matrix

| Contract                 | Offline proof                 | Deployed proof                                                 |
| ------------------------ | ----------------------------- | -------------------------------------------------------------- |
| Job decoding and bounds  | schema/property tests         | rejected malformed live request                                |
| Sole operation lease     | store/lifecycle race tests    | collision with snapshot/down                                   |
| Kitesurf selection       | adapter fake contract         | exact package, `sessionId() === undefined`                     |
| Real app execution       | scripted fake page            | deterministic JS app through private bridge                    |
| Assertions decide status | workflow tests                | deliberately wrong assertion fails red                         |
| PNG validity/ownership   | artifact adapter tests        | put/head/read through private R2                               |
| Summary updates          | UI polling/projection tests   | frames visible before terminal result                          |
| Replay                   | ordered timing/UI tests       | plays deployed frame sequence                                  |
| Auth isolation           | route/egress tests            | URL-only preview and unauthenticated summary denied            |
| Finalization             | scoped interruption tests     | browser close and unexpose after forced failure                |
| Hard cap/vaporize        | TestClock/state-machine tests | disposable stack leaves no exposure/object/schedule            |
| Credential isolation     | structured leak tests         | deployed scan contains no real token/account/browser authority |

## Cost envelope

Scotty already requires Workers Paid for Containers, so this feature adds no new Cloudflare base subscription. Current official Kitesurf launch material says it is free while in beta; budget against standard Browser Run pricing anyway because no post-beta Kitesurf price is published.

- Browser Run Paid includes 10 browser-hours/month, then charges $0.09/hour. Equivalent overage is $0.0015 for one minute or $0.0075 for five minutes. Ten average concurrent browsers are included; Scotty's current ten-container maximum and one job per session stay within that billing allowance.
- One 24 MiB/12-frame job retained seven days costs about $0.00014 in R2 Standard after free allowances. Standard includes 10 GB-month, 1 million Class A operations, and 10 million Class B operations monthly.
- A DO held active for a full five-minute job consumes 37.5 GB-s. After the included 400,000 GB-s/month, that is about $0.00047 per job. In practice the owning session DO/container is usually already active.
- Evidence does not create another container. If a five-minute test alone keeps the existing `standard-2` container awake beyond the agent's work, container overage is approximately $0.006 at 20% CPU to $0.011 at full CPU, before included container allowances.
- A first-level wildcard on an existing Cloudflare zone adds no documented fixed Cloudflare DNS/TLS/route fee. A separate preview domain adds its registrar renewal cost. Avoid `*.preview.example.com` under the `example.com` zone: Universal SSL does not cover that nested wildcard, and Advanced Certificate Manager is documented at $10/month per zone. Prefer a dedicated zone such as `*.scotty-preview.example` or a safely reserved first-level wildcard.

At 1,000 five-minute jobs/month, current beta browser cost is $0 and the planned R2/DO usage remains inside the listed included allowances; the likely incremental Cloudflare invoice is $0 apart from any additional container awake time or domain registration. At standard post-beta Browser Run rates, the same 83.3 browser-hours would cost about $6.60 after the included 10 hours. At 10,000 five-minute jobs, standard browser overage is about $74.10; R2 storage is roughly $0.69, and one-second live summary polling could add about $0.30 in DO request overage. These are account-level estimates and shared usage from other workloads reduces the included headroom.

Primary pricing references: [Browser Run](https://developers.cloudflare.com/browser-run/pricing/), [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

## Rollout

1. Add an installation-scoped `SCOTTY_EVIDENCE_ENABLED` gate defaulting off.
2. Deploy binding and synthetic canary only; confirm Kitesurf package behavior.
3. Deploy state/artifact/summary behind owner-only test access.
4. Enable the private bridge only after wildcard DNS, route, and TLS proof.
5. Run the full deterministic passed/failed/interrupted/vaporized canary.
6. Enable the Pi tool for one installation.
7. Observe launch failures, unsupported classifications, job duration, screenshot bytes, R2 reconciliation, unexpose retries, and cleanup age by IDs/counts only.
8. Expand availability only while no-orphans and credential scans remain green.

Existing v1 installation pointers remain valid and preview-free. Enabling evidence for one of those installations is a deployment gate: first migrate its local pointer/topology to the optional v2 preview fields through a separately designed, reviewed migration path, then prove the configured wildcard domain and TLS, and only then set the gate. This bridge-only slice intentionally does not add a v1-to-v2 migration command.

## Residual risks

- Kitesurf is beta and may not support a real app's browser surface. The exact deployed canary protects platform compatibility; each job still needs typed `unsupported` behavior.
- Screenshot evidence may contain repository secrets rendered by the app. Private access and retention reduce exposure but cannot reliably redact pixels.
- The wildcard preview domain and certificate are mandatory infrastructure even though human portals are deferred.
- Step-frame Replay can miss animation between actions. It is evidence of checkpoints, not continuous motion or a visual-regression oracle.
- Holding the global evidence lease intentionally blocks snapshot/down/resume for at most five minutes. Hard cap and vaporize remain preemptive.

## Open decisions and gates

1. **Replay terminology:** approve the v1 definition of “recording” as a playable, timestamped PNG sequence. Requiring a downloadable true WebM now rejects this simple Kitesurf-only plan and requires another encoding/browser backend.
2. **Installation preview domain:** provide an explicit wildcard base, owning Cloudflare zone, and certificate strategy. Evidence cannot run against Sandbox-local apps without it.
3. **Retention policy:** this plan selects seven days and 40 MiB per job; installation-wide quota and cleanup cadence should be confirmed before broad rollout.
4. **Synthetic app authentication:** repositories needing login must define a development-only same-origin login/seed contract. Real credentials remain forbidden.

Live View/Portals begin only after this packet is deployed and proved. They reuse the private transport primitives but require separate human authorization, stable service lifecycle, and UX decisions.
