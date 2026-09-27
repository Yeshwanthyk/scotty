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

- CLI `scotty new | read | steer | interrupt | show | log`.

## Drive

1. `npm run --silent scotty -- new octocat/Hello-World --prompt "Reply with the word MARKER1 and
nothing else." --key $RANDOM-$$ > $EVIDENCE/01-new.json`: exit 0, an `id` (C1).
2. Run `npm run --silent scotty -- read <id> --role assistant --last 1` into numbered
   `02-read-<attempt>.json` files. Each invocation exits 0 with one snapshot. Read again at
   1–2 second intervals, stopping within 600 seconds, until `authority` is stable/warm,
   `turn.state` is `completed` and a message contains `MARKER1` (C1, C2). A null turn means
   the initial prompt has not appeared yet; it is not proof of completion. Save `show <id>`
   into `02b-show.json` and check the same answer and turn ID through that second view.
3. `npm run --silent scotty -- steer <id> "Now reply with MARKER2." > $EVIDENCE/03-steer.json`,
   then read into numbered `04-read-<attempt>.json` files until a new turn ID is `completed`
   and its assistant message contains `MARKER2`; check `show <id>` in `04b-show.json` (C3).
4. `steer <id> "Count slowly from 1 to 500, one number per line."` into `05-steer.json`; once
   `read` has a new latest turn whose `state` is `streaming`, `interrupt <id>` into
   `06-interrupt.json`. Read into numbered `07-read-<attempt>.json` files until that turn's
   state is `aborted`; each read must exit 0 and return at most one message. Check
   `show <id>` in `07b-show.json`: the same turn is `aborted`, and the log's `turn.ended`
   has `state: "interrupted"` (C4). Use the same 600-second bound for each read sequence;
   stop on a failed session, command error, or missed deadline.
5. `npm run --silent scotty -- log <id> > $EVIDENCE/08-log.json`. From it: `container.start` to
   `sup.hello` time (C5); exactly one `prompt.delivered` per `req` (the interrupt is delivered as
   its own `req` too); no duplicate agent events.

6. On this same session, compare default `read`, `--last 2`, and `--role assistant --last 2`
   with `show`: counts are bounded, role filtering precedes the limit, message IDs remain
   stable across reads, and the latest `turn` stays the same regardless of filtering. Bounds
   `0`, `501`, `1.5`, and role `tool` must exit 2. Root help must list `read` and omit `watch`;
   invoking `watch <id>` must exit 2. Record these commands and results too.
7. `npm run --silent scotty -- new octocat/Hello-World --base main` must exit 2;
   `npm run --silent scotty -- new --help` must exit 0 and omit `--base`. Record both
   outputs and exit codes.

## Proof

Files 01–08 with exit codes; markers in the answers; `08-log.json` showing each request delivered
once and the interrupted turn end.

## Gotchas

- The first create on a fresh stage includes the container cold start (tens of seconds).
- A model can ignore "nothing else"; check the marker is present, not the exact text.
