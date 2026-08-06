---
name: scotty
description: Operate Scotty sessions. Use when creating, observing, opening, checkpointing, resuming, beaming down, or vaporizing a session; recovering ownership; or checking sandbox tools.
---

# Scotty

Operate Scotty as an authoritative state machine. Direct command responses own mutation results;
`scotty ls --json` is the polling projection.

## Contract

- Pass `--json` to every operational command and `--detach` to `beam up`.
- Use Cloudflare. Runner-backed session creation is not available.
- Label the returned URL “the live Pi worklog.”
- Render `warm` as “ready.” Use “working” only when `agentState` is exactly `working`.
- Use the returned `url`. Keep root tokens in a private token file, the environment, or `~/.scotty.json`.
- Retry exits 2, 4, or 5 only after changing input, credentials, or session state.

## Launch

1. Run the provider command with a specific 1–120 character title:

   ```sh
   scotty beam up "PROMPT" --title "SHORT OUTCOME" --repo OWNER/NAME --provider cloudflare --cap 4h --detach --json
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

## Inspect and steer peers

- Inspect a warm session without waking it with `scotty inspect ID --json`.
- Send a bounded prompt (not a slash command) with `scotty steer ID "MESSAGE" --json`.
- Inside a Scotty sandbox, these commands automatically use `https://scotty.internal`; do not pass
  credentials or source identity. Outside a sandbox, they use the configured authenticated Worker.
- Treat `stale` and `unavailable` as wrong-state results. Treat `ambiguous` as non-retryable unless
  the session is inspected first.

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
- From the matching local Git repository, run `scotty beam down ID --json`; expect
  `{"branch","sha","rolloutPath","resumeCmd"}`. Run a non-null `resumeCmd` when the user wants local
  continuation.
- With explicit user intent and work stored elsewhere, run
  `scotty beam vaporize ID --yes --json`.
  Completion is exactly `{"id","status":"gone"}`. Vaporize deletes immediately; create any required
  snapshot first.

State flow: `booting -> warm -> sleeping -> booting -> warm`; failures may enter `failed`, and
vaporize ends at `gone`.

## Setup and diagnostics

- Before setup, ask the user for an installation name. Never infer it from their username, machine,
  repository, Cloudflare account, or an existing Scotty deployment.
- `scotty init --name NAME [--profile PROFILE]` creates one namespaced installation, creates the
  root token, and writes a mode-0600 `~/.scotty.json`. It does not adopt or recover resources.
- On a new machine, `scotty recover --name NAME [--profile PROFILE]` displays the existing resource
  mapping and rotates only the root token after confirmation. A legacy deployment can use a
  private, uncommitted `--adoption-manifest PATH`.
- `scotty deploy` plans and applies code or resource changes for the managed installation. It does
  not change credentials. It asks only when the plan contains changes. Use `--yes` for changed
  non-interactive deployments.
- `scotty upgrade` installs a newer GitHub Release only after Ed25519 manifest and SHA-256 asset
  checks pass.
- `scotty uninstall` deletes compute and retains KV/R2 data by default. `--delete-data` also deletes
  that data. Both forms require confirmation and stop active sessions.
- Credential precedence for session commands is `--token-file`, `SCOTTY_TOKEN`, then config.
- `scotty doctor --json` verifies the local installation pointer, Worker reachability, and root
  authentication without exposing the token.
- Before runner setup, ask for a stable runner name. Never infer it from a username, hostname,
  Cloudflare account, or installation name.
- `scotty runner setup --name NAME --root ABSOLUTE_PATH --image
IMAGE@sha256:DIGEST --codex-auth ABSOLUTE_PATH --source-binary ABSOLUTE_PATH --json` registers
  the name with the control plane, receives a one-time runner credential, and installs the
  hardened user service without exposing that credential. Use `--replace` only when the user
  explicitly wants to move or reinstall an existing runner.
- `scotty runner list --json` lists authoritative registrations plus desired, connection, and
  assigned-session state. `scotty runner remove NAME --yes --json` is allowed only after assigned
  sessions are gone.
- `scotty owner recover --json` opens the five-minute recovery flow and returns only
  `{"opened":true,"expiresAt"}`.
- `scotty tools list --json` prints the standard tool manifest. `scotty tools doctor --json`
  reports missing, broken, or version-mismatched tools and exits nonzero when any fail.
- `scotty auth status --json` reports only provider IDs, credential types, adapter support, and the
  active `PI_AUTH_JSON` digest.
- `scotty auth sync --json` reads the private `~/.pi/agent/auth.json`, exports only supported
  provider fields, verifies the saved Cloudflare account, Worker, bindings, and origin, uploads the
  write-only Worker secret to that exact Worker, and waits for the redacted digest to match. It
  never changes existing sessions.
- `scotty auth reseed ID --json` replaces one warm Cloudflare session's provider map.
  `scotty auth reseed --all-active --json` explicitly replaces every warm Cloudflare session.
- If `scotty beam up --help` lacks `--title`, use a CLI built from current Scotty source before
  launching.

Exit codes: 0 success, 1 generic/network, 2 usage/config, 3 not found, 4 auth, 5 wrong state.
