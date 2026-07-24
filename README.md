# Scotty

Scotty runs a persistent Codex TUI in a Cloudflare Sandbox, exposes it through an authenticated browser terminal, checkpoints it to R2, and can resume, publish, beam down, or permanently destroy the session.

## Components

- `worker/` — Hono API, Sandbox Durable Object, credential-isolating egress proxy, Sheppard-backed lifecycle, and terminal UI.
- `cli/scotty.ts` — single-file Bun CLI; compile with `bun build --compile`.
- `e2e/` — credential-free fake-service E2E suite plus an explicitly gated deployed canary.
- `spikes/` — executable probes for the upstream Sandbox contracts.
- [`docs/cloudflare-primitives.md`](docs/cloudflare-primitives.md) — illustrated guide to the Cloudflare pieces Scotty uses and why.
- `PLAN.md` / `IMPLEMENTATION_DAG.md` — scope, architecture, dependency order, and proof gates.

## Security model

Repository code is untrusted. Real Codex and GitHub credentials stay in Worker secrets or per-session Durable Object storage. The container receives session-bound sentinels only. `ContainerProxy` replaces sentinels on allowlisted egress, sanitizes OAuth refresh responses before they return to the container, and denies all other outbound traffic.

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

A Wrangler dry run also builds the Sandbox image and therefore requires a healthy Docker daemon:

```sh
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
```

## Cloudflare setup

Create dedicated KV and R2 resources, then fill their IDs/names in `worker/wrangler.jsonc`. Backups require the R2 binding plus the Sandbox SDK's presigned-upload credentials.

```sh
cd worker
npx wrangler kv namespace create SESSIONS
npx wrangler r2 bucket create scotty-backups

npx wrangler secret put SCOTTY_TOKEN
npx wrangler secret put CODEX_AUTH_JSON
npx wrangler secret put GH_TOKEN
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

Use a fine-grained GitHub PAT restricted to managed repositories. Add an R2 lifecycle rule for the `backups/` prefix; SDK backup TTL is metadata and does not itself remove expired objects.

Production infrastructure has one owner: the guarded local command `npm run deploy:production`.
Configure the local Alchemy OAuth profile once with `npx alchemy login --configure`. The command
refuses CI, takes an exclusive local lock, requires a clean `main` exactly matching `origin/main`,
runs the full check suite, audits the pinned production account and Worker, revalidates the exact
commit immediately before mutation, deploys through Alchemy, waits for any asynchronous Container
rollout resource to report `completed` with its target version and healthy capacity (or requires
Alchemy to report a terminal no-op). An update without a rollout must remain unchanged for the
bounded control-plane observation window. The command audits the result even if deployment fails.
Do not bypass it with a raw production Wrangler or Alchemy command.

## CLI

```sh
bun build cli/scotty.ts --compile --outfile dist/scotty
./dist/scotty init --host https://scotty-worker.<account>.workers.dev --token "$SCOTTY_TOKEN"
./dist/scotty up "fix the failing tests" --repo anomalyco/rift
./dist/scotty ls --json
./dist/scotty snapshot <id>
./dist/scotty resume <id>
./dist/scotty pr <id>
./dist/scotty down <id>
./dist/scotty vaporize <id> --yes
```

The CLI token is also the browser bootstrap/recovery credential. Open a browser once through
`scotty attach`, then use **Devices** on `/sessions` to create a five-minute one-use QR/link for
Helium, a phone, or another browser profile. Every paired browser gets an independent revocable
cookie; ordinary session links stay clean.

Run `scotty skills` for the embedded agent-facing command and state-machine reference.

## E2E

```sh
node e2e/scripts/run.mjs
```

The destructive deployed canary is opt-in and requires every `SCOTTY_E2E_*` gate documented in `e2e/README.md`. Never point it at production resources.
