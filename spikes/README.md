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

## Migration baseline

`fixtures/wrangler-bundle-metadata.json` records the current Worker bundle,
exports, bindings, migration, assets configuration, and Container association
for comparison with the future Alchemy plan. It was produced without deploying:

```sh
npx wrangler deploy --dry-run --config worker/wrangler.jsonc \
  --outdir /tmp/scotty-wrangler-baseline \
  --metafile /tmp/scotty-wrangler-baseline/bundle-meta.json \
  --containers-rollout none
```

`--containers-rollout none` skips the local Docker build while preserving the
declared Container in Wrangler's generated metadata and binding report.
