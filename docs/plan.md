# Rebuild plan

This is the work queue for the rebuild. Any session should be able to pick up the next step from this file alone and finish it.

- [design.md](design.md) describes what is being built.
- This file describes the order, the proof for each step, and the mistakes not to repeat.
- `@old` means the old implementation at commit `3042018` on `main`. Read an old file with `git show 3042018:<path>`.

## Start here (every session)

1. Read `AGENTS.md`, then `docs/design.md`, then this file.
2. Run `git submodule update --init vendor/effect vendor/alchemy` if `vendor/` is empty. It is read-only reference source.
3. In **Status**, pick the first step that is `todo` and whose dependencies are all `done`. If a step is `in progress`, read its notes and continue it rather than starting another.
4. Set that step to `in progress` in **Status**. Work directly on `rebuild/core`; don't create a branch per step. Commit each finished piece of work as you go, with the step id in the message (for example `Step 3: ...`).
5. Do only what the step's **In scope** list says. Anything else you find goes on a new line under **Later**; don't build it now.
6. The step counts as done only when every **Done when** item has passed. Record the commands you ran and their results in **Status** notes and in the commit message.
7. Before committing, check the diff against **Review rules**.
8. If a design decision changes, update `docs/design.md` in the same commit. If a spike changes the plan, update the affected steps here.

## Status

Update this table in every commit that moves a step.

| Step | Title                                    | Depends on | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Repository setup                         | none       | done   | On `rebuild/core`: `742aa85` commits the cleared tree, then the setup commit. `git submodule update --init` → `vendor/effect` `14a3f14` (tag `effect@4.0.0-rc.117`), `vendor/alchemy` `473c395` (`v2.0.0-beta.79`). Pinned exact: effect, @effect/sql-sqlite-do, @effect/platform-bun, @effect/vitest `4.0.0-rc.117`; alchemy `2.0.0-beta.79`; vitest `5.0.2`; oxfmt `0.70.0`; oxlint `1.85.0`; typescript `7.0.2`. No peer conflicts; `npm audit` reports 12 transitive advisories (hono, @hono/node-server, lodash), left as is. `npm install`, `npm run fmt:check` (81 files), `npm run lint`, `npm run typecheck` (root + ui) and `npm run ui:build` pass. `test`/`e2e`/`deploy` are stubs that print "not yet" and exit 1. oxfmt and oxlint run with `--disable-nested-config`, otherwise they load `vendor/*` configs (oxfmt reformatted `vendor/alchemy`; reverted). Root tsconfig adds lib `DOM` for `TextEncoder` in `protocol/` until step 2 sets runtime types. |
| 1a   | Spike: ChatGPT sign-in on the Worker     | 0          | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 1b   | Spike: DO → container WebSocket          | 0          | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 1c   | Spike: Codex network use                 | 0          | done   | Branch `rebuild/1c`. PASS with `[features] plugins = false`: 3/3 model requests via `/p/chatgpt/responses`, zero other connections; with plugins on, one direct `chatgpt.com` and two `github.com` connections (plugin sync). `chatgptAuthTokens` rejects a sentinel. Evidence in `work/spikes/1c/RESULT.md` (not committed); reviewed by an Opus subagent (accept with changes, applied). Findings in `design.md` Open questions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2    | Slice 1: core loop                       | 1b, 1c     | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3    | Slice 2: ChatGPT credentials             | 1a, 2      | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4    | Slice 3: GitHub, pause, resume, vaporize | 3          | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5    | Slice 4: rest of the UI API              | 4          | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6    | CLI                                      | 2          | todo   | Starts as soon as step 2 is done; `deploy` and `up` grow with each slice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7    | Slice 5: previews, terminal, evidence    | 5          | todo   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8    | Cutover                                  | 5, 6       | todo   | Needs the owner's approval before touching the old deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Commands every step uses

| Command                             | What it does                                                                    | Added in |
| ----------------------------------- | ------------------------------------------------------------------------------- | -------- |
| `npm run fmt` / `npm run fmt:check` | oxfmt, excluding `vendor/**` and `work/**`                                      | exists   |
| `npm run lint`                      | oxlint, built-in rules only, excluding `vendor/**` and `work/**`                | step 0   |
| `npm run typecheck`                 | TypeScript across the repository                                                | exists   |
| `npm run ui:build`                  | Builds `ui/dist`                                                                | exists   |
| `npm test`                          | Fold unit tests and log replays (`@effect/vitest`)                              | step 2   |
| `npm run e2e -- <name>`             | Runs `e2e/<name>.ts` against `SCOTTY_URL` (a deployment)                        | step 2   |
| `scotty deploy --stage <stage>`     | Builds and applies the stack. Until step 6, `npm run deploy -- --stage <stage>` | step 2   |

Deployment needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Use an explicit test stage such as `dev`; never derive one. If you have no credentials, stop at the last local check and say so in **Status**. Don't mark the step done.

## Mistake ledger

The old reliability board (`docs/reliability.md:75-87` @old) counted 229 fix commits. Each row gives the cause, the rule that removes it, and the check that proves the rule holds. Review rules R1–R8 are defined in the next section.

| #   | Old failure class                         | Example commits @old                                                                   | Cause                                                                                                                                 | Rule now                                                                                                               | Checked by                                                           |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| M1  | Lifecycle fencing and recovery (79 fixes) | `adc5e63` scheduling races; `43f0545` stranded transitions                             | Handlers awaited the SDK, R2 and sidecars mid-transition, while alarms, callbacks and retries ran in between. Each got its own fence. | A handler appends, folds and sends. An outside action is an intent event, and its result is a later event.             | R1, R2; fold invariants; e2e `kill`                                  |
| M2  | Several timers                            | `fade743` early alarms lost; `3be0300`, `e81ada3`, `9c7ecfc` hard-cap budgets          | Alarms and timeouts were tuned independently.                                                                                         | One alarm, derived from state as the earliest pending deadline. Deadlines come from one table in `fold.ts`.            | Fold test: after every event, the alarm equals the minimum deadline. |
| M3  | Provider and host contract drift (36)     | `709f04e` Codex notification shape; `597096a` Hatch quotas                             | Mocks hid real behavior, and SDK shapes leaked into the core.                                                                         | No mocks of Cloudflare, Codex or GitHub. Codex notifications are stored as received and interpreted only in `view.ts`. | R7; e2e on a real deployment; replays of real logs                   |
| M4  | Disk backup and restore                   | `patches/@cloudflare+sandbox+0.12.9.patch`; hard-cap reserve `docs/reliability.md:108` | Full-disk backup ran under a hard time cap using a promise that couldn't be cancelled.                                                | No disk backups. Pause saves a WIP branch plus the Codex rollout file.                                                 | e2e `pause-resume`                                                   |
| M5  | Deploy and artifact skew (30)             | `f1b6dd3` rollout convergence; `1bc84c9` rollout gate; `a09f256` packaging             | Two deploy paths, rollout watchers, patched Alchemy.                                                                                  | One deploy path on unpatched Alchemy. The supervisor reports its version in `hello`; a mismatch is a `failed` event.   | e2e `core` on a fresh deploy                                         |
| M6  | Evidence lifecycle (29)                   | `d12116b` upload retries; `c017f4a` revert; `803364e` reload loop                      | The recorder, R2 and UI settled independently.                                                                                        | Deferred to step 7. Evidence results are session events.                                                               | Step 7 e2e                                                           |
| M7  | Credential authority (21)                 | `893ed14` fail closed; `f30b21c` fresh epoch; `94c42e3` revert                         | A registry, vault, rotation, grants, local sync and migrations overlapped.                                                            | One Creds DO holds every real secret. Sign-in and refresh run on the Worker. Containers get sentinels only.            | R3; e2e `secrets`                                                    |
| M8  | UI and projection drift (17)              | `db4bac4` lifecycle reconcile; `47b5cc0` replay after refresh                          | The list trusted KV, which was only best-effort.                                                                                      | No KV. The list reads an index plus each Session DO's view.                                                            | Step 5 e2e: the list matches the detail views                        |
| M9  | CLI (13)                                  | `cc5bf74` stale pending-up markers; `2215715` atomic plans                             | Local journals, and recovery by matching error text.                                                                                  | The CLI stores only `{url, stage}`. Retries are safe through `Idempotency-Key`.                                        | e2e `cli`: `up` twice → one session                                  |
| M10 | Compatibility code (4 reverts)            | `6a5f0e9`, `c017f4a`, `94c42e3`, `6f4210a`                                             | Contract changes went through compatibility branches.                                                                                 | No compatibility with @old. A log-format change ships with a reset note.                                               | R6                                                                   |
| M11 | Process heavier than the product          | Custom lint skills, Quint models, the board, ~74k lines of tests                       | Every fix paid for all the tooling.                                                                                                   | Fold unit tests plus a few e2e tests. No custom lint plugin.                                                           | R7                                                                   |

## Review rules

Check every commit against these.

- **R1.** In `src/session/object.ts` and `src/creds/object.ts`, nothing awaits or `yield*`s an outside call (container, R2, fetch, another DO) between reading state and appending the event.
- **R2.** Every outside action has an intent event, a result event, and a deadline in the fold.
- **R3.** Real secrets appear only under `src/creds/`. Search the diff for `access_token`, `refresh_token`, `ghp_`, `github_pat_` and `Authorization` elsewhere.
- **R4.** Boundary input is decoded with Schema: HTTP, WebSocket messages, R2 objects, OAuth responses, CLI arguments. No `any`, no casts that hide a type, no `!`.
- **R5.** Stage, account and installation names come from explicit input only.
- **R6.** No compatibility code for @old formats.
- **R7.** A test is either a fold or replay unit test or an e2e test against a deployment. Reject mocks and tests that match source text.
- **R8.** The step's e2e ran on a deployment, and the commit message records the command and result.

## Step 0: repository setup

- **Depends on:** nothing.
- **In scope:**
  - Commit the staged tree on `rebuild/core`.
  - Pin exact versions (checked 2026-09-26; these are the latest releases, the same commits as `vendor/`):
    - `effect`, `@effect/sql-sqlite-do`, `@effect/vitest`, `@effect/platform-bun`: `4.0.0-rc.117` (npm tag `rc`; `latest` is still v3, so never install untagged).
    - `alchemy`: `2.0.0-beta.79`.
    - `vitest` `5.x` (required by `@effect/vitest`), `oxfmt` `0.70.0`, `oxlint` `1.85.0`, `typescript` `7.0.2`.
  - Add `oxlint` with only built-in rules: `no-explicit-any`, no non-null assertions, no unused code. No custom plugin.
  - To move to a newer Effect or Alchemy later, bump the npm version and the `vendor/` submodule to the same release commit in one commit, then rerun every check and e2e.
  - Create the empty folders `src/session`, `src/creds`, `container/supervisor`, `cli`, `e2e`, `e2e/logs`.
  - Make `npm run typecheck` cover `src/`, `container/`, `cli/`, `e2e/` and `protocol/` as well as `ui/`.
  - Add the scripts `test`, `e2e` and `deploy` as stubs that exit with a clear "not yet" message.
- **Out of scope:** any runtime code.
- **Done when:**
  - `npm install`, `npm run fmt:check`, `npm run lint`, `npm run typecheck` and `npm run ui:build` pass.
  - `git submodule status` shows `vendor/effect` at `14a3f14` (`effect@4.0.0-rc.117`) and `vendor/alchemy` at `473c395` (`v2.0.0-beta.79`).

## Step 1: spikes

Spike code lives in `work/spikes/<id>/` and is never committed. Record the result, with evidence (commands and output), under "Open questions" in `design.md`. If a spike fails, apply its fallback to `design.md` and to the affected steps here.

### 1a: ChatGPT sign-in on the Worker

- **Read first:** Codex's login code in the `openai/codex` repository (`codex-rs/login`), and the device-auth flow behind `codex login --device-auth`.
- **Pass:** a deployed Worker completes the device-code flow, receives access and refresh tokens and the account ID, and refreshes once.
- **Fallback:** the CLI runs sign-in once and uploads the token to the Creds DO. Refresh still runs on the Worker.

### 1b: DO → container WebSocket

- **Read first:** `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/Container.ts:137-155` and `ContainerPlatform.ts:186-199`; the Containers guide under `vendor/alchemy/website/src/content/docs/`.
- **Pass:** on beta.79, a DO opens a WebSocket through `container.getTcpPort(7000)` to a server in the container, and messages flow both ways for 10 minutes.
- **Fallback:** the supervisor dials in to `wss://<host>/sup/<id>` with a per-session secret passed at start. Access bypasses that one path.

### 1c: Codex network use

- **Read first:** `worker/src/agent/codex/process.ts:204-270` @old, which already pointed Codex at a proxy base URL.
- **Pass:** with `base_url` set to a logging proxy, a full Codex turn with tool use sends every `chatgpt.com` request through that proxy.
- **Fallback:** add a `/p/chatgpt` sub-route for each extra host found, or allow the host directly if it carries no credential.

## Step 2: slice 1, the core loop

- **Depends on:** 1b, 1c.
- **Read first:** `design.md` sections "Session", "Supervisor" and "Deploy".
- **In scope:**
  - Create a session from a public repository, get a Codex answer, steer it, and interrupt it.
  - Codex uses an OpenAI API key stored in the Creds DO and swapped at `/p/openai`, so no real secret enters the container even here. The key is set with a temporary `POST /api/credentials/openai`.
- **Out of scope:** ChatGPT, GitHub push, pause, the UI beyond what already renders, the CLI.
- **Build:**
  - `alchemy.run.ts`: the Worker (assets from `ui/dist`, Access), the Session DO hosting the Container, the Creds DO, R2.
  - `src/session/events.ts`, `src/session/fold.ts` (states, invariants, deadline table), `src/session/object.ts`.
  - `src/worker.ts`: `POST /api/sessions`, `GET /api/sessions/:id`, `/steer`, `/interrupt`, `/p/openai`.
  - `container/Dockerfile`, trimmed from `worker/container/Dockerfile` @old, without the Sandbox SDK base image.
  - `container/supervisor/`: the WebSocket protocol from `design.md`, cloning, and `codex app-server --listen stdio://`.
  - `e2e/core.ts`; `npm test`; `npm run e2e`; `npm run deploy`.
- **Port from @old:**
  - Codex `config.toml` and launch: `worker/src/agent/codex/process.ts:204-270`.
  - Thread start and resume: `worker/src/agent/codex/session.ts:996-1044`.
  - Header cleanup and OpenAI swap: `worker/src/egress/worker.ts:95-123`, `428-443`.
- **Do not port:** `worker/src/session/object.ts`, `worker/src/session-actor/**`, `worker/src/sandbox/runtime.ts`, `@cloudflare/sandbox`.
- **Done when:**
  - `npm test` passes, covering every invariant and the alarm-equals-earliest-deadline property.
  - `npm run deploy -- --stage dev` succeeds on a fresh stage.
  - `npm run e2e -- core` passes: create → answer → steer → interrupt.
  - The standard checks pass.
- **Guards:** M1, M2, M3, M5.

## Step 3: slice 2, ChatGPT credentials

- **Depends on:** 1a, 2.
- **In scope:** sign in to ChatGPT from the UI's Settings; the Creds DO stores and refreshes the tokens; Codex uses `/p/chatgpt`. Remove `/p/openai` and the temporary key endpoint.
- **Out of scope:** GitHub, other providers.
- **Build:**
  - `src/creds/object.ts`: sign-in, tokens, refresh (intent → call → result), per-session sentinels.
  - `src/creds/swap.ts`: an explicit path allowlist (only `/p/chatgpt/responses` is known to be needed, from spike 1c), a constant-time sentinel check, removal of hop-by-hop and incoming auth headers, and a log line for every outcome including upstream failures.
  - A ChatGPT sign-in control in the UI's Settings. This is the only UI change here.
  - `e2e/secrets.ts`.
- **Port from @old:** the ChatGPT swap and host check, `worker/src/egress/worker.ts:164-240`.
- **Do not port:** `cli/src/pi-auth.ts` (local auth-file import), `scotty sync`, the credential registry, vault or rotation code.
- **Done when:**
  - `npm run e2e -- secrets` passes: the real tokens are absent from container env, files, process arguments and git config.
  - A refresh forced during a turn lets the turn finish, and the container never sees the new token.
  - `npm run e2e -- core` still passes.
- **Guards:** M7.

## Step 4: slice 3, GitHub, pause, resume, vaporize

- **Depends on:** 3.
- **In scope:** clone and push private repositories through `/p/github`; `sleep`, `resume` and `vaporize`.
- **Build:**
  - The git credential helper and `url.insteadOf` in the supervisor.
  - `/p/github`: only smart-HTTP paths for the session's repository.
  - Pause (WIP push → rollout file to R2 → stop), resume, vaporize.
  - `e2e/pause-resume.ts`, `e2e/vaporize.ts`, `e2e/kill.ts`.
- **Port from @old:**
  - The credential-helper idea: `worker/src/sandbox/workspace.ts:70-76`. It changes to return the sentinel.
  - The rollout-file format: `worker/src/agent/codex/persistence-format.ts:5-24` (keep only the rollout path pattern and file list; drop the sidecar history).
- **Done when:**
  - `pause-resume`: a marker file and the Codex thread survive sleep and resume.
  - `vaporize`: no container, R2 objects or branch remain, and running it twice is safe.
  - `kill`: killing the container mid-turn, and mid-pause, ends in a correct state with no invariant violation.
  - `core` and `secrets` still pass.
- **Guards:** M1, M4.

## Step 5: slice 4, the rest of the UI API

- **Depends on:** 4.
- **In scope:** the existing UI works on a phone without changes, apart from hiding screens.
- **Build:**
  - `src/session/view.ts` for every shape the UI reads.
  - The session index.
  - `changes`, `settings`, `repos`, `checkpoint`.
  - Hide the Devices, Providers-and-runners and Stats routes.
  - `e2e/ui.ts`, a browser test at 390×844.
- **Contract:** the UI's readers in `ui/src/data/*.ts` and `protocol/` are the field-level contract. Match them; don't change them.
- **Done when:**
  - `npm run e2e -- ui` passes: create, watch the conversation stream in, steer, open the diff.
  - The list matches each session's detail view.
  - All earlier e2e tests still pass.
- **Guards:** M3, M8.

## Step 6: CLI

- **Depends on:** 2. Grows with each later slice.
- **In scope:** `deploy --stage`, `up`, `ls`, `inspect`, `read`, `steer`, `interrupt`, `sleep`, `resume`, `vaporize`, `log`, `replay`. Built with `bun build --compile`. `deploy` embeds `alchemy.run.ts` and the built UI and image context.
- **Done when:**
  - `npm run e2e -- cli` passes: `up` twice with the same key produces one session.
  - `scotty replay` on a saved log in `e2e/logs/` reproduces its recorded invariant failure.
  - `bun build cli/main.ts --compile --outfile /tmp/scotty` succeeds.
- **Guards:** M5, M9.

## Step 7: slice 5, previews, terminal, evidence

- **Depends on:** 5.
- **Previews:** `<port>-<id>-<nonce>.<previewBase>` → Session DO → `getTcpPort(port)`, behind Access. Old URL shape: `worker/src/hatch/contracts.ts:489-492` @old.
- **Terminal:** a PTY in the supervisor, relayed Worker → DO → container.
- **Evidence:** port `worker/container/pi-packages/sources/scotty-browser-test/runner.ts` @old. Results are session events.
- **Done when:** a preview opens on a phone (HTTP and WebSocket); the terminal shows output; evidence frames render in the UI.
- **Guards:** M6.

## Step 8: cutover

- **Depends on:** 5, 6.
- **In scope:** deploy to the real domain on the owner's chosen stage; run every e2e test; merge `rebuild/core` into `main`.
- **Out of scope without explicit approval:** tearing down or changing the old deployment.

## Later

Each item gets its own step here before anyone builds it.

- Claude, Pi and custom providers: new Creds DO rows and swap routes.
- `gh` inside the container.
- User-supplied images, checked against the supervisor contract at `hello`.

## When something breaks

1. Save the session's event log to `e2e/logs/<date>-<short-name>.jsonl` before fixing anything.
2. Add a replay test that fails on it.
3. Fix the bug. The fix is done when the replay passes and the relevant e2e test passes on a deployment.
4. If the bug fits a ledger row, add its commit to that row. If it fits none, add a new row.
