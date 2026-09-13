# Steering, interruption and queued follow-up

Messages target the intended active or next turn without duplication.

## Behaviors

Q1 active steer; Q2 interrupt; Q3 queued follow-up; Q4 retry/reconciliation; Q5 browser-independent dispatch.

## User entry points

CLI `steer ID TEXT`, `steer ID TEXT --follow-up --idempotency-key KEY`, `interrupt ID`;
browser Stop/Steer must be exercised separately.

## Drive

Start an owned session with a bounded command long enough to observe a running native tool.
Read the active turn ID. Send active steer and require the receipt to reference that same turn.
Queue a distinct message with a recorded idempotency key; require mode followUp and one queue item.
Interrupt the active turn; require canonical aborted/native interrupted and preservation of the queue.
Close the browser and observe CLI inspect until queued work is admitted once and completes.
Require the runtime to remain healthy after late terminal-interaction events from the interrupted
command; an accepted queue receipt followed by `stale_notification` is a failed run.
Retry the same queue request with the same key/text; verify no second native turn.
An unknown delivery requires inspection of the saved receipt, not a new key.

## Proof

Store admission IDs, active/terminal states, queue sizes and exactly-once native receipt assertions.
Retain evidence before vaporizing only the owned session.

## Gotchas

Queue acceptance does not prove execution. A terminal follow-up test never exercises active steering.
The prior local `codex-workflow` failure did not reach its queue and interrupt steps. Treat those
steps as unproven until a complete owned canary records admission, terminal state, and the queued
turn. Local reducer assertions do not establish alarm dispatch.
