# Scotty — Implementation Plan

Cloud coding agents on Cloudflare (Amp-orbs style). Beam a Codex agent into a cloud sandbox, work with it live in the browser, let it sleep, resume later, ship a PR, or beam the session back down to your laptop.

This plan is written for AI agents to implement. Follow phases in order; each phase has acceptance criteria. Do not add features beyond this document.

See `IMPLEMENTATION_DAG.md` for dependency order, work packages, proof gates, and current Sandbox SDK corrections. Where an SDK contract makes an older detail here impossible, the correction in that DAG governs.

---

## Architecture (final, agreed)

```
scotty CLI ──► Worker (Hono, single route file)
                 │
                 ├─ Sandbox DO per session (@cloudflare/sandbox, RPC API — NOT the
                 │    deprecated HTTP/WS transports)
                 │    • image: codex CLI (pinned), Sheppard, git, gh + baked bare clone of repo
                 │    • Sheppard-managed Codex TUI with independent client views
                 │    • sleepAfter: "60m" (idle) + scheduled hard cap (default 4h)
                 │    • createBackup() → R2 before any sleep; restoreBackup() on resume
                 │
                 ├─ KV: non-secret list projection  id → {status, repo, branch,
                 │                              backupId, codexThreadId, createdAt}
                 │
                 └─ Web UI: one static page, ghostty-web (coder/ghostty-web) attached to
                    the Sandbox native PTY over websocket → https://<host>/s/<id>
```

Primitives used: Workers, Durable Objects, Sandbox SDK, R2, KV. Nothing else (no D1, no Queues, no Workflows).

## Repo layout

```
scotty/
├── worker/
│   ├── src/index.ts          # Hono routes + Sandbox binding + session DO
│   ├── src/session.ts        # session lifecycle (create/snapshot/resume/vaporize, alarm)
│   ├── container/Dockerfile  # base image (see below)
│   ├── public/terminal.html  # ghostty-web page
│   └── wrangler.jsonc
├── cli/
│   └── scotty.ts             # single-file Bun/TS CLI, compiled with `bun build --compile`
├── PLAN.md
└── README.md
```

## Key decisions (do not relitigate)

- **Repo**: default `anomalyco/rift`. Default branch is **`dev`** (there is NO `main`). "Latest" always means latest `dev` unless the repo's default branch differs — resolve default branch dynamically via `gh repo view --json defaultBranchRef` and cache it in the session record.
- **Codex auth**: real tokens NEVER enter the container. Seed from `CODEX_AUTH_JSON` secret into the **session DO storage** (authoritative copy); container gets a sentinel auth.json. The egress proxy (see Credential safety) injects/refreshes real tokens. Refreshed bundles are persisted to DO storage, so snapshots contain only the sentinel — nothing sensitive.
- **Codex version**: pin in Dockerfile to the same minor as the user's local (`codex-cli 0.144.x`) so beam-down rollout files stay compatible.
- **Sheppard is the terminal backbone**: Codex runs in a Sheppard-managed PTY. Every browser attachment runs an independent Sheppard client, so scroll position, viewport size, and disconnect cleanup are per device while Codex survives client disconnects. Set `GIT_TERMINAL_PROMPT=0` and `TERM=xterm-256color`.
- **Terminal**: use the Sandbox SDK **native PTY/terminal API** (shipped Feb 2026) — do NOT run ttyd. Browser side uses `ghostty-web` (npm, xterm.js-compatible API) wired to the terminal websocket. If the SDK's xterm addon assumes xterm.js exactly, wiring raw WS ↔ ghostty-web write/onData is acceptable.
- **Snapshots**: Sandbox `createBackup()` / `restoreBackup()` (SquashFS → R2). Use `/workspace/<id>` (an SDK-supported backup root) and set `CODEX_HOME=/workspace/<id>/.codex`, so one snapshot includes the worktree and rollouts. auth.json in the snapshot is only the sentinel — real tokens live in DO storage (see Credential safety).
- **Instance type**: `standard-2` default; make it a config constant.
- **Auth for web/API v1**: single-user. The deploy-time `SCOTTY_TOKEN` remains the CLI/bootstrap recovery credential. A singleton Auth Durable Object owns one-use pairing grants, independent browser registrations, revocation, and short-lived one-use PTY tickets. Browser credentials are opaque, stored only as SHA-256 digests in the Auth DO, and carried in a Secure HttpOnly SameSite cookie. No Cloudflare Access in v1.
- **Domain**: start on `*.workers.dev` (native terminal WS goes through the Worker, no wildcard subdomain needed). `exposePort` previews are out of scope for v1.

## Credential safety (crabfleet/Cloudflare-example grade — REQUIRED, not optional)

Threat model: codex executes arbitrary repo code (`--yolo`-class trust) inside the container. Assume anything on the container's disk, env, or reachable network can be read and exfiltrated by that code. Therefore:

**1. Egress proxy — real creds never enter the container.**
Adopt the pattern from Cloudflare's `sandbox-sdk/examples/codex` (it ships working code — reuse it, don't reinvent):

- Container env/`auth.json` contain **sentinel values only** (e.g. `scotty-sentinel-<sessionId>`).
- All container egress goes through the proxy. For allowlisted hosts, the proxy strips the sentinel and injects the real credential:
  - `api.openai.com`, `chatgpt.com` → real Codex tokens (from session DO storage)
  - `github.com`, `api.github.com` → real `GH_TOKEN` (from Worker secret)
- Any other Authorization-bearing request passes through unmodified with its useless sentinel.
- Token refresh: extend the CF example's sentinel-injection pattern with Worker-side ChatGPT OAuth refresh and **persist the rotated bundle to session DO storage**. The example itself does not persist rotations, so this must pass the contract/security gate in `IMPLEMENTATION_DAG.md`. This replaces the old "auth.json in snapshot" design — snapshots are now credential-free, and beam-down never ships tokens.

**2. Egress allowlist.**
Default-deny outbound except: `github.com`, `api.github.com`, `codeload.github.com`, `api.openai.com`, `chatgpt.com`, plus package registries needed for builds (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, crates.io as needed — config constant). Exfil via arbitrary hosts is blocked even if repo code goes rogue. Use the Sandbox SDK's egress controls (as in the Claude Code example); if a hole is unavoidable, log it as a known risk in README.

**3. GitHub token scope.**
`GH_TOKEN` is a **fine-grained PAT** limited to the repos scotty manages (contents: rw, pull requests: rw, administration: rw only if repo auto-create is wanted — otherwise drop it and let `pr` fail with a hint). Never a classic all-repo PAT. GitHub App installation tokens remain the v2 upgrade path.

**4. Scotty's own tokens.**

- `SCOTTY_TOKEN` grants full control of sessions (and thus code execution) — treat like a password. CLI stores it 0600 in `~/.scotty.json`. During the compatibility window, an old root-token browser cookie or `?t=` bootstrap link is exchanged once for an administrator browser registration and redirected to a clean URL; the root token is never copied into the replacement cookie.
- `/devices` creates five-minute one-use `/pair#token=…` links. The fragment is removed before the browser makes the consume request. Each target browser receives its own 30-day credential and can be revoked without affecting other browsers.
- PTY websocket upgrades use five-minute one-use tickets bound to both the registered browser and session. Revoking a browser removes outstanding tickets; existing sockets lose their heartbeat and are cleaned up by the existing lease bound.

**5. Hygiene rules for implementers.**

- No secret in: Dockerfile, image layers, KV, R2 snapshots, logs, JSON output, error messages, git remotes (no `https://token@github.com` URLs — use a credential helper fed by env at exec time).
- Secrets live in exactly two places: Worker secrets (seed values) and session DO storage (rotated codex bundle).
- `vaporize` must also delete the DO-stored credential bundle.
- Rollout JSONLs can contain prompts/source — treat beam-down output as sensitive; write locally with 0600.

## Container image (worker/container/Dockerfile)

- Base: `ubuntu:24.04` or the Sandbox SDK base image if required by the SDK.
- Install: git, gh, curl, ca-certificates, codex CLI (pinned), a pinned static Sheppard binary, and locales (UTF-8).
- Bake: `git clone --bare https://github.com/anomalyco/rift /cache/rift.git` (public repo, no creds at build time). Configure fetch refspec `+refs/heads/*:refs/remotes/origin/*`.
- Entrypoint per Sandbox SDK requirements.

## Session lifecycle (worker/src/session.ts)

**create** (`POST /api/sessions {prompt, repo?}`):

1. Generate id (short, url-safe). Write KV record `status=booting`.
2. `getSandbox(env.SANDBOX, id)` — boots container.
3. In container: `git -C /cache/rift.git fetch origin` → resolve `origin/<defaultBranch>` SHA → `git -C /cache/rift.git worktree add -b scotty/<id> /workspace/<id> <sha>`.
4. Set `CODEX_HOME=/workspace/<id>/.codex`. Write **sentinel** auth.json (`scotty-sentinel-<id>`) there; store the real bundle in DO storage.
5. Start a Sheppard daemon on the session-private socket and spawn a managed `codex "<prompt>"` tab in `/workspace/<id>`. Capture the Codex thread id later from `$CODEX_HOME/sessions` (newest rollout file's UUID) and store it in KV.
6. Schedule `enforceHardCap` for `now + HARD_CAP_MS` (default 4h, override via `?cap=`).
7. KV → `status=warm`, respond with the clean URL `{id, url: https://<host>/s/<id>}`.

**idle sleep**: `sleepAfter: "60m"` on the Sandbox. Override `onActivityExpired()` to pause the Sheppard-managed agent, `createBackup({dir: "/workspace/<id>"})`, durably store the handle, publish `status=sleeping`, then stop. `onStop()` is cleanup-only because it runs after shutdown.

**hard cap**: use the Container's `schedule()` API rather than overriding its lifecycle `alarm()`. The scheduled callback quiesces, backs up, and destroys regardless of activity. This guarantees no session outlives its cap even with an open browser tab or a busy process.

**resume** (`POST /api/sessions/:id/resume`):

1. Fresh sandbox with same id → `restoreBackup(backupId)`.
2. Start a fresh Sheppard-managed tab in `/workspace/<id>` → `codex resume <threadId>` (fall back to `codex resume --last`).
3. New alarm (+4h). KV `status=warm`. Same web URL works.

**snapshot** (`POST /api/sessions/:id/snapshot`): `createBackup()` on demand, update backupId. Container stays up.

**pr** (`POST /api/sessions/:id/pr`):

1. Exec in container with a **sentinel** `GH_TOKEN` env (real PAT lives in Worker secrets; egress proxy swaps it on api.github.com/github.com requests only). Never write any token to disk:
   - **If the target repo does not exist on GitHub, create it first**: `gh repo view <owner>/<name> || gh repo create <owner>/<name> --private --source /workspace/<id> --push`. This covers first-push-of-a-new-project; for existing repos it's a no-op check.
   - `git push -u origin scotty/<id>`
   - `gh pr create --base <defaultBranch> --head scotty/<id> --title ... --body-file ...` (skip PR creation when the repo was just created and has no base branch yet — then just report the pushed branch URL).
2. Return PR/branch URL.

**down (beam down)** (`GET /api/sessions/:id/down`):

1. Worker reads from sandbox: newest rollout JSONL under `$CODEX_HOME/sessions/**`, plus branch name + head SHA.
2. Respond with a tar stream (rollout file + metadata JSON).
3. CLI: `git fetch origin scotty/<id>` in local repo, writes rollout into local `~/.codex/sessions/YYYY/MM/DD/` (preserve filename/UUID), prints: `codex resume <uuid> -C <local-worktree-path>`.

**vaporize** (`DELETE /api/sessions/:id`): destroy sandbox, delete backups from R2, delete KV record. No snapshot. Gone.

**ls** (`GET /api/sessions`): list KV records.

## CLI (cli/scotty.ts)

```
scotty up "prompt" [--repo owner/name] [--cap 4h] [--detach]   # create; prints web URL; opens browser unless --detach
scotty ls [--json]
scotty attach <id>            # opens web URL (browser)
scotty snapshot <id>
scotty resume <id>
scotty pr <id> [--title ...]
scotty down <id>              # beam down: branch + rollout → local; prints resume cmd
scotty vaporize <id>          # destroy everything, no snapshot
```

Config: `~/.scotty.json` `{host, token}`. `scotty init` writes it (prompts for host + token). All commands are thin wrappers over the API above. `--json` on everything for scripting.

## Agent ergonomics (CLI is agent-first)

AI agents (Claude Code, Codex, pi) are the primary CLI users. Requirements:

**Machine-readable by default when piped**

- Every command supports `--json`; additionally, auto-detect non-TTY stdout and emit JSON (same as `--json`). Human tables only on a TTY.
- JSON shapes are stable and minimal: `up` → `{id, url, branch, status}`; `ls` → array of session records; `pr` → `{prUrl?, branchUrl, created}`; `down` → `{branch, sha, rolloutPath, resumeCmd}`. Errors → `{error: {code, message, hint}}` on stderr, non-zero exit.
- Exit codes: 0 ok, 1 generic, 2 bad usage, 3 not found, 4 auth, 5 session in wrong state (e.g. resume on a warm session). Never exit 0 on failure.
- No interactive prompts anywhere except `scotty init`. Every command must run unattended. `vaporize` takes `--yes` to skip its confirm; confirm is skipped automatically when non-TTY.

**Self-describing help**

- `scotty --help` and `scotty <cmd> --help`: one usage line, flags, and 1-2 real examples each (crabfleet-style). Terse — no prose walls.
- `scotty help --agents` (and `scotty skills`, see below) is the long-form agent doc.

**`scotty skills` command**

- `scotty skills` prints a complete SKILL.md to stdout: what scotty is, the full command reference with JSON output shapes, the canonical workflows (up → work → pr; up → snapshot → resume; down → local resume), state machine (booting → warm → sleeping → gone), and rules of thumb (always `--json`, poll `ls` for status transitions, vaporize when done to stop spend, hard cap means sessions self-sleep).
- `scotty skills install` writes it where agents look:
  - `--claude`: `~/.claude/skills/scotty/SKILL.md` (with frontmatter `name: scotty`, `description: Manage cloud Codex agent sessions on Cloudflare`)
  - `--codex`: appends a short pointer section to `~/.codex/AGENTS.md`
  - `--here`: writes `./.agents/scotty.md` and appends a pointer line to `./AGENTS.md` (create if missing)
  - no flag: prints the paths it would write and asks nothing (agents pass a flag).
- The SKILL.md content lives in the CLI binary (single source of truth, versioned with the CLI). Regenerated per release — never hand-edit installed copies.

**Statelessness for agents**

- Any command accepts `--host`/`--token` flags and `SCOTTY_HOST`/`SCOTTY_TOKEN` env vars overriding `~/.scotty.json`, so agents can run without a config file.
- `scotty ls --json` is the single polling primitive; include `ageSeconds` and `capRemainingSeconds` per session so agents can reason about lifetime without date math.

## Web page (worker/public/terminal.html)

- Single HTML file served by the Worker at `/s/:id`.
- Loads ghostty-web (bundle it into the Worker assets; no CDN).
- Requests a one-use PTY ticket with the browser cookie, then connects to `wss://<host>/api/sessions/:id/pty?ticket=<short-lived-ticket>`; Worker atomically consumes the ticket and bridges to a Sandbox PTY running an independent Sheppard client.
- Translates desktop wheels and touch swipes into SGR mouse events while Sheppard owns the alternate screen, preserving per-client server-side scrollback. Touch taps are translated too, so mobile rail actions remain usable.
- Reconnect on drop with backoff. Show session id + status (warm/sleeping) in a slim header; if sleeping, show a "Resume" button that calls the resume endpoint then reconnects.

## Phases

**Phase 1 — credential-free vertical infrastructure (up → web terminal)**
Worker + Dockerfile + `scotty up` + `/s/:id` page with working PTY. Use a harmless fake agent until Phase 1.5 passes. Acceptance: `scotty up "hello"` prints a URL; opening it shows the Sheppard-managed session on a fresh worktree of latest `dev`; refreshing the page reattaches without killing the process.

**Phase 1.5 — credential safety + live Codex (before any real-token use)**
Egress proxy with sentinel injection + allowlist, DO-stored codex bundle with proxy-side refresh, cookie-based web auth, then Codex startup. Acceptance: `env`, `cat ~/.codex/auth.json`, and `git config --list` inside the container show only sentinels; a curl from inside the container to a non-allowlisted host fails; codex completes a turn (proxy injection works); after a forced token refresh the DO bundle is updated and a resumed session still authenticates.

**Phase 2 — lifecycle (sleep/snapshot/resume/hard cap)**
`onActivityExpired()` checkpoint, scheduled hard cap, and `scotty resume/snapshot/ls`. Acceptance: force-sleep a session, resume it, codex continues the same thread with the same worktree; a session with an open browser tab still snapshots+sleeps at the hard cap.

**Phase 3 — ship (pr + repo auto-create)**
`scotty pr` incl. `gh repo create` fallback. Acceptance: PR opened against `dev` on rift from a session branch; pushing a session whose repo doesn't exist creates the repo and pushes.

**Phase 4 — beam down + vaporize**
`scotty down`, `scotty vaporize`. Acceptance: after beam down, `codex resume <uuid>` locally replays the cloud conversation and the branch is fetchable; vaporize leaves no KV record, no R2 objects, no sandbox (and no DO credential bundle).

**Phase 5 — agent ergonomics**
`--json` everywhere + non-TTY auto-JSON, exit codes, `scotty skills` + `skills install`, `help --agents`. Acceptance: an agent given only `scotty skills` output can run up → pr → vaporize unattended with no prompts; piping any command produces valid JSON; wrong-state operations exit 5 with a hint.

## Risks / gotchas (implementers: read)

1. Cloudflare does not guarantee uninterrupted container lifetime — hosts can restart. Recovery is only as fresh as the latest successful checkpoint; `onStop()` cannot snapshot an already-stopped container. Don't fight it.
2. Sandbox SDK HTTP/WS transports are deprecated (June 2026) — use the RPC API only. Check the current `@cloudflare/sandbox` README before coding against examples older than mid-2026.
3. auth.json refresh tokens rotate; the **DO-stored bundle** is the single source of truth after first refresh (proxy persists rotations). Never re-seed from the `CODEX_AUTH_JSON` secret once a DO copy exists — a stale seed can invalidate the rotated refresh token.
4. Rollout beam-down is not an official Codex contract. Pin codex versions; treat failures as non-fatal (branch fetch alone is still a useful beam-down).
5. Codex and Sheppard both use alternate-screen terminal modes. Keep browser wheel/touch translation and deployed phone/desktop interaction in the release gate; local emulator scrollback alone is not proof.
6. `standard-2` idle-warm ≈ $0.057/hr; sleeping ≈ free. The hard cap bounds worst-case spend.

## Out of scope for v1 (do not build)

Warm pools, multi-user auth, D1 event replay, SSH gateway, VNC, exposePort previews, GitHub App tokens (PAT via `GH_TOKEN` secret is fine), multiple concurrent repos per session, Cloudflare Access.

## References (read before implementing your phase)

**Cloudflare Sandbox SDK / Containers**

- Sandbox SDK repo + examples: https://github.com/cloudflare/sandbox-sdk
- **Codex example (egress proxy + sentinel + `CODEX_AUTH_JSON` — the credential-safety blueprint)**: https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex
- Codex app-server example (browser ↔ Worker ↔ codex, session naming): https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server
- Claude Code example (egress allowlist pattern): https://github.com/cloudflare/sandbox-sdk/tree/main/examples/claude-code
- Sandbox terminal/PTY concepts: https://developers.cloudflare.com/sandbox/concepts/terminal/
- Terminal API (PTY, xterm addon): https://developers.cloudflare.com/sandbox/api/terminal/
- Native PTY announcement (Feb 2026): https://developers.cloudflare.com/changelog/post/2026-02-09-pty-terminal-support/
- Backup/restore API (`createBackup`/`restoreBackup`, Feb 2026): https://developers.cloudflare.com/changelog/post/2026-02-23-sandbox-backup-restore-api/
- **Transport deprecation — RPC only (June 2026)**: https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/
- Preview URLs (not needed v1, context only): https://developers.cloudflare.com/sandbox/concepts/preview-urls/
- Production deployment (wildcard domain, if previews added later): https://developers.cloudflare.com/sandbox/guides/production-deployment/
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Container rollouts (image updates vs live sessions): https://developers.cloudflare.com/containers/platform-details/rollouts/
- Durable Objects alarms (hard cap): https://developers.cloudflare.com/durable-objects/api/alarms/

**Codex CLI**

- Auth docs: https://developers.openai.com/codex/auth
- CI/CD auth (seeding auth into runners): https://developers.openai.com/codex/auth/ci-cd-auth
- Non-interactive mode (`codex exec`, `CODEX_API_KEY`): https://developers.openai.com/codex/non-interactive-mode
- CLI reference (`exec`, `resume`, sandbox/approval flags): https://developers.openai.com/codex/cli/reference
- Source (pin-compatible reading): https://github.com/openai/codex
  - auth.json shape: `codex-rs/login/src/auth/storage.rs` · token refresh: `codex-rs/login/src/auth/manager.rs` · rollout layout: `codex-rs/rollout/src/list.rs`
- TUI scrollback issue under xterm.js: https://github.com/openai/codex/issues/27644

**Terminal (browser)**

- ghostty-web (WASM ghostty, xterm.js-compatible API): https://github.com/coder/ghostty-web

**Git / GitHub**

- Target repo (public, default branch `dev`, no `main`): https://github.com/anomalyco/rift
- git worktree: https://git-scm.com/docs/git-worktree
- gh pr create: https://cli.github.com/manual/gh_pr_create
- gh repo create: https://cli.github.com/manual/gh_repo_create
- gh env vars (`GH_TOKEN` precedence): https://cli.github.com/manual/gh_help_environment
- Fine-grained PATs: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

**Prior art (UX reference, not dependencies)**

- Amp orbs manual: https://ampcode.com/manual/orbs
- Amp "Putting an Agent in an Orb" (setup/resume hooks, snapshots): https://ampcode.com/notes/putting-an-agent-in-an-orb
- crabfleet (CLI verb shape, Ghostty-WASM attach, same CF architecture): https://github.com/openclaw/crabfleet · https://docs.crabfleet.ai/architecture/

**Worker framework**

- Hono on Cloudflare Workers: https://hono.dev/docs/getting-started/cloudflare-workers
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
