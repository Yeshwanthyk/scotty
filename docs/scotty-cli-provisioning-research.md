# Scotty CLI in-container provisioning research

> Research only. No implementation, deployment, or provider action was performed. Repository state was preserved. Research date: 2026-09-19.

## Executive finding

The in-container `scotty` is currently an image-owned executable, not a separately provisioned asset. `worker/container/Dockerfile:19-32` copies the CLI source into a build stage, compiles it with `bun build ... --compile`, and verifies it; `worker/container/Dockerfile:202` then copies the result to `/usr/local/bin/scotty`. The final image checks its mode and version at `worker/container/Dockerfile:292-303`. Therefore a CLI-only change currently changes the Docker build context and image, and requires an image rollout.

The existing “skills delivery” machinery is a useful integrity and lifecycle precedent, but it does not currently deliver a provider-owned CLI. Cloud resources support `skill`, `package`, `tool`, and `extension` only (`worker/src/sandbox/config-contracts.ts:25-71`). A `tool` is put on the session shell's `PATH` (`worker/src/sandbox/auth.ts:132-195,308-331,519-561`), whereas skills are symlinked into the merged Codex/Pi skill tree (`worker/src/sandbox/skill-commands.ts:17-33`). That path is user-controlled global configuration, so a user resource named `scotty` must not silently become the authoritative Scotty executable.

**Recommendation:** split the feature from the broad S2 image rollout. First prove S2's Docker-free deployment using Alchemy's target-registry digest path. Then add a small provider-owned CLI-artifact pointer and provisioning seam, reusing the existing content-addressed bundle, validation, staging, and session-pinning primitives. Publish an immutable Linux/amd64 CLI artifact before activating its pointer; materialize it only for new sessions that pin that exact digest; expose it from a session-scoped writable directory rather than overwriting `/usr/local/bin`. Existing live and sleeping sessions retain their pinned artifact. Do not add a generic installer or reconciler, and do not silently upgrade a running session.

## What is delivered today

### Host CLI and deployment archive

The standalone release embeds `scotty-deployment.tar.gz`. The catalog includes CLI source, worker source, skills, infrastructure, prebuilt Worker bundles, the Dockerfile, and patches (`cli/src/deployment-packaging.ts:19-59`). It does **not** contain a separately defined compiled Linux CLI payload for session provisioning. `scripts/build-cli.mjs:41-85` validates and archives the project inputs; `scripts/build-cli.mjs:87-110` embeds that archive into the host executable.

At deploy time, `cli/src/installation-deployment.ts:439-479` extracts the embedded archive to a temporary root and requires prebuilt Worker entries. `:497-499` then prepares `.alchemy/scotty-container-context`. This archive is deployment/build input, not a runtime session artifact. The image budget inspection itself invokes Docker (`cli/src/deployment-packaging.mjs:273-304`). The current command path also checks Docker during init (`cli/src/commands.ts:928-934`) and deploy (`:1423-1438`). Thus a standalone CLI with an embedded archive proves clean-room packaging, but not a Docker-free Cloudflare install.

The two embedded skills are a different local-CLI feature: `cli/src/embedded-scotty-skill.ts:5-39` embeds and reads `SKILL.md` files from the compiled host executable. This does not transfer those files, or the host executable, into a session.

### Session resource delivery

The actual session path is:

1. Resource files are decoded and bounded. `worker/src/sandbox/cloud-resources.ts:22-56` rejects credential-like paths; `:125-184` validates safe paths, file sizes, total size, executable/regular mode, required `SKILL.md`, and per-file digests.
2. The bundle contains a deterministic archive and manifest. `worker/src/sandbox/bundle-store.ts:3-9,68-81` uses digest-addressed R2 keys and checks size, content type, and digest metadata. `:114-182` performs create-only writes for the archive and manifest; it does not overwrite a different object at the same digest.
3. Activation is CAS/idempotent. `worker/src/sandbox/config-store.ts:189-225` rejects stale revisions, accepts an idempotent replay, and commits the new active digest in the Durable Object transaction.
4. The session pins the active bundle at admission. `worker/src/session-actor/configuration.ts:9-30` explicitly says cloud edits do not change a session's pinned configuration. `worker/src/session-actor/transitions/create-sandbox.ts:409-451` materializes the pinned digest and passes its items/root into seed; `:493-528` records a fenced runtime materialization marker.
5. `worker/src/sandbox/bundle-materializer.ts:148-190,203-242` writes to a staging tree, validates gzip/TAR/digest/member type, writes a verified marker, and promotes a digest-specific root. The existing promotion is `rm -rf final && mv staging final` (`:192-201`): safe enough for a new digest-specific root, but not an appropriate in-place replacement strategy for a named live executable.

This makes an executable `tool` technically possible: `modeClass: "executable"` is preserved by the manifest and archive path, and `auth.preflight` checks tool existence (`worker/src/sandbox/auth.ts:441-479`). It is not sufficient as the product contract because the active bundle is global, user-editable configuration and `SandboxBundleItemKindSchema` has no provider-owned CLI identity (`worker/src/sandbox/config-contracts.ts:25-71`). The resource mutation route rebuilds and activates that user-controlled bundle (`worker/src/index.ts:671-730`). It also does not prove that the native Codex process sees the tool: `worker/src/agent/codex/process.ts:224-230` links only the bundle's skills, and `:252-265` launches with `extendEnv: false` and a fixed `/usr/local/bin:/usr/bin:/bin` PATH. This is a design constraint, not an assumption that a shell `PATH` change reaches Codex.

## Deployment and Docker-free distinction

Scotty currently declares an external Dockerfile/context in `infra/cloudflare-stack.ts:52-59` and passes those fields to `Cloudflare.Containers.ContainerPlatform` at `:329-337`. That is the external-image build path.

The pinned Alchemy source distinguishes four internal strategies. `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerProvider.ts:42-76` defines `external`, `remote`, and `prepushed`; `:429-461` recognizes a target-registry reference and selects `prepushed`; `:522-620` shows the consequences:

- `prepushed`: resolve the digest and use it as-is; no Docker pull, build, or push (`:532-546`).
- `remote`: Docker pull/tag, then push (`:549-559` and `:611-618`).
- `external`: Docker build from the supplied context (`:560-574`).
- effectful builds also materialize a context and invoke Docker (`:575-608`).

The public API documents the same distinction in `vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerApplication.ts:274-325` and the public guide `vendor/alchemy/website/src/content/docs/cloudflare/compute/containers.mdx:175-201`: a Docker Hub/other remote image is still pulled and re-pushed, while a digest already under `registry.cloudflare.com/<account>/<repo>@sha256:...` is deployed as-is. A local provider remains Docker-oriented; this is a remote deployment distinction, not a promise that local development or image inspection is Docker-free.

So the supported Docker-free prebuilt path is: CI or an already-authorized publisher pushes a tested `linux/amd64` image to the target Cloudflare registry, and the released CLI selects that exact target-registry digest. Merely adding an `image` property containing a public image reference is still Docker-dependent. S2's own plan makes this explicit (`docs/plans/multi-provider-session-plan.md:83-97`) and says custom-image selection is one deployed Container application requiring readiness/drain, not a per-session override (`:89-97`).

The runner path is intentionally different and remains Docker-dependent: `cli/src/runner-docker.ts:128-155` executes `/usr/bin/docker`, and `cli/src/runner-setup.ts:119-137` requires Docker and `gh`. The plan says runner-backed creation remains disabled until native transport/lifecycle proof (`AGENTS.md:11-13`; `docs/plans/multi-provider-session-plan.md:119-133`). This research does not treat that path as an alternative to Cloudflare provisioning.

## Minimal supported delivery path

1. **Release one explicit artifact.** Build a separate, pinned `linux/amd64` Scotty CLI executable from the release source, with a release manifest containing CLI version/build revision, target/ABI, byte size, mode, and SHA-256. Do not reuse a developer's host binary: the release pipeline produces different host targets, and compatibility with the Cloudflare Sandbox base must be proven inside the exact image/runtime. The current image is explicitly `linux/amd64` (`worker/container/Dockerfile:241-251`), while the existing Codex package is separately pinned to `x86_64-unknown-linux-musl` and verified in `cli/effect-test/deployment-inputs.test.ts:298-327`; neither fact proves the Bun CLI artifact's libc/CPU compatibility.
2. **Publish before activation.** The deploy CLI may carry the release artifact as a separately embedded file or release archive entry, but the Worker cannot read a local host file by magic. Deployment must upload it through an authenticated owner operation before changing the provider-owned active pointer. Reuse the existing immutable R2/bundle storage and validation patterns (`worker/src/sandbox/bundle-store.ts:114-182`; `worker/src/sandbox/bundle-materializer.ts:148-242`) rather than creating a generic installer. Measure the executable against the existing 48 MiB gzip limit (`worker/src/sandbox/bundle-store.ts:3-4,184-219`) before committing to the shared bundle format; if it does not fit, use a provider-owned artifact object with the same digest/metadata rules, not an unverified download.
3. **Use provider ownership, not a user `tool` convention.** Store an `activeScottyCli` digest/version pointer in the installation/session configuration authority, or an equivalent narrow provider-owned release record. Do not let `/api/resources/tool/scotty` control it. The generic resource endpoint is user-resource delivery (`worker/src/index.ts:671-730`, and `cli/src/commands.ts:2072-2103`), and the current schemas permit a tool with that name. A small provider-specific pointer/materializer extension is within this feature; a generic installer/reconciler is not.
4. **Materialize session-scoped and read-only.** During create, after the session has admitted its pinned configuration, materialize `.scotty/scotty-cli/<digest>/scotty` (or an equivalent digest-specific root), verify archive digest, member digest, regular-file type, executable mode, platform metadata, and `scotty --version`, then expose that exact path to the terminal environment. Do not write `/usr/local/bin/scotty` at runtime: its image ownership and runtime-user/writeability are not established, and in-place replacement would make rollback ambiguous. Use the existing staging/verified-marker approach, but keep old digest roots and atomically create/rename a selector only if a selector is needed.
5. **Pin it at admission.** Extend the same admission snapshot principle as `SessionConfiguration` (`worker/src/session-actor/configuration.ts:9-30`) with the CLI artifact digest/version. The create materialization marker must include and fence that digest alongside bundle/runtime identity (`worker/src/session-actor/transitions/create-sandbox.ts:31-43,716-758`). Existing image-baked `/usr/local/bin/scotty` can remain as a compatibility fallback during rollout, but the fallback must not silently hide a failed provider artifact installation.
6. **Define agent reach explicitly.** The terminal shell can receive a provider CLI path through the existing environment construction (`worker/src/sandbox/auth.ts:308-331,519-561`). Native Codex needs a separate, explicit launch-path decision because its isolated launch links skills but fixes its environment (`worker/src/agent/codex/process.ts:224-255`). Do not claim “available to agents” until an exact Pi/Codex invocation test proves it.

### Failure, rollback, and credentials

Upload and validate the immutable artifact first; update the provider pointer with CAS/idempotency second; only then admit sessions using it. If either upload, validation, install, version probe, or pointer commit fails, leave the previous pointer unchanged. R2's create-only behavior and config CAS provide the required primitives; old immutable objects need not be deleted for rollback. A rollback is a pointer change to a previously verified digest, not an overwrite.

A session install must fail closed: clean its staging directory, retain the prior verified digest if one exists, and never report success after an ambiguous write or process probe. The executable is code, not a credential. Do not include Codex/GitHub credentials, sentinels, auth files, Git config, or credential references in its archive, manifest, image props, R2 metadata, or deployment logs. The existing sensitive-path checks (`worker/src/sandbox/cloud-resources.ts:22-56,150-168`) are useful defense-in-depth but cannot substitute for provider ownership and artifact provenance.

## Live, sleeping, and resumed sessions

- **New session:** pin the artifact digest at admission and materialize/probe that digest before supervisor readiness. A latest lookup after admission is forbidden.
- **Live session:** do not upgrade it in place. If the image itself changes, the existing deployment code already requires authenticated session-readiness preflight before a changed Container rollout (`cli/src/installation-deployment.ts:908-939`) and waits for rollout afterward. A CLI-only artifact should avoid that installation-wide rollout by being new-session-only.
- **Sleeping session:** sleep must preserve the pinned digest. The backup path stops/quiesces Pi before sync and backup (`worker/src/session-actor/transitions/backup-lifecycle-sandbox.ts:288-342`), creates a confirmed backup (`:344-424`), and resume restores only the current owned backup (`:427-454`). Do not replace the artifact while asleep merely because a newer release exists.
- **Resume:** restore the exact pinned artifact or prove that the digest-specific materialization is still present, then start the supervisor and verify readiness/transport. The existing sequence is explicit in `worker/src/session-actor/transitions/backup-lifecycle-sandbox.ts:487-539,600-665` and `:1246-1385`. Missing artifact, incompatible platform, or version mismatch must be a typed resume failure/reconciliation state, not a fresh “latest” install or a success from uncertain provider state.

## Exact test ownership and proposed S2 split

Existing tests already cover the pieces to extend:

- Packaging/archive ownership: `cli/effect-test/deployment-inputs.test.ts:75-171,173-234,256-351`; this currently proves Dockerfile/archive coverage, pinned image-side executables, and mode/version checks, not dynamic CLI delivery.
- Immutable storage and lost-response behavior: `worker/test/sandbox/sandbox-bundle-store.test.ts:78-207`.
- Archive/materialization digest, staging, and cleanup behavior: `worker/test/sandbox/sandbox-bundle-materializer.test.ts:86-208` and the remaining materializer cases in that file.
- Resource path/mode/sensitive-file contracts: `worker/test/sandbox/cloud-resources.test.ts:8-68`.
- Create fencing/readiness: `worker/test/session-actor/create-sandbox.test.ts:205-260` and its create provider cases.
- Backup/restore ownership and exact supervisor stop/start: `worker/test/session-actor/backup-lifecycle-sandbox.test.ts:122-280`.
- Sleep/resume phase ordering and proofs: `worker/test/session-actor/checkpoint-sleep-resume.test.ts:139-247` and its resume cases below.
- Existing image regression: `scripts/check-container-image.test.mjs:32` and the checks it invokes; this must remain an image fallback/regression test, not the artifact-delivery proof.

The exact new focused checks should be added beside those owners, not as a new harness:

1. A release/packaging test proves the provider Linux artifact has a manifest, fixed target, digest, executable mode, and no credential material; it also proves host deployment can publish it without invoking Docker.
2. A storage/config contract test proves create-only artifact upload, digest/size metadata verification, CAS activation, idempotent replay, stale-pointer rejection, and pointer rollback without overwriting an old artifact.
3. A materializer test proves staged executable installation, digest/version/platform mismatch failure, cleanup, and retention of the old verified version.
4. Create tests prove the artifact digest is admitted, materialized, probed, and included in the create marker; the generic user `tool` named `scotty` must not satisfy this proof.
5. Backup/sleep/resume tests prove the exact digest survives a confirmed snapshot and restore, and that missing/incompatible artifacts fail typed rather than resolving latest.
6. A real Linux/amd64 test in the exact Cloudflare image/base proves the compiled artifact starts and `--version` works. A shell-only test is insufficient; current `deployment-inputs` tests do not establish libc/CPU compatibility.
7. The no-Docker S2 account spike must exercise a target-registry digest. `scripts/check-cli-standalone-deploy.mjs:186-250` is useful clean-room/cleanup evidence, but its current failure proof is not a no-Docker successful deployment proof.

**Scope decision:** S2 should contain the Docker-free Cloudflare image-selection proof and, at most, the artifact format/compatibility spike and contract tests needed by the next packet. Full provider-owned CLI provisioning should be a separate S2b (or a clearly separate packet before S3 if S3 requires it). It crosses session admission, create, backup/restore, native Codex launch, artifact authority, and Linux binary compatibility; combining it with custom-image rollout risks treating an installation-wide image change as a per-session update. S2 must not claim completion until the target-registry path is proven; CLI provisioning must not claim completion until the lifecycle and exact Linux execution tests pass.

## Uncertainties that require proof

- Whether the release-built Bun `linux/amd64` executable is compatible with the exact Cloudflare Sandbox base's libc and runtime user.
- Whether its compressed artifact fits the existing R2 bundle limit and Worker upload limits.
- Whether the runtime user can execute (not write) session materialized files and whether any supervisor/Codex sandbox policy blocks them.
- Whether “in-container CLI” means terminal/Pi shell only or native Codex tool execution too; current Codex launch behavior does not answer that.
- Whether a provider-owned CLI pointer belongs in SandboxConfig authority or a separate installation release record without violating the existing DO ownership split. This must be decided before persistence changes; it must not become a second generic reconciler.
- The exact deployment credential/owner operation for uploading the release artifact is not present in the current deployment path. The archive is extracted locally today (`cli/src/installation-deployment.ts:448-479`); no source inspected here proves that the Worker can consume a new archive member without an explicit upload operation.

These are evidence gaps, not assumptions. No deployment or live-session upgrade should proceed until each is resolved by the focused tests and an authorized account proof.
