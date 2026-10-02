# Blueprints

A blueprint is a JSON file of connections and automations for one use. Installing one makes them
through the ordinary API, all off, and shows the hook URLs and secrets to paste into the provider.
Two ship in `blueprints/`: `pr-reviewer.json` (GitHub) and `linear.json` (Linear).

## Behaviours

- **B1** `scotty blueprint install <file> --repo <owner/repo>` (or `--target <name>=<owner/repo>`,
  repeated, for a blueprint with targets) and Settings → Blueprints refuse a missing required
  secret, a missing repo or targets, or a target that names no valid automation, before anything
  is made. The refusal names the connection and the question, never a secret, and shows the hook
  URLs to set up first.
- **B2** A name that already exists stops the install before anything is made.
- **B3** Install creates every connection and automation, the automations off, for the chosen repo
  and agent. It shows each hook URL, any generated secret once, the setup text and the MCP sign-in
  still needed. Nothing else is printed, and pasted secrets are never echoed.
- **B4** PR reviewer, once enabled: a signed `pull_request` opened starts a session keyed by the PR
  on its head branch. An `issue_comment` on the PR wakes that session, and `closed` ends it.
- **B5** Linear, installed with targets (a label → repo each), makes its three automations once per
  target, named after the label. Once enabled: an Issue created or updated with a target's label
  added starts a session in that target's repo through that target's automation, keyed by the
  issue id, which reads through the Linear MCP connection. Other updates and other targets'
  automations are skipped runs. An update to state type `completed` or `canceled` ends it through
  that target's end automation.

## Entry points

- CLI `scotty blueprint install`, with secrets piped on stdin as one JSON object of connection
  name to secret. UI Settings → Blueprints. e2e: `npm run --silent e2e -- blueprints`.

## Drive

1. `scotty blueprint install blueprints/pr-reviewer.json --repo <owner/repo> </dev/null`: refused,
   naming `github-api` and showing the `github-prs` hook URL; `automation ls` shows nothing new (B1).
2. Pipe `{"github-api": "<token>"}` from a file: the output lists `github-prs` with its URL and a
   secret shown once, `github-api`, and the three automations off (B3). Run it again: refused with
   `Already exists` (B2).
3. In Settings → Blueprints, choose Linear. It asks for targets (name → repo rows) instead of a
   repo, and Install is disabled until the signing secret and a target are filled. Install it with
   two targets. The sheet shows the hook URL, setup text and a Connect button for `linear`. The
   Automations page lists six off, three per target (B1, B3, B5).
4. Set `SCOTTY_URL` to a test stage with `mcpOAuthTest` and run `npm run --silent e2e --
blueprints` (B4, B5). It installs both with this run's own names and the scripted agent, then
   enables them. It drives:
   - **PR reviewer.** Signed opened, comment and closed deliveries. It checks the review turn, the
     session's `automation-base` head branch, the comment's wake, and the `container.stopped`
     with reason `ended`.
   - **Linear.** Two targets, `e2e:a` and `e2e:b`, both on the fixture repo. Signed deliveries
     pointed at the MCP test server: create without a target's label (skipped), `e2e:b` added
     (started by `linear-labelled-e2e-b-…`, A's skipped, MCP `read` result in the log), an edit
     (skipped) and completed (ended by `linear-done-e2e-b-…`, A's skipped).
5. Clean up: `automation rm` each automation and `rm connection` each connection made.

## Gotchas

- The installer does not enable anything; `scotty automation enable <name>` or the toggle does.
- `${target}` is filled in at install (names get its slug); `{{…}}` is filled from each payload.
- "Label added" is `updatedFrom.labelIds` present and the label in `data.labels`. Any later
  label change on a labelled issue wakes its session again.
- GitHub deliveries sent by the owner's own GitHub login are self-events and skip, so the owner's
  own PR comments do not wake the review. Fork PR head branches are not in the repo.
- `contains ""` matches a present field; a list or object field is matched on its JSON text.

## Diagnosis

- `runs --automation <name> --json` names the failed filter or missing template field.
- A refused install prints which connections or automations it made before a failure; remove
  them by name before retrying.
