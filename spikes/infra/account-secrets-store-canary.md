# M01B disposable Account Secrets Store canary

This is an inert, offline-verifiable scaffold. **Documentation is not authorization.** Normal tests
do not authenticate, deploy, mutate Cloudflare, or inspect real credential values. The default
Stack composes the concrete Cloudflare provider with a lazy, local, synthetic-only source and a
stage-local owner key while keeping Alchemy state local. Do not use `~/.codex/auth.json` here.

## Local preflight

1. Run `npm run fmt`, `npm run lint:skills`, the focused tests, contract typecheck, and secret scan.
   Inspect the source and bundle for routes, telemetry, logging, plaintext props, stable names, or an
   Alchemy fork; stop if found.
2. Generate a fresh stage and private local directory:

   ```sh
   stage="m01b-secret-canary-$(openssl rand -hex 16)"
   canary_dir="$HOME/.config/scotty/canaries/$stage"
   umask 077
   mkdir -p "$canary_dir"
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' >"$canary_dir/root-key"
   synthetic_value="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
   printf '{"OPENAI_API_KEY":"%s"}' "$synthetic_value" >"$canary_dir/auth.json"
   unset synthetic_value
   chmod 600 "$canary_dir/root-key" "$canary_dir/auth.json"
   ```

   The value is deliberately synthetic but still must not enter argv, logs, plans, or state.

3. Export metadata and paths only. Do not export plaintext and do not sync yet:

   ```sh
   export ALCHEMY_STAGE="$stage"
   export ALCHEMY_TELEMETRY_DISABLED=1
   export SCOTTY_M01B_SYNTHETIC_AUTH_FILE="$canary_dir/auth.json"
   export SCOTTY_M01B_ROOT_KEY_FILE="$canary_dir/root-key"
   export SCOTTY_M01B_ACCOUNT_ID="<synthetic-test-account-id>"
   export SCOTTY_M01B_STORE_ID="<isolated-test-store-id>"
   export SCOTTY_M01B_BINDING_ATTACHED=1
   ```

   Sync is an explicit pre-plan operation, but it remains locked until all three exact approvals are
   present. Planning consumes only the resulting digest; reconcile reopens the source lazily and
   verifies the same digest before mutation.

4. Confirm every physical name begins `scotty-m01b-disposable-`, retains 96 random bits, and is at
   most 63 characters. Use only local state, `destroy` from first deployment, no routes, no adoption,
   and no stable production names.

## Approval and lifecycle

1. Stop and request confirmation before authenticating or running any Cloudflare plan. All remaining
   commands run from the approved local machine/runner, never from an autonomous orb.
2. Separately request authentication/evaluation approval, mutation approval, and cleanup approval.
   Only an authorized operator may set exact values:
   `SCOTTY_M01B_APPROVE_DEPLOY=deploy:<stage>`,
   `SCOTTY_M01B_APPROVE_MUTATION=mutate:<stage>:synthetic`, and
   `SCOTTY_M01B_APPROVE_CLEANUP=destroy:<stage>:disposable`. Missing or wrong values must fail before
   program/resource evaluation. Possessing this runbook grants none of these approvals.
3. After explicit approval, set those exact values and run the isolated sync before authentication:

   ```sh
   sync_json="$(bun spikes/infra/account-secrets-store-canary-sync.ts)"
   export SCOTTY_M01B_KEYED_DIGEST="$(printf '%s' "$sync_json" | jq -er .keyedDigest)"
   unset sync_json
   ```

4. Authenticate locally. Use only the guarded executor; it rejects unexpected resources, actions,
   tasks, phases, and source/key disclosure before apply, then scans output and local state. Start
   with the guarded plan only:

   ```sh
   export SCOTTY_M01B_PHASE=first SCOTTY_M01B_OPERATION=plan
   bun spikes/infra/account-secrets-store-canary-exec.ts
   ```

   The first plan must be create-only for exactly `SyntheticSecret (Scotty.WriteOnlySecret)` and
   `SyntheticBindingWorker (Cloudflare.Worker)`. Stop on any other resource/action or unresolved
   physical name. Confirm the Worker desired binding contains solely
   `{type,name,storeId,secretName}` for the synthetic secret. Never invoke raw `alchemy deploy` or
   `alchemy destroy` for this canary.

5. After reviewing the plan, prove ambiguous create once by setting
   `SCOTTY_M01B_INTERRUPT_AFTER_WRITE=create` and `SCOTTY_M01B_OPERATION=apply` for the first approved
   apply. The canary adapter interrupts only after Cloudflare returns successful create
   metadata, so Alchemy must not have a committed resource output. Unset the variable immediately
   and rerun guarded `apply`: recovery must find the authentic same-name secret, re-resolve the synthetic
   source, PATCH its exact ID, observe `active`, and then create the Worker. Never kill an arbitrary
   mutation and guess whether it committed.
6. Update `auth.json` with a newly generated synthetic value, rerun sync, set
   `SCOTTY_M01B_PHASE=update`, and use guarded `plan` then `apply`. The plan may contain only secret
   update plus Worker no-op. Set
   `SCOTTY_M01B_INTERRUPT_AFTER_WRITE=patch` for one approved deploy, unset it, then rerun. Recovery
   must re-PATCH the persisted exact ID and observe `active`; there must be no blind HTTP retry.
7. Call the Worker endpoint. It may return only `{ "bound": true }`; stop if body, logs, telemetry,
   plans, state, outputs, or errors contain synthetic plaintext or the owner-key marker.
8. Set `SCOTTY_M01B_PHASE=second` and run guarded `plan`. Both resources must be no-op. Stop on
   update, replace, delete, or an unexpected resource.
9. Set `SCOTTY_M01B_BINDING_ATTACHED=0` and `SCOTTY_M01B_PHASE=unbind`; run guarded `plan` then
   `apply`, and verify the endpoint returns `{ "bound": false }`. Only then set
   `SCOTTY_M01B_PHASE=destroy`, run guarded `plan`, review delete-only actions for precisely the
   Worker and secret, and run guarded `apply`. Delete only the persisted exact secret ID; cleanup
   must not resolve the source, bulk-delete, delete a store, or force-delete.
10. Directly query Cloudflare metadata using the approved operator tooling and verify the exact
    Worker and exact secret ID are absent. Check no disposable same-stage names remain. Only then
    remove local state, delete the disposable local canary directory, and unset approvals and
    authentication.

Stop immediately for approval mismatch, non-local state, enabled observability, adoption/routes,
name collision, unexpected plan action/resource, source read during plan/no-op/delete, foreign or
tampered ownership, leaked marker/plaintext, ambiguous identity, failed absence check, or any need
to use real credentials as canary material. Preserve sanitized evidence and escalate; do not retry
mutation or cleanup by hand.
