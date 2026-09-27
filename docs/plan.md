# Rebuild plan

This is the work queue. A fresh agent session should be able to pick up the next step from this file alone, finish it, and prove it.

- [design.md](design.md) says what is being built. [setup.md](setup.md) says how to get a machine able to deploy and test.
- `@old` means the old implementation at commit `3042018` on `main`. Read an old file with `git show 3042018:<path>`. It is reference only.

## Rule zero: build the least code that passes the step

The old implementation died from weight: 229 fix commits, ~74k lines of tests, custom lint plugins, fences on fences. This rebuild wins only by staying small. **Every rule below is a reason to reject a diff, including your own.**

### What to write

1. **Only what the step's Done when needs.** If no Done-when item fails without a line of code, delete that line. "Might be useful later" is a rejection.
2. **Touch only the files the step lists.** Touching another file needs one sentence in the step's Status notes saying why. A step that grows past its **Budget** (added lines, excluding docs and saved logs) stops and asks the owner before continuing.
3. **No new abstraction without two real callers today.** No new interface, class, service, `Layer`, `Context.Tag`, factory, registry, plugin point, generic helper or wrapper module for one use. Inline it.
4. **No options nobody sets.** No flags, config keys, env vars, parameters with defaults "for flexibility", or feature toggles unless the step names them.
5. **No defensive code for impossible states.** Decode input once at the boundary (Schema), then trust the types. No re-validation, no `try/catch` around code that can't throw, no fallbacks for cases the fold already rules out.
6. **No retries, timers or backoff** except the deadlines in the fold's table (`src/session/fold.ts`). The DO has one alarm. Don't add a second.
7. **No new dependencies** unless the step names them. No `@effect/platform`, `@effect/schema`, `@cloudflare/sandbox`, fast-check, mocking or HTTP-stub libraries, ever.
8. **No compatibility code.** No shims for @old formats, no migration of old event logs, no dual code paths. A log-format change ships with a reset note in the commit.
9. **Reuse before adding.** Before writing a helper, `grep` for one. Before a new error class, reuse `CliFailure`, `AgentError`, `CredentialStoreError` or the API's `bad(...)`.
10. **Deleting beats adding.** If the step can be done by removing code, remove it.
11. **Comments say why, never what.** No JSDoc on obvious functions. No banner comments. No TODOs; open items go under **Later** here.
12. **Small files.** A file over ~250 lines or a function over ~60 lines needs a reason in the commit message.

### What to test

13. **Three kinds of test, no others:** (a) unit tests of `src/session/fold.ts`; (b) replays of saved event logs in `e2e/logs/`; (c) e2e against a real deployment in `e2e/`. Nothing else goes in `npm test`.
14. **No mocks** of Cloudflare, Codex, GitHub, ChatGPT or the network. No fake servers, no stubbed `fetch`, no in-memory DO doubles.
15. **No unit tests for** the CLI, the supervisor, the Worker routes, the Creds DO, `view.ts` or helpers. They are proved by e2e and the verify-scotty recipes.
16. **One test per behaviour.** Don't add a test that repeats what an existing test already fails on. No snapshot tests, no tests that read source text, no tests of private helpers.
17. **A bug gets exactly one new test:** its saved log plus a failing replay (see "When something breaks"), or one e2e assertion if the bug isn't in the fold.
18. **Scratch stays scratch.** Probes, fuzzers, spikes and mutation checks go in `work/` and are never committed.

### How to check yourself before committing

Run through this list and write the answers in your final report:

- `git diff --stat`: is every file in the step's **Touch** list? Is the added-line count within **Budget**?
- For every new exported symbol: `grep -rn '<name>' src cli container e2e protocol ui/src`. Does it have a caller outside its own file? If not, un-export or delete it.
- For every new test: which Done-when item or which bug does it prove? If none, delete it.
- For every new `if`, `catch` or `Option`: which real input reaches it? If none, delete it.
- Did you add anything the step didn't ask for? Move it under **Later** and remove it from the diff.

## Start here (every session)

1. Read `AGENTS.md`, `docs/design.md`, this file, and `docs/setup.md` if the machine isn't set up.
2. Run `git submodule update --init vendor/effect vendor/alchemy` if `vendor/` is empty. It is read-only reference source.
3. In **Status**, pick the first step that is `todo` and whose dependencies are all `done`. If a step is `in progress`, read its notes and continue it.
4. Set it to `in progress` in **Status** and commit that line with your first piece of work. Work directly on `rebuild/core`; never commit to `main`; never create a branch per step.
5. Before using any Effect or Alchemy API, find it in `vendor/effect` or `vendor/alchemy` and look at one test or example that uses it. Don't rely on memory or on Effect v3 docs.
6. Do only the step's **In scope** list. Anything else you notice goes on a new line under **Later**.
7. The step is done only when every **Done when** item has passed. Record the exact commands and results in **Status** notes and in the commit message.
8. If a design decision changes, update `docs/design.md` in the same commit.
9. Stop and report (don't work around) when: a check fails for a reason outside the step; a vendor API doesn't behave as its source says; a dependency conflict appears; the step needs an owner action (a browser sign-in, a secret, a paid-plan setting); or the budget is exceeded.

## Checks

Run all of these before every commit, in this order, and report each result. A check you couldn't run is reported as not run, with the reason.

```sh
npm run fmt              # oxfmt, rewrites files; commit the result
npm run lint             # oxlint, built-in rules only
npm run typecheck        # root tsc + ui
npm run ui:build         # builds ui/dist (the Worker serves it)
npm test                 # fold unit tests + replays (vitest)
```

Against the `dev` deployment (needs the env from `docs/setup.md`):

```sh
. work/dev-env.sh                        # your untracked env file (setup.md)
npm run deploy -- --stage dev            # copies the image, applies alchemy.run.ts
npm run --silent e2e -- core             # create, answer, redeploy, steer, interrupt
npm run --silent scotty -- doctor        # exit 0 with access/worker/chatgpt "ok"
```

- A change under `container/**` or `protocol/supervisor.ts` needs a new image: push `rebuild/core`, wait for the `image` workflow (`gh run watch`), take the digest from the run summary, set `SCOTTY_SOURCE_IMAGE=index.docker.io/yeshwanthyk/scotty@sha256:<digest>`, then deploy.
- Only stage `dev`. Never `production`, never `scotty-baseline-*`, never a derived name.
- Never print or save a token (ChatGPT, GitHub, Cloudflare, Docker Hub, Access JWT). Print variable names, lengths, SHA-256 prefixes or expiry only.
- Use a temp `CODEX_HOME` for any local Codex run; never touch `~/.codex`.
- Stage explicit paths (`git add <paths>`). Never `git commit -a`, never bare `git stash`.

## Status

Update this table in every commit that moves a step. Keep notes to commands, results and commit ids.

| Step | Title                                | Depends on | Status   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Repository setup                     | none       | done     | `742aa85`, `45fbc2c`. Pins: effect family `4.0.0-rc.117`, alchemy `2.0.0-beta.79`, vitest `5.0.2`, oxfmt `0.70.0`, oxlint `1.85.0`, typescript `7.0.2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1    | Spikes 1a–1e                         | 0          | done     | Results in `design.md` Open questions. 1e: chatgpt.com rejects all Worker/DO egress with 403; container egress works, so Codex calls chatgpt.com directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2    | Core loop                            | 1          | done     | `c68623e`…`f82cdb9`. On `dev`: `npm run e2e -- core` passes (create → `ready 0` → redeploy → steer → interrupt; cold start 2.3 s). verify-scotty core-loop C1–C5 pass (`work/verify/`). 27 tests (`npm test`) incl. replays `e2e/logs/reconnect-before-ready.jsonl`, `redial-alarm.jsonl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2b   | Agent-first CLI slice, verify skill  | 2          | done     | `7413f66`, `f82cdb9`: `doctor signin new ls show steer interrupt watch log`; `.agents/skills/verify-scotty` proven on `dev`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3    | Tidy what exists                     | 2b         | done     | `72f74c2` + owner-approved CLI/docs/recipe/log extension replaces `watch` with `read`. `npm run fmt`, `npm run lint`, `npm run typecheck`, `npm run ui:build`, `npm test`: pass (27). Dev: `npm run deploy -- --stage dev`, `npm run --silent e2e -- core` (2229 ms cold start), `npm run --silent scotty -- doctor`: pass. Missing-field curl: HTTP 400, `{"error":{"message":"Missing key\n  at [\"title\"]","code":"bad_request"}}`. `git ls-files deploy e2e/lib`: only deploy TS. verify-scotty C1–C5 + read bounds/roles/IDs/removal pass: `work/verify/step3-read-aFLnOa5H/` (2562 ms). Code net −481.                                                                                                                                                                                                                         |
| 3b   | Clear old leftovers outside `ui/`    | 3          | done     | `2f2a9fe`. `npm run fmt`, `npm run lint`, `npm run typecheck`, `npm run ui:build`, `npm test`: pass (27). Image CI `36292026877` passed; fresh digest set in `work/dev-env.sh`. After `. work/dev-env.sh`: `npm run deploy -- --stage dev`, `npm run --silent e2e -- core` (2235 ms cold start), `npm run --silent scotty -- doctor`: pass. `git ls-files \| grep gitkeep` and the documented `rg`: empty; `rg` excludes this plan's instructions and step 5's pending removals. `new octocat/Hello-World --base main`: exit 2; `new --help`: omits `--base`. `node work/verify/step3b-dnouTtJA/drive.mjs`: C1–C5 + read/flag checks pass (3536 ms); evidence in `work/verify/step3b-dnouTtJA/`. Extra path `.agents/skills/verify-scotty/features/core-loop.md`: verify-scotty requires a recipe for the removed flag. Code net −11. |
| 4    | ChatGPT refresh and sign-out         | 7          | deferred | Owner approved deferral; reassess after the trial. Manual `signin` remains the trial path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5    | Phone UI on the core                 | 3b         | todo     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6    | GitHub: private repos and push       | 3          | todo     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7    | Owner trial (gate)                   | 5, 6       | todo     | Owner action. Steps 8–12 are provisional until this step rewrites them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8    | Pause, resume, vaporize              | 7          | todo     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 9    | The rest of the UI API               | 8          | todo     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10   | `scotty deploy` and the compiled CLI | 7          | todo     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 11   | Previews, terminal, evidence         | 9          | todo     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12   | Cutover                              | 9, 10      | todo     | Needs the owner's approval before touching the old deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Step 3: tidy what exists

- **Why:** three rough edges hit during step 2. Fix them before anything new is built on top.
- **Depends on:** 2b.
- **In scope:**
  1. **Delete compiled leftovers.** `deploy/run.js`, `deploy/image.js` and `deploy/oci.js` are committed build output with no importer (`grep -rn 'run.js\|image.js\|oci.js' --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=work .` finds nothing). Delete them. Add `deploy/*.js` to `.gitignore` only if something regenerates them.
  2. **One HTTP client.** `e2e/lib/client.ts` duplicates `cli/client.ts` (Access token via `cloudflared`, JSON requests, error decoding). Make `e2e/core.ts` use `cli/client.ts`'s request function and schemas, and delete `e2e/lib/client.ts`. Change `cli/client.ts` only as much as the e2e needs (for example, exporting a function that already exists).
  3. **API 400s say what's wrong.** `POST /api/sessions` with a missing field returns a generic `bad_request`. In `src/http/api.ts`, when a body fails Schema decoding, put the decoder's message (field path and expectation) in `error.message`. Don't echo the body back. Use the existing `bad(...)` helper; add no new error type.
  4. **Replace watch with bounded reads (owner approved).** Delete `watch`. Add `read <id> --last N` (default 1, integer 1–500), optionally filtered by `--role user|assistant`. Return one JSON snapshot with session authority, the latest turn's ID/state, and up to N recent messages with stable IDs, role, state and text. Filter before limiting; omit empty assistant text. Preserve `show`. Use the existing conversation API; add no timers, follow mode or sequence cursors. Update the CLI docs and verification recipes, and add one CLI e2e assertion that reading an interrupted turn returns normally with `aborted` state.
- **Out of scope:** any other new command, any new route, refactors of files not listed.
- **Touch:** `deploy/*.js` (delete), `e2e/core.ts`, `e2e/lib/client.ts` (delete), `cli/client.ts`, `src/http/api.ts`, `cli/commands/watch.ts` (delete), `cli/commands/read.ts`, `cli/main.ts`, `e2e/logs/2026-09-26-watch-aborted.jsonl`, `docs/plan.md`, `docs/design.md`, `docs/setup.md`, `.agents/skills/verify-scotty/SKILL.md`, `.agents/skills/verify-scotty/features/core-loop.md`, `.agents/skills/verify-scotty/features/redeploy.md`.
- **Budget:** +60 added lines net; the step should delete more than it adds.
- **Done when:**
  - The checks pass.
  - `curl` (with the Access header from `cloudflared access token -app=$SCOTTY_URL`, not saved) `POST $SCOTTY_URL/api/sessions` with body `{"repo":"octocat/Hello-World"}` returns 400 and a message naming the missing field. Paste the response body (not the header) in Status notes.
  - After deploy, `npm run --silent e2e -- core` passes on `dev`.
  - `git ls-files deploy e2e/lib` lists no `.js` file and no `client.ts` under `e2e/lib`.
  - `read --last 1` returns at most one message and the latest turn state, including `aborted` after interrupt; `--role assistant` filters before limiting. Invalid bounds/roles exit 2. `watch` is absent from help and exits 2 when invoked. The updated verify-scotty core-loop recipe passes on dev.

## Step 3b: clear old leftovers outside `ui/`

- **Why:** an audit on 2026-09-26 (four read-only scouts, one per slice: UI views, UI data, core, repo meta) found a few leftovers outside `ui/`. They are small and independent of every later step, so clear them first. `ui/` leftovers are listed in step 5.
- **Depends on:** 3.
- **In scope:**
  1. Delete the placeholder files in non-empty directories: `cli/.gitkeep`, `container/supervisor/.gitkeep`, `e2e/logs/.gitkeep`, `src/creds/.gitkeep`, `src/session/.gitkeep`.
  2. `deploy/image.ts`: delete the exported `copy` wrapper (no caller; `deploy/run.ts` uses `copyImage` with `copyLayer`).
  3. `package.json`: remove the dev dependency `@effect/platform-node` (nothing imports it; Alchemy lists it only as an optional peer). Run `npm uninstall @effect/platform-node` so the lockfile follows, and prove the deploy still works.
  4. `src/http/api.ts`: remove `hardCapSeconds` from `Create`. It is accepted and never used, and no step implements a hard cap. The UI still sends it until step 5; Schema structs ignore extra keys, so this is safe to do first.
  5. `cli/commands/sessions.ts`: remove `new --base`. It is parsed and then always rejected as unsupported, and the API always uses the repository's default branch. Update `cli/main.ts` help and `docs/design.md` "CLI". If the trial needs a base branch, it becomes a step then.
  6. `docs/design.md`:
     - "Scope of v1" says sign-in is from the web UI and "the UI stays as it is". Say instead that sign-in is `scotty signin` today (the UI control is step 9) and that step 5 reduces the UI to the core flow.
     - "Layout": `src/worker.ts` serves `/api/*` and UI assets today. Mark `/p/github` as step 6 and preview routing as step 11. Mark `protocol/` as holding only `supervisor.ts`.
     - "API the UI needs": split the table into **served now** (`GET/POST /api/sessions`, `GET /api/sessions/:id`, `GET /conversation`, `GET /log`, `POST /steer`, `POST /interrupt`, `GET /api/credentials/chatgpt` + `start`/`poll`) and **planned**, each with its step: DELETE and sleep/resume/checkpoint → 8; changes, settings, repos → 9; hatch, evidence, terminal, resources → 11.
  7. Step 9 below: drop the sentence that makes `ui/src/protocol/` the unchangeable contract. After step 5, the surviving readers in `ui/src/data/` are the contract.
- **Out of scope:** anything in `ui/` (step 5); `deploy/**` beyond item 2 (step 10); the UI-shaped fields in `src/session/view.ts` (step 5 removes what the UI stops reading); the `provider` field (the CLI and UI both send it and the UI reads it back).
- **Touch:** the five `.gitkeep` files, `deploy/image.ts`, `package.json`, `package-lock.json`, `src/http/api.ts`, `cli/commands/sessions.ts`, `cli/main.ts`, `docs/design.md`, `docs/plan.md`.
- **Budget:** net negative lines of code.
- **Done when:**
  - The checks pass.
  - `git ls-files | grep gitkeep` prints nothing; `rg -n 'platform-node|hardCapSeconds' --glob '!vendor' --glob '!ui' --glob '!package-lock.json' --glob '!docs/plan.md' .` prints nothing.
  - On `dev`: `npm run deploy -- --stage dev` (proves the dependency removal) and `npm run --silent e2e -- core` pass.
  - `npm run --silent scotty -- new octocat/Hello-World --base main` exits 2 (unknown flag).

## Step 4: ChatGPT refresh and sign-out

- **Why:** the access token lives 10 days and the Creds DO refuses to hand out one with under 24 hours left. Today, when it expires, the owner must run `scotty signin` again.
- **Depends on:** 7 and owner reassessment.
- **Deferred:** the design below is provisional. Manual `scotty signin` covers the owner trial. Settle the lost-reply and network retry policy before activating this step.
- **Read first:** `design.md` "Credentials"; `src/creds/object.ts`, `src/creds/oauth.ts`; `work/spikes/1a/RESULT.md` (refresh request shape and rotation, if present locally); Codex `codex-rs/login/src/auth/manager.rs` refresh (`https://github.com/openai/codex`, tag `rust-v0.157.1`).
- **In scope:**
  1. `src/creds/oauth.ts`: add `refreshTokens(refreshToken)`: JSON `POST https://auth.openai.com/oauth/token` with `{grant_type: "refresh_token", client_id, refresh_token}`, Schema-decoded. Return the new access token, refresh token, ID token and expiry, or an `OAuthFailure` with HTTP status and upstream `error`/`code` (never token fields). Add `revoke(refreshToken)` for `https://auth.openai.com/oauth/revoke`. Follow the style of `exchangeCode`.
  2. `src/creds/object.ts`:
     - The DO's alarm fires at `expiresAt − 48h`, so `sessionToken()` (which needs ≥24h) always has a fresh token. On the alarm: mark a refresh as pending in storage, call `refreshTokens`, then in one storage write replace all tokens, **only if the stored refresh token is still the one that was sent**. Clear pending.
     - One refresh at a time: if a refresh is pending, `sessionToken()` does not start another. It returns the stored token if that still has ≥24h, otherwise `CredentialStoreError("ChatGPT sign-in expiring")`.
     - Permanent failure (401; 400 `invalid_grant`; `refresh_token_expired|reused|invalidated`) or an unclear result (lost reply, 200 without both tokens): delete the tokens, so status becomes `signed-out`. Never send the old refresh token again.
     - Transient failure (5xx, network): keep the tokens and set the alarm 15 minutes later.
     - Add `signOut()`: revoke the refresh token (ignore revoke failures), then delete the tokens.
  3. `src/http/api.ts`: `DELETE /api/credentials/chatgpt` → `signOut()`, and `POST /api/credentials/chatgpt/refresh` → run one refresh now and return `{status, expiresAt}` (this route exists so the e2e can prove refresh without waiting 8 days; it is Access-protected like every route).
  4. `cli/commands/setup.ts`: `scotty signout`. `doctor` already reports sign-in status (step 2b).
  5. `e2e/signin.ts` (register it in `e2e/run.ts`), which assumes a signed-in stage:
     - Call `/refresh` twice in a row: both succeed, `expiresAt` doesn't decrease, and the status stays `signed-in` (proves the rotated refresh token is stored and used).
     - After the refreshes, `npm run e2e -- core`'s create-and-answer part still works (the new access token works from the container). Reuse the core flow; don't copy it.
     - Fire two `/refresh` calls concurrently: both return `signed-in` and neither leaves the store signed out.
  6. Update `design.md` "Credentials" with the agreed refresh schedule, failure policy and `/refresh` route.
- **Out of scope:** a UI sign-in control (step 9), refreshing tokens already handed to a running session, GitHub.
- **Touch:** `src/creds/oauth.ts`, `src/creds/object.ts`, `src/http/api.ts`, `cli/commands/setup.ts`, `cli/main.ts`, `e2e/signin.ts`, `e2e/run.ts`, `docs/design.md`, `.agents/skills/verify-scotty/features/signin.md`.
- **Budget:** +250 lines.
- **Done when:**
  - The checks pass. No new unit tests: the Creds DO is proved by e2e (rule 15).
  - On `dev`: `npm run --silent e2e -- signin` passes, then `npm run --silent e2e -- core` passes.
  - `scotty signout`, then `scotty doctor` exits 3 with the hint `npm run --silent scotty -- signin`. The owner then signs in again (a browser step: stop and ask), and `doctor` exits 0.
  - `grep -rn 'access_token\|refresh_token' src cli e2e container | grep -v '^src/creds/'` finds nothing new.
  - The verify-scotty `signin` recipe is updated for `signout` and re-driven, with evidence in `work/verify/`.

## Step 5: the phone UI on the core

- **Why:** the trial (step 7) is phone-first. The UI shell is not served at its routes, and `ui/` still speaks the old API. Restore the shell, align the core flow with the API, and delete the old-only screens and what they leave unused.
- **Depends on:** 3b.
- **Known mismatches** (2026-09-26 audit, checked against source on 2026-09-27; only shell routing checked live so far):
  - Shell (browser and authenticated HTTP): `/` and `/sessions` return 404 while `/api/sessions` returns 200. Vite emits `/_shell.html`; the Worker has no SPA fallback. `/_shell.html` redirects to `/_shell`, which loads Scotty but shows Not Found.
  - Steer: `ui/src/data/conversation-client.ts` sends `message` (plus optional `images`, `deliverAs`, `clientUserMessageId`); the API needs `{text, turn, req?}`.
  - Interrupt: the UI sends `{turnId, sessionRevision}`; the API needs `{turn, req?}`.
  - Write responses: the UI expects `{id, status: "accepted", sessionRevision}`; the API returns operation statuses such as `pending` and `delivered`. Pending acknowledges a recorded request; an echoed user message alone is not proof of delivery.
  - Turn identity: conversation `turns[].id` is the request ID, while writes need the authoritative `state.currentTurn`, which the conversation view does not expose.
  - Create: `ui/src/data/session-creator.ts` sends `hardCapSeconds` and Pi images; the API takes `{title, repo, prompt, provider}`. The create response already matches.
  - The new-session form reads `/api/repos` (not served) for its repository list; manual `owner/repo` fallback works. Its optional settings button uses local form options, not `/api/settings`. The create response matches.
- **In scope:**
  1. **Confirm in the browser first.** Deploy `dev`, open it in a real browser at 390×844, and record in Status notes each screen and request that fails. Drive the browser with the `computer-use` skill. The page is behind Cloudflare Access: if the browser shows an Access login, stop and ask the owner to log in there (a browser step). Don't add Playwright or another browser dependency.
  2. **Serve the shell, then fix the core flow:** align `ui/vite.config.ts`'s shell entrypoint and `src/worker.ts`'s asset fallback with Cloudflare SPA serving. Use the vendored `AssetsConfig`'s `notFoundHandling` and `runWorkerFirst` options so `/api/*` still reaches the Worker; add no server. Then fix the session list, the new-session form (public repository and prompt; Codex only; no base branch, no images, no hard cap, no repository picker), and the session page with the conversation, steer and interrupt. Adapt the UI's writes and response handling to the API's actual statuses; pending remains pending. Use authoritative `currentTurn` for writes, preserve stable message IDs, and add no array-length reconstruction or log-polling layer.
  3. **Delete old-only screens and their components:**
     - Routes: `routes/devices.tsx`, `routes/providers.tsx`, `routes/stats.tsx`, `routes/settings.tsx`. Regenerate `routeTree.gen.ts` with `npm run generate-routes --workspace @scotty/ui`; don't edit it by hand.
     - Components used only by those routes: `AdminPage.tsx`, `SettingsShell.tsx`, `ResourcesSection.tsx`.
     - Components with no backend: `ImageAttachments.tsx`, `Terminal.tsx` (terminal is step 11), `PierreDiff.tsx` (diff is step 9), and `SessionSelection.tsx` (Claude/Pi/provider labels). Rebuild these in their own steps if still needed; don't keep old code for them.
  4. **Strip old parts from the files that stay:**
     - `Sidebar.tsx`: the admin links and the principal/owner check (`readCurrentPrincipal`).
     - `s.$sessionId.tsx`, `SessionMenu.tsx`, `SessionRow.tsx`, `SessionSwitcher.tsx`: the lifecycle controls (sleep, resume, checkpoint, vaporize) and the selection labels.
     - `data/session-reader.ts`, `data/session-catalog-controller.ts`: selection parsing and equality checks left by those removals.
     - `SessionWorkbench.tsx`: everything except the conversation (the Summary, Diff, Terminal, Hatch and Evidence panels).
     - `LiveConversation.tsx`, `Conversation.tsx`, `MarkdownImage.tsx`: images, evidence, and queued follow-ups.
     - `CreateSessionForm.tsx`: images, settings links, the repository lookup, and the hard cap.
     - `workspace.css`: the selectors that no remaining element uses.
  5. **Delete the data layer those removals orphan:** `data/admin.ts`, `data/settings.ts`, `data/settings-preview.ts`, `data/session-lifecycle.ts`, `data/session-workbench.ts`, `data/image-attachments.ts`, `data/resource-files.ts`, `domain/session-lifecycle-reconciliation.ts`, `fixtures/settings.ts`, and all of `ui/src/protocol/` except `session/conversation.ts`. Remove fixture fallbacks and demo content from `fixtures/sessions.ts`, `fixtures/conversation.ts` and `fixtures/markdown.ts` unless a remaining screen needs them. Remove the synthetic `session-rail.ts` import/branch and `ConversationPreview` if its session-route fixture caller is removed. Before deleting each file, `grep` for its importers.
  6. **Delete the UI dependencies nothing imports afterwards:** `@pierre/diffs`, `@xterm/xterm` and `@xterm/addon-fit` only if orphaned. Keep `mermaid`: `Markdown.tsx` uses `MermaidDiagram` in the core conversation. Remove orphaned packages with `npm uninstall --workspace @scotty/ui <name>`.
  7. **Server side:** expose authoritative `currentTurn` in `conversationView` and its decoder for steer and interrupt. Remove other fields from `src/session/view.ts` only if no remaining UI reader, `cli/client.ts` schema or `e2e/` assertion reads them (capabilities, cap time, transport counters, queue, truncation, if unused).
  8. Add `.agents/skills/verify-scotty/features/ui.md`: a browser recipe at 390×844. Create on `octocat/Hello-World`, see the answer, steer, interrupt, reload, and check that the list matches the session page.
- **Out of scope:** the ChatGPT sign-in control (the CLI's `signin` covers it), changes/diff, lifecycle actions, new UI features or restyling, and a browser e2e dependency.
- **Touch:** `ui/src/**`, `ui/vite.config.ts`, `ui/package.json`, `package-lock.json`, `src/worker.ts`, `src/session/view.ts`, `cli/client.ts` (only if changed view fields affect its schemas), `docs/design.md` ("API the UI needs"), `.agents/skills/verify-scotty/features/ui.md`, `.agents/skills/verify-scotty/SKILL.md`.
- **Budget:** +150 added lines outside `ui/`. `ui/` must shrink in net lines; expect several thousand lines to go.
- **Done when:**
  - The checks pass. On `dev`: `npm run --silent e2e -- core` passes.
  - The `ui` recipe is driven in a real browser on `dev`, with screenshots and results in `work/verify/`.
  - Root, session list, create and a direct session URL reload all load the UI. An unknown `/api/*` route still returns a JSON 404 from the Worker.
  - No UI request returns 404. Prove it one of two ways: save the browser's network log with the evidence; or list every path the UI still calls (`rg -o "/api/[A-Za-z0-9/_.{}$()-]*" ui/src | sort -u`) and `curl` each with the Access header (`cf-access-token: $(cloudflared access token -app=$SCOTTY_URL)`, never saved), recording each status code.
  - Every file listed for deletion in items 3 and 5 is gone; `ls ui/src/protocol` shows only `session/`.
  - `rg -ni -e 'claude|pi-console|resource|hatch|evidence|runner|pairing|principal|sleep|vaporize' ui/src` finds nothing, or each remaining hit is explained in Status notes.

## Step 6: GitHub, private repositories and push

- **Why:** real work happens in private repositories and has to leave the container as a pushed branch. Without this, the trial can only exercise public repositories and loses its work.
- **Depends on:** 3.
- **In scope:** clone and push private repositories. The container never sees the GitHub token.
- **Build:**
  - Creds DO: store one GitHub token (`POST /api/credentials/github`, write-only; `GET` returns only `{status}`).
  - `/p/github/*` in `src/creds/swap.ts`: only smart-HTTP paths (`info/refs`, `git-upload-pack`, `git-receive-pack`) for the session's own repository; check a per-session sentinel in constant time; strip incoming auth and hop-by-hop headers; add the real token; forward to `https://github.com`. Port header cleanup from `git show 3042018:worker/src/egress/worker.ts` lines 95–123 and 428–443.
  - Supervisor: `git config url."https://<host>/p/github/".insteadOf https://github.com/` and a credential helper that prints the sentinel.
  - How the container reaches `/p/github` behind Access is an open question. Try `interceptOutboundHttp` (`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/Container.ts:149`) with a plain-http internal host first. Spike it in `work/spikes/6a/` and write the result into `design.md` before building.
  - `e2e/github.ts`: clone a private test repository (the owner names it; the test reads it from `SCOTTY_PRIVATE_TEST_REPO`), commit, push to `scotty/<id>`, check the branch exists with `gh api`, then delete the branch.
- **Done when:** `e2e -- github` and `e2e -- core` pass on `dev`; a scan of the container's env, files, process arguments and git config (names only, lengths, hashes) shows no GitHub token.

## Step 7: owner trial (gate)

- **Depends on:** 5, 6. This step is the owner's; an agent only supports it.
- **In scope:**
  - The owner uses `dev` for real work for a few days: sessions on their real repositories from the phone UI and from the CLI, steering, interrupting, reconnecting, pushing a branch, and a redeploy mid-session.
  - An agent fixes only what blocks that use, each fix with a saved log and replay if it is in the fold ("When something breaks").
  - Record what felt slow, confusing or missing in this step's Status notes, in the owner's words.
- **Then:** with the owner, reassess deferred step 4 and rewrite steps 8–12 to the minimum the trial showed is needed. Steps may be cut, merged, reordered or moved to **Later**. No step after this starts before that rewrite is committed.
- **Done when:** the owner says the trial is done and the rewrite of steps 8–12 is committed.

## Step 8: pause, resume, vaporize (provisional)

- **Depends on:** 7.
- **Build:** the events already in `design.md` (`pause.requested` … `gone`) with fold deadlines; pause = push WIP branch, save the Codex rollout file to R2, stop the container; resume = start, clone, restore rollout, `thread/resume`; vaporize = destroy the container, delete R2 objects and the branch. `scotty sleep|resume|vaporize <id>`.
- **Done when:** e2e `pause-resume` (a marker file and the Codex thread survive), `vaporize` (nothing remains; running it twice is safe), and `kill` (container killed mid-turn and mid-pause ends in a correct state with no `invariant.violated`) pass on `dev`, plus `core`. The failed sessions left on `dev` by earlier steps are vaporized.

## Step 9: the rest of the UI API (provisional)

- **Depends on:** 8.
- **Contract:** step 5 left only the core flow; its readers in `ui/src/data/` are the contract. This step builds back only the screens the trial asked for, each written against the new API (not restored from `3042018`), and adds a ChatGPT sign-in control.
- **Build:** `view.ts` for every shape the UI reads; the session index; `changes`, `settings`, `repos`, `checkpoint`.
- **Done when:** `e2e -- ui` (a browser at 390×844: create, watch the answer stream in, steer, open the diff) passes, and the list matches each detail view.

## Step 10: `scotty deploy` and the compiled CLI (provisional)

- **Depends on:** 7.
- **Build:** `scotty deploy --stage <stage>` replaces `npm run deploy` (same image copy, then the Alchemy apply); `bun build cli/main.ts --compile`; the CLI embeds the default image digest.
- **Done when:** `scotty deploy --stage dev` then `e2e -- core` pass; `new` twice with the same `--key` creates one session.

## Step 11: previews, terminal, evidence (provisional)

- **Depends on:** 9.
- **Previews:** `<port>-<id>-<nonce>.<previewBase>` → Session DO → `getTcpPort(port)`, behind Access. **Terminal:** a PTY in the supervisor relayed Worker → DO → container. **Evidence:** results are session events.
- **Done when:** a preview opens on a phone (HTTP and WebSocket), the terminal shows output, and evidence renders in the UI.

## Step 12: cutover (provisional)

- **Depends on:** 9, 10.
- **In scope:** deploy to the owner's chosen stage and domain, run every e2e, merge `rebuild/core` into `main` with the owner's approval.
- **Out of scope without explicit approval:** tearing down or changing the old deployment.

## Later

Each item gets its own step before anyone builds it.

- A running session whose ChatGPT token expires mid-session (sessions longer than ~24h): hand it a fresh token on reconnect.
- The agent can read the ChatGPT token from `config.toml` (accepted risk, `design.md` "Credentials"). Revisit if chatgpt.com ever accepts Worker egress again.
- Claude, Pi and custom providers.
- `gh` inside the container.
- User-supplied images, checked against the supervisor contract at `hello`.

## Review rules

Every commit is checked against these and Rule zero.

- **R1.** In `src/session/object.ts` and `src/creds/object.ts`, nothing awaits an outside call (container, R2, fetch, another DO) between reading state and appending the event.
- **R2.** Every outside action has an intent event, a result event and a deadline in the fold.
- **R3.** Real secrets appear only under `src/creds/`, plus the one documented exception (the ChatGPT access token in the container's `config.toml`). Search the diff for `access_token`, `refresh_token`, `ghp_`, `github_pat_`, `Authorization`.
- **R4.** Boundary input is decoded with Schema: HTTP, WebSocket messages, R2 objects, OAuth responses, CLI arguments. No `any`, no casts that hide a type, no `!`.
- **R5.** Stage, account and repository names come from explicit input only.
- **R6.** No compatibility code for @old formats.
- **R7.** Tests follow rules 13–18.
- **R8.** The step's e2e ran on `dev`, and the commit message records the command and result.

## Mistake ledger

The old reliability board (`docs/reliability.md:75-87` @old) counted 229 fix commits. Each row names the cause and the rule that removes it.

| #   | Old failure class                | Cause                                                                                        | Rule now                                                                                |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| M1  | Lifecycle fencing (79 fixes)     | Handlers awaited outside calls mid-transition; alarms, callbacks and retries ran in between. | Append → fold → at most one command. Outside actions are intent + result events. R1, R2 |
| M2  | Several timers                   | Alarms and timeouts tuned independently.                                                     | One alarm, derived from the fold's deadline table.                                      |
| M3  | Provider contract drift (36)     | Mocks hid real behaviour; SDK shapes leaked into the core.                                   | No mocks; e2e on a real deployment; agent events interpreted only in `view.ts`.         |
| M4  | Disk backup and restore          | Full-disk backup under a hard time cap.                                                      | No disk backups: WIP branch plus the Codex rollout file.                                |
| M5  | Deploy and artifact skew (30)    | Two deploy paths, rollout watchers, patched Alchemy.                                         | One deploy path, unpatched Alchemy, image by digest.                                    |
| M6  | Evidence lifecycle (29)          | Recorder, R2 and UI settled independently.                                                   | Evidence results are session events (step 11).                                          |
| M7  | Credential authority (21)        | Registry, vault, rotation, grants, sync and migrations overlapped.                           | One Creds DO. One documented exception. R3                                              |
| M8  | UI projection drift (17)         | The list trusted best-effort KV.                                                             | No KV; the list reads the index plus each DO's view.                                    |
| M9  | CLI (13)                         | Local journals; recovery by matching error text.                                             | The CLI stores nothing; retries use `--key`/`--req`.                                    |
| M10 | Compatibility code (4 reverts)   | Contract changes went through compatibility branches.                                        | No compatibility code. R6                                                               |
| M11 | Process heavier than the product | Custom lint skills, formal models, the board, ~74k lines of tests.                           | Rule zero.                                                                              |

## When something breaks

1. Save the session's event log (`npm run --silent scotty -- log <id>`) to `e2e/logs/<yyyy-mm-dd>-<short-name>.jsonl` before fixing anything. Check it holds no token first.
2. If the bug is in the fold: add one replay test that fails on it. Otherwise: add one e2e assertion that fails on it.
3. Fix the bug. It is fixed when that test passes and `npm run e2e -- core` passes on `dev`.
4. If the bug fits a ledger row, name the row in the commit message.
