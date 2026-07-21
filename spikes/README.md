# Cloudflare contract probes

These probes freeze the upstream contracts Scotty relies on without putting real
Codex or GitHub credentials in a container.

## Local checks

```sh
npm install --no-package-lock --ignore-scripts
npm run typecheck:contracts
npm run test:contracts
npm run probe:dry-run
```

The Wrangler dry run bundles the Worker and validates its bindings. It also asks
Docker to parse/build the paired Sandbox image, so the local Docker daemon must
be healthy.

## Disposable deployed probe

Use a dedicated development account and R2 bucket. Never deploy this Worker
without its random bearer token.

```sh
npx wrangler secret put PROBE_TOKEN --config spikes/wrangler.jsonc
npx wrangler deploy --config spikes/wrangler.jsonc
```

Set `PROBE_URL` and `PROBE_TOKEN`, then exercise the RPC/storage, backup/restore,
and scheduled callback surfaces:

```sh
curl -fsS -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE_URL/rpc/probe-1"
curl -fsS -X POST -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE_URL/backup/probe-1"
curl -fsS -X POST -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE_URL/schedule/probe-1"
```

Connect a WebSocket client to `/terminal/probe-1` with the same Authorization
header to inspect raw PTY bytes, input, resize behavior, and named-session
reattachment. Production backup/restore also needs the Sandbox SDK's R2 access
key secrets; the `BACKUP_BUCKET` binding alone only covers local backup mode.
