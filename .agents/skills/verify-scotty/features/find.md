# Find sessions

The session list is grouped by recency, filtered, and searchable from the CLI, the API and Cmd-K.

## Behaviours

- **N1** `ls --search <text>` and `GET /api/sessions?q=<text>` return only sessions whose title,
  repository, branch, whole first prompt, key or hook connection contains the text, ignoring
  case; no match is an empty list. A text over 200 characters is a 400 with that message.
- **N2** The sidebar groups sessions Today / This week / Older. Running hides stopped and failed
  sessions; Mine shows those started from the UI, CLI or API; Automations those a hook started.
- **N3** A session stopped for over 7 days is under Archived, which starts collapsed.
- **N4** Cmd-K finds a session by a word of its first prompt and opens it; choosing a repository
  limits the sidebar to that repository and shows a chip that clears it.

## Entry points

- CLI `scotty ls --search`. e2e: `npm run --silent e2e -- core` (asserts N1). Browser at 390×844
  and at desktop width for N2–N4; `npm run ui:dev` shows seeded sessions in every group.

## Drive

1. From a ready [core-loop](core-loop.md) session, `ls --search <part of its title>` into
   `01-title.json` lists it; `ls --search <its repo>` into `02-repo.json` lists it;
   `ls --search zzz-nothing` into `03-none.json` has `sessions: []` (N1).
2. Open `/sessions` and screenshot the list at both widths: groups in order, titles whole where
   there is room (N2). Choose Running and screenshot: only live sessions remain. Choose
   Automations: only sessions a hook made (in `npm run ui:dev`, the two from `sentry`). Choose
   Mine: those sessions are gone and the rest are back.
3. Expand Archived (N3); it lists only sessions stopped over 7 days ago.
4. Press Cmd-K, type a word from a session's prompt that is not in its title, and open it (N4).
   Type a repository name, choose it, and screenshot the filtered sidebar: a chip with the
   repository's name and × sits after the filters. Click it; every repository is back.
5. From a [hooks](hooks.md) session, `ls --search <its key>` and `ls --search <its connection>`
   list it (N1).

## Gotchas

- Search reads the text the Creds DO stored when each session was made; a session made before
  that was stored is listed but never matches a search.
