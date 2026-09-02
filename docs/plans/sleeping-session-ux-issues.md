# Sleeping session UX issue log

> Status: Implemented and locally verified; deployment proof pending review and merge.
>
> Lane: `sleeping-session-ux`
>
> Base commit: `544f6546702d394db6303af6cbb4079bc182f731`
>
> Live target: installation `baseline`, Worker `scotty-baseline-worker`, script version
> `f6ce43e8-d732-41f2-a42c-d53680df16af`
>
> Observation window: 2026-09-02 17:04-17:08 UTC

This log records bounded, redacted evidence. Actor authority is lifecycle truth. KV is a
non-secret list projection and must converge to actor authority; the UI must not infer lifecycle
state from the hard-cap timer.

## SLEEP-001: reconciled sleep does not refresh the list projection

- Status: resolved in lane
- Severity: P1
- Symptom: the sessions rail shows a green active signal and `Session limit reached` or a future
  `Auto-stop` countdown, but selecting the session returns to `/sessions`.
- Public proof:
  - `scotty list --json` reported `0aabf3a6883f` and `96166b6e4982` as `warm`.
  - `scotty inspect ID --json` rejected both with `wrong_state`.
  - A direct `GET /s/0aabf3a6883f` returned HTTP 302 to `/sessions` in the Worker tail.
- Authority proof:
  - `0aabf3a6883f` is actor revision 53, `Stable(Sleeping)`, with a confirmed backup; its journal
    tail is `runtime_observed` / `runtime_stopped_callback` at 2026-09-02T02:01:15.056Z.
  - `96166b6e4982` is actor revision 16, `Stable(Sleeping)`, with a confirmed backup; its journal
    tail is `runtime_observed` / `runtime_stopped_callback` at 2026-09-02T15:19:05.040Z.
- First divergence: `actorLifecycleProgram` publishes KV only after a synchronous terminal result.
  A reconciling result exits before publication, and `enqueueRuntimeLifecycleObservation` later
  commits the callback decision without publishing the new actor-derived projection.
- Required invariant: after an accepted actor decision changes the public view, publication must
  eventually make KV equal to the current actor-derived projection. Retried/stale callbacks must
  not regress a newer projection.
- Resolution: actor deadlines, hard-cap decisions, and runtime lifecycle callbacks now publish a
  best-effort projection by rereading current actor authority. Publication derives from current
  authority rather than directly from the triggering callback. An authoritative point read also
  republishes its actor-derived projection, so opening either already-stale session repairs its KV
  row before the browser follows the focused-session redirect. Durable retry and monotonic ordering
  between concurrent publications remain follow-up projection contracts; this incident fix does
  not claim them.
- Local proof: lifecycle tests assert `projection:failed` after hard-cap and unexpected-stop
  decisions, `projection:sleeping` after activity-expiry callback settlement, and a fresh sleeping
  projection after the actor's public point read.

## SLEEP-002: sleeping session links lose session context

- Status: resolved in lane
- Severity: P1
- Symptom: selecting a sleeping session appears to do nothing and leaves an empty sessions page.
- Direct evidence: `serveScottySessionPage` redirects every non-warm session to `/sessions` without
  the session ID. The sessions page already supports `/sessions?focus=ID` and renders lifecycle
  controls, including `Resume & open`, when that focused projection exists.
- Required behavior: a sleeping or recoverable failed session link must land on its focused
  management surface with clear status, backup readiness, and the primary resume action.
- Resolution: non-warm and runner session page routes redirect to `/sessions?focus=ID`. The focused
  surface clearly labels Sleeping, explains checkpoint readiness, offers `Resume & open` only when
  a usable backup exists, and opens the focused workspace on mobile.
- Local proof: route, presentation, action-availability, and mobile-layout tests pass. The local UI
  preview served the new state, but the collaborative preview bridge timed out while snapshotting
  both the page and a plain local 404, so this lane does not claim screenshot/browser proof.

## SLEEP-003: missing actor authority leaks a raw JSON document into browser navigation

- Status: resolved in lane
- Severity: P1
- Symptom: opening `/s/31b96cb22596` displayed
  `{\"error\":{\"code\":\"not_found\",\"message\":\"Session unknown was not found\"}}` as the
  entire page.
- Authority proof: authenticated actor diagnostics returned HTTP 404 with
  `Session unknown was not found`; no actor authority exists for that ID.
- First divergence: `/s/:id` is a browser page route, but an actor lookup failure escapes through
  the API JSON error envelope instead of resolving to an authenticated HTML recovery surface.
- Required behavior: browser navigation must preserve the public API error envelope for API
  callers while rendering a clear unavailable/deleted-session state with a route back to sessions.
- Resolution: `/s/:id` converts only actor `not_found` failures into
  `/sessions?unavailable=ID`. The explicit unavailable marker wins over stale list data and renders
  a human HTML recovery state with a route back to all sessions. API error envelopes are unchanged.
- Local proof: integration tests assert the missing-actor redirect separately from non-warm focus;
  sessions-page tests validate the unavailable query boundary and stale-row precedence.

## Verification

- `npm run fmt`
- `npm run lint`
- `npm run typecheck`
- `npx vitest run worker/test/session/session-actor-lifecycle.test.ts worker/test/integration/routes.test.ts worker/test/public/sessions/sessions-page.test.ts` — 112 passed
- `npm run test:all` — passed
- `npm run test:ui-preview` — 2 passed
- `node e2e/scripts/scan.mjs` — 16,227 files scanned; no configured secrets found
- `bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli-sleeping-session-ux` — passed

## Evidence limits

- The repository does not contain the skill-documented `scripts/capture-actor.mjs` at the base
  commit. Actor diagnostics were therefore read from the authenticated
  `GET /api/sessions/:id/actor` endpoint and reduced to authority, revision, and journal fields.
- The bounded Worker tail was observation only. It confirmed request/response statuses but does
  not override actor authority.
- No session, credential, deployment, or provider resource was mutated during diagnosis.
- Local dependency installation warned that Node 24.1.0 is below the repository's declared
  `^24.15.0` engine. All recorded checks still passed on that host version.
