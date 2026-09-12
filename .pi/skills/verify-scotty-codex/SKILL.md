---
name: verify-scotty-codex
description: Verify Scotty's deployed Codex CLI session surface after runtime, protocol, settings, or lifecycle changes; audit native event coverage when a session stops unexpectedly.
---

# Verify Scotty Codex sessions

## Launch

Use the user-selected built CLI and installation. Read its `--build-info`, `doctor --json`, and
`skill show scotty-live-observability`. A deployment is a separate authorized operation through
`deploy --plan --json` and the reviewed `deploy --yes --json` plan. Never bypass deployment guards.
The selected host must already be deployed; this skill does not replace the deployment driver.

For local-only CLI/Worker wiring, use `npm run lab -- start`, the returned run ID with
`npm run lab -- exec RUN_ID -- doctor --json`, then `npm run lab -- stop RUN_ID`.
This proves local routing only. Sandbox/model behavior requires the deployed recipes below.

## Doctor

Confirm the exact CLI build, host and installation match the user's target. Read `list --json`;
record existing IDs as unowned. Confirm `beam --help`, `inspect --help`, and `steer --help` agree
with the recipe. Use existing installation authentication; credential synchronization is separate.
The smoke explicitly selects Codex and checks its canonical conversation shape; model and effort
from the cloud profile need separate displayed/persisted selection readback.
`Warm`, `doctor.ok`, and a marker-only answer are not native tool or delegation proof.

## Drive

Read [Features](features/README.md), select the affected recipes, and label each proof tier.
The executable smoke recipe uses the real CLI, requires a fresh evidence directory, creates one
session, and deletes only that returned ID. Example for the currently authorized installation:

```sh
python3 .pi/skills/verify-scotty-codex/scripts/smoke.py \
  --cli /tmp/scotty-runtime-release --repo Yeshwanthyk/scotty \
  --evidence "/tmp/scotty-codex-proof-$(date -u +%Y%m%dT%H%M%SZ)-$$" \
  --authorize-create-and-cleanup
```

Choose a fresh evidence directory for another run; existing directories fail closed.
Choose the executable and repository explicitly for another installation. Concurrent deployment
and lifecycle driving is unsafe. Independent created sessions may run concurrently if separately owned.
After a surprise failure, retain the failure receipt, run doctor again, and isolate the failed
session before another drive. A failed create without an ID requires the maintained exact pending
request recovery helper in `scripts/scotty-lab.mjs`; do not guess an ID or blindly resubmit.

## Evidence

The smoke helper writes timestamped `proof.json` with build/target, admission and terminal IDs,
matching completed command/output assertions, marker assertions, runtime health, and cleanup. It
excludes raw model content, command output and credentials. Its pass record is written only after
owned cleanup succeeds. Other recipes must record equally explicit action/result pairs. Correlate
receipts to turns. A follow-up must reach its admitted turn with the requested completed tool.
Native delegation requires native activity/child identity evidence, not the model claiming it ran.
A stopped runtime fails the feature even if an earlier turn passed.
Canonical tool output is capped at 1,200 bytes; this smoke proves that the requested large command
ran and projected its bounded output, not the full native aggregate byte count. The protocol
decoder test separately accepts a synthetic 211,769-byte aggregate; it is not live native proof.
See [Coverage audit](features/coverage-audit.md) for unsupported and unproven paths.

## Cleanup

The helper vaporizes only its returned session and verifies `gone`. Evidence survives cleanup.
If interrupted before cleanup, recover its exact ID from `proof.json`, inspect it, and run the
selected CLI's `vaporize ID --yes --json` only for that owned session. Never target `6ffa0a512819`.
Retain an ambiguous cleanup as blocked. Preserve all pre-existing sessions, including working controls.
Local lab cleanup uses the run's own stop command; resolve cleanup-pending before success.

## Features

[Feature index](features/README.md) owns coverage and recipes. Passing one recipe proves only that
recipe. A complete runtime release needs every affected supported path, including recovery after
failure, plus image/native and deployed evidence. Report partial or blocked coverage explicitly.
