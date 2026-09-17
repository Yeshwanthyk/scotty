# OpenClaw and Scotty: security and operations comparison

## Scope, provenance, and evidence labels

**Supersession notice.** The previous report used a stale OpenClaw snapshot. Its OpenClaw claims
and line references are withdrawn. This revision uses only the parent-supplied archive:

`/tmp/openclaw-provenance.8W7wWd/openclaw-openclaw-1482bf1/`

The archive was downloaded from GitHub for OpenClaw commit
`1482bf19a763acc59470faf3425b3cf559018b2c`. All OpenClaw paths and line ranges below were
rechecked against that archive. Scotty was checked in the working tree at
`709f04e3c8720021fe1073ce8ffd61cfa712ccb2`.

Evidence labels:

- **Source:** shipped implementation or configuration.
- **Docs/design:** repository-owned behavior or operating assumptions.
- **Test:** executable test or harness code; it does not prove that the test ran or passed.
- **Deployed proof:** a result artifact from a real deployment. No such result is asserted here.

The comparison treats Scotty's stronger credential, tenant, and egress isolation as a constraint.
OpenClaw's trusted-host features are not Scotty gaps when adopting them would weaken that boundary.

## Executive findings

| Area           | OpenClaw                                                                                                                                                                                                        | Scotty                                                                                                      | Evidence-grounded reading                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Trust boundary | One trusted operator or mutually trusting team per Gateway; adversarial users require separate Gateways/hosts. Host exec and sandbox-off are documented defaults.                                               | Per-session Sandbox Durable Object is authoritative; repository code and containers are untrusted subjects. | Different threat models. Do not import OpenClaw's host-trust defaults into Scotty.            |
| Pairing/auth   | Shared Gateway credentials authenticate a trusted operator; device pairing adds role/scope-bearing device tokens.                                                                                               | Root bearer is separate from digest-backed browser credentials and owner epoch state.                       | Scotty preserves a stronger root/browser separation.                                          |
| Credentials    | SecretRefs and sentinels reduce exposure but remain optional; the shared store is plaintext SQLite at rest.                                                                                                     | Registry values are encrypted; containers receive managed handles, not provider values.                     | Keep Scotty's mandatory isolation.                                                            |
| Sandbox/egress | Docker sandbox defaults are strong when enabled, but sandbox mode is off by default. Secret egress is destination-bound and the traffic allowlist is only defense in depth for clients honoring proxy settings. | Static allowlisted egress and session-derived credential resolution reject ambient authority.               | OpenClaw offers useful diagnostics and deployment choices, not a universal deny-all boundary. |
| Approvals      | Rich host/node policy and approval UX; trusted full/off defaults remain documented.                                                                                                                             | Inner Codex is deliberately no-prompt/full-access inside Scotty's outer controls.                           | Keep control-plane gates separate from model-mediated approvals.                              |
| Diagnostics    | Security audit and structured Doctor lint provide strong operator explanation.                                                                                                                                  | `doctor` and redacted installation diagnostics are narrower.                                                | Read-only explanation is the clearest transferable capability.                                |
| Test evidence  | Local WebSocket/Docker tests and workflow definitions were found. No run result was found in the supplied archive.                                                                                              | Local/deployed canary definitions exist. No current canary result is claimed.                               | Definitions are not proof of a passed deployment.                                             |

## 1. Trust model and sandbox

### OpenClaw

**Docs/design.** OpenClaw documents one trust boundary per Gateway, says that authenticated Gateway
callers are trusted operators, treats `sessionKey` as routing rather than authorization, and directs
adversarial users to separate Gateways and preferably separate OS users/hosts
(`docs/gateway/security/trust-model.md:11-21`, `docs/gateway/security/trust-model.md:60-68`). Its
security policy describes host-first exec, `agents.defaults.sandbox.mode: "off"`, and implicit
`tools.exec.host: "auto"` falling back to the Gateway when no sandbox is active
(`SECURITY.md:131-153`).

**Source.** Docker sandbox resolution defaults the root filesystem read-only, mounts tmpfs, uses
network `none`, and drops all capabilities (`src/agents/sandbox/config.ts:104-115`). The effective
sandbox mode defaults to `off` and workspace access to `none`
(`src/agents/sandbox/config.ts:246-252`). `host` networking is blocked, and `container:*` namespace
joins require explicit opt-in (`src/agents/sandbox/network-mode.ts:17-31`).

### Scotty

Scotty assigns authority to the per-session Sandbox Durable Object; KV is a non-secret projection,
R2 stores immutable data, and the container owns neither session state nor real credentials
(`README.md:104-106`). The reserved container-to-session origin rejects credential, source-identity,
proxy, and Scotty-prefixed ambient headers (`worker/src/egress/session.ts:48-70`,
`worker/src/egress/session.ts:164-181`). Its `ContainerProxy` dispatches the reserved host itself
(`worker/src/egress/session.ts:141-158`).

### Comparison

OpenClaw is a personal-agent Gateway with a trusted host/operator boundary. Scotty is a cloud
service with an untrusted execution subject. OpenClaw's host execution and default-off sandbox are
therefore unsuitable Scotty defaults. Scotty should preserve session-scoped authority, a
non-authoritative container, and fail-closed internal routing.

## 2. Pairing and authentication

### OpenClaw

**Source.** Token and password authentication use constant-time comparison; missing credentials do
not consume a failure slot, while mismatches are rate-limited
(`src/gateway/auth.ts:318-373`). Shared-secret HTTP authentication restores the normal default
operator scopes, and narrower `x-openclaw-scopes` headers do not reduce that shared-secret path
(`src/gateway/http-auth-utils.ts:704-742`). The default set includes admin, read, write,
approvals, pairing, and talk-secret scopes (`src/gateway/method-scopes.ts:43-52`).

Pending device records carry a device ID and public key; persisted paired records can carry
role/scope-bearing `DeviceAuthToken` values (`src/infra/device-pairing.types.ts:10-49`,
`src/infra/device-pairing.types.ts:112-139`). Approval checks requested roles/scopes against the
approver's scopes and creates a fresh token for each approved role
(`src/infra/device-pairing-approval.ts:276-395`, `src/infra/device-pairing-tokens.ts:84-102`).
The paired-device record serializes those token values into `tokens_json`
(`src/infra/device-pairing-store.ts:228-245`,
`src/state/openclaw-state-schema.sql:610-625`). Thus the storage is not digest-only for those
bearer tokens.

**Docs/design.** OpenClaw explicitly says that pairing extends operator trust rather than creating
hostile-user isolation (`docs/gateway/security/trust-model.md:60-68`).

### Scotty

The root token is accepted only from `Authorization: Bearer`; a root token presented as a client
credential is rejected, while browser authentication uses a separate client credential
(`worker/src/auth/request.ts:31-57`). Browser cookies are secure, HTTP-only, SameSite Strict, and
host-scoped (`worker/src/auth/request.ts:122-136`). Scope and owner checks are explicit
(`worker/src/auth/request.ts:78-100`).

Persisted clients, pairings, transfers, and recovery grants contain credential digests, and owner
state carries an epoch (`worker/src/auth/registry.ts:16-80`). Pairing links are stored and consumed
by digest (`worker/src/auth/registry.ts:477-527`); root recovery revokes active browser credentials
before installing a fresh owner and clearing pairings/handoffs
(`worker/src/auth/registry.ts:777-845`). The deployed-route test is a test definition, not a result
(`e2e/tests/deployed-routes.test.mjs:15-58`).

### Comparison

OpenClaw has scoped device pairing and token rotation, but the shared Gateway secret represents
broad operator authority and paired bearer tokens are persisted as token values. Scotty separates
root recovery authority from browser sessions, stores browser/pairing digests, and revokes the
browser credential set on recovery. Do not collapse those Scotty authorities.

## 3. Credential handling

### OpenClaw

**Docs/design.** SecretRefs reduce runtime/config exposure but do not make plaintext safe: plaintext
credentials remain supported, and a credential in an agent-readable file remains readable
(`docs/gateway/secrets/runtime-model.md:25-46`). The shared store's protected `secret` entries are
write-only through list/get interfaces, while `env` entries are agent-readable; store values are
explicitly unencrypted at rest in SQLite (`docs/gateway/secrets/secret-store-and-egress.md:11-22`,
`docs/gateway/secrets/secret-store-and-egress.md:40-47`). The schema has a plaintext `value TEXT`
column (`src/state/openclaw-state-schema.sql:2654-2669`).

**Source.** Sentinels use AES-256-GCM with process-global random keys; sealing registers exact-value
redaction, and resolution rejects malformed or tampered ciphertext
(`src/secrets/sentinel.ts:21-40`, `src/secrets/sentinel.ts:51-107`). Store reads return plaintext
only inside the Gateway process and, when requested, mint sentinels plus host bindings for
subprocess egress (`src/secrets/store/secret-store.ts:300-338`).

### Scotty

Scotty encrypts Registry credentials with AES-GCM, binds ciphertext to installation/name/version/
kind as associated data, and verifies a keyed digest after decryption
(`worker/src/credentials/crypto.ts:65-145`). Session runtime projection contains grants and managed
handles; Pi auth JSON carries those handles or a synthetic managed token rather than the provider
value (`worker/src/credentials/managed.ts:69-135`).

Egress resolution is accepted only for the Cloudflare Sandbox class with a valid container ID
(`worker/src/egress/worker.ts:247-276`). OpenAI/ChatGPT resolve managed handles and inject the real
credential only at outbound egress (`worker/src/egress/worker.ts:70-87`,
`worker/src/egress/worker.ts:124-169`); GitHub resolution additionally binds access to the
repository in the destination URL (`worker/src/egress/worker.ts:171-190`).

### Comparison

OpenClaw's SecretRef migration and sentinel paths are useful hardening inside its process trust
boundary. They do not provide Scotty's encrypted central storage or session-bound authority.

## 4. Sandbox and egress policy

### OpenClaw

When enabled, Docker sandbox resolution supplies read-only root, tmpfs, network `none`, and dropped
capabilities (`src/agents/sandbox/config.ts:104-115`); the sandbox mode still defaults to `off`
(`src/agents/sandbox/config.ts:246-252`). The Docker E2E exercises `none`, read-only, and read-write
workspace access and checks that unrelated host files are not visible
(`test/e2e/qa-lab/runtime/openclaw-sandbox-workspace-isolation.e2e.test.ts:62-155`). This is test
code, not a recorded pass.

The default-off secret egress proxy authenticates each run, binds sentinels to exact hosts, refuses
unresolved/unregistered substitutions, and rejects non-HTTPS or disallowed destinations
(`docs/gateway/secrets/secret-store-and-egress.md:50-59`,
`docs/gateway/secrets/secret-store-and-egress.md:98-109`,
`src/secrets/egress-proxy/proxy-server.ts:161-190`,
`src/secrets/egress-proxy/proxy-server.ts:367-386`). Registration uses a loopback proxy URL and
run-scoped token (`src/secrets/egress-proxy/proxy-server.ts:615-647`).

The traffic allowlist is separate from destination binding: it can restrict non-sentinel traffic,
but only for clients honoring the proxy environment; raw-socket bypass remains possible
(`docs/gateway/secrets/secret-store-and-egress.md:127-148`). The feature applies only to
Gateway-hosted exec, not sandbox or remote-node exec (`docs/gateway/secrets/secret-store-and-egress.md:141-148`).
It is credential-specific/defense-in-depth egress control, not a universal deny-all network
boundary.

### Scotty

Scotty defines a static host allowlist and dispatches each host to a credential-aware or
credential-free handler (`worker/src/egress/worker.ts:12-31`, `worker/src/egress/worker.ts:209-245`).
Credential-free pass-through rejects authorization, API-key, GitHub-token, proxy-auth, and cookie
headers (`worker/src/egress/worker.ts:192-203`); forwarded requests remove credential and source-IP
headers (`worker/src/egress/worker.ts:360-376`). The documented contract denies other outbound
traffic while acknowledging allowed package registries as a residual exfiltration channel
(`README.md:118-136`). The reserved same-repository path also rejects ambient authority
(`worker/src/egress/session.ts:141-181`).

### Comparison

OpenClaw supplies useful sandbox and operator explanation, but its proxy is not a replacement for
Scotty's narrow network surface and session-derived credential authority. Scotty must not add an
arbitrary-host bypass or expose plaintext to the container.

## 5. Approvals

### OpenClaw

**Docs/design.** Exec approvals are a companion-app/node host guardrail layered over tool policy;
effective policy is normally the stricter combination of tool and approval settings
(`docs/tools/exec-approvals.md:11-34`). The documented modes are `deny`, `allowlist`, `ask`, `auto`,
and `full`, and unavailable UI uses the ask fallback, which defaults to `deny`
(`docs/tools/exec-approvals.md:85-96`, `docs/tools/exec-approvals.md:185-197`). Approved runs bind
execution context and, where possible, executable/file identity; the docs explicitly call file
binding best-effort rather than a complete interpreter/runtime model
(`docs/tools/exec-approvals.md:49-59`).

The trusted-host defaults remain `security="full"` and `ask="off"`
(`src/infra/exec-approvals-config.ts:83-86`, `docs/gateway/security/trust-model.md:60-68`). The
loopback WebSocket E2E defines policy CAS, token redaction, a pending approval, and a second-reviewer
`allow-once` resolution (`test/e2e/qa-lab/runtime/gateway-exec-approvals.e2e.test.ts:38-81`,
`test/e2e/qa-lab/runtime/gateway-exec-approvals.e2e.test.ts:110-191`).

### Scotty

Scotty pins Codex thread start/resume to `approvalPolicy: "never"` and
`sandbox: "danger-full-access"`, and rejects drift (`worker/src/agent/codex/session.ts:981-1013`,
`worker/src/agent/codex/session.ts:709-723`). The protocol schema fixes those literals
(`protocol/codex-app-server.ts:42-63`). The outer container, session authority, managed credential
handles, repository grants, and egress policy provide the containment.

Destructive control-plane actions remain gated by plan review, local checks, and a deployed lifecycle
canary (`README.md:297-322`, `README.md:357-359`). The canary rejects unsafe stage names and
requires exact stage-scoped deploy/destroy approvals (`e2e/canary/full-stack-canary.ts:64-119`).

### Comparison

OpenClaw's approval UX is useful for trusted-host operator intent. Scotty's inner no-prompt mode is
intentional defense composition, not evidence that the outer boundary is absent. Keep destructive
control-plane approvals separate from model-mediated command prompts.

## 6. Operator diagnostics

### OpenClaw

`openclaw security audit` supports read-only local auditing, `--deep` live/plugin probes, `--fix`,
and JSON output (`src/cli/security-cli.ts:79-142`, `docs/cli/security.md:23-90`). The audit docs
cover trust-model, sandbox/tool, network, plugin, and dangerous-flag findings
(`docs/cli/security.md:29-90`).

Doctor lint is read-only, supports JSON, check selection, severity thresholds, and structured
findings (`docs/cli/doctor/lint.md:12-75`). Doctor's gateway/service checks report pending pairing,
role/scope and token drift without auto-approving or auto-rotating devices
(`docs/gateway/doctor/gateway-and-services.md:26-48`), and include PID/exit and port-collision
diagnostics (`docs/gateway/doctor/gateway-and-services.md:210-211`).

### Scotty

`scotty doctor` reads managed installation metadata, authenticates, requests the session list,
validates its shape, and reports reachability/auth success (`cli/src/commands.ts:2156-2184`).
Install/deploy/uninstall failures can produce bounded redacted diagnostics
(`cli/src/installation-diagnostics.ts:107-137`); the file is mode `0600` and its path is reported
without failing open if persistence fails (`cli/src/installation-diagnostics.ts:140-186`).

### Bounded opportunity

Scotty can adopt OpenClaw's _diagnostic shape_ without its trust assumptions:

1. Add a read-only security report for browser ownership epoch, revoked/stale client counts, session
   authority, Registry grant metadata, egress-policy version, backup/schedule presence, and rollout
   health.
2. Report only safe identifiers, digests/counts, typed status, and remediation commands—never
   credential values, decrypted Registry data, container env, raw logs, or new authority routes.
3. Keep detection separate from repair and preserve explicit authorization for mutations.
4. Explain the inner Codex `never`/`danger-full-access` setting together with the outer controls.

## 7. Test evidence and deployed proof

### OpenClaw

The supplied archive contains local executable coverage for Docker workspace isolation and loopback
WebSocket approvals (`test/e2e/qa-lab/runtime/openclaw-sandbox-workspace-isolation.e2e.test.ts:62-155`,
`test/e2e/qa-lab/runtime/gateway-exec-approvals.e2e.test.ts:38-81`). It also contains a scheduled/
reusable QA workflow with required exact-SHA input (`.github/workflows/qa-live-transports-convex.yml:1-15`),
credential-persistence disabled during checkout, and selected-ref validation against `expected_sha`
(`.github/workflows/qa-live-transports-convex.yml:210-267`). These are test/workflow definitions.
I found no run result, signed attestation, deployment inventory, or immutable artifact in the supplied
archive proving that the cited revision passed a deployed security boundary.

### Scotty

Scotty distinguishes static/helper checks, the local-live Worker/Sandbox/Pi loop, a non-mutating
deployed route check, and a gated deployed canary (`e2e/README.md:3-33`). The canary uses a
stage-isolated resource set and exact deploy/cleanup approvals (`e2e/README.md:53-66`), and checks
known disposable values only across externally observed artifacts rather than exposing privileged
storage inspection (`e2e/README.md:82-88`). The deployed test refuses to enable without required
inputs, isolated stage/host naming, and destructive confirmation (`e2e/tests/deployed.test.mjs:14-53`).
Its lifecycle covers terminal, checkpoint, hard-cap, resume, archive, vaporize, and cleanup paths
(`e2e/tests/deployed.test.mjs:174-203`, `e2e/tests/deployed.test.mjs:337-430`). These are definitions,
not a current pass record (`README.md:503-511`).

## Concise comparison

OpenClaw is a feature-rich personal-agent Gateway built around a trusted single-operator or
mutually trusting team boundary. It has mature pairing, host approvals, security audit, Doctor, and
local/live QA machinery. Its current docs and source still make sandbox-off, host-first/full-off
operation and plaintext/unencrypted shared-store fallbacks explicit choices inside that boundary.

Scotty is narrower at the boundaries relevant to a remote cloud agent: authoritative per-session
state, separate root/browser authority, digest-only browser credentials, encrypted Registry values,
session-bound credential resolution, managed container handles, repository-scoped GitHub access, and
allowlisted egress. The transferable OpenClaw capability is operator explainability, not ambient
host authority or plaintext fallback.

No current deployed pass artifact was found in the inspected OpenClaw archive or Scotty tree. This
report does not claim that either deployment passed its checks.

## Research limitations

- OpenClaw claims were restricted to the pinned archive and the source/docs/test paths cited above.
- The prior stale-snapshot report is superseded; its provenance and stale line references must not
  be used.
- Tests and workflows were inspected but not executed.
- No credentials, deployment, live Gateway, Cloudflare resource, CI system, or external state was
  accessed.
- This is a bounded comparison of trust model, pairing/auth, credentials, sandbox/egress,
  approvals, diagnostics, and proof design—not a complete vulnerability audit.
