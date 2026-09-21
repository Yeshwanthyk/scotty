---
name: scotty-live-observability
description: Diagnose Scotty deployments and live session-actor flows using public CLI proof, authoritative actor evidence, and bounded Cloudflare Worker tails. Use for live canaries, lifecycle divergence, unknown provider outcomes, deployment verification, or session debugging; this skill does not authorize mutation.
---

# Observe Scotty Live State

Establish the live target before interpreting events. Read the configured installation with
`scotty doctor --json`, then record the exact CLI or commit, installation, Worker, session ID, and
UTC observation window. Names and targets remain user-supplied. Never infer that a repository or
existing session is disposable.

Use the smallest proof tier that answers the question:

1. Public behavior: doctor, list, inspect, and passive read using current CLI help.
2. Actor authority: a redacted authority snapshot and causal journal from the Session owner.
3. Live execution: a bounded JSON Worker tail around one reproduction.
4. Provider reality: the explicitly identified Container or R2 resource, only when actor facts do
   not settle the provider outcome.

Use a maintained actor-capture helper from the installed skill directory or exact Scotty checkout
when available. If none is available, stop at public proof and report actor authority as unproved;
do not reconstruct private endpoints or print installation credentials. Likewise, derive a missing
Create ID only from a maintained pending-request helper, never from a visible substring of an
idempotency key.

Correlate evidence by session ID, transition nonce, attempt, authority revision, journal sequence,
result code, and event time. Worker tails and provider observations explain transitions but cannot
override the actor journal.

For Codex startup failures, find `Codex supervisor exited before readiness` in Worker logs.
Correlate `sessionId` and `generation`; inspect `processStatus`, `exitCode`, and optional
`startupStage` / `startupCode`. Missing startup fields mean no classified record was retrieved;
a null exit code means the provider did not supply one. Capture this evidence before vaporizing.

Interpret boundaries precisely:

- No actor authority after failed Create means failure occurred before admission.
- `Transitioning(..., reconciling)` retains ownership of an ambiguous outcome; do not retry outside
  the actor.
- `Stable(Failed)` is a committed typed failure; report its safe result code.
- `Stable(Warm)` proves fenced runtime, supervisor, and transport readiness, not model success.
- Missing diagnostics after successful vaporize is compatible with deleted authority; distinguish
  an unknown session from an HTTP route fallback.

For Codex, separate message admission from terminal response in canonical read. For an authorized
messaging canary, correlate active steering and terminal follow-ups by returned turn ID and require
completed tool receipts. For interruption, require native terminal `interrupted` and its public
canonical `aborted` projection. A delivery-unknown result requires inspection, not blind
resubmission. For sleep/resume, require authoritative Sleeping after backup confirmation, then
Warm with a new runtime generation and the same native thread. Compare earlier canonical turns
and tool output, then require a completed new turn using prior conversation context. Standalone
checkpoint should save and restart the same Codex thread and retain earlier turns; verify shared
skill discovery through the native session. A scheduled midpoint may interrupt active work and
must not replay an uncertain external effect. The final sleep starts ten minutes before cap (or
at midpoint for caps of twenty minutes or less), and the cap remains absolute. If final backup
stalls, distinguish the owned attempt from an earlier confirmed recovery point. Verify the
confirmed timestamp and actionable wake source before claiming recoverability; an owned ID
alone is not a backup. An unknown create/restore response requires reconciliation of the same
attempt and its workspace marker, never a fresh backup attempt.

For an authorized queue canary, use `steer --follow-up --idempotency-key ID` during
an active turn. Default `steer` still targets that turn. Require the public `mode: "followUp"`
admission and visible queue item, then close the browser and prove alarm-driven native admission
and terminal completion. Queue acceptance alone proves no native execution. Verify ordinary
interrupt preserves queued work, sleep retains it, resume checks the restored thread's receipts,
and vaporize removes it. A lost reply must retain the same ID and text; a restored accepted receipt
may remove the item, while an absent or unknown receipt must remain visibly unconfirmed without a
replacement turn. Inspect before sending another message with a new ID.
For Pi overrides, native settings readback must precede the first prompt. Local TOML defaults do
not establish effective settings for an existing Session.

In this checkout the maintained actor and pending-create helpers live in `scripts/lab/scotty-lab.mjs`
and are consumed by `scripts/lab/scotty-lab.ts`. Use their current ownership/manifest contract; do not
assume standalone `capture-actor.mjs` or `latest-pending-session.mjs` exists.

Keep evidence safe and bounded. Never print tokens, root keys, OAuth values, credential plaintext,
environment values, prompts, model content, or raw provider payloads. Preserve the first divergent
request, authority snapshot, and relevant tail window before another reproduction. Stop if secret
material appears.

Mutation remains separately authorized. Creating, steering, interrupting, checkpointing, sleeping,
resuming, vaporizing, syncing, deploying, and resetting resources require explicit scope and
targets. Track
canary IDs and clean up only owned canaries. Fault controls reproduce failures; they never set the
desired final state directly.

For durable end-to-end evidence, use the existing Scotty lab rather than creating another lifecycle
controller. The lab drives public paths and captures proof; it does not repair actor state.
