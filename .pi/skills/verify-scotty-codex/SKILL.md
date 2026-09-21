---
name: verify-scotty-codex
description: Verify Scotty's deployed Pi or Codex CLI commands and native tool receipts after runtime, protocol, settings, or lifecycle changes; audit native event coverage when a session stops unexpectedly.
---

# Verify Scotty Pi and Codex sessions

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

For Pi, use [Pi native commands](features/pi-commands.md) and its dedicated helper.
The Codex helper below requires canonical turns and must not be reused for Pi snapshots.

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
request recovery helper in `scripts/lab/scotty-lab.mjs`; do not guess an ID or blindly resubmit.

## Evidence

The smoke helper writes timestamped `proof.json` with build/target, admission and terminal IDs,
matching completed command/output assertions, marker assertions, runtime health, and cleanup. It
excludes raw model content, command output and credentials. Its pass record is written only after
owned cleanup succeeds. Other recipes must record equally explicit action/result pairs. Correlate
receipts to turns. A follow-up must reach its admitted turn with the requested completed tool.
Native delegation requires native activity/child identity evidence, not the model claiming it ran.
A stopped runtime fails the feature even if an earlier turn passed.
Scotty's canonical projection has no 1,200-byte tool-output cap, but a smoke proves only the content
it observes; it does not prove unlimited native retention. Pi's upstream console producer still
shortens individual values at 16 KiB, keeps the latest 500 messages and 100 active tools, and caps
the snapshot response at 2 MiB. Its `truncated` flags must remain visible. A synthetic large-value
decoder test proves decoder acceptance only; it is not live native proof.
See [Coverage audit](features/coverage-audit.md) for unsupported and unproven paths.
For Hatch or language support changes, also run the [Hatch and toolchains](features/hatch-toolchains.md)
recipe and keep local image proof separate from deployed session proof.

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
