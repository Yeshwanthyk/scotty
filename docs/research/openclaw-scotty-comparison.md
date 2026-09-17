# OpenClaw cloud agents: lessons for Scotty

## Bottom line

OpenClaw separates its authoritative Gateway from disposable execution machines. It supports two arrangements:

```text
OpenClaw worker-turn
Gateway: transcript + model credentials + placement/checkpoints
    ↕ authenticated, replayable worker/node transport
Cloud machine: agent loop + commands/files

OpenClaw Codex remote-exec
Gateway: Codex app-server + model credentials + transcript
    ↕ authenticated remote execution transport
Remote machine: commands/files/HTTP execution

Scotty today
Session Sandbox DO: lifecycle authority + operation lease + recovery state
    ↕ managed runtime boundary
Cloudflare Container: Pi/Codex execution, session-bound credential handles
R2: confirmed immutable backups
Runner: registration/control transport exists; session creation remains gated
```

The first two arrangements are documented explicitly in OpenClaw's [cloud-worker ownership table](https://github.com/openclaw/openclaw/blob/1482bf19a763acc59470faf3425b3cf559018b2c/docs/gateway/cloud-workers.md#L41-L53). Implementation and Scotty evidence are traced in the supporting reports below.

This is not evidence that Scotty needs OpenClaw's full feature set. Its strongest transferable ideas concern remote placement, durable turn ownership, recovery visibility, and operator diagnostics. Scotty already has important authority, backup, unknown-outcome, and credential-isolation constraints that must survive any adoption.

## What to investigate next

| Priority                           | Opportunity                                          | Scope and proof needed                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Near-term candidate                | Better read-only diagnostics                         | Explain authority/readiness, pending recovery, backup status, and credential/egress policy without exposing secrets. First inventory existing safe projections; preserve current CLI output contracts.                            |
| Near-term candidate                | Recovery visibility                                  | Publish sanitized counts/status for unknown outcomes, pending cleanup, and recovery age, derived from the actor journal rather than a second authority. Verify existing telemetry before declaring it missing.                    |
| Before enabling runners            | Explicit execution capability and readiness contract | Distinguish connected/registered from capable of creating an agent session. Prove native RPC, runtime identity, generation fencing, cancellation, reconnect, and teardown with the deployed lifecycle canary.                     |
| Before enabling runners            | Durable placement and cleanup identity               | Reuse operation IDs and exact cleanup handles. A failed setup, disconnected socket, or kill signal must not mean allocation never happened or cleanup completed. Scotty already follows this principle for its current lifecycle. |
| If remote live sessions are wanted | Replay/catch-up contract                             | Define session/run identity, cursors, stale-generation rejection, admission versus completion, and unknown outcomes. This is an explicit product/API decision, not a silent route replacement.                                    |
| If child agents are wanted         | Durable parent/child task ownership                  | Specify accepted task identity, parent notification, cancellation intent, terminal outcome, and cleanup responsibility before adding spawn/concurrency UX. Not a present-day correctness defect merely because Scotty lacks it.   |

A useful next design session would choose between **improving the existing Cloudflare experience** and **finishing a remote-runner vertical slice**. Those are different investments. The research does not justify treating every missing OpenClaw capability as urgent work.

## What not to copy

- Do not replace Session DO authority with Gateway-style process state or local registries.
- Do not weaken confirmed-backup, hard-cap, lease, or unknown-provider-outcome rules to enable automatic retries.
- Do not send real GitHub/Codex credentials into execution hosts. OpenClaw's worker GitHub launch binding explicitly includes a token; that conflicts with Scotty's managed-handle boundary ([source](https://github.com/openclaw/openclaw/blob/1482bf19a763acc59470faf3425b3cf559018b2c/src/gateway/worker-environments/worker-github-binding.ts#L62-L95)).
- Do not add a provider catalog, broad plugin framework, or parallel infrastructure reconciler merely for parity.
- Do not enable runner creation based on registration, connectivity, or unit-test presence alone.

## Evidence pack

Three scouts used `openai-codex/gpt-5.6-luna`, high effort, with separate research scopes:

1. [Cloud topology and provisioning](openclaw-cloud-topology.md)
2. [Agent lifecycle, transport, and recovery](openclaw-agent-lifecycle.md)
3. [Security and operations](openclaw-security-operations.md)
4. [Source provenance and reproduction](openclaw-source-provenance.md)

OpenClaw: `1482bf19a763acc59470faf3425b3cf559018b2c`, latest GitHub `main` observed during acquisition. Scotty: `709f04e3c8720021fe1073ce8ffd61cfa712ccb2`.

`opensrc` reported a fetch but its export differed from the exact GitHub commit archive. Research was restarted against the exact archive; the provenance note records the discrepancy. Parent review also requested a fresh security citation audit after finding stale provenance in that report.

This is source research, not runtime verification. Tests cited by the scouts were inspected, not executed. No deployment, credential access, production code change, or current production pass claim is part of this work.
