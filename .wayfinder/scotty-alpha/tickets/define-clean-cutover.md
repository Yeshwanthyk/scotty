---
title: Define the clean state and schema cutover
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the authoritative state model
  - Define the config and Plugin contract
  - Define the canonical Session lifecycle
  - Define the credential and login state machine
  - Define the Mirror, Fork, and Publish state machine
  - Define the trusted-runner parity contract
  - Define local state retention and cleanup
---

## Question

How must each implementation slice introduce its canonical contract and remove the Legacy, V2, V3, migration union, dead provider path, old command, or obsolete persisted state that it replaces before that slice may pass?

## Inherited lifecycle contract

The clean schema has only `provisioning`, `warm`, `stopped`, and `gone` as Session lifecycle states.
Failure and transition progress belong to operation and recovery records. Legacy `booting`,
`sleeping`, `failed`, and transition-specific state interpretations must not remain as parallel authority.

## Inherited repository contract

The canonical path is GitHub through the Scotty repository bridge to a verified Artifacts Mirror,
then one deterministic Fork and a provider-local sentinel broker. Direct Session GitHub clones,
global GitHub egress from compute, hidden Publish commits, inferred check commands, force-push,
real tokens in Session state, and parallel public-import product paths must be removed when their
replacement slice passes.

## Inherited spike disposition

Alpha removes `spikes/` completely. Proven secret-boundary providers move to their production
module, reusable contract tests move beside their owner, deployed canaries move to `e2e/canaries/`,
and lasting findings move to `docs/research/`. Superseded experiments, one-time migration code,
generated `.wrangler` state, the spike scaffold, and spike-only configuration are deleted. No
supported implementation, test, script, or package command may still depend on `spikes/`.

## Inherited credential cutover

The canonical boundary is one Account Secrets Store wrapping key, Credential-object ciphertext,
immutable Session generation grants, and typed provider-local brokers. Remove Config-owned real
environment values, required global-secret lists, static shared placeholders, direct credential
egress injection, dead vault code, raw Session env/file credentials, and tests that preserve those
paths. Promote the write-only key provider and canary before deleting `spikes/`.

## Inherited thin-Sandbox cutover

Remove hardcoded Pi provider, model, thinking, trust, and package settings; Codex config and the
Codex compaction package; direct Pi startup; `gh` and token Git helpers; automatic repository Pi
resources; legacy sandbox config and remote package installation; and parallel setup paths. The
canonical replacement is one allowed `pi` config object, one pinned snapshot, one RPC supervisor,
one built-in standard tool Plugin, and product-owned dormant Hatch and capture capabilities.


## Inherited local-state cutover

The alpha target uses only the XDG config, state, and cache roots. Remove `~/.scotty`,
`~/.scotty.json`, `~/.scotty/sandbox.json`, duplicate TUI/client stores, old secret locations,
adoption compatibility files, stale pending-up files, and Runner Session credential mounts. The
current unshipped development machine may discard all legacy local Scotty state and start fresh.
Do not ship a compatibility reader or retain a secret backup.


## Inherited trusted-Runner cutover

Remove production host-process execution, general `ExecRuntime`, arbitrary Runner image selection,
copied Codex and GitHub files, Session credential mounts, direct container Internet access, direct
GitHub bootstrap, the fixed-port mounted-HTTP stub, connection-as-readiness, and incomplete Runner
setup and removal paths. Host-process mode may remain only as a loopback development adapter and
must never become create-capable.

The replacement is the exact signed Docker release, typed Runner operations, certified capability
and light-health proof, orchestrator reservations, provider-host brokers, native Pi RPC, exact
Fork Git, Worker-streamed R2 checkpoints, same-Session Resume, outbound-link Hatch and capture,
the five-minute local control lease, proven removal, and explicit lost-host abandon. Runner-backed
Session creation stays disabled until this complete replacement passes its deployed canary.

## Resolution

Alpha uses a clean replacement, not a migration product. Current Scotty state is unshipped
development state. Implementation builds and proves the canonical system, clears the current
Scotty-owned development state, deploys a fresh Installation, and proves that fresh result. Scotty
does not ship a V2 or V3 reader, a dual-write period, a legacy mode, or a broad reset command.

External GitHub repositories, branches, pull requests, and human metadata are not Scotty
development state. The cutover preserves them. Cleanup may remove only resources whose Scotty
ownership is proven. An uncertain resource remains as explicit cleanup debt.

### Merge rule for each implementation slice

An implementation slice may merge only when the same pull request:

1. introduces one canonical contract and owner;
2. moves every in-scope caller, writer, reader, projection, command, and test to it;
3. proves the replacement with the smallest focused checks;
4. deletes the replaced schema, decoder, state interpretation, command, provider path, test, and
   compatibility helper; and
5. reports any later slice that still depends on a narrow canonical interface.

Temporary adapters may exist while an agent works on an unmerged branch. They may not land on the
integration branch. A feature flag, deprecation comment, unused export, compatibility decoder, or
test that preserves old behavior does not count as deletion. No slice may write both old and new
authority.

Agents should own complete vertical pull requests and their focused proof. They may choose code
structure inside the settled contracts. They must not preserve an old outcome merely to make a
partial pull request pass.

### Dependency order

Implementation proceeds in this order:

1. canonical shared schemas, state owners, operation envelopes, local paths, and strict decoders;
2. config, Plugin resolution, deployed snapshot activation, Auth, Credential, repository, and
   projection contracts;
3. canonical Session lifecycle and the Cloudflare host adapters, including Pi RPC, brokers,
   checkpoints, Hatch, capture, and cleanup;
4. trusted Runner host adapters against those same contracts; and
5. full provider canaries and the complete alpha release gate.

Cloudflare and Runner do not need to change in the same pull request when they depend on a stable
shared contract. Old Runner behavior is never a fallback. Runner-backed Session creation remains
disabled until the full deployed Runner parity canary passes. Alpha does not ship until both
offered providers pass their release gates.

### Required replacement families

The slices must leave exactly these canonical families:

| Area | Keep | Remove with its replacement |
|---|---|---|
| Session | `provisioning`, `warm`, `stopped`, `gone`, plus operation and recovery records | `booting`, `sleeping`, `failed`, transition states, migration unions, and legacy decoders |
| Configuration | one XDG private config, one normalized immutable deployed snapshot, one activation record | `.scotty` files, old sandbox schemas, hardcoded Pi choices, remote package sources, and parallel setup paths |
| Credentials | wrapping key, Credential ciphertext generations, immutable Session grants, typed brokers, memory-only sentinels | Config-owned secrets, global required-secret lists, raw env/file/argument credentials, static placeholders, and direct egress injection |
| Repository | GitHub bridge, verified Mirror, deterministic Session Fork, exact prepared Publish point | direct GitHub Session clones, `gh`, token Git helpers, hidden commits, inferred checks, force-push, and public-import side paths |
| Runtime | one supervised Pi RPC process, config-driven behavior, exact setup and image | direct Pi startup, a second shell authority, Codex CLI/config, hardcoded package and trust settings |
| Local state | canonical XDG roots, device identity credentials, secret-free hints, bounded disposable data | legacy roots, duplicate client/TUI stores, pending-up files, copied Runner credentials, and compatibility readers |
| Runner | certified Docker adapter, typed protocol, brokers, checkpoints, Hatch/capture relay, proven cleanup | production host process, generic host exec, arbitrary images, direct network, credential mounts, stub HTTP, and connection-as-readiness |
| Product surfaces | one executable, CLI/TUI, settled browser assets | desktop application, sidecar, old commands, old envelopes, and compatibility packaging |
| Experiments | production providers, owner-local contract tests, `e2e/canaries/`, retained research | the complete `spikes/` tree and every source, script, package, or config dependency on it |

Deleting a writer comes before declaring its old data irrelevant. Deleting a reader comes after no
canonical operation can produce the old shape. Projection stores are rebuilt from the new owners;
they are not migrated into authority.

### Development reset

The repository owns one guarded development-only reset script. It is not embedded in the released
Scotty executable. It must:

- require the exact Installation name and target account;
- inspect current resources and print a sanitized deletion plan;
- identify every resource by proven Scotty ownership rather than by a broad prefix alone;
- require explicit confirmation;
- revoke identities and stop mutation before deleting owned compute, Durable Object state,
  projections, R2 data, Artifacts Mirrors and Forks, Runner state, and legacy local state;
- preserve external GitHub repositories, branches, pull requests, and human metadata;
- verify each deletion or report the exact retained resource and safe next action; and
- be repeatable after interruption without treating absence as proof of an unrelated deletion.

The reset stores no credentials, workspace content, or secret-bearing backup. Before deletion it
may retain only a sanitized inventory and diagnostics needed to explain failure. There is no
rollback to the old product after authority is cleared. Recovery is retrying cleanup or deploying
the fresh canonical system.

### Cutover flow

```text
agent builds canonical slice
  -> focused local and contract proof
  -> all callers move
  -> old path and tests leave in the same pull request
  -> guarded disposable provider proof where needed

all slices ready
  -> print sanitized current-development reset plan
  -> explicitly confirm
  -> fence and clear proven Scotty-owned state
  -> verify absence or report retained cleanup debt
  -> deploy one fresh canonical Installation
  -> run Cloudflare and Runner canaries
  -> run the complete alpha release gate
```

Every cutover and deployment result uses the common staged error envelope. It names the failed
stage, exact target, last proven effect, retained state, ambiguity, safe retry, and required human
action. A partial reset, ambiguous provider result, failed deployment, stale projection, missing
cleanup proof, or failed canary is a failure. Scotty never reports a successful cutover because the
old control plane is merely unreachable.

This decision defines implementation acceptance and destructive development cleanup. It does not
perform that cleanup or implement product code.

## Decision trail

- Use a clean reset for unshipped Scotty development state.
- Preserve external GitHub repositories, branches, pull requests, and human metadata.
- Require replacement, caller movement, proof, and deletion in the same implementation pull
  request.
- Let temporary adapters exist only on unmerged working branches.
- Build shared contracts first, Cloudflare adapters second, and trusted Runner adapters third.
- Keep Runner creation disabled until its full deployed parity proof passes.
- Use one guarded repository-only reset script, not a shipped broad reset command.
- Verify absence and report exact cleanup debt instead of claiming success from ambiguity.
