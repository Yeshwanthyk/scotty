# Scotty design

Scotty runs coding-agent sessions in Cloudflare Containers and drives them from a phone-friendly web UI and one CLI. This is a rebuild. The old implementation is at `3042018` on `main`; port from it only where this document says so.

## Scope of v1

- **Single user.** Cloudflare Access for the owner's email is the only login. No pairing, devices, owner transfer or root token.
- **Credentials live on the Worker.** You sign in from the web UI; nothing is copied from a local machine.
  - ChatGPT subscription, used by Codex.
  - A GitHub token, used by git.

  Claude, Pi providers, custom providers and `gh` come later, with the same providers shape.

- **One agent: Codex** (`codex app-server` over stdio). The contracts are agent-neutral so Claude and pi can be added later as a new case, not a breaking change: the supervisor's `start` carries `agent: {kind: "codex", ...}`, agent output is `agent {n, kind, event}`, the supervisor runs Codex behind an agent-runner interface, and only `view.ts` interprets agent events, per `kind`.
- **One runtime: a Cloudflare Container.** It runs the default image this repository ships, or an image the user supplies that meets the supervisor contract.
- **The UI stays as it is.** It talks to the API contract below.

## Layout

```
alchemy.run.ts        the whole stack: Worker, Session DO + Container, Creds DO, R2, Access, preview route
src/
  worker.ts           Effect HttpRouter: /api/*, /p/* credential swap, preview host routing, UI assets
  session/
    events.ts         event Schemas (the log format)
    fold.ts           pure fold(state, event) and invariants; the only unit-tested module
    object.ts         Session DO: append → fold → maybe send a command; one derived alarm
    view.ts           state → UI API shapes (sessions, conversation, changes)
  creds/
    object.ts         Creds DO: ChatGPT sign-in and refresh, GitHub token, per-session sentinels
    swap.ts           /p/chatgpt/* and /p/github/* handlers
container/
  Dockerfile          default image: Node, git, Codex, the dev toolchain, supervisor
  supervisor/         scotty-sup: WebSocket server; runs codex app-server; git; pause/resume
cli/
  main.ts             Effect CLI: deploy, up, ls, inspect, read, steer, interrupt, vaporize, log
protocol/             API schemas shared by the UI and the Worker (kept from the old repository)
ui/                   the web app (kept)
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

| Event                                                                  | Fields                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `created`                                                              | `repo, baseBranch, title, prompt, image, agent`                |
| `container.start` / `sup.hello`                                        | `gen` / `gen, image, version`                                  |
| `workspace.ready`                                                      | `gen, branch, commit`                                          |
| `prompt.requested` / `prompt.delivered`                                | `req, turn, text, images` / `req`                              |
| `interrupt.requested`                                                  | `req, turn`                                                    |
| `agent.event`                                                          | `gen, n, kind, event` (the agent's raw notification)           |
| `turn.ended`                                                           | `turn, state`                                                  |
| `pause.requested` / `wip.pushed` / `agent.saved` / `container.stopped` | `op` / `commit` / `r2Key, sha` / `gen`                         |
| `resume.requested` / `agent.restored`                                  | `op` / `threadId`                                              |
| `failed`                                                               | `phase, code, retryable`                                       |
| `vaporize.requested` / `gone`                                          | `op`                                                           |
| `timeout`                                                              | `op or gen` (from the one alarm the DO derives from its state) |

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
- Dialing is an outside action: the DO appends `container.start {gen}`, then dials outside the handler. `hello {gen}` is the result; a failed dial or the deadline is a later event.
- When the DO wakes and the fold says a `gen` is running, it re-dials and resumes from the last acknowledged `n`. The supervisor keeps running and keeps unacknowledged messages across a socket drop.
- The DO handles socket messages one at a time through a queue, never a `runPromise` per message.

- **DO → supervisor:** `start {gen, repo, branch, agent, restore?}`, `prompt {req, turn, text}`, `interrupt {req}`, `pause {op}`, `shutdown`.
- **Supervisor → DO:** `hello`, `workspace_ready`, `delivered {req}`, `agent {n, kind, event}`, `turn_end`, `wip_pushed`, `agent_saved`, `error`.

Every message carries `gen` and a sequence number `n`. On reconnect, each side resends everything after the last sequence number the other side acknowledged. If the container dies, the DO sees the socket close, appends an event, and the fold decides what happens next.

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

- **One store.** The Creds DO holds the ChatGPT access token, refresh token, expiry and account ID, plus the GitHub token. It is the only place a real secret exists.
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
- **Sentinels only in the container.** Each session gets a random sentinel per provider. No real secret ever enters the container.
- **Codex:** `config.toml` sets `model_provider` to use `base_url = "https://<host>/p/chatgpt"` and `env_key = "SCOTTY_CHATGPT"`, with the sentinel in that variable. The provider also sets `wire_api = "responses"`, `requires_openai_auth = false`, `supports_websockets = false` and zero retries, and `config.toml` sets `[features] plugins = false`, so `/p/chatgpt/responses` is the only ChatGPT path (spike 1c). Codex runs with an explicit environment allowlist, never the supervisor's whole environment. The `/p/chatgpt` route:
  - checks the sentinel;
  - removes the incoming auth headers;
  - sets the `Authorization: Bearer` and ChatGPT account headers;
  - forwards the request to `https://chatgpt.com/backend-api/codex`.
- **git:** `url."https://<host>/p/github/".insteadOf https://github.com/`, with a credential helper that returns the sentinel. `/p/github` allows only smart-HTTP paths for the session's repository and swaps in the real token.
- **No HTTPS interception.** Alchemy beta.79 exposes only `interceptOutboundHttp`, and routing by base URL needs no TLS tricks.
- **Port from `3042018`:** the header cleanup and host checks in `worker/src/egress/worker.ts:95-123,164-240,428-443`, and the Codex config shape in `worker/src/agent/codex/process.ts:204-270`.

## API the UI needs

The same origin serves `/api/*` and `ui/dist`, with the error format `{error:{message,code?,hint?}}`. The full field-level contract is in the old UI's readers (`ui/src/data/*.ts`) and `protocol/`.

| Endpoint                                                                  | Source                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/sessions`, `GET/DELETE /api/sessions/:id`, `POST /api/sessions` | Session index (one small table in the Creds DO or a Sessions DO) + each Session DO's view |
| `POST /api/sessions/:id/{sleep,resume,checkpoint}`                        | Pause, resume, WIP push                                                                   |
| `GET /api/sessions/:id/conversation`                                      | Turns folded from `agent.event` (the UI polls every 750 ms to 2.5 s)                      |
| `POST /api/sessions/:id/{steer,interrupt}`                                | `prompt.requested` / `interrupt.requested`                                                |
| `GET /api/sessions/:id/changes[/patch]`                                   | A supervisor command that runs `git diff`                                                 |
| `GET /api/settings`, `/api/repos`                                         | A settings row in the Creds DO                                                            |
| `GET /api/credentials` + sign-in                                          | The Creds DO (the UI change for ChatGPT sign-in comes in slice 2)                         |

Later: `/hatch` and preview routing (`<port>-<id>-<nonce>.<previewBase>` → Session DO → `getTcpPort(port)`), `/evidence`, the terminal WebSocket, and `/api/resources`. The Devices, Providers-and-runners and Stats screens get hidden.

## Deploy

- `scotty deploy` builds the UI, supervisor and image, then applies `alchemy.run.ts`.
- **Stage:** explicit, default `personal`. It is never derived from the user, machine or account.
- **State:** Alchemy local state under `~/.scotty/state/`.
- **Cloudflare credentials:** the Alchemy OAuth profile (`--profile default`) or `CLOUDFLARE_API_TOKEN` with the account ID from the environment; never deployed.
- **Updates:** each CLI release embeds its own stack, so updating is a new CLI followed by `scotty deploy`.
- No patches on Alchemy or other dependencies unless a beta.79 failure is shown.

## Tests

- **Unit:** only `fold.ts`, covering its invariants, plus replays of real event logs saved as files. Each fixed bug adds its log.
- **End to end,** against a real deployment:
  1. `deploy` → create → Codex answers → `steer` → `interrupt`.
  2. The real token never appears in the container (scan env, files and process arguments).
  3. `sleep` → `resume`: a marker file on the WIP branch survives, and the Codex thread continues.
  4. `vaporize` leaves no container, R2 objects or branch, and running it twice is safe.
  5. Killing the container mid-turn, or during a pause, ends in a correct state.

## Slices

1. Stack plus the Session DO event log plus the supervisor, running a hard-coded prompt through Codex with an API key → proof: e2e 1.
2. ChatGPT sign-in and refresh in the Creds DO, and the `/p/chatgpt` swap → e2e 2.
3. GitHub token, `/p/github`, WIP branch pause and resume → e2e 3 and 4.
4. The rest of the UI contract: changes, settings, repos, and hiding the unused screens.
5. Hatch previews, terminal, evidence.

## Open questions to settle early

- ~~Can the Worker run the ChatGPT device-code sign-in itself (Codex's `login --device-auth` flow), and what does the refresh endpoint look like?~~ **Answered by spike 1a (deployed, 2026-09-26): yes.** No bot check on Worker egress to `auth.openai.com`. The refresh token rotated on the one refresh. The ID token lives one hour; the access token's lifetime was not measured. The first run failed because Effect's `bodyText` sets `text/plain` over an explicit content type (`HttpClientRequest.ts:693-700`, `internal/httpBody.ts:9-11`); the code exchange must use `bodyUrlParams`. The fallback (CLI sign-in) is not needed. Not covered: a second refresh with the rotated token, a refresh that races another, and whether re-polling after a successful exchange is safe.
- ~~Does `getTcpPort(...).fetch` support a WebSocket upgrade from the DO to the container on Alchemy beta.79?~~ **Answered by spike 1b (deployed, 2026-09-26): yes.** The DO sends `port.fetch` with `Upgrade: websocket`, takes `webSocket` from the 101 response and calls `accept()`. Pings and ticks flowed both ways for 600 s with no reconnect, 43–71 ms echo latency. The `/sup/<id>` fallback is not needed. Not covered: a DO restart or redeploy closes the socket and nothing reconnects it; cold start was not measured; an open outbound socket keeps the DO resident (no hibernation).
- ~~Does Codex send anything to `chatgpt.com` outside `base_url`?~~ **Answered by spike 1c (Codex 0.157.0, run locally, 2026-09-26):**
  - With the provider config under "Credentials", a full turn with tool use (write `hello.txt`, run `cat hello.txt`) sent all 3 model requests as `POST <base_url>/responses` through the swap proxy, with only a sentinel in Codex's environment. No login or refresh call was needed.
  - With plugins enabled (the default), Codex also opened one direct `chatgpt.com:443` connection and two `github.com:443` connections: the curated-plugin startup sync (`git ls-remote`/`fetch` of `openai/plugins`, and most likely `chatgpt.com/backend-api/plugins/export/curated`). With `[features] plugins = false`, a fresh run made no connection outside `base_url`.
  - Limit: the egress observer saw only traffic that honours `HTTPS_PROXY`/`HTTP_PROXY`. The container's own egress rules are the backstop.
  - `account/login/start` with `type: "chatgptAuthTokens"` (seen in t3code) rejects an opaque sentinel with `invalid ID token format`; it needs a real JWT and is marked internal-only. Scotty does not use it.
  - The model must be one the ChatGPT account allows: `gpt-5.5` worked; `gpt-5.1-codex` and `gpt-5.4` returned HTTP 400. The model is a setting, not a constant.
