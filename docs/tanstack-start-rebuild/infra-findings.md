# Infrastructure findings

## CLEAN-01: Vaporize cannot interrupt an active Evidence lease

Status: source-confirmed root cause; implementation pending.

```text
VaporizeCommand
  -> actor commits Transitioning(Vaporize)
  -> Hatch cleanup accepts the Vaporize operation and completes
  -> Evidence cleanup receives the prior Evidence nonce
  -> Evidence updateActive observes the current Vaporize lease
  -> lease_changed
  -> error is flattened to evidence_interruption_unknown
  -> Evidence absence is never confirmed
  -> Vaporize cannot reach Gone
  -> KV keeps a stale deleting projection
```

The actor is retaining operation ownership correctly. The contract mismatch is between the
Vaporize coordinator and the Evidence store: cleanup must be authorized by the current Vaporize
nonce while targeting the prior active Evidence job. Normal Evidence updates must continue to
require the Evidence nonce.

### Retry gap

After the transition deadline, Vaporize re-enters reconciliation without continuing provider
cleanup dispatch. A failed actor-deadline callback also lacks the successor scheduling used by the
hard-cap callback. These gaps can turn the deterministic lease rejection into an effectively
unbounded transition.

### Smallest coherent fix

1. Add Vaporize-authorized Evidence cleanup operations that validate the current Vaporize nonce
   and target the prior Evidence job.
2. Preserve the retryable cleanup order: revoke, unexpose, close, interrupt.
3. Continue durable cleanup reconciliation after the transition deadline.
4. Schedule a successor alarm when the actor-deadline callback fails.

### Missing proof

- Store contract: active Evidence can be cleaned by the owning Vaporize operation without
  weakening ordinary Evidence lease checks.
- Integration: open Hatch plus active Evidence, then Vaporize; Hatch, Evidence, preview state,
  actor authority, and KV projection all reach terminal absence.
- Race: Vaporize cleanup continues after its deadline.
- Alarm: callback failure schedules the successor retry.

Existing Vaporize tests use fake provider phases or finalize Evidence before Vaporize, so they do
not cover this lease handoff.
