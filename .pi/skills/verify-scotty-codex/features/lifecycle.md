# Save, resume and failure recovery

Sleeping retains the conversation and resumes it in a fresh runtime.

## Behaviors

L1 healthy sleep/save; L2 restore same native thread; L3 retained queue; L4 runtime failure;
L5 vaporize ownership and backup cleanup.

## User entry points

Browser Sleep session, CLI `resume ID`, CLI `vaporize ID --yes --json`;
the owned lab lifecycle driver supplies the public sleep route. Standalone Codex checkpoint is unsupported.

## Drive

In a lab-owned Codex session use `npm run lab -- lifecycle sleep-resume --session ID` only after
confirming its current driver supports the selected agent. For a deployed owned session, complete a
command and record turn identity, sleep through the browser, require authoritative Sleeping with a
confirmed backup, then resume through CLI. Require a new runtime generation and the same native
thread, retained transcript, and a completed command using prior context. Queue persistence requires
a separately queued item and native receipt reconciliation. The lab fault flags and runtime-loss
scenario currently return `not-available`; do not report them as fault or recovery proof.

## Proof

Actor state/revision, backup identity, old/new runtime generation, same thread identity, retained
turns, fresh completed tool and cleanup receipt. Redact credentials and content.

## Gotchas

The current failed-host save requires healthy terminal state. Failed Codex research sessions could
not save or resume without a backup. Report this as a product defect, not a successful recovery.
`Warm` tracks infrastructure lifecycle and does not prove host health. A UI error banner is useful
failure evidence, but does not prove preservation or recoverability.
