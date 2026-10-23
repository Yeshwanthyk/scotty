# Plan

The work queue. Finished work lives in git history; this file holds only the rules and what is still open.

- [design.md](design.md) says what is built. [setup.md](setup.md) gets a machine able to deploy and test.

## Start here

1. Read `AGENTS.md`, `docs/design.md` and this file; `docs/setup.md` if the machine isn't set up.
2. `git submodule update --init vendor/effect vendor/alchemy` if `vendor/` is empty. It is read-only.
3. Pick an open item below whose dependencies are built, or the one the owner names. Work on a branch and land it on `main` through a pull request.
4. Check every Effect or Alchemy API against `vendor/` and one of its tests before using it.
5. Do only the item's **In scope**. Anything else goes under **Later**.
6. It is done when every **Done when** check passes. Record the commands and results in the PR and the item's row.
7. If a design decision changes, update `docs/design.md` in the same PR.
8. Stop and ask when a check fails for a reason outside the item, a vendor API doesn't behave as its source says, the work needs an owner action (a sign-in, a secret, a paid setting), or it grows far past its scope.

## Rules

Each is a reason to reject a diff, including your own.

1. Write only what **Done when** needs. No abstraction without two real callers, no options nobody sets, no defensive code for states the types rule out, no compatibility code.
2. No retries, timers or backoff except the deadlines in `src/session/fold.ts`. The DO has one alarm.
3. No new dependencies unless the item names them. Never `@effect/platform`, `@effect/schema`, `@cloudflare/sandbox`, fast-check or mocking libraries.
4. Reuse before adding; deleting beats adding. Comments say why, never what. No TODOs.
5. In `src/session/object.ts` and `src/creds/object.ts`, nothing awaits an outside call between reading state and appending the event. Every outside action has an intent event, a result event and a deadline in the fold.
6. Tests are only: unit tests of `src/session/fold.ts`, replays of logs in `e2e/logs/`, and e2e against a real deployment. No mocks. A bug gets one new test.
7. Real secrets appear only under `src/creds/`, plus the `AGENTS.md` exceptions. Never print or save a token; print names, lengths or SHA-256 prefixes.
8. Scratch goes in `work/`, is never committed, and is deleted once its result is in `design.md`.

## Checks

Before every commit, in order; report each result, and any you couldn't run with the reason.

```sh
npm run fmt && npm run lint && npm run typecheck && npm run ui:build && npm test
```

Against a test stage (env from `docs/setup.md`):

```sh
. work/dev-env.sh
npm run --silent scotty -- deploy
npm run --silent e2e -- core
npm run --silent scotty -- doctor
```

- A change under `container/**` or `protocol/supervisor.ts` needs a new image: push the branch, `gh workflow run image.yml --ref <branch>`, `gh run watch`, put `index.docker.io/yeshwanthyk/scotty@sha256:<digest>` in `container/image.digest`, then deploy.
- Use a temp `CODEX_HOME` for any local Codex run. Stage explicit paths; never `git commit -a`.

## When something breaks

1. Save the event log (`scotty log <id>`) to `e2e/logs/<yyyy-mm-dd>-<name>.jsonl`, checked for tokens, before fixing anything.
2. A fold bug gets a failing replay test; any other bug gets one failing e2e assertion.
3. It is fixed when that test and `npm run e2e -- core` pass.

## Open

| Item | Title                        | Depends on | Status   |
| ---- | ---------------------------- | ---------- | -------- |
| C1   | ChatGPT refresh and sign-out | owner      | deferred |
| S6   | Scotty inside sessions       | none       | todo     |
| S7   | Slack bot                    | none       | todo     |
| S10  | Approvals for MCP writes     | none       | todo     |
| R2   | Runners on the owner's boxes | none       | todo     |
| R3   | Where a session runs         | R2         | todo     |
| Z1   | The agent asks for more      | S6         | todo     |

### C1: ChatGPT refresh and sign-out

- **Why:** the access token lives 10 days and the Creds DO refuses to hand out one with under 24 hours left. Today, when it expires, the owner must run `scotty auth login chatgpt` again.
- **Depends on:** owner reassessment.
- **Deferred:** the design below is provisional. Manual `scotty auth login chatgpt` covers the owner trial. Settle the lost-reply and network retry policy before activating this step.
- **Read first:** `design.md` "Credentials"; `src/creds/object.ts`, `src/creds/oauth.ts` (the refresh request shape and rotation are in `design.md` "Credentials"); Codex `codex-rs/login/src/auth/manager.rs` refresh (`https://github.com/openai/codex`, tag `rust-v0.157.1`).
- **In scope:**
  1. `src/creds/oauth.ts`: add `refreshTokens(refreshToken)`: JSON `POST https://auth.openai.com/oauth/token` with `{grant_type: "refresh_token", client_id, refresh_token}`, Schema-decoded. Return the new access token, refresh token, ID token and expiry, or an `OAuthFailure` with HTTP status and upstream `error`/`code` (never token fields). Add `revoke(refreshToken)` for `https://auth.openai.com/oauth/revoke`. Follow the style of `exchangeCode`.
  2. `src/creds/object.ts`:
     - The DO's alarm fires at `expiresAt − 48h`, so `sessionToken()` (which needs ≥24h) always has a fresh token. On the alarm: mark a refresh as pending in storage, call `refreshTokens`, then in one storage write replace all tokens, **only if the stored refresh token is still the one that was sent**. Clear pending.
     - One refresh at a time: if a refresh is pending, `sessionToken()` does not start another. It returns the stored token if that still has ≥24h, otherwise `CredentialStoreError("ChatGPT sign-in expiring")`.
     - Permanent failure (401; 400 `invalid_grant`; `refresh_token_expired|reused|invalidated`) or an unclear result (lost reply, 200 without both tokens): delete the tokens, so status becomes `signed-out`. Never send the old refresh token again.
     - Transient failure (5xx, network): keep the tokens and set the alarm 15 minutes later.
     - Add `signOut()`: revoke the refresh token (ignore revoke failures), then delete the tokens.
  3. `src/http/api.ts`: `DELETE /api/credentials/chatgpt` → `signOut()`, and `POST /api/credentials/chatgpt/refresh` → run one refresh now and return `{status, expiresAt}` (this route exists so the e2e can prove refresh without waiting 8 days; it is Access-protected like every route).
  4. `cli/commands/setup.ts`: `scotty auth logout chatgpt`. `doctor` already reports sign-in status.
  5. `e2e/signin.ts` (register it in `e2e/run.ts`), which assumes a signed-in stage:
     - Call `/refresh` twice in a row: both succeed, `expiresAt` doesn't decrease, and the status stays `signed-in` (proves the rotated refresh token is stored and used).
     - After the refreshes, `npm run e2e -- core`'s create-and-answer part still works (the new access token works from the container). Reuse the core flow; don't copy it.
     - Fire two `/refresh` calls concurrently: both return `signed-in` and neither leaves the store signed out.
  6. Update `design.md` "Credentials" with the agreed refresh schedule, failure policy and `/refresh` route.
- **Out of scope:** a UI sign-in control, refreshing tokens already handed to a running session, GitHub.
- **Touch:** `src/creds/oauth.ts`, `src/creds/object.ts`, `src/http/api.ts`, `cli/commands/setup.ts`, `cli/main.ts`, `e2e/signin.ts`, `e2e/run.ts`, `docs/design.md`, `.agents/skills/verify-scotty/features/signin.md`.
- **Size:** about +250 lines.
- **Done when:**
  - The checks pass. No new unit tests: the Creds DO is proved by e2e.
  - On a test stage: `npm run --silent e2e -- signin` passes, then `npm run --silent e2e -- core` passes.
  - `scotty auth logout chatgpt`, then `scotty doctor` exits 3 with the hint `scotty auth login chatgpt`. The owner then signs in again (a browser step: stop and ask), and `doctor` exits 0.
  - `grep -rn 'access_token\|refresh_token' src cli e2e container | grep -v '^src/creds/'` finds nothing new.
  - The verify-scotty `signin` recipe is updated for `auth logout chatgpt` and re-driven.

### S6: Scotty inside sessions

- **In scope:** the image carries the `scotty` CLI pointed at `scotty.internal`; the Worker takes the session's identity from props. A session can create, read and steer others; a child's origin is its parent.
- **Done when:** a scripted session starts a child and reads its answer.

### S7: Slack bot

- **In scope:** Slack as a blueprint: a connection whose signature configuration is Slack's (`v0:{timestamp}:{body}`), the owner's Slack user id as an `only` filter, key `slack:{channel}:{thread}`, `start` on a mention and `wake` on thread replies. Scotty shows an app manifest with the events URL; the owner pastes the bot token (a token connection) and signing secret. The agent posts its answer to the thread through the Slack token connection. Repo from `in owner/repo`, else the blueprint's default, else the agent asks in the thread. Slack retries are no-ops.
- **Done when:** `e2e slack` with a signed mention payload starts a session whose scripted reply is posted through the connection; the owner sees a real thread reply on `main`.

### S10: approvals for MCP writes

- **In scope:** a tool policy may say `ask` for tools outside the allowed set. The proxy refuses such a call with "needs approval" and the Session DO records an approval request event; the owner approves or denies in the UI (phone first), which is a later event, and Scotty steers the session to retry. An approval covers one tool for the session, or always for that connection. The agent never waits on an open request for the owner.
- **Done when:** `e2e` makes a scripted session call an `ask` tool, sees the refusal and the pending request, approves it, and the retry succeeds; a denial is recorded and the call stays refused.

### R2: runners on the owner's boxes

- **Why:** the owner has Linux machines (first `slumbers`: 16 cores, 27 GB, Docker) and wants sessions on them, with hatch and the terminal working as on Cloudflare.
- **Shape:** each runner is a name in the deploy config. The deployer makes, by name, a Cloudflare Tunnel `scotty-<stage>-runner-<name>`, the hostname `runner-<name>.<domain>` routed to it (with a Worker route that has no script, so the preview wildcard doesn't catch it), and an Access application that admits only a service token kept in the Creds DO. `scotty runner add <name>` installs `scotty runner` on the box as a systemd service; it runs `cloudflared` in Docker with the tunnel's token, and serves `PUT|GET|DELETE /s/:id` (a Docker container per session from the same image) and `/s/:id/port/:n` (forwarded to the container). The Session DO's runner place is `fetch` to that host: no link protocol of Scotty's own. The container's `github.internal` and `files.internal` go through the daemon to the Worker with a short-lived token for that session only; the real credentials stay in the Creds DO. Sleep keeps the container's disk on the box.
- **Spike first:** a DO holds the supervisor WebSocket through the tunnel for an hour with the resend protocol intact; result in `design.md`.
- **In scope:** the above; Settings → Runners (name, online, last seen, sessions running, limit); `scotty runners`; `scotty new --on <name>`; `container.stopped {reason: gone}` when a runner stops answering.
- **Done when:** `e2e runner` runs a scripted session on `slumbers`, steers it, sleeps and wakes it, and opens a hatch preview through the Worker; no real token appears on the box outside the agents' own exceptions.

### R3: where a session runs

- **In scope:** a default place per repo; an automation's `on:`; `--on runners` picks the least busy online runner; a runner that is offline at create fails fast with a clear message rather than falling back silently. The UI's new-session sheet has a place picker.
- **Done when:** `e2e runner` creates by repo default and by automation.

### Z1: the agent asks for more

- **Why (owner, 2026-10-19):** an agent that runs out of memory or time on a build should be able to say so, without the owner noticing first.
- **Shape:** from inside a session (S6's `scotty` at `scotty.internal`), `scotty resize --size <name> --why <text>` appends `size.requested {size, why}`. The owner approves or denies from the session page or with `scotty resize <id> --approve|--deny`. An approval is a stop and a resume at that size (design.md "Resume at another size"), after the current turn ends, then a prompt that says the session now runs at the new size. The agent never waits on the owner, and an unanswered request expires when the session stops. A request is never applied without the owner's approval, because it costs money (owner to confirm).
- **In scope:** the above; the request shows in the session's thread and in the sessions list; `skills/scotty/SKILL.md` tells agents when to ask (out of memory, a build slower than its timeout).
- **Out of scope:** automatic resizing; sizes above `standard-4` (the agent is told to suggest a runner).
- **Done when:** fold tests cover request, approve, deny and expiry. `e2e sizes` has a scripted session run `scotty resize --size standard-2 --why test`; the request shows in `read`. Approving it stops and resumes the session at `standard-2`, and the next turn reads the bigger `nproc`. A denied request changes nothing. Screenshots of the request in the thread.

## Later

Each gets its own item before anyone builds it.

- The CLI looks like `init` wherever a person reads it (`doctor`, `ls`, `read`, `new`); piped output stays JSON.
- A running session whose ChatGPT token expires mid-session gets a fresh one on reconnect.
- The agent can read the ChatGPT token from `config.toml` (accepted risk). Revisit if chatgpt.com accepts Worker egress again.
- Custom providers.
- Warm per-repository environments: setup run once per repository and cached in R2, so sessions start with dependencies installed.
- Split `src/creds/object.ts` by provider (`chatgpt`, `github`, `claude`) with the same RPC names and tables; no behaviour change.
