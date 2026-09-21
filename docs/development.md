# Development

[README](../README.md) · [Architecture](architecture.md) · [Setup and deployment](setup.md)

Read [AGENTS.md](../AGENTS.md) before changing Scotty. It defines public contracts, state and
credential ownership, Effect and Alchemy rules, and required checks. For non-trivial Effect or
Alchemy changes, follow its source-first instructions against the pinned reference submodules.

## Checkout setup

Use the Node version in [`.nvmrc`](../.nvmrc), npm, Bun, and Git:

```sh
git submodule update --init vendor/effect vendor/alchemy
npm ci --no-audit --no-fund
npm run check
```

Fresh Linux agent environments can use [`.agents/setup`](../.agents/setup). Resumed environments
can use [`.agents/resume`](../.agents/resume) to check the cached installation:

```sh
./.agents/setup
./.agents/resume
```

Docker is needed for the real local Sandbox loop, image builds, dry-run probe, and deployment.
Cloudflare credentials are needed only for deployed probes or deployment. Default test suites do
not use Cloudflare, provider, or GitHub credentials.

## Repository map

| Path            | Contents                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| `worker/`       | API, Durable Objects, agent runtimes, egress, lifecycle, and runner control     |
| `ui/`           | Browser interface                                                               |
| `cli/`          | Effect-native Bun CLI and embedded guides                                       |
| `protocol/`     | Shared schemas and contracts                                                    |
| `infra/`        | Alchemy infrastructure                                                          |
| `assets/brand/` | Icons, hero art, and agent glyphs                                               |
| `e2e/`          | Static contracts, local-live helpers, deployed route checks, and guarded canary |
| `vendor/`       | Pinned read-only reference source                                               |

## Feedback loop

Run the smallest relevant test before editing. Use watch mode while changing the code, then format,
rerun the focused test and nearest suite, and run the complete gate before handoff.

```sh
# Worker: one pass, then watch
npx vitest run worker/test/sandbox/sandbox-runtime.test.ts
npx vitest worker/test/sandbox/sandbox-runtime.test.ts

# Other focused suites
npx vitest run cli/effect-test/command-tree.test.ts
bun test cli/test/cli.test.ts
npm run test:e2e:local-live:helpers
node --test scripts/reconcile-containers.test.mjs

# Format the files you changed, then run the full gate
npx oxfmt --disable-nested-config --write README.md worker/src/sandbox/runtime.ts
npm run check
```

Replace example paths with the affected files. `npm run check` covers pinned packages, formatting,
lint, typechecks, tests, and the secret scan. Do not format or lint vendor sources, generated assets,
tldraw archives, or `work/`.

To build the contributor CLI:

```sh
npm run build:cli
./dist/scotty --help
```

Normal operators should use the signed release, not a source checkout.

## Local lab

The lab runs the real CLI against the production Worker in Wrangler local mode with Docker-backed
Sandbox support. See the [original lab guide](https://github.com/Yeshwanthyk/scotty/blob/b5ff919/docs/scotty-lab.md)
for the before/after verification procedure.

```sh
npm run lab -- start
npm run lab -- exec RUN_ID -- doctor --json
npm run lab -- stop RUN_ID
```

`start` needs Docker and Bun. It creates isolated temporary Wrangler state and CLI `HOME`, chooses
a run-specific Worker name, and reports a run ID and host after `/health` passes. `exec` forwards
arguments without a shell and preserves stdio and exit status. `doctor` alone does not create a
session. `stop` removes only containers belonging to that run's Worker.

The private `.scotty-lab/run.json` manifest contains no credentials. Mode-0600 temporary files hold
the generated root token, Wrangler inputs, and redacted startup log until cleanup. Follow the lab's
before/after representative-flow gate and stop on unexplained divergence.

## Local-live and E2E

Static contracts and local-live helper tests are included in `npm run test:all`:

```sh
npm run test:e2e:static
npm run test:e2e:local-live:helpers
```

The real local Worker/Sandbox/Pi loop is explicit:

```sh
npm run test:e2e:local-live -- --no-open --no-hold
```

See [the E2E guide](../e2e/README.md) for Docker, GitHub login, and credential prerequisites. For
Colima, prefix the command with `DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"` if needed.
The loop uses temporary local state and containers, not deployed Scotty resources. It checks fresh
managed-credential wiring; provider credential proof still requires the deployed Registry. Use
`--require-response` only when the container network permits model traffic.

There is no default fake/offline E2E suite. Deployed checks are separate:

```sh
npm run test:e2e:deployed-routes
npm run test:e2e:deployed
```

The route check is non-mutating. The full canary is destructive and uses the stage-isolated
`e2e/canary/full-stack-canary.run.ts` stack. Read every gate in the E2E guide before running it; its
production-host check fails closed. Local success is not deployed proof.

## Wrangler boundaries

For a local rollback probe or interactive development:

```sh
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
npx wrangler dev --config worker/wrangler.jsonc
```

The dry run builds the Sandbox image and needs Docker. Wrangler is not the production deployment
path. Operators use the [signed CLI deployment workflow](setup.md#update-the-cloud-installation).

Source maintainers use `npm run deploy:production -- --container` only as a checkout safety gate
while preparing a signed executable. Without `--container`, that gate requires a no-op Container
plan and does not open Docker. Do not add `--container` just to bypass a failed no-op check: first
confirm an image or Container configuration change is intended. Never bypass a failed guard with a
direct Wrangler or Alchemy upload.
