# Scotty

Scotty runs a persistent Codex TUI in a Cloudflare Sandbox, exposes it through an authenticated browser terminal, checkpoints it to R2, and can resume, publish, beam down, or permanently destroy the session.

![Scotty](assets/brand/scotty-hero-16x9.png)

## Components

- `worker/` — Hono API, Sandbox Durable Object, credential-isolating egress proxy, Sheppard-backed lifecycle, and terminal UI.
- `cli/` — Effect-native Bun CLI and embedded `scotty skills` guide.
- `assets/brand/` — app icons, favicons, hero/social art, and agent glyphs.
- `e2e/` — credential-free fake-service E2E suite plus an explicitly gated deployed canary.
- `spikes/` — executable probes for the upstream Sandbox contracts.
- [`EFFECT_V4_MIGRATION.md`](EFFECT_V4_MIGRATION.md) — governing Alchemy v2 + Effect v4
  architecture, migration order, and proof gates.
- [`docs/effect-v4-alignment-tasks.md`](docs/effect-v4-alignment-tasks.md) — audited migration
  status and remaining agent-ready work.
- `PLAN.md` / `IMPLEMENTATION_DAG.md` — historical v1 behavior, state-machine, and invariant
  references.

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

`alchemy.run.ts` accepts only the exact `production` stage. Its guarded greenfield resource path
requires `CLOUDFLARE_ACCOUNT_ID` and matching `SCOTTY_CLOUDFLARE_ACCOUNT_ID`, telemetry disabled
with `ALCHEMY_TELEMETRY_DISABLED=1`, and account-scoped confirmations:
`SCOTTY_CHUNK2_ABSENCE_CONFIRMED=absent:<account-id>:scotty-worker` and
`SCOTTY_CHUNK2_APPROVE_GREENFIELD=greenfield:<account-id>:scotty-worker`. The production wrapper
derives and supplies these values after auditing the pinned account; operators should not export
them to bypass its checks.

Alchemy declares the Worker, Durable Objects, Container application, KV namespace, R2 bucket,
assets, bindings, migrations, and retained-resource policy. Existing inherited Worker secrets
remain managed outside Alchemy state. Use a fine-grained GitHub PAT restricted to managed
repositories.

## CLI

```sh
bun build cli/scotty.ts --compile --outfile dist/scotty
./dist/scotty init --host https://scotty-worker.<account>.workers.dev --token "$SCOTTY_TOKEN"
./dist/scotty up "fix the failing tests" --repo anomalyco/rift --json
./dist/scotty skills
```

Use `scotty attach <id>` to bootstrap a browser. Run `scotty skills` for the complete agent-facing
command and state-machine guide.

## E2E

```sh
node e2e/scripts/run.mjs
```

The destructive deployed canary is opt-in and requires every `SCOTTY_E2E_*` gate documented in `e2e/README.md`. Never point it at production resources.
