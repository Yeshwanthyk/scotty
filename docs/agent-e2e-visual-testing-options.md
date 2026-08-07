# Agent E2E visual testing options

**Status:** superseded comparison note  
**External facts re-verified:** 2026-08-06  
**Superseded by:** `docs/kitesurf-first-architecture.md` after proving native sessionless Kitesurf launch and a Sandbox SDK portal bridge. This note remains useful for comparing full-Chromium/video trade-offs.

## 1. Executive recommendation

Scotty should add a **session-scoped `BrowserSession` inside the same Sandbox as the app**, controlled through a Scotty-owned Pi tool and headless Playwright. The app and browser can then share `localhost`; the Sandbox Durable Object (DO) remains authoritative for capture state and lifecycle; and finalized artifacts flow through a Worker-side `ArtifactStore` into a **separate private R2 artifact bucket/prefix**. An authenticated review surface should stream them only after browser-client authorization. Traces and videos are secret-class by default. There should be no public “unguessable” artifact URLs.

Build this in three slices. First prove a PNG and a finalized Playwright trace on the disposable deployed stack. Then expose the bounded agent tool and lifecycle integration. Only then add Playwright's current Screencast WebM path, after deployed stop/finalization/upload is proven. Playwright explicitly supports screenshots, rich traces, and a Screencast API that can deliver live JPEG frames and save WebM on `stop()` ([screenshots](https://playwright.dev/docs/screenshots), [trace viewer](https://playwright.dev/docs/trace-viewer-intro), [Screencast](https://playwright.dev/docs/api/class-screencast)).

This evidence is for review, not correctness by itself. A screenshot or video can show a convincing path while missing regressions; the browser script must also make explicit DOM/network assertions and report their results in the manifest.

## 2. What Cursor and Amp actually prove

### Cursor Cloud Agents

**Verified facts.** Cursor documents one isolated VM per cloud agent, with a full desktop, mouse/keyboard browser use, screenshots/videos/log references, PR-attached demos, and remote desktop takeover with hand-back to the agent ([capabilities](https://cursor.com/docs/cloud-agent/capabilities), [computer-use announcement](https://cursor.com/blog/agent-computer-use)). Cursor also exposes agent-scoped artifact listing and a download endpoint that returns a 15-minute presigned URL ([Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)). Its GitHub embedding mode intentionally uses long public URLs because GitHub's image proxy requires them ([capabilities](https://cursor.com/docs/cloud-agent/capabilities)).

**What that proves.** Giving an agent the app's actual runtime and making review evidence a first-class output materially improves handoff. Live takeover is useful when automation stalls.

**What it does not prove.** The reviewed Cursor contracts do not promise deterministic replay of mouse/keyboard actions. Their demos are human evidence, not assertion proof. Scotty should copy the integrated feedback loop and artifact lifecycle, not Cursor's public-link choice or assume a video is a test oracle.

### Amp Orbs

**Verified facts.** Amp defines Orbs as fresh remote machines for unattended agents. Its current image includes `agent-browser`, `ffmpeg`, and ImageMagick; its Portals are authenticated URLs to services inside an Orb; and users can review files and share a terminal ([Orbs manual](https://ampcode.com/manual/orbs)). Amp's own engineering walkthrough demonstrates agents producing screenshots/recordings and directs visual artifacts to `.amp/in/artifacts/` ([Putting an Agent in an Orb](https://ampcode.com/notes/putting-an-agent-in-an-orb)). Multiplayer exposes the Portal, file changes, and shared terminal to authorized workspace participants ([Multiplayer](https://ampcode.com/news/multiplayer)).

**What that proves.** A fresh machine with a paved dev-server command, seeded test identity, known ports, browser tooling, and an obvious artifact directory can let the agent self-correct without bespoke instructions for every repository.

**What it does not prove.** The reviewed Amp sources do not define a durable artifact API/retention contract comparable to Cursor's, and Portals/files/shared terminals are not a general full-remote-desktop contract. Scotty needs an explicit manifest, retention, authorization, and cleanup model rather than treating files left by the agent as publication.

## 3. Scotty's current gap and hard constraints

### Current gap

- CI runs `npm run check`, which reaches `test:all`; the default E2E is a real CLI process against an in-memory fake Worker/session service (`.github/workflows/ci.yml:13-28`, `package.json:17-18`, `package.json:38-44`, `e2e/README.md:3-6`). It proves contracts, not rendering.
- `local-live` runs the real local Worker, Docker Sandbox, and Pi, but its browser step only issues pairing and invokes macOS `open`; there is no browser automation or capture (`e2e/README.md:30-51`, `e2e/scripts/local-live.mjs:399-419`, `e2e/scripts/local-live.mjs:563-575`).
- The deployed canary is a disposable full stack (`e2e/README.md:60-66`), but its UI check uses Node `fetch`, asserts HTML text, and checks a non-upgraded terminal response; no browser engine executes the page (`e2e/tests/deployed.test.mjs:212-231`).
- The image installs and probes a pinned developer toolchain, but Scotty does not install or probe Chromium, Playwright, FFmpeg, or Xvfb (`worker/container/Dockerfile:41-52`, `worker/container/Dockerfile:87-98`, `worker/container/Dockerfile:184-188`).

### Useful seams already present

- `SandboxRuntime` already owns command execution, process start/lookup/kill/wait, port readiness, and port fetch (`worker/src/sandbox-runtime.ts:32-47`, `worker/src/sandbox-runtime.ts:54-94`).
- `PI_PACKAGES` is the explicit extension-packaging seam for a Scotty browser tool (`worker/src/container-auth.ts:9-17`).
- `/s/:id/*` already authenticates a browser-client cookie, while the subpath implementation validates the session and returns 404. It is a reserved place for a future review contract, not permission to silently change routes (`worker/src/index.ts:659-672`, `worker/src/index.ts:967-979`).
- Checkpointing already quiesces/stops Pi, syncs, and backs up the whole session root (`worker/src/session.ts:1795-1834`). Since that root is `/workspace/<id>` (`worker/src/workspace.ts:61-62`), large and sensitive capture bytes must stage outside it (for example `/tmp/scotty-artifacts/<capture-id>`) and upload separately.
- Alchemy already creates the Sandbox DO, non-secret KV projection, and R2 backup bucket and binds them to the Worker (`infra/cloudflare-stack.ts:127-145`, `infra/cloudflare-stack.ts:167-184`). Add artifact storage as a distinct resource/binding; do not overload backup records or KV.

### Invariants the design must preserve

1. The Sandbox DO remains authoritative for the session, sole mutation lease, credentials, hard-cap state, backup handles, `BrowserSession`, and artifact manifests. KV remains a non-secret list projection. R2 backup objects remain immutable backups.
2. Container processes and files are never authoritative. The container receives sentinels only; artifact upload must not put R2 credentials in it.
3. Existing egress remains allowlisted (`worker/src/egress.ts:28-46`). A page that needs an unapproved CDN should fail visibly, not broaden policy implicitly.
4. Hard cap wins over capture. Snapshot still quiesces before sync/backup. Vaporize retries until browser processes, staging, metadata, artifact objects, backups, credentials, projection, and schedules are gone.
5. Runner-backed session creation remains unavailable until native Pi RPC transport and deployed lifecycle proof exist (`worker/src/index.ts:419-430`). Option D cannot bypass that gate.
6. Existing public routes, CLI JSON, and exit codes stay unchanged. Any review route named below is a future explicit contract decision.

## 4. Decision matrix

| Option                                                            | Localhost reach                                                                                                           | Capture/review quality                                                                                                                                                                                                         | Isolation and lifecycle                                                                                               | Cost/complexity                                                                                    | Fit now                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Colocated headless Playwright in each Sandbox**              | Direct: browser and app share the Sandbox network namespace                                                               | Best first-party Playwright fidelity: assertions, PNG, trace, and later WebM/live frames                                                                                                                                       | Browser failure is inside the session blast radius; DO can own process IDs and hard-cap cleanup                       | Larger image and higher per-session CPU/RAM; one pinned browser/toolchain                          | **Best.** Reuses process/port, Pi-package, backup, auth, and canary seams without exposing the app                                                                                                                                                                                         |
| **B. Dedicated browser Sandbox/service over Playwright protocol** | Not direct; requires an authenticated session-to-browser preview bridge                                                   | High with Playwright's native protocol; `connectOverCDP` is Chromium-only and documented as lower fidelity than `connect()` ([BrowserType](https://playwright.dev/docs/api/class-browsertype))                                 | Stronger browser isolation and pooling, but two runtimes now share one capture lease and must survive partial failure | Highest distributed-systems cost: capability issuance, version matching, routing, quotas, cleanup  | Good later if browser resource pressure dominates; premature before one capture lifecycle works                                                                                                                                                                                            |
| **C. Cloudflare Browser Run broker**                              | A remote managed browser cannot address `localhost` in a separate Scotty Sandbox; Scotty must first expose/bridge the app | Managed screenshots/CDP and lightweight rrweb session recording; recording is structured DOM/input/navigation data, not video ([session recording](https://developers.cloudflare.com/browser-run/features/session-recording/)) | Cloudflare owns browser lifecycle, but Scotty still owns target authorization and artifacts                           | Lowest browser-image operations; adds binding, quotas, remote target path, and product limitations | Not first: Cloudflare says Playwright Test and videos are not yet fully supported ([Playwright support](https://developers.cloudflare.com/browser-run/playwright/)); session inactivity/limits also constrain long runs ([limits](https://developers.cloudflare.com/browser-run/limits/))  |
| **D. Headed Xvfb + FFmpeg, or trusted local runner**              | Direct when colocated; runner can reach local/private apps according to its network                                       | Full desktop pixels, native dialogs, multiple apps, and browser chrome                                                                                                                                                         | Largest attack surface; desktop state, display, audio, secrets, and takeover need new authority and cleanup contracts | Highest CPU/storage/operational cost; FFmpeg/X11 tuning and runner trust                           | Reserve for desktop/native-app evidence. Playwright's CI guidance requires Xvfb for headed Linux ([CI](https://playwright.dev/docs/ci)); FFmpeg can capture X11 displays ([devices](https://ffmpeg.org/ffmpeg-devices.html)), but this fidelity is unnecessary for the first web-app slice |

## 5. Selected shape: A, screenshot + trace first

A is the smallest end-to-end shape that can launch a repository app and exercise it where it already runs. It avoids inventing a preview tunnel, distributed browser capability, or desktop takeover protocol. It also preserves high-fidelity Playwright semantics. Playwright traces contain DOM snapshots plus action, log, source, network, error, and console views ([trace viewer](https://playwright.dev/docs/trace-viewer-intro)); that diagnostic value is precisely why traces can contain secrets and must be private.

The first milestone should create an explicit screenshot and trace, close the browser context, hash both files, upload them, and prove authenticated retrieval. Standard Playwright video is only available after page/context close ([videos](https://playwright.dev/docs/videos)); the newer Screencast API likewise writes WebM when stopped and can simultaneously emit live JPEG frames ([Screencast](https://playwright.dev/docs/api/class-screencast)). WebM should wait until deployed tests prove that stop/finalization cannot be skipped by interruption, hard cap, snapshot, or vaporize.

**Why not Browser Run first?** Its operational simplicity applies when the target is already reachable from its managed browser. Scotty's app is on Sandbox localhost. Building a secure preview broker first would move the hard problem rather than remove it, while Browser Run still lacks full Playwright Test/video parity.

**Why not full desktop first?** The initial use case is a web app, for which DOM locators, assertions, traces, and page pixels are more deterministic and cheaper. Xvfb/FFmpeg or a trusted runner should be an explicit later capability for Electron/native/multi-app flows, after runner creation is enabled through its existing gate.

## 6. Target contracts and ownership

### `BrowserSession` — DO-owned control state

One active browser per Scotty session. Persist `{id, sessionId, state, processId, appPorts, startedAt, deadlineAt, captureId, lastActionAt, failure?}`. States are `starting → ready → finalizing → closed`, with terminal `failed`/`expired`. Every transition is revision/nonce checked under the session's sole operation lease. A browser process ID in the container is only an observation, never proof of state.

The agent uses a Scotty Pi extension delivered through `PI_PACKAGES`. Its bounded surface is launch/close, navigate to an approved loopback port, locator-based action, assertion, screenshot, and trace controls. It must not expose arbitrary browser protocol credentials, R2 credentials, Scotty root/browser credentials, or a generic public port. Existing background-terminal tooling may launch the repository's dev server; `BrowserSession` verifies port readiness and owns the browser/capture processes.

### `CaptureArtifact` — DO-owned manifest, R2-owned bytes

Use a versioned manifest such as:

```text
{id, captureId, sessionId, kind, mediaType, state,
 objectKey?, byteLength?, sha256?, createdAt, finalizedAt?, expiresAt,
 sensitivity: "secret", assertionSummary, redactionPolicyVersion, failure?}
```

Lifecycle: `staging → finalizing → uploading → available`; terminal/retry states: `upload_unknown`, `failed`, `delete_pending`, `deleted`, `expired`. The manifest is authoritative only in the DO. Bytes use an immutable key such as `artifacts/v1/<session>/<capture>/<sha256>.<ext>` in a separate private artifact bucket/prefix. Do not put manifests in KV or reuse `DirectoryBackup`/`ownedBackupIds`.

`ArtifactStore` is a Worker/DO-side service with `putVerified`, `open`, `head`, and `delete`. The DO reads a bounded staging stream from the Sandbox and uploads through the R2 binding; the container never gets storage credentials. `available` is committed only after size and checksum verification. If a put response is ambiguous, retain `upload_unknown`, the nonce, expected key, size, and digest; retry idempotently and reconcile with `head`. Never report a stale/ambiguous object as available.

### Authenticated review routes — future explicit public contract decision

Proposed additions under the currently reserved authenticated namespace:

- `GET /s/:id/artifacts` — private manifest list;
- `GET /s/:id/artifacts/:artifactId` — review metadata/UI;
- `GET /s/:id/artifacts/:artifactId/content` — authenticated, `no-store` byte stream with fixed content type and download disposition for trace/WebM.

They must use the existing browser-client cookie and scope rules, reject root query/cookie/bearer handoff exactly as session pages do, validate artifact ownership in the session DO, and never redirect to a public R2 URL. Keep all existing route behavior and CLI shapes unchanged until this addition is separately approved.

### Finalization, caps, auth, and redaction

- **Order:** stop accepting actions; stop trace/Screencast; close context/browser; wait for stable files; validate magic bytes; hash; upload; then delete staging. Browser/context close is a required finalizer, not agent etiquette.
- **Initial hard limits:** one browser and one active capture; 15-minute browser lifetime; 5-minute capture; at most 5 screenshots (10 MiB each), a 100 MiB trace, a later 100 MiB WebM, and 250 MiB total retained artifacts per session. Crossing a limit stops capture and records a typed failure. Values are deployment policy, not agent-controlled.
- **Retention:** propose seven days, bounded further by installation policy; vaporize deletes immediately. Expiry sets `delete_pending` until R2 deletion is confirmed.
- **Synthetic auth:** deployed proof uses only a deterministic local test app and seeded fake user/session. Repositories may supply an explicit test-only seed/magic-login hook. Never inject real Codex/GitHub credentials or Scotty root/client credentials into the browser profile, trace, page, app env, command line, or artifact.
- **Redaction:** scrub structured action logs, URLs, headers, and manifest errors using an explicit versioned policy; mask configured input selectors. Do not claim reliable post-hoc redaction of pixels, DOM snapshots, network bodies, canvas, or video. Because opaque content can still leak, screenshots, traces, and videos remain secret-class even after redaction.
- **Snapshot/hard cap:** refuse new actions, run the bounded finalizer, and kill the browser/app if the deadline wins. A failed/unknown capture is recorded; it cannot delay the hard cap. Artifact staging remains outside the backed-up workspace.
- **Vaporize:** cancel capture, kill processes, delete staging and every DO-owned artifact object, and retry ambiguous deletion before declaring all owned state gone. A screenshot must not outlive a vaporized session by accident.

## 7. Production and test call graphs

### Production

```text
Pi agent
  -> Scotty browser Pi tool (session capability; bounded actions)
    -> Sandbox DO BrowserSession transition under operation lease
      -> SandboxRuntime starts/observes app port + Playwright/Chromium
        -> Playwright drives http://127.0.0.1:<approved-port>
        -> assertions + PNG/trace staged under /tmp/scotty-artifacts/<capture>
      -> mandatory context/browser finalizer
      -> DO reads bounded staging stream
        -> ArtifactStore.putVerified -> private Artifact R2
      -> DO commits CaptureArtifact.available

User browser
  -> existing Auth DO client-cookie validation
  -> /s/:id/artifacts/... review route
  -> Sandbox DO ownership/manifest check
  -> ArtifactStore.open -> authenticated no-store response
```

No real credential crosses into Chromium or R2 object metadata. The Worker/DO, not the agent, decides object keys, limits, availability, and deletion.

### Test call graph / proof ladder

```text
CI offline
  real CLI -> fake Worker/DO/ArtifactStore
  proves schemas, leases, auth, caps, retries, ambiguous upload/delete, route envelopes

Container contract
  pinned image -> Chromium + Playwright probes
  deterministic local page -> locator assertion + valid PNG + readable trace

Local-live
  real Worker + Sandbox + Pi package -> synthetic app on localhost
  proves process/port control, agent tool, finalization, no workspace backup inclusion

Disposable deployed canary
  real Alchemy Worker/DO/Container/KV/private artifact R2
  -> drive synthetic UI -> finalize -> authenticated review
  -> snapshot/hard-cap/resume/vaporize
  -> prove no artifact, staging, runtime, KV, credential, backup, or schedule orphan
```

Visual artifacts supplement assertions. The canary must fail red if the browser never executed JavaScript, the expected DOM state was not reached, finalization did not complete, unauthenticated retrieval succeeds, a forbidden marker appears in structured metadata, or cleanup remains ambiguous.

## 8. Three implementation slices

### Slice 1 — deployed PNG + trace substrate

Add the pinned Chromium/Playwright image capability, DO-owned browser/artifact contracts, private `ArtifactStore`, and approved review routes. Drive a deterministic synthetic app directly from the disposable canary, make at least one DOM assertion, finalize a PNG and trace, and retrieve both with a browser client credential.

**Acceptance proof:** container contract plus deployed canary; unauthenticated/root-query access is rejected; trace is readable; checksums match; artifacts are absent from workspace backup; vaporize leaves no artifact/staging orphan.  
**Non-goals:** agent autonomy, WebM, live frames, public sharing, desktop takeover, Browser Run, arbitrary external sites.

### Slice 2 — agent-facing E2E workflow and lifecycle

Package the bounded Pi browser tool, connect it to `BrowserSession`, add synthetic-auth guidance/hooks, explicit assertion summaries, quotas, and snapshot/hard-cap interruption behavior. Prove a real Pi session can start the app, drive a UI state, and publish review evidence without receiving real credentials.

**Acceptance proof:** local-live and deployed synthetic task both produce the asserted state and private artifacts; forced interruption at each lifecycle phase yields either verified `available` or typed retry/failure, never false success.  
**Non-goals:** native apps, full desktop, human takeover, cross-session browser pooling, runner-backed creation.

### Slice 3 — bounded WebM

Use Playwright Screencast with both `path` and optional bounded `onFrame`; stop it in the same mandatory finalizer and upload only the closed, validated WebM. Live frames may support an authenticated ephemeral preview later, but are not persisted individually.

**Acceptance proof:** deployed capture survives normal close and forced hard-cap/snapshot paths, has bounded duration/size, decodes as WebM, and is deleted on expiry/vaporize; a killed finalizer never publishes a partial file.  
**Non-goals:** audio, X11 desktop recording, indefinite streaming, public embeds, deterministic action replay.

## 9. Risks and open decisions

- **Image/runtime support:** verify Chromium sandbox flags, shared memory, fonts, and Sandbox instance memory on the exact pinned base image; do not assume generic Playwright Docker guidance applies.
- **Resource contention:** colocated Chromium can starve Pi or the app. Measure standard-2 memory/CPU and enforce one-browser admission before considering option B.
- **Trace leakage:** traces can include DOM, console, URLs, request/response data, and cookies. Decide whether production traces are opt-in per capture or always-on only for synthetic canaries; secret classification is not optional.
- **App variability:** repositories need a discoverable start command, readiness signal, port, seed/reset hook, and test identity. Decide whether this is AGENTS.md convention, a checked-in Scotty manifest, or both.
- **Route contract:** separately approve exact `/s/:id/artifacts` paths, scope requirements, content-disposition behavior, and whether a session must be warm to review already-finalized artifacts.
- **Retention and quotas:** validate the proposed seven-day/250-MiB policy against R2 cost and user review latency; keep policy installation-scoped and non-agent-controlled.
- **Assertions:** decide the minimum machine-readable assertion schema. Do not infer success from “artifact exists.”
- **Live review:** choose later between Screencast frames, a Playwright viewer, or no live stream. It must remain authenticated and must not become desktop takeover accidentally.
- **Browser Run pivot point:** reconsider C only if apps gain a secure preview endpoint or capture mostly targets deployed public URLs.
- **Full desktop gate:** define a separate threat model and runner lifecycle proof before D; browser evidence must not quietly enable general remote control.

## Options to choose from

1. **Choose A (recommended):** colocated headless Playwright; ship private screenshot + trace first, then the agent tool, then bounded WebM.
2. **Choose B later:** split browser compute into a dedicated service only after measurements show colocated Chromium is the bottleneck.
3. **Choose C for public previews:** use Cloudflare Browser Run only when the target is already securely reachable and its Playwright/video gaps are acceptable.
4. **Choose D only for desktop apps:** Xvfb/FFmpeg or a trusted local runner after a separate security model and the native Pi runner gate are complete.
