# TanStack Start UI state and proof contract

Status: rebuild acceptance specification. The existing Worker APIs and Sandbox Durable Object
remain authoritative. React, TanStack Start, TanStack Router, and StyleX own presentation and
navigation only.

## 1. State ownership

| Layer | Owner | May decide | Must not decide |
| --- | --- | --- | --- |
| Session authority | Session Sandbox Durable Object | Stable state, active transition/lease, lifecycle action admission, backup/runtime proofs | Rail ordering or visual selection |
| Session projection | KV list projection | Fast repository/session listing from the last successful publication | Whether an action is currently legal |
| Selected-session read | Actor-derived session view | Current detail state and available actions | Whether the URL is selected |
| URL | TanStack Router | Selected session and surface | Lifecycle state |
| React query/cache | Browser memory | Pending, last successful response, refetch and cancellation | A new domain state |
| Display state | React components | Labels, skeletons, progress, recoverable error affordances | Fabricating `warm`, `sleeping`, `failed`, or success |

The route is the selection contract:

- `/sessions` shows the home/list surface.
- `/s/$sessionId` opens the conversation, even when it is sleeping, failed, transitioning, or
  gone. The conversation shell then explains which content and actions are available.
- A `focus` search parameter may scroll/highlight a rail row, but it is never a substitute for
  `/s/$sessionId` and never claims that the conversation is open.
- Every session row remains a real link. Router enhancement may intercept a successful click,
  but a rerender, disclosure toggle, pending request, or stale projection must not swallow native
  navigation.

## 2. Authoritative and displayed states

Actor authority is one of:

```text
Absent
  -> Transitioning(Create)
  -> Stable(Warm | Failed)

Stable(Warm)
  -> Transitioning(Checkpoint | Sleep | WarmWork | Vaporize)
Stable(Sleeping)
  -> Transitioning(Resume | Vaporize)
Stable(Failed)
  -> Transitioning(Resume | Vaporize), when actionable
Stable(Gone)
  -> terminal

Transitioning(WarmWork)
  kind = Evidence | Hatch | Down | ManualCheckpoint | RuntimePreparation
Every transition is either executing or reconciling and retains its lease until terminal.
```

The UI presents stable state and operation state separately. It must not collapse a transition
back into its origin label without also showing the active operation.

| Actor authority | Rail label | Conversation shell | Actions |
| --- | --- | --- | --- |
| no selected read yet | Last projected label, marked stale if applicable | Skeleton; preserve prior route content only as visibly stale | None |
| `Transitioning(Create)` | Creating | Setup progress | None |
| `Stable(Warm)` | Ready, plus fresh agent activity | Conversation and composer | Checkpoint, Sleep, Work, Vaporize |
| `Transitioning(Checkpoint)` | Saving | Read-only conversation with saving progress | None |
| `Transitioning(Sleep)` | Going to sleep | Read-only conversation with exact phase | None |
| `Stable(Sleeping)` | Sleeping | Retained conversation; Resume is primary | Resume, Vaporize |
| `Transitioning(Resume)` | Waking | Retained conversation with exact phase | None |
| `Transitioning(WarmWork)` | Ready + Evidence/Hatch/etc. progress | Conversation remains visible; affected panel shows progress | None for conflicting lifecycle actions |
| `Stable(Failed)`, actionable | Needs attention | Failure code, retained content, recovery explanation | Resume, Vaporize |
| `Stable(Failed)`, not actionable | Failed | Failure code and retained-content boundary | Vaporize |
| `Transitioning(Vaporize)` | Vaporizing | Destructive progress; no optimistic disappearance | None |
| `Stable(Gone)` | Archived/Gone only when product policy retains a tombstone | Terminal explanation; no runtime content fetch | None |

`booting`, `warm`, `sleeping`, `failed`, and `gone` are public projection labels. `deleting` and
`operation { kind, mode, phase }` are independent fields. Agent `working`, `waiting`, `completed`,
and `tool-stalled` are expiring activity observations, not session lifecycle states.

StyleX state rules must derive from semantic attributes (`aria-current`, `aria-busy`,
`data-session-state`, `data-operation`) rather than DOM position. Motion is interruptible,
specific to `opacity`/`transform`, and never the only state signal. Dynamic timers use tabular
figures. Controls have at least a 40px desktop and 44px compact hit area.

## 3. Actions, leases, and 409 behavior

| Intent | Valid authority | Pending presentation | Terminal success | 409 handling |
| --- | --- | --- | --- | --- |
| Open conversation | Any known session/tombstone | Route skeleton, cancellable old fetch | Selected route renders | Navigation never fails because of a lease; a content subrequest may be unavailable |
| Checkpoint | Stable Warm | Saving, phase if known | Stable Warm with confirmed backup | Refetch actor view; show the active operation or changed state inline |
| Sleep | Stable Warm | Going to sleep | Stable Sleeping with confirmed backup and observed stop | Same; never turn the whole conversation into an error card |
| Resume | Stable Sleeping or actionable Failed | Waking, phase if known | Stable Warm with fresh readiness proof | Refetch; if resume is already executing, attach to progress instead of retry-spamming |
| Evidence/Hatch work | Stable Warm, no conflicting lease | Panel-local progress | Stable Warm plus authoritative feature state | Refetch; distinguish busy lease, stale runtime, and invalid state |
| Vaporize | Warm, Sleeping, or Failed | Vaporizing until absence is confirmed | Stable Gone/removed projection | Retry only from retained actor operation; never infer success from a missing runtime alone |

Expected 409s are typed concurrency or state results, not generic failures:

1. Cancel obsolete reads when the route changes. Responses for session A can never replace the
   screen for session B.
2. On `conflict`, refetch the selected actor-derived view once and render its active operation.
3. On `wrong_state`, refetch once, remove the now-invalid action, and explain the new state.
4. A Pi snapshot/stream 409 means conversation runtime content is temporarily unavailable while
   the session is not stably warm. Keep the route, metadata, retained transcript, and lifecycle
   controls. Retry with bounded backoff only while actor authority says the condition can settle.
5. Never run parallel retries for the same query or mutation. Mutation buttons share one
   session-scoped pending owner.
6. A deadline or reconnect must resume/reconcile the actor-owned operation; browser polling may
   observe progress but does not drive correctness.

## 4. Deterministic seed catalogue

Every fixture has a fixed clock, stable IDs, deterministic text, and explicit actor authority,
projection timestamp, transcript, feature state, and expected actions. Include an intentionally
stale projection where specified.

| Fixture ID | Required data and purpose |
| --- | --- |
| `empty-installation` | No repositories or sessions; create-session affordance and empty guidance |
| `many-sessions` | 4 repositories, 60 sessions, long/duplicate titles, all lifecycle labels, archived section, keyboard and scroll retention |
| `warm-idle` | Stable Warm, no activity, short conversation |
| `warm-working` | Stable Warm with unexpired working proof and active streaming turn |
| `sleeping-retained` | Stable Sleeping, confirmed backup, full retained conversation, Resume primary |
| `failed-recoverable` | Actionable Failed from Warm and retained backup |
| `failed-terminal` | Non-actionable Failed, no wake source |
| `transition-create` | Every Create phase, executing and reconciling variants |
| `transition-sleep` | Every Sleep phase with retained transcript |
| `transition-resume` | Every Resume phase, including slow restore |
| `transition-vaporize` | Every cleanup phase, including Hatch/Evidence cleanup pending |
| `projection-stale` | Rail says Warm while actor says Sleeping; selected read must correct detail and then rail |
| `runtime-missing` | Actor projection says Warm but current runtime readiness/content probe is unavailable; no false-ready composer |
| `gone-deep-link` | Direct `/s/:id` load for a retained tombstone and for a truly unknown ID |
| `long-chat` | 200 turns; very long prose/code/table/URL content; first/middle/latest anchors; virtualized scroll and return-position proof |
| `streaming-text` | Character and chunk deltas, markdown split across chunks, reconnect with `Last-Event-ID`, completion and interruption |
| `tool-calls` | Queued/running/success/error/interrupted calls, large bounded result, repeated tool-call IDs on replay |
| `questions` | Single choice, multi-choice, free text, confirmation, answered, cancelled, and stale question after route switch |
| `hatch-matrix` | Starting, running+exposed, sleeping, unhealthy, stopped, failed, stale runtime epoch, permit denied, cleanup pending |
| `evidence-matrix` | Recording, complete passing/failing, interrupted, expired, missing bytes, invalid provenance, cross-session reference, video disabled/enabled |

Hatch and Evidence are separate state machines. Evidence remains readable while Hatch is stopped.
An Evidence reference is displayed only when stored bytes and same-conversation provenance both
validate. A syntactically valid but unproven reference is explicitly **Unavailable: provenance**,
not a generic unavailable state. Hatch UI separately reports desired status, observed status,
exposure, runtime epoch freshness, health, and whether a retry is legal.

## 5. Browser comparison and proof matrix

Run each row against both the current UI and rebuild with identical seeds, viewport, clock, and
interaction script. Current failures are expected evidence, not acceptance exceptions.

| Surface | Fixtures | Required interactions | Proof |
| --- | --- | --- | --- |
| Home/rail | empty, many, stale projection, all stable/transition labels | create, expand archive, click every row, keyboard open, back/forward, rapid A/B/A switch | Screenshots + navigation video + route/assertion JSON |
| Conversation | warm, sleeping, failed, gone, long chat | direct deep link, refresh, scroll restore, session switch during fetch | Screenshots at anchors + video + no stale response assertion |
| Composer/stream | streaming, questions, tool calls | send, steer/follow-up, cancel, reconnect, switch away/back | Video + event transcript + duplicate/loss assertions |
| Lifecycle actions | sleep, resume, checkpoint, vaporize, all transition phases | double click, competing action, refresh mid-operation, injected 409, slow response | Video + actor journal + request/response trace |
| Hatch | hatch matrix | ensure, open, health loss, sleep/resume, stale handoff, close, vaporize | Screenshots/video + authoritative Hatch record + access assertions |
| Evidence/Summary | evidence matrix + long chat | record, finalize, open frame/video, refresh, sleep, cross-reference | Screenshots/WebM + provenance/assertion JSON |
| Responsive/accessibility | representative fixture from every group | compact rail, focus order, Escape, reduced motion, 200% zoom | Desktop/compact screenshots + accessibility results |

For motion, inspect lifecycle changes and panel entry/exit at 10% speed. Verify interruption,
focus retention, static state cues, no first-load flourish, and reduced-motion behavior.

Artifact paths are deterministic:

```text
artifacts/ui-rebuild/<run-id>/<implementation>/<surface>/<fixture>/<viewport>/
  <step>--before.png
  <step>--after.png
  journey.webm
  assertions.json
  actor-journal.json
  network.json
```

Where `implementation` is `current` or `tanstack-start`; `viewport` is `desktop-1440x900`,
`compact-390x844`, or `zoom-200`; and steps use zero-padded action names such as
`01-rail-loaded`, `02-archive-open`, `03-session-selected`. Redact credentials, cookies, handoff
values, repository secrets, and raw provider tokens from every artifact.

Acceptance requires semantic assertions, not just an exit code or video:

- route, heading, selected row, actor-derived lifecycle label, operation, and available actions;
- no unexpected 4xx/5xx, no uncaught browser error, and no duplicate mutation;
- expected 409 classified by code and followed by the documented UI state;
- stream has no lost or duplicate completed content after reconnect;
- artifact bytes load only through authenticated routes and provenance fails closed;
- session switching never displays another session's transcript, feature state, or mutation result.

## 6. Known live bugs to reproduce before fixing

| ID | Observed behavior | Contract at risk | Required isolating proof |
| --- | --- | --- | --- |
| `NAV-01` | Archived row clicks work intermittently; native disclosure rerender can replace the anchor during interaction | URL/navigation ownership | Pointer and keyboard video, event/route trace, 50-click deterministic test |
| `NAV-02` | `/sessions?focus=8f617f30a671` highlights/focuses but does not open its chat | Focus was conflated with selection | Assert focus-only behavior or replace links with canonical `/s/:id`; copy/open-in-new-tab proof |
| `LOAD-01` | Switching sessions sometimes replaces the whole page with `Could not load Pi session (409)` | Content availability was conflated with route/detail availability | Rapid A/B/A trace correlated with actor operation and cancelled request IDs |
| `STATE-01` | Session limit/sleep can be actor-authoritative while the rail still displays Warm | KV projection is stale | Same-timestamp actor view, KV projection, and rendered labels; demonstrate selected-read repair |
| `STATE-02` | Actor may report Stable Warm after provider runtime disappears | Stable label lacks live readiness/freshness at the consumer boundary | Actor journal + runtime observation + composer gating proof |
| `LEASE-01` | Slow resume and lifecycle work yield repeated 409s and appear stuck | Expected lease contention is rendered as failure; retry ownership is unclear | Double-submit/reload test with one operation nonce and eventual terminal authority |
| `HE-01` | Hatch is intermittently unavailable despite previously working | Desired/observed/exposure/runtime-epoch states may diverge; exact cause remains to be isolated | Hatch record + actor WarmWork transition + provider exposure/health for the same generation |
| `HE-02` | Evidence is frequently shown as unavailable | Missing bytes, incomplete finalization, retention, or provenance rejection are visually conflated | Reference, same-conversation provenance, Evidence record, R2 presence, and route result correlated by artifact ID |
| `CLEAN-01` | Vaporize can remain reconciling while Hatch/Evidence cleanup outcomes are unknown and list state remains stale | Cleanup terminality and projection publication | Actor cleanup absence categories + provider observations + final projection removal |

Do not assign a single root cause to `HE-01` or `HE-02` until the correlated proof exists. The UI
must expose their distinct typed conditions while backend investigation fixes any authority or
adapter divergence.

## 7. Merge gates

1. Fixture schemas decode at the same boundary as production responses; no UI-only lifecycle
   vocabulary is introduced.
2. Component tests cover every table row above, including keyboard and reduced motion.
3. Browser comparison artifacts exist for every matrix row and contain semantic assertions.
4. `NAV-01`, `LOAD-01`, `STATE-01`, `LEASE-01`, `HE-01`, and `HE-02` each have a red reproduction
   and a green rebuild result. Backend defects may land separately, but the rebuild must not mask
   them.
5. Existing HTTP routes, error envelopes, auth boundaries, persisted semantics, and lifecycle
   actions remain compatible.
6. A production canary proves create, long/streaming chat, sleep, resume, Hatch, Evidence,
   switching, and vaporize. Local seeded proof does not substitute for deployment proof.
