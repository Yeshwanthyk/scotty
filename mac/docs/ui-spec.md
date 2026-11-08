# Scotty for macOS: UI spec

The Mac app is a second client of the same Worker API as the web UI in `ui/`. It changes nothing
on the server. Every word on screen is the web's word, quoted from the file named. When the web
changes a word, change it here and in the app.

The app connects to whichever Scotty the user types. Nothing in it names a stage, account or
domain.

## Stack decision: Rune, and none of ratstack's code

- **Rune** (`anomalyco/rune`, rev `59f0326b`) draws the app. It gives native windows, a GPU
  renderer, text input, virtual rows, a tab strip and Markdown (`rune-kit`). It also has headless
  `--scene`/`--snap` tooling, which every screenshot below uses.
- **ratstack** (`ratstack.sh`, `joelhooks/rat-stack`) is a TypeScript service stack: Effect,
  Alchemy, XState, Effect Schema, Foldkit for the web, Better Auth, and MCP/OpenAPI, deployed on
  Workers. It has no native UI layer, so it can't draw a Mac app. Scotty's server already runs on
  the parts that overlap (Effect and Alchemy).
  - **Taken now:** its security checklist. The Access token lives in the macOS Keychain (service
    `scotty-mac`, one item per origin). It is never put in a file, an environment variable, a
    log or argv.
  - **Taken later:** "one schema, every interface". Generate the Rust wire types (`api.rs`) from
    the Effect schemas in `ui/src/data/core.ts` and `ui/src/protocol/session/conversation.ts`
    through JSON Schema, so this client can't drift from the server. Until then, `api.rs`
    mirrors those schemas by hand and names them field for field.
  - **Not taken:** Better Auth, roles or pairing. Scotty has one user, and Cloudflare Access is
    the login.

## Auth and transport

- **Sign in.** Ported from ky's `signin.rs`.
  1. HEAD the origin with `cf-access-metadata-request: true` and verify the metadata JWT against
     the team's certs.
  2. Open `<origin>/cdn-cgi/access/cli?…` in the browser.
  3. Long-poll `login.cloudflareaccess.org/transfer/<pubkey>` and open the sealed `app_token`.
  4. Store it in the Keychain.
  5. Every request and socket sends `cf-access-token: <token>` and the cookie
     `CF_Authorization=<token>`.
- **No `Origin` header.** The Worker refuses a foreign Origin on writes and live sockets
  (`src/worker.ts`). The native client sends none.
- **HTTP.** ureq runs on a thread per request, posts its result over mpsc and wakes the loop.
- **Errors.** An error body is `{error:{message}}`. Without one, the message is
  `Request failed (<status>)`. A 401, 403 or redirect clears the token, so the next request signs
  in again.
- **Live sockets.** tungstenite runs one thread per socket.
  - It reconnects with backoff from 1s to 30s, and a drop under 3s isn't shown.
  - A close with code 1000 is final.

## Endpoints the app calls

| Surface            | Call                                                                         | Shape                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Session list       | `GET /api/sessions`                                                          | `{version:1, sessions:[Session]}`                                                                                            |
| Session list, live | `WS /api/sessions/live`                                                      | `{kind:"session", session}` or `{kind:"removed", id}`. On open, read the list again.                                         |
| Session            | `WS /api/sessions/{id}/live`                                                 | `{kind:"snapshot", seq, session, conversation}`; an older `seq` is ignored                                                   |
| Session gone?      | `GET /api/sessions/{id}`                                                     | a 404 means `Session not found`                                                                                              |
| Steer              | `POST /api/sessions/{id}/steer` `{text, turn, req}`                          | `{status}`. `turn` = `conversation.currentTurn`, `req` = a UUID reused on retry                                              |
| Stop turn          | `POST /api/sessions/{id}/interrupt` `{turn, req}`                            | `{status}`                                                                                                                   |
| Stop / Resume      | `POST /api/sessions/{id}/stop` or `/resume` `{}`                             |                                                                                                                              |
| Delete             | `DELETE /api/sessions/{id}`                                                  |                                                                                                                              |
| New session        | `POST /api/sessions`, header `idempotency-key`                               | body `{title, repo, prompt, agent, provider:"cloudflare"}`. `title` is the prompt's first line, cut to 57 + `…` when over 60 |
| Settings           | `GET /api/settings`                                                          | `{instructions, sources, claudeStyle, email, running, maxRunning}`                                                           |
| Accounts           | `GET /api/credentials/{chatgpt,claude,github}`                               | `{status, expiresAt}` / `{status, login}`                                                                                    |
| Instructions       | `PUT /api/settings/instructions {text}`                                      |                                                                                                                              |
| Repositories       | `GET /api/repos`; `PUT /api/repos/{repo} {size}`; `DELETE /api/repos/{repo}` | `{repos:[{repo,size}]}`                                                                                                      |

## Status (from `ui/src/data/status.ts`)

Checked in this order; the first match wins:

1. transitioning → `Starting`
2. lifecycle failed → `Failed`
3. working → `Working`
4. stopped with reason idle → `Asleep`; any other stopped → `Stopped`
5. turns greater than the turns seen → `New reply`
6. otherwise → `Ready`

- "Seen" is a count per session, kept in the app's support folder.
- Stop labels, from `stopLabel`:

  | reason        | label                    |
  | ------------- | ------------------------ |
  | user          | `Stopped by you`         |
  | ended         | `Ended by an automation` |
  | stalled       | `Stopped — no output`    |
  | crashed       | `Crashed (exit N)`       |
  | exited        | `Container exited`       |
  | agent         | `Agent exited`           |
  | deploy        | `Container replaced`     |
  | cap           | `Too many running`       |
  | gone          | `Container lost`         |
  | anything else | `Stopped`                |

- `stopSentence` and `failureSentence` are copied word for word into `api.rs`.
- `ago`:
  - under 45s → `now`
  - under an hour → `Nm`
  - under a day → `Nh`
  - under a week → `Nd`
  - otherwise a short date
- Groups: `Today`, `This week`, `Older`.

## Surfaces

### Connect (first launch, or "Switch Scotty")

The web has no equivalent: there, the browser already knows the host. Words are the app's own,
in the web's voice.

- **Title:** `Open your Scotty`
- **Body:** `Type the address of your Scotty. You'll sign in through its Cloudflare Access in your browser.`
- **Field:** placeholder `scotty.example.com`, button `Open`
- **Bad address:** `That isn't an address. It looks like scotty.example.com.`
- **Saved addresses** are listed above the field, each with `Open`.

### Window frame

- **Sidebar.** Left, 264 wide (`--sidebar-width`), drawn on `--sidebar`.
  - The head sits beside the traffic lights and has `Hide sidebar`.
  - The brand row shows the ring mark and `Scotty`.
  - Search row: `Search` with a ⌘K keycap.
  - `+` with the label `New session`.
  - Filter chips: `All`, `Mine`, `Automations`, `Running`.
  - Groups `Today`, `This week`, `Older`.
  - A `Stopped` fold holds dormant sessions. It is open when nothing is live.
  - States:
    - `Can't reach Scotty. Retrying…`
    - `No sessions yet. Start one and it shows up here.`
    - `Nothing matches.`
  - **Row.**
    - Line 1: the title.
    - Line 2 for a loud status (Starting, Failed, New reply): the status label + ` · repo`.
    - Line 2 otherwise: `repo` (or `No repository`) · ago. A `Claude` tag is added for Claude
      sessions.
    - Mark: a spinner for Working and Starting, a dot for Failed and New reply.
  - **Foot.** The host name with a link dot (Connected, Connecting…, Offline), then Settings (⌘,).
- **Tabs.** Open sessions are tabs across the top, the window's drag band.
  - They drag to reorder.
  - ⌘W closes a tab; the session stays in the sidebar.
  - A tab shows a busy mark while its session works.
- **Nothing open:** `No session open` / `Pick one in the sidebar, or start one with ⌘N.`

### Session (`ui/src/routes/s.$sessionId.tsx`, `Thread.tsx`, `ToolRow.tsx`)

- **Header**, 48 tall.
  - Title.
  - Session line: `owner/name`, then the branch unless it starts with `scotty/`, then the size,
    then `via <automation>` or `via webhook <connection>`.
  - A status pill, or `Sleeps in Nm` while idle with a `sleepsAt`.
  - A diff stat button (`+N −N`) that opens the Changes panel.
  - Actions: `Copy session ID` (then `Copied`), `Resume`, `Stop session`, `Delete session`.
    Delete asks `Delete this session and its history?` first.
- **Link notes:**
  - `Connecting…`
  - `Reconnecting…`
  - `Disconnected; reload to reconnect`
  - `Session not found`
- **Thread**, 704 wide (`--thread-width`).
  - Older turns fold behind `N earlier turns`.
  - Each turn:
    - The user bubble, on `--raised` with radius 20. `Show more` / `Show less` past 8 lines.
    - The work log:
      - While live, its rows show, then a `Working` spinner with the elapsed time.
      - When done, the log folds under `Worked for 2m 3s · 5 steps` (`Ran` when not completed).
    - The answer, as Markdown.
    - End marks: `Interrupted` or `Turn failed`, and `Copy answer`.
  - Tool rows use the tense table (`Read`/`Reading`, `Ran`/`Running`, …).
    - Runs of read-only tools become `Explored 3 files, 1 search`.
    - Exit codes read `exit N`, and declined tools read `Declined`.
    - Edits carry a `+N −N` stat.
  - Plan: `Plan N/M` with its steps. Notices: info or error.
- **Lifecycle notices.** The stop sentence or failure sentence shows at the thread's end.
- **Composer.** A floating field, 54 tall with radius 23, text 14/22. Return sends; Stop replaces
  Send while the agent works with an empty draft. Placeholders:
  - failed → `Resume to try again`
  - can't take messages → `This session can't take messages`
  - dormant → `Send to resume…`
  - working → `Steer the agent…`
  - otherwise → `Add a follow up…`
- **Send notes:** `Stopping this turn…`, `Queued`. Errors: `Could not <action> the session`,
  `Request failed`.
- **Changes panel** (`Changes.tsx`, `DiffLines.tsx`). On the right, 44% of the width and at least 360.
  - Summary: `N files changed` and `+N −N`.
  - Each file has a head with a chevron, a file icon (plus, minus or plain), the path (the
    directory quiet, the name bold) and a stat.
  - Lines show old and new numbers and a +/− mark, on `--diff-add-bg` / `--diff-del-bg`.
  - Unchanged runs over 8 lines fold to 3 either side: `N unchanged lines`. Past 400 lines,
    `N more lines`.
  - Empty: `No changes yet`.

### ⌘K (`CommandMenu.tsx`)

- Placeholder `Search sessions, repos and actions`.
- Sections, in order:
  - **Running.**
  - **Actions:**
    - `New session`
    - `Hide sidebar` / `Show sidebar` (`⌘\`)
    - `Stats` (`Hours, turns and failures per repository`)
    - `Settings: <section>` with each section's detail
  - **Repositories:** `<repo>`, `Show its sessions`. Shown only while typing; it sets the
    repository filter.
  - **Sessions:** title, with `repo · ago`.
- Empty: `Nothing matches “<query>”`.

### Settings window (`Settings.tsx`)

A separate window (⌘,), with the left nav listing the sections and the page on the right. A
second ⌘, or clicking the nav moves between pages. Sections, in order:

| id           | Label          | Detail                                    | First slice                                    |
| ------------ | -------------- | ----------------------------------------- | ---------------------------------------------- |
| accounts     | `Accounts`     | `ChatGPT, Claude and GitHub`              | read: status rows with the web's sentences     |
| instructions | `Instructions` | `Added to every session`                  | edit and `Save` (PUT)                          |
| skills       | `Skills`       | `Installed in new sessions`               | read: sources and their skills                 |
| repositories | `Repositories` | `The size new sessions get`               | read, plus `Clear`                             |
| connections  | `Connections`  | `Webhooks, API tokens and MCP servers`    | `Open in the browser`                          |
| blueprints   | `Blueprints`   | `Connections and automations for one use` | `Open in the browser`                          |
| running      | `Running`      | `Sessions running and the cap`            | read                                           |
| signed-in    | `Signed in`    | `Cloudflare Access`                       | email, `Sign out` (forgets the Keychain token) |

- **Accounts.**
  - ChatGPT:
    - `Signed in. Codex runs on this account.`
    - `Sign-in expires soon; sign in again.`
    - `Not signed in. Codex sessions can't start until you are.`
  - Claude:
    - `Token set. Claude sessions run on your subscription.`
    - `Token expires soon; add a new one.`
    - `No token. Run claude setup-token and paste what it prints.`
  - GitHub:
    - `Token for <login>. Sessions push branches with it.`
    - `No token. Sessions can clone only the built-in fixture.`
- **Running.** `<n> of <max> running` with `Full` or `Room left`, and the two web detail
  sentences.
- **Signed in.** `<email>` or `Unknown account`, then `Signed in through Cloudflare Access.`
- Errors read `Could not load settings`.

## Theme (`ui/src/global.css`)

Light and dark tokens are copied into `theme.rs`, following macOS appearance unless the user
toggles it with ⇧⌘L.

- Accent `#c2552f` / `#d9693f`.
- Status colours: working `#2f8fdc`, attention `#c98a14`, done `#2f9b62`, danger `#cf3b2e`.
- Radius 10. The font is the system font, with SF Mono for code.

## Shortcuts

| Keys      | Action              |
| --------- | ------------------- |
| ⌘K        | Command menu        |
| ⌘N, ⌘T    | New session         |
| ⌘W        | Close tab           |
| ⌘1–9      | Go to a tab         |
| ⇧⌘[ / ⇧⌘] | Previous / next tab |
| ⌘\        | Sidebar             |
| ⌘,        | Settings            |
| ⇧⌘L       | Light/dark          |
| ⌥⌘D       | Changes panel       |
| Return    | Send                |
| ⇧Return   | New line            |

## Proof

```sh
cd mac && cargo build --release
APP_OFFLINE=1 target/release/scotty-mac --scene <name> --size 1180x820 --snap out.png
APP_OFFLINE=1 target/release/scotty-mac --window settings --scene <page> --size 760x560 --snap out.png
```

Scenes are listed in `src/view.rs` `SCENES` and `src/settings.rs` `SCENES`.
