# Scotty design

Scotty runs coding-agent sessions in Cloudflare Containers and drives them from a phone-friendly web UI and one CLI. This is a rebuild. The old implementation is at `3042018` on `main`; port from it only where this document says so.

## Scope of v1

- **Single user.** Cloudflare Access for the owner's email is the only login. No pairing, devices, owner transfer or root token.
- **Credentials live on the Worker.** ChatGPT sign-in is `scotty signin` today; the UI control comes in step 9. Nothing is copied from a local machine.
  - ChatGPT subscription, used by Codex.
  - A GitHub token, used by git.

  Claude, Pi providers, custom providers and `gh` come later, with the same providers shape.

- **One agent: Codex** (`codex app-server` over stdio). The contracts are agent-neutral so Claude and pi can be added later as a new case, not a breaking change: the supervisor's `start` carries `agent: {kind: "codex", ...}`, agent output is `agent {n, kind, event}`, the supervisor runs Codex behind an agent-runner interface, and only `view.ts` interprets agent events, per `kind`.
- **One runtime: a Cloudflare Container.** It runs the default image this repository ships, or an image the user supplies that meets the supervisor contract.
- **The UI is reduced to the core flow in step 5.** Later steps add back only what the owner trial needs.

## Layout

```
alchemy.run.ts        the whole stack: Worker, Session DO + Container, Creds DO, R2, Access
src/
  worker.ts           Effect HttpRouter: /api/* and UI assets; /p/github is step 6, previews step 11
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
    object.ts         Creds DO: ChatGPT sign-in and refresh, session access token, GitHub token
    swap.ts           /p/github/* handler (planned, step 6)
container/
  Dockerfile          default image: Node, git, Codex, the dev toolchain, supervisor
  supervisor/         scotty-sup: WebSocket server; runs codex app-server; git; pause/resume
cli/
  main.ts             Effect CLI: doctor, signin, new, ls, show, read, steer, interrupt, log (deploy later)
  client.ts           typed API client behind Access; shared with e2e/
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

| Event                                                                  | Fields                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`                                                              | `repo, baseBranch, branch, title, prompt, image, agentKind` (`branch` is the work branch `scotty/<session id>`, chosen at create time)                          |
| `container.start` / `sup.hello`                                        | `gen` / `gen, n, version, boot` (`boot` identifies one supervisor process)                                                                                      |
| `workspace.ready`                                                      | `gen, n, base, branch, commit`                                                                                                                                  |
| `agent.ready`                                                          | `gen, n, agentKind, session` (the agent's session id)                                                                                                           |
| `prompt.requested` / `prompt.delivered`                                | `req, turn, text, images` / `gen, n, req` (delivery settles a prompt or interrupt; client `req` cannot start with `initial:`)                                   |
| `interrupt.requested`                                                  | `req, turn`                                                                                                                                                     |
| `agent.event`                                                          | `gen, n, agentKind, event` (the raw agent notification; the fold does not interpret it)                                                                         |
| `turn.ended`                                                           | `gen, n, turn, codexTurn, state` (`turn` is the DO turn; `codexTurn` is recorded, not matched)                                                                  |
| `sup.error`                                                            | `gen, n, code, message, req?` (a pending `req` fails except on `timeout`; `stale` fails it too; req-less `exit` fails the session as `agent_exited`, retryable) |
| `failed`                                                               | `phase, code, retryable`                                                                                                                                        |
| `socket.closed` / `dial.failed`                                        | `gen`                                                                                                                                                           |
| `sup.redial`                                                           | `gen` (on wake, start if no hello; otherwise dial)                                                                                                              |
| `invariant.violated`                                                   | `code, detail`                                                                                                                                                  |
| `timeout`                                                              | `op`: `container`, `workspace`, `dial`, `redial`, or `req:<req>`; lifecycle expiry fails with `<op>_timeout`, retryable                                         |
| `pause.requested` / `wip.pushed` / `agent.saved` / `container.stopped` | `op` / `commit` / `r2Key, sha` / `gen` (later)                                                                                                                  |
| `resume.requested` / `agent.restored`                                  | `op` / `threadId` (later)                                                                                                                                       |
| `vaporize.requested` / `gone`                                          | `op` (later)                                                                                                                                                    |

Fold states, and the status the UI shows for each:

| State                      | UI status              |
| -------------------------- | ---------------------- |
| `provisioning`, `resuming` | `booting`              |
| `running`                  | `warm`                 |
| `pausing`                  | `warm` (transitioning) |
| `paused`                   | `sleeping`             |
| `failed`                   | `failed`               |
| `deleting`, `gone`         | `gone`                 |

Invariants are checked on every append. A violation appends an `invariant.violated` event and alerts; it does not throw. `scotty log <id>` shows the timeline. `scotty replay <id>` downloads the events and runs the same fold locally, stopping at the first bad event.

Duplicate requests (the same `req`) do nothing. A prompt whose `turn` no longer matches is answered with `stale`, which the UI already understands.

## Supervisor

`scotty-sup` is the container's entrypoint. It listens on port 7000. The Session DO connects to it with `container.getTcpPort(7000)` and upgrades to a WebSocket. That traffic never leaves Cloudflare, so the supervisor needs no auth token and no public route.

- Don't use `Cloudflare.Containers.layer` in the Session DO. It starts the container on every DO construction (`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/StartContainer.ts:398-402`), so reading a paused session would boot it. Use the container handle's `start()`, `destroy()` and `running` (`Container.ts:137-147`) from the fold's commands. `start()` returns before the container boots (`ContainerPlatform.ts:213`), so the dial retries until `hello` arrives or the fold's deadline fires.
- Dialing is an outside action: the DO appends `container.start {gen}`, then starts and dials outside the handler. `start()` returns before boot; the fold's `container` deadline bounds boot to `hello`, `workspace` bounds hello to workspace readiness, and `dial` bounds a lost socket. A failed dial never extends that deadline. The single alarm also drives `redial` retries every 2 seconds; the DO keeps no other timer.
- On wake, `sup.redial` starts the container if hello has not arrived (start if it is not running, then dial); otherwise it dials `ws://container/?gen=<gen>&after=<lastN>`. `lastN` is the highest accepted supervisor output number, regardless of output type. The supervisor replays stored outputs after that number without waiting for an ack message.
- `hello {gen, n:1, version, boot}` is the reconnect handshake. It is accepted while disconnected with a pending container or dial operation, even if `n:1` is below `lastN`; it never decreases `lastN`. A changed boot for the same gen fails the session with `supervisor_restarted`, retryable. A repeated hello while connected does nothing. A new gen after failure is later work.
- After hello, the DO sends `start {repo, base, branch, agent}` if the workspace is not ready, or re-sends pending prompts and interrupts in log order if it is. `start` is idempotent per gen; the supervisor deduplicates requests by `req`. A prompt for a DO turn the supervisor has already ended receives `error {req, code:"stale"}` and becomes failed. The initial prompt `initial:<gen>` remains pending from `workspace.ready` until delivery, a non-timeout error, or its own timeout. A settled request never changes again.
- All other supervisor outputs are accepted only if the gen matches, the socket is connected and `n > lastN`. Accepting one advances `lastN` even if it otherwise changes nothing. An error with `req` and code `timeout` leaves the request pending; a non-timeout code fails it. A req-less `exit` means the agent died and fails the session as `agent_exited`, retryable; other req-less errors are informational. The DO passes socket messages and close through one queue, so messages that arrived first are appended first.
- The DO sends `ack {ack:lastN}` on an accepted turn end and whenever an accepted output crosses 50 past the last recorded ack. One append sends at most one command: hello sends start/resend, and the first workspace-ready sends the initial prompt instead of acking. The next accepted output that still crosses the threshold acks. Repeated or rejected outputs do not ack. `turn_end.turn` is the DO turn; `codexTurn` is informational.
- **DO → supervisor:** `start {repo, base, branch, agent}`, `prompt {req, turn, text}`, `interrupt {req}`, `ack {ack}`. Later: `pause {op}` and `shutdown`.
- **Supervisor → DO:** `hello {version, boot}`, `workspace_ready {base, branch, commit}`, `agent_ready {kind, session}`, `delivered {req}`, `agent {kind, event}`, `turn_end {turn, codexTurn, state}`, `error {code, message, req?}`. Every output also has `{gen, n}`. Later: `wip_pushed` and `agent_saved`.

The fold, its invariants, and saved-log replays are the only unit-tested session behavior. Supervisor transport, request deduplication, frame limits, workspace cloning and Codex integration are proved against a deployment, not mocked.

## Pause and resume

There are no disk snapshots.

- **Pause:**
  1. The supervisor stops Codex cleanly.
  2. It commits everything and pushes `scotty/<id>/wip`.
  3. It uploads `$CODEX_HOME/sessions/**/rollout-*.jsonl` and the thread ID to R2 through the Worker.
  4. The DO appends the results and stops the container.
- **Resume:**
  1. Start a new container.
  2. Clone the repository and check out the WIP branch.
  3. Restore the rollout file.
  4. Reinstall dependencies.
  5. Resume Codex with `thread/resume <threadId>`.

Old reference for the Codex state files: `worker/src/agent/codex/persistence-format.ts` and `worker/src/agent/codex/session.ts:996-1044` at `3042018`.

## Credentials

- **One store.** The Creds DO holds the ChatGPT access token, refresh token, expiry and account ID, plus the GitHub token. Only the ChatGPT access token ever leaves it (below).
  - It refreshes the ChatGPT token itself before expiry: a refresh intent, a call outside the state change, then the result.
  - If a refresh result is unclear, it asks for a new sign-in rather than retrying.
- **Sign-in runs on the Worker** (spike 1a). The Creds DO runs Codex's device-code flow against `https://auth.openai.com` with client ID `app_EMoamEEZ73f0CkXaXp7hrann`:
  1. `POST /api/accounts/deviceauth/usercode` (JSON `client_id`) → `device_auth_id`, `user_code`, string `interval`. The user opens `/codex/device`.
  2. `POST /api/accounts/deviceauth/token` (JSON `device_auth_id`, `user_code`). Only 403 `deviceauth_authorization_pending` means pending; any other non-200 fails with its status and error code. A 200 returns `authorization_code`, `code_verifier`, `code_challenge`.
  3. `POST /oauth/token`, **form-encoded** (`grant_type=authorization_code`, `client_id`, `code`, `redirect_uri=https://auth.openai.com/deviceauth/callback`, `code_verifier`), sent once: the code may be consumed even if the reply is lost.
  - The account ID is `["https://api.openai.com/auth"].chatgpt_account_id` in the ID token. Expiry is the access token's `exp` (refresh 5 minutes before it).
- **Refresh:** `POST /oauth/token`, **JSON** `{grant_type: "refresh_token", client_id, refresh_token}`.
  - The refresh token rotates on every refresh, so the old one is dead once the call succeeds.
  - Only one refresh runs at a time.
  - The new tokens replace the old in one storage write.
  - A lost reply, or a 200 without both tokens, is unknown: sign-in is required, and the old token is never retried.
  - 401, 400 `invalid_grant` and `refresh_token_{expired,reused,invalidated}` are permanent; other failures are transient.
- **OAuth errors** record the HTTP status and upstream `error`/`code`, never token fields.
- **Sign-out** revokes at `https://auth.openai.com/oauth/revoke`.
- **ChatGPT token in Codex's config** (spike 1e, `work/spikes/1e/RESULT.md`). chatgpt.com answers 403 to every request from a Worker or DO, but not to requests from the container. So the model call goes from the container directly:
  - At `start` the Session DO asks the Creds DO for `{token, accountId}` and sends them over the supervisor socket only; they never enter the event log. The Creds DO refuses a token with less than 24 hours left (the access token lives 10 days), and the session fails with `signin_required`.
  - `config.toml` (mode 0600) sets `base_url = "https://chatgpt.com/backend-api/codex"`, `experimental_bearer_token = <token>`, `http_headers = { "chatgpt-account-id" = … }`, `wire_api = "responses"`, `requires_openai_auth = false`, `supports_websockets = false`, zero retries, and `[features] plugins = false` (spike 1c). Codex runs with an explicit environment allowlist.
  - The token is in no environment variable, so commands the agent runs don't inherit it. An env var did not work: in Codex 0.157.1, `[shell_environment_policy] exclude = ["SCOTTY_*"]` still let commands see it (e2e run 4, `work/step2/env-names.out`). e2e `core` checks with `env | grep -c SCOTTY_`.
  - Risk accepted for a single user: code in the container can read `config.toml` and use the token until it expires. The refresh token never leaves the Creds DO.
- **git:** `url."https://<host>/p/github/".insteadOf https://github.com/`, with a credential helper that returns the sentinel. `/p/github` allows only smart-HTTP paths for the session's repository and swaps in the real token.
- **No HTTPS interception.** Alchemy beta.79 exposes only `interceptOutboundHttp`, and routing by base URL needs no TLS tricks.
- **Port from `3042018`:** the header cleanup and host checks for `/p/github` in `worker/src/egress/worker.ts:95-123,164-240,428-443`, and the Codex config shape in `worker/src/agent/codex/process.ts:204-270`.

## API the UI needs

The same origin serves `/api/*` and `ui/dist`, with the error format `{error:{message,code?,hint?}}`.

### Served now

| Endpoint                                                                     | Source                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `GET/POST /api/sessions`, `GET /api/sessions/:id`                            | Creds DO session index and each Session DO's view |
| `GET /api/sessions/:id/conversation`, `GET /api/sessions/:id/log`            | Folded agent events and the raw event log         |
| `POST /api/sessions/:id/steer`, `POST /api/sessions/:id/interrupt`           | `prompt.requested` and `interrupt.requested`      |
| `GET /api/credentials/chatgpt`, `POST /api/credentials/chatgpt/{start,poll}` | Creds DO ChatGPT status and device-code sign-in   |

### Planned

| Step | Endpoints and routing                                                                |
| ---- | ------------------------------------------------------------------------------------ |
| 8    | `DELETE /api/sessions/:id`, `POST /api/sessions/:id/{sleep,resume,checkpoint}`       |
| 9    | `GET /api/sessions/:id/changes[/patch]`, `GET /api/settings`, `GET /api/repos`       |
| 11   | `/hatch`, preview routing, `/evidence`, the terminal WebSocket, and `/api/resources` |

## CLI

Agent-first: an agent or a script is the primary user, and a person reading it gets the same clarity.

- **Output:** stdout carries exactly one JSON value per command. Progress and hints go to stderr. No colour codes, no prompts, no pager.
- **Errors:** `{"error":{"code","message","hint"}}` on stdout, with a non-zero exit: 1 for a request or agent failure, 2 for bad usage, 3 when setup is missing (no `SCOTTY_URL`, no Access login, not signed in to ChatGPT). `hint` is the exact command that fixes it.
- **Target:** `SCOTTY_URL` or `--url`, never derived. Access through `cloudflared access token` at run time; nothing stored by the CLI.
- **Commands:** `doctor` checks the URL, Access, the Worker's reply and ChatGPT sign-in, and prints what to fix. `signin` runs the device code (prints the URL and code to stderr, polls, prints the result). `new <owner/repo> [--prompt text] [--key k]` is idempotent on `--key` and uses the repository's default branch. `show <id>` prints the session view and conversation; `log <id>` the raw events. `read <id> [--last N] [--role user|assistant]` returns recent messages (default 1, maximum 500), session authority and the latest turn's ID/state. Messages have stable IDs, role, turn state and text; role filtering precedes the limit, and empty assistant text is omitted. The latest turn is independent of the selected messages; it is null before any prompt appears. Callers choose when to read again: there is no `watch` command. `steer <id> <text>` and `interrupt <id>` take an optional `--req` for retries.
- **Help:** `--help` on every command is short and ends with one runnable example.

## Deploy

- **Image:** CI builds the default image from `container/Dockerfile` (supervisor included), publishes it to a public OCI registry, and records its linux/amd64 manifest digest; each CLI release embeds that digest. No local Docker is needed to deploy or develop.
- `scotty deploy` builds the UI, copies the pinned image into `registry.cloudflare.com/<account>/<explicit repository>@sha256:<digest>` over the OCI distribution API with short-lived registry credentials (verifying every digest, streaming blobs, never logging or persisting the credential), then applies `alchemy.run.ts` with `registryId: "registry.cloudflare.com"` and that digest ref, which Alchemy deploys as pre-pushed with no Docker (`ContainerProvider.ts:442-458,536-542`). The copy runs in the CLI before the apply; only the digest ref reaches Alchemy props or state.
- Copy rather than pull: Cloudflare can pull public Docker Hub images directly but does not cache them, so every cold start would pull from Docker Hub under its rate limits; GHCR is not a supported pull source.
- Later, user-supplied images use the same digest-pinned copy and are checked against the supervisor contract at `hello`.
- Don't use Alchemy's local `dev` Container runtime; it runs Docker (`vendor/alchemy/website/src/content/docs/cloudflare/local-development.mdx:79-80`).
- **Stage:** explicit, default `personal`. It is never derived from the user, machine or account.
- **State:** Alchemy local state (`Alchemy.localState()`) in `.alchemy/` at the repository root, git-ignored. Deleting it orphans the deployed stage; back it up if the stage matters.
- **Cloudflare credentials:** the Alchemy OAuth profile (`--profile default`) or `CLOUDFLARE_API_TOKEN` with the account ID from the environment; never deployed.
- **Updates:** each CLI release embeds its own stack, so updating is a new CLI followed by `scotty deploy`.
- No patches on Alchemy or other dependencies unless a beta.79 failure is shown.

### Alchemy beta.79 workarounds (shown on `dev`, 2026-09-26)

- **Props run at runtime too.** A resource's props `Effect` (for example `Config.String("SCOTTY_OWNER_EMAIL")` in `src/worker.ts`, `SCOTTY_IMAGE` in `src/session/object.ts`) is evaluated again inside the deployed bundle, where deploy-time env vars are absent. A missing `Config` there crashed every request with error 1101. Fix: `Config.withDefault("")` on those props; `alchemy.run.ts` rejects a missing value before any deploy, so the default is reached only at runtime (`5e5cdcc`).
- **DO migrations are computed per logical ID.** Binding the session Container under a second logical ID re-added `new_sqlite_class` for the Session DO and the deploy failed; sharing the env key instead dropped the container metadata. Fix: `src/session/container-binding.ts` binds the container application from the Session DO's own outer phase, mirroring `ContainerPlatform.bind` (`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerPlatform.ts:143-172`) without `Containers.layer`, which would start the container on every DO construction (`5551360`).
- Remove each workaround when an Alchemy upgrade makes it unnecessary, and prove it with `npm run deploy -- --stage dev` plus `npm run e2e -- core`.

## Tests

- **Unit:** only `fold.ts`, covering its invariants, plus replays of real event logs saved as files. Each fixed bug adds its log.
- **End to end,** against a real deployment:
  1. `deploy` → create → Codex answers → `steer` → `interrupt`.
  2. The real token never appears in the container (scan env, files and process arguments).
  3. `sleep` → `resume`: a marker file on the WIP branch survives, and the Codex thread continues.
  4. `vaporize` leaves no container, R2 objects or branch, and running it twice is safe.
  5. Killing the container mid-turn, or during a pause, ends in a correct state.

## Slices

1. Stack plus the Session DO event log plus the supervisor, running a hard-coded prompt through Codex with the owner's ChatGPT sign-in (minimal, no refresh yet) → proof: e2e 1.
2. ChatGPT refresh and sign-out in the Creds DO; the token reaches Codex through `config.toml` only (see "Credentials") → e2e 2.
3. GitHub token, `/p/github`, WIP branch pause and resume → e2e 3 and 4.
4. The rest of the UI contract: changes, settings, repos, and hiding the unused screens.
5. Hatch previews, terminal, evidence.

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
- How does container development work without local Docker? Each `container/` change otherwise needs a CI image build before a dev deploy. Options: a CI workflow on push to `rebuild/core`; a stable base image with the compiled supervisor fetched at start by digest; a remote builder. Settle before step 2 deploys.
