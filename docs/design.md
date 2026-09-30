# Scotty design

Scotty runs coding-agent sessions in Cloudflare Containers and drives them from a phone-friendly web UI and one CLI. This is a rebuild. The old implementation is at `3042018` on `main`; port from it only where this document says so.

## Scope of v1

- **Single user.** Cloudflare Access for the owner's email is the only login. No pairing, devices, owner transfer or root token: any device signed in through Access is the owner.
- **Credentials live on the Worker.** ChatGPT sign-in is `scotty login chatgpt`; Settings → Accounts also has a UI control. Nothing is copied from a local machine.
  - ChatGPT subscription, used by Codex.
  - A GitHub token, used by git.

  - A Claude setup token, used by Claude Code. The owner signs in on a laptop with the official `claude setup-token` and pushes the token once, like the GitHub token.

  Pi providers, custom providers and `gh` come later, with the same providers shape.

- **Two agents: Codex and Claude.** Codex runs as `codex app-server` over stdio; Claude through the Agent SDK. The supervisor's `start` carries `agent: {kind, ...}`, agent output is `agent {n, kind, event}`, and each agent lives in its own folder: `container/supervisor/agents/<kind>/` (runner and files, picked by `makeAgent`, the only switch on kind) and `src/session/agents/<kind>.ts` (its events as items and text, and its start config). Pi is added the same way.
- **One runtime: a Cloudflare Container.** It runs the default image this repository ships, or an image the user supplies that meets the supervisor contract.
- **The UI has the core flow plus settings, terminal, files and hatch previews.** Every feature ships its CLI command first.

## Layout

```
src/
  worker.ts           Effect HttpRouter: /api/* and UI assets; /api/git for the container, Hatch previews
  session/
    events.ts         event Schemas (the log format)
    fold.ts           pure fold(state, event); the only transition function
    state.ts          State shape and initial state
    deadlines.ts      deadline table and the one derived alarm
    invariants.ts     invariants(state), checked after every append
    ack.ts            pure ack threshold and recorded-ack checks
    commands.ts       pure command(state, event): the at-most-one command the DO sends after an append
    object.ts         Session DO: append → fold → maybe send a command; one derived alarm
    view.ts           state → UI API shapes (sessions, conversation, changes)
  creds/
    object.ts         Creds DO: ChatGPT sign-in, session access token, GitHub token; refresh deferred
    git.ts            git smart-HTTP handler for github.internal
container/
  Dockerfile          default image: Node, git, Codex, the dev toolchain, supervisor
  supervisor/         scotty-sup: WebSocket server; runs codex app-server; git; per-turn save and resume
cli/
  main.ts             Effect CLI: deploy, doctor, login, new, ls, read, steer, interrupt, log
  binary.ts           the compiled CLI's entry; hands release.ts the embedded release
  client.ts           typed API client behind Access; shared with e2e/
deploy/
  release.ts          builds a release: the Worker bundle, the web app, release.json
  compile.ts          builds the scotty binary for each platform with the release inside
  deployer.ts         deploys a release to a stage, and removes a stage, by name over the Cloudflare API
  image.ts, oci.ts    copies the pinned image into registry.cloudflare.com
protocol/
  supervisor.ts       the only protocol file; wire schema shared by the Session DO and supervisor
ui/                   the web app (kept; its old API schemas are in ui/src/protocol/ until it is rewired)
e2e/                  tests against a real deployment
```

Everything is TypeScript on Effect `4.0.0-rc.117` and Alchemy `2.0.0-beta.79`, pinned under `vendor/` as read-only reference source. The CLI and supervisor are compiled to single binaries with `bun build --compile`.

## Session: one writer, one log

The Session DO is the only writer for its session. Its SQLite storage (via `@effect/sql-sqlite-do`) holds one table:

```
events(seq INTEGER PRIMARY KEY, at, src, kind, op, data JSON)
```

State is `fold(events)`. Every handler does the same three things:

1. append the event;
2. fold it into the state;
3. optionally send one command to the supervisor.

A handler never awaits an outside party while changing state. An outside action is recorded as an intent event, and its result arrives as a later event. An unknown result leaves the intent pending until an outcome or a timeout event settles it; it is never reported as success.

| Event                                   | Fields                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`                               | `repo, baseBranch, branch, title, prompt, image, agentKind, scripted?, idleAfter?` (`branch` is the work branch `scotty/<session id>`, chosen at create time; `idleAfter` shortens the idle window, scripted sessions only) |
| `container.start` / `sup.hello`         | `gen` / `gen, n, version, boot` (`boot` identifies one supervisor process)                                                                                                                                                  |
| `workspace.ready`                       | `gen, n, base, branch, commit, ms?, retried?` (`ms`: clone/fetch time; `retried`: git's error for each retried GitHub failure)                                                                                              |
| `agent.ready`                           | `gen, n, agentKind, session` (the agent's session id)                                                                                                                                                                       |
| `prompt.requested` / `prompt.delivered` | `req, turn, text, images` / `gen, n, req` (delivery settles a prompt or interrupt; client `req` cannot start with `initial:`)                                                                                               |
| `interrupt.requested`                   | `req, turn`                                                                                                                                                                                                                 |
| `agent.event`                           | `gen, n, agentKind, event` (the raw agent notification; the fold does not interpret it)                                                                                                                                     |
| `turn.ended`                            | `gen, n, turn, codexTurn, state` (`turn` is the DO turn; `codexTurn` is recorded, not matched)                                                                                                                              |
| `sup.error`                             | `gen, n, code, message, req?` (a pending `req` fails except on `timeout`; `stale` fails it too; req-less `exit` stops the session)                                                                                          |
| `failed`                                | `phase, code, retryable`                                                                                                                                                                                                    |
| `socket.closed` / `dial.failed`         | `gen`                                                                                                                                                                                                                       |
| `sup.redial`                            | `gen` (on wake, start if no hello; otherwise dial)                                                                                                                                                                          |
| `file.attached`                         | `file, name, type, size, caption?` (bytes already in R2 at `files/<session>/<file>`; shown in the current turn)                                                                                                             |
| `invariant.violated`                    | `code, detail`                                                                                                                                                                                                              |
| `timeout`                               | `op`: `container`, `workspace`, `dial`, `redial`, `save`, `watch`, `idle`, `stalled`, or `req:<req>`; `container`/`workspace` expiry fails with `<op>_timeout`, retryable; `dial` expiry stops (`gone`)                     |
| `save.done` / `save.failed`             | `turn` / `turn, code` (an accepted `turn.ended` is the save intent)                                                                                                                                                         |
| `container.stopped`                     | `gen, reason?, exitCode?, idleSeq?` (`reason`: `user`, `idle`, `stalled`, `crashed`, `exited`, `deploy`, `gone`; folds to `stopped`; an idle stop names the idle `timeout` it checked)                                      |
| `container.watched`                     | `gen` (the DO awaits the container's exit; re-arms the `watch` deadline)                                                                                                                                                    |
| `resume.requested`                      | (resumes a stopped or retryably failed session; a steer to a stopped session resumes in the same fold)                                                                                                                      |
| `active`                                | (the owner used the terminal or a preview when the idle deadline came; restarts the idle window)                                                                                                                            |

Fold states, and the status the UI shows for each:

| State          | UI status                                      |
| -------------- | ---------------------------------------------- |
| `provisioning` | `booting`                                      |
| `running`      | `running`, or `warm · sleeps in Nm` while idle |
| `stopped`      | `stopped · <reason>`, or `asleep · idle`       |
| `failed`       | `failed`                                       |

Invariants are checked on every append. A violation appends an `invariant.violated` event and alerts; it does not throw. `scotty log <id>` shows the timeline. `scotty replay <id>` downloads the events and runs the same fold locally, stopping at the first bad event.

Duplicate requests (the same `req`) do nothing. A prompt whose `turn` no longer matches is answered with `stale`, which the UI already understands.

## Supervisor

`scotty-sup` is the container's entrypoint. It listens on port 7000. The Session DO connects to it with `container.getTcpPort(7000)` and upgrades to a WebSocket. That traffic never leaves Cloudflare, so the supervisor needs no auth token and no public route.

- Don't use `Cloudflare.Containers.layer` in the Session DO. It starts the container on every DO construction (`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/StartContainer.ts:398-402`), so reading a paused session would boot it. Use the container handle's `start()`, `destroy()` and `running` (`Container.ts:137-147`) from the fold's commands. `start()` returns before the container boots (`ContainerPlatform.ts:213`), so the dial retries until `hello` arrives or the fold's deadline fires.
- Dialing is an outside action: the DO appends `container.start {gen}`, then starts and dials outside the handler. `start()` returns before boot; the fold's `container` deadline bounds boot to `hello`, `workspace` bounds hello to workspace readiness, and `dial` bounds a lost socket. A failed dial never extends that deadline. The single alarm also drives `redial` retries every 2 seconds; the DO keeps no other timer.
- On wake, `sup.redial` starts the container if hello has not arrived (start if it is not running, then dial); otherwise it dials `ws://container/?gen=<gen>&after=<lastN>`. `lastN` is the highest accepted supervisor output number, regardless of output type. The supervisor replays stored outputs after that number without waiting for an ack message.
- `hello {gen, n:1, version, boot}` is the reconnect handshake. It is accepted while disconnected with a pending container or dial operation, even if `n:1` is below `lastN`; it never decreases `lastN`. A changed boot for the same gen means the container was replaced under the session, as a deploy can do; the session stops with reason `deploy` and the replacement is destroyed. A repeated hello while connected does nothing. A new gen after failure is later work.
- After hello, the DO sends `start {repo, base, branch, agent}` if the workspace is not ready, or re-sends pending prompts and interrupts in log order if it is. `start` is idempotent per gen; the supervisor deduplicates requests by `req`. A prompt for a DO turn the supervisor has already ended receives `error {req, code:"stale"}` and becomes failed. The initial prompt `initial:<gen>` remains pending from `workspace.ready` until delivery, a non-timeout error, or its own timeout. A settled request never changes again.
- All other supervisor outputs are accepted only if the gen matches, the socket is connected and `n > lastN`. Accepting one advances `lastN` even if it otherwise changes nothing. An error with `req` and code `timeout` leaves the request pending; a non-timeout code fails it. A req-less `exit` means the agent died and stops the session (reason `agent`), resumable; other req-less errors are informational. The DO passes socket messages and close through one queue, so messages that arrived first are appended first.
- The DO sends `ack {ack:lastN}` on an accepted turn end and whenever an accepted output crosses 50 past the last recorded ack. One append sends at most one command: hello sends start/resend, and the first workspace-ready sends the initial prompt instead of acking. The next accepted output that still crosses the threshold acks. Repeated or rejected outputs do not ack. `turn_end.turn` is the DO turn; `codexTurn` is informational.
- **DO → supervisor:** `start {repo, base, branch, agent}`, `prompt {req, turn, text}`, `interrupt {req}`, `ack {ack}`. Later: `pause {op}` and `shutdown`.
- **Supervisor → DO:** `hello {version, boot}`, `workspace_ready {base, branch, commit}`, `agent_ready {kind, session}`, `delivered {req}`, `agent {kind, event}`, `turn_end {turn, codexTurn, state}`, `error {code, message, req?}`. Every output also has `{gen, n}`. Later: `wip_pushed` and `agent_saved`.

The fold, its invariants, and saved-log replays are the only unit-tested session behavior. Supervisor transport, request deduplication, frame limits, workspace cloning and Codex integration are proved against a deployment, not mocked.

## Stop and resume

There are no disk snapshots and no vaporize. A session is `running` or `stopped`.

- **Save after every turn.** An accepted turn end is the save intent. The Session DO pulls one tar from the supervisor (`GET /save` on port 7000) and writes it to R2 at `saves/<id>.tar`, overwriting the previous save. The tar holds the thread's rollout file (`codex/`), every file that differs from the base commit, committed or not, excluding ignored files (`repo/`), and the deleted paths (`deleted`). Nothing is committed for the save and nothing is pushed. Unpushed agent commits come back as uncommitted changes.
- **Stopped** is one phase whatever the cause, and the state keeps why: `user` (`scotty stop`), `idle`, `stalled`, `crashed` (with the exit code), `exited`, `deploy`, `gone` (found missing, or unreachable past the dial deadline), or `agent` (the agent exited). Stopping or failing interrupts the open turn: it is recorded as an `interrupted` turn, so the next prompt starts a new one. Work since the last finished turn is lost.
- **Watching.** Once the supervisor answers a dial, the DO calls `container.monitor()` in a background fiber (one at a time, in a `FiberHandle`) and appends `container.watched`. When the container exits, the fiber appends `container.stopped` with `crashed` and the exit code, or `exited`, so a crash is recorded when it happens rather than when someone looks. `monitor()` is only called after a dial succeeds: it settles at once for a container not yet placed (`vendor/alchemy/.../Containers/StartContainer.ts:307`). The DO also sets the container's inactivity timeout to 15 minutes. Without it, Cloudflare stopped the container 70–140 s after a quiet DO was evicted, mid-turn (`e2e/logs/2026-09-30-idle-container-stopped.jsonl`). The `watch` deadline (10 minutes, shorter than that timeout) wakes an evicted DO, which re-watches the container or records it `gone`; the wake's `sup.redial` reattaches the socket. `e2e lifecycle` proved it (2026-09-30): through 330 s with no request, the DO was evicted despite its open supervisor socket, and the turn completed after `sup.redial` reattached it.
- **Sleeping.** A running session with no open turn and no save in flight is idle; its `idle` deadline is 10 minutes after the last turn's save settles (a scripted create may pass a shorter `idleAfter`). A prompt or steer opens a turn and clears it. When it comes, the DO asks the supervisor (`GET /terminals`) how many terminal sockets are open and checks when it last forwarded a preview or terminal request; if either shows use within the window it appends `active`, otherwise `container.stopped {idle}`, which destroys the container. The check runs off the alarm handler with a 5 s limit, and the stop names the idle timeout it checked: the fold ignores it once a prompt, a turn or `active` has come since, so a steer that lands during the check keeps the session awake even if its turn finishes first. Client request ids may not start with `initial:` or `stalled:`; those are the DO's own. Either way the fold has already started the next window, so a lost alarm handler only delays sleep. An open turn has a `stalled` deadline, 30 minutes after the last accepted agent output: the fold then adds its own interrupt `stalled:<turn>`. The session stops (`stalled`) once that turn's save settles, unless the owner has started another turn, or at the next `stalled` deadline if the turn never ends. The view gives `progress.sleepsAt`; `scotty ls` shows `warm · sleeps in Nm` and `asleep · idle`.
- **Resume** (`scotty resume`, or a steer to a stopped session):
  1. Destroy any running container and start a new one (a new gen).
  2. `PUT /save` the tar, then `start` with `resume: {threadId, commit}`.
  3. Clone, check out the base commit on `scotty/<id>`, unpack `repo/`, delete the `deleted` paths.
  4. Unpack `codex/` into `CODEX_HOME` at the rollout's original relative path and resume Codex with `thread/resume {threadId, cwd, approvalPolicy, sandbox}`. Codex 0.157.1 takes no path; it finds the rollout under `CODEX_HOME` by thread ID (spike 6a).
- Pushing to GitHub is the agent's own `git push`, when asked or needed.

Old reference for the Codex state files: `worker/src/agent/codex/persistence-format.ts` and `worker/src/agent/codex/session.ts:996-1044` at `3042018`.

## Hatch

A server in a running session on port N is at `https://N-<id>.<SCOTTY_HATCH_BASE>`. The deployer makes a proxied AAAA `100::` record for `*.<base>` and the route `*.<base>/*`. The Worker has `runWorkerFirst: true`: it serves the UI itself through `ASSETS`, sends `/api/*` to the router, and sends a preview host to the Session DO's `fetch`. Port 7000 and ports outside 1024–65535 get a 404. The DO answers 502 `Session not running` unless the phase is `running`, so a preview never starts a container, and 502 `Nothing is answering on port N yet` when no server listens there. Otherwise it forwards to `getTcpPort(N)` at `http://localhost:N` without the incoming `Host` (Vite refuses unknown hosts), and returns `HttpServerResponse.raw(response)` so a 101 keeps its WebSocket. There is no nonce, cookie, quota or event: the Worker's own Access application gates the route (spike 8a b), so one token covers the UI and previews.

Spike 8a (2026-09-27): (a) `runWorkerFirst: true` still serves `/`, `/sessions`, `/s/<id>` and `/api/*`; (b) without a token a preview host gets Access's 302, and with the Worker's token it reaches the Worker; (c) a WebSocket echo passes through Worker → DO → `getTcpPort`, and the server sees `Host: localhost:8080`; (d) `setsid nohup <cmd> > log 2>&1 < /dev/null &` from a Codex command survives the command and the turn in Codex 0.157.1. A process does not survive the container sleeping.

The dev environment belongs to the agent, and nothing in an agent adapter knows about it. The image adds `curl`, `sudo` and `xz-utils`, gives `scotty` passwordless sudo, and runs on `standard-1` (4 GiB). `container/AGENTS.md` is installed as `/etc/scotty/AGENTS.md`, and each agent's global-instructions path links to it (Codex: `~/.codex/AGENTS.md`, loaded on start and resume). The supervisor gives the agent process one variable, `SCOTTY_HATCH=https://{port}-<id>.<base>`, from `start.hatch`. The contract: setup goes through `.agents/setup`, an idempotent bash script in the repository that the agent writes if missing and runs again after a resume, and that ends by printing `Ready: <URL>` once the dev server answers. Scotty never parses or runs it. The deployer sets `SCOTTY_HATCH_BASE` to the stage's domain as a plain Worker variable. On `dev` with a Vite + React repo, the URL came back 45–104 s after `new`; after a stop, most of the wait is Scotty preparing the workspace (34–186 s), not setup (about 12 s).

## Credentials

- **One store.** The Creds DO holds the ChatGPT access token, refresh token, expiry and account ID, plus the GitHub token. Only the ChatGPT access token ever leaves it (below).
  - Today the owner runs `scotty login chatgpt` when `doctor` reports sign-in missing or expiring. Automatic refresh and sign-out are deferred until after the owner trial.
- **Sign-in runs on the Worker** (spike 1a). The Creds DO runs Codex's device-code flow against `https://auth.openai.com` with client ID `app_EMoamEEZ73f0CkXaXp7hrann`:
  1. `POST /api/accounts/deviceauth/usercode` (JSON `client_id`) → `device_auth_id`, `user_code`, string `interval`. The user opens `/codex/device`.
  2. `POST /api/accounts/deviceauth/token` (JSON `device_auth_id`, `user_code`). Only 403 `deviceauth_authorization_pending` means pending; any other non-200 fails with its status and error code. A 200 returns `authorization_code`, `code_verifier`, `code_challenge`.
  3. `POST /oauth/token`, **form-encoded** (`grant_type=authorization_code`, `client_id`, `code`, `redirect_uri=https://auth.openai.com/deviceauth/callback`, `code_verifier`), sent once: the code may be consumed even if the reply is lost.
  - The account ID is `["https://api.openai.com/auth"].chatgpt_account_id` in the ID token. Expiry is the access token's `exp`.
- **Refresh (deferred, provisional):** `POST /oauth/token`, **JSON** `{grant_type: "refresh_token", client_id, refresh_token}`. Reassess the schedule and lost-reply/network retry policy after the trial before implementation.
  - The refresh token rotates on every refresh, so the old one is dead once the call succeeds.
  - Only one refresh runs at a time.
  - The new tokens replace the old in one storage write.
  - A lost reply, or a 200 without both tokens, is unknown: sign-in is required, and the old token is never retried.
  - 401, 400 `invalid_grant` and `refresh_token_{expired,reused,invalidated}` are permanent; other failures are transient.
- **OAuth errors** record the HTTP status and upstream `error`/`code`, never token fields.
- **Sign-out (deferred)** would revoke at `https://auth.openai.com/oauth/revoke`.
- **ChatGPT token in Codex's config** (spike 1e). chatgpt.com answers 403 to every request from a Worker or DO, but not to requests from the container. So the model call goes from the container directly:
  - At `start` the Session DO asks the Creds DO for `{token, accountId}` and sends them over the supervisor socket only; they never enter the event log. The Creds DO refuses a token with less than 24 hours left (the access token lives 10 days), and the session fails with `signin_required`.
  - `config.toml` (mode 0600) sets `base_url = "https://chatgpt.com/backend-api/codex"`, `experimental_bearer_token = <token>`, `http_headers = { "chatgpt-account-id" = … }`, `wire_api = "responses"`, `requires_openai_auth = false`, `supports_websockets = false`, zero retries, and `[features] plugins = false` (spike 1c). Codex runs with an explicit environment allowlist.
  - The token is in no environment variable, so commands the agent runs don't inherit it. An env var did not work: in Codex 0.157.1, `[shell_environment_policy] exclude = ["SCOTTY_*"]` still let commands see it (e2e run 4). e2e `core` checks with `env | grep -c SCOTTY_`.
  - Risk accepted for a single user: code in the container can read `config.toml` and use the token until it expires. The refresh token never leaves the Creds DO.
- **Claude (owner, 2026-09-28).** Claude runs only on the owner's Claude subscription, the way t3code runs it: the official Agent SDK drives the real `claude` binary, and Scotty never runs a Claude login itself.
  - **Sign-in happens on the owner's laptop.** `scotty login claude` runs `claude setup-token`: the browser opens and the owner signs in. The CLI takes the `sk-ant-oat01-…` token from its output and sends it to the Creds DO. If it can't read the output, the owner pipes the token in on stdin, as with `gh auth token | scotty login github`. Settings → Accounts has a paste field for the phone.
  - **Pushed once, not synced.** The setup token lasts a year and never rotates, and the laptop's own `claude` login is untouched. `doctor` shows its expiry. Copying the laptop's normal Claude login isn't an option: it is a token that expires within hours plus a refresh token that rotates on use, so the laptop and Scotty would log each other out.
  - **Delivery:** at `start`, the Session DO sends the token over the supervisor socket only, never through the event log. The supervisor starts Claude with `CLAUDE_CODE_OAUTH_TOKEN` in that process's environment, and Claude calls `api.anthropic.com` directly. Claude Code 2.1.284 strips the variable from the commands it runs: a Bash tool call saw `ANTHROPIC_BASE_URL` but not the token (spike 10a). Accepted risk, as with Codex: code in the container can read it from the Claude process. Through the Agent SDK (0.3.284, compiled with Bun, a real setup token), neither a tool call's env, a file under HOME nor stderr held the token.
  - **Runtime (spike 10a, SDK 0.3.284, claude 2.1.284, local and in a Linux container as `scotty`):** `ClaudeRunner` keeps one `query()` per session with streaming input. A new session passes `sessionId`, a resume `resume`; Claude sends nothing before the first prompt. Steers are pushed into the running query and fold into its turn; the DO turn ends on the `result` with no queued messages that answers one of its messages (`queued_turn_count`, `user_message_uuids`). `interrupt()` keeps the process; with no `result` in 3 s the runner ends the turn and relaunches with `resume`. `env` is an allowlist. Frames keep only text and thinking deltas and Edit/Write patches. The save tar holds only `~/.claude/projects/-workspace-repo/<id>.jsonl`.
  - **Claude Code guards itself:** it refuses a `pkill` whose pattern matches its own process. The crash check in `e2e/stop-resume.ts` has the shell kill its parent (`kill -9 $PPID`) instead.
- **git (spike 7a).** One GitHub token, set once with `gh auth token | scotty login github`; any repository it can reach works, with no repository list.
  - The supervisor sets `url."http://github.internal/api/git/".insteadOf https://github.com/`, plus `user.name` and `user.email` from `start.git`. The container has no GitHub credential and no credential helper.
  - The Creds DO checks the token with `GET https://api.github.com/user` when it is set and stores `login`, `name` (falls back to `login`) and `email` (falls back to `<id>+<login>@users.noreply.github.com`). `new` resolves the default branch with the token; no token, or a GitHub error, is a 400 with the hint `scotty login github`.
  - Before each `container.start` that starts a container, the Session DO awaits the raw `storage.container.interceptOutboundHttp("github.internal", ctx.exports.default({ props: { session, repo } }))`. `ctx.exports.default` is the Worker's own loopback (Alchemy's entry is `export default makeWorkerBridge(WorkerEntrypoint, …)`, `Workers/Sources/Rolldown.ts:259`). A new container needs a fresh install; a DO restart with the container still running keeps it. Alchemy's `interceptOutboundHttp` wrapper drops the promise (`Containers/ContainerPlatform.ts:196-200`), so the raw call is used.
  - The Worker reads identity only from `ctx.props` (`WorkerExecutionContext.raw.props`), never from `Host` or anything the container sends. A request without props, such as a public one through Access, gets 404. The path is under `/api/` because the static-assets layer answers everything outside `runWorkerFirst: ["/api/*"]`, loopback traffic included.
  - The handler allows only smart-HTTP paths for the session's own repository, and in `git-receive-pack` only updates to `refs/heads/scotty/*` (it buffers the push body to read the commands; a body that is only a flush-pkt is git's auth probe and passes). It strips incoming auth and hop-by-hop headers, adds the real token, and forwards to `https://github.com`.
  - GitHub throttles Cloudflare's shared egress (429, or 403 with `retry-after` or `x-ratelimit-remaining: 0`, which the handler returns as 429). The supervisor retries only 429, 5xx and dropped transfers, backing off from 1 s to 30 s; clone and resume fetch share a 240 s budget, so no attempt starts after ~270 s of the 360 s `workspace` deadline. A transfer stalled for 30 s fails and is retried. Any other 4xx fails at once.
- **No HTTPS interception.** Git goes over plain HTTP to `github.internal`. The raw Container API also has `interceptOutboundHttps` (workers-types `index.d.ts:4001`), which Alchemy doesn't wrap; it isn't needed.
- **Port from `3042018`:** the header cleanup for the git handler in `worker/src/egress/worker.ts:95-123,164-240,428-443`, and the Codex config shape in `worker/src/agent/codex/process.ts:204-270`.

## API the UI needs

The same origin serves `/api/*` and `ui/dist`, with the error format `{error:{message,code?,hint?}}`.

The conversation snapshot includes top-level `currentTurn`, the authoritative turn identity for steer and interrupt writes. `turns[].id` remains the stable message identity.

### Served now

| Endpoint                                                                     | Source                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `GET/POST /api/sessions`, `GET /api/sessions/:id`                            | Creds DO session index and each Session DO's view    |
| `GET /api/sessions/:id/conversation`, `GET /api/sessions/:id/log`            | Folded agent events and the raw event log            |
| `POST /api/sessions/:id/steer`, `POST /api/sessions/:id/interrupt`           | `prompt.requested` and `interrupt.requested`         |
| `GET /api/credentials/chatgpt`, `POST /api/credentials/chatgpt/{start,poll}` | Creds DO ChatGPT status and device-code sign-in      |
| `GET/POST /api/credentials/github`; `/api/git/*` (loopback only)             | Creds DO GitHub token; git handler                   |
| `GET /api/sessions/:id/files/:file`; `PUT files.internal` (loopback only)    | R2 `files/<session>/<file>`; `file.attached`         |
| `DELETE /api/sessions/:id`                                                   | A stopped or failed session: log, save, files, index |
| `POST /api/sessions/:id/{stop,resume}`                                       | Session DO stop, and `resume.requested`              |
| `GET /api/sessions/:id/hatch/:port`; `<port>-<id>.<hatch base>`              | Hatch preview URL and routing                        |
| `GET /api/sessions/:id/terminal` (WebSocket)                                 | A shell in the session's container                   |
| `GET /api/sessions/live`, `GET /api/sessions/:id/live` (WebSocket)           | Pushed list and session updates (below)              |
| `GET/POST /api/credentials/claude`                                           | Creds DO Claude token status                         |
| `GET /api/settings`, `PUT /api/settings/instructions`                        | Creds DO instructions and skill list                 |
| `PUT /api/skills`, `PATCH/DELETE /api/skills/:name`                          | R2 `skills/<name>` and the Creds DO skill list       |
| `GET /api/version`                                                           | The deployed Worker's version                        |

### Live updates

The UI doesn't poll; the server pushes. Both sockets are hibernatable WebSockets accepted by a Durable Object, and a client sends nothing on them (a message closes the socket).

- **Session:** `/api/sessions/:id/live` is accepted by the Session DO. On connect, and after appends, it sends `{kind:"snapshot", seq, session, conversation}`: `session` and `conversation` are what `GET /api/sessions/:id` (its `session`) and `/conversation` return, and `seq` is the last event's, so a client drops an older frame. The conversation replays the log, so pushes are coalesced: after an append, one push 250 ms later carries everything appended meanwhile. Watching isn't using: the live route doesn't touch the idle window, so an open page doesn't keep a session awake.
- **List:** `/api/sessions/live` is accepted by the owner's Creds DO, which holds the session index. When a push finds the session's view changed from the last one it sent (kept in memory), the Session DO calls the Creds DO, which sends `{kind:"session", session}`; deleting a session sends `{kind:"removed", id}`. The client reads `GET /api/sessions` on each connect, then applies frames.
- A push is not state: a lost one is repaired by the next, or by the snapshot a reconnect gets. The UI reconnects with backoff (1 s doubling to 30 s), at once when the tab shows again or the network returns, and says "Reconnecting…" after 3 s without a socket.

### Later

`changes[/patch]` and `repos`.

## CLI

Agent-first: an agent or a script is the primary user, and a person reading it gets the same clarity.

- **Output:** one JSON value on stdout with `--json`, or when stdout is not a terminal. In a terminal the output is readable text, coloured unless `NO_COLOR` is set. Progress and prompts go to stderr.
- **Errors:** `{"error":{"code","message","hint"}}` on stdout in JSON mode, otherwise `✗ message` and `→ hint` on stderr. The exit code is 1 for a request or agent failure, 2 for bad usage, and 3 when setup is missing (no address, no Access login, not signed in). `hint` is the exact command that fixes it.
- **Target:** `SCOTTY_URL`, else `https://<host>` from the CLI config (`~/.config/scotty/config.json`: stage, email, accountId, domain, zoneId, host); never derived. Access comes through `cloudflared access token` at run time; the CLI stores no token.
- **Ids:** a session id can be given as its first 4+ characters; an ambiguous or unknown prefix is an error.
- **Setup:** `doctor` checks the address, Access, the Worker's version, and each sign-in (ChatGPT, GitHub, Claude), with each account's expiry and the fix for each problem. `login chatgpt` runs the device code: it prints the code, opens the page, and polls. `login github` saves the token from stdin, or from `gh auth token`. `login claude` runs `claude setup-token` and saves the token, or reads it from stdin.
- **Sessions:** `new <owner/repo> <prompt> [--agent codex|claude] [--key k]` is idempotent on `--key` and uses the repository's default branch. `ls` lists sessions. `read <id> [--last N] [--role user|assistant]` prints the session state and recent messages (default 1, maximum 500; role filtering precedes the limit; empty assistant text is omitted). `log <id>` prints the raw events. There is no `watch`: callers choose when to read again. `steer <id> <text>` and `interrupt <id>` take an optional `--req` for retries. `stop`, `resume`, `open [id]` and `hatch <id> <port>` do what they say. `rm <id…>` deletes stopped or failed sessions with their saves and files, after resolving every id; a running one answers 409 with the hint `scotty stop <id>`.
- **What sessions get:** `push skill <folder|zip…>`, `push instructions <file|->`, `ls skills` and `rm skill <name>`.
- **Help:** `scotty --help` lists every command; `scotty <command> --help` is short and most end with one runnable example.

## Deploy

- **Image:** CI builds the default image from `container/Dockerfile` (supervisor included), publishes it to a public OCI registry, and records its linux/amd64 manifest digest; `container/image.digest` pins it, and each CLI release embeds it. The image's `scotty.supervisor` label is `supervisorVersion` from `protocol/supervisor.ts`. No local Docker is needed to deploy or develop.
- **Release:** `deploy/release.ts` bundles `deploy/entry.js` (Alchemy's generated Worker entry, reading the stage from the Worker's `ALCHEMY_STAGE`, so one bundle serves every stage) with rolldown and `@alchemy.run/cloudflare-runtime`, copies `ui/dist` without its prerender `server/`, and writes `release.json` (`version`, the pinned image, `supervisor`). Alchemy stays the Worker's runtime; it no longer deploys.
- **Binary:** `deploy/compile.ts` builds a release, packs it with `skills/scotty/SKILL.md` into `dist/release.pack` (paths to base64), and compiles `cli/binary.ts` for darwin-arm64, darwin-x64 and linux-x64 with the pack embedded (`with { type: "file" }`); macOS binaries are ad-hoc signed. The binary unpacks the release into a temporary folder for a deploy. From a checkout the CLI builds the release in a `bun` subprocess instead, so the binary never bundles rolldown. `.github/workflows/release.yml` runs on a tag `v<version>`: it publishes the three tarballs, `checksums.txt` and `install.sh` on GitHub Releases, then writes `Formula/scotty.rb` (depends on `cloudflared`) to the tap `Yeshwanthyk/homebrew-scotty`.
- **Deployer:** `scotty deploy` takes that release and `deploy/deployer.ts` applies it with direct Cloudflare API calls: it copies the pinned image into `registry.cloudflare.com/<account>/scotty@sha256:<digest>` over the OCI distribution API with short-lived registry credentials (verifying every digest, streaming blobs, never logging or persisting the credential), then makes or updates the bucket, the web app's assets (wrangler's hash: the first 32 hex of sha256(bytes + extension), so unchanged files are skipped), the Worker (both DOs, one migration `v1` only when its `SessionObject` namespace is new, the container binding, and the plain-text vars Alchemy's runtime reads: `ALCHEMY_PHASE=runtime`, `ALCHEMY_WORKER_NAME`, `ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`, `ALCHEMY_CLOUDFLARE_ACCOUNT_ID`), the container app (a changed image is a 100% rolling rollout), the custom domain, the Access application (owner email only), the preview record and the route. Proved on `main` by a spike (2026-09-29).
- **Nothing is remembered between runs.** Every resource is found by its name, so `teardown` removes a stage by name and then lists what is left; the config is kept until nothing is.
- Copy rather than pull: Cloudflare can pull public Docker Hub images directly but does not cache them, so every cold start would pull from Docker Hub under its rate limits; GHCR is not a supported pull source.
- **Custom images:** `deploy --image docker.io/<repo>@sha256:<digest>` deploys an image built `FROM` the pinned one through the same copy. Before anything is pushed, its config's `scotty.supervisor` label must equal the release's `supervisor`, or the deploy is refused and names the image to build from. It lasts until the next deploy without `--image`.
- Don't use Alchemy's local `dev` Container runtime; it runs Docker (`vendor/alchemy/website/src/content/docs/cloudflare/local-development.mdx:79-80`).
- **Stage:** explicit, from the CLI config. It is never derived from the user, machine or account. Resources are named `scotty-<stage>` (Worker), `scotty-<stage>-sessions` (container app) and `scotty-<stage>-artifacts` (bucket); the Worker serves the config's `host` as a custom domain. Changing a name replaces the resource: a new Worker has empty Durable Objects (sessions and sign-ins are gone), and a bucket that still holds files can't be deleted until it is emptied.
- **Cloudflare credentials:** an API token from `CLOUDFLARE_API_TOKEN`, or pasted after `init`, `deploy` or `teardown` opens the dashboard's token page with the permissions filled in. It is held in memory for that run only, checked by listing its accounts, and never saved or deployed.
- **Updates:** each CLI release carries its own release, so updating is a new CLI followed by `scotty deploy`.
- No patches on Alchemy or other dependencies unless a beta.79 failure is shown.

### Alchemy beta.79 runtime workarounds (shown on `dev`, 2026-09-26)

- **Props run at runtime too.** A resource's props `Effect` (for example `Config.String("SCOTTY_OWNER_EMAIL")` in `src/worker.ts`, `SCOTTY_IMAGE` in `src/session/object.ts`) is evaluated inside the deployed bundle, where those vars are absent. A missing `Config` there crashed every request with error 1101. Fix: `Config.withDefault("")` on those props (`5e5cdcc`).
- **DO migrations are computed per logical ID.** Binding the session Container under a second logical ID re-added `new_sqlite_class` for the Session DO and the deploy failed; sharing the env key instead dropped the container metadata. Fix: `src/session/container-binding.ts` binds the container application from the Session DO's own outer phase, mirroring `ContainerPlatform.bind` (`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerPlatform.ts:143-172`) without `Containers.layer`, which would start the container on every DO construction (`5551360`).
- Remove each workaround when an Alchemy upgrade makes it unnecessary, and prove it with `scotty deploy` plus `npm run e2e -- core`.

## Tests

- **Unit:** only `fold.ts`, covering its invariants, plus replays of real event logs saved as files. Each fixed bug adds its log.
- **End to end,** against a real deployment. Sessions in these tests use `fixtureRepo` (`_scotty/fixture`, `main`): a bare repository at `/opt/scotty/fixture.git` in the image, cloned without GitHub; the API skips the GitHub lookup for it. Only `github` and `hatch-env` reach GitHub.
  - Sessions run the agent's scripted stand-in (`container/scripted/`, `scotty-codex-scripted` and `scotty-claude-scripted` in the image) unless a test is given `--real`; the create body's `scripted: true` asks for it. A stand-in speaks its agent's wire protocol (Codex's app-server JSON-RPC, Claude Code's stream-json for the Agent SDK), so the supervisor's adapters run unchanged, and it reads each prompt as a script: `run <command>`, `sleep <s>`, `say <text>` with `{{out}}` (the last output) and `{{recall}}` (the first prompt, read back from the saved session file, so it proves resume). Its messages are typed against the pinned SDK and against `codex-protocol.ts`, generated by `npm run protocol:codex` from the pinned Codex, so typecheck fails when they drift. A spec gives shapes, not ordering or timing; a real session that shows otherwise becomes a replay. `github`, `hatch-env` and `files` test what the agent does, so they run the real Codex.
  1. `deploy` → create → Codex answers → `steer` → `interrupt`.
  2. The real token never appears in the container (scan env, files and process arguments).
  3. `stop` → `resume`: the Codex thread continues, and a marker file written in the first turn survives.
  4. Killing the container mid-turn ends `stopped` and resumes from the last finished turn.

## Slices

The order of work is in `plan.md` ("Order of work"): stop and resume, private repositories and push, Hatch, images and video in chat, Claude, Pi, then the UI. ChatGPT refresh, `scotty deploy` and cutover are deferred.

## Open questions to settle early

- ~~Can the Worker run the ChatGPT device-code sign-in itself (Codex's `login --device-auth` flow), and what does the refresh endpoint look like?~~ **Answered by spike 1a (deployed, 2026-09-26): yes.** No bot check on Worker egress to `auth.openai.com`. The refresh token rotated on the one refresh. The ID token lives one hour; the access token's lifetime was not measured. The first run failed because Effect's `bodyText` sets `text/plain` over an explicit content type (`HttpClientRequest.ts:693-700`, `internal/httpBody.ts:9-11`); the code exchange must use `bodyUrlParams`. The fallback (CLI sign-in) is not needed. Not covered: a second refresh with the rotated token, a refresh that races another, and whether re-polling after a successful exchange is safe.
- ~~Does `getTcpPort(...).fetch` support a WebSocket upgrade from the DO to the container on Alchemy beta.79?~~ **Answered by spike 1b (deployed, 2026-09-26): yes.** The DO sends `port.fetch` with `Upgrade: websocket`, takes `webSocket` from the 101 response and calls `accept()`. Pings and ticks flowed both ways for 600 s with no reconnect, 43–71 ms echo latency. The `/sup/<id>` fallback is not needed. Not covered: a DO restart or redeploy closes the socket and nothing reconnects it; cold start was not measured; an open outbound socket keeps the DO resident (no hibernation).
- ~~Does Codex send anything to `chatgpt.com` outside `base_url`?~~ **Answered by spike 1c (Codex 0.157.0, run locally, 2026-09-26):**
  - (Historical: this was the `/p/chatgpt` swap design that spike 1e replaced.) With the provider config of that time, a full turn with tool use (write `hello.txt`, run `cat hello.txt`) sent all 3 model requests as `POST <base_url>/responses` through the swap proxy, with only a sentinel in Codex's environment. No login or refresh call was needed.
  - With plugins enabled (the default), Codex also opened one direct `chatgpt.com:443` connection and two `github.com:443` connections: the curated-plugin startup sync (`git ls-remote`/`fetch` of `openai/plugins`, and most likely `chatgpt.com/backend-api/plugins/export/curated`). With `[features] plugins = false`, a fresh run made no connection outside `base_url`.
  - Limit: the egress observer saw only traffic that honours `HTTPS_PROXY`/`HTTP_PROXY`. The container's own egress rules are the backstop.
  - `account/login/start` with `type: "chatgptAuthTokens"` (seen in t3code) rejects an opaque sentinel with `invalid ID token format`; it needs a real JWT and is marked internal-only. Scotty does not use it.
  - The model must be one the ChatGPT account allows: `gpt-5.5` worked; `gpt-5.1-codex` and `gpt-5.4` returned HTTP 400. The model is a setting, not a constant.
- ~~Can Scotty deploy its Container from a prebuilt image without a local Docker?~~ **Answered by spike 1d (deployed, 2026-09-26): yes, by copy.** An Effect script copied a digest-pinned linux/amd64 image into `registry.cloudflare.com/<account>/<repo>` over the OCI HTTP API with `Containers.createContainerRegistryCredentials` (account-wide, pull+push, 60 min), and Alchemy deployed it as pre-pushed with no docker on PATH; the DO got HTTP 200. Not covered: a direct `docker.io` pull (the nginx test image crashed the same way from both registries; Cloudflare documents Docker Hub as supported but uncached); digest verification, streaming and retries for a multi-GB image; registry size limits; first boot of the real image (a 4.6 MB image took 22.7 s after a rollout); garbage collection of copied images.
- How does container development work without local Docker? Each `container/` change otherwise needs a CI image build before a dev deploy. Options: a CI workflow on push to `rebuild/core`; a stable base image with the compiled supervisor fetched at start by digest; a remote builder. Settle this before deploying.
