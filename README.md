# Scotty

Scotty runs Pi in a persistent Cloudflare Sandbox workspace, presents its TUI through Ghostty Web
at an authenticated `/s/<id>` URL, checkpoints the workspace to R2, and can resume, beam down, or
permanently destroy the session. Trusted runner sessions retain a Pican compatibility path.

![Scotty](assets/brand/scotty-hero-16x9.png)

## Components

- `worker/` — Hono API, Sandbox Durable Object, credential-isolating egress proxy, Pi lifecycle,
  Ghostty Web terminal, and trusted-runner Pican compatibility.
- `cli/` — Effect-native Bun CLI and embedded `scotty skills` guide.
- `assets/brand/` — app icons, favicons, hero/social art, and agent glyphs.
- `e2e/` — credential-free fake-service E2E suite plus an explicitly gated deployed canary.
- `spikes/` — executable probes for the upstream Sandbox contracts.
- [`EFFECT_V4_MIGRATION.md`](EFFECT_V4_MIGRATION.md) — governing Alchemy v2 + Effect v4
  architecture, migration order, and proof gates.
- [`docs/effect-v4-alignment-tasks.md`](docs/effect-v4-alignment-tasks.md) — audited migration
  status and remaining agent-ready work.
- [`PORTABLE_EXECUTION_PLAN.md`](PORTABLE_EXECUTION_PLAN.md) — active Cloudflare, runner,
  Slumbers, Box, connection-control, and multi-provider delivery plan.
- `PLAN.md` / `IMPLEMENTATION_DAG.md` — historical v1 behavior, state-machine, and invariant
  references.

## Security model

Repository code is untrusted. Real Pi provider and GitHub credentials stay in Worker secrets or per-session Durable Object storage. The container receives session-bound sentinels only. `ContainerProxy` replaces sentinels on allowlisted egress, sanitizes OAuth refresh responses before they return to the container, and denies all other outbound traffic.

Browser authority is separate from the root credential. `SCOTTY_TOKEN` is accepted only as a CLI
bearer and break-glass recovery credential; it is never accepted from a cookie, browser URL, or
`?t=`. The singleton Auth Durable Object stores exactly one owner client ID plus an ownership
epoch. Other browsers are standard clients. Pairing creates standard access, ownership transfer is
bound to one existing target browser, and root recovery revokes every browser credential before
creating a fresh owner. Raw client, pairing, transfer, and recovery secrets are never persisted.

The browser never receives container credentials. For Cloudflare sessions, the Worker authenticates
the terminal WebSocket and attaches it to the Sandbox native PTY running Pi. Trusted runner Pican
traffic stays behind the authenticated Scotty route. Pi, Codex, and runner Pican receive only
session-bound Codex and GitHub sentinels.

Residual limitation: any allowed package registry is still a potential source/prompt exfiltration channel. Keep `ALLOWED_HOSTS` in `worker/src/egress.ts` minimal for the target repository.

## Local checks

Requirements: Node 22+, npm, Bun, Docker, and Cloudflare authentication only for deployed probes
or production deployment.

```sh
npm install
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
npm run build:cli
```

The default suites do not use Cloudflare, OpenAI, or GitHub credentials.

A Wrangler dry run remains as a local rollback probe. It builds the Sandbox image and therefore
requires a healthy Docker daemon:

```sh
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
```

For interactive local Worker development only, use:

```sh
npx wrangler dev --config worker/wrangler.jsonc
```

Wrangler is not a production infrastructure or deployment path.

## Cloudflare deployment

The standalone CLI owns installation. Run `scotty init --name NAME`; it asks Alchemy to authenticate
the selected Cloudflare profile, deploys all namespaced resources, generates and uploads the root
Worker secret without putting it in Alchemy state, and stores the local pointer in mode-0600
`~/.scotty.json`. The installation name is required and is never inferred from a username, machine,
repository, or Cloudflare account.

On a replacement machine, run `scotty init --name NAME --existing`. Cloudflare profile ownership is
the recovery authority; the CLI reconnects to the same Alchemy stack and rotates the root token.
Copying `~/.scotty.json` is optional, not required. A pre-existing deployment whose physical or
Alchemy logical names differ from the generic convention can be preserved with a private
`--adoption-manifest PATH`; `.scotty-adoption.json` is ignored by Git.

Alchemy declares the Worker, Durable Objects, Container application, KV namespace, R2 bucket,
assets, bindings, migrations, and retained-resource policy. Defaults are derived from the
installation name: `scotty-NAME-worker`, `scotty-NAME-runner`, `scotty-NAME-sandbox`,
`scotty-NAME-sessions`, and `scotty-NAME-backups`. No Cloudflare account ID, workers.dev hostname,
Container UUID, or runner instance name is committed.

Repository maintainers can retain the guarded release wrapper with
`SCOTTY_INSTALLATION_NAME=NAME npm run deploy:production`. It refuses CI and unsafe Git state,
runs the full checks, deploys through Alchemy, and audits Container rollout settlement. Legacy
resource names require `SCOTTY_ADOPTION_MANIFEST=/private/path.json`.

The current Cloudflare gate is forward-only: the full local suite and Colima-backed image build must
pass with pinned Pi and Ghostty Web versions, then the guarded deployment and deployed canary must
prove `beam up → Pi terminal → snapshot → resume → vaporize`. No Pican, Sheppard, or tmux process
is part of the Cloudflare path.

## CLI

```sh
npm run build:cli
./dist/scotty init --name home
./dist/scotty init --name home --existing
./dist/scotty doctor --json
./dist/scotty owner recover
./dist/scotty beam up "fix the failing tests" --repo owner/project --provider cloudflare --json
./dist/scotty skills
```

For a trusted Linux VPS, first build or pull the pinned runtime image and sign in with `gh`.
Then run the repeatable user-service setup:

```sh
./dist/scotty runner setup \
  --name "$RUNNER_NAME" \
  --root /home/runner/.local/state/scotty-runner \
  --image sha256:<64-lowercase-hex> \
  --codex-auth /home/runner/.codex/auth.json \
  --source-binary /absolute/path/to/dist/scotty
```

The command uses the installation in `~/.scotty.json`, registers the required name with the
control plane, receives a one-time runner credential, imports the current GitHub CLI login,
installs runner-only credential files, writes and restarts the hardened systemd user service, and
fails if the service is not active. Pass `--replace` only when moving or reinstalling an existing
runner; that rotates its credential and disconnects the old machine. Use `scotty runner list` to
inspect registrations and `scotty runner remove NAME --yes` after all assigned sessions are gone.
The runner credential is never accepted as a command argument or stored in Worker configuration.

Run `scotty owner recover` once on the intended primary browser after a fresh deployment or when
moving to a replacement laptop. Keep `SCOTTY_TOKEN` in a password manager or another protected
recovery location. `scotty attach <id>` opens the Pi terminal at the clean session URL and requires
an already paired browser. Sleeping sessions must be resumed from Home before the terminal opens.
See
[`docs/owner-transfer-cutover.md`](docs/owner-transfer-cutover.md) before production migration.

## E2E

```sh
node e2e/scripts/run.mjs
```

The destructive deployed canary uses the stage-isolated
`spikes/infra/full-stack-canary.run.ts` stack and requires every stage-scoped gate documented in
`e2e/README.md`. Its production Worker host check fails closed.
