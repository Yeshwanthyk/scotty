# Automations

An automation starts or steers a session on a schedule or on a webhook delivery. Every firing is
a run: skipped (and why), or started or steered a session, and then how that session's turn went.

## Behaviours

- **A1** `automation add` makes an automation that is off; `automation ls` says it in a sentence
  with its last run. Replacing one (PUT) turns it off again.
- **A2** A calendar schedule (five cron fields in an explicit IANA zone) fires once at its time
  into a session; `runs` lists the run as started, linked to that session, and later its turn
  outcome.
- **A3** The session's origin names the automation and the run; the UI's session header links
  back to the automation.
- **A4** A delivery to a connection whose event automation's `only` does not match is a run
  skipped with `not matched: …`, and starts nothing.
- **A5** `automation run <name>` fires now (on or off); a schedule missed by more than 10 minutes
  is one run skipped as `missed`.
- **A6** The UI's Automations page lists them with a toggle and last run, edits one, and lists
  runs linked to their sessions.

## Entry points

- CLI `scotty automation add|ls|enable|run|rm`, `scotty runs [--automation name]`. API
  `/api/automations`, `/api/runs`. e2e: `npm run --silent e2e -- automations`.

## Drive

1. `automation add digest <owner/repo> "Summarise yesterday's commits" --cron "<m> <h> * * *"
--tz Asia/Kolkata`, with the time two minutes ahead in that zone; `automation ls` shows it off
   (A1). `automation enable digest`.
2. Wait for the minute; `runs --automation digest --json` into `02-runs.json`: one run, started,
   with a session (A2). `read <session>` answers; `runs` shows the turn completed.
3. `ls --search digest` finds the session; in the UI its header says "From automation digest"
   and links back (A3).
4. `connect webhook demo`; `automation add triage <owner/repo> "Look at {{issue.title}}" --on demo
--only action=opened,reopened`; enable it; POST a signed `{"action":"closed", …}`: the answer
   and `runs --automation triage` show it skipped, `not matched: action is "closed"` (A4).
5. `automation run triage`: skipped (no payload matches); `automation run digest`: started (A5).
6. Open Automations in the UI (A6). Clean up: `automation rm digest`, `automation rm triage`,
   `rm connection demo`.

## Gotchas

- A connection that any automation listens on hands every delivery to its automations; the
  `{repo, prompt, key}` body only starts a session on a connection none listens on.
- A run with no answer from its session is fired again every minute for an hour with the same
  run id (the start's retry key), then failed.
- `runs` keeps the last 500 runs; the list shows 100.
