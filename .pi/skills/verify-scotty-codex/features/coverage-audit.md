# Coverage audit: Scotty lab and Codex

This is a map of what the lab actually asserts, not a list of successful runs. The lab drives
`cli/scotty.ts` against a local Wrangler Worker. A green local lab result does not establish a
deployed Codex Container or native app-server result. Inspect the retained scenario and command
records under `.scotty-lab/evidence/RUN_ID/` before marking any row passed.

| Advertised flow or state | Lab action and assertion | Codex or end-to-end limit |
| --- | --- | --- |
| Start, doctor, stop | `start` owns a Wrangler process and isolated CLI home; `exec RUN_ID -- doctor --json` runs the real CLI; `stop` checks process ownership and retains cleanup/log evidence. | Doctor proves local CLI/Worker routing. It creates no Sandbox or Codex process. `setup` imports the shared Pi auth source used by Codex grant selection; setup/sync is separate from doctor and does not by itself prove native readiness. |
| Create and ready | `create-and-ready` calls `beam --detach --json`, records the returned or exact pending-request ID, and requires CLI `warm` plus stable actor `Warm` with matching authority/journal revisions. | No prompt completion, native readiness, selected model/effort readback, command, transcript or browser proof. `Warm` can coexist with a stopped Codex host. |
| Checkpoint | `checkpoint` calls the CLI, requires the same owned ID, CLI `warm` and stable actor `Warm`. | Codex checkpoint is explicitly unsupported by the public session route. This is a Pi lifecycle assertion, not a runnable Codex checkpoint proof. |
| Sleep and resume | `sleep-resume` calls the authenticated public sleep route, waits for stable actor `Sleeping`, invokes CLI `resume`, then requires same ID, CLI `warm` and stable actor `Warm`. | No confirmed backup identity, prior turn preservation, same native thread, new runtime generation, queued work or fresh command assertion. A non-2xx sleep response can still proceed if actor state settles. Failed-host recovery is not proved. |
| Vaporize | `vaporize` accepts only a lab-owned ID, requires CLI `gone` and stable actor `Gone`. | Does not independently enumerate provider resources, backup objects or credential destruction. `stop` alone is not a session vaporize operation. |
| Full lifecycle | `full` composes create, checkpoint, sleep-resume and vaporize, then records success. | Its checkpoint step is unsupported for Codex, so `full` cannot be a Codex all-flows gate. A failure before vaporize leaves the owned ID for explicit cleanup. |
| Codex workflow | `codex-workflow` selects Sol/medium, requires canonical command completion, follows up, steers an active turn, queues and interrupts it, observes the queued command, then checks healthy sleep/resume continuity and a fresh command before owned vaporize. | This is a real local Worker/native-model path only when the scenario itself passes. The 2026-09-12 local run failed at its initial turn with `upstream_failed (other)` and no tool activity, so none of the later controls or resume steps were proved by that run. It does not cover delegation, browser controls, failed-host recovery or Pi continuity. |
| Captured failure states | `npm run test:lab` schema-decodes two redacted production snapshot/actor pairs and asserts their public UI projection: Warm actor with stopped host, and Failed sleep without a backup. | One conversation is current at capture; the other is last-observed. These are deterministic state-projection fixtures, not native event replay or evidence that either old session can recover. Earlier deleted sessions have no recoverable native event capture. |
| Runtime loss and hard cap | Both scenarios record `not-available` before a lifecycle action. | No live fault, hard-cap deadline, failure recovery or retention proof. |
| Nine fault controls | Any `--fault` value records `not-available` before the selected action. | No injection or post-dispatch ambiguity/reconciliation proof. |
| Actor diagnostics | Each supported action reads validated actor diagnostics and compares stable authority, revision and journal tail. | Journal may be truncated at 256 events; provider snapshots are `not-available`. CLI/HTTP outcome is not correlated with an operation ID or independently verified provider state. |
| Transcript read/follow recipe | `docs/scotty-lab.md` gives manual `read`, `--follow` and `steer` commands. | These are instructions, not lifecycle-driver assertions. A passive read does not prove changed-message follow behavior. |
| Container image check | `check:container-image` launches the packaged pinned 0.153.4 server, verifies readiness, selected settings, managed auth isolation, skill discovery, idle snapshot and stop. | It proves real native process startup in the CI image. It does not send a model command, delegate, follow up or exercise deployed actor lifecycle. |
| Native supervisor tests | `scripts/codex-session-supervisor.test.mjs` includes real pinned binary against a synthetic upstream. | The native cases skip when `SCOTTY_TEST_CODEX_BINARY` is unset; a green job without that variable is not evidence that they ran. |

The deployed smoke helper in this skill adds one different proof tier: two completed turns, each
with a matching completed command, a marker, a healthy runtime, a follow-up receipt that matches
the observed second turn, and owned cleanup. Its 70,000-byte prompt asks for a large command;
canonical tool output is capped at 1,200 bytes, so this view cannot prove the full native aggregate
length. A protocol decoder test accepts a synthetic 211,769-byte aggregate; live native byte
delivery beyond the canonical cap remains unproven. The smoke does not cover delegation, active
steering, queueing, interruption, sleep, resume, failed-host
recovery, provider state or browser controls.

To close the Codex release gap, make the existing public-path checks pass in this order:

1. Resolve the local initial-turn `upstream_failed (other)` and rerun `codex-workflow` to a passing
   result. Its current source asserts selected agent/model/effort, canonical commands, receipt
   correlation, queue/interrupt, runtime generation, native thread identity, transcript continuity,
   fresh post-resume command and owned cleanup; a failed run proves only the reached prefix.
2. Confirm the supported Codex sleep-resume path also preserves backup identity and model context
   beyond the prior transcript and fresh command. Keep checkpoint and therefore `full` out of the
   Codex gate unless that public capability is deliberately added.
3. Expose bounded, lab-owned fault controls and provider observations before claiming runtime-loss,
   hard-cap or ambiguous-outcome recovery. Keep `not-available` until those paths exist.
4. Exercise delegated research, queued follow-up and browser controls through separate recipes;
   native child identity requires native evidence, not model prose or command counts.
