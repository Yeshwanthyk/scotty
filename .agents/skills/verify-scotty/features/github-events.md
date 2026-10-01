# GitHub events and babysit

A GitHub connection hands verified events to automations. Babysit uses the PR session's
`gh:<repo>#<number>` key to steer it when a check fails. The payload is GitHub's JSON with
`event` supplied by `X-GitHub-Event`; dotted paths reach array elements with `.0`.

## Prove it

On an already deployed stage, run `npm run --silent e2e -- github`. Its GitHub-event portion
uses a scripted fixture session and signs payloads itself; no real webhook is required. A
stored GitHub token is required to prove skipping its stored login. The remaining GitHub test
also uses `SCOTTY_PRIVATE_TEST_REPO` and `gh` to prove private-repo pushes. Pass when:

- A generated GitHub connection secret is shown once; listings show its hook URL.
- A signed `check_run` failure makes one run marked `steered`, linked to the keyed session,
  which completes a second turn with the rendered PR number.
- Redelivery of the same `X-GitHub-Delivery` is `duplicate` with no new run or session event.
- A bad signature is HTTP 401 and listed as `rejected: bad_signature`.
- A sender equal to the stored GitHub login is listed as `skipped: own_github_identity`,
  with no session, run or turn from that delivery.
- A verified delivery with no listening automation is `skipped: no_automation`, with no
  session or run from that delivery.

## Owner setup

1. `scotty connect github github-events`: paste its URL and whole secret into GitHub's webhook
   settings. Use `application/json` and subscribe to check runs. Keep the one-time secret out
   of evidence files. `scotty connections` shows the URL again.
2. Create the PR session:
   `scotty new owner/repo "Work on PR #42" --session-key 'gh:owner/repo#42'`.
3. Add the disabled babysit automation, then enable it:

   ```sh
   scotty automation add babysit owner/repo \
     'Fix the failed check {{check_run.name}} for PR #{{check_run.pull_requests.0.number}}: {{check_run.html_url}}' \
     --on github-events --only event=check_run --only action=completed \
     --only check_run.conclusion=failure \
     --key 'gh:{{repository.full_name}}#{{check_run.pull_requests.0.number}}'
   scotty automation enable babysit
   ```

4. Deliver a check failure from another GitHub login. For a synthetic POST, sign the exact body
   bytes with HMAC-SHA256 keyed by the full displayed secret, and set these headers:
   `X-Hub-Signature-256: sha256=<hex>`, `X-GitHub-Delivery: <unique-id>` and
   `X-GitHub-Event: check_run`. Include `action: completed`, `repository.full_name: owner/repo`,
   `check_run.conclusion: failure`, `check_run.pull_requests: [{number: 42}]`, the check's `name`
   and `html_url`, and `sender.login` unequal to the stored login.
5. Read `scotty deliveries --connection github-events`, `scotty runs --automation babysit`,
   `scotty read <session>` and `scotty log <session>` into evidence. Check the same session got
   the second turn. Repeat the id, then use a wrong signature and the stored login as sender;
   verify the outcomes above. Save the session log even on failure.
6. In Settings → Connections, the connection's URL and accepted/skipped deliveries are visible;
   accepted deliveries link to their session. `npm run ui:dev` seeds these states locally.
   Clean up only this run's sessions, automation and connection.

## Find what broke

- HTTP 302 means `/hooks/*` lacks its Access bypass. HTTP 404 is a recorded
  `unknown_connection`; check the name and `scotty connections`.
- HTTP 400 `missing_headers` means a required header is absent, empty or an id/event is too
  long. `bad_body` means unreadable JSON or a payload that is not an object. HTTP 413 means the raw body exceeded 64 KiB.
- HTTP 401 `bad_signature`: sign the exact raw bytes using the secret as text, including
  `whsec_`; do not use Standard Webhooks' base64 key decoding or id/timestamp signing string.
- `own_github_identity` comes only from the token's stored login. Check Settings → Accounts or
  `scotty doctor`; with no token stored, no sender is dropped.
- An accepted delivery with a skipped run: `scotty runs` reports the filter or missing template
  field. Checks without PRs lack `check_run.pull_requests.0.number`. `skipped: no_automation`
  means no automation listens on that connection.
- A failed run: compare the rendered PR key, repo and agent with the existing session. Session
  logs show whether a prompt was taken; a run still `received` has no known answer yet.
