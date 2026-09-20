# Docker, MCP, then Linux — implementation plan

## Restart here — S2a/S2b local candidate; combined live gate pending

Status at the 2026-09-20 planning handoff:

| Packet                                  | Status                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 image publication                    | Complete: `v0.3.19` published and independently verified                                                                                             |
| S2a Docker-free CF install/custom image | Local standard-image implementation present; live transfer/install gate pending; custom-image proof deferred                                         |
| S2b side-loaded sandbox CLI             | Connected local candidate; signed standard-image compatibility, automatic admission, cache/pin/materialization and restore wired; live proof pending |
| S3–S6                                   | Not started; preserve the dependency order below                                                                                                     |

**Completed prerequisite:** [release v0.3.19](https://github.com/Yeshwanthyk/scotty/releases/tag/v0.3.19), [successful release run 35465340703](https://github.com/Yeshwanthyk/scotty/actions/runs/35465340703), source revision `7c84770356f09f9cfbe068a1a12aefa218b88653`. The released `scotty-image-manifest.json` identifies the tested `linux/amd64` image at `sha256:83068d1f8bc8cb705a70c379ef5cd33c02dd4f920d3166f415a6baa02c0f39a5`. Resolve its repository/reference from that manifest, not a hardcoded account. Native image checks, anonymous pull, matching configuration/platform, and OCI provenance passed. The signed CLI upgrade manifest and image provenance were also independently verified. See [the final S1 receipt](../s1-image-publication-handoff.md#final-receipt--s1-complete) for evidence and historical repair details. S1 does not prove Docker-free installation or Linux-runner compatibility.

### Fresh-session procedure

1. Read `AGENTS.md`, this plan, and the final S1 receipt. Check `git status`, fetch current main, and create a new S2 branch from main containing the release revision above. At handoff the checkout is still `fix/image-attestation-home`; the plan and `.quickdiff/` are untracked and the S1 handoff has local documentation changes. Preserve these files and user comments; do not reset or clean them away.
2. Start S2a with a read-only feasibility scout of **Docker-free transfer into the user's target Cloudflare registry**. Source inspection already distinguishes Alchemy's Docker-based remote-image path from its Docker-free target-registry `prepushed` path; this is not end-to-end installation proof. Read [CLI/image coupling research](../scotty-cli-image-coupling-research.md) and [provisioning research](../scotty-cli-provisioning-research.md), then recheck pinned source and official registry APIs/tooling. Return the supported transfer/authentication path, actual Docker invocation chain, and smallest account-spike proof. If no supported path exists, report the blocker before implementing a workaround. Read-only S2b design can proceed in parallel; implementation/proof remain separate packets.
3. Keep the main thread as orchestrator: delegate a bounded implementation to one writer, then independent verification with exact checks. Use current runtime preferences and approval routing. The previous bounded repair used Sol medium for implementation and Luna high for verification; Astra medium is not a prerequisite. Jev may judge a bounded report, but does not replace tests or authorize execution.
4. Complete each packet's local checks before requesting its live proof. Obtain a user-supplied installation name and fresh authorization for registry writes, publication, deployment, custom-image rollout/drain, or destructive cleanup. Prior S1 publication approvals are finished; keep the existing deployment intact. This planning session performed source research and documentation changes only, not implementation or deployment. Research notes are also local work to preserve.

**Agreed scope (supersedes deployment-only selection):** each new session resolves the newest compatible signed GitHub Linux CLI, verifies/caches its bytes in R2, and pins the exact descriptor/digest before admission. SandboxConfig owns installation selection; Session owns its immutable pin. Explicit lookup outage may use the last verified compatible cached selection, recorded as `cached_during_lookup_outage` with its original verification time. Signature, integrity, malformed, no-compatible and truncated-search failures never downgrade. Existing/running/sleeping/resumed sessions never look up latest. CLI-only releases need no image rollout. Standard-image compatibility is signed and bound to the selected immutable image digest; custom-image attestation UX and live support are deferred. Unproven images fail managed admission rather than borrowing compatibility from labels.

**Current execution boundary:** one integration writer; preserve dirty release/cache work and `.quickdiff`. Do not fetch, branch, commit, publish, deploy, access live accounts/R2 or clean existing resources without fresh authorization. The historical fresh-session procedure below is not authorization for those actions. Complete the connected local candidate, then request the combined S2a/S2b standard-image live gate; do not return to isolated packet/review rounds.

**Deferred, not a prerequisite:** broad CI duration/conditional image reuse optimization remains separate. S2b must prove CLI-only delivery using an unchanged image digest, but does not redesign all CI caching. Until S2b removes the image-owned CLI, its source/version remain image inputs. Afterwards, account for all remaining native runtime, dependency, and tool-inventory inputs. Reused images retain their original build revision/provenance and require compatibility/availability checks.

## Scope and order

This is the single active plan for this work. It is self-contained; superseded plans have been removed. Each implementation session must recheck the named source and current tests rather than rely on prior conversation history.

Delivery order is deliberately vertical: **Docker/image maintenance first, MCP second, Linux third**. Daytona is explicitly out of scope: do not research it, add adapters, or perfect a future provider contract. It can be reconsidered in a separate plan.

Packet labels identify outcomes, not mandatory isolated slices or review rounds. The current authorization combines the remaining S2a/S2b local integration into one deployable standard-image candidate, followed by a separately authorized live gate. A fresh session reads this document and `AGENTS.md`, not prior transcripts. This plan does not itself authorize deployment or external-provider actions.

## Rules and handoff

- Preserve the working CF actor and official Sandbox SDK host island. Add only seams required by Linux; no broad upfront adapter extraction or lifecycle rewrite.
- No compatibility reader, dual protocol, silent reset, unsafe re-enrollment, or half-enabled Linux admission. Remove dead paths in the packet that proves their replacement.
- Vendor Effect/Alchemy source and pins are read-only. No generic image/settings/provider registry, installer framework, new verify command, or new test harness.
- Normal CLI installation must not require Docker; the registered Linux execution host still requires the supported container runtime. User image authors own additional tooling and local MCP binaries. Real managed Codex/GitHub credentials stay server-side, never in user images, ordinary settings, runner files/env/argv/logs, or backups.
- Every handoff records commit SHA, exact files, start/end state, user demo, commands/results, cleanup IDs, removals/searches, evidence limits, and the next packet's prerequisites.

```text
S1 image publication -> S2a Docker-free CF install/custom image
S2a -> S2b side-loaded sandbox CLI
S2b -> S3 MCP Settings/projection
S2a + S2b + S3 -> S4 Linux native minimal vertical
S4 -> S5 Linux resume/Hatch/canary
S5 -> S6 approved no-compat cutover/final audit
```

S1/S2 come first by the user's chosen order, not because MCP or registry publication is a technical prerequisite for native Linux transport. Preserve current CF tools. S4 can develop against a local immutable Linux image artifact, but the sequence changes only by an explicit decision if an earlier gate blocks.

## Existing versus proposed commands

**Existing today:** the verification skill's current CF/Codex drive is:

```sh
python3 .pi/skills/verify-scotty-codex/scripts/smoke.py \
  --cli /path/to/selected/scotty --repo OWNER/REPO \
  --evidence /tmp/scotty-codex-proof-<timestamp>-<pid> \
  --authorize-create-and-cleanup
```

It proves CF/Codex only. `npm run lab -- start` and its returned run ID prove local routing only.

**Proposed syntax, not current support:** extend the existing smoke recipe with `--provider runner --runner <USER_NAME> --agent pi|codex`. Maintain the existing `.pi/skills/verify-scotty-codex` skill after real recipes; do not create a skill or command.

## S1 — `image-publication`

**Status:** complete in `v0.3.19`; the restart receipt above is authoritative. The following records S1's delivered scope, not work to repeat.

**Original start:** current CF Dockerfile, CI, and local image-oriented installation path; no immutable provider release manifest was proven.

**Owner/files:** `.github/workflows/{ci,release-cli}.yml`, `worker/container/Dockerfile`, `scripts/check-container-image.mjs`, and the smallest release-manifest file under existing packaging ownership. Inspect, never edit, pinned Alchemy sources.

**Change:** centrally build, test, attest, and publish the existing CF-compatible image with an immutable digest/platform manifest. Preserve current tools and official SDK/Hatch contracts; do not make minimal-tool removal a prerequisite. Users do not run this CI.

Use a public Docker Hub repository with maintainer-supplied identity and CI credentials, not account names committed to source. Publish the release manifest only after every required image is tested and pullable; incomplete pushes are not a complete release. Retain exact compatible Worker/SDK/runtime versions and do not claim untested architectures.

**User demo — passed:** the authorized `v0.3.19` release published the tested immutable image; a fresh CI runner anonymously pulled and inspected it by digest and verified provenance. Independent post-release provenance and signed CLI-manifest verification also passed.

**Gate:** existing `npm run check:container-image`, native/image checks, public pull, digest/platform match, and credential-state inspection. If CI or registry publication cannot be made safe, stop image replacement work; any decision to proceed with Linux source work instead is an explicit resequencing, not a hidden dependency bypass.

**Cleanup/removal:** no old path removed yet; receipt lists image consumers and CF tool-impact approval needed before later deletion. Handoff includes digest, manifest, provenance, and results.

## S2a — `cf-no-docker-install`

**Current state:** S1's released `v0.3.19` manifest remains historical evidence. Local S2a immutable-image selection/transfer and deployment inputs are implemented in the current checkout; fresh-account Docker-free transfer/install remains unproven. S2b now requires newly signed standard-image runtime-compatibility metadata; the old unsigned image manifest is not sufficient for the candidate's automatic managed admission. Complete the combined standard-image live gate below. Custom-image attestation/proof remains deferred.

**Owner/files:** `cli/src/deployment-packaging.{ts,mjs}`, `cli/src/installation-deployment.ts`, `infra/cloudflare-stack.ts`, `cli/src/commands.ts`, and existing archive tests. Inspect compiled CLI ownership in `scripts/build-cli.mjs`. Read pinned Alchemy `ContainerProvider`/`ContainerApplication`; do not edit vendor.

**Change:** make released CLI deployment select the approved image digest and prove the actual Alchemy/platform prebuilt path. An image field alone is insufficient: the current pull/tag/push path must not be mistaken for Docker-free installation. Preserve archive/assets and current CF runtime behavior.

Verify `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/{ContainerApplication,ContainerProvider}.ts`: remote references invoke Docker pull/tag/push; an image already in the target Cloudflare registry takes the `prepushed` path without those operations. See `ContainerProvider.ts` image strategy selection and `buildAndPushImage`, plus `vendor/alchemy/website/src/content/docs/cloudflare/compute/containers.mdx`. This only proves the deployment leg. S1's public image is not automatically available in every user's target registry.

**Ordered tasks:** (1) establish a supported authenticated transfer into the user's target registry without local Docker or user-run CI; (2) verify immutable source/destination identity, platform, transfer retry/failure behavior, and credential isolation; (3) supply that target digest through Alchemy's public image API while removing normal-install Docker preflights/context work only after proof; (4) run clean-install/upgrade and custom-image live gates. Resolve account identity from authorized runtime context, never repository constants. Do not add hidden shared registry credentials or a second Container reconciler. If transfer is unsupported, stop and record the blocker; a manually prepushed image alone does not satisfy the fresh-user demo.

CF has one deployed Container application image today: custom-image selection requires an approved deployment/drain, not an assumed per-session override. Preserve existing session data and require restore compatibility before rollout. User image authors may use build tooling to produce their derived image; the normal installer must not require it.

**User demo:** on a fresh machine with no repository checkout, Docker, or user CI, run the released CLI's proposed `scotty init ...` and `scotty doctor --json`, then start a CF Pi and Codex session, Hatch, lifecycle, and cleanup. Also deploy a user-built derived CF image with one extra tool and confirm the selected digest is used. These commands are proposed where syntax is not already established.

**Gate:** authorized no-Docker account spike, image digest/platform inspection, clean install/upgrade, CF native smoke, and archive integrity. If the platform path is unavailable, retain the working CF path and mark distribution blocked; do not claim success or add a hidden transfer credential.

**Cleanup/removal:** only after the gate, remove normal-install Docker/context consumers. Keep maintainer Dockerfiles and development tooling. Receipt includes no-Docker evidence and deletion search.

## S2b — `side-loaded-sandbox-cli`

**Start/current state:** local S2a transfer/deployment inputs and S2b release, verifier, resolver and streaming-cache implementations exist. The integration adds selection authority, signed standard-image compatibility, admission pins and create/restore materialization. No deployed receipt exists. The user authorized final S2b decoupling before the combined live gate: the image no longer owns `/usr/local/bin/scotty`, and managed installation must fail closed rather than fall back.

**Outcome:** each new session automatically selects a separately signed compatible Linux CLI and ensures verified immutable cached bytes before pinning. Create and resume side-load the exact pin before Pi/Codex readiness, including an absolute-path `--version` execution. A CLI-only release can use the same deployed image digest. The executable is not a Settings Tool or a user bundle; a user tool named `scotty` cannot satisfy managed readiness.

**Owner/files:** release/artifact ownership in `scripts/build-cli.mjs`, `scripts/make-cli-release.mjs`, `.github/workflows/release-cli.yml`, and `cli/src/{upgrade,build-info,installation-deployment,commands}.ts`; provisioning precedents in `worker/src/sandbox/{bundle-store,bundle-materializer,config-contracts,config-store,config-object,auth}.ts`; session pinning/create/restore in `worker/src/session-actor/configuration.ts`, `worker/src/session-actor/transitions/{create-sandbox,backup-lifecycle-sandbox}.ts`, and `worker/src/session/object.ts`; native Codex environment in `worker/src/agent/codex/process.ts`. These are inspection/change candidates, not a requirement to modify every file. One bounded writer owns shared session/runtime files.

**Ordered tasks:**

1. Settle the narrow artifact/authority contract before persistence changes. Reuse existing immutable storage, validated staging, CAS/idempotency, and admission-pinning patterns where appropriate, not a generic installer. Record which installation authority owns the active release pointer and how the Session owns its pinned digest; preserve the existing DO ownership split. Measure binary/archive size against existing limits (sandbox gzip bundles currently cap at 48 MiB), target ABI/CPU compatibility, and executable filesystem policy before choosing transport. Sharing a user resource bundle is not assumed.
2. Produce a dedicated runtime Linux/amd64 executable without the host CLI's embedded deployment archive. Bind version, build revision, target, byte size, digest, and compatibility to a signed release artifact. Preserve existing host CLI manifest/updater contracts; do not silently change their schema or command surface. The current host release executable is not automatically the correct sandbox payload.
3. Deployment verifies digest-bound signed standard-image runtime compatibility and injects the evidence and selected image digest into Worker configuration. Every new-session lookup resolves GitHub, then ensures the immutable R2 artifact before committing SandboxConfig's selection. Transaction-issued tickets prevent stale completion rollback. Persist descriptors and verification time, never download/presigned URLs or credentials. Only explicit lookup outage permits a previously verified compatible selection; its cached object must still exist and match. Other lookup/cache errors fail closed. No custom-image metadata inference or attestation UX is included.
4. At session admission, pin the selected artifact. Materialize and verify it in a session-scoped executable location before readiness; expose it explicitly to Pi, terminal commands, and native Codex. Codex currently fixes `PATH` with `extendEnv: false`, so Pi shell wiring alone is insufficient. A user tool with the same name must not satisfy managed-artifact readiness. Do not overwrite a live executable or silently fall back to a stale image binary after installation fails.
5. Preserve live/sleeping session pins in authoritative Session configuration. Resume restores the current backup and checks/rematerializes only that pin under existing lease rules. Missing R2 bytes, incompatible deployed evidence or invalid installed bytes fail typed even when a backup/image/user tool contains a binary. No legacy reader, migration, implicit repinning or running-session updater is included; old unpinned sessions are not converted. Any deployment drain remains separately authorized.
6. Remove image compilation/copy/version inventory and obsolete CLI-only Docker-context inputs before live proof, as explicitly authorized. Preserve the Codex server build stage, pinned Sandbox base, native wrappers, Pi/Codex runtimes and toolchains. Prove locally that the dedicated runtime executable runs on the exact supported base and final image, with `/usr/local/bin/scotty` absent. Then prove a CLI-only upgrade with the deployed container image digest unchanged, including failed-selection retention and stale-completion rollback prevention. Automatic newest-compatible selection does not introduce an activation/rollback endpoint.

**Proof:** extend existing release/upgrade, `cli/effect-test/deployment-inputs.test.ts`, `worker/test/sandbox/{sandbox-bundle-store,sandbox-bundle-materializer}.test.ts`, create/backup/sleep-resume, and native Codex launch tests as applicable. Cover signature/digest/target/size/mode rejection; CAS stale-write/idempotency/rollback; failed staging cleanup; exact admission/restore identity; user-tool collision; and both agents' executable resolution. Run the artifact on the exact supported Linux/amd64 base, not just a host shell. No new test harness.

**Combined S2a/S2b standard-image live gate:** on an authorized test installation, use the released CLI on a Docker-free machine to plan/apply the signed standard-image deployment. Publish approved runtime CLI A; create Pi and Codex sessions and record native tool receipts for managed `command -v scotty`, `scotty --version` and SHA-256. Publish compatible B without redeploying the Container application; new admissions must pin B while A sessions remain A, including supported sleep/resume. Prove lookup-outage fallback reports stale freshness, integrity failure does not downgrade, and a missing pinned object cannot resume. Failure-injection fixtures must be isolated; never mutate a live production cache object. Verify Hatch, native lifecycle and credential isolation. Publication, registry transfer, deployment, sessions and owned cleanup need fresh authorization. Custom-image attestation/proof remains deferred. Binary removal is now a prerequisite to this gate, not evidence that the gate passed.

### Connected implementation and operator handoff

- Signed `runtimeCompatibility` in `scotty-image-manifest.json` binds the final image digest to the Bun compile target/CPU/libc/exact Sandbox base tuple. The released CLI verifies it; Alchemy verifies again before injecting `SCOTTY_CONTAINER_IMAGE_DIGEST` and `SCOTTY_RUNTIME_IMAGE_COMPATIBILITY`. No trust is inferred from image labels. Existing custom-image selectors still deploy as before, but absent trusted evidence their new managed admissions are unsupported.
- Guarded source deployment may pass the signed evidence JSON through `SCOTTY_RUNTIME_IMAGE_COMPATIBILITY`; extract the release manifest's `runtimeCompatibility` unchanged. It must match the explicitly selected `SCOTTY_CONTAINER_IMAGE_DIGEST`. This is evidence delivery, not an unsigned compatibility override. Standard released-CLI selection is automatic and requires no new flag. An init replay re-fetches standard evidence and retains the existing image identity fence.
- SandboxConfig stores `scotty:runtime-cli-selection:1` with issued/committed tickets and the last verified pin. Session configuration stores `runtimeCli: { descriptor, verifiedAt, freshness }`; list/CLI JSON envelopes are unchanged. Freshness is an internal authoritative selection field, not a claim that an outage fallback is latest.
- Fallback accepts transport/timeout lookup errors, HTTP 429 and HTTP 5xx only. Other HTTP statuses (including a missing manifest's 404 or authorization rejection) fail admission rather than quietly reuse an older CLI. Cache download/storage failures do not use the lookup fallback.
- R2 uses the existing retained private `SANDBOX_BUNDLE_BUCKET`, isolated under `runtime-cli/sha256/...`. The stack has no object expiration policy; user bundle APIs address only their own fixed keys. No resource-bundle size limit or new bucket/public route applies. Native single-put limits remain enforced by the streaming cache.
- Session streams R2 bytes through its existing authenticated Sandbox SDK RPC `writeFileStream` boundary to a random staging file. It checks SHA-256, byte size and mode, then hard-links create-only to `/workspace/SESSION/.scotty/runtime-cli/bin/scotty`. Replays verify instead of replacing. Staging cleanup is finalized; transport ambiguity remains typed. The managed directory precedes user/image tools in Pi/terminal PATH and is explicitly set for native Codex's `extendEnv: false` launch.
- Local proof uses synthetic release keys/responses and local storage/host adapters. It is not deployed GitHub trust-root, registry-transfer, SDK transport, native model-turn or full E2E proof. No binary-removal gate has passed. The local Linux process-launch proof uses a probe child through production Codex launch code, not a real Codex model turn.

**Local evidence (2026-09-20):** focused session/lifecycle/Codex/release/compatibility suites, worker/CLI/contracts typechecks, scoped formatting and lint/skills were run for the integration. A local Workerd/Miniflare composition exercised the production GitHub resolver, streaming cache, native R2 adapter, native DO selection transactions and admission configuration resolver: fresh selection committed only verified bytes, outage reused the pin with stale freshness, bad signature failed without replacing authority, and one immutable object remained. GitHub responses and the test trust root were synthetic; no live account or remote R2 was used. Receipt and reproduction inputs: `/tmp/scotty-s2b-integration/{workerd-proof.log,workerd-proof.ts,run-workerd.mjs}`.

The local `linux/amd64` image probe executed the compiled 108,239,168-byte runtime CLI using production materialization commands and production native Codex launch configuration. Pi and the Codex probe child resolved `/workspace/a0b1c2d3e4f5/.scotty/runtime-cli/bin/scotty` and printed `0.3.19`; repeated materialization kept the inode; missing cached bytes failed closed. Receipt: `/tmp/scotty-s2b-integration/linux-proof.log`. The network-disabled ephemeral container was removed. This historical receipt proves local native executable/PATH behavior, not an official released-image identity, real Codex tool turn or authenticated deployed SDK delivery. The later authorized baked-binary removal requires fresh local base/image proof and does not establish deployment proof.

**Next authorized operator sequence:** choose a release tag and user-supplied installation; publish through the guarded release workflow (image evidence plus runtime executable/manifest); use that released CLI's `init` or `deploy --plan --json`, review the exact standard-image digest/account/resources, then explicitly authorize `deploy --yes --json`. Do not substitute an older unsigned image manifest or a custom `--image` selector. Run the existing Pi and Codex verification recipes with owned session IDs, add the managed-path/digest/version assertions above, then repeat admissions after runtime release B without an image rollout. Retain separate receipts for Docker-free installation, native tool turns, sleep/resume, freshness/error injection and cleanup. Do not claim the combined gate from local tests.

**Handoff:** record artifact signature/digest/platform, image digest before/after, authority and session snapshot fields, exact delivery/materialization paths, Pi/Codex invocation evidence, restore/rollback evidence, compatibility policy, old-path removal search, and limits. S4 must re-prove the artifact's target/runtime compatibility on Linux runners rather than assuming CF proof transfers.

## S3 — `mcp-settings`

**Start:** S2a/S2b provide compatible image/install and side-loaded CLI handoffs; Settings has existing CAS/snapshot and Skills/Tools/Extensions UI, but no verified MCP server projection.

**Owner/files:** existing settings schema/store/UI paths (`protocol/cloud-settings.ts`, `worker/src/sandbox/{config-contracts,config-store,config-object}.ts`, `ui/src/data/settings.ts`), `worker/src/agent/codex/process.ts`, `worker/src/sandbox/auth.ts`, and a minimal Pi wrapper only if source verification proves it necessary. `protocol/mcp-settings.ts` is NEW only if ownership cannot fit existing schemas.

**Change:** add adjacent MCP add/edit/remove with revisioned next-session snapshot. Pin a compatible `pi-mcp-adapter` in the image handoff; render actual isolated Codex `CODEX_HOME/config.toml` and verified selected-Pi config. Ordinary env reuses existing validators.

Use existing SandboxConfig CAS and `worker/src/session-actor/configuration.ts` for the pinned snapshot; extend `ui/src/routes/settings.tsx` beside `ResourcesSection.tsx`. Support only a small HTTP URL or local executable/args/ordinary-env format. Verify the adapter's exact pin, public loader, and config precedence; generic Pi `settings.json` is not an established MCP server format. Native Codex's writer is `launchProcess` in `worker/src/agent/codex/process.ts`, not merely the workspace seed. Live and sleeping sessions retain their snapshot.

This session also owns the necessary image dependency/lock/manifest changes after S2a/S2b's handoffs,
and uses S1's release pipeline to verify the adapter is present in the selected image. Subsequent
MCP configuration edits must trigger no image build; prove add/edit/remove through the actual UI.

**User demo:** selected Pi and Codex sessions each load one local stdio fixture and one minimal public/lazy remote fixture, visibly use the tool, and clean up the child. Derived user images own local MCP binaries; there is no installer.

**Gate:** stale revision, unsupported-field rejection, actual config-home load, no ambient project merge, no managed credentials, and shutdown cleanup. No OAuth, approval system, secret inputs, runtime download, or new MCP auth UI.

**Cleanup/removal:** delete only static/incorrect MCP projection code proven replaced; retain Skills/Tools/Extensions ownership. Receipt records adapter source/version, actual file paths, fixtures, and unsupported fields. MCP completion does not imply Linux completion.

## S4 — `linux-native-minimal`

**Start:** S2a/S2b/S3 receipts exist; CF remains working. This session builds and proves the smallest Linux-compatible variant from the existing shared image ingredients if none is already available. Record its exact digest/platform; do not assume the CF image or side-loaded CLI artifact is portable. Reuse S2b's delivery contract and prove runner artifact materialization/identity before readiness. Keep runtime/image ownership in this packet until that gate passes.

**Owner/files:** `protocol/runner.ts`, `worker/src/runner/*`, `worker/src/egress/{worker,session}.ts`, `cli/src/{runner-link,runner-runtime,runner-operation-journal,runner-setup,runner-docker}.ts`, and NEW `worker/src/session-actor/providers/linux-runner.ts`. One integrator owns needed `worker/src/session/object.ts`, `worker/src/index.ts`, and CLI create/request changes for the controlled demo; S5 extends that same path rather than inventing another. Freeze the narrow wire contract before client/server edits; no parallel shared-file writers.

**Change:** implement one vertical path: registered runner, selected native Pi or Codex create, real bounded tool turn, interrupt, and vaporize. Managed assignment broker, server-side generation fencing, offline expiry outside the image, descendant/container cleanup, and credential-free host routing are mandatory here—not deferred contract work. Codex checkpoint remains unsupported.

Current egress trusts CF `OutboundHandlerContext`; a runner-supplied sentinel/session ID cannot replace that identity. Authenticate current assignment/generation and scope managed requests to fixed Pi/Codex/Git destinations, preserving rotation/revocation and bounded streaming. Prove pinned-client TLS/routing before claiming broker support. Keep Ensure/Inspect/Exec/Stop/Remove semantics in the replacement protocol. Enforce the authority deadline outside the session image, including when the supervisor dies while Docker survives; no renewal may extend the Session hard cap.

**User demo:** controlled test installation only, using proposed `scotty beam ... --provider runner --runner <USER_NAME> --agent pi|codex --json`, then inspect, interrupt, and vaporize the returned owned session. No general live admission before S5.

**Gate:** synthetic transport first, then actual pinned Pi/Codex/Git routing; assignment revocation, link loss, supervisor death, expiry, cleanup, and forbidden credential-surface inspection. Native readiness must identify the selected agent, not merely an open container.

**Cleanup/removal:** after real broker proof, replace credential-copy/mount paths and the old wire reader coherently in the candidate code. Production deployment of these removals requires S6's inventory/drain approval. General runner admission stays disabled until S5 proof and S6 cutover; controlled candidate routing is not production enablement. A failed broker, watchdog, or cleanup gate returns a blocked receipt.

## S5 — `linux-resume-hatch-canary`

**Start:** S4 has a controlled create/interrupt/vaporize proof and no unsafe half-admitted sessions.

**Owner/files:** `worker/src/session-actor/provider-executor.ts`, `worker/src/session/object.ts`, `worker/src/session/contracts.ts`, `worker/src/hatch/{gateway,store,contracts,gateway-policy}.ts`, `worker/src/index.ts`, and the existing CLI create boundary; one integrator owns these shared files.

**Change:** add provider-specific current-backup sleep/resume without changing backup invariants, common CF Hatch gateway auth with Linux private tunnel, HTTP/WS, explicit capability results, and CLI selection/readback. Preserve native Pi/Codex support differences; Codex standalone checkpoint stays unsupported. Same-host backup is not silently substituted for authoritative immutable R2.

**User demo:** actual CLI canary for Pi and Codex: create, bounded tool turn, follow-up/interrupt, Hatch HTTP and WS, supported sleep/resume with native identity, then vaporize. Use the maintained smoke recipe plus a new runner recipe; retain exact owned IDs and cleanup proof.

**Gate:** contract suite, CF regression, backup/restore marker, revocation, offline cap, tunnel assignment fencing, HTTP/WS pressure, failure reconciliation, and no-credential inspection. Any missing current backup or native thread fails resume rather than starting a replacement.

**Cleanup/removal:** remove runner-disabled admission and obsolete CF-only routing only after this canary; unsupported terminal/passive/children remain typed and unadvertised. Receipt includes canary evidence, capability matrix, and removal search.

## S6 — `approved-cutover`

**Start:** the selected deliverable has a complete demonstrated receipt chain. Any prerequisite demo still awaiting authorization is blocked, not complete. Earlier CF image/MCP releases require their own approved rollout; this packet audits the final selected release, not retroactively authorizes prior actions.

**Owner:** integration/operator; no broad feature implementation. Audit release manifest, image digest, CLI/skill recipes, old protocol/credential paths, persisted sessions, assignments, backups, archives, and active resources.

**User demo/gate:** run only the selected track's authorized final regression: CF regression; Linux Pi/Codex canary; or S1/S2 distribution install. Publication, deployment, registry actions, and destructive migration require manual approval and are not performed here.

**Cleanup/removal:** prove drain/stop evidence or approved conversion, delete remaining dead code, CLI flags, tests for replaced internals, and stale skill assumptions. No dual reader, silent reset, or unsafe automatic re-enrollment. Update the existing verification skill after live recipes; do not add a harness.

**Definition of done:** users receive the demonstrated outcome for the selected track: working CF image installation, MCP settings for both native agents, or Linux native sessions with brokered credentials, offline hard cap, recovery, Hatch, and cleanup. Daytona is explicitly not included.
