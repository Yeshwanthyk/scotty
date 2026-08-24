---
title: Define the credential and login state machine
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the authoritative state model
  - Prove the Cloudflare Artifacts Git path
  - Choose the GitHub–Artifacts bridge and Session Git boundary
---

## Question

How do Pi login, private configuration, deployed credential state, Session grants, Artifacts access, rotation, revocation, and readiness fit into one safe state machine without exposing real credentials to Session compute?

## Inherited state contract

Account Secrets Store owns the Installation wrapping key. The Credential object owns ciphertext,
generation metadata, and credential operations. Config owns only the sanitized Pi seed and Plugin
requirements. Each Session owns its immutable generation grant, sentinel, and vault. Every brokered
use checks the pinned generation, grant, provider binding, and runtime epoch freshly. Real
operation-bound provider tokens remain outside Session compute.

## Resolution

Scotty uses one general Installation credential registry. It is not limited to Pi and GitHub.
Administrators may create stable installation-local names such as `sentry`, `datadog-prod`, or
`npm-publish`. Names are never inferred from a provider account, username, machine, or repository.

Two names are reserved:

- `pi` is the one Installation Pi login and uses either an API key or Codex OAuth; and
- `github` is the one Installation GitHub login used for private Mirror refresh and Publish.

Every credential uses the same generation, encryption, grant, broker, failure, and cleanup
contract. Credential use still requires a typed delivery adapter; storing an opaque value does not
give Session compute raw access to it.

### Secret boundary and authority

Cloudflare Account Secrets Store cannot be the whole runtime credential authority. Its Worker
binding reads one fixed secret name, cannot look up arbitrary generations, and cannot write OAuth
refresh state at runtime. Scotty therefore uses this smallest complete boundary:

- Account Secrets Store owns one fixed wrapping key per Installation;
- one installation-scoped Credential Durable Object owns encrypted credential generations,
  metadata, current-generation pointers, operations, validation evidence, and cleanup; and
- provider-local brokers hold decrypted values only for one logical provider operation or stream.

Account Secrets Store contains no Pi, GitHub, or custom user credential value. The Credential
object contains ciphertext, not plaintext at rest. Config contains only the sanitized Pi seed and
Plugin credential requirements. Session records contain generation references, a grant, and a
sentinel, not real values.

The wrapping-key binding name and Account Secrets Store secret name are exact and namespaced by
immutable Installation identity. Several Installations may share the account-level store safely.
Installation deletion removes only its exact wrapping key after every owned ciphertext and
reference is gone. It never deletes the account-wide store or discovers cleanup targets by loose
prefix.

### Credential records and generations

Each credential record contains:

- its administrator-chosen name;
- one typed delivery adapter and non-secret policy;
- a current generation pointer for future Sessions;
- encrypted retained generations with opaque generation IDs, keyed digests, auth kind, scope,
  target policy, expiry metadata, validation evidence, and reference state; and
- one operation record with idempotency key, phase, last proven effect, retry state, and result.

Credential operations are Create or Login, Import, Replace, Remove-for-future, OAuth Refresh,
Validate, Retire generation, and Cleanup. These are operations, not a large credential lifecycle
enum. Usability is derived freshly as `ready`, `blocked`, `unavailable`, `stale`, or
`not_configured`.

Create, Import, or Replace receives the plaintext only through protected authenticated input. It
encrypts and persists a candidate generation, validates it through its typed adapter, and only then
atomically changes the current pointer for future Sessions. A crash before pointer activation
leaves the prior current generation unchanged. The candidate remains explicit orphan or retry
state; Scotty never guesses activation.

Remove-for-future clears the current pointer. It does not delete a generation still referenced by
a Warm or Stopped Session or open Publish. A generation may be deleted only after exact reference
checks prove that no active owner needs it.

### Pi and GitHub login

Scotty reuses Pi's login behavior. The administrator may run Pi API-key or Codex OAuth login
through the Scotty CLI, or explicitly import one existing local Pi login after Scotty shows its
provider and sanitized subject and receives approval. Scotty does not silently discover or import
local logins.

The Config-owned Pi seed contains only the auth kind, provider, sanitized display metadata, and
sentinel-shaped Pi auth descriptor. It contains no usable secret, ciphertext, wrapping-key
coordinate, or Account Secrets Store reference. Session materialization creates only the sanitized
descriptor for the pinned `pi` generation.

GitHub authentication is established by explicitly importing the selected GitHub CLI login after
account and permission checks, or by entering a fine-grained personal access token through
protected input. Alpha does not build a second GitHub OAuth application and does not use an
environment `GH_TOKEN` as durable authority.

The GitHub adapter validates the required private-source read and controlled branch and pull
request permissions. Public anonymous refresh does not consume the credential, but a freshly
usable `github` credential remains part of the settled Installation readiness contract.

Local Pi and GitHub source logins remain owned by their original tools. Scotty imports a copy with
explicit approval and never deletes or rewrites the source login. Local operation journals retain
only digests, operation IDs, and sanitized results.

### Future-Session generation rule

At Create, every Session pins the current generation of:

- `pi`;
- `github`;
- each credential required by its selected Plugin setup; and
- each additional credential the administrator explicitly selects.

The Session grant and generation set are immutable until Vaporize. Administrator Create, Replace,
or Remove operations affect future Sessions only. Existing Sessions never switch generations,
gain a new credential, lose a pinned credential, or reactivate from an Installation credential
change.

There is no standalone live Session-grant edit or revocation in alpha. To end credential access for
an existing Session, Vaporize it. Stop and Resume fence runtime epochs but preserve the immutable
grant and pinned generations. Vaporize permanently ends the grant and releases generation
references after any open Publish settles.

If a pinned API key, GitHub credential, or custom credential expires or is revoked by its external
provider, Scotty blocks that Session's affected operation with a typed result. It never switches to
the Installation's newer generation. This future-Session rule intentionally supersedes the earlier
decision that administrator rotation and revocation apply live to existing Sessions.

Codex OAuth refresh is maintenance inside a pinned generation, not administrator replacement. One
Credential-owned refresh operation serializes concurrent requests for that generation. It writes
and encrypts the new OAuth state, atomically commits it to the same generation, and only then lets
the sanitized model response proceed. Waiting requests use the committed state. An expired token
or failed refresh is never used as fallback.

### Custom credential requirements

A validated Plugin manifest may declare a non-secret credential requirement with a requirement
ID, adapter, and target scope. The administrator binds that requirement to a named credential in
the Credential object. Neither the private config nor deployed snapshot contains the value or a
usable secret reference.

Session Create pins the bound generation. A missing, incompatible, expired, or unusable required
credential blocks that Session route with a typed result. An unused optional custom credential
does not make the whole Installation not Ready; its Plugin capability reports `not_configured` or
`blocked` independently.

All custom replacement follows the same future-Session rule. Generic custom credentials have no
automatic refresh in alpha. External expiry blocks the pinned operation.

### Delivery adapters and broker authorization

Alpha provides four delivery adapters:

- Pi model requests through the provider-local model broker;
- GitHub refresh and Publish through the control-plane repository bridge;
- Artifacts Git through the provider-local Session Git broker; and
- generic scoped HTTPS-header injection through the provider-local HTTP broker.

A generic HTTPS policy names exact HTTPS origins, an explicit header, and an optional value prefix.
The broker does not forward credentials across redirects. It rejects plaintext HTTP, wildcard
hosts, undeclared origins, URL-query injection, cookies, body rewriting, and unsafe header targets.

Credentials for protocols such as AWS signing, SSH agents, databases, or arbitrary TCP may be
stored, but they cannot be granted until a product-approved host-side adapter with its own scope and
proof exists. Alpha returns `unsupported_credential_adapter`; it never falls back to raw secret
injection into Session environment or files.

For every brokered operation, the provider host proves the assigned Session, immutable grant,
current Warm runtime epoch, pinned credential generation, adapter, requested target, and scope. The
Credential object decrypts only that generation. The broker retains plaintext only for that
logical operation or stream, then clears it. It does not cache real values for a runtime epoch or
Session lifetime.

The stable Session sentinel lives in the Session vault and is materialized only to the authenticated
provider host and protected helper or protocol. Sentinel alone is useless without the current
provider-broker and runtime-epoch binding. It is excluded from checkpoints, projections, logs, API
output, Git config, process arguments, and repository files.

Real credentials never enter container environment or files, Session process arguments, logs, Git
config, KV, R2, API responses, Alchemy props, outputs, or state. Provider operation tokens also
remain outside Session compute.

### Deployment and readiness

Deployment discovers the account's single Account Secrets Store or proposes explicit creation when
none exists. It writes one Installation wrapping key through Scotty's write-only custom provider,
binds only that key, deploys the Credential object, and proves encryption and decryption with
synthetic material. Deployment retains the account-level store during Installation cleanup.

The Account Secrets Store provider, production binding, and canary must move out of `spikes/` under
the approved spike disposition. No user credential may flow through Alchemy planning or resource
state.

Installation readiness freshly proves:

- the wrapping-key binding and Credential object are usable;
- the current `pi` generation is usable;
- the current `github` generation has required permissions;
- the Cloudflare model, HTTP, Git, and Artifacts broker paths are usable; and
- at least one complete new-Session route has every required Plugin credential binding.

Optional custom credentials report independently. Cached validation never authorizes Create,
Resume, model use, Git, Publish, or generic HTTPS access.

### Failure and recovery results

Every Deploy, Login, Import, Replace, Remove-for-future, Refresh, Validate, Broker, Retire, and
Cleanup result reports:

- stable operation ID, target, and credential name or sanitized generation ID;
- exact stage and typed code;
- last proven effect and retained valid state;
- any ambiguous provider state;
- whether retry is safe and the exact retry point;
- required human action; and
- a sanitized cause.

Credential and deployment stages include `validate`, `preflight`, `plan`, `prepare`, `apply`,
`activate`, `verify`, `receive`, `encrypt`, `persist_candidate`, `validate_provider`,
`activate_for_future`, `refresh_oauth`, `resolve_generation`, `authorize_broker`, `inject_request`,
`retire_generation`, and `cleanup`.

Failure never returns a real value, wrapping key, ciphertext, provider token, unsafe URL, secret
header, or raw provider body. It never rolls back or reports success from an ambiguous external
write. Missing wrapping keys, ciphertext, pinned generations, or Session sentinels are typed
corruption and block use rather than triggering silent recreation.

### Proof boundary

Deterministic tests must cover encryption ownership, candidate activation, concurrent operations,
future-only replacement, retained generations, OAuth refresh commit and crash recovery, exact
reference cleanup, Pi and GitHub import approval, Plugin requirement binding, Session grant pins,
old runtime epochs, sentinel misuse, broker target and scope enforcement, redirect denial, custom
adapter rejection, provider expiry, secret-store outage, Credential-object reconstruction, and the
complete staged failure envelope.

The guarded deployed canary must prove the real Account Secrets Store wrapping-key binding,
write-only key provisioning, Credential-object ciphertext, API-key and Codex OAuth broker use,
private GitHub refresh and Publish, generic HTTPS-header injection, provider-local behavior on
Cloudflare and trusted runners, future-Session generation isolation, cleanup, and absence of real
credentials from every forbidden surface.

## Refined local credential boundary

Scotty-owned local raw credentials are limited to root recovery, the current paired-terminal
client, and a Runner's separate registration identity. Pi, GitHub, and custom credential plaintext
streams through memory into the guarded Credential-object operation and is not staged in an alpha
product file. Local journals retain only keyed digests and sanitized operation facts. The current
development machine may use a private temporary file only as an unshipped exception.
