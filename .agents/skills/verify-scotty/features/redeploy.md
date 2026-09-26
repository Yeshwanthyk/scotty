# Survive a Worker redeploy

A session keeps working across a Worker redeploy: the DO re-dials the supervisor, and no message
is lost or duplicated.

## Behaviours

- **R1** After a redeploy mid-turn, the running turn still completes, and its answer arrives.
- **R2** The log has no gap and no duplicate: every supervisor output `n` appears once, in order,
  and each request is delivered once.

## Entry points

- CLI `scotty steer | watch | log`, plus `npm run deploy -- --stage <stage>` (owner authorized).

## Drive

1. Have a ready session from [core-loop](core-loop.md) (steps 1–2).
2. `steer <id> "Count from 1 to 200, one number per line, then say MARKER3."`, and wait until
   `watch` shows the turn running.
3. Redeploy the same stage with the same env (see SKILL.md "Launch"); save its output as
   `$EVIDENCE/03-redeploy.log` (no secrets are printed).
4. `watch <id> --until idle --timeout 600 > $EVIDENCE/04-watch.jsonl`: the answer ends with `MARKER3` (R1).
5. `log <id> > $EVIDENCE/05-log.json`: a `socket.closed` then a re-dial and `sup.hello` with the
   same boot, the `n` values strictly increasing with no repeats, one `prompt.delivered` per
   request (R2).

## Proof

`04-watch.jsonl` with `MARKER3`; `05-log.json` showing the reconnect with no duplicate or missing
`n`.

## Gotchas

- A redeploy that changes the image restarts the container: that is a new boot, and the session
  fails as `supervisor_restarted` by design. Redeploy with the same image digest.
