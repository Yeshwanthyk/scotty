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

Interpret boundaries precisely:

- No actor authority after failed Create means failure occurred before admission.
- `Transitioning(..., reconciling)` retains ownership of an ambiguous outcome; do not retry outside
  the actor.
- `Stable(Failed)` is a committed typed failure; report its safe result code.
- `Stable(Warm)` proves fenced runtime, supervisor, and transport readiness, not model success.
- Missing diagnostics after successful vaporize is compatible with deleted authority; distinguish
  an unknown session from an HTTP route fallback.

Keep evidence safe and bounded. Never print tokens, root keys, OAuth values, credential plaintext,
environment values, prompts, model content, or raw provider payloads. Preserve the first divergent
request, authority snapshot, and relevant tail window before another reproduction. Stop if secret
material appears.

Mutation remains separately authorized. Creating, steering, checkpointing, sleeping, resuming,
vaporizing, syncing, deploying, and resetting resources require explicit scope and targets. Track
canary IDs and clean up only owned canaries. Fault controls reproduce failures; they never set the
desired final state directly.

For durable end-to-end evidence, use the existing Scotty lab rather than creating another lifecycle
controller. The lab drives public paths and captures proof; it does not repair actor state.
