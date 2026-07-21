# M01C disposable Sandbox SDK canary

This proof is inert during the normal local gate. It describes one synthetic Alchemy Worker,
external SQLite Durable Object, Container application, KV namespace, R2 bucket, and static asset
binding. It does not replace Wrangler/Hono and must use a newly generated random stage:

```sh
stage="m01c-canary-$(openssl rand -hex 16)"
```

The disposable canary runs against unmodified Alchemy beta.63. It avoids two missing production
safety contracts rather than weakening them:

1. Every physical name derives from a fresh 128-bit random stage and retains 96 random bits. This
   makes accidental collision the primary isolation control. The reviewed first plan must contain
   only the four expected creates. Never use `--adopt`.
2. Every resource uses `destroy` from its first deployment. The canary never relies on a later
   `retain` → `destroy` policy transition.

The portable Alchemy extensions under `work/` remain evidence for later production adoption,
where stable existing names and retained authoritative data make these workarounds invalid. They
are not applied to Scotty's dependency or upstream gitlink.

## Safety model

- Stages must match `m01c-canary-<32 lowercase hex characters>`.
- Every physical name starts with `scotty-m01c-disposable-`, includes 96 bits of the isolated
  stage suffix, and remains at most 63 characters.
- The stack refuses even to evaluate unless `SCOTTY_M01C_APPROVE_DEPLOY` exactly equals
  `deploy:<stage>`.
- Resources use Alchemy `destroy` from creation. Every plan, deployment, and destroy evaluation
  also requires `SCOTTY_M01C_APPROVE_CLEANUP` to exactly equal `destroy:<stage>:disposable`; this
  prevents an ordinary environment from evaluating the destructive stack.
- `ALCHEMY_TELEMETRY_DISABLED=1` is mandatory. Worker/Container observability is disabled. The
  stack has no custom routes or adopted names and must never be run with `--adopt`.
- No credential is accepted by the stack. The backup assertion uses the SDK's credential-less,
  R2-binding-backed path. The production presigned-R2 path remains unverified until an approved
  live destination implements M01B's source-reference/digest-only provider contract.

## Account Secrets Store boundary deferred from this scaffold

Per-Worker secrets and Alchemy's built-in `SecretsStore.Secret` are prohibited: both can place
plaintext in Alchemy resource props/state. A later production-presigned-backup proof may use only
an Account Secrets Store resource and identifier-only Worker binding:

```text
{ type: "secrets_store_secret", name, store_id, secret_name }
```

That binding must remain in every desired Worker upload; omitted-binding preservation is not a
credential contract. The deferred provider must enforce all of the following before this canary
claims presigned backup parity:

- props/state contain stable store/secret IDs, source reference, provider version, keyed local
  digest, and an authenticated/versioned Scotty owner marker encoded in the secret `comment`;
- exact-ID plus the persisted owner/marker gates update and delete; privileged Cloudflare admins
  remain outside the threat model;
- remote metadata has no value digest/version/CAS, and this limitation is explicit in plans and
  tests rather than replaced with idealized native owner/digest fields;
- an ambiguous POST/PATCH outcome always re-resolves the trusted source and idempotently PATCHes
  the exact ID until one unambiguous success and an `active` observation occur; marker/comment
  alone never proves plaintext;
- POST/PATCH automatic retries are disabled, interruption is preserved, and typed failures,
  defects, request/response objects, logs, and telemetry are sanitized;
- delete first removes the Worker binding, then GETs the persisted exact ID, verifies the expected
  owner/marker, and DELETEs only that ID without resolving the source; no bulk/store/force delete;
- values are limited to 1024 bytes until a live test resolves the docs/OpenAPI discrepancy.

Required local contracts are pending/active/deleted, 404/409, foreign/tampered marker,
explicit/failed adoption, ambiguous writes, no blind retries, zero source reads for
read/plan/no-op/delete, binding metadata, and secret scans across plans/state/logs/errors/bundles.
That provider work is deferred because M01C is a synthetic credential-free scaffold, not Chunk 2
or production secret adoption.

## Later live procedure — requires new explicit approval

The text below is documentation, not authorization. Choose a fresh random stage and keep deploys
serialized for that stack and stage.

1. Review the first plan. It must contain only creates for the Worker, Container, KV, and R2
   resources; the `ScottySandbox` SQLite migration, Container class metadata, and matching
   namespace association are Worker/Container metadata rather than standalone resources. Stop on
   any update, replacement, delete, action, or unexpected resource. A create plan does not prove
   remote absence for resources whose props contain unresolved outputs; random-name isolation is
   the collision control for this disposable canary.
2. Deploy without `--adopt`, record the non-secret Worker URL output, and run
   `sandbox-sdk-canary.live.test.ts` with:
   - `ALCHEMY_STAGE=<stage>`
   - `SCOTTY_M01C_CANARY_URL=<deployed HTTPS URL>`
   - `SCOTTY_M01C_RUN_LIVE=run:<stage>`
3. Review a second plan. After any provider normalization pass, every action must be `noop`.
4. Run destroy with both exact approvals still present. Verify the isolated Worker, Container
   application, KV namespace, R2 bucket/backups, and DO namespace are absent before deleting local
   state.

The live suite is a starting harness for fixed command execution, file operations, a named session,
native binary PTY WebSocket exchange/reconnect, binding-backed backup/restore, outbound
allow/deny behavior, lifecycle callbacks, and Durable Object storage across host reconstruction.
It exposes only one stage-derived DO and `/bin/cat`, never an interactive shell. Until the suite,
actual activity-expiry timing, static assets, second plan, and guarded cleanup pass, all entries in
`M01C_LIVE_ASSERTIONS` remain `unverified-live`.

## Pinned public contracts

- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Worker.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerProvider.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObject.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerApplication.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerPlatform.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerProvider.ts`
- `vendor/alchemy/packages/alchemy/src/Resource.ts`
- `node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts`
- `node_modules/@cloudflare/sandbox/dist/sandbox-DI6suZAc.js`

`bindExternalSandboxContainer` contributes only public bindings; Alchemy's built-in Worker and
Container providers remain the only cloud reconcilers. `ContainerProxy` is re-exported directly
from the official Sandbox package, and the canary class extends the current production Sandbox
class without changing production routes or lifecycle code.
