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

Repository code is untrusted. Real Codex and GitHub credentials stay in Worker secrets or per-session Durable Object storage. The container receives session-bound sentinels only. `ContainerProxy` replaces sentinels on allowlisted egress, sanitizes OAuth refresh responses before they return to the container, and denies all other outbound traffic.

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
bun build cli/scotty.ts --compile --outfile dist/scotty
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

Production infrastructure has one owner: the guarded local command `npm run deploy:production`.
Configure the local Alchemy OAuth profile once with `npx alchemy login --configure`. The command
refuses CI, takes an exclusive local lock, requires a clean `main` exactly matching `origin/main`,
runs the full check suite, audits the pinned production account and Worker, revalidates the exact
commit immediately before mutation, deploys through Alchemy, waits for any asynchronous Container
rollout resource to report `completed` with its target version and healthy capacity (or requires
Alchemy to report a terminal no-op). An update without a rollout must remain unchanged for the
bounded control-plane observation window. The command audits the result even if deployment fails.
Do not bypass it with a raw production Wrangler or Alchemy command.

`alchemy.run.ts` accepts only the exact `production` stage. Its guarded Cloudflare stack
requires `CLOUDFLARE_ACCOUNT_ID` and matching `SCOTTY_CLOUDFLARE_ACCOUNT_ID`, telemetry disabled
with `ALCHEMY_TELEMETRY_DISABLED=1`, and account-scoped confirmations:
`SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED=confirmed:<account-id>:worker=scotty-worker:runnerWorker=scotty-runner:durableObjects=ScottySandbox,ScottyAuthRegistry,ScottyRunner:container=<container-name>:kv=scotty-sessions:r2=scotty-backups`
and
`SCOTTY_CLOUDFLARE_DEPLOY_APPROVAL=deploy:<account-id>:scotty-worker`. The production wrapper
derives and supplies these values after auditing the pinned account; operators should not export
them to bypass its checks.

Alchemy declares the Worker, Durable Objects, Container application, KV namespace, R2 bucket,
assets, bindings, migrations, and retained-resource policy. Existing inherited Worker secrets
remain managed outside Alchemy state. Use a fine-grained GitHub PAT restricted to managed
repositories. `SCOTTY_RUNNER_TOKEN` is a separate inherited Worker secret used only by the
configured `slumbers` runner; set it before deploying and provide the same value only to that
runner's protected service environment. The external `scotty-worker` keeps the public Hono routes
and native Sandbox/Auth classes; the private, URL-disabled `scotty-runner` Worker alone hosts
`ScottyRunner`, receives no inherited secrets, and is reached only through the external Worker's
cross-script `RUNNERS` binding.

The current Cloudflare gate is forward-only: the full local suite and Colima-backed image build must
pass with pinned Pi and Ghostty Web versions, then the guarded deployment and deployed canary must
prove `beam up → Pi terminal → snapshot → resume → vaporize`. No Pican, Sheppard, or tmux process
is part of the Cloudflare path.

## CLI

```sh
bun build cli/scotty.ts --compile --outfile dist/scotty
./dist/scotty init --host https://scotty-worker.<account>.workers.dev --token "$SCOTTY_TOKEN"
./dist/scotty owner recover
./dist/scotty beam up "fix the failing tests" --repo owner/project --provider cloudflare --json
./dist/scotty skills
```

For a trusted Linux VPS, first build or pull the pinned runtime image and sign in with `gh`.
Then run the repeatable user-service setup:

```sh
SCOTTY_RUNNER_TOKEN="$SCOTTY_RUNNER_TOKEN" ./dist/scotty runner setup \
  --host https://scotty-worker.<account>.workers.dev \
  --name slumbers \
  --root /home/runner/.local/state/scotty-runner \
  --image sha256:<64-lowercase-hex> \
  --codex-auth /home/runner/.codex/auth.json \
  --source-binary /absolute/path/to/dist/scotty
```

The command imports the current GitHub CLI login, installs runner-only credential files, writes
and restarts the hardened systemd user service, and fails if the service is not active. It never
accepts the runner token as a command argument.

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
