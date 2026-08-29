# Scotty E2E checks

The repository does not ship a fake Worker or a default offline E2E suite. The checked-in E2E
surface is the direct static contract test, the real local-live Worker/Sandbox/Pi loop, the
non-mutating deployed route check, and the explicitly gated deployed canary. The local-live helper
tests cover the pure helpers used by that runtime loop.

## Run the direct checks

From the repository root:

```sh
npm run test:e2e:static
npm run test:e2e:local-live:helpers
node e2e/scripts/scan.mjs
```

The direct static contract and local-live helper tests are included in `npm run test:all`. They
do not start a Worker, Sandbox, or Pi process and do not require Cloudflare or GitHub credentials.

## Run the real local Worker, Sandbox, and Pi

The local-live harness exercises the local Worker/Sandbox/Pi lifecycle with disposable credential
sources and Registry sync. Set `SCOTTY_PI_AUTH_FILE` to a mode-0600 Pi auth file and
`SCOTTY_GH_CONFIG_DIR` to a GitHub CLI config for the disposable canary account; it also requires
a healthy Docker daemon and `gh auth login`. It uses temporary Wrangler state and a temporary
control-token file, opens a one-time browser pairing page after the lifecycle check, and keeps
Wrangler alive until `Ctrl-C`.
The harness writes a complete TOML declaration, runs `scotty sync` before Session creation, and
uses Registry-backed Pi/GitHub grants. Provider values are read only from the local source boundary
and are never placed in Worker environment configuration.
It does not read or change any deployed Scotty resources. The local SDK host uses its documented
HTTP control transport; deployed Scotty remains on RPC.

```sh
npm run test:e2e:local-live
```

The first Docker build can take about 10 minutes. Later runs are normally faster. To run only the
automated checks without opening a browser or holding Wrangler open:

```sh
npm run test:e2e:local-live -- --no-open --no-hold
```

Use `--repo OWNER/NAME` to test a repository other than the current GitHub origin, or `--port PORT`
if `8791` is occupied. Add `--require-response` when the local network supports container model
traffic and you want the prompt to return its exact response marker.
The deployed canary checks the externally observable credential boundary described below.

## Run against a disposable deployment

The deployed canary uses `spikes/infra/full-stack-canary.run.ts`, which creates a complete
stage-isolated Worker, Sandbox, Credential Registry, Auth Durable Objects, Container application,
KV namespace, and R2 buckets with destroy-on-cleanup policies. The stage must be
`scotty-e2e-<32 lowercase hex>` and requires exact stage-scoped deploy and cleanup approvals.
Production names and hosts fail closed.

```sh
stage="scotty-e2e-$(openssl rand -hex 16)"
export ALCHEMY_TELEMETRY_DISABLED=1
export SCOTTY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export SCOTTY_E2E_TOKEN="$SCOTTY_TOKEN"
export CREDENTIAL_WRAPPING_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export SCOTTY_E2E_CREDENTIAL_WRAPPING_KEY="$CREDENTIAL_WRAPPING_KEY"
export SCOTTY_E2E_APPROVE_DEPLOY="deploy:$stage"
export SCOTTY_E2E_APPROVE_CLEANUP="destroy:$stage:disposable"
npx alchemy deploy spikes/infra/full-stack-canary.run.ts --stage "$stage" --yes
```

Use the `workerName` and `workerUrl` printed by Alchemy. Publish disposable credentials through the
TOML sync path rather than Worker environment secrets:

```sh
mkdir -p ~/.config/scotty
chmod 700 ~/.config/scotty
cat > ~/.config/scotty/scotty.toml <<'EOF'
version = 1

[sync]
skills = []
packages = []
tools = []
extensions = []

[repos]
allowed = ["owner/disposable-repo"]

[credentials.codex]
kind = "pi-auth"
source = "/absolute/path/to/disposable-pi-auth.json"
scope = "global"

[credentials.github]
kind = "github-cli"
scope = "repository"
repositories = ["owner/disposable-repo"]
EOF
SCOTTY_HOST='https://scotty-e2e-<stage-suffix>-worker.<account>.workers.dev' \
SCOTTY_TOKEN='<root-token-from-the-disposable-stage>' \
GH_CONFIG_DIR='/absolute/path/to/disposable-gh-config' scotty sync
```

The Registry owns encrypted credential versions. Containers receive only fixed managed handles;
provider values are not Worker environment variables. The local-live run exercises the same
Registry sync and grant path against local Durable Objects. The crypto/store unit tests prove the
Registry at-rest encryption boundary. The deployed canary does not expose an internal credential
inspection endpoint or inspect deployed Durable Object, container, KV, or R2 storage; it instead
checks known disposable values only across externally observed CLI, HTTP, terminal, snapshot,
archive, and repository-operation artifacts.

Use a disposable clone of the repository. The canary pushes one random `scotty/<id>` branch and
proves the Worker `/api/sessions/:id/down` route returns its session archive; the test deletes that
branch in its cleanup hook.

```sh
SCOTTY_E2E_DEPLOYED=1 \
SCOTTY_E2E_STAGE="$stage" \
SCOTTY_E2E_HOST='https://scotty-e2e-<stage-suffix>-worker.<account>.workers.dev' \
SCOTTY_E2E_TOKEN='<root-token-from-the-disposable-stage>' \
SCOTTY_E2E_REPO='owner/disposable-repo' \
SCOTTY_E2E_LOCAL_REPO='/absolute/path/to/disposable-repo' \
SCOTTY_E2E_CAP='5m' \
SCOTTY_E2E_PI_AUTH_FILE='/absolute/path/to/disposable-pi-auth.json' \
SCOTTY_E2E_GH_CONFIG_DIR='/absolute/path/to/disposable-gh-config' \
SCOTTY_E2E_CAP_TIMEOUT_MS='600000' \
SCOTTY_E2E_CONFIRM_DESTRUCTIVE="destroy:$stage:disposable" \
npm run test:e2e:deployed
```

The test performs the real lifecycle sequence
`beam → root recovery on the disposable stage → Pi worklog/RPC boundary → snapshot → scheduled
hard-cap sleep → resume → Worker /down → vaporize`, then runs isolated local and peer inspect/steer
proofs.
The root-authenticated local CLI first steers a same-repository target and verifies its exact
response through passive inspect. The disposable Container application permits a lingering
lifecycle host plus two concurrent warm peer instances, so the peer proof then creates a separate
source session and invokes a root-bearer- and
stage-authenticated canary RPC that runs the built `/usr/local/bin/scotty inspect TARGET --json`
and `steer TARGET MESSAGE --json` inside that authoritative source container. The RPC supplies
`SCOTTY_SESSION_ID` only through exec env. It requires inspect success and an accepted steer, then
polls the ordinary root CLI inspect path until the target finishes an exact unique-marker response.
The canary-only authenticated probes verify DO reconstruction, managed credential grants, and
complete runtime/KV/R2/credential/schedule cleanup. Known disposable values are checked by the
test harness across externally observed artifacts; direct Registry DO storage and internal
container/KV/R2 contents are not inspected by the deployed canary. Registry crypto/store unit
tests remain the at-rest proof. Every `__e2e` route requires the exact random canary stage header
and root bearer. After it passes, prove a second plan is a no-op, then destroy the entire stage:

```sh
npx alchemy plan spikes/infra/full-stack-canary.run.ts --stage "$stage"
npx alchemy destroy spikes/infra/full-stack-canary.run.ts --stage "$stage" --yes
```

The cleanup hook retries `vaporize` and deletes the test-created remote branch if any assertion
fails after session creation. The explicit `alchemy destroy` above is still required to remove
the entire disposable stage, even after a failed test; do not rely on the cleanup hook alone.

Run the non-mutating route check with `npm run test:e2e:deployed-routes` after setting
`SCOTTY_E2E_HOST`, `SCOTTY_E2E_TOKEN`, and a non-mutating `SCOTTY_E2E_CLIENT_CREDENTIAL`.

`deployed-routes.test.mjs` is deliberately non-mutating. It requires
`SCOTTY_E2E_CLIENT_CREDENTIAL` for an already registered disposable or canary browser and proves
that the root bearer, root cookie, and `?t=` cannot open browser pages. It never pairs, transfers,
recovers, logs out, or revokes that client.

## Red-capable failure signals

Each retained check is placed at a contract boundary. Static contract failures identify the
violated source invariant; local-live failures include auth, RPC, or asset diagnostics; deployed
route failures identify the rejected boundary; and canary teardown names the orphan class.
