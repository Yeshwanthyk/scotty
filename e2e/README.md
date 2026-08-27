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

The local-live harness tests both Pi credential paths changed by auth hydration:

1. a fresh session writes current Pi auth before its first Pi process starts;
2. a warm session quiesces, reseeds, restarts Pi, and executes another provider request.

It requires a healthy Docker daemon, `gh auth`, and a mode-0600
`~/.pi/agent/auth.json`. It uses temporary Wrangler state and a temporary secret file, opens a
one-time browser pairing page after both checks pass, and keeps Wrangler alive until `Ctrl-C`.
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
if `8791` is occupied. The auth proof distinguishes a credential rejection from an unrelated
upstream failure, such as OpenAI blocking Docker's egress IP. Add `--require-response` when the
local network supports container model traffic and you want both prompts to return their exact
response markers.

## Run against a disposable deployment

The deployed canary uses `spikes/infra/full-stack-canary.run.ts`, which creates a complete
stage-isolated Worker, Sandbox and Auth Durable Objects, Container application, KV namespace, and
R2 bucket with destroy-on-cleanup policies. The stage must be
`scotty-e2e-<32 lowercase hex>` and requires exact stage-scoped deploy and cleanup approvals.
Production names and hosts fail closed.

```sh
stage="scotty-e2e-$(openssl rand -hex 16)"
export ALCHEMY_TELEMETRY_DISABLED=1
export SCOTTY_E2E_APPROVE_DEPLOY="deploy:$stage"
export SCOTTY_E2E_APPROVE_CLEANUP="destroy:$stage:disposable"
npx alchemy deploy spikes/infra/full-stack-canary.run.ts --stage "$stage" --yes
```

Use the `workerName` and `workerUrl` printed by Alchemy. Seed disposable secret values out of band
so Alchemy state retains only inherited secret references:

```sh
worker='scotty-e2e-<stage-suffix>-worker'
token_file="$(mktemp)"
chmod 600 "$token_file"
openssl rand -hex 32 >"$token_file"
npx wrangler secret put SCOTTY_TOKEN --name "$worker" <"$token_file"
gh auth token | tr -d '\n' | npx wrangler secret put GH_TOKEN --name "$worker"
test -s "$HOME/.pi/agent/auth.json"
npx wrangler secret put PI_AUTH_JSON --name "$worker" <"$HOME/.pi/agent/auth.json"
```

`PI_AUTH_JSON` and `GH_TOKEN` stay in the Worker/Durable Object credential boundary. The
Container receives only its session-bound Codex and GitHub sentinels.

Use a disposable clone of the repository. The canary pushes one random `scotty/<id>` branch so
beam-down exercises a real remote fetch; the test deletes that branch in its cleanup hook.

```sh
SCOTTY_E2E_DEPLOYED=1 \
SCOTTY_E2E_STAGE="$stage" \
SCOTTY_E2E_HOST='https://scotty-e2e-<stage-suffix>-worker.<account>.workers.dev' \
SCOTTY_E2E_TOKEN="$(tr -d '\n' <"$token_file")" \
SCOTTY_E2E_REPO='owner/disposable-repo' \
SCOTTY_E2E_LOCAL_REPO='/absolute/path/to/disposable-repo' \
SCOTTY_E2E_CAP='5m' \
SCOTTY_E2E_CAP_TIMEOUT_MS='600000' \
SCOTTY_E2E_CONFIRM_DESTRUCTIVE="destroy:$stage:disposable" \
npm run test:e2e:deployed
```

The test performs the real lifecycle sequence
`up → root recovery on the disposable stage → Pi worklog/RPC boundary → snapshot → scheduled
hard-cap sleep → resume → down → vaporize`, then runs isolated local and peer inspect/steer proofs.
The root-authenticated local CLI first steers a same-repository target and verifies its exact
response through passive inspect. The disposable Container application permits a lingering
lifecycle host plus two concurrent warm peer instances, so the peer proof then creates a separate
source session and invokes a root-bearer- and
stage-authenticated canary RPC that runs the built `/usr/local/bin/scotty inspect TARGET --json`
and `steer TARGET MESSAGE --json` inside that authoritative source container. The RPC supplies
`SCOTTY_SESSION_ID` only through exec env. It requires inspect success and an accepted steer, then
polls the ordinary root CLI inspect path until the target finishes an exact unique-marker response.
Both peer sessions are vaporized on success or failure.

The canary-only authenticated probes also verify DO reconstruction, credential persistence,
sentinel-only container state, non-secret KV, default-deny egress, restored backups,
and complete runtime/KV/R2/credential/schedule cleanup. Every `__e2e` route requires the exact
random canary stage header and root bearer. After it passes, prove a second plan is a no-op, then
destroy the entire stage:

```sh
npx alchemy plan spikes/infra/full-stack-canary.run.ts --stage "$stage"
npx alchemy destroy spikes/infra/full-stack-canary.run.ts --stage "$stage" --yes
rm "$token_file"
```

The cleanup hook retries `vaporize` and deletes the test-created remote branch if any assertion
fails after session creation. Always destroy the disposable Alchemy stage, even after a failed
test.

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
