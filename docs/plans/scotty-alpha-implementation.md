# Scotty alpha implementation packet

## Orientation

Scotty alpha is a clean contract cutover, not a compatibility migration. The product converges on one shared authority model, proves the complete Cloudflare product first, adds a trusted Runner only after that proof, and then packages one exact release candidate.

The central change is to separate durable product truth from execution details:

- the Session Sandbox Durable Object owns a canonical Session record, one operation lease, immutable grants, backup handles, and hard-cap metadata;
- installation-scoped Durable Objects own configuration snapshots, credentials, repositories, authentication, and Runner registration;
- KV is a repairable, non-secret projection; R2 owns immutable backup, evidence, artifact, and bundle objects with distinct meanings;
- Cloudflare Sandbox and trusted Runner compute execute the same Session contract but never become authoritative;
- every mutation reports the last proven effect, retained authority, ambiguity, safe retry, and required human action instead of collapsing failure into a Session state.

This ordering is deliberate. PRs 1–5 establish shared contracts and authorities. PRs 6–11 complete and prove Cloudflare. PRs 12–14 cannot enable Runner-backed Create until Cloudflare is proven and Runner parity is independently canaried. PR 15 accepts one signed, digest-pinned release candidate.

## Settled decisions and invariants

1. Canonical Session lifecycle states are exactly `provisioning`, `warm`, `stopped`, and `gone`.
2. `failed` is an operation result, never a Session lifecycle state. Operation state records stage, progress, last proven effect, retained state, ambiguity, safe retry, and human action.
3. There is one mutating operation lease per Session. Stale revisions and stale runtime epochs are fenced.
4. A complete Checkpoint is the only Resume authority. Snapshot quiesces Pi, syncs the exact Session Fork revision, writes an immutable backup, commits the Checkpoint, and only then stops compute.
5. Create arms the hard cap before commit, pins provider/config/credential/repository inputs, creates a baseline Checkpoint, and does not send an initial prompt.
6. Installation and Runner names are always user supplied. Local config points to an installation but is not deployment authority.
7. New Sessions pin the active immutable config snapshot and credential generations; existing Sessions do not drift.
8. Real credentials never enter Session env/files/args/logs/Git config, KV, R2, API responses, or Alchemy props/outputs/state. Session compute receives sentinels only; brokers hold plaintext for one authorized operation.
9. The Installation Mirror and Session Fork replace direct Session GitHub access. Publish is a controlled exact-commit operation; Vaporize does not report `gone` before owned state is proven absent.
10. Cloudflare must pass the PR 11 deployed canary before Runner production work begins. Runner-backed Create remains disabled until PR 14 passes.
11. Public HTTP routes, error-envelope shape, CLI JSON/exit-code behavior, persisted semantics, browser handoff, and credential isolation remain stable except where this packet explicitly replaces a contract.

## Scope and live inventory

The repository already has significant provisional implementations. The symbols below are the live starting points; entries marked **new** do not exist yet.

### Shared contracts and state

- `worker/src/contracts.ts`: `SessionStatusSchema`, `SessionOperationSchema`, `SessionFailureSchema`, `SessionRecordSchema`, `SessionProjectionSchema`, `SessionViewSchema`, `SessionEnvironmentStatusSchema`, `StatsResponseSchema`, `decodeSessionRecord`, `decodeSessionRecordResult`, `toProjection`, `toSessionView`, `ScottyError`.
- `worker/src/session-store.ts`: `SessionStore`, `SessionControlAuthority`, `SESSION_CONTROL_REVISION_KEY`, `acquireOperation`, `updateForOperation`, `markHardCapFailure`, `recordRuntimeStop`, `failOperation`.
- `worker/src/session-lifecycle.ts`: `SESSION_SCHEDULE_CALLBACKS`, `VAPORIZE_CONFLICTING_SCHEDULE_CALLBACKS`, `sessionAllowsRuntimeAccess`, `hardCapObservationIsCurrent`.
- `worker/src/session.ts`: `Sandbox`, lifecycle handlers, `CheckpointExitClassification`, `withCheckpointRuntimeRestore`.
- `worker/src/session-projection.ts`: `SessionProjection`, `projectSessionBestEffort`, `removeSessionProjection`, `listSessionProjections`.
- `worker/src/stats-projection.ts`: `StatsProjection`, `recordWorkspaceCreation`, `readStats`, `aggregateStats`.
- `cli/src/schemas.ts`: `SessionResponseSchema`, `StableSessionSchema`, `OperationResponseSchema`, `SessionOperationOutputSchema`, and their decoders.
- `tui/src/schemas.ts`: `FleetSessionSchema`, Create/Vaporize result schemas and remote protocol decoders.

### Config and bundle authority

- `cli/src/sandbox-config-contracts.ts`: `SandboxConfigSchema`, `SkillSourceSchema`, `PiPackageSourceSchema`.
- `cli/src/sandbox-config.ts`: `sandboxConfigPath`, `loadSandboxConfig`, `saveSandboxConfig`, sorting/encoding.
- `cli/src/sandbox-prepare.ts`: `prepareSkillSource`, `preparePiPackageSource`, `buildSandboxBundle`.
- `cli/src/sandbox-sync.ts`: `synchronizeSandboxBundle`, `synchronizeLocalSandbox`.
- `worker/src/sandbox-config-contracts.ts`: `SandboxConfigAuthoritySchema`, `SandboxActivateInputSchema`.
- `worker/src/sandbox-config-store.ts`: `SandboxConfigStore`, `durableObjectSandboxConfigAuthorityStorage`.
- `worker/src/sandbox-config-object.ts`: `ScottySandboxConfig` RPC boundary.
- `worker/src/sandbox-bundle-store.ts`: `SandboxBundleStore` and R2 capabilities.

### Identity and authentication

- `worker/src/auth-registry.ts`: `AuthRegistry`, `AuthAuthoritySchema`, owner/pairing/transfer/recovery candidates and issued credentials.
- `worker/src/auth-object.ts`: `ScottyAuthRegistry` RPC object.
- `worker/src/auth.ts`: `requireAuthScope`, `requireOwnerPrincipal`, cookie/client credential helpers.
- `tui/src/pairing.ts`, `tui/src/config.ts`, `tui/src/transport.ts`: terminal pairing, local config, authenticated transport.
- `worker/public/pair.js`, `worker/public/devices.js`: browser pairing and device ownership surfaces.

### Credentials and egress

- `worker/src/environment-contracts.ts`: legacy and v2/v3 environment authorities, Session snapshots, sentinels, bindings, and views.
- `worker/src/environment-store.ts`: `EnvironmentStore`, credential-resolution preference and origin policy.
- `worker/src/environment-secret-vault.ts`: `EnvironmentSecretVault`, sentinel resolution and proxy response contracts.
- `worker/src/environment-policy.ts`: `REQUIRED_GLOBAL_SECRET_NAMES`, reservation/materialization policy.
- `worker/src/egress.ts`: `EgressTransport`, `makeOutboundByHost`, `makeEnvironmentOutbound`.
- `worker/src/container-session-egress.ts`: internal Session proxy routes.
- Credential Durable Object, named generation contracts, grants, and provider brokers: **new**.

### Repositories

- `protocol/repository.ts`: repository identity and installation registry contracts.
- `worker/src/installation-repo-store.ts`: `InstallationRepoStore` authority.
- `worker/src/repo-verifier.ts`: `RepoVerifier`, `VerifiedRepository`.
- `worker/src/repo-projection.ts`: registry projection and repair.
- `worker/src/workspace.ts`: current GitHub-backed workspace setup.
- Mirror/Fork authority and Git bridge modules: **new**.

### Cloudflare lifecycle, Hatch, evidence, and artifacts

- `worker/src/session.ts`, `worker/src/session-store.ts`, `worker/src/backup-store.ts`, `worker/src/sandbox-runtime.ts`, `worker/src/container-auth.ts`.
- `worker/src/hatch-contracts.ts`, `worker/src/hatch-store.ts`, `worker/src/hatch-gateway.ts`.
- `worker/src/evidence-contracts.ts`, `worker/src/evidence-store.ts`, `worker/src/evidence-workflow.ts`, `worker/src/container-evidence-recorder.ts`, `worker/src/evidence-preview.ts`.
- `worker/src/artifact-store.ts`, `worker/src/backup-store.ts`, `worker/src/sandbox-bundle-store.ts` are distinct R2 boundaries.
- `infra/cloudflare-stack.ts`, `infra/external-sandbox-container-binding.ts`, `infra/installation.ts` own deployment topology.

### CLI, TUI, browser, Runner, and packaging

- `cli/scotty.ts`, `cli/src/main.ts`, `cli/src/commands.ts`, `cli/src/pure.ts`, `cli/src/services.ts`, `cli/skills/scotty/SKILL.md`.
- `tui/src/main.ts`, `controller.ts`, `state.ts`, `ui.ts`, `transport.ts`, plus provisional `desktop-*` modules.
- `worker/public/*.js|html|css` are browser operator surfaces.
- `protocol/runner.ts`: typed transport but still includes `ExecRuntime` and `ExecRuntimeResult`.
- `worker/src/runner-{control,object,registry,registry-object,transport,worker}.ts`.
- `cli/src/runner-{setup,link,runtime,docker,operation-journal}.ts`.
- `scripts/build-cli.mjs`, `scripts/make-cli-release.mjs`, `cli/src/upgrade.ts`.
- `desktop/**`, desktop build/package scripts, and TUI desktop sidecar modules are provisional and scheduled for deletion in PR 10.

## Target production flow and state ownership

```text
local config pointer
  -> browser-owner or paired-terminal credential
  -> installation authorities
       Auth DO
       SandboxConfig DO -> immutable R2 bundle/snapshot
       Credential DO -> encrypted named generations
       Repository DO -> Installation Mirror
       Runner Registry DO
  -> Session Sandbox DO
       canonical Session record + revision
       one operation lease
       immutable config/credential/repository grants
       backup handles + hard cap
  -> provider adapter
       Cloudflare Sandbox first
       trusted Runner after PR 14
  -> sentinel brokers / Session Fork / one Pi RPC process
  -> repairable KV projections and immutable R2 objects
```

A provider effect is successful only after its durable proof is committed. An interrupted call is reconciled against provider and owned state before retry. If reconciliation cannot establish an effect, the operation remains explicit and actionable; the Session does not move to a synthetic failure state.

## Dependency graph

```text
PR 1 -> PR 2 -> PR 3 -> PR 4 -> PR 5
  \       \      \      \      \
   +-------+------+------+-------> PR 6 -> PR 7 -> PR 8 -> PR 9 -> PR 10 -> PR 11
                                                                         |
                                            Cloudflare deployed gate <---+
                                                                         v
                                                                      PR 12 -> PR 13 -> PR 14
                                                                                           |
                                                        Runner enablement gate <------------+
                                                                                           v
                                                                                         PR 15
```

PRs are merged in numeric order. A later PR may prepare tests or interfaces early, but it may not activate its production path before all preceding gates pass.

## Implementation chunks

### PR 1 — Canonical state and result contracts

**Behavior.** Replace lifecycle states with `provisioning | warm | stopped | gone`. Add one canonical operation/result schema carrying `stage`, `progress`, `lastProvenEffect`, `retainedState`, `ambiguity`, `safeRetry`, and `humanAction`. Operation failures retain lifecycle truth and lease/retry authority. Projections preserve revision freshness and are repairable.

**Files/symbols.** Change `worker/src/contracts.ts` (`SessionStatusSchema`, `SessionOperationSchema`, `SessionFailureSchema`, `SessionRecordSchema`, projections/stats); `worker/src/session-store.ts` (`acquireOperation`, `updateForOperation`, failure/stop transitions); `worker/src/session-lifecycle.ts`; `worker/src/session-projection.ts`; `worker/src/stats-projection.ts`; `cli/src/schemas.ts`; `tui/src/schemas.ts`; affected browser projections.

**Ownership change.** Failure moves from `SessionRecord.status` to the active/retained operation result. Session DO remains authoritative; KV remains a revisioned projection.

**Delete exactly.** Literals `booting`, `sleeping`, and lifecycle `failed` from `SessionStatusSchema` and all Session-only schemas/callers; `SessionFailureSchema`/`failure` fields once represented by the operation result; `withLegacyCloudflareBinding`; permissive CLI `Schema.NonEmptyString` Session statuses; `sleepingNow` stats field and sleeping-only browser grouping; generic `upstream` provider error once typed operation results cover its callers. Do not delete unrelated evidence/rollout/tool result literals named `failed`.

**Focused proof.** `npm run fmt`; `npm run lint:skills`; `npx vitest run worker/test/contracts.test.ts worker/test/session-store.test.ts worker/test/session-projection.test.ts worker/test/stats-projection.test.ts worker/test/session-lifecycle-machine.test.ts`; `npm run typecheck:worker`; `npm run typecheck:cli`; `npm run typecheck:tui`; scoped `rg` absence scan for old Session states.

**Risk.** This is a repository-wide contract cutover; distinguish Session state from Hatch, evidence, Runner rollout, and tool statuses.

### PR 2 — Config, Plugins, and snapshot activation

**Behavior.** Strictly decode `${XDG_CONFIG_HOME:-~/.config}/scotty/config.json`, resolve local Plugins in deterministic order, reject collisions, deploy an immutable snapshot, and atomically activate it. Existing Sessions retain their pinned snapshot.

**Files/symbols.** Replace the schemas and flow in `cli/src/sandbox-config-{contracts,}.ts`, `sandbox-sources.ts`, `sandbox-prepare.ts`, `sandbox-sync.ts`; change `worker/src/sandbox-config-{contracts,store,object}.ts`, `sandbox-bundle-store.ts`; add Plugin/snapshot names to these owner modules rather than a parallel setup path.

**Ownership change.** Local config selects inputs; SandboxConfig DO owns the activation pointer; immutable R2 bundle/snapshot owns deployed content; Session record owns its pinned digest.

**Delete exactly.** `.scotty.json` reads/writes in CLI and scripts; legacy `.scotty/sandbox` config path; `SkillSourceSchema`, `PiPackageSourceSchema`, `skills`, `piPackages`, remote source support, hardcoded model/provider/thinking defaults, and duplicate setup commands after callers move.

**Focused proof.** `npx vitest run cli/effect-test/sandbox-config.test.ts cli/effect-test/sandbox-bundle.test.ts cli/effect-test/sandbox-sync.test.ts worker/test/sandbox-config-store.test.ts worker/test/sandbox-bundle-store.test.ts worker/test/sandbox-bundle-materializer.test.ts`; affected typechecks; XDG and activation replay tests.

### PR 3 — Browser owner, pairing, and local identity

**Behavior.** One browser owner creates expiring one-use pairing grants for terminals; clients can revoke themselves; owner transfer and root recovery have explicit effects. Root recovery revokes every browser/client credential.

**Files/symbols.** `worker/src/auth-registry.ts` (`AuthAuthoritySchema`, `AuthRegistry`, pairing/transfer/recovery candidates), `auth-object.ts`, `auth.ts`, `tui/src/pairing.ts`, `tui/src/config.ts`, and browser pair/device pages. Add a CLI local-identity service using keychain with `0600` private-file fallback.

**Ownership change.** Auth DO exclusively owns credential digests and browser ownership. The OS keychain/private file owns the local client secret.

**Delete exactly.** global-token client authentication, duplicate local credential stores, desktop-owned pairing, root token URL/cookie support, and prior local credential paths after migration.

**Focused proof.** `npx vitest run worker/test/auth-registry.test.ts worker/test/auth-ownership-machine.test.ts tui/test/config-pairing.test.ts`; CLI local-state tests; `npm run typecheck:worker`; `npm run typecheck:tui`; permission assertions.

### PR 4 — General credential authority

**Behavior.** Add encrypted named credential generations, immutable Session generation grants, operation-scoped brokers, refresh-before-response OAuth semantics, revocation, and custom adapters.

**Files/symbols.** Add Credential DO contracts/store/object; replace credential ownership in `environment-contracts.ts`, `environment-store.ts`, `environment-policy.ts`, `environment-secret-vault.ts`, `egress.ts`, `container-session-egress.ts`, `session.ts`, CLI credential commands, and Cloudflare bindings.

**Ownership change.** Account Secrets Store owns only the Installation wrapping key. Credential DO owns ciphertext generations and OAuth refresh. Session DO owns immutable generation grants. Broker memory owns plaintext for one operation.

**Delete exactly.** config/environment-owned plaintext, `REQUIRED_GLOBAL_SECRET_NAMES`, `RequiredGlobalSecretName`, `CREDENTIAL_RESOLUTION_PREFERENCE`, static injected placeholders as authority, raw env injection, direct credential egress, Session credential files, and GitHub/Pi-specific storage.

**Focused proof.** `npx vitest run worker/test/environment-store.test.ts worker/test/environment-secret-vault.test.ts worker/test/egress.test.ts worker/test/container-session-egress.test.ts worker/test/session-environment-refresh.test.ts`; new Credential DO contract tests; `node e2e/scripts/scan.mjs`; forbidden-surface scans; worker/CLI typechecks.

### PR 5 — Repository Mirror and Session Fork

**Behavior.** Verify an exact GitHub commit, reconcile it into an Installation Mirror, deterministically create a Session Fork, and expose only operation-bound sentinel Git access to Session compute.

**Files/symbols.** `protocol/repository.ts`; `worker/src/installation-repo-store.ts` (`InstallationRepoStore`); `repo-verifier.ts`; `repo-projection.ts`; replace `workspace.ts`; add Mirror/Fork store and bridge modules; add Alchemy bindings and owner-adjacent tests.

**Ownership change.** Repository DO owns registry/Mirror metadata. Repository object storage owns Mirror/Fork bytes. Session DO owns the exact commit/Fork grant. Git broker briefly owns provider credentials.

**Delete exactly.** direct Session GitHub clone in `workspace.ts` and `scotty-runner-bootstrap`; runtime `gh`, `GH_TOKEN`, public-import side path, and any installation GitHub credential in compute.

**Focused proof.** `npx vitest run worker/test/installation-repo-store.test.ts worker/test/repo-verifier.test.ts worker/test/repo-projection.test.ts worker/test/workspace.test.ts`; new Mirror/Fork contract tests; protocol security tests; forbidden-token scan; affected typechecks.

### PR 6 — Cloudflare Create and baseline Checkpoint

**Behavior.** Idempotent Create pins provider, active snapshot, credential generations, and exact repository commit; creates the Fork; arms hard cap; creates Sandbox/brokers; starts one Pi RPC process; proves readiness; writes a baseline Checkpoint; commits `warm`. No initial prompt is sent.

**Files/symbols.** `worker/src/session.ts`, `session-store.ts`, `create-idempotency.ts`, `container-auth.ts`, `sandbox-runtime.ts`, `backup-store.ts`, repository/credential/config authorities, and Create routes/CLI result decoders.

**Ownership change.** Session DO commits all immutable grants and baseline backup handle before warm projection. Runtime readiness is evidence, not authority.

**Delete exactly.** legacy Create phases/states replaced by canonical operation stages, startup prompt dispatch, direct Pi startup, direct GitHub workspace setup, and credential-bearing container configuration.

**Focused proof.** `npx vitest run worker/test/session-create.test.ts worker/test/create-idempotency.test.ts worker/test/session-store.test.ts worker/test/sandbox-runtime.test.ts worker/test/backup-store.test.ts`; one-Pi and first-prompt tests; worker/CLI typechecks.

### PR 7 — Snapshot, Sleep, Resume, and hard caps

**Behavior.** Snapshot/Sleep/timeout quiesces Pi, syncs Fork, writes immutable R2 backup, commits complete Checkpoint, stops compute, and enters `stopped`. Resume requires the current complete Checkpoint and makes the same Session `warm`. Clock/schedule behavior is deterministic and stale runtimes are fenced.

**Files/symbols.** `worker/src/session.ts`, `session-store.ts`, `session-lifecycle.ts`, `backup-store.ts`, provider adapters, schedule callbacks, and CLI/TUI/browser lifecycle callers.

**Ownership change.** Session DO owns Checkpoint completeness and schedules; R2 owns backup bytes; runtime has no stop authority.

**Delete exactly.** `sleeping`, stop-without-Checkpoint branches, direct wall-clock lifecycle calls, incomplete backup authority, stale-backup Resume, and Runner exceptions that bypass Checkpoint semantics.

**Focused proof.** `npx vitest run worker/test/session-lifecycle-machine.test.ts worker/test/session-lifecycle.test.ts worker/test/session-resume.test.ts worker/test/backup-store.test.ts`; TestClock hard-cap/inactivity cases; affected typechecks.

### PR 8 — Hatch, screenshot, and video evidence

**Behavior.** Every Session installs dormant Hatch/capture capability. Application Sessions activate authenticated, generation-fenced HTTP/WebSocket Hatch plus screenshot/video evidence. Stop and Vaporize revoke access and clean active work without treating browser connectivity as lifecycle proof.

**Files/symbols.** `hatch-contracts.ts`, `hatch-store.ts`, `hatch-gateway.ts`, `evidence-contracts.ts`, `evidence-store.ts`, `evidence-workflow.ts`, `container-evidence-recorder.ts`, `evidence-preview.ts`, `artifact-store.ts`, browser-test Pi package and public display modules.

**Ownership change.** Session DO owns Hatch/evidence state and generation; Artifact Store owns immutable media; auth handoff owns temporary browser access.

**Delete exactly.** Hatch-as-deployment-evidence checks, unauthenticated evidence URLs, shared backup/evidence/artifact keys or meanings, and lifecycle transitions inferred from browser connection.

**Focused proof.** `npx vitest run worker/test/hatch-gateway.test.ts worker/test/hatch-session-lifecycle.test.ts worker/test/evidence-contracts.test.ts worker/test/evidence-store.test.ts worker/test/evidence-workflow.test.ts worker/test/evidence-session-lifecycle.test.ts worker/test/artifact-store.test.ts`; public view tests; affected typechecks.

### PR 9 — Publish and Vaporize

**Behavior.** Publish selects an exact agent commit, runs declared checks in isolated state, reconciles base drift/conflicts, and creates/updates a controlled GitHub branch and PR without overwriting human metadata. Vaporize revokes grants, stops runtime, removes Hatch/evidence/Fork, reconciles Publish, proves absence, then commits `gone`.

**Files/symbols.** Replace `DownManifestSchema`, `handleDown`, `session.ts` down/vaporize handlers, repository bridge, CLI Publish/Vaporize commands, projection cleanup, and backup/artifact cleanup owners.

**Ownership change.** Session DO owns Publish/Vaporize retry authority. Repository bridge owns exact provider operations. GitHub remains authoritative for branch/PR existence; local ambiguity is reconciled.

**Delete exactly.** beam-down archive semantics, hidden commits, inferred check commands, force-push, guessed dirty inclusion, ambiguous-write success, and any early `gone` write.

**Focused proof.** `npx vitest run worker/test/session-down-vaporize.test.ts worker/test/session-store.test.ts worker/test/repo-verifier.test.ts`; new Publish contract tests; CLI command tests; lifecycle race tests; affected typechecks.

### PR 10 — Canonical executable and operator surfaces

**Behavior.** One compiled `scotty` executable owns CLI, PTY TUI, setup/config/credential/repository/Session/browser/Runner/update/uninstall commands and embeds the operating Skill.

**Files/symbols.** `cli/scotty.ts`, `cli/src/{main,commands,pure,services,schemas}.ts`, `tui/src/{main,controller,state,ui,transport}.ts`, browser handoff, `cli/skills/scotty/SKILL.md`, build/release scripts. Review `stash@{0}` manually and port only compatible thread-selection/steering behavior.

**Ownership change.** The executable owns local orchestration and presentation; browser/TUI remain clients of remote authorities.

**Delete exactly.** `beam` command tree, `init`, old JSON decoders/envelopes after all callers move, `desktop/**`, `tui/src/desktop-*`, `tui/test/desktop-*`, `scripts/build-scotty-desktop-sidecar.mjs`, `scripts/check-scotty-desktop*.mjs`, `scripts/package-scotty-desktop*.mjs`, desktop package scripts, sidecar artifacts, duplicate TUI authority, and adjacent runtime assets.

**Focused proof.** `npx vitest run cli/effect-test/command-tree.test.ts`; `bun test cli/test/cli.test.ts cli/test/skill-content.test.ts`; `npm run test:tui`; `npm run check:cli-clean-room`; `npm run check:cli-compiled`; `bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli`; empty-home PTY/browser tests; absence scans.

### PR 11 — Clean cutover and Cloudflare proof

**Behavior.** Promote lasting spike code/tests, move deployed canaries to `e2e/canaries/`, delete provisional paths, provide a guarded repository-only development reset, deploy fresh Cloudflare infrastructure, and run the complete lifecycle canary.

**Files/symbols.** Move owner-specific `spikes/**` content beside owners; restructure `e2e`; add guarded reset/deletion-plan script; update package scripts, deployment topology, scan rules, and docs.

**Ownership change.** Production modules/tests own accepted spike findings. Reset deletes only repository-owned development resources identified by sanitized plans.

**Delete exactly.** `spikes/**`, references to `spikes/`, old schemas/config paths/desktop/sidecar/forbidden credential surfaces, obsolete canary scripts, and cleanup debt proven safe to remove.

**Focused proof.** Full baseline: `npm run fmt`; `npm run lint:skills`; `npm run lint`; `npm run typecheck`; `npm run test:all`; `node e2e/scripts/scan.mjs`; `bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli`; guarded fresh deploy; complete Cloudflare canary covering Create, first Pi response, Snapshot/Resume, Hatch, screenshot/video, Publish, Vaporize, and cleanup.

**Gate.** Do not begin Runner production implementation until this deployed canary is recorded passing.

### PR 12 — Runner setup and certification

**Behavior.** A paired terminal consumes a one-use setup grant on a trusted Linux host, installs the exact signed Scotty binary and digest-pinned OCI image, creates/replaces Runner identity, installs a system service, and proves capabilities before accepting work.

**Files/symbols.** `runner-registry.ts`, `runner-registry-object.ts`, `runner-control.ts`, `cli/src/runner-setup.ts`, `runner-link.ts`, `runner-docker.ts`, install/service scripts, release manifest verification.

**Ownership change.** Runner Registry DO owns identity digest, desired mode, certification, health, and capacity. Host owns only its credential and certified artifacts.

**Delete exactly.** copied Pi/GitHub credentials in setup, arbitrary image selection, connection-equals-readiness, and production host-process Session support.

**Focused proof.** `npx vitest run worker/test/runner-registry.test.ts worker/test/runner-control.test.ts cli/effect-test/runner-setup.test.ts cli/effect-test/runner-link.test.ts cli/effect-test/runner-docker.test.ts`; setup crash/replacement/digest/health/capacity tests; affected typechecks.

### PR 13 — Runner Session parity

**Behavior.** Runner implements the same typed Create/Pi/broker/Fork/Checkpoint/Sleep/Resume/Hatch/evidence/Publish/Vaporize contract inside Docker, with Worker-streamed backups, outbound Hatch relay, five-minute control lease, and offline watchdog.

**Files/symbols.** Replace `protocol/runner.ts`, `worker/src/runner-{transport,object,control}.ts`, `cli/src/runner-{runtime,docker,operation-journal,link}.ts`; connect shared Session provider adapter and broker/backup/Hatch/repository services.

**Ownership change.** Session DO retains authority. Runner holds a bounded control lease and ephemeral runtime state; Docker workspace is never authoritative.

**Delete exactly.** `ExecRuntimeSchema`, `ExecRuntime`, `ExecRuntimeResultSchema`, `ExecRuntimeResult`, generic host argv/cwd execution, credential mounts, direct Internet, fixed-port HTTP stub, and Runner stop-without-Checkpoint paths.

**Focused proof.** `npx vitest run protocol/runner.test.ts worker/test/runner-transport.test.ts worker/test/runner-control.test.ts cli/effect-test/runner-runtime.test.ts cli/effect-test/runner-docker.test.ts`; broker cleanup, lease/watchdog, backup streaming, parity contract tests; affected typechecks.

### PR 14 — Runner cleanup and final provider canary

**Behavior.** Drain stops and checkpoints Sessions before update/removal, proves local cleanup when reachable, and retains receipts. Lost Runner removal revokes identity and records cleanup debt without claiming deletion.

**Files/symbols.** Runner registry/control/runtime/setup modules, CLI Runner administration, cleanup receipt/debt contracts, canaries under `e2e/canaries/`.

**Ownership change.** Registry DO owns revocation and cleanup debt. Reachable Runner signs cleanup receipts. Unreachable host state remains explicitly unproven.

**Delete exactly.** optimistic lost-host deletion claims, cleanup without receipts, update paths that accept active Sessions, and the Runner-backed Create feature gate after the canary passes.

**Focused proof.** Runner unit/contract suites; normal remove/update/interruption/lost-host tests; full deployed Runner canary; forbidden-credential and workspace-absence scans.

**Gate.** Keep Runner-backed Create disabled until independent verification records this canary passing.

### PR 15 — Final alpha packaging and acceptance

**Behavior.** Build one source revision into signed macOS arm64/x64 and Linux arm64/x64 executables plus one digest-pinned OCI image; install, update, use, and uninstall that exact candidate through automated and human acceptance.

**Files/symbols.** `scripts/make-cli-release.mjs`, `cli/src/upgrade.ts` manifest/signature schemas, build scripts, OCI checks, release canaries and walkthrough documentation.

**Ownership change.** Signed release manifest owns artifact identity; installation pins exact binary/image digests; acceptance records point to one revision and deployment.

**Delete exactly.** unsigned/ad-hoc artifacts, adjacent runtime asset dependence, mutable image tags as authority, and temporary release exceptions.

**Focused proof.** Full deterministic suite; four architecture build/install smoke tests; signature/digest checks; fresh setup; first Pi response; one full Session per provider; TUI/browser/Hatch/evidence/Publish/Resume/Vaporize; update and uninstall; human acceptance record.

## Verification matrix

| Boundary               | Required proof before merge                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Schema/persisted state | strict decode success/failure, replay, stale revision, no legacy decoder           |
| Session operations     | one lease, last proven effect, ambiguity retention, safe retry/human action        |
| Projection             | stale-write rejection or overwrite by newer revision, list repair, absence repair  |
| Credentials            | ciphertext at rest, no plaintext surfaces, operation cancellation/revocation       |
| Repository             | exact commit, moving-ref detection, Fork replay/deletion, ambiguous reconciliation |
| Lifecycle              | hard cap before Create commit, complete Checkpoint, same-Session Resume, fencing   |
| Browser evidence       | authenticated Hatch, generation fencing, screenshot/video display and cleanup      |
| Publish/Vaporize       | exact commit/checks, metadata preservation, races, proof before success            |
| CLI/TUI                | stable JSON and exit codes, PTY/browser handoff, empty home, no local Pi           |
| Cloudflare             | fresh deployed complete lifecycle canary                                           |
| Runner                 | certification, parity contracts, lease/watchdog, cleanup receipt/debt canary       |
| Release                | signed four-platform artifacts, exact OCI digest, fresh install/update/uninstall   |

Every PR runs `npm run fmt` before lint. Effect changes also run `npm run lint:skills`. Each implementation PR runs the smallest focused tests and affected typechecks; PRs 11 and 15 run the complete baseline.

## Agent implementation ticket template

```text
Title: PR N — <outcome>

Read first:
- AGENTS.md
- docs/plans/scotty-alpha-implementation.md, PR N
- applicable .agents/skills/*/SKILL.md
- pinned Effect/Alchemy source and tests for every non-trivial pattern

Branch: pr-N-<short-name>

Deliver one vertical slice:
1. Implement the new contract and production path.
2. Move every caller named in the packet.
3. Delete the replaced path and exact deletion list.
4. Add owner-adjacent contract/replay/failure tests.
5. Run format, lint:skills, focused tests, and affected typechecks.
6. Run the scoped old-path/secret absence scan.
7. Commit with the proof summary and open a PR.

Invariants:
- preserve unrelated HTTP/CLI contracts and credential isolation;
- never infer installation/Runner names;
- never report success from ambiguous provider state;
- never weaken types or add compatibility decoders;
- do not enable a gated production path early.

Report:
- files/symbols changed;
- ownership transition;
- old path deleted;
- commands and results;
- unresolved deployment/human proof.
```

## Integration review template

```text
Review PR N against docs/plans/scotty-alpha-implementation.md.

Contract:
[ ] New behavior is end to end, not an isolated schema.
[ ] Every caller uses the new contract.
[ ] Public envelopes/exit codes changed only where approved.

Authority and failure:
[ ] Durable owner is explicit.
[ ] One operation lease and freshness/epoch fences hold.
[ ] Last proven effect, retained state, ambiguity, retry, and human action are truthful.
[ ] No success is inferred from an ambiguous provider response.

Security:
[ ] Unknown boundary data is strictly decoded.
[ ] No real credential reaches forbidden surfaces.
[ ] Logs, errors, fixtures, and deployment state are sanitized.

Removal:
[ ] Exact deletion list is gone.
[ ] No parallel/compatibility path remains.
[ ] Absence scans distinguish same-named non-Session statuses.

Proof:
[ ] Format ran before lint.
[ ] Focused tests cover replay, interruption, stale state, and projection repair.
[ ] Affected typechecks pass.
[ ] Required deployed/human proof is explicitly pending or recorded.

Verdict: merge only when new contract works AND every caller moved AND focused proof passes AND old path is deleted.
```

## Rollout and gates

### Cloudflare canary boundary

PR 11 starts from a guarded repository-only development reset and a fresh Installation. The canary must use production Alchemy resources and the official Sandbox integration, not the fake Worker or merely reachable routes. It must prove setup/ownership, configuration activation, credential brokering, exact repository import/Fork, Create with baseline Checkpoint, first prompt after TUI connection, Snapshot/Sleep/Resume, authenticated Hatch, screenshot and video, Publish, Vaporize, and resource cleanup. Logs and artifacts must pass forbidden-surface scans.

### Runner start gate

No PR 12 production implementation or Runner-backed Create activation starts until the PR 11 Cloudflare canary passes. PRs 12–14 may rely on the already-proven shared provider contract but may not weaken it. Runner-backed Create remains disabled until PR 14 proves certification, full Session parity, normal cleanup/update, lost-host debt semantics, identity revocation, and a complete deployed Runner canary.

### Final release proof

PR 15 selects one commit and records:

- signed release manifest;
- macOS arm64/x64 and Linux arm64/x64 artifact digests;
- exact OCI image digest;
- clean installation and pairing;
- first real Pi response;
- one complete Cloudflare and one complete Runner Session;
- TUI/browser review, Hatch, screenshot/video, Publish, Snapshot/Resume, Vaporize;
- update and uninstall;
- automated results and human acceptance against the same candidate.

## Risks and mitigations

- **State-name overreach:** `failed` and `sleeping` also describe evidence, Hatch, rollout, tools, and runtime observations. Absence scans must target Session contracts and UI projections, not blindly rename every occurrence.
- **Large shared cutover:** PR 1 can expose provisional lifecycle assumptions throughout Session, CLI, TUI, and browser code. Keep the canonical schema small, use compiler errors as the caller inventory, and merge only after the old union is absent.
- **Authority duplication:** provisional environment, workspace, desktop, and Runner paths already exist. Each PR must delete replaced ownership, not wrap it.
- **Provider ambiguity:** Cloudflare/GitHub/Runner writes can complete after transport failure. Operation records must retain reconciliation authority and safe retry guidance.
- **Deployment-only gaps:** local fakes cannot prove Sandbox, Durable Object migration, Cloudflare routing, or Runner host cleanup. PR 11, PR 14, and PR 15 explicitly reserve deployed proof.
- **Credential leakage during migration:** scans cover container env/files/args/logs/Git config, KV/R2/API, Alchemy state/outputs, fixtures, diagnostics, and release artifacts.

## Open decisions

The product ordering and authority model are settled. These implementation details must be decided in their owning PR and recorded in code/tests without reopening the architecture:

1. PR 1: exact bounded schemas/enums for operation `stage`, `progress`, `lastProvenEffect`, retained-state references, ambiguity, safe retry, and human action. This gates all later operation implementations.
2. PR 2: final local Plugin manifest syntax and collision namespace. This gates snapshot encoding, not the activation ownership model.
3. PR 4: credential adapter registration contract and wrapping/encryption primitives supported by the Cloudflare deployment. This gates custom adapters.
4. PR 5: immutable Mirror/Fork object layout and reconciliation receipts. This gates Create and Publish.
5. PR 8: application-Session activation declaration and screenshot/video capture parameters. This gates active Hatch/evidence, not dormant installation.
6. PR 9: declared-check manifest location and exact Publish branch naming. This gates Publish behavior.
7. PR 10: whether `stash@{0}` thread selection/steering fits the canonical browser surface; inspect, port selectively, never restore wholesale.
8. PR 11/14/15: deployment account/installation/Runner names and human approval are supplied at execution time and are never inferred.
