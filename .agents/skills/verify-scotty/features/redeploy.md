# Survive a Worker redeploy

A session keeps working across a Worker redeploy: the DO re-dials the supervisor, and no message
is lost or duplicated. A deploy never replaces a running container, even with a new image: the
container keeps the image it started with, and only the next start (a new session, or a resume
after a stop or sleep) gets the new one.

## Behaviours

- **R1** After a redeploy mid-turn, the running turn still completes, and its answer arrives.
- **R2** The log has no gap and no duplicate: every supervisor output `n` appears once, in order,
  and each request is delivered once.
- **R3** A redeploy with a new image leaves the running container alone: the reconnect's
  `sup.hello` has the same boot, and the session does not stop with reason `deploy`.

## Entry points

- CLI `scotty steer | read | log`, plus `scotty deploy` for the configured stage (owner authorized).

## Drive

1. Have a ready session from [core-loop](core-loop.md) (steps 1–2).
2. `steer <id> "Count from 1 to 200, one number per line, then say MARKER3."`, and wait until
   `read <id>` shows a new latest turn with state `streaming`; record its ID.
3. Redeploy the same stage with the same env (see SKILL.md "Launch"); save its output as
   `$EVIDENCE/03-redeploy.log` (no secrets are printed).
4. Run `read <id> --role assistant --last 1` into numbered `04-read-<attempt>.json` files,
   with command exit codes. Read again at 1–2 second intervals for at most 600 seconds until
   the recorded turn is `completed` and its assistant message ends with `MARKER3` (R1).
   Stop on a failed session, command error, or missed deadline.
5. `log <id> > $EVIDENCE/05-log.json`: a `socket.closed` then a re-dial and `sup.hello` with the
   same boot, the `n` values strictly increasing with no repeats, one `prompt.delivered` per
   request (R2).

6. For R3, repeat steps 2–5 with a deploy that names a new image (`scotty deploy --image <ref>`,
   SKILL.md "Launch"). The same boot in `sup.hello` and a completed turn prove it.

## Proof

The final `04-read-<attempt>.json` with `MARKER3`; `05-log.json` showing the reconnect with no duplicate or missing
`n`, and the same boot after the new-image deploy.

## Gotchas

- Stop reason `deploy` still exists: the fold records it when a `sup.hello` comes with a new boot,
  meaning the container was replaced under the session. A deploy no longer does that; if it
  appears after one, the container app is not on the `durable_object` policy (see
  [sizes](sizes.md)).
