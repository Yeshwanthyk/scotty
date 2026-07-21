# Scotty: Alchemy v2 + Effect v4 implementation packet

This is the handoff for a fresh implementation session. It records the settled target architecture, what setup already exists, the gaps Scotty must fill itself, ordered migration slices, and the proof required before replacing the current Wrangler/Hono implementation.

## Orientation

Scotty will use one model rather than keeping infrastructure in Wrangler, HTTP in Hono, domain work in manual Promises, and selected helpers in Effect.

- **Alchemy v2 owns Cloudflare infrastructure and ordinary runtime integration.** It declares the stack, Workers, Durable Object bindings/migrations, Container application, KV, R2, assets, domains, stages, deployment, state, and deployed integration tests.
- **Effect v4 owns application behavior.** It defines HTTP contracts, schemas, typed errors, services/layers, storage adapters, retries, clocks, scopes, concurrency, streaming, and CLI effects.
- **The official Cloudflare Sandbox SDK remains the container/session implementation.** Alchemy does not implement its process, file, terminal, backup, or credential-interception APIs. Scotty supplies the missing Effect bridge and Alchemy provider glue.
- **Native code is limited to mandatory host signatures.** The Sandbox SDK subclass and PTY/outbound callback signatures remain tiny native islands that delegate immediately into scoped Effects. They are not a competing application architecture.

The end state has no Hono runtime, no hand-maintained `wrangler.jsonc`, no manual KV/R2 binding interfaces, and no second Cloudflare Effect integration such as `effect-cf`.

## Current audit status

### Setup completed

- `vendor/effect` pins Effect commit `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`, package set `4.0.0-beta.99`.
- `vendor/alchemy` pins Alchemy release commit `cde008ab6b77783d3edbf5dc82750fbdfd279347`, exactly matching installed package `2.0.0-beta.63`.
- Worker runtime dependency `effect@4.0.0-beta.99` is exact.
- Root dependencies `effect@4.0.0-beta.99`, Alchemy's optional bridge peer `@effect/platform-node@4.0.0-beta.99`, `alchemy@2.0.0-beta.63`, and `@effect/vitest@4.0.0-beta.99` are exact.
- Alchemy's Effect peer range is `>=4.0.0-beta.97 || >=4.0.0`; Scotty beta.99 satisfies it.
- `AGENTS.md` requires source-first work against both submodules and records the Sandbox and credential constraints.
- oxfmt and oxlint are pinned and exclude all `vendor/**` source.

### Conversion not yet implemented

- Production source does not import Effect or Alchemy.
- `worker/src/index.ts` still uses Hono and manually defined bindings.
- `worker/wrangler.jsonc` still owns deployment metadata.
- Session, credential, egress, Sandbox, backup, and CLI code remains Promise/throw based.
- Stored and network data uses manual validation and unsafe casts rather than Schema.
- No Alchemy stack, custom provider, Effect HTTP API, Sandbox Effect bridge, or Alchemy deployed test exists.

Do not report the repository as migrated until the definition of done at the end of this packet passes.

## Settled contracts and invariants

### Public behavior remains compatible

Preserve unless explicitly approved otherwise:

- HTTP methods and routes currently registered in `worker/src/index.ts`.
- Error envelope `{ "error": { "code", "message", "hint" } }` and HTTP statuses.
- CLI JSON keys, TTY behavior, stdout/stderr placement, and exit codes `0`–`5`.
- PTY framing, resize, reconnect, binary output, token-to-cookie handoff, and streamed beam-down behavior.
- Persisted `SessionRecord` version `1`, storage keys, statuses, operation lease, and nonce semantics.
- `/workspace/<id>`, branch `scotty/<id>`, tmux session `agent`, and execution session `scotty-web`.

### State ownership remains unchanged

- The Sandbox Durable Object storage owns the authoritative session record, operation lease, real credential bundle, refresh lease, and hard-cap metadata.
- KV is only an eventually consistent, non-secret list projection. It never authorizes a transition.
- R2 stores immutable backups. The authoritative DO record decides which backup is current and recoverable.
- The container filesystem is disposable state restored from a DO-approved backup.
- Alchemy state owns infrastructure metadata only. It must not own session state or real Codex/GitHub credential values.
- Effect runtime memory may contain invocation-scoped adapters or disposable caches, never the only copy of externally meaningful state.

### Credential isolation remains stronger than normal Alchemy secrets

- Real Codex/GitHub credentials may exist only in the approved initial secret source and Sandbox DO storage.
- Containers receive session-bound sentinels only.
- No real credential enters Container environment, files, args, logs, Git config, KV, R2, API responses, stack outputs, Alchemy resource props, or Alchemy state.
- `Config.redacted` is not sufficient: Alchemy state encoding retains the wrapped value in encrypted state.
- Scotty must implement a write-only/reference-only Alchemy secret resource whose persisted state contains an identifier and digest, never the value.
- OAuth rotation commits to the Sandbox DO before a sanitized sentinel response reaches the container.

## Target architecture

The Sandbox SDK's required base class cannot also extend Alchemy's generated Durable Object bridge. Use two Alchemy-managed Workers so the ordinary API can be fully Effect-native while the SDK host remains a minimal external-class island.

```diagram
┌────────────────────────────── Alchemy Stack ────────────────────────────────┐
│                                                                            │
│  ┌────────────────────┐       typed cross-worker DO binding                │
│  │ API Worker         │────────────────────────────────────┐               │
│  │ Alchemy + Effect   │                                    │               │
│  │ HttpApi / Router   │                                    ▼               │
│  └─────────┬──────────┘                         ┌────────────────────────┐   │
│            │                                    │ Sandbox Host Worker    │   │
│            │                                    │ external SDK class     │   │
│       ┌────┴────┐                               │ + Scotty Effect bridge │   │
│       │ Assets  │                               └───────────┬────────────┘   │
│       └─────────┘                                           │                │
│                                                             ▼                │
│                                                   ┌──────────────────────┐   │
│  ┌────────────┐  ┌────────────┐                  │ Sandbox Durable Obj. │   │
│  │ KV project │  │ R2 backups │◀─────────────────│ authoritative state  │   │
│  └────────────┘  └────────────┘                  └───────────┬──────────┘   │
│                                                             │                │
│                                                             ▼                │
│                                                   ┌──────────────────────┐   │
│                                                   │ Container app/image  │   │
│                                                   │ Codex + tmux + git   │   │
│                                                   └──────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

### API Worker

Use `Cloudflare.Worker` in its Effect-native form.

- Effect `HttpApi` defines JSON endpoint paths, inputs, outputs, and declared errors.
- `HttpRouter` handles raw/special responses: terminal HTML, token redirect/cookie handoff, PTY upgrade proxy, assets, and tar streaming.
- Alchemy's bridge supplies one isolate initialization and one fresh event scope, transfers stream/WebSocket scope ownership correctly, and closes event resources through `waitUntil`.
- Alchemy KV capability clients implement list-projection reads.
- A typed cross-worker Durable Object binding invokes the Sandbox host.
- Remove Hono after route parity tests pass.

### Sandbox Host Worker

Deploy a plain module through Alchemy because Cloudflare must see an exported class extending `@cloudflare/sandbox`'s `Sandbox`.

- The host module exports `ScottySandbox extends Sandbox<Bindings>` under the exact class name declared in Alchemy.
- The host module also exports the official Sandbox SDK `ContainerProxy`; outbound interception depends on this export.
- Public Promise-returning RPC methods call one `runSandboxEffect` boundary helper.
- `runSandboxEffect` has explicit variants for serializable RPC values, native streaming responses, PTY/WebSocket upgrades, lifecycle callbacks, and outbound callbacks. It must not close a scope while a returned stream/socket still owns resources.
- SDK lifecycle, PTY, outbound, and scheduling callbacks preserve their exact native signatures and immediately delegate domain work into Effect.
- Workerd-owned Request, Response, WebSocket, and stream identities stay within the callback event; they are not cached across events.
- The host binds the same KV projection and R2 backup resources through Alchemy.

### External Sandbox DO + Container association

Alchemy can already declare and migrate an externally implemented DO:

```ts
Cloudflare.DurableObject<ScottySandbox>("Sandbox", {
  className: "ScottySandbox",
  scriptName: sandboxHostName,
});
```

Alchemy can also build and deploy Scotty's Dockerfile as a Container application. Its Effect-native `Containers.layer` assumes an Alchemy-generated DO, but beta.63 resources expose public binding contracts. Implement a small Scotty binding helper, not an independently reconciling cloud provider, that contributes the same two relationships as Alchemy's `ContainerPlatform.bind`:

1. Worker metadata `containers: [{ className: "ScottySandbox" }]`.
2. Container application `durableObjects.namespaceId` set to the external DO namespace ID.

The helper binds the external namespace ID into the existing Container resource and the class metadata into the existing Sandbox host Worker. Alchemy's built-in Worker and Container providers remain the sole reconcilers. Test plan output, idempotence, replacement behavior, and deletion through those providers. If the exact public binding shape fails to compile or deploy against the release pin, contribute/patch the smallest public helper and pin that source before continuing; do not add a second owner that mutates the same cloud resources.

### Write-only secret resource

Implement one small Alchemy custom resource, tentatively `WorkerSecretReference`:

- resource props contain only `sourceId`, destination identifiers, and a version/digest reference;
- a lazy deploy-only `SecretSource` Effect service resolves plaintext inside `reconcile`, never while constructing Alchemy resource `news` or attributes;
- provider writes it through Cloudflare's Worker secret or Secrets Store API;
- persisted Alchemy state contains only Worker/script ID, binding name, provider version, and a keyed digest suitable for drift/change detection;
- plans, logs, errors, outputs, telemetry, and state never contain the plaintext;
- read cannot recover the value and reports only existence/metadata;
- delete removes only the named secret;
- synthetic-secret tests scan local and remote state after success, failure, interruption, and destroy.

Prefer a write-only Secrets Store resource plus identifier-only Worker binding if the target account supports it. Otherwise prove separately managed Worker secrets survive later Alchemy uploads. Bind Codex/GitHub seeds only to the Sandbox host and HTTP auth only to the API Worker. The Sandbox DO seeds both real Codex and GitHub values once; existing DO values always win, and egress reads both real credentials from DO storage rather than Worker bindings.

#### Temporary local provenance contract

Until a shared secret manager is selected, approved operators may sync the
initial Codex seed from exactly `${CODEX_HOME:-~/.codex}/auth.json` on the
local deploy machine. The trusted adapter rejects arbitrary source IDs,
symlinks, non-regular files, wrong ownership, group/other permissions,
malformed Codex JSON, and values over the provider's 1024-byte cap. CI cannot
resolve this source and fails closed when standard CI identity variables are
present. The production Layer derives paths only from absolute `HOME` and
`CODEX_HOME`; arbitrary-path source Layers are explicitly disposable synthetic
canary/test boundaries and are not used by the production composition.

A stable 256-bit root lives outside the repository at
`~/.config/scotty/secrets/root-key`, mode 0600, with an independent encrypted
recovery copy required before any real mutation. Domain-separated digest and
owner-marker keys are derived in memory. The operator that creates the recovery
copy records a mode-0600, no-symlink `root-key.recovery.json` receipt containing
only `{version:1,rootKeyFingerprint,escrowId}`. The production owner-key Layer
fails before provider evaluation if the receipt is absent, malformed, or does
not match the active root. The receipt is a trusted operator attestation, not a
second copy of the key. An explicit sync step reads the local source and emits
only `{sourceId,keyedDigest}`; Alchemy plan consumes that metadata and never
opens the Codex file. Reconcile re-reads the exact file, recomputes the digest,
and fails before mutation if the source changed after sync.

Owner-key rotation verifies with one active key and at most one retained
previous key, signs with the active key only, and uses a provider-version bump
to force re-signing. The retained key has its own matching recovery receipt and
uses the fixed `root-key.previous` path; enable it only with
`SCOTTY_RETAIN_PREVIOUS_OWNER_KEY=1`. Drop the previous key only after a no-op
plan passes with active-only verification. Existing Sandbox DO credential
bundles remain authoritative; changing the local seed affects new sessions,
while Chunk 5 owns rotation for existing sessions.

### Alchemy state and deployment policy

- Pin `alchemy@2.0.0-beta.63` and its source SHA. Upgrade only in a dedicated compatibility change.
- Disable Alchemy telemetry during the evaluation and production path.
- Use one Cloudflare remote state store per account boundary.
- Enforce one deploy per stack/stage in CI; the inspected Alchemy state API has no stack-wide lease/CAS around plan → cloud mutation → state commit.
- Pin physical resource names for adoption.
- Persistent DO/R2 resources need explicit retain/adoption handling before any destroy test.
- Keep Wrangler only as a temporary rollback artifact until the Alchemy canary and one production release pass; then remove it rather than maintaining two configurations.

## Target flows

### HTTP command

1. Alchemy starts an event-scoped API Worker handler.
2. `HttpApi` decodes path/query/body/auth data with Schema.
3. The handler calls the typed Sandbox DO binding.
4. The Sandbox host converts RPC entry into a scoped Effect.
5. The Effect reads authoritative DO state and performs the transition through typed services.
6. Declared domain errors cross RPC as stable values and map to the existing HTTP envelope.
7. The API Worker returns an Effect HTTP response; Alchemy converts it to the native response.

### PTY/stream request

1. `HttpRouter` authenticates and looks up the authoritative session through typed RPC.
2. The Sandbox SDK receives the exact native request/upgrade object it requires.
3. The native SDK callback owns pumping/backpressure for the PTY/WebSocket.
4. State decisions and failures delegate to Effect services in the same event.
5. Alchemy transfers response scope ownership to the stream/upgrade and closes it at completion.

### Credentialed egress

1. Container presents a Sandbox-bound sentinel.
2. Native outbound callback invokes the Effect egress program.
3. Credential vault validates the sentinel against authoritative DO storage.
4. Host policy injects the real credential only for the allowlisted destination with manual redirects.
5. OAuth refresh acquires a transactional lease, persists rotation, and returns sentinel-only JSON.
6. Typed failures are redacted before crossing the callback boundary.

## Delivery DAG

```diagram
┌───────────────┐
│ 0 Baseline    │
└───────┬───────┘
        ▼
┌────────────────────────┐
│ 1 Alchemy feasibility  │
│ providers + SDK canary │
└───────────┬────────────┘
            ▼
┌────────────────────────┐
│ 2 Stack + adoption     │
│ no runtime cutover     │
└───────────┬────────────┘
            ▼
┌────────────────────────┐
│ 3 Schema/error domain  │
└───────────┬────────────┘
            ▼
┌────────────────────────┐
│ 4 Sandbox Effect bridge│
│ state + operation lease│
└───────────┬────────────┘
            ├────────────────────┐
            ▼                    ▼
┌────────────────────┐  ┌────────────────────┐
│ 5 Vault + egress   │  │ 6 Sandbox adapters │
└─────────┬──────────┘  └──────────┬─────────┘
          └──────────────┬─────────┘
                         ▼
              ┌────────────────────┐
              │ 7 API Worker       │
              │ HttpApi + Router   │
              └──────────┬─────────┘
                         ▼
              ┌────────────────────┐
              │ 8 Create/resume    │
              └──────────┬─────────┘
                         ▼
              ┌────────────────────┐
              │ 9 Backup/lifecycle │
              └──────────┬─────────┘
                         ▼
              ┌────────────────────┐
              │ 10 Ship/destroy    │
              └──────────┬─────────┘
                         ▼
              ┌────────────────────┐
              │ 11 Effect CLI      │
              └────────────────────┘
```

## Implementation chunks

### Chunk 0 — restore and record a green baseline

**Status:** Complete. Node is pinned to `22.22.2`; `npm run check` enforces a
single installed Effect version; and
`spikes/fixtures/wrangler-bundle-metadata.json` records the Wrangler baseline.

**Purpose:** separate pre-existing behavior/tooling issues from migration regressions.

**Work:**

- Upgrade the development Node runtime to at least `22.22.2` or `24.15.0`; current Node `22.21.1` triggers an `ini@7` engine warning after Alchemy installation.
- Confirm exact npm and submodule pins resolve to one Effect beta.99 copy.
- Run format/lint/typecheck/test/security scan/CLI build and fix only baseline failures.
- Add a check that fails on multiple installed Effect versions.
- Record current Wrangler bundle metadata as a fixture for later Alchemy comparison.

**Gate:** no runtime behavior changes. Commit separately.

### Chunk 1 — prove the missing Alchemy integration before broad conversion

This is the first hard gate. Do not migrate routes or lifecycle until it passes.

**Status:** 1A and 1B pass their local public-contract proofs. The 1C local
scaffold uses fresh 128-bit stage-derived physical names, requires an exact
create-only first-plan review, and marks every disposable resource `destroy`
from its first deployment. Random-name isolation, rather than the create plan
alone, controls accidental collision because Alchemy may skip a provider read
while desired props contain unresolved outputs. This lets the isolated
synthetic canary use unmodified Alchemy beta.63 without relying on a
retain-to-destroy transition. Fail-closed adoption and policy persistence
remain blockers for Chunk 2 production adoption, where stable existing names
and retained authoritative data cannot use the disposable-canary workaround.

The approved disposable deployment on 2026-07-21 passed command/file/session,
outbound allow/deny, binding-backed R2 backup/restore, DO reconstruction, and
binary PTY reconnect tests. Its normalized second plan contained four no-ops,
and Cloudflare API reads independently confirmed the Worker, Container
application, KV namespace, and R2 bucket absent after guarded cleanup. Exact
activity-expiry timing and browser asset rendering remain outside that proof.

The Account Secrets Store provider now enforces metadata-only state, exact-ID
ownership/update/delete, authenticated markers, bounded activation, and
ambiguous-write replay with short-lived plaintext. Foreign/unowned adoption
intentionally fails closed on unmodified Alchemy beta.63 because the engine
cannot carry current-run adoption authorization safely into reconcile. The
Cloudflare HTTP transport, local-only lazy Codex source, stable/rotatable owner
key, complete provider Layer composition, identifier-only binding, and guarded
synthetic canary definition pass offline contracts. The approved local
Secrets Store canary on 2026-07-21 passed create convergence, exact-ID update
recovery, identifier-only runtime binding, steady-state no-op, unbind,
exact-ID delete, and direct absence checks without disclosing synthetic
plaintext or owner-key material. Live proof also corrected the provider Layer
service exposure, Cloudflare's count-based pagination envelope,
unresolved-Output plan display, and the guarded replay shape when Alchemy
creates an independent Worker concurrently with the injected secret-create
interruption. Review then found that read-recovered create metadata could skip
source revalidation; the provider now requires committed old props before a
no-op, with direct and full Plan-to-Apply regressions proving re-resolution,
digest verification, and exact-ID PATCH. The reusable isolated test store
remains; the stage Worker, secret, local state, and synthetic files were
removed.

#### 1A External Sandbox Container binding helper

Implement and test the public binding helper against a disposable Worker/DO/Container. Verify:

- generated Worker metadata names the external `ScottySandbox` class;
- Container application references the same DO namespace ID;
- the built-in providers' read/diff/reconcile is idempotent;
- interrupted provider reconcile converges on retry;
- Container association replacement behavior is explicit in the plan;
- no private Alchemy APIs leak into application call sites.

#### 1B Write-only secret provider

Use synthetic credentials. Verify no plaintext in `.alchemy`, remote state responses, plans, logs, stack outputs, exceptions, generated bundle, Docker context, telemetry, or provider state. Test update, failed update, interruption, and delete.

#### 1C Sandbox SDK deployed canary

Deploy the current official `ScottySandbox` class and Dockerfile through Alchemy in an isolated stage. Prove command execution, files, named sessions, PTY/WebSocket, backup/restore, lifecycle callbacks, outbound interception, and DO storage survive reconstruction.

**Stop condition:** if public Alchemy binding/provider APIs cannot safely express 1A/1B, implement the smallest public extension in a pinned Alchemy fork or upstream change. Do not fall back to permanent Wrangler/manual scripts.

### Chunk 2 — adopt the current monolith without moving authority

First place current physical resources under Alchemy ownership without changing Worker topology or moving the Durable Object class. Deploy the existing module as an external/async Alchemy Worker and preserve its exact Worker name, Sandbox class name, DO namespace, Container association, KV, R2, assets, compatibility flags, routes, and secrets.

**Files introduced:** `alchemy.run.ts` and focused infrastructure modules under an appropriate existing directory; do not create a broad framework hierarchy.

**Resources:**

- Current monolithic Worker and static assets.
- Existing external `ScottySandbox` class, `ContainerProxy`, DO namespace, and migration metadata without transfer.
- Container application built from `worker/container/Dockerfile`.
- KV session projection.
- R2 backup bucket and lifecycle/retention policy.
- write-only secret resources.
- explicit stage names, physical names, compatibility flags, limits, domains, and stack outputs containing no secrets.

**Adoption proof:**

1. clone or create non-production equivalents with seeded DO/KV/R2 data;
2. run Alchemy plan/adopt without applying;
3. require zero delete/replace for Worker, DO namespace, KV, R2, and Container application;
4. compare generated bindings, migrations, container metadata, assets, compatibility config, and routes with the recorded Wrangler fixture;
5. deploy, rerun plan, and require a no-op;
6. exercise rename/transfer/remove migration fixtures separately so data-destructive plans are visible;
7. seed synthetic session state, operation lease, credential bundle, schedule, KV projection, and R2 backup and prove adoption preserves all of them.

Wrangler remains rollback-only during this chunk and must not be updated in parallel.

### Chunk 3 — Schema domain and typed error contract

**Files/symbols:** `worker/src/contracts.ts`, credential/OAuth types in `worker/src/egress.ts`, CLI response decoders, and new Effect HTTP API declarations.

**Work:**

- Define schemas for every HTTP input/output, persisted session/credential record, KV projection, OAuth payload, PR/down result, and CLI response.
- Keep version `1`, defaults, limits, trimming, optional-key omission, and public error text compatible.
- Use schema-backed tagged errors for public HTTP/RPC failures and data-tagged errors for internal adapters.
- Map `bad_request`, `auth`, `not_found`, `wrong_state`, `conflict`, `upstream`, and `internal` to existing statuses and exit codes.
- Replace domain wall-clock use with `Clock`; tests use `TestClock`.
- Malformed authoritative state fails closed and is never silently repaired. Malformed KV projection may be skipped but cannot affect transitions.

**Tests:** fixtures for every state, public envelope golden tests, credential-safe parse errors, time calculations, and CLI golden output.

### Chunk 4 — Sandbox Effect bridge and authoritative state services

**Host boundary:** `ScottySandbox extends @cloudflare/sandbox Sandbox` remains, but methods become thin adapters over Effects.

**Services:**

- `SessionStore`: DO storage get/put/transaction/decode.
- `SessionProjection`: Alchemy KV capability implementation.
- `SandboxRuntime`: official SDK process/file/session/schedule/container calls.
- `BackupStore`: official SDK backup plus Alchemy R2 capability where direct R2 cleanup is required.
- `CredentialVault`: added in Chunk 5.

**First migrated symbols:** `requireRecord`, `project`, `acquireOperation`, `updateForOperation`, `releaseOperation`, `releaseOperationIfHeld`, `failOperation`.

**Invariants/tests:** atomic status+lease transaction, stale nonce rejection, concurrency conflict, projection non-authority, recoverability only with current backup, event-scope finalization, and DO reconstruction without runtime-memory authority.

Do not combine this chunk with checkpoint/hard-cap behavior.

### Chunk 5 — credential vault and egress

Implement in two reviewable commits.

#### 5A Vault

Migrate `seedCredential`, `requireCredential`, `readCredentialForProxy`, refresh lease acquisition/cancel/rotation, and credential deletion. Use transactional DO storage and `Clock`. Seed both Codex and GitHub credentials into the DO once. Existing stored credentials always win over later seed changes; new sessions without required seeds fail closed. GitHub egress must stop reading the real token directly from Worker env.

#### 5B Egress

Keep the official native outbound callback signatures and delegate to Effect programs for host policy, sentinel lookup, OAuth decode/rotation, fetch, retry, and error mapping.

**Security proof:** destination matrix, credential type separation, manual redirects, auth/cookie stripping on pass-through, deny fallback, malformed OAuth fail-closed, rotation-before-response, restart persistence, and full surface scan.

### Chunk 6 — Sandbox process/workspace adapters

Migrate `execChecked`, worktree preparation, Git helper, sentinel auth seed, agent start/resume, environment construction, rollout discovery, and command redaction behind typed services.

The official Sandbox SDK remains the implementation; Scotty writes Effect wrappers with `Effect.tryPromise`, typed errors, scopes, and interruption policy.

**Tests:** exact cwd/env/session IDs, hostile shell inputs, prompt/title non-logging, existing/missing repository behavior, dynamic default branch, fake agent, resume ID/`--last`, SDK adapter contract, and no credential in any command surface.

### Chunk 7 — build the two-Worker topology in a shadow stage

**JSON API:** define with `HttpApi` and handler layers.

**Special routes:** use `HttpRouter`/raw Effect HTTP response support for:

- terminal page and assets;
- token-to-cookie redirect;
- PTY/WebSocket upgrade;
- streamed beam-down tar;
- any Sandbox callback requiring exact native object identity.

Use Alchemy KV clients and typed cross-worker DO binding. Delete Hono dependency and Hono-specific tests only after route parity, auth, stream, and upgrade tests pass. Do not retain a second route table.

Prove the API Worker and Sandbox host in a shadow stage first. The Sandbox host contract includes `ScottySandbox`, `ContainerProxy`, and separate scope ownership tests for ordinary RPC, streaming responses, PTY/WebSocket upgrades, lifecycle callbacks, and outbound callbacks.

For the controlled cutover, either transfer `ScottySandbox` from the adopted monolithic Worker to the Sandbox host while preserving the namespace ID, or keep the existing physical Worker as the Sandbox host and move public traffic to the new API Worker. Seed state before rehearsal and prove the same DO namespace ID, record, lease, credential, schedule, backup, and Container association afterward.

Rollback after this point is not “redeploy Wrangler.” Prepare either a reverse DO transfer or a traffic/code rollback that leaves DO ownership on the new host. Rehearse forward and rollback transitions on cloned non-production state before production.

### Chunk 8 — create and resume

Migrate `createScottySession` and `resumeScottySession` over the established services.

- Create: absent/gone → `booting` lease → credential/workspace/agent/schedule → `warm`.
- Create failure: `failed`, nonrecoverable → destroy or bounded destroy retry.
- Resume: `sleeping` or recoverable `failed` → lease → `booting` → restore/agent/schedule → `warm`.
- Resume failure: `failed`, recoverable only with current backup → destroy/retry.

Test every injected stage failure and preserve record/projection/schedule/thread-capture ordering. Use separate commits for create and resume.

### Chunk 9 — checkpoint, backup rotation, idle, and hard cap

#### 9A Checkpoint

Use scope finalizers around pause/resume. Preserve sequence:

1. persisted lease;
2. pause tmux process group;
3. filesystem `sync`;
4. immutable backup upload;
5. authoritative commit of new current/old current as previous;
6. projection;
7. best-effort deletion of formerly previous;
8. resume for manual snapshot;
9. lease release according to caller.

#### 9B Lifecycle

Migrate idle expiry, hard cap, stop, destroy retry, and thread capture. Preserve stale-payload rejection, 30-second operation grace, checkpoint-before-stop, `sleeping` only after successful stop, failed+destroy on hard-cap error, attached PTY not extending cap, cleanup-only `onStop`, and 12-attempt thread capture.

Use `TestClock`, fault injection, official callback canaries, and a shortened deployed cap.

### Chunk 10 — publish, beam-down, and vaporize

Use separate commits.

- **Publish:** full persisted lease, sentinel-only GitHub auth, clean/dirty worktree, private new repo, stored default branch, unchanged result.
- **Beam-down:** Effect archive preparation and validation, but preserve scope-transferred streaming; exact manifest/tar/checksum/path/ref/SHA/mode behavior.
- **Vaporize:** schedules → runtime → deduplicated backups → credential → KV projection → minimal `gone` tombstone. Define durable partial-progress/retry behavior before coding and test every failed stage.

### Chunk 11 — Effect-native CLI

Finish the one-model conversion by migrating asynchronous CLI transport, filesystem, process, browser, timeout, and install flows to Effect. Keep pure parsing/rendering as pure functions, not Promise code.

`main` is the single Bun/OS Promise boundary and folds typed failures to the exact existing stderr envelope and exit code. Preserve config precedence, non-TTY JSON, idempotency keys, timeouts, token URL non-disclosure, secure writes, archive verification, and CLI compile shape.

### Chunk 12 — cut over and remove the old model

After an Alchemy canary and one stable release:

- remove `worker/wrangler.jsonc` and Wrangler deploy/dev scripts;
- remove Hono and manual binding types replaced by Alchemy;
- remove compatibility shims and duplicate tests that no longer execute production paths;
- keep Cloudflare types/packages still required by the official Sandbox SDK and Alchemy build;
- document Alchemy login/profile, plan, deploy, stage, CI serialization, rollback, and destroy safety;
- keep submodule pins and source-first guidance.

## Testing and verification

### Local gate for every chunk

```sh
npm run fmt
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
git submodule status vendor/effect vendor/alchemy
npm ls effect @effect/platform-node alchemy @effect/vitest --all
```

Add a deterministic assertion that only Effect `4.0.0-beta.99` is resolved.

### Alchemy provider contract gate

The secret provider requires read/diff/reconcile/delete, no-op repeat, interrupted apply, failed apply, adoption, and state-encoding tests. The external Sandbox binding helper requires generated-plan, built-in provider, replacement, adoption, and deployed association tests.

### Adapter contract gate

Run the same contracts against fake and production implementations for DO storage, KV projection, R2/backup, credential vault, egress, Sandbox process/files/sessions, scheduler/lifecycle, and HTTP/RPC boundaries.

### Deployed canary

Every deploy requires user approval. Use an isolated stage/account first and run:

```text
up → attach → reconnect → snapshot → hard-cap sleep → resume → pr → down → vaporize
```

Verify:

- DO state and rotated credential survive host reconstruction;
- KV is non-secret and can lag without changing transitions;
- backup restore is correct and old backup deletion follows commit;
- container sees sentinels only;
- redirects/default deny prevent credential escape;
- stream/PTY scopes close correctly;
- vaporize leaves no Container, backup, credential, KV projection, schedule, or active lease;
- a second Alchemy plan is a no-op.

## Rollout and rollback

1. Build the binding helper and write-only secret provider; pass an isolated Sandbox SDK canary.
2. Adopt the current monolith and cloned non-production resources with no replacement/deletion or DO transfer.
3. Deploy the two-Worker Alchemy architecture to a shadow stage and run full E2E plus transfer/rollback rehearsal.
4. Cut one disposable production-like stage while keeping the existing Wrangler artifact as rollback.
5. Cut production only after plan review and explicit approval.
6. After one stable Alchemy-managed release, remove Wrangler/Hono rather than maintaining both.

Alchemy state has no proven stack-wide deploy lease. CI must serialize by stack+stage with `cancel-in-progress: false`; operators must not deploy the same stage concurrently from laptops.

## Risks and gates

### Blocking before implementation broadens

- **Binding feasibility:** external Sandbox DO ↔ Container metadata must work through Alchemy's public binding contracts or a pinned minimal upstream extension.
- **Secret non-persistence:** synthetic scan must prove real-value paths are absent from Alchemy state and telemetry.
- **Node engine:** use a runtime accepted by Alchemy's dependency graph.
- **Adoption:** first plan must not recreate/delete authoritative DO, R2, KV, Worker, or Container resources.
- **Sandbox parity:** generic Alchemy Container examples do not prove the official Sandbox SDK; the dedicated canary must.

### Decisions to settle in the named chunks

- Projection failure/retry policy without making KV authoritative (Chunk 4).
- Client abort versus durable operation interruption policy (Chunk 7).
- Scope/cancellation behavior for native PTY and tar streams (Chunks 7/10).
- Durable vaporize partial-progress representation (Chunk 10).
- Persistent resource retention semantics for Alchemy destroy (Chunk 2 before any destructive test).

## Source map

### Effect beta.99

- `vendor/effect/AGENTS.md`
- `vendor/effect/.patterns/effect.md`
- `vendor/effect/.patterns/testing.md`
- `vendor/effect/migration/`
- `vendor/effect/ai-docs/src/`
- `vendor/effect/packages/effect/src/`
- `vendor/effect/packages/effect/test/`

### Alchemy beta.63

- `vendor/alchemy/website/src/content/docs/cloudflare/compute/workers.mdx`
- `vendor/alchemy/website/src/content/docs/cloudflare/compute/durable-objects.mdx`
- `vendor/alchemy/website/src/content/docs/cloudflare/compute/run-a-container.mdx`
- `vendor/alchemy/website/src/content/docs/cloudflare/apis/effect-http-api.mdx`
- `vendor/alchemy/website/src/content/docs/infrastructure-as-code/custom-provider.mdx`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Worker.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerBridge.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObject.ts`
- `vendor/alchemy/packages/alchemy/src/Resource.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerPlatform.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerApplication.ts`
- `vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerProvider.ts`
- `vendor/alchemy/packages/alchemy/src/State/StateEncoding.ts`
- corresponding tests under `vendor/alchemy/packages/alchemy/test/Cloudflare/`

Pinned source and tests outrank docs and this packet when an API differs.

### Comparative only

- UsefulSoftwareCo/executor: service/layer boundaries, request resource ownership, typed errors, and Effect tests.
- `effect-cf@0.16.0`: event scopes and Cloudflare tests, but no dependency because Alchemy owns this integration.

## Definition of done

The conversion is complete only when:

- Alchemy is the sole Cloudflare infrastructure/deployment model;
- the API Worker, HTTP API, resources, services, errors, clocks, retries, and CLI async core are Effect-native;
- the official Sandbox subclass contains only mandatory host adapters over scoped Effects;
- a public Alchemy binding helper associates the external Sandbox DO/Container, and the custom secret provider writes secrets without plaintext state;
- DO storage remains authoritative and all untrusted/persisted data is schema-decoded;
- operation, credential, egress, backup, lifecycle, and destructive paths pass fault-injection contracts;
- no real credential appears in any forbidden surface, including Alchemy state;
- local checks and adapter contracts pass;
- the full deployed canary passes and a following Alchemy plan is a no-op;
- Wrangler, Hono, and duplicate manual binding/runtime code are removed;
- public HTTP, CLI, persistence, terminal, and security contracts remain compatible.

Until the deployed Alchemy canary passes, describe the work as planned or locally verified—not production proven.
