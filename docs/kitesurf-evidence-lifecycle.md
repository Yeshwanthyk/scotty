# Kitesurf-first evidence and lifecycle ownership (superseded)

> Historical research record. It predates Evidence v2 and does not describe the
> shipped Showcase contract. See `docs/hatch-summary-architecture.md` for the
> active design.

- **Status:** superseded by Evidence v2
- **External facts verified:** 2026-08-06
- **Scope:** Browser Run Kitesurf only; no `agent-browser`, no browser binary in the Scotty container, and no local Chromium process.

## Decision

Scotty should drive a **remote Kitesurf Browser Session from the Worker/DO boundary**, not from the Sandbox container. A bounded Scotty browser tool submits typed intents; the Sandbox Durable Object (DO) owns the evidence run, the Browser Run session ID, the one mutation lease, assertion results, artifact manifests, deadlines, cleanup work, and retry state. Screenshot bytes go directly from the Worker-side browser adapter to a **separate private R2 artifact bucket**. The agent receives neither Browser Run authority nor R2 authority.

Use a Browser Session, rather than Quick Actions, for functional workflows: Cloudflare's Playwright API documents navigation, locator actions, `expect()` assertions, and screenshot bytes in one session. Select Kitesurf explicitly through the documented `browser=kitesurf` CDP endpoint. Cloudflare's current Kitesurf page documents that selector for CDP and Quick Actions, but not an equivalent Worker-binding launch option. Do not silently call a generic browser binding and assume it launched Kitesurf. The initial adapter should therefore connect from Worker code to the Kitesurf CDP endpoint; its API token is a Worker-only inherited secret/reference, never an Alchemy prop/state value or a container value. A later binding-backed transport is acceptable only after the exact Kitesurf selector is verified against the pinned package and a deployed capability test.

Kitesurf is the functional engine, not a pixel oracle. Structural assertions determine whether a workflow passed; a PNG is review evidence. Cloudflare says Kitesurf is not pixel-perfect, implements only a subset of CDP, cannot play video or render WebGL, and is not suitable for a long-running authenticated session. Every supported Scotty action must pass a Kitesurf-specific deployed contract test ([Kitesurf docs](https://developers.cloudflare.com/browser-run/kitesurf/)).

Do **not** enable Browser Run session recording in the first product contract. It is rrweb structured replay, not true video, and Cloudflare retains it for 30 days. The official docs expose retrieval but no early-delete contract. Enabling it would therefore make Scotty's “vaporize removes all owned evidence” invariant false. True video is outside the Kitesurf backend: Cloudflare separately lists Playwright video as not fully supported ([session recording](https://developers.cloudflare.com/browser-run/features/session-recording/), [Playwright](https://developers.cloudflare.com/browser-run/playwright/)).

## Provider facts that shape the design

| Concern                           | Official Browser Run contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Scotty consequence                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional actions and assertions | Cloudflare's Playwright fork demonstrates `goto`, locator `fill`/`press`, `expect(...).toHaveCount`, `toHaveText`, and `page.screenshot()`. Playwright Test is not fully supported, but assertions are the documented exception ([Playwright](https://developers.cloudflare.com/browser-run/playwright/)).                                                                                                                                                                                                                        | Expose a small typed action/assertion vocabulary. Do not expose arbitrary CDP or JavaScript evaluation to the agent. Capability-test every operation against Kitesurf because there is no complete Kitesurf action matrix.                                                                                                                                                                         |
| Screenshot bytes                  | `page.screenshot()` returns bytes that the official Worker example places directly in a PNG response. The screenshot Quick Action likewise returns image bytes; `/snapshot` is a different endpoint whose embedded image representation is base64 ([Playwright](https://developers.cloudflare.com/browser-run/playwright/), [screenshot endpoint](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/), [snapshot endpoint](https://developers.cloudflare.com/browser-run/quick-actions/snapshot/)). | Capture from the live Browser Session, validate PNG magic bytes, size, and hash, then upload the exact bytes to private R2. Never treat a JSON/base64 snapshot field as the PNG contract.                                                                                                                                                                                                          |
| Kitesurf fidelity                 | Kitesurf is an ephemeral, stateless engine with lower CPU/memory use, slightly slower wall time, non-pixel-perfect rendering, and only the agent-relevant subset of browser behavior ([Kitesurf docs](https://developers.cloudflare.com/browser-run/kitesurf/)).                                                                                                                                                                                                                                                                  | Assertions are authoritative for behavior; screenshots are human evidence. No shared Chromium/Kitesurf pixel baselines. Keep runs short and reproducible.                                                                                                                                                                                                                                          |
| Browser Run session ID            | `POST /devtools/browser` returns a `sessionId` and WebSocket URL. The ID is then used for tab management and `DELETE /devtools/browser/{sessionId}`; recording retrieval also uses it ([HTTP session management](https://developers.cloudflare.com/browser-run/cdp/session-management/), [session recording](https://developers.cloudflare.com/browser-run/features/session-recording/)).                                                                                                                                         | Persist the ID as `providerBrowserSessionId` immediately after acquisition. Do not confuse it with Scotty's session ID, the evidence run ID, a CDP target ID, or a page-scoped CDP `sessionId`.                                                                                                                                                                                                    |
| Closure                           | Explicit HTTP deletion returns `{ "status": "closing" }`, not a documented terminal receipt. `NormalClosure`, browser idle, crash, connection error, and eviction are distinct close outcomes; sessions may close unexpectedly ([HTTP session management](https://developers.cloudflare.com/browser-run/cdp/session-management/), [close reasons](https://developers.cloudflare.com/browser-run/reference/browser-close-reasons/)).                                                                                               | “Close requested” is not “closed.” Persist `close_pending`, then reconcile active sessions/history until the provider ID is terminal/absent. Any terminal reason proves resource closure; only `NormalClosure` proves an orderly success path.                                                                                                                                                     |
| Retries                           | Cloudflare demonstrates honoring `Retry-After` for 429s and retrying connection errors/evictions. It documents no idempotency key or exactly-once replay for session creation or browser actions ([limits](https://developers.cloudflare.com/browser-run/limits/), [close reasons](https://developers.cloudflare.com/browser-run/reference/browser-close-reasons/)).                                                                                                                                                              | Retry admission only at the provider's time and before Scotty deadlines. Never blindly replay a click, submit, or fill after an ambiguous transport result; reconcile its postcondition first.                                                                                                                                                                                                     |
| Quotas                            | Free defaults are 10 browser minutes/day, 3 concurrent sessions, and one new Browser Session per 20 seconds. Paid defaults are 120 concurrent sessions and one acquisition/second. Both default to 60 seconds idle, configurable to 10 minutes; releases may close live sessions. Kitesurf has no separate numerical quota table ([limits](https://developers.cloudflare.com/browser-run/limits/), [Kitesurf docs](https://developers.cloudflare.com/browser-run/kitesurf/)).                                                     | Treat quotas as account-wide provider admission, not a per-session promise. Read `Retry-After`/provider limit observations, apply stricter Scotty limits, and never keep a browser alive merely to reserve capacity.                                                                                                                                                                               |
| Live View                         | Live View is interactive for any Browser Session. `Cloudflare.getLiveView` can issue `tab`, `full`, or `devtools` links, defaulting to five minutes and capped at one hour ([Live View](https://developers.cloudflare.com/browser-run/features/live-view/)).                                                                                                                                                                                                                                                                      | A Live View URL is an ephemeral bearer capability. Return it only to an authenticated Scotty browser client with `Cache-Control: no-store`; never persist or log the URL/JWT.                                                                                                                                                                                                                      |
| HITL                              | Structured handoff uses `Cloudflare.getLiveView`, `Cloudflare.handoff`, and `Cloudflare.handoffComplete`; handoff timeouts may be set up to 30 minutes. Manual polling is also documented ([Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)).                                                                                                                                                                                                                                       | Always set a timeout no later than the evidence deadline and Scotty hard cap. Persist only handoff ID/state/instructions digest/expiry, not the Live View URL or sensitive human input. A hard cap or vaporize preempts the handoff. Kitesurf-specific HITL support remains a deployed proof gate because the generic page says “any Browser Session” but the Kitesurf page does not enumerate it. |
| Session recording                 | Recording is opt-in, finalized after session closure, retained 30 days, limited to 1 second–2 hours, unavailable for Quick Actions, and returned as per-target rrweb event arrays. Canvas pixels, cross-origin iframe contents, media playback, and WebGL are absent; inputs are masked ([session recording](https://developers.cloudflare.com/browser-run/features/session-recording/)).                                                                                                                                         | Call it **rrweb replay**, never video. Disable it while Scotty requires immediate evidence deletion on vaporize. An exported copy in Scotty R2 would not remove Cloudflare's retained copy.                                                                                                                                                                                                        |
| Provider data retention           | For normal CDP/Playwright/Quick Actions, Cloudflare says submitted/generated content is discarded after the rendering response; session recording is the 30-day exception ([Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/)).                                                                                                                                                                                                                                                                                | Scotty owns retained screenshot bytes only after private R2 commit. Keep provider recording off and close every Browser Session explicitly.                                                                                                                                                                                                                                                        |

## Current Scotty contracts to preserve

1. **The Sandbox DO is authoritative.** `SessionRecord` currently contains status, the single `operation`, hard-cap metadata, owned backup IDs/handles, and typed public failure data (`worker/src/contracts.ts:65-106`, `worker/src/contracts.ts:132-162`). The record and monotonic control revision are written together in a DO transaction (`worker/src/session-store.ts:22-23`, `worker/src/session-store.ts:186-198`). Evidence must join that authority; KV remains only the non-secret projection produced by `toProjection` (`worker/src/contracts.ts:193-214`, `worker/src/contracts.ts:663-683`).
2. **There is one mutation lease.** `SessionStore.acquireOperation` checks allowed status, rejects a live operation, and only lets vaporize replace an abandoned lease (`worker/src/session-store.ts:394-423`). Updates and release are nonce-checked (`worker/src/session-store.ts:283-307`). Evidence commands must use this lease for begin/commit; an idle remote browser is a subordinate resource, not a second authority.
3. **Create arms the hard cap before committing authority.** The initial record contains `hardCapAt`, the schedule is attempted first, and a schedule failure commits a typed failed record before runtime cleanup (`worker/src/session.ts:634-714`). Evidence cannot weaken this ordering or extend its own deadline past `hardCapAt`.
4. **Snapshot is a quiesced checkpoint.** The current path stops/quiesces Pi, runs `sync`, creates a 30-day backup, commits its handle, and only then resumes/release as appropriate (`worker/src/session.ts:1762-1857`). Manual snapshot acquires the global snapshot lease and restores Pi on success (`worker/src/session.ts:1917-1936`). A remote browser cannot be part of that filesystem backup.
5. **Hard cap wins.** Current enforcement rejects stale `hardCapAt` payloads, gives ordinary operations a 30-second grace, marks over-grace work failed, checkpoints, and stops/destroys runtime (`worker/src/session.ts:1180-1267`). The observation guard prevents a stale hard-cap callback from overwriting newer authority (`worker/src/session-lifecycle.ts:19-28`, `worker/src/session-store.ts:481-503`). Evidence adds provider cleanup; it does not add browser grace beyond the hard cap.
6. **Resume requires the current backup.** Resume acquires the lease, rejects a missing current backup, resets and schedules the hard cap before restore, restores credentials/runtime, and commits `warm`; failure commits recoverable `resume_failed` and destroys runtime (`worker/src/session.ts:868-933`). A pre-sleep Browser Run session must never be resumed as browser state.
7. **Vaporize is durable reconciliation.** It persists/reuses a `vaporize` lease, arms retry, destroys compute, deletes every owned backup, deletes credentials/idempotency state, commits `gone`, removes the projection, and cancels schedules (`worker/src/session.ts:945-1059`, `worker/src/session.ts:1143-1178`). Failures retain the lease and retry; tests exercise that behavior (`worker/test/session-down-vaporize.test.ts:161-217`, `worker/test/session-down-vaporize.test.ts:396-419`). Evidence closure and object deletion must happen before `gone`.
8. **Runtime stop has explicit commit semantics.** A committed managed stop becomes `sleeping`; an uncommitted stop becomes recoverably `failed` when a backup exists (`worker/src/session-store.ts:505-543`). Evidence cleanup must not manufacture sleeping/success from provider ambiguity.
9. **Container and backup storage are not evidence authority.** The container receives session-bound GitHub sentinels, not real credentials (`worker/src/container-auth.ts:278-299`). Its workspace is `/workspace/<id>` (`worker/src/workspace.ts:61-63`). The existing backup service is specifically directory-backup create/restore/delete (`worker/src/backup-store.ts:8-27`, `worker/src/backup-store.ts:50-88`) and the current R2 binding is `BACKUP_BUCKET` (`worker/src/bindings.ts:6-22`). Screenshot bytes need a separate artifact binding and manifest, not `ownedBackupIds`.
10. **The localhost transport already has an owner.** The Sandbox DO reaches a container port through `containerFetch(http://127.0.0.1:<port>)` (`worker/src/session.ts:299-304`), exposed in the domain as bounded port readiness/status operations (`worker/src/sandbox-runtime.ts:42-47`, `worker/src/sandbox-runtime.ts:65-94`, `worker/src/sandbox-runtime.ts:185-201`). Kitesurf cannot navigate that loopback address; a Worker-owned preview bridge must delegate to this transport.
11. **Browser authentication must stay isolated.** `/s/:id` and its wildcard require a registered browser cookie and reject root-token query handoff (`worker/src/index.ts:660-685`, `worker/src/index.ts:920-932`). Evidence review should reuse that authorization pattern. The preview capability used by Kitesurf is separate and never becomes a user cookie or URL token.
12. **Current deployed proof expects no orphans.** The deployed canary already covers up/Pi/snapshot/hard-cap/resume/down/vaporize (`e2e/tests/deployed.test.mjs:155-356`), and protocol tests prove hard-cap backup failure preserves recovery (`e2e/tests/protocol-security.test.mjs:472-493`). Kitesurf evidence must extend, not replace, that proof ladder.

## Target boundaries and call graph

```text
Pi agent in Sandbox
  -> bounded Scotty evidence tool
     (intent only; no CDP URL/token, Browser Run token, R2 credential, or Live View JWT)
  -> authenticated Worker/DO command
  -> Sandbox DO transaction: begin evidence operation + nonce + deadline
  -> Worker-side KitesurfClient
       -> Browser Run CDP endpoint ?browser=kitesurf
       -> remote Kitesurf Browser Session
       -> Worker evidence-preview origin
            -> digest-authenticated preview route
            -> Sandbox DO -> containerFetch(127.0.0.1:approved-port)
  -> Sandbox DO transaction: commit action/assertion/provider observation
  -> page.screenshot() bytes
  -> ArtifactStore.putVerified -> private ARTIFACT_BUCKET
  -> Sandbox DO transaction: commit immutable artifact manifest

Authenticated reviewer
  -> registered Scotty browser cookie
  -> /s/:id/evidence/... (proposed explicit route)
  -> Sandbox DO ownership/manifest check
  -> ArtifactStore.open -> no-store byte response

Lifecycle callback
  -> Sandbox DO acquires/preempts with snapshot | resume | vaporize | hard-cap authority
  -> close/reconcile Browser Run provider session
  -> delete/reconcile private artifacts when required
  -> continue existing checkpoint/restore/destroy transition
```

### Dependency direction

- `EvidenceWorkflow` is Effect domain code. It depends on `KitesurfClient`, `EvidenceStore`, `ArtifactStore`, `Clock`, and the existing session control authority.
- `KitesurfClient` is a Worker host adapter around the official CDP/Playwright client. It decodes all provider responses, exposes typed failures, preserves interruption, and never reaches the container.
- `ArtifactStore` is a Worker/DO-side R2 adapter with `put`, `head`, `open`, `delete`, and prefix/list reconciliation. The container never sees R2 credentials.
- `EvidencePreview` is a native Worker/Cloudflare adapter. It validates a digest-backed capability, session ID, method, path, and approved port before delegating to the existing Sandbox transport. It strips hop-by-hop, cookie, root-token, and provider-auth headers in both directions.
- The Pi package contains only a typed Scotty tool client. It is a future addition to the explicit `PI_PACKAGES` seam (`worker/src/container-auth.ts:8-18`); it is not `agent-browser` and does not speak CDP.

## Authoritative state

Use a separate schema-decoded DO value, `scotty:evidence:v1`, but read/write it in the **same DO transaction and control revision** as `scotty:session`. This keeps the existing public `SessionRecord`/KV projection bounded while making lifecycle and evidence changes atomic. Refactor the current record transaction boundary rather than issuing two independent puts.

```ts
type EvidenceState = {
  readonly version: 1;
  readonly sessionId: string;
  readonly nextRunSequence: number;
  readonly activeRun?: EvidenceRun;
  readonly artifacts: ReadonlyArray<EvidenceArtifact>;
  readonly ownedObjectKeys: ReadonlyArray<string>;
  readonly pendingDeletes: ReadonlyArray<PendingArtifactDelete>;
  readonly providerReconcile?: ProviderReconcile;
  readonly retainedBytes: number;
  readonly nextMaintenanceAt?: string;
};

type EvidenceRun = {
  readonly id: string; // Scotty evidence run ID
  readonly sequence: number;
  readonly phase:
    | "opening"
    | "open_unknown"
    | "ready"
    | "acting"
    | "action_unknown"
    | "handoff"
    | "closing"
    | "close_pending"
    | "closed"
    | "failed"
    | "expired";
  readonly operationNonce?: string; // same global SessionOperation nonce while a command is live
  readonly providerBrowserSessionId?: string;
  readonly providerTargetId?: string;
  readonly providerStartedAt?: string;
  readonly providerObservedAt?: string;
  readonly closeReason?: string;
  readonly closeReasonText?: string; // bounded/redacted
  readonly startedAt: string;
  readonly deadlineAt: string; // <= SessionRecord.hardCapAt
  readonly lastActionSequence: number;
  readonly pendingAction?: EvidenceActionAttempt;
  readonly handoff?: {
    readonly handoffId: string;
    readonly state: "requested" | "completed" | "failed" | "timed_out";
    readonly expiresAt: string;
    readonly instructionsDigest: string;
  };
  readonly failure?: EvidenceFailureRecord;
};

type EvidenceArtifact = {
  readonly id: string;
  readonly runId: string;
  readonly kind: "screenshot";
  readonly state: "putting" | "put_unknown" | "available" | "delete_pending" | "deleted" | "failed";
  readonly objectKey: string;
  readonly mediaType: "image/png";
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly availableAt?: string;
  readonly expiresAt: string;
  readonly assertionSequence: number;
  readonly failure?: EvidenceFailureRecord;
};
```

`EvidenceActionAttempt` stores the action kind, selector, sequence, precondition/postcondition specification, deadline, and a digest/redacted summary. It does not store secrets or raw human input. Sensitive entry belongs in bounded HITL; an automated fill containing sensitive data is non-retryable and must not be persisted.

A `SessionOperation.kind = "evidence"` is held only while one begin/provider-call/commit command is executing. Between commands, `activeRun.phase = "ready"` is durable but `SessionRecord.operation` is `null`, so snapshot, hard cap, or vaporize can acquire the single global lease and preempt the provider resource. There is never a second evidence mutation lease.

### Stored, derived, and deliberately unstored data

| Class               | Data                                                                                                                                              | Owner                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Authoritative       | Evidence phase, provider Browser Session ID, operation nonce, deadlines, assertion outcomes, hashes, object keys, pending close/delete/retry work | Sandbox DO                                                                               |
| Immutable bytes     | Validated PNG objects under deterministic keys                                                                                                    | Private artifact R2                                                                      |
| External resource   | Live Kitesurf process/tabs/cookies and provider close history                                                                                     | Browser Run; always treated as an observation that must be reconciled to DO intent       |
| Projection          | Bounded evidence summary, if later exposed                                                                                                        | Derived from DO; never in the existing KV list projection by default                     |
| Ephemeral secret    | Browser Run API token, preview capability plaintext, Live View URL/JWT                                                                            | Worker adapter/request memory only; DO stores preview digest and Live View metadata only |
| Deliberately absent | CDP WebSocket URL, Browser Run token, R2 credentials, user browser cookie, root token, raw HITL input                                             | Nowhere in container, DO record, KV, artifact metadata, logs, or Alchemy state           |

## Invariants

1. At most one active evidence run exists per Scotty session, and every mutation is nonce/revision checked under the global session operation lease.
2. `deadlineAt <= hardCapAt`; keepalive, retry, Live View, and HITL cannot extend either deadline.
3. `ready|acting|handoff|closing|close_pending` implies a persisted `providerBrowserSessionId`. `open_unknown` is the only state allowed after ambiguous acquisition without an ID.
4. `closed` requires provider terminal/absent observation. A close acknowledgement alone only permits `close_pending`.
5. An action is successful only after its explicit postcondition assertion commits. “No Playwright exception” and “screenshot exists” are insufficient.
6. A mutating action with an ambiguous response is never replayed until reconciliation proves its precondition still holds and its postcondition does not.
7. `available` requires a private R2 `head` observation matching key, byte length, SHA-256 metadata, media type, and session/run ownership.
8. R2 keys are immutable and deterministic: `evidence/v1/<session>/<run>/<artifact>/<sha256>.png`. A conflicting existing object is corruption, not overwrite permission.
9. Review bytes require a registered Scotty browser client on every request. No public bucket/domain, public presigned URL, root-token URL, or unguessable-URL authorization.
10. Browser Run recording is disabled. No state or UI calls an rrweb recording “video.”
11. Snapshot and resume never preserve/reconnect a provider browser. Available R2 artifacts may survive sleep until retention expiry.
12. Hard cap preempts actions/HITL and requests provider close before continuing runtime shutdown; failure to confirm close remains durable cleanup work.
13. Vaporize does not commit `gone` while any provider session, artifact object, preview capability, backup, credential, projection, or schedule is owned or ambiguously present.
14. Container files and process memory are never authoritative evidence storage. Screenshot bytes do not enter `/workspace/<id>` and therefore do not inflate or leak into directory backups.

## State transitions

### Evidence run

| Transition                      | Trigger and precondition                                                                   | Durable begin                                                                                        | External effect                                                    | Commit/recovery                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none -> opening`               | Warm Cloudflare session, no session operation, no active run, quota policy permits attempt | Acquire `evidence` lease; allocate run/attempt IDs; store deadline and provider-acquisition baseline | Acquire Kitesurf session with `browser=kitesurf`                   | Persist provider ID then `ready`; release lease. Rejected launch -> typed `failed`. Lost response -> `open_unknown` plus maintenance schedule.                                   |
| `open_unknown -> closing        | failed`                                                                                    | Reconciler owns the recorded attempt                                                                 | Persist reconciliation nonce and acquisition observation window    | List provider sessions/history through the installation-scoped adapter                                                                                                           | If exactly one safely attributable session is found, persist its ID and close it. If none is found after the provider idle window, fail closed. If attribution is not unique, retain typed ambiguous state; do not start another run or claim cleanup. |
| `ready -> acting`               | Agent submits next typed action and no lifecycle operation exists                          | Acquire lease; persist action sequence, redacted intent, pre/postconditions, and deadline            | Execute one bounded Playwright operation                           | Evaluate postcondition, commit assertion result, set `ready`, release.                                                                                                           |
| `acting -> action_unknown`      | Connection/eviction/timeout after dispatch and before a trusted result                     | Persist unknown result and release the command lease                                                 | Reconnect only to the same provider ID if it remains active        | Check postcondition first. If true, commit success. If false and precondition still holds, retry once only when action policy permits. Otherwise fail `EvidenceActionAmbiguous`. |
| `ready -> putting -> available` | A screenshot command's assertions have passed                                              | Persist deterministic artifact identity, expected limits, and `putting`                              | `page.screenshot()`, validate PNG/size/hash, `R2.put`, then `head` | Commit `available` only after exact `head`; ambiguous put becomes `put_unknown` and is reconciled by `head`.                                                                     |
| `ready -> handoff`              | Explicit user-visible request; Kitesurf HITL capability probe passed                       | Persist bounded instructions digest and expiry                                                       | Request `tab` Live View + structured handoff                       | Return URL once through authenticated no-store response; persist only handoff event/state. Timeout/failure closes or returns to ready by policy.                                 |
| `ready                          | acting                                                                                     | action_unknown                                                                                       | handoff -> closing`                                                | Explicit finish, snapshot, hard cap, retention, or vaporize                                                                                                                      | Acquire/preempt with the owning lifecycle lease; reject new actions; persist close intent                                                                                                                                                              | Close via the launch-owned API/HTTP DELETE | Persist `close_pending`; reconcile provider history/active sessions. Normal close allows successful `closed`; other terminal reasons produce `closed` plus typed run failure where appropriate. |
| `close_pending -> closed`       | Maintenance callback or lifecycle retry                                                    | Persist observation nonce                                                                            | Query active/history/session details                               | Terminal/absent observation commits `closed`, clears provider handle, and releases provider cleanup.                                                                             |
| `* -> expired`                  | Evidence deadline                                                                          | Same as lifecycle close                                                                              | Close provider                                                     | Preserve completed artifacts until their own expiry; no more actions.                                                                                                            |

### Why provider acquisition needs an attribution gate

Browser Run documents no client idempotency key. A Worker can be interrupted after the provider allocates a session but before Scotty stores the returned ID. Blindly listing account sessions and closing a “new” one could destroy another workload.

The Kitesurf adapter therefore needs an **installation-scoped serialized acquisition journal** (a tiny broker DO or equivalent strongly consistent gate) with a caller-supplied Scotty attempt ID. It serializes only Browser Run acquisition and records the before/after session inventory needed to attribute an ambiguous launch; the Sandbox DO remains authoritative for the Scotty evidence run and owns the resulting handle. This is not a second product lifecycle authority.

A deployed gate must prove that the official session-list API is scoped tightly enough to the Scotty Browser Run binding/installation to make that attribution unique. If that cannot be proved, persistent Browser Sessions fail the vaporize contract and the product must fall back to one-shot Kitesurf Quick Actions until Cloudflare exposes idempotent acquisition or tagged sessions. Do not paper over this gap with idle timeout.

## Begin / commit / reconcile rules

Every external Browser Run or R2 effect follows the same protocol:

1. **Begin:** atomically validate session status/global lease; write a new nonce, intent, expected prior state, deadline, and enough non-secret data to reconcile; increment the control revision.
2. **Effect:** perform exactly one provider/storage side effect outside the transaction.
3. **Commit:** atomically require the same nonce and expected state; decode/validate the result; write the provider ID, assertion result, hash, object observation, or terminal close observation; release the lease.
4. **Stale result:** never attach it to newer authority. Compensate using the returned provider ID/object key (close/delete), or persist reconciliation if compensation is ambiguous.
5. **Interruption/unknown result:** retain the durable intent, set an explicit `_unknown`/`_pending` state, and arm maintenance before returning failure. Never report success from an ambiguous provider or R2 state.

| Effect                        | Safe automatic retry?                                                        | Reconciliation                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Read/assert/list/history/head | Yes, bounded by command/hard-cap deadline                                    | Repeat and decode; stale nonce discards result.                                                                                    |
| Acquire Browser Session       | No blind retry                                                               | Installation acquisition journal + before/after inventory; otherwise `ProviderLaunchAmbiguous`.                                    |
| Navigate GET                  | Only if no page mutation contract and postcondition is false                 | Reconnect same provider ID; assert URL/DOM state.                                                                                  |
| Click/press/submit/fill       | No                                                                           | Check explicit postcondition, then precondition; retry once only for declared idempotent actions. Sensitive fill is never retried. |
| Screenshot capture            | Yes if the run/page is still the same and assertion sequence has not changed | Re-capture if no object exists; object identity includes bytes hash.                                                               |
| R2 put                        | Same deterministic key only                                                  | `head` and compare size/hash/ownership metadata. Mismatch is corruption.                                                           |
| Provider close                | Yes                                                                          | Query active sessions/history until terminal/absent; preserve `close_pending`.                                                     |
| R2 delete                     | Yes                                                                          | `head`/list until absent; preserve `delete_pending`.                                                                               |

## Typed failures

Use internal `Schema.TaggedErrorClass`/`Data.TaggedError` values and store a bounded `EvidenceFailureRecord { code, message, retryClass, observedAt }`. Map them at the existing HTTP boundary to today's `wrong_state`, `conflict`, `upstream`, or `internal` envelopes; do not change public routes/error shapes incidentally. `SessionFailure.code` is already an internal string while public API codes remain the closed set in `worker/src/contracts.ts:101-106` and `worker/src/contracts.ts:382-455`.

| Failure                                        | Meaning                                                                   | Retry class                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `EvidenceWrongState` / `EvidenceLeaseConflict` | Session/run/nonce/revision no longer permits the command                  | Never automatically; caller refreshes.                                            |
| `KitesurfCapabilityUnsupported`                | Required CDP/action/HITL behavior failed the Kitesurf capability contract | Never on the same deployment/version.                                             |
| `ProviderAdmissionLimited`                     | 429, acquisition rate, concurrency, or daily quota                        | At provider `Retry-After`/observed acquisition time, only before deadlines.       |
| `ProviderLaunchRejected`                       | Provider proved no session was created                                    | Policy-bounded retry.                                                             |
| `ProviderLaunchAmbiguous`                      | Acquisition may have created an unattributed session                      | Reconcile only; block further acquisition and vaporize success.                   |
| `ProviderSessionLost`                          | Idle, eviction, crash, or connection closure                              | Reconnect same ID if active; otherwise fail run. Do not replay mutations blindly. |
| `ProviderClosePending`                         | Close requested but terminal absence is unproved                          | Maintenance/vaporize reconciliation.                                              |
| `EvidencePreconditionFailed`                   | Action was not safe to dispatch                                           | Never; report assertion detail.                                                   |
| `EvidenceAssertionFailed`                      | Functional postcondition failed                                           | Never by default; agent may choose a new action.                                  |
| `EvidenceActionAmbiguous`                      | Mutating action result cannot be classified                               | Reconcile; no automatic replay.                                                   |
| `EvidenceDeadlineExceeded`                     | Action/run/HITL exceeded bounded time                                     | Close provider; no action retry.                                                  |
| `EvidenceHandoffFailed`                        | Human marked failed, timed out, or provider ended                         | Policy decision; close by default in the first HITL slice.                        |
| `ScreenshotInvalid` / `ArtifactTooLarge`       | Bytes are not an allowed bounded PNG                                      | Never for those bytes.                                                            |
| `ArtifactPutUnknown`                           | R2 put result is ambiguous                                                | `head` deterministic key.                                                         |
| `ArtifactCorrupt`                              | Existing object's metadata differs from expected                          | Never overwrite; operator-visible failure.                                        |
| `ArtifactDeletePending`                        | R2 absence is unproved                                                    | Retry/reconcile; blocks vaporize `gone`.                                          |

Logs contain only Scotty session/run/artifact IDs, error tag, bounded provider close reason, attempt count, durations, and byte counts. They exclude URLs with query strings, selectors marked sensitive, page text, headers, cookies, preview tokens, Live View URLs, CDP endpoints, and provider/API errors that may echo credentials.

## Functional action and assertion contract

Initial agent-facing operations:

- `start({ approvedPort, startPath, viewport })`
- `navigate({ path, expectedUrlPath })`
- `click({ selector, precondition, postcondition })`
- `fill({ selector, value, sensitive: false, postcondition })`
- `press({ selector, key, postcondition })`
- `assert({ visible | text | count | urlPath })`
- `screenshot({ name, fullPage: false })`
- `finish()`

Selectors and assertions are bounded strings decoded at the HTTP/tool boundary. Navigation accepts an approved preview-relative path, never an arbitrary URL. The Worker constructs the preview origin and sets a capability header itself. The first slice should support test IDs/CSS only; role/text locators can be added after Kitesurf proof. Arbitrary `evaluate`, arbitrary CDP, file upload/download, popups, multiple tabs, raw cookies, request interception, and external navigation are out of scope.

Each mutating action requires a machine-readable postcondition, recorded before dispatch. Assertion results include kind, expected digest/bounded public value, actual digest/bounded public value, duration, and action sequence. A screenshot references the last successful assertion sequence so reviewers can tell what functional claim it accompanies.

## Preview and credential isolation

A remote Kitesurf session cannot reach the Sandbox's `127.0.0.1`. Add a Worker-owned evidence preview route that:

1. accepts only a random, run-scoped capability in a dedicated header;
2. stores only the capability digest in the Sandbox DO;
3. checks warm status, active evidence run, approved port, method, path, deadline, and provider run state;
4. delegates to the existing DO `containerFetch` transport;
5. strips `Authorization`, cookies, Scotty root/client credentials, Browser Run headers, hop-by-hop headers, and unsafe response headers;
6. applies `Cache-Control: no-store`, strict CSP, and a response byte/time limit; and
7. is revoked before provider close during snapshot, hard cap, expiry, or vaporize.

The capability is not a user credential and never appears in a URL, page DOM, screenshot manifest, logs, container env/files, or R2 metadata. Browser Run authority stays in the Worker adapter. Real Codex/GitHub credentials remain excluded exactly as the current sentinel environment requires.

Kitesurf can otherwise fetch subresources directly from the public Internet, bypassing the Sandbox's current host allowlist. The adapter must reject requests outside the preview origin (and any separately approved immutable asset origins) using a capability-tested interception mechanism. If Kitesurf's CDP subset cannot enforce that egress policy, the preview must rewrite/proxy every subresource through the Worker; broad Internet navigation is not an acceptable fallback.

## Screenshot artifacts, privacy, retention, and deletion

Create a dedicated private `ARTIFACT_BUCKET`; do not reuse `BACKUP_BUCKET`. The current Alchemy stack creates one retained backup R2 bucket and binds only that bucket (`infra/cloudflare-stack.ts:16-78`, `infra/cloudflare-stack.ts:133-139`, `infra/cloudflare-stack.ts:167-186`). The artifact resource must follow the same installation-owned Alchemy model but have its own binding, store, contract tests, deletion path, and uninstall policy.

Initial policy:

- PNG only, fixed viewport, one screenshot per run, 10 MiB maximum.
- One active run per Scotty session and one installation-wide acquisition at a time in the first slice.
- Five-minute run deadline, always reduced to remaining hard-cap time.
- Seven-day artifact retention by default, configurable only by installation policy—not by the agent.
- Per-session retained-byte accounting in DO authority; reject before upload when quota is exhausted.
- Immutable, content-addressed object keys and exact owner/hash/size metadata.
- No public R2 domain or public bucket. Authenticated Worker streaming uses `Content-Type: image/png`, `Content-Disposition`, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`.
- Expiry transitions `available -> delete_pending`; only confirmed R2 absence commits `deleted` and releases retained bytes.
- Snapshot/sleep do not reset retention. Resume does not extend it. Vaporize ignores the normal retention date and deletes immediately.
- Installation uninstall should retain artifact data by default, matching current backup/KV retention, and include it in explicit `--delete-data`; this is a future CLI/deployment contract change, not part of the first runtime slice.

## Live View and HITL

Live View is a review/control channel to the provider browser, not a Scotty artifact and not durable session state.

- Issue it only from an authenticated owner/client review route after the DO confirms `activeRun.phase` and target ownership.
- Request `mode: "tab"` for HITL, with `expiresInMs` bounded to five minutes initially. Do not expose full DevTools to ordinary clients.
- Return the URL once with `no-store`; do not put it in KV, R2, logs, session projection, CLI JSON, or the DO record.
- Use structured `Cloudflare.handoff` only after a deployed Kitesurf capability test. Subscribe before requesting handoff, persist the returned handoff ID and deadline, and reconcile with `Cloudflare.getHandoffState` after disconnect/eviction.
- While `handoff`, automated actions are rejected. Snapshot, hard cap, retention expiry, and vaporize revoke preview authority and close the provider without waiting for the human.
- Human-entered secrets remain provider-side and may still affect page/network state. Input masking in rrweb is not a security boundary; recording remains disabled.

## rrweb replay versus true video

Scotty must present three distinct concepts:

1. **Screenshot:** actual PNG pixels at one point, privately retained by Scotty.
2. **Browser Run recording:** rrweb DOM/input/navigation event arrays retained by Cloudflare for 30 days; useful for replay but missing canvas pixels, cross-origin frames, media, WebGL, and unmasked input values. This is not video.
3. **True video:** a pixel-time media file such as WebM. Browser Run Playwright video is currently not fully supported, and Kitesurf itself cannot provide the missing video/WebGL fidelity.

The Kitesurf-first backend ships only (1). It may expose neither (2) nor (3) until there is an explicit retention/deletion contract. If true video becomes a requirement, it is a separate backend decision, not a renamed rrweb feature or a screenshot slideshow.

## Quota, retry, and closure policy

- Query provider limit/session observations before acquisition where available, but treat the acquisition response as final authority because quotas are account-wide and racy.
- Map 429 and `Retry-After` to `ProviderAdmissionLimited`. Schedule one retry only if it falls before run and hard-cap deadlines. Do not busy-wait in a Worker request.
- Do not encode free/paid limits as correctness assumptions; they are planning defaults. Scotty's first installation gate is stricter than either plan.
- Use a short keepalive only for a live command/HITL. Never send synthetic commands merely to defeat idle closure after Scotty has no active work.
- Capture `providerBrowserSessionId` before any action and before close. A launched Playwright browser must be closed, not merely disconnected; Cloudflare documents that close-after-connect can only disconnect while close-after-launch closes the provider session.
- After close request, reconcile until active-session absence or terminal history. Persist the raw bounded close reason for diagnosis and map it to orderly, idle, evicted, crashed, connection, or unknown.
- Provider idle/eviction can prove cleanup but cannot retroactively turn an uncommitted action or artifact into success.

## Scotty lifecycle integration

### Snapshot and managed sleep

A provider browser is external, mutable, and absent from the directory backup. Snapshot therefore uses this order under the existing `snapshot` lease:

1. reject new evidence commands and revoke the preview capability;
2. request provider close and reconcile it to terminal/absent;
3. if closure remains ambiguous, retain `close_pending`, arm maintenance, fail the manual snapshot, and leave the session warm—do not claim a self-consistent checkpoint;
4. once closed, run the existing Pi quiesce/stop, `sync`, backup commit, prior-backup deletion, and Pi restore/managed stop sequence; and
5. retain only already-available private artifacts and their original expiry.

Idle managed sleep follows the same order. An rrweb recording is not expected because recording is disabled. Screenshot bytes never enter the backed-up workspace.

### Hard cap

The hard cap preempts evidence immediately. Unlike ordinary operations in the current 30-second grace branch, `operation.kind === "evidence"` is marked interrupted and handed to hard-cap cleanup without allowing the browser command to extend the cap.

1. atomically revoke preview/HITL, mark pending action `EvidenceDeadlineExceeded`, and persist provider close intent;
2. make a bounded close request, but do not let provider confirmation delay Pi checkpoint/destruction beyond the existing hard-cap shutdown budget;
3. persist `close_pending` and arm provider reconciliation if terminal proof is unavailable;
4. continue current checkpoint/stop; on backup failure, preserve the last current backup and record recoverability exactly as today; and
5. keep the DO/schedule alive until remote provider cleanup is confirmed, even after the container is destroyed.

A hard-capped session may be `sleeping` or recoverably `failed` while evidence cleanup is pending. Public success must not imply the provider is closed; resume is blocked until reconciliation completes.

### Resume

Resume first reconciles any pre-sleep evidence state under the `resume` lease:

1. require a current backup as today;
2. require no open/unknown provider session and no live preview/HITL capability;
3. if closure cannot be proved, release/retain retry state and leave the session sleeping/failed—do not restore compute;
4. schedule the new hard cap, restore the current backup, reseed sentinels/runtime, and commit warm using the existing order; and
5. retain available artifacts without extending expiry. A new evidence run always acquires a new Kitesurf Browser Session and clean context.

### Vaporize

Extend current durable vaporize ordering to:

1. acquire/reuse the durable `vaporize` lease and arm retry **before** cleanup;
2. revoke preview/HITL and close/reconcile every known or ambiguous provider acquisition;
3. delete every DO-owned artifact key and reconcile exact absence;
4. destroy Sandbox/runner compute;
5. delete backups, credentials, create idempotency, and any acquisition-journal ownership;
6. commit the `gone` tombstone with empty evidence/backups/credentials;
7. remove KV projection and cancel all schedules.

Any failure keeps the vaporize lease and retry state. A provider `status: closing`, R2 delete acknowledgement, expired Live View URL, or expected idle timeout is not enough to write `gone`. Because Browser Run offers no documented early deletion for rrweb recordings, enabling recording is incompatible with this transition.

### Maintenance scheduling

Add one persisted evidence maintenance callback to the existing schedule registry (`worker/src/session-lifecycle.ts:3-12`). It wakes at the earliest provider-close retry, acquisition reconciliation, artifact expiry, or delete retry. Vaporize cancels ordinary evidence schedules only after taking ownership, then uses its own retry callback. Gone repair rechecks provider journal and artifact prefix absence before removing the final retry.

## Minimal first vertical slice

Build one narrow deployed canary; do not start with the agent tool, HITL, rrweb, true video, arbitrary repository apps, or the localhost preview bridge.

### Slice

1. Add the Worker-side Kitesurf CDP adapter with explicit `browser=kitesurf`, typed acquire/close/history/limits failures, and an inherited Worker-only secret reference. Prove no browser executable/process is added to the container.
2. Add DO `EvidenceState`, atomic begin/commit/reconcile storage, `SessionOperation.kind = "evidence"`, and one maintenance callback.
3. Add a private artifact R2 bucket/store and one authenticated PNG retrieval route. The test target is a deterministic, disposable-stack-only Scotty canary page reachable from Browser Run without user/Codex/GitHub credentials.
4. Execute one fixed workflow: navigate, fill one non-sensitive value, click, assert exact text/count, capture one PNG, hash/upload/head-verify, close Kitesurf, and reconcile `NormalClosure`/absence.
5. Retrieve the PNG through an authenticated Scotty browser client and verify bytes/hash. Unauthenticated, root-query, and direct-R2 access must fail.
6. Vaporize the owning Scotty session and prove provider session absence, artifact absence, empty ownership state, projection removal, and no retry schedule orphan.

### Acceptance proof

- A deployed capability test proves Kitesurf supports every used locator/assertion/screenshot/close/history call; unsupported CDP fails red as `KitesurfCapabilityUnsupported`.
- The assertion fails red when the canary text is wrong even if a valid PNG exists.
- The PNG has valid magic bytes, declared size, matching SHA-256, and exact private R2 metadata.
- Injected interruption after provider acquisition, after action dispatch, after R2 put, and after close request yields a durable `_unknown`/`_pending` state and successful reconciliation—never false success.
- 429 honors `Retry-After`; no retry crosses run/hard-cap deadline.
- Vaporize remains non-gone through injected provider-close and R2-delete ambiguity, then completes on retry.
- `node e2e/scripts/scan.mjs` and artifact/log scans find no Browser Run token, preview capability, Live View URL, browser cookie, root token, or real provider credential.
- Container image/toolset tests continue to show no `agent-browser` and add an explicit no-Chromium-process/image assertion (the existing toolset test already excludes `agent-browser` at `cli/test/cli.test.ts:2292-2310`).

### Explicitly deferred

- Sandbox localhost preview proxy and repository-provided start/port manifests.
- Agent-facing Pi package and open-ended action planning.
- Live View/HITL.
- rrweb recording and true video.
- Multiple tabs, session reuse across evidence runs, shared browser pools, arbitrary external origins, and pixel regression.
- Snapshot/hard-cap/resume interruption in the deployed canary. Their state-machine/fake-adapter tests land with the state model; deployed lifecycle proof is the next vertical slice before evidence is generally available.

## Proof ladder after the first slice

1. **Pure/domain:** schema decoding, transition legality, nonce/revision races, action ambiguity, quota timing with `TestClock`, closure classification, retention accounting.
2. **Adapter contract:** fake and production-shaped `KitesurfClient`/`ArtifactStore` suites for malformed provider data, 429, eviction, unknown launch/close, corrupt PNG, unknown put/delete, and exact-key reconciliation.
3. **Remote Kitesurf capability:** deployed fixed page exercises each allowed action/assertion, screenshot bytes, Live View/HITL when later enabled, and forbidden-CDP behavior.
4. **Local fake lifecycle:** snapshot/hard-cap/resume/vaporize transition tests extend current lifecycle coverage (`worker/test/session-lifecycle-machine.test.ts:262-342`, `worker/test/session-resume.test.ts:42-134`, `worker/test/session-down-vaporize.test.ts:161-419`).
5. **Disposable deployed canary:** real Alchemy Worker/Sandbox DO/Container/KV/private artifact R2/Browser Run; force interruption at every begin/effect/commit seam and finish with the existing no-orphans probe.

## Open proof gates, not design ambiguities

- Verify the exact Worker-compatible Playwright/CDP package and Kitesurf selector against Scotty's pinned runtime. Official docs guarantee the endpoint query, not a binding launch option.
- Prove provider session listing is scoped enough for unique ambiguous-acquisition attribution. If not, persistent sessions cannot meet strict vaporize.
- Prove the Kitesurf CDP subset supports request interception needed for preview-origin-only egress. Otherwise implement a complete Worker proxy before repository apps.
- Prove generic Live View/HITL commands on Kitesurf specifically before exposing them.
- Decide the exact authenticated evidence review route as an explicit public HTTP contract addition; preserve all existing routes and CLI JSON meanwhile.
- Validate seven-day/10-MiB policy and installation uninstall behavior before making it configurable.

## Official sources

- [Cloudflare Browser Run: Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)
- [Cloudflare Browser Run: Playwright](https://developers.cloudflare.com/browser-run/playwright/)
- [Cloudflare Browser Run: session management over HTTP](https://developers.cloudflare.com/browser-run/cdp/session-management/)
- [Cloudflare Browser Run: screenshot endpoint](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
- [Cloudflare Browser Run: snapshot endpoint](https://developers.cloudflare.com/browser-run/quick-actions/snapshot/)
- [Cloudflare Browser Run: Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
- [Cloudflare Browser Run: Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
- [Cloudflare Browser Run: session recording](https://developers.cloudflare.com/browser-run/features/session-recording/)
- [Cloudflare Browser Run: limits](https://developers.cloudflare.com/browser-run/limits/)
- [Cloudflare Browser Run: browser close reasons](https://developers.cloudflare.com/browser-run/reference/browser-close-reasons/)
- [Cloudflare Browser Run: reuse sessions](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)
- [Cloudflare Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/)
