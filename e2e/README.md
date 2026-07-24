# Scotty E2E harness

The default suite uses a real Scotty CLI process and an in-memory fake Worker/session service. It needs Node 22+, Bun, Git, and no Cloudflare or GitHub credentials. The fake models authoritative sessions, KV projections, backups, runtimes, a credential vault, hard-cap behavior, egress policy, cookie handoff, and a small authenticated WebSocket PTY protocol.

## Run locally

From the repository root:

```sh
node e2e/scripts/run.mjs
node e2e/scripts/scan.mjs
```

The CLI defaults to `cli/scotty.ts`. To test a compiled artifact:

```sh
SCOTTY_E2E_CLI="$PWD/dist/scotty" node e2e/scripts/run.mjs
```

The default suite covers `up`, `ls`, `snapshot`, hard-cap sleep, `resume`, `down`, and idempotent `vaporize`; tracked-repo creation, authentication, ordering, and retention after vaporize; JSON keys; stdout/stderr separation; exit codes 0 through 5; wrong-state errors; backup restoration; hard-cap backup failure; PTY auth/resize/reconnect; cookie/query-token behavior; sentinel and credential scans; denied/redirected egress; tar traversal rejection; rollout mode 0600; and runtime/KV/R2/credential orphan cleanup.

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

Use the `workerUrl` printed by Alchemy and a disposable clone of the repository. The canary pushes
one random `scotty/<id>` branch so beam-down exercises a real remote fetch; the test deletes that
branch in its cleanup hook.

```sh
SCOTTY_E2E_DEPLOYED=1 \
SCOTTY_E2E_STAGE="$stage" \
SCOTTY_E2E_HOST='https://scotty-e2e-<stage-suffix>-worker.<account>.workers.dev' \
SCOTTY_E2E_TOKEN='the inherited canary Worker token' \
SCOTTY_E2E_REPO='owner/disposable-repo' \
SCOTTY_E2E_LOCAL_REPO='/absolute/path/to/disposable-repo' \
SCOTTY_E2E_CAP='5m' \
SCOTTY_E2E_CAP_TIMEOUT_MS='600000' \
SCOTTY_E2E_CONFIRM_DESTRUCTIVE="destroy:$stage:disposable" \
node e2e/scripts/run.mjs --deployed
```

The test performs the real sequence
`up → attach → PTY reconnect → snapshot → scheduled hard-cap sleep → resume → down → vaporize`.
Its canary-only authenticated probe verifies DO reconstruction, credential persistence,
sentinel-only container state, non-secret KV, default-deny egress, restored backups, closed terminal
leases, and complete runtime/KV/R2/credential/schedule cleanup. After it passes, prove a second plan
is a no-op, then destroy the entire stage:

```sh
npx alchemy plan spikes/infra/full-stack-canary.run.ts --stage "$stage"
npx alchemy destroy spikes/infra/full-stack-canary.run.ts --stage "$stage" --yes
```

The cleanup hook retries `vaporize` and deletes the test-created remote branch if any assertion
fails after session creation. Always destroy the disposable Alchemy stage, even after a failed
test.

## Red-capable failure signals

Each assertion is placed at a contract boundary. A CLI failure prints the exact command stderr; lifecycle tests inspect the first divergent fake resource; security tests identify the leaking surface; PTY tests identify auth, frame ordering, resize, or generation continuity; and teardown names the orphan class. Keep the fake deterministic—product behavior belongs in `cli/**` and `worker/**`, not in this harness.
