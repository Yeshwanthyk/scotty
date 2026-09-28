# Stop and resume

A session can be stopped to free its container and brought back with its Codex thread and files.

## Behaviours

- **L1** `stop <id>` ends with `ls` showing `stopped` and the container not running.
- **L2** `resume <id>` (or a steer on a stopped session) starts a new container on the same thread:
  the agent recalls a marker from before the stop.
- **L3** Tracked and untracked non-ignored files come back; ignored files (dependencies) do not.
- **L4** A crash mid-turn (Codex killed) ends the session `stopped` with no `invariant.violated`,
  and it resumes like L2.

## Entry points

- CLI `scotty stop | resume | steer | read | ls | log`. e2e: `npm run --silent e2e -- stop-resume`.

## Drive

1. From a ready [core-loop](core-loop.md) session, steer "Remember the word LMARK1 and write it
   to marker.txt." and read until the turn completes.
2. `stop <id>` into `02-stop.json`; `ls` into `03-ls.json` shows it `stopped` (L1).
3. `steer <id> "What word did I ask you to remember? Is marker.txt there?"` into `04-steer.json`;
   read until completed: the reply names `LMARK1` and the file (L2, L3).
4. Steer "Run exactly: `sleep 5 && pkill -9 -f 'codex app-server'`"; read until the session is
   `stopped`; `log <id>` has no `invariant.violated`; `resume <id>` and a steer recall `LMARK1` (L4).
5. `log <id> > $EVIDENCE/06-log.json`.

## Gotchas

- Resume restores the workspace from R2 before the agent starts; installed dependencies and
  running servers are gone, and the agent reruns `.agents/setup`.
