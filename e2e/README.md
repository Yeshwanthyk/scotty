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

The default suite covers `up`, `ls`, `snapshot`, hard-cap sleep, `resume`, `pr`, `down`, and idempotent `vaporize`; tracked-repo creation, authentication, ordering, and retention after vaporize; JSON keys; stdout/stderr separation; exit codes 0 through 5; wrong-state errors; backup restoration; hard-cap backup failure; PTY auth/resize/reconnect; cookie/query-token behavior; sentinel and credential scans; denied/redirected egress; tar traversal rejection; rollout mode 0600; and runtime/KV/R2/credential orphan cleanup.

## Run against a disposable deployment

The deployed canary is destructive: it creates a session, waits for its configured hard cap, opens a PR, beams the session down, and vaporizes it. It skips with a list of missing gates unless every variable below is explicit.

```sh
SCOTTY_E2E_DEPLOYED=1 \
SCOTTY_E2E_HOST='https://scotty-e2e.example.workers.dev' \
SCOTTY_E2E_TOKEN='disposable-worker-token' \
SCOTTY_E2E_REPO='owner/disposable-repo' \
SCOTTY_E2E_LOCAL_REPO='/absolute/path/to/disposable-repo' \
SCOTTY_E2E_CAP='2m' \
SCOTTY_E2E_CAP_TIMEOUT_MS='420000' \
SCOTTY_E2E_CONFIRM_DESTRUCTIVE=YES \
SCOTTY_E2E_ORPHAN_PROBE_URL='https://scotty-e2e.example.workers.dev/__e2e/orphans' \
node e2e/scripts/run.mjs --deployed
```

`SCOTTY_E2E_ORPHAN_PROBE_URL/<session-id>` must be available only on the disposable test Worker, require the same bearer token, and return this after teardown:

```json
{ "runtime": false, "kv": false, "credentials": false, "backups": [] }
```

Never point the deployed suite at a production Worker, account bucket, token, or repository. The cleanup hook retries `vaporize` if any assertion fails after session creation.

## Red-capable failure signals

Each assertion is placed at a contract boundary. A CLI failure prints the exact command stderr; lifecycle tests inspect the first divergent fake resource; security tests identify the leaking surface; PTY tests identify auth, frame ordering, resize, or generation continuity; and teardown names the orphan class. Keep the fake deterministic—product behavior belongs in `cli/**` and `worker/**`, not in this harness.
