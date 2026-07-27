---
name: scotty
description: Manage Pican-hosted Codex workspaces on Cloudflare. Use before running Scotty to start, inspect, attach, checkpoint, resume, beam down, or vaporize a session.
---

# Scotty

Scotty beams a Pican-hosted Codex workspace into a Cloudflare Sandbox. Use it to start a hosted
session, open Pican's mounted UI, checkpoint or resume it, beam its branch and Codex rollout down
to the current local repository, and permanently remove it. Commit, push, and open pull requests
directly from Codex when you want them; Scotty doesn't own source-control publishing.

## Command reference

- `scotty init [--host URL] [--token TOKEN]` writes `~/.scotty.json` with mode 0600. This is the only command that prompts.
- `scotty beam up "PROMPT" --repo OWNER/NAME --provider cloudflare [--cap 4h] [--detach] --json` returns `{"id","url","branch","provider","status"}`.
- `scotty ls --json` returns session records including `provider`, `ageSeconds`, and `capRemainingSeconds`. This is the polling primitive.
- `scotty attach ID --json` opens the mounted Pican UI and returns `{"id","url","opened"}`.
- `scotty owner recover --json` uses the protected root token to open a five-minute browser
  recovery flow and returns only `{"opened":true,"expiresAt"}`. It never prints the capability URL.
- `scotty snapshot ID --json` checkpoints a warm session and returns `{"id","status","backupId"?}`.
- `scotty resume ID --json` restores a sleeping or recoverable failed session and returns `{"id","url"?,"branch"?,"status"}`.
- `scotty down ID --json` fetches the session branch, securely installs its rollout when present, and returns `{"branch","sha","rolloutPath","resumeCmd"}`. The last two values are null when no usable rollout exists.
- `scotty vaporize ID --yes --json` permanently deletes runtime, backups, credentials, and registry state; it returns `{"id","status":"gone"}`.
- `scotty tools list --json` prints the immutable `standard` sandbox tool manifest. `scotty tools doctor --json` probes the installed commands without Worker credentials.
- `scotty skills` prints this document.

Every operational command accepts `--host` and `--token`. Precedence is flags, then `SCOTTY_HOST`/`SCOTTY_TOKEN`, then `~/.scotty.json`. Non-TTY output automatically uses JSON. Errors are `{"error":{"code","message","hint"}}` on stderr.

The root token is CLI and break-glass authority only. Mounted Pican URLs are clean; they never
contain the root token or Pican's internal proxy credential. Keep the root token in a password
manager or another protected recovery location. On a replacement laptop, run `scotty init` with
that token and then `scotty owner recover`. Recovery revokes every existing browser credential but
leaves sessions, containers, backups, and worktrees intact.

Exit codes: 0 success, 1 generic or network failure, 2 bad usage/config, 3 session not found, 4 authentication/authorization failure, 5 wrong session state.

## Workflows

### Cloud work

1. Run `scotty beam up "TASK" --repo OWNER/NAME --provider cloudflare --detach --json`.
2. Poll `scotty ls --json` until the session is `warm`.
3. Open the returned URL or run `scotty attach ID`; Pican reconnects to the same hosted session.
4. Ask Codex in Pican to commit, push, or open a pull request when you want that.
5. Run `scotty vaporize ID --yes --json` after the work is safely stored elsewhere.

### Sleep and resume

1. Run `scotty snapshot ID --json` before a deliberate pause. Scotty gracefully stops Pican,
   flushes the workspace, creates the backup, and starts Pican again.
2. Poll `scotty ls --json`; hard-capped or idle sessions become `sleeping` automatically.
3. Run `scotty resume ID --json` only when it is sleeping or recoverably failed.

### Beam down

1. Change into the matching local Git repository.
2. Run `scotty down ID --json`.
3. Run the returned `resumeCmd` when non-null.

## State machine

`booting -> warm -> sleeping -> booting -> warm`. Setup or checkpoint failures may enter `failed`; recoverable failures can resume through `booting`. `vaporize` moves any live state to terminal `gone`.

## Rules of thumb

- Always pass `--json` in agent automation.
- Poll `ls`; its records are a projection and direct commands enforce authoritative state.
- A hard cap gracefully stops Pican, checkpoints, and sleeps even while its UI is open.
- Vaporize completed sessions to stop spend. It never snapshots first.
- Retry network failures, but don't retry exit 2, 4, or 5 without changing input, credentials, or state.
