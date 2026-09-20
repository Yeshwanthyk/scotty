# Docker, MCP, then Linux — implementation plan

## Restart here — S1 complete; S2a next, then S2b

Status at the 2026-09-20 planning handoff:

| Packet                                  | Status                                                   |
| --------------------------------------- | -------------------------------------------------------- |
| S1 image publication                    | Complete: `v0.3.19` published and independently verified |
| S2a Docker-free CF install/custom image | Next; source research only; registry transfer unproven   |
| S2b side-loaded sandbox CLI             | Planned; implementation and live proof not started       |
| S3–S6                                   | Not started; preserve the dependency order below         |

**Completed prerequisite:** [release v0.3.19](https://github.com/Yeshwanthyk/scotty/releases/tag/v0.3.19), [successful release run 35465340703](https://github.com/Yeshwanthyk/scotty/actions/runs/35465340703), source revision `7c84770356f09f9cfbe068a1a12aefa218b88653`. The released `scotty-image-manifest.json` identifies the tested `linux/amd64` image at `sha256:83068d1f8bc8cb705a70c379ef5cd33c02dd4f920d3166f415a6baa02c0f39a5`. Resolve its repository/reference from that manifest, not a hardcoded account. Native image checks, anonymous pull, matching configuration/platform, and OCI provenance passed. The signed CLI upgrade manifest and image provenance were also independently verified. See [the final S1 receipt](../s1-image-publication-handoff.md#final-receipt--s1-complete) for evidence and historical repair details. S1 does not prove Docker-free installation or Linux-runner compatibility.

### Fresh-session procedure

1. Read `AGENTS.md`, this plan, and the final S1 receipt. Check `git status`, fetch current main, and create a new S2 branch from main containing the release revision above. At handoff the checkout is still `fix/image-attestation-home`; the plan and `.quickdiff/` are untracked and the S1 handoff has local documentation changes. Preserve these files and user comments; do not reset or clean them away.
2. Start S2a with a read-only feasibility scout of **Docker-free transfer into the user's target Cloudflare registry**. Source inspection already distinguishes Alchemy's Docker-based remote-image path from its Docker-free target-registry `prepushed` path; this is not end-to-end installation proof. Read [CLI/image coupling research](../scotty-cli-image-coupling-research.md) and [provisioning research](../scotty-cli-provisioning-research.md), then recheck pinned source and official registry APIs/tooling. Return the supported transfer/authentication path, actual Docker invocation chain, and smallest account-spike proof. If no supported path exists, report the blocker before implementing a workaround. Read-only S2b design can proceed in parallel; implementation/proof remain separate packets.
3. Keep the main thread as orchestrator: delegate a bounded implementation to one writer, then independent verification with exact checks. Use current runtime preferences and approval routing. The previous bounded repair used Sol medium for implementation and Luna high for verification; Astra medium is not a prerequisite. Jev may judge a bounded report, but does not replace tests or authorize execution.
4. Complete each packet's local checks before requesting its live proof. Obtain a user-supplied installation name and fresh authorization for registry writes, publication, deployment, custom-image rollout/drain, or destructive cleanup. Prior S1 publication approvals are finished; keep the existing deployment intact. This planning session performed source research and documentation changes only, not implementation or deployment. Research notes are also local work to preserve.

**New requested scope:** S2b side-loads the Scotty CLI into the sandbox, analogous to skills/capabilities provisioning—not necessarily in the same bundle or as a user-managed tool. CLI-only updates must not require rebuilding or rolling out the container image. Deployment selects and delivers a verified artifact; session preparation installs the pinned artifact before agent readiness. Silent updates to running or sleeping sessions are not requested.

**Deferred, not a prerequisite:** broad CI duration/conditional image reuse optimization remains separate. S2b must prove CLI-only delivery using an unchanged image digest, but does not redesign all CI caching. Until S2b removes the image-owned CLI, its source/version remain image inputs. Afterwards, account for all remaining native runtime, dependency, and tool-inventory inputs. Reused images retain their original build revision/provenance and require compatibility/availability checks.

## Scope and order

This is the single active plan for this work. It is self-contained; superseded plans have been removed. Each implementation session must recheck the named source and current tests rather than rely on prior conversation history.

Delivery order is deliberately vertical: **Docker/image maintenance first, MCP second, Linux third**. Daytona is explicitly out of scope: do not research it, add adapters, or perfect a future provider contract. It can be reconsidered in a separate plan.

Each packet is one fresh implementation session, one bounded commit/review, and one demonstrated user outcome. Labels are session IDs, not time estimates. A fresh session reads this document and `AGENTS.md`, not prior transcripts. No code, skill, test, deployment, or external-provider action is performed by this plan.

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

**Start:** S1's released `v0.3.19` manifest is available, but CLI installation still uses the local Docker/repository-context path. S2a is not implemented; begin with the registry-transfer feasibility scout above.

**Owner/files:** `cli/src/deployment-packaging.{ts,mjs}`, `cli/src/installation-deployment.ts`, `infra/cloudflare-stack.ts`, `cli/src/commands.ts`, and existing archive tests. Inspect compiled CLI ownership in `scripts/build-cli.mjs`. Read pinned Alchemy `ContainerProvider`/`ContainerApplication`; do not edit vendor.

**Change:** make released CLI deployment select the approved image digest and prove the actual Alchemy/platform prebuilt path. An image field alone is insufficient: the current pull/tag/push path must not be mistaken for Docker-free installation. Preserve archive/assets and current CF runtime behavior.

Verify `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/{ContainerApplication,ContainerProvider}.ts`: remote references invoke Docker pull/tag/push; an image already in the target Cloudflare registry takes the `prepushed` path without those operations. See `ContainerProvider.ts` image strategy selection and `buildAndPushImage`, plus `vendor/alchemy/website/src/content/docs/cloudflare/compute/containers.mdx`. This only proves the deployment leg. S1's public image is not automatically available in every user's target registry.

**Ordered tasks:** (1) establish a supported authenticated transfer into the user's target registry without local Docker or user-run CI; (2) verify immutable source/destination identity, platform, transfer retry/failure behavior, and credential isolation; (3) supply that target digest through Alchemy's public image API while removing normal-install Docker preflights/context work only after proof; (4) run clean-install/upgrade and custom-image live gates. Resolve account identity from authorized runtime context, never repository constants. Do not add hidden shared registry credentials or a second Container reconciler. If transfer is unsupported, stop and record the blocker; a manually prepushed image alone does not satisfy the fresh-user demo.

CF has one deployed Container application image today: custom-image selection requires an approved deployment/drain, not an assumed per-session override. Preserve existing session data and require restore compatibility before rollout. User image authors may use build tooling to produce their derived image; the normal installer must not require it.

**User demo:** on a fresh machine with no repository checkout, Docker, or user CI, run the released CLI's proposed `scotty init ...` and `scotty doctor --json`, then start a CF Pi and Codex session, Hatch, lifecycle, and cleanup. Also deploy a user-built derived CF image with one extra tool and confirm the selected digest is used. These commands are proposed where syntax is not already established.

**Gate:** authorized no-Docker account spike, image digest/platform inspection, clean install/upgrade, CF native smoke, and archive integrity. If the platform path is unavailable, retain the working CF path and mark distribution blocked; do not claim success or add a hidden transfer credential.

**Cleanup/removal:** only after the gate, remove normal-install Docker/context consumers. Keep maintainer Dockerfiles and development tooling. Receipt includes no-Docker evidence and deletion search.

## S2b — `side-loaded-sandbox-cli`

**Start:** S2a's compatible image/install receipt exists. Today `worker/container/Dockerfile` compiles the CLI and copies it to `/usr/local/bin/scotty`; CLI/version changes are image inputs. Source-only research is linked in the restart procedure; no side-loading path has been implemented or proven.

**Outcome:** deployment/provisioning delivers a separately verified Linux CLI artifact, and session preparation side-loads it inside the sandbox before Pi/Codex readiness. A CLI-only release can use the same image digest. “Like skills/capabilities” describes side-loading, not a requirement to put the executable in the skills bundle or Settings Tools. Do not make a user resource named `scotty` the managed artifact authority.

**Owner/files:** release/artifact ownership in `scripts/build-cli.mjs`, `scripts/make-cli-release.mjs`, `.github/workflows/release-cli.yml`, and `cli/src/{upgrade,build-info,installation-deployment,commands}.ts`; provisioning precedents in `worker/src/sandbox/{bundle-store,bundle-materializer,config-contracts,config-store,config-object,auth}.ts`; session pinning/create/restore in `worker/src/session-actor/configuration.ts`, `worker/src/session-actor/transitions/{create-sandbox,backup-lifecycle-sandbox}.ts`, and `worker/src/session/object.ts`; native Codex environment in `worker/src/agent/codex/process.ts`. These are inspection/change candidates, not a requirement to modify every file. One bounded writer owns shared session/runtime files.

**Ordered tasks:**

1. Settle the narrow artifact/authority contract before persistence changes. Reuse existing immutable storage, validated staging, CAS/idempotency, and admission-pinning patterns where appropriate, not a generic installer. Record which installation authority owns the active release pointer and how the Session owns its pinned digest; preserve the existing DO ownership split. Measure binary/archive size against existing limits (sandbox gzip bundles currently cap at 48 MiB), target ABI/CPU compatibility, and executable filesystem policy before choosing transport. Sharing a user resource bundle is not assumed.
2. Produce a dedicated runtime Linux/amd64 executable without the host CLI's embedded deployment archive. Bind version, build revision, target, byte size, digest, and compatibility to a signed release artifact. Preserve existing host CLI manifest/updater contracts; do not silently change their schema or command surface. The current host release executable is not automatically the correct sandbox payload.
3. During explicit deployment/provisioning, verify and upload the immutable artifact before CAS activation. Authentication stays at the owner/deployment boundary; no managed credentials, ambient auth files, or registry credentials enter artifacts, container files, R2 metadata, or logs. Failed upload/verification/activation must not advance the active pointer. Rollback selects a previously verified artifact, not an overwritten object.
4. At session admission, pin the selected artifact. Materialize and verify it in a session-scoped executable location before readiness; expose it explicitly to Pi, terminal commands, and native Codex. Codex currently fixes `PATH` with `extendEnv: false`, so Pi shell wiring alone is insufficient. A user tool with the same name must not satisfy managed-artifact readiness. Do not overwrite a live executable or silently fall back to a stale image binary after installation fails.
5. Preserve live/sleeping session pins. Resume must restore or rematerialize the exact pinned artifact under the existing lease/backup rules; missing or incompatible artifacts produce a typed failure, never a lookup of latest. Record how pre-change persisted sessions retain their behavior or require an approved drain; do not silently rewrite their configuration. No running-session auto-updater is included.
6. Prove a CLI-only upgrade and rollback with the container image digest unchanged. Only then remove image compilation/copy/version inventory and obsolete CLI-only Docker-context inputs from `worker/container/Dockerfile`, `worker/container/toolsets/standard.json`, `cli/src/deployment-packaging.{ts,mjs}`, and affected packaging/image checks. Preserve inputs shared with the native Codex server or other image-owned tools. Pi/Codex runtimes, native wrappers, and toolchains remain image-owned.

**Proof:** extend existing release/upgrade, `cli/effect-test/deployment-inputs.test.ts`, `worker/test/sandbox/{sandbox-bundle-store,sandbox-bundle-materializer}.test.ts`, create/backup/sleep-resume, and native Codex launch tests as applicable. Cover signature/digest/target/size/mode rejection; CAS stale-write/idempotency/rollback; failed staging cleanup; exact admission/restore identity; user-tool collision; and both agents' executable resolution. Run the artifact on the exact supported Linux/amd64 base, not just a host shell. No new test harness.

**User demo/gate:** on an authorized test installation, provision CLI A, create Pi and Codex sessions and invoke `scotty --version`; provision CLI B using the same container image digest and show new sessions use B while existing sessions retain A. Prove supported sleep/resume retains A, failed provisioning leaves the previous active version, and rollback changes only subsequent admissions. Verify Hatch/native lifecycle regression and credential isolation. Release/publication, deployment, image-binary removal rollout, and owned-session cleanup need fresh authorization.

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
