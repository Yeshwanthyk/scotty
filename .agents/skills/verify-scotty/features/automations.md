# Automations

An automation starts, wakes or ends a keyed session on a schedule or webhook delivery. Every
firing is a run: skipped (and why), started, steered, ended or failed. Prompt runs show the turn outcome.

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
- **A7** `wake` and `end` without a key's session skip with `no_session` and create nothing.
- **A8** `end` stops and releases the key. A later `wake` skips and `start` makes a different
  session. The old one remains listed, readable and resumable by an owner message. Retrying
  the end delivery keeps its ended run and appends nothing after the owner resumes it.
- **A9** `only` and `except` share equality, one-of and string contains; every rule in a filter
  must match. The first failed only rule or matched except rules appear in the skip reason.
- **A10** A rendered branch is the new session's base, with work on `scotty/<id>`; a missing
  branch template field is a skip. Wake and start-to-existing leave the session's branch alone.

## Entry points

- CLI `scotty automation add|ls|enable|run|rm`, `scotty runs [--automation name]`. API
  `/api/automations`, `/api/runs`. e2e: `npm run --silent e2e -- automations`.

## Drive

1. `automation add digest <owner/repo> "Summarise yesterday's commits" --cron "<m> <h> * * *"
--tz Asia/Kolkata`, with the time two minutes ahead in that zone; `automation ls` shows it off
   (A1). `automation enable digest`.
2. Wait for the minute; `runs --automation digest --json` into `02-runs.json`: one run, started,
   with a session (A2). `read <session>` answers; `runs` shows the turn completed.
3. `ls --search digest` finds the session; in the UI its header's second line says "via digest"
   and links back (A3).
4. `connect standard-webhooks demo`; `automation add triage <owner/repo> "Look at {{issue.title}}" --on demo
--only action=opened,reopened`; enable it; POST a signed `{"action":"closed", …}`: the answer
   and `runs --automation triage` show it skipped, `not matched: action is "closed"` (A4).
5. `automation run triage`: skipped (no payload matches); `automation run digest`: started (A5).
6. Open Automations in the UI (A6). Clean up: `automation rm digest`, `automation rm triage`,
   `rm connection demo`.
7. Run `npm run --silent e2e -- automations` against `track` after an image rebuild containing
   the fixture's `automation-base` branch (A7–A10). It signs its own deliveries, checks the
   branch's different commit, filters, key release and owner resume. It sends the end request
   id directly through `/api/sessions/:id/stop` with `Idempotency-Key` after resume to prove DO
   dedupe, refuses an end for a different repo, and replays old starts and ends after run pruning.
8. In the editor or CLI, try `--only 'issue.title=~issue' --except 'issue.title=~[skip]'`
   and `--branch '{{issue.branch}}'` on an event automation. A title without `issue`, one with
   `[skip]`, and an otherwise matched payload missing `issue.branch` each list a specific skip.
   The JSON API represents contains as `{kind: "contains", value: "issue"}` (A9–A10).
9. Load and save an unchanged automation with equality `"~urgent"`, equality `"a,b"`, a
   one-element one-of list and contains text with a newline. Read it back from the API: `only`
   and `except` must be identical. The editor quotes literals and uses JSON arrays for one-of.

## Gotchas

- A connection that any automation listens on hands every delivery to its automations; the
  `{repo, prompt, key}` body only starts a session on a connection none listens on.
- A run with no answer from its session is fired again every minute for an hour with the same
  run id (the start's retry key), then failed.
- `runs` keeps the last 500 runs; the list shows 100.
- Missing key fields skip before lookup; an omitted key on wake or end gives `no_session`.
- An end for a reserved but uncreated session skips with `no_session`; the webhook returns 200.
  If the session is then created, it runs until it idles or is stopped. A failed session counts
  as ended after its stop is recorded, retaining its failure behavior.
- `end` currently uses the ordinary stop path. Its `ended` stop reason waits for the owner's
  session-lifecycle merge; the run itself already says `ended`.

## Diagnosis

- A skip names the failed rule or missing template field in `runs --automation <name> --json`.
- If an end remains received, inspect `log <session>` for `container.stopped` with
  `req: run:<run-id>`; the same run retries that target. An unknown result stays pending.
- If the next start reuses the old session, key release failed: inspect the ended run's session
  and the old session's stop request. Both sessions must remain in `ls` after a successful release.
- If branch checkout fails, read `created.baseBranch`, `workspace.ready` and `sup.error` in
  the log; the fixture branch requires the rebuilt image. The work branch stays `scotty/<id>`.
