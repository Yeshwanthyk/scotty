# Core loop: create, answer, steer, interrupt

A session on a public repository gets a Codex answer, accepts a steer, and stops on interrupt.

## Behaviours

- **C1** `new` returns an ID and branch `scotty/<id>`; the session reaches ready (workspace
  cloned, agent started).
- **C2** The first prompt gets an answer containing the marker word.
- **C3** `steer` during or after a turn is delivered once and answered.
- **C4** `interrupt` during a running turn ends it as `interrupted`.
- **C5** Cold start: the time from create to the supervisor `hello` is recorded.

## Entry points

- CLI `scotty new | watch | steer | interrupt | show | log`.

## Drive

1. `npm run --silent scotty -- new octocat/Hello-World --prompt "Reply with the word MARKER1 and
nothing else." --key $RANDOM-$$ > $EVIDENCE/01-new.json`: exit 0, an `id` (C1).
2. `npm run --silent scotty -- watch <id> --until idle --timeout 600 > $EVIDENCE/02-watch.jsonl`:
   exit 0 once idle. `watch` prints only session views; read answers with
   `scotty show <id> > $EVIDENCE/02b-show.json`: `turns[0].assistant` contains `MARKER1` (C1, C2).
3. `npm run --silent scotty -- steer <id> "Now reply with MARKER2." > $EVIDENCE/03-steer.json`,
   then `watch <id> --until idle` into `04-watch.jsonl` and `show <id>` into `04b-show.json`:
   `turns[1].assistant` contains `MARKER2` (C3).
4. `steer <id> "Count slowly from 1 to 500, one number per line."` into `05-steer.json`; once
   `show` has a turn whose `state` is `streaming`, `interrupt <id>` into `06-interrupt.json`; then
   `watch <id> --until idle` into `07-watch.jsonl` and `show <id>` into `07b-show.json`: that turn's
   `state` is `aborted`, and the log's `turn.ended` has `state: "interrupted"` (C4).
5. `npm run --silent scotty -- log <id> > $EVIDENCE/08-log.json`. From it: `container.start` to
   `sup.hello` time (C5); exactly one `prompt.delivered` per `req` (the interrupt is delivered as
   its own `req` too); no duplicate agent events.

## Proof

Files 01–08 with exit codes; markers in the answers; `08-log.json` showing each request delivered
once and the interrupted turn end.

## Gotchas

- The first create on a fresh stage includes the container cold start (tens of seconds).
- A model can ignore "nothing else"; check the marker is present, not the exact text.
