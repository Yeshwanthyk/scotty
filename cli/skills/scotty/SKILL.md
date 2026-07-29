---
name: scotty
description: Operate Scotty sessions. Use when creating, observing, opening, checkpointing, resuming, beaming down, or vaporizing a session; recovering ownership; or checking sandbox tools.
---

# Scotty

Operate Scotty as an authoritative state machine. Direct command responses own mutation results;
`scotty ls --json` is the polling projection.

## Contract

- Pass `--json` to every operational command and `--detach` to `beam up`.
- Use Cloudflare unless the user requests a named trusted runner.
- Label a Cloudflare URL “the live Pi terminal” and a runner URL “the runner workspace.”
- Render `warm` as “ready.” Use “working” only when `agentState` is exactly `working`.
- Use the returned `url`. Keep root tokens confined to flags, environment, or `~/.scotty.json`.
- Retry exits 2, 4, or 5 only after changing input, credentials, or session state.

## Launch

1. Run the provider command with a specific 1–120 character title:

   ```sh
   scotty beam up "PROMPT" --title "SHORT OUTCOME" --repo OWNER/NAME --provider cloudflare --cap 4h --detach --json
   ```

   ```sh
   scotty beam up "PROMPT" --title "SHORT OUTCOME" --repo OWNER/NAME --provider runner --runner NAME --cap 4h --detach --json
   ```

2. Parse `{"id","title","url","branch","provider","status"}` from stdout.
3. If status is `booting`, observe that exact ID.
4. Render the result using the final-response contract.

Launch is complete only when the exact ID is `warm`, `sleeping`, or `failed`, or when observation
reaches its polling limit. Every completion path ends with one final response.

## Observe an ID

1. Run `scotty ls --json` every 5 seconds and select the record with the exact `id`.
2. Stop on `warm`, `sleeping`, or `failed`, or after 36 polls.
3. After 36 booting records, preserve the status as `booting` and report the three-minute timeout.

Observation is complete when the final record and its stopping reason are known.

## Final response

Final response is complete only when it matches one of these shapes:

- For `warm`, return one sentence:
  `Session ID is ready on branch BRANCH: [open LABEL](URL).`
- For `sleeping`, `failed`, or a polling timeout, return at most three short lines: exact status;
  `failure.code`, `failure.message`, and `failure.recoverable` when present; then one concrete next
  action.
- Include command history, polling logs, raw JSON, architecture, and recap only when the user asks.

## Lifecycle

- Open a warm session with `scotty attach ID --json`; expect `{"id","url","opened":true}`.
- Checkpoint a warm session with `scotty snapshot ID --json`; expect
  `{"id","status","backupId"?}`.
- Resume a sleeping or recoverably failed session with `scotty resume ID --json`, then observe the
  exact ID when status is `booting`.
- From the matching local Git repository, run `scotty down ID --json`; expect
  `{"branch","sha","rolloutPath","resumeCmd"}`. Run a non-null `resumeCmd` when the user wants local
  continuation.
- With explicit user intent and work stored elsewhere, run `scotty vaporize ID --yes --json`.
  Completion is exactly `{"id","status":"gone"}`. Vaporize deletes immediately; create any required
  snapshot first.

State flow: `booting -> warm -> sleeping -> booting -> warm`; failures may enter `failed`, and
vaporize ends at `gone`.

## Setup and diagnostics

- `scotty init [--host URL] [--token TOKEN]` writes mode-0600 `~/.scotty.json`; it is the only
  prompting command. Credential precedence is flags, environment, then config.
- `scotty owner recover --json` opens the five-minute recovery flow and returns only
  `{"opened":true,"expiresAt"}`.
- `scotty tools list --json` prints the standard tool manifest. `scotty tools doctor --json`
  reports missing, broken, or version-mismatched tools and exits nonzero when any fail.
- `scotty auth status --json` reports only provider IDs, credential types, adapter support, and the
  active `PI_AUTH_JSON` digest.
- `scotty auth sync --json` locks and decodes `~/.pi/agent/auth.json`, resolves local API-key
  references, uploads the write-only Worker secret, and waits for the redacted digest to match. It
  never changes existing sessions.
- `scotty auth reseed ID --json` replaces one warm Cloudflare session's provider map.
  `scotty auth reseed --all-active --json` explicitly replaces every warm Cloudflare session.
- If `scotty beam up --help` lacks `--title`, use a CLI built from current Scotty source before
  launching.

Exit codes: 0 success, 1 generic/network, 2 usage/config, 3 not found, 4 auth, 5 wrong state.
