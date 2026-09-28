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

| Step | Title                                | Depends on | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------ | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Repository setup                     | none       | done        | `742aa85`, `45fbc2c`. Pins: effect family `4.0.0-rc.117`, alchemy `2.0.0-beta.79`, vitest `5.0.2`, oxfmt `0.70.0`, oxlint `1.85.0`, typescript `7.0.2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 1    | Spikes 1a–1e                         | 0          | done        | Results in `design.md` Open questions. 1e: chatgpt.com rejects all Worker/DO egress with 403; container egress works, so Codex calls chatgpt.com directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2    | Core loop                            | 1          | done        | `c68623e`…`f82cdb9`. On `dev`: `npm run e2e -- core` passes (create → `ready 0` → redeploy → steer → interrupt; cold start 2.3 s). verify-scotty core-loop C1–C5 pass (`work/verify/`). 27 tests (`npm test`) incl. replays `e2e/logs/reconnect-before-ready.jsonl`, `redial-alarm.jsonl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2b   | Agent-first CLI slice, verify skill  | 2          | done        | `7413f66`, `f82cdb9`: `doctor signin new ls show steer interrupt watch log`; `.agents/skills/verify-scotty` proven on `dev`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3    | Tidy what exists                     | 2b         | done        | `72f74c2` + owner-approved CLI/docs/recipe/log extension replaces `watch` with `read`. `npm run fmt`, `npm run lint`, `npm run typecheck`, `npm run ui:build`, `npm test`: pass (27). Dev: `npm run deploy -- --stage dev`, `npm run --silent e2e -- core` (2229 ms cold start), `npm run --silent scotty -- doctor`: pass. Missing-field curl: HTTP 400, `{"error":{"message":"Missing key\n  at [\"title\"]","code":"bad_request"}}`. `git ls-files deploy e2e/lib`: only deploy TS. verify-scotty C1–C5 + read bounds/roles/IDs/removal pass: `work/verify/step3-read-aFLnOa5H/` (2562 ms). Code net −481.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3b   | Clear old leftovers outside `ui/`    | 3          | done        | `2f2a9fe`. `npm run fmt`, `npm run lint`, `npm run typecheck`, `npm run ui:build`, `npm test`: pass (27). Image CI `36292026877` passed; fresh digest set in `work/dev-env.sh`. After `. work/dev-env.sh`: `npm run deploy -- --stage dev`, `npm run --silent e2e -- core` (2235 ms cold start), `npm run --silent scotty -- doctor`: pass. `git ls-files \| grep gitkeep` and the documented `rg`: empty; `rg` excludes this plan's instructions and step 5's pending removals. `new octocat/Hello-World --base main`: exit 2; `new --help`: omits `--base`. `node work/verify/step3b-dnouTtJA/drive.mjs`: C1–C5 + read/flag checks pass (3536 ms); evidence in `work/verify/step3b-dnouTtJA/`. Extra path `.agents/skills/verify-scotty/features/core-loop.md`: verify-scotty requires a recipe for the removed flag. Code net −11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4    | ChatGPT refresh and sign-out         | 5          | deferred    | Owner approved deferral. Manual `auth login chatgpt` remains the path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5    | Phone UI on the core                 | 3b         | done        | Owner accepted replacing the old UI with a minimal one (see step 5 Owner decision). `npm run fmt`, `npm run lint`, `npm run typecheck`, `npm run ui:build`, `npm test` (27): pass. `dev`: `e2e -- core` pass (cold start 2415 ms); `doctor` ok. `/`, `/sessions`, `/sessions/create`, `/s/abc`: 200 text/html; `/api/nope`: 404 JSON (was 404 on all UI routes). Every UI path (`/api/sessions`, `/<id>`, `/<id>/conversation`, `steer`, `interrupt`) with a real ID: 200; a stale turn returns `{"status":"stale"}`, which the UI keeps as not sent. Browser: the owner drove list, create, steer, interrupt on `dev` ("ok it worked"); computer-use could not see Helium windows, so no U2–U5 screenshots. `rg` sweep: no hits; `ui/src/protocol` has only `session/`. Reviews: Astra (drafts cleared on stale, no idempotency keys, state across session navigation) and Opus (unused exports, `_id`, lucide-react) fixed. Diff: `ui/` −15,103/+444; outside `ui/` +8/−714 (`src/session/object.ts` changed for the `conversationView` signature). Also touched `.agents/skills/verify-scotty/features/README.md` to index the `ui` recipe. Evidence: `work/verify/step5-ui/`.                                                                                                                                                                                                                                                                                                                                            |
| 6    | Sessions that stop and resume        | 5          | done        | A `c13f0aa` (stopped, `scotty stop`, `session_index`), B `dc833d4` (save to R2), C `dd0d8f6` (resume, e2e stop-resume), dev fixes `7e46ef3` (procps; e2e fails if the crash turn completes) and `1538d11` (supervisor reports a signal-killed Codex; exitCode fails on a signal). Owner approved the budget overrun (+747 vs +610, excluding docs/logs). fmt/lint/typecheck/ui:build/test pass (34). Image `36326537233`, digest in `work/dev-env.sh`, deployed to dev: `e2e stop-resume` (all 4 items), `e2e core`, `scotty doctor` pass; leftover dev sessions stopped. Logs saved: crash-without-pkill, crash-kill-unnoticed. Evidence `work/verify/step6-stopresume/NOTES.md`. Outside Touch list: container/supervisor/main.ts (wires save handlers), container/Dockerfile (pkill for the crash step), container/supervisor/codex-rpc.ts (exit fix), fold-fixtures/property/wire tests (behaviour change).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7    | GitHub: private repos and push       | 6          | done        | Spike 7a `8fdb9d8`; `af5ab88` (token, git handler behind the interceptor, scotty/* pushes), `3618665` (gh-style `auth login chatgpt` / `auth login github`, `auth status`; `signin` gone), `428c32c`, `4694584`, `320a948`, `8443105`, `6fca28a`, `bb8d82c`, `9c50cd3`, `6e97218`, `4db1448` (dev hardening: clone retries GitHub throttling on Cloudflare egress (429/403/5xx, dropped transfers) 10x30 s; a failed start fails at once; container work runs in `waitUntil` under one permit, checks its generation, retries the first dial; session list opens views concurrently; Codex exit reports code/signal and redacted stderr; e2e waits stop on a stopped/failed session with its reason, 420 s). fmt/lint/typecheck/ui:build/test pass (35). Image `36351474583`, digest in `work/dev-env.sh`, deployed to dev: `e2e github` (all 4 items), `e2e stop-resume`, `e2e core`, `scotty doctor` pass. Over budget (+414 vs +380); the owner marked the step done. Outside Touch list: `container/supervisor/codex-rpc.ts` (exit evidence), `src/session/{fold,supervisor-link}.ts` + `fold.test.ts` (fail a start at once, typed dial error), `e2e/{core,stop-resume}.ts` + `e2e/lib/wait.ts` (shared terminal-aware wait), `docs/setup.md` and `.agents/skills/verify-scotty` (auth CLI). Open: a Worker deploy during a session's first seconds once left it waiting to `container_timeout` (not reproduced; see Later).                                                                                            |
| 8    | Hatch: routing                       | 7          | done        | Zone `yeshyendamuri.dev` (route adopted from the old Worker). Spike 8a a–d pass (`design.md` Hatch). Checks pass (35 tests). On `dev`: `e2e -- hatch` passes (marker with Host `localhost:8080`, WebSocket echo, anonymous 302, 7000 → 404, unknown → 502, stopped → 502 and `not_running`); `core` (2993 ms cold start), `stop-resume`, `github`, `doctor` pass. Owner phone check passed (2026-09-27): one Access login, then the page with `Host seen: localhost:8080`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8b   | Hatch: the dev environment           | 8          | done        | Instructions are agent-neutral (`container/AGENTS.md`, linked as `~/.codex/AGENTS.md`; `SCOTTY_HATCH` in the agent env; `codex.ts` has no instruction text). Checks pass (35 tests). Image `32c14cd` on `dev`: `e2e -- hatch-env` passes: setup URL in 99 s, `.agents/setup` prints `Ready: <URL>`, resume URL in 202 s (186 s of it is workspace restore before the agent starts, not setup; earlier runs 104/83 s and 45 s). `hatch`, `core` (now allows only `SCOTTY_HATCH`), `stop-resume` (one flake: first dial after stop gave up at ~10 s; rerun passed), `github`, `doctor` pass. Follow-ups deployed and proven on `dev` (2026-09-28, image `4804c88`): `d7e177d` (clone retries back off from 1 s; `workspace.ready` carries `ms` and `retried`), `0690a15` (first dial retries until the container deadline), `2b083bf` (lifecycle e2e use `fixtureRepo`, baked into the image, instead of GitHub) and the retry budget (clone and fetch share 240 s; only 429, 5xx and dropped transfers retry; the proxy turns a rate-limit 403 into 429; spike `work/spikes/retry-budget`: 403/404/401 fail in <0.5 s, 429/503 stop at 242 s). `e2e -- core`, `stop-resume`, `hatch`, `github`, `hatch-env` (setup URL 38 s, resume URL 26 s, was 202 s) and `scotty doctor` pass; `workspace.ready` 119–463 ms with `retried: []`. One earlier `stop-resume` run failed: the resume prompt started no container (`e2e/logs/2026-09-28-resume-no-start.jsonl`, under **Later**). The phone check stays in step 9's Done when. |
| 9    | Files the agent makes, in chat       | 8b         | in progress |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10   | Claude                               | 9          | todo        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11   | Pi                                   | 10         | todo        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 12   | The UI, bottom-up                    | 11         | todo        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 13   | `scotty deploy` and the compiled CLI | 5          | deferred    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14   | Cutover                              | 12, 13     | deferred    | Needs the owner's approval before touching the old deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

- **Why:** the access token lives 10 days and the Creds DO refuses to hand out one with under 24 hours left. Today, when it expires, the owner must run `scotty auth login chatgpt` again.
- **Depends on:** 5 and owner reassessment.
- **Deferred:** the design below is provisional. Manual `scotty auth login chatgpt` covers the owner trial. Settle the lost-reply and network retry policy before activating this step.
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
  4. `cli/commands/setup.ts`: `scotty auth logout chatgpt`. `doctor` already reports sign-in status (step 2b).
  5. `e2e/signin.ts` (register it in `e2e/run.ts`), which assumes a signed-in stage:
     - Call `/refresh` twice in a row: both succeed, `expiresAt` doesn't decrease, and the status stays `signed-in` (proves the rotated refresh token is stored and used).
     - After the refreshes, `npm run e2e -- core`'s create-and-answer part still works (the new access token works from the container). Reuse the core flow; don't copy it.
     - Fire two `/refresh` calls concurrently: both return `signed-in` and neither leaves the store signed out.
  6. Update `design.md` "Credentials" with the agreed refresh schedule, failure policy and `/refresh` route.
- **Out of scope:** a UI sign-in control (step 12), refreshing tokens already handed to a running session, GitHub.
- **Touch:** `src/creds/oauth.ts`, `src/creds/object.ts`, `src/http/api.ts`, `cli/commands/setup.ts`, `cli/main.ts`, `e2e/signin.ts`, `e2e/run.ts`, `docs/design.md`, `.agents/skills/verify-scotty/features/signin.md`.
- **Budget:** +250 lines.
- **Done when:**
  - The checks pass. No new unit tests: the Creds DO is proved by e2e (rule 15).
  - On `dev`: `npm run --silent e2e -- signin` passes, then `npm run --silent e2e -- core` passes.
  - `scotty auth logout chatgpt`, then `scotty doctor` exits 3 with the hint `scotty auth login chatgpt`. The owner then signs in again (a browser step: stop and ask), and `doctor` exits 0.
  - `grep -rn 'access_token\|refresh_token' src cli e2e container | grep -v '^src/creds/'` finds nothing new.
  - The verify-scotty `signin` recipe is updated for `auth logout chatgpt` and re-driven, with evidence in `work/verify/`.

## Step 5: the phone UI on the core

- **Why:** the owner drives sessions from a phone. The UI shell is not served at its routes, and `ui/` still speaks the old API. Restore the shell, align the core flow with the API, and delete the old-only screens and what they leave unused.
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
     - Components with no backend: `ImageAttachments.tsx`, `Terminal.tsx` (terminal is under Later), `PierreDiff.tsx` (diff is under Later), and `SessionSelection.tsx` (Claude/Pi/provider labels). Rebuild these in their own steps if still needed; don't keep old code for them.
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
- **Out of scope:** the ChatGPT sign-in control (the CLI's `auth login chatgpt` covers it), changes/diff, lifecycle actions, new UI features or restyling, and a browser e2e dependency.
- **Owner decision (2026-09-27):** items 3–5 were done by replacing the old UI rather than stripping it. The owner saw the minimal UI on `dev`, accepted it for now, and moved the old style and improvements to step 12 (bottom-up). `ui/src` is three routes on `data/core.ts`; the listed deletions are a subset of what went.
- **Touch:** `ui/src/**`, `ui/vite.config.ts`, `ui/package.json`, `package-lock.json`, `src/worker.ts`, `src/session/view.ts`, `cli/client.ts` (only if changed view fields affect its schemas), `docs/design.md` ("API the UI needs"), `.agents/skills/verify-scotty/features/ui.md`, `.agents/skills/verify-scotty/SKILL.md`.
- **Budget:** +150 added lines outside `ui/`. `ui/` must shrink in net lines; expect several thousand lines to go.
- **Done when:**
  - The checks pass. On `dev`: `npm run --silent e2e -- core` passes.
  - The `ui` recipe is driven in a real browser on `dev`, with screenshots and results in `work/verify/`.
  - Root, session list, create and a direct session URL reload all load the UI. An unknown `/api/*` route still returns a JSON 404 from the Worker.
  - No UI request returns 404. Prove it one of two ways: save the browser's network log with the evidence; or list every path the UI still calls (`rg -o "/api/[A-Za-z0-9/_.{}$()-]*" ui/src | sort -u`) and `curl` each with the Access header (`cf-access-token: $(cloudflared access token -app=$SCOTTY_URL)`, never saved), recording each status code.
  - Every file listed for deletion in items 3 and 5 is gone; `ls ui/src/protocol` shows only `session/`.
  - `rg -ni -e 'claude|pi-console|resource|hatch|evidence|runner|pairing|principal|sleep|vaporize' ui/src` finds nothing, or each remaining hit is explained in Status notes.

## Order of work (owner, 2026-09-27)

The owner trial gate is gone; the owner set this order instead: sessions that stop and resume, private repositories and push, Hatch, images and video in chat, Claude, Pi, then the UI. Deferred: step 4, `scotty deploy`, the terminal, cutover.

**CLI first.** Every feature ships its `scotty` command and its e2e before any UI. The UI (step 12) is built on commands that already work, so the owner and agents control everything from the CLI.

**UI: just enough until step 12.** Before step 12, touch `ui/` only to keep the step 5 flow working (list, create, conversation, steer, interrupt) when an API change would break it, and to add a bare control only where a step needs one to prove itself. No styling, layout or new screens; the redesign waits for step 12, once everything else works.

Steps 8–14 are provisional: each is rewritten to Rule zero's detail (In scope, Touch, Budget, Done when) before it starts.

## Step 6: sessions that stop and resume

- **Why:** a session's container can stop (idle, crash, redeploy, Cloudflare) while the view still says `warm`, and nothing can stop or bring back a session. On `dev` on 2026-09-27, `ls` showed `fea49255…` `warm` while Cloudflare listed its container `stopped`, and three rows with an empty ID stuck in `create`. Reading such a session wakes its DO, which redials a container that is gone: `dial.failed` every 2 s until the `dial` deadline fails the session as `dial_timeout` (seen on `04bc6d3c…` and `fea49255…`).
- **Depends on:** 5.
- **Design (owner, 2026-09-27):** two states, `running` and `stopped`. No vaporize, no separate pause, no disk snapshots. No compatibility with existing `dev` sessions: they are dropped (item 1).
- **In scope:**
  1. **Reset `dev` first.** Save one stuck log (`fea49255…`) to `e2e/logs/2026-09-27-warm-after-container-stopped.jsonl` and add its failing replay: the fold must end `stopped`, not `failed`, once the dial deadline passes (after item 3, it passes). Then drop the old index: rename the Creds DO table `sessions` to `session_index` (no migration, no drop; the old rows and the three empty-ID rows become unreachable). Record the reset in the commit. The empty-ID rows came from `reserve` succeeding before `create` appended `created`; no fix beyond the reset.
  2. **Save after every turn.** An accepted `turn.ended` is the save intent: the fold adds a `save` deadline (60 s), and its command is `save {gen, turn, ack}`. The DO sends the ack, `GET`s `http://container/save?gen=<gen>` over `getTcpPort(7000)`, and `put`s the body to R2 `saves/<id>.tar`, overwriting the last save. The result is `save.done {turn}` or `save.failed {turn, code}`; a `save` timeout records the save as failed. A failed save never fails the session. The supervisor builds the tar with `tar` (no new dependency):
     - `codex/`: the thread's rollout file at its path under `CODEX_HOME`.
     - `repo/`: every file that differs from the base commit, committed or not (`git diff --name-only <base>` with deletions filtered out, plus `git ls-files --others --exclude-standard`). Ignored files stay out.
     - `deleted`: the paths `git diff --name-only --diff-filter=D <base>` lists.
       Nothing is committed for the save and nothing is pushed. Commits the agent made but did not push come back as uncommitted changes; that is accepted. The thread ID is already in the log (`agent.ready.session`), and the base commit in `workspace.ready.commit`.
  3. **Stopped is one event.** `container.stopped {gen}` folds any non-failed session to `stopped`: disconnected, deadlines cleared, pending requests `ended`. It is appended when:
     - `scotty stop <id>` (`POST /api/sessions/:id/stop`); its command is `destroy`, whose outcome changes nothing (resume destroys again).
     - a dial fails and `container.running` is false (in `object.ts` dispatch, instead of `dial.failed`);
     - the `dial` deadline fires (the fold folds it to `stopped` instead of `dial_timeout`);
     - the supervisor reports a req-less `exit` (the agent died; today this fails the session as `agent_exited`).
       `container` and `workspace` timeouts still fail the session.
  4. **Resume.** `resume.requested {}` (`scotty resume <id>`, `POST /api/sessions/:id/resume`) on a `stopped` session: `gen + 1`, phase `provisioning` (no separate resuming state), hello/boot/ready/lastN/ack state reset, `container` deadline; command `container.start`, which destroys a running container first. A `prompt.requested` on a stopped session whose `turn` equals `currentTurn` does the same in the same fold and stays `pending`; its `req` deadline starts at `workspace.ready`. On hello the DO reads R2 `saves/<id>.tar`; if it exists it `PUT`s it to `http://container/save?gen=<gen>` and sends `start` with `resume: {threadId, commit}`; otherwise `start` as today. The supervisor clones, checks out the recorded base `commit` on `scotty/<id>` (`git fetch --depth 1 origin <commit>`), unpacks `repo/` over it, deletes the `deleted` paths, unpacks `codex/` into `CODEX_HOME`, and calls Codex `thread/resume` instead of `thread/start`. `workspace.ready` on a resumed gen sets `running` and resends pending requests; there is no initial prompt. Dependency reinstall is out of scope: nothing in the e2e needs it.
  5. **Before building 4**, check Codex 0.157.1's `thread/resume` params and whether it finds the rollout by thread ID or needs the original path: `codex app-server generate-json-schema` with a temp `CODEX_HOME`, in `work/spikes/6a/`. Write the answer into `design.md` "Stop and resume".
  6. **View and CLI.** `lifecycle` is `running`, `stopped` or `failed` (`warm` is gone; the create reply's `status` too). `scotty stop <id>`, `scotty resume <id>`. `ui/` changes only if the status rename breaks the list (it reads `lifecycle` as a string, so it shouldn't).
  7. **Wiring.** Bind `SessionArtifacts` to the Session DO as a read-write R2 bucket (`Cloudflare.R2.ReadWriteBucket`, see `vendor/alchemy/packages/alchemy/test/Cloudflare/Container/fixtures/effectful/object.ts`). Keep `design.md` (events table, fold states, "Stop and resume") in line with what is built.
- **Out of scope:** pushing anything to GitHub (step 7: the agent pushes with `git push` when asked or needed), dependency reinstall, resuming a `failed` session, R2 lifecycle rules, hiding sessions, UI controls for stop/resume (step 12).
- **Touch:** `src/session/{events,state,fold,deadlines,invariants,commands,object,supervisor-events,view}.ts`, `src/session/fold.test.ts`, `src/session/replay.test.ts`, `src/creds/object.ts` (table rename only), `src/http/api.ts`, `protocol/supervisor.ts`, `container/supervisor/{socket,controller,codex,codex-rpc-schema,runner,agent,workspace}.ts`, `cli/client.ts`, `cli/commands/actions.ts`, `cli/main.ts`, `e2e/stop-resume.ts`, `e2e/run.ts`, `e2e/logs/2026-09-27-warm-after-container-stopped.jsonl`, `alchemy.run.ts` (only if the binding needs it), `docs/design.md`, `docs/plan.md`.
- **Budget:** +610 added lines, excluding docs and saved logs (roughly fold/state/events/commands 200, DO 100, supervisor 160, API/CLI 60, e2e 150). Past that, stop and ask.
- **Done when:**
  - The checks pass, including the new replay. `container/**` changed, so a new image is built and deployed to `dev`.
  - `npm run --silent e2e -- stop-resume` on `dev`:
    1. `new octocat/Hello-World` with a prompt holding a random marker that also asks the agent to write it to `marker.txt` and delete `README`; the turn ends and `save.done` follows.
    2. `stop`: `ls` shows `stopped`, and `wrangler containers instances <app id> --json` shows the instance not `running` (the app ID comes from `SCOTTY_CONTAINER_APP_ID` in `work/dev-env.sh`, never derived).
    3. `steer` "What was the marker?": the session resumes by itself, `agent.ready.session` equals the first thread ID, and the answer contains the marker. A steer asking for `cat marker.txt; ls README` shows the marker and that `README` is gone.
    4. Crash mid-turn: steer "Run exactly: `sleep 5 && pkill -9 -f 'codex app-server'`", so Codex dies inside its own turn (the supervisor is PID 1 and can't be SIGKILLed from inside). The session ends `stopped` with no `invariant.violated`; `resume`, then a steer recalls the marker (from the last finished turn).
  - `npm run --silent e2e -- core` and `scotty doctor` pass on `dev`.
  - Leftover `dev` sessions from the runs are `stopped`.

## Step 7: GitHub: private repositories and push

- **Why:** real work happens in private repositories and has to leave the container. Today `new` resolves the default branch through GitHub's public API with no token and the supervisor clones with no credentials, so only public repositories work, and work leaves the container only as a save in R2 (step 6).
- **Depends on:** 6.
- **Design (owner, 2026-09-27):** set GitHub up once, then just create sessions.
  - One GitHub token for the whole deployment, set once with `gh auth token | scotty auth login github`. There is no repository list: any repository the token can reach works with `scotty new owner/repo`. The @old `scotty repo add` catalogue is not ported.
  - The agent pushes with plain `git push` when asked or when the task needs it, only to `scotty/*` branches. No `scotty push`, no `refs/scotty/<id>`, no automatic push, no pull requests (`gh` stays under Later).
  - The container never sees the token. Git in the container talks plain HTTP to a made-up host, `github.internal`. The Session DO sends that host to a Worker-side handler with `container.interceptOutboundHttp` before starting the container. The handler already knows the session, so there is no sentinel, no credential helper, no public `/p/github` route and no Access bypass.
  - Warm per-repository environments (dependencies installed once) are a separate step under **Later**.
- **In scope:**
  1. **Spike 7a first** (`work/spikes/7a/`, uncommitted code, deployed to `dev`, no image change). Find a way for the handler to know the session without trusting anything the container sends. Try, in order, and stop at the first that works:
     a. `interceptOutboundHttp("github.internal", <DurableObjectState>.exports.default({ props: { session } }))`, with the Worker's fetch reading the props;
     b. the Session DO's own stub as the Fetcher, answered by the DO's `fetch`;
     c. fall back to a per-session sentinel: the handler maps the Basic-auth password to the session, compared in constant time. The supervisor sets a credential helper that prints it.
     Prove it from a real session, with no GitHub token: the handler answers with the session ID it was given, and a steer to run `curl -s http://github.internal/probe` prints exactly that session's ID, for two sessions at once. Write the result, with citations into `vendor/alchemy`, into `design.md` "Credentials" before building. If none of a–c works, stop and ask.
  2. **Token.** The Creds DO stores one GitHub token plus the `login`, `name` and `email` from `GET https://api.github.com/user`, checked when set (non-200 is refused). `POST /api/credentials/github` is write-only; `GET /api/credentials/github` returns `{status, login}` only. The owner makes a fine-grained token with no expiry: repository access "All repositories" or the chosen ones, Contents read/write, Metadata read.
  3. **CLI.** `scotty auth login github` reads the token from stdin (for example `gh auth token | scotty auth login github`) and prints `{status, login}`; it replaces `scotty signin` with `scotty auth login chatgpt` (no alias) and adds `scotty auth status`. `doctor` reports `github: ok|missing`, and missing exits 3 with the hint `scotty auth login github`.
  4. **Default branch.** `new` looks the repository up with the token on the Worker, so private repositories resolve. It fails with 400 and a hint when GitHub has no token or answers 404.
  5. **Git handler** (`src/creds/git.ts`), called only through the interceptor: allow `GET /api/git/<owner>/<repo>(.git)?/info/refs?service=git-upload-pack|git-receive-pack`, `POST .../git-upload-pack` and `POST .../git-receive-pack`, only for the session's own `repo`, and answer 403 for anything else. For `git-receive-pack`, read the ref-update commands (pkt-lines before the pack) and refuse, with a 403, any ref that isn't `refs/heads/scotty/*`. Drop incoming `authorization`, `cookie` and hop-by-hop headers, add the real token as Basic auth (`x-access-token:<token>`), and forward to `https://github.com`, streaming the body. Port the header cleanup from `git show 3042018:worker/src/egress/worker.ts` lines 95–123 and 428–443.
  6. **Supervisor.** Before cloning: `git config --global url."http://github.internal/api/git/".insteadOf https://github.com/`, plus `user.name` and `user.email`, which come in `start` as `git: {name, email}`. The clone URL stays `https://github.com/<repo>`.
- **Out of scope:** a repository list, per-repository setup scripts or cached environments, `gh` in the container, pull requests, pushing to non-`scotty/*` refs, GitHub Apps, token expiry handling, UI controls (step 12).
- **Touch:** `src/creds/{object,git}.ts`, `src/worker.ts`, `src/http/{api,repository}.ts`, `src/session/object.ts`, `protocol/supervisor.ts`, `container/supervisor/{workspace,controller}.ts`, `cli/{client,main}.ts`, `cli/commands/setup.ts`, `e2e/github.ts`, `e2e/run.ts`, `alchemy.run.ts` (only if the binding needs it), `docs/design.md`, `docs/plan.md`.
- **Spike 7a result:** option a works (`work/spikes/7a/RESULT.md`, written into `design.md` "Credentials"). The props are `{session, repo}`, git goes to `http://github.internal/api/git/`, and the image has no `curl`, so prompts must not use it.
- **Budget:** +380 added lines, excluding docs (roughly Creds DO and API 60, git handler 110, DO wiring 20, supervisor and protocol 25, CLI 45, e2e 120). Past that, stop and ask.
- **Owner actions before the e2e:** create the fine-grained token and run `gh auth token | npm run --silent scotty -- auth login github` (or pipe the fine-grained token), and name a private test repository in `SCOTTY_PRIVATE_TEST_REPO` in `work/dev-env.sh`.
- **Done when:**
  - The checks pass. `container/**` changed, so a new image is built and deployed to `dev`.
  - `npm run --silent e2e -- github` on `dev`:
    1. `new $SCOTTY_PRIVATE_TEST_REPO` with a prompt to write a random marker to `marker.txt`, commit, and `git push origin HEAD`; the turn ends and `gh api repos/<repo>/branches/scotty/<id>` shows the commit, whose `marker.txt` holds the marker.
    2. A steer to run `git push origin HEAD:refs/heads/scotty-e2e-forbidden` fails, and `gh api` shows no such branch.
    3. A steer to print `env`, `git config --list --show-origin` and `grep -rlE 'gh[opsu]_[A-Za-z0-9]{20,}|github_pat_' / --exclude-dir=proc --exclude-dir=sys 2>/dev/null` finds no token pattern (the e2e checks the reply; no token appears in any prompt).
    4. The e2e deletes the `scotty/<id>` branch with `gh api -X DELETE`.
  - `npm run --silent e2e -- stop-resume`, `npm run --silent e2e -- core` and `scotty doctor` pass on `dev`.

## Step 8: Hatch (routing)

- **Why:** the owner validates work from a phone; today a server inside a session is unreachable.
- **Depends on:** 7.
- **Design (owner, 2026-09-27):** `https://<port>-<id>.<base>` → Worker (Host check) → Session DO `fetch` → `getTcpPort(port).fetch`, HTTP and WebSocket, behind Access. No nonce, no handoff token, no cookie, no permits, no quotas, no fold event. Every old Hatch auth failure (`9deb075`, `b3df3b8`, `bc7e038`, `3a2813a`) and the quota failure (`597096a`) came from layers this design leaves out.
- **In scope:**
  1. **Owner action:** name the zone and base in `work/dev-env.sh` as `SCOTTY_HATCH_BASE` (for example `preview.<zone>`) and `SCOTTY_HATCH_ZONE_ID`. `alchemy.run.ts` rejects a missing value. If 8a-b ends with a separate Access application, run `cloudflared access login https://1024-x.<base>` once.
  2. **Spike 8a** (`work/spikes/8a/`, uncommitted), stopping at the first failure:
     a. `runWorkerFirst: true` with `ui/dist` served through `ASSETS` still serves the step 5 URLs. Today `runWorkerFirst: ["/api/*"]` (`src/worker.ts:26`) would answer preview paths from the SPA fallback.
     b. A wildcard route plus a proxied AAAA `100::` record is gated by the Worker's Access app. If it isn't, pass one `self_hosted` Application for `*.<base>` as the Worker's `access` (`WorkerAccess.ts:27`), so the UI and previews share one application and one token; a second application only if that fails.
     c. A WebSocket goes through Worker → DO → `getTcpPort` to an echo server that also prints the `Host` it received. It must be `localhost:<port>` (Vite answers 403 to any other); if it isn't, the DO deletes the incoming `host` header.
     d. A server started from a Codex command as `setsid nohup <cmd> > /workspace/.scotty/logs/<name>.log 2>&1 < /dev/null &` survives the command and the turn (Codex 0.157.1).
     Write the results into `design.md` "Hatch".
  3. **Infra** in `alchemy.run.ts` / `src/worker.ts` props: a proxied AAAA `100::` DNS record for `*.<base>`, `routes: [{pattern: "*.<base>/*", zoneId}]`, and `runWorkerFirst: true`.
  4. **Worker:** after the loopback branch, a `Host` ending in `.<base>` is parsed as `<port>-<id>`. Port 7000, and any port outside 1024–65535, gets a 404; otherwise the request goes to `sessions.getByName(id).fetch(request)`. Other hosts: `/api/*` goes to the router, everything else to `ASSETS`.
  5. **Session DO `fetch`:** if the phase isn't `running`, answer 502 `session not running` and start nothing. Otherwise forward the web request to `getTcpPort(port).fetch("http://localhost:<port><path><search>", …)` and return the reply as `HttpServerResponse.raw(response)`, in the DO and in the Worker: `raw` is the one body `toWeb` hands back untouched (`vendor/effect/packages/effect/src/unstable/http/HttpServerResponse.ts:1031-1040`), so a 101 keeps its `webSocket`; `fromWeb` (`src/creds/git.ts:72`) rebuilds it and drops it. A rejected fetch is a 502.
  6. **API and CLI:** `GET /api/sessions/:id/hatch/:port` → `{url}`, or 409 `not_running`. `scotty hatch <id> <port>` prints it. `hatchHost(port, id)` is shared by items 4 and 6.
  7. `e2e/hatch.ts`, registered in `e2e/run.ts`.
- **Out of scope:** image changes, port discovery, agent instructions, resume behaviour (8b), UI (12), quotas, caps, per-request auth.
- **Touch:** `alchemy.run.ts`, `src/worker.ts`, `src/session/object.ts`, `src/http/api.ts`, `cli/commands/actions.ts`, `cli/main.ts`, `e2e/hatch.ts`, `e2e/run.ts`, `docs/design.md`, `docs/plan.md`, `docs/setup.md`.
- **Budget:** +220 added lines, excluding docs (infra 20, Worker 35, DO 30, API/CLI 35, e2e 100). Past that, stop and ask.
- **Done when:**
  - The checks pass. No image change.
  - `npm run --silent e2e -- hatch` on `dev`:
    1. `new octocat/Hello-World` with a prompt to write `server.mjs`: a Node HTTP server on `0.0.0.0:8080` whose `GET /` returns a random marker from the prompt and whose `/ws` echoes. The prompt runs it detached (spike 8a d) and asks for the reply `done`.
    2. `scotty hatch <id> 8080` prints `https://8080-<id>.<base>`. `GET /` with an Access token returns 200 and the marker; a WebSocket to `/ws` echoes a message.
    3. Without the token, the URL never returns the marker (only Access's redirect, 302 or 401).
    4. `https://7000-<id>.<base>/` returns 404 and `https://8080-nosuchsession.<base>/` returns 502.
    5. After `stop`, `GET /` returns 502 and `scotty hatch <id> 8080` exits 1 with `not_running`.
  - The owner repeats item 2 by hand in a phone browser (one Access login, then the marker page), noted in Status.
  - `e2e -- core`, `stop-resume`, `github` and `scotty doctor` pass on `dev`; the SPA still loads at `/`, `/sessions` and `/s/<id>`.

## Step 8b: Hatch: the dev environment

- **Why:** a preview URL is useless until the agent can install a repository's toolchain, run its app on `0.0.0.0`, keep it running past the turn, and bring it back after a resume. The old build's `hatch.toml`, restore extension and toolchain allowlist each broke (`e16e241`, `1bc8b36`, `fbbdb24`, `109c66b`, `ecda4aa`, `fa5eb9c`, `284f056`, `ade3b12`).
- **Depends on:** 8.
- **Design (owner, 2026-09-27):** the agent writes and owns the environment, in the repository, as `.agents/setup`, the file the owner's Amp already writes (`../scotty/.agents/setup`). Scotty never parses or runs it; it only tells the agent the contract. No cache, no snapshot, nothing restarts by itself: after a resume the agent runs setup again.
- **In scope:**
  1. **Image:** `curl sudo xz-utils` and `/etc/sudoers.d/scotty` with `scotty ALL=(ALL) NOPASSWD:ALL`. Nothing else.
  2. **Instance:** `instanceType` in `src/session/object.ts` becomes `standard-1` (4 GiB; `basic` is 1 GiB). A constant.
  3. **Protocol:** `start.hatch`, the URL template `https://{port}-<id>.<base>`, composed by the Session DO.
  4. **Instructions, agent-neutral (owner, 2026-09-28: Pi and Claude Code come later):** `container/AGENTS.md` is copied to `/etc/scotty/AGENTS.md`, and each agent's global-instructions path is a symlink to it in the image (Codex: `~/.codex/AGENTS.md`; Codex 0.157.1 loads it, checked with `codex debug prompt-input`). The supervisor gives the agent process `SCOTTY_HATCH`, the template; no agent adapter carries instruction text. The file says: you are `scotty` in a Scotty container (Debian bookworm, Node 22, git, curl, passwordless sudo, internet; `sudo apt-get update` before installing); repo at `/workspace/repo`; setup always goes through `.agents/setup` (bash, idempotent, in the repo), written first if missing (toolchains pinned from repo files onto `PATH` via `/usr/local/bin`, dependencies, services, dev servers); bind to `0.0.0.0`, detach long-lived servers with `setsid nohup … &` logging to `/workspace/.scotty/logs/`; the script ends by waiting for each dev server on localhost and printing `Ready: <URL from $SCOTTY_HATCH>`, which the agent gives the user; keep dependency and build dirs git-ignored; after a resume run `.agents/setup` first.
  5. `e2e/hatch-env.ts`, registered in `e2e/run.ts`. `SCOTTY_HATCH_TEST_REPO` names a small Vite + React repo the owner picks.
- **Out of scope:** a cache (Later), toolchain managers or Bun/Go/Rust/Python/build-essential in the image, browsers (step 9), databases, dev-env secrets, snapshots, per-session instance sizes, Scotty running setup, an automatic prompt after resume, port discovery, UI (step 12).
- **Touch:** `container/Dockerfile`, `container/AGENTS.md`, `container/supervisor/{codex,codex-config,controller,runner}.ts`, `protocol/supervisor.ts`, `src/session/object.ts`, `e2e/hatch-env.ts`, `e2e/run.ts`, `docs/design.md`, `docs/plan.md`, `docs/setup.md`.
- **Budget:** +160 excluding docs (image 3, protocol/DO 20, supervisor 40, e2e 100). Past that, stop and ask.
- **Done when:**
  - The checks pass; new image built and deployed to `dev`.
  - `npm run --silent e2e -- hatch-env` on `dev`:
    1. `new $SCOTTY_HATCH_TEST_REPO`, prompt "Set up this repo's dev environment, start the dev server, and reply with only its URL." The reply is `https://<port>-<id>.<base>`; `GET /` with an Access token returns 200 with `/@vite/client` in the body.
    2. Steer "Run `.agents/setup` and reply with only its last line" → `Ready: https://<port>-<id>.<base>`.
    3. `stop`, then steer "Bring the dev server back up and reply with only its URL": the URL answers 200 with `/@vite/client` again.
    4. The e2e prints, and Status records, time from `new` to item 1's reply and from item 3's steer to its reply. These decide the cache.
  - The owner repeats item 1 on a phone and uses the app, noted in Status.
  - `e2e -- hatch`, `core`, `stop-resume`, `github` and `scotty doctor` pass on `dev`; leftover sessions `stopped`.

## Step 9: files the agent makes show up in chat

- **Why:** when the agent takes a screenshot of a Hatch page, records a short video or renders a chart, the owner should see it in the conversation on the phone, in the turn that made it. There is no "evidence" concept, panel, command or ledger: a file is just part of the agent's reply.
- **Depends on:** 8b (the owner took 8b as working on 2026-09-28; its dev rerun and phone check fold into this step's e2e and phone check).
- **Design (owner, 2026-09-28):** one agent-neutral primitive, a shell command the agent runs, taught in `container/AGENTS.md`. The bytes go to R2 before the event is written, so an event never points at missing bytes. The event lives in the event log, and the conversation shows it.
- **In scope:**
  1. **Attach command in the image:** `scotty-attach <path> [caption]`, a small script in `container/`. It sends `PUT http://files.internal/` with the bytes, `content-type`, a file name header and an optional caption header, prints `Attached: <name>` on 200 and the error otherwise. It holds no token.
  2. **Route:** the Session DO also routes `files.internal` through the same loopback interceptor as `github.internal`. The props carry the session, so the container never names it. The Worker checks the type is `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `video/webm` or `video/mp4` and the size is at most 25 MB, decoding the headers with Schema. It streams the body to R2 at `files/<session>/<file id>`. Only after the put succeeds does it call the Session DO's `attach` RPC.
  3. **Event:** `file.attached {file, name, type, size, caption?}`, appended by the Session DO. The fold gives it to `currentTurn`. If R2 fails, the Worker returns 502 and no event is written.
  4. **Conversation:** each turn in `conversationView` gains `files: [{id, name, type, size, caption?}]`, in attach order. `GET /api/sessions/:id/files/:file` streams from R2 with the stored type; Access gates it like every other API route.
  5. **Chat UI (the one `ui/` change):** `ui/src/routes/s.$sessionId.tsx` shows a turn's files under its assistant text. Images show as `<img>` (tap opens the full file); videos as `<video controls playsinline>`. Nothing else in `ui/` changes.
  6. **CLI:** `scotty read` lists each file under its turn as `name (type, size) <url>`. There is no new command.
  7. **Capture tools (owner, 2026-09-28: keep the image small):** the image gains no browser. `container/AGENTS.md` tells the agent:
     - install Playwright's Chromium on demand the first time it needs one (`npx -y playwright@<pinned> install --with-deps chromium`);
     - screenshot a local server directly at `localhost:<port>`, not through the preview URL, at 390×844 unless asked otherwise;
     - record a video with Playwright's `recordVideo`;
     - attach every image or video it makes for the user with `scotty-attach`, then mention it in its reply.
- **Out of scope:** images the owner sends into the chat (`prompt.requested.images` stays `[]`), agent-specific image items (Codex `imageView` and similar), thumbnails or transcoding, deleting files, quotas beyond the per-file cap, the full UI (step 12), and Claude or Pi (steps 10 and 11; the command already works for them).
- **Touch:** `container/Dockerfile`, `container/AGENTS.md`, `container/scotty-attach`, `src/worker.ts`, `src/session/{object,events,fold,view}.ts`, `src/session/fold.test.ts`, `src/http/api.ts`, `cli/`, `ui/src/routes/s.$sessionId.tsx`, `e2e/files.ts`, `e2e/run.ts`, `alchemy.run.ts` (only if R2 needs a new binding), `docs/design.md`, `docs/plan.md`.
- **Budget:** +300 excluding docs and e2e (Dockerfile and AGENTS.md 20, attach script 25, Worker route 60, DO, event and fold 50, view and API 50, UI 50, CLI 20). Past that, stop and ask.
- **Done when:**
  - The checks pass. The fold tests cover `file.attached` both during a turn and after a stop. A new image is built and deployed to `dev`.
  - `npm run --silent e2e -- files` on `dev`, using `$SCOTTY_HATCH_TEST_REPO`:
    1. Prompt: "Start the dev server, take a 390×844 screenshot of the page and a 5 second video of clicking the counter, and attach both to this chat."
    2. Turn 0's `files` holds one `image/png` and one `video/webm`. The e2e prints the time from the prompt to the end of the turn, which includes installing Chromium on demand.
    3. Each file answers 200 with its type and its event's size. The PNG starts with the PNG signature; the webm starts with the EBML header `1A 45 DF A3`.
    4. A PUT to `files.internal` whose type is not on the list gets 415, and one over 25 MB gets 413; neither writes an event. Test this with a steer that runs `curl` in the container.
    5. After `stop`, the conversation still lists both files and both still download, because they come from R2, not the container.
  - `e2e -- hatch-env`, `hatch`, `core`, `stop-resume`, `github` and `scotty doctor` pass on `dev`.
  - The owner's phone check: in a session on the phone, ask for a screenshot and a video; both appear in that turn, the image opens and the video plays inline. Note the result in Status.

## Step 10: Claude (provisional)

- **Depends on:** 9.
- **Build:** `scotty new --agent claude`; credentials in the Creds DO under the same rules; agent events interpreted only in `view.ts` (ledger M3); stop and resume work as in step 6.
- **Done when:** `e2e -- core` and `e2e -- stop-resume` pass with `--agent claude`.

## Step 11: Pi (provisional)

- **Depends on:** 10.
- **Build and Done when:** as step 10, with `--agent pi`.

## Step 12: the UI, bottom-up (provisional)

- **Depends on:** 11.
- **Build:** rebuild the style and the improvements of the old UI (`git show 3042018:ui/src/...`) bottom-up on the step 5 core: design tokens and layout first, then the session list and switcher, the rich conversation, then a screen per command that already exists (stop and resume, Hatch, images and video, agent choice, the ChatGPT sign-in control). Write each against the current API; restore no old data layer.
- **Done when:** the `ui` recipe, extended to each screen, passes in a real browser at 390×844, and the list matches each detail view.

## Step 13: `scotty deploy` and the compiled CLI (deferred)

- **Build:** `scotty deploy --stage <stage>` replaces `npm run deploy` (same image copy, then the Alchemy apply); `bun build cli/main.ts --compile`; the CLI embeds the default image digest.
- **Done when:** `scotty deploy --stage dev` then `e2e -- core` pass; `new` twice with the same `--key` creates one session.

## Step 14: cutover (deferred)

- **In scope:** deploy to the owner's chosen stage and domain, run every e2e, merge `rebuild/core` into `main` with the owner's approval.
- **Out of scope without explicit approval:** tearing down or changing the old deployment.

## Later

Each item gets its own step before anyone builds it.

- **Deploy during a start (seen once, step 7):** a Session DO reset about 3 s into a first start dropped the in-memory dial retry; the constructor's `sup.redial` → `container.start` then logged nothing until `container_timeout` at 120 s. Reproduce by deploying during `new` with `wrangler tail` attached. Suspect: dial attempts hanging to their 10 s timeout (21 × 10 s outlasts the 120 s container deadline).
- A running session whose ChatGPT token expires mid-session (sessions longer than ~24h): hand it a fresh token on reconnect.
- The agent can read the ChatGPT token from `config.toml` (accepted risk, `design.md` "Credentials"). Revisit if chatgpt.com ever accepts Worker egress again.
- Custom providers.
- The terminal (a PTY in the supervisor relayed Worker → DO → container).
- `changes`/diff, `settings`, `repos` API for the UI.
- `gh` inside the container.
- **Resume prompt starts no container (seen once, 2026-09-28):** a prompt to a stopped session appended `prompt.requested` and nothing else until `timeout container` 120 s later; the rerun passed. Log: `e2e/logs/2026-09-28-resume-no-start.jsonl`. Add a failing replay before fixing.
- **Dev-environment cache (step 8b review):** Build it when post-resume setup is > ~3 min on a real repo, or registry throttling makes item 3 flaky: `cache.internal` via `interceptOutboundHttp`, R2 `cache/<owner>/<repo>/<key>.tar` streamed by the Worker, a 15-line `scotty-cache restore|save` script, key chosen by the agent from the lockfile hash.
- Warm per-repository environments: a setup script run once per repository, its result cached (for example a workspace tar in R2) so sessions start with dependencies installed.
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
