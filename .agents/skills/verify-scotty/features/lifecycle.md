# Lifecycle

A quiet turn keeps running, an idle session sleeps and frees its container, and a message wakes it.

## Behaviours

- **W1** A turn that prints nothing for 5 minutes completes; the log has no `container.stopped`
  before its `turn.ended` and no `invariant.violated`. A `sup.redial` in between shows the Session DO
  was evicted and reattached.
- **W2** Once the turn's save is done, `ls` shows `warm · sleeps in Nm`; after the idle window it
  shows `asleep · idle`, the log has `container.stopped {reason: "idle"}`, and the container
  instance is not running.
- **W3** A steer to the asleep session starts a new container (`sup.hello` with gen 2) and its turn
  completes.
- **W4** `stop <id>` records `container.stopped {reason: "user"}`.

## Entry points

- CLI `scotty new | ls | steer | stop | log`. e2e: `npm run --silent e2e -- lifecycle` (about 8
  minutes; the scripted stand-in sleeps after a 60 s `idleAfter`).

## Drive

1. Create a scripted session on `_scotty/fixture` with prompt `sleep 300\nsay awake` and
   `idleAfter: 60000`; send no request for 330 s, then `log <id> > $EVIDENCE/01-log.json` (W1).
2. `ls > $EVIDENCE/02-warm.txt` right after the turn ends (W2), then again after a minute into
   `03-asleep.txt`; `npx wrangler containers instances $SCOTTY_CONTAINER_APP_ID --json` into
   `04-instances.json` (W2).
3. `steer <id> "say again"`; read until completed; `log <id> > $EVIDENCE/05-log.json` (W3).
4. `stop <id>`; `log <id> > $EVIDENCE/06-log.json` (W4).

## Gotchas

- Any request to the session keeps its DO in memory, so step 1 must stay silent to test eviction.
- An open terminal socket keeps an idle session awake; close the terminal before waiting for sleep.
- The `stalled` stop (30 minutes without agent output) is proved by fold tests only.
