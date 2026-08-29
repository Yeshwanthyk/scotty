# Unified credential registry and grant-based egress

## Orientation

Scotty currently has three credential paths: `scotty init` uploads GitHub as `GH_TOKEN`, `scotty auth sync` writes Pi credentials into SandboxConfig, and every Session Durable Object stores another plaintext Pi/GitHub copy. Containers receive random sentinels, and egress resolves those sentinels through the Session vault.

Replace that with one operator and authority model:

```text
TOML declares named local sources and global/exact-repository scope
  -> scotty sync validates every source before remote mutation
  -> one installation Credential Registry DO stores encrypted values
  -> new Session receives all global grants plus exact-repository grants
  -> Session stores non-secret references and managed handles only
  -> unchanged Pi and Git use fixed non-secret compatibility handles
  -> egress validates source Container, grant, repository, destination, and placement
  -> Registry decrypts the real value only for the bounded upstream request
```

Cloudflare OS is the conceptual reference: account objects own credentials and agents receive scoped capabilities rather than tokens. Scotty cannot require typed Gatekeeper RPC from unchanged Pi and Git, so grant-aware egress is its compatibility Gatekeeper. See [`../research/cloudflare-os-credential-architecture.md`](../research/cloudflare-os-credential-architecture.md).

## Settled decisions

1. A dedicated installation-scoped `ScottyCredentialRegistry` Durable Object is the sole owner of provider credentials.
2. `init` generates one 32-byte installation wrapping key and uploads it directly as `CREDENTIAL_WRAPPING_KEY`; the key never enters Alchemy props, state, outputs, ordinary config, or API output.
3. Credential values are encrypted with authenticated encryption before DO persistence.
4. TOML contains names, source pointers, kinds, and scope policy, never values.
5. Initial kinds are `pi-auth` and `github-cli`. Generic environment, Sentry, Datadog, SSH, signing, and plaintext materialization are deferred.
6. `scope = "global"` grants the credential to every new Session.
7. `scope = "repository"` requires a non-empty list of exact canonical `owner/repository` identities. No wildcard or inferred identity exists.
8. `scotty sync` is the only credential ingestion command. It replaces the desired current value/policy for new Sessions.
9. Removing a credential declaration and syncing prevents new grants. Existing Sessions retain their starting grants.
10. Existing Sessions, including sleep/resume, retain the credentials selected at creation. There is no live reseed or rebind workflow.
11. Internal immutable versions may preserve existing Sessions, but versions are not an operator-facing concept.
12. Session DO persistence contains only grant references, managed handles, and non-secret operation metadata.
13. Containers receive fixed non-secret managed handles, not real credentials and not random secret sentinels.
14. Egress requires both a managed handle and the current source Container identity. It never injects a credential from origin alone.
15. `scotty creds` directly lists redacted name, kind, scope, and configured state. There is no `creds list`, status, revoke, or delete command.
16. `scotty doctor` owns config/readiness diagnosis. The `config` and `auth` command groups are removed after compatibility drain.
17. `init` stops reading GitHub credentials. `PI_AUTH_JSON` and `GH_TOKEN` provider bindings are removed after legacy Sessions drain.
18. Root/browser credentials remain separate control-plane authorities.
19. Deployment is not authorized by this plan. Run the guarded deployment only after all local proof passes and the user explicitly approves it.

## Target TOML

```toml
version = 1

[sync]
skills = ["~/.pi/agent/skills"]
packages = []
tools = []
extensions = []

[credentials.openai]
kind = "pi-auth"
source = "~/.pi/agent/auth.json"
scope = "global"

[credentials.github]
kind = "github-cli"
scope = "repository"
repositories = [
  "owner/service",
  "owner/another-service",
]

[repos]
allowed = ["owner/service", "owner/another-service"]
```

Rules:

- credential names are unique, bounded identifiers;
- `pi-auth` requires one private regular non-symlink source file;
- `github-cli` has no value or command in TOML; its adapter invokes the existing bounded local GitHub CLI path;
- `global` forbids `repositories`;
- `repository` requires at least one exact repository;
- repository credential scope must be a subset of `[repos].allowed`;
- config/doctor validation does not read credential values;
- sync reads only declared sources and reads all of them before any remote mutation.

## Target state ownership

### Credential Registry DO

Owns:

- encrypted named credential versions;
- current desired credential set and scope policies;
- Session-to-version grants;
- OAuth refresh serialization and rotation for a pinned Pi credential;
- release and garbage collection of versions no Session references.

It never owns:

- Session lifecycle or operation leases;
- Session sentinels/handles as secrets;
- repository registration;
- browser/root credentials;
- bundle archives or active bundle selection.

### Session Sandbox DO

Owns:

- Session record and operation lease;
- non-secret grant projection `{ name, kind, versionRef, handleSlots }`;
- lifecycle ordering and release retry state;
- container runtime and backup lifecycle.

It stores no provider credential value.

### Container

Receives only non-secret compatibility projections, for example:

```text
Pi API key: scotty-managed://openai/openai/api-key
Pi OAuth access: scotty-managed://openai/openai-codex/access
Pi OAuth refresh: scotty-managed://openai/openai-codex/refresh
Git password: scotty-managed://github/git-https
```

If Pi requires a JWT-shaped identity token, use a deterministic synthetic token whose payload identifies the managed handle. It remains non-secret.

### Egress

For every credentialed request:

1. derive the source Session from trusted Container SDK context;
2. sanitize ambient authorization/proxy/forwarding headers;
3. decode a supported managed handle only from the adapter's exact placement;
4. require the Session's pinned grant for that name and slot;
5. require the exact canonical repository when the grant is repository-scoped;
6. require the adapter's exact HTTPS origin, path policy, method policy, and redirect policy;
7. ask the Registry to resolve the pinned value transiently;
8. inject only into the declared header/body field for the upstream request;
9. sanitize provider responses where OAuth/native compatibility requires it.

A copied handle has no authority in another Session because source identity and the Session grant are mandatory.

## Failure behavior

- Invalid TOML or any missing/malformed local source fails before bundle or credential remote mutation.
- A missing/malformed wrapping key fails closed; there is no plaintext fallback for Registry records.
- Registry corruption, authentication-tag failure, unknown handle, missing grant, repository mismatch, or destination mismatch returns a typed sanitized failure.
- No error contains local source contents, provider values, wrapping key, ciphertext, or synthetic test canaries.
- Sync is idempotent for unchanged bundle and credential contents.
- If bundle and credential publication cannot be one transaction, prepare both locally first, make both remote writes idempotent, report partial completion explicitly, and make retry converge. Never claim atomicity that the authorities do not provide.
- Existing legacy Sessions remain on their legacy vault until vaporized. New Sessions never fall back to legacy provider secrets after the Registry is active.
- Vaporize releases Registry grants as owned cleanup. Interrupted release retains retry state; success is not reported while the Session grant remains owned.

## Production paths

### Synchronization

```text
scotty sync
  -> load/decode TOML
  -> build deterministic non-secret bundle
  -> read and decode every declared credential source
  -> inspect managed installation before secret read where required
  -> publish desired encrypted credential set to Registry
  -> publish/activate bundle
  -> return redacted bundle + credential summary
```

### Session creation

```text
POST /api/sessions
  -> authorize repository
  -> Registry issues global + exact-repository grants for Session ID
  -> arm hard cap and commit existing Session authority ordering
  -> persist non-secret Session grant projection
  -> materialize bundle and managed handles
  -> start/health-check Pi
  -> commit warm
```

### OpenAI request

```text
Pi managed handle
  -> Container outbound interception
  -> source Session identity
  -> Session grant validation
  -> exact OpenAI/ChatGPT/OAuth route policy
  -> Registry decrypts pinned value transiently
  -> upstream request
  -> sanitized response
```

### Git HTTPS request

```text
Git credential helper returns managed handle
  -> source Session identity
  -> GitHub grant validation
  -> exact owner/repository URL validation
  -> Registry decrypts pinned GitHub value transiently
  -> upstream Git request
```

### OAuth refresh

Refresh mutates the credential version already pinned by the Session; it does not move the Session to a newer administrative sync version.

```text
begin refresh for { session, versionRef, provider, nonce }
  -> one Registry-owned refresh operation
  -> exact auth.openai.com token request
  -> authenticated encrypted update of pinned version
  -> idempotent nonce result
  -> sentinel-shaped/managed-handle response to Pi
```

Persistence completes before the sanitized response. Concurrent refreshes collapse or fence; stale completion cannot overwrite current state.

## Implementation stages

### Stage 1 — Global Pi/OpenAI Registry path

**Behavior delivered**

- New installs have a wrapping key and Credential Registry binding.
- Existing installs can provision the missing key exactly once through an explicit migration-aware deployment path; deploy never rotates an existing key.
- TOML can declare one or more `pi-auth` credentials.
- `scotty sync` publishes the encrypted desired credential set.
- New Sessions pin global Pi grants and use managed handles through existing OpenAI/ChatGPT/OAuth egress behavior.
- Legacy Sessions continue using the old vault.

**Primary files and symbols**

- `protocol/credentials.ts` — names, kinds, scopes, handles, grants, redacted metadata.
- `worker/src/credential-contracts.ts` — encrypted envelopes and Registry RPC schemas.
- `worker/src/credential-crypto.ts` — wrapping-key decode, HKDF/AES-GCM/HMAC primitives adapted from historical commit `1637c182` after current Effect-source verification.
- `worker/src/credential-store.ts` — current values, internal versions, Session grants, refresh operations.
- `worker/src/credential-object.ts` — `ScottyCredentialRegistry`.
- `worker/src/bindings.ts`, `worker/wrangler.jsonc`, `infra/cloudflare-stack.ts` — `CREDENTIALS` DO and inherited `CREDENTIAL_WRAPPING_KEY` name.
- `cli/src/commands.ts`, `cli/src/scotty-config-contracts.ts`, `cli/src/scotty-config.ts`, `cli/src/pi-auth.ts` — init/sync/config ingestion.
- `worker/src/session.ts`, `worker/src/container-auth.ts`, `worker/src/egress.ts` — new-session grants and Pi handle resolution.

**Verification**

- schema/config/source boundary tests;
- crypto round-trip, random IV, AAD mismatch, wrong/missing key, ciphertext leak scan;
- Registry idempotency, replacement, removal-for-new, grant pinning, release, stale refresh fencing;
- new Session grant projection contains no plaintext;
- existing legacy Session remains functional;
- OpenAI API-key and OAuth request/refresh tests preserve status and sanitized responses;
- focused CLI/Worker typechecks and tests, format, lint-skills, leak scan.

**Stop conditions**

- wrapping key enters Alchemy state/config/output;
- real value enters Session storage or Container state;
- request injection occurs without both handle and trusted source Session grant;
- public Session routes or error envelopes change unintentionally;
- a new Session silently falls back to `PI_AUTH_JSON` after Registry activation.

### Stage 2 — Repository-scoped GitHub path

**Behavior delivered**

- TOML declares a `github-cli` credential as global or exact-repository scoped.
- `scotty sync` reads GitHub locally and stores it in the Registry.
- Repository verification and new Session creation use the matching Registry credential.
- Git helper emits only a managed handle.
- GitHub egress enforces exact granted repository before substitution.
- `init` stops reading/uploading GitHub credentials for new installations.

**Primary files and symbols**

- Stage 1 credential contracts/store/object and TOML source union.
- `cli/src/commands.ts` `init`, `sync`; `cli/src/dependencies.ts`/services for bounded GitHub source read.
- `worker/src/repo-verifier.ts`, `worker/src/session.ts` create path.
- `worker/src/workspace.ts`, `worker/src/container-auth.ts` Git helper projection.
- `worker/src/egress.ts` GitHub route/repository enforcement.
- `infra/cloudflare-stack.ts` and deployment services for eventual `GH_TOKEN` removal.

**Verification**

- global and multiple exact-repository scopes;
- disallowed repository rejected before Sandbox allocation;
- exact Git smart-HTTP paths accepted, neighboring repo rejected;
- remote URL/config/argv/env contain no real token;
- deterministic fixture clone/push with independent verification in the real proof stage;
- init no longer invokes GitHub credential acquisition for new installations.

**Stop conditions**

- repository registration is treated as credential authorization;
- broad github.com origin injection occurs without exact repository parsing;
- token enters Git URL, Git config, arguments, logs, or Container files.

### Stage 3 — CLI collapse and legacy drain

**Behavior delivered**

- Public surface is `scotty init`, `scotty sync`, `scotty creds`, and `scotty doctor` for installation/config/credential management.
- `scotty creds` lists redacted metadata directly.
- `doctor` reports invalid config, missing wrapping-key binding, Registry readiness, and legacy Session count.
- `config` and `auth` command groups are removed.
- `PI_AUTH_JSON`, `GH_TOKEN`, SandboxConfig Pi authority, and legacy Session vault code are removed only after every non-gone legacy Session is vaporized.

**Primary files and symbols**

- `cli/src/commands.ts` command tree and output.
- CLI command-tree, integration, lab, docs, and completion tests.
- `worker/src/index.ts` legacy auth routes.
- `worker/src/installation-pi-auth-store.ts`, `worker/src/credential-vault.ts` legacy stores.
- `worker/src/bindings.ts`, `infra/cloudflare-stack.ts`, deploy/install/uninstall secret lifecycle.
- `README.md`, `e2e/README.md`, lab scripts and scans.

**Verification**

- removed command parser errors and preserved exit/error envelope conventions;
- redacted `creds` and doctor outputs;
- no production references to legacy provider bindings/stores/routes;
- current Session create/resume/snapshot/vaporize and Registry release tests;
- full repository gates and compiled CLI.

**Stop conditions**

- any legacy non-gone Session can still require removed state;
- deployment can remove provider secrets before legacy drain;
- root/browser credentials are conflated with provider credentials.

### Stage 4 — Browser and real Sandbox proof

This follows Q5 browser work rather than preceding it.

**Behavior delivered**

- Browser creates/opens a real Session, sends a prompt, receives a real model response, and displays the settled thread.
- The same Session clones and pushes an exact granted disposable repository.
- Wrong-repository access fails.
- Snapshot/resume retains the Session's original grants.
- Vaporize removes Session-owned grant references and compute.

**Verification**

- focused browser projection/transport tests;
- real local Sandbox flow with strict provider response classification;
- container env/files/args/Git config scans for real credentials;
- independent Git remote verification;
- lifecycle cleanup and no remaining owned grant;
- full local gates.

A guarded deployed canary follows only after explicit user approval.

## Verification matrix

| Boundary        | Required proof                                                                          |
| --------------- | --------------------------------------------------------------------------------------- |
| TOML            | strict decode, scope/repository rules, no value reads during doctor                     |
| Local sources   | private Pi file, bounded GitHub CLI adapter, no argv/log exposure                       |
| Wrapping key    | direct secret upload, no Alchemy state/config/output, no rotation on deploy/recover     |
| Crypto          | authenticated round-trip, random IV, AAD, wrong-key failure, no plaintext serialization |
| Registry        | desired-set replacement/removal, internal pinning, release/GC, corruption failure       |
| Session         | non-secret projection, create ordering, resume pin, vaporize release retry              |
| Container       | only managed handles, no real values in files/env/args/Git config                       |
| OpenAI egress   | handle + source grant + exact route, API key, OAuth refresh ordering                    |
| GitHub egress   | handle + source grant + exact repository, clone/push, neighboring denial                |
| CLI             | simple command tree, redacted outputs, existing envelope/exit conventions               |
| Lab/browser     | real Sandbox, strict model result, exact-repo Git proof, cleanup                        |
| Full repository | format, lint-skills, lint, typecheck, tests, scan, compiled CLI                         |

## Rollout

1. Land Stage 1 with compatibility reads for existing legacy Sessions and Registry-only writes for new Sessions.
2. Land Stage 2 and stop creating new Worker-secret-backed GitHub Sessions.
3. Run doctor to enumerate legacy Sessions; vaporize them through normal lifecycle.
4. Land Stage 3 only when no non-gone Session depends on legacy authority.
5. Complete Q5 browser work.
6. Run Stage 4 local real-Sandbox proof.
7. Present the exact guarded deployment command, target installation, diff, checks, and cleanup plan to the user.
8. Deploy only after explicit approval; run the deployed canary and verify the next deployment plan is a no-op.

## Risks

- Pi native credential formats may require deterministic synthetic token shapes beyond a simple URI handle. Keep them non-secret and adapter-owned.
- Git smart-HTTP path parsing must cover the exact protocol paths without broadening to unrelated repositories.
- Bundle and credential publication are separate authorities; retry convergence must be truthful when one succeeds and the other fails.
- Existing Sessions force a temporary dual runtime path. Do not remove legacy code based only on KV projection without checking authoritative Session state.
- The dedicated Registry changes DO topology and migration. Alchemy remains the only resource reconciler.
- The wrapping key is intentionally unrecoverable from ordinary config. Losing it requires resynchronizing credentials; never replace it silently.

## Open decisions

No product-shape decisions remain for Stages 1–3. Implementation may stop for discussion if pinned Effect/Alchemy source disproves an assumed API, Pi cannot operate with a non-secret managed handle, exact Git repository parsing cannot be bounded, or a safe one-time wrapping-key migration for existing installations cannot be demonstrated.

Deployment target, timing, and authorization remain explicitly open until local Stage 4 proof passes.
