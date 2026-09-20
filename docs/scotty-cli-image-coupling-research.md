# Scotty CLI image-coupling research

## Scope and conclusion

Read locally: `AGENTS.md`, `docs/plans/multi-provider-session-plan.md`, and `docs/s1-image-publication-handoff.md`, plus the Dockerfile, deployment/release packaging, signed-manifest code, image gates, sandbox bundle/session code, Alchemy source, and focused tests. No deployment, registry, provider, or network mutation was performed. No source code was changed; this report is the only new file.

**Conclusion:** the in-container `scotty` command is currently an image-owned binary. The Dockerfile copies CLI source into a build stage, compiles it, and copies the result to `/usr/local/bin/scotty` (`worker/container/Dockerfile:4,19-32,202`). The final image gate checks its mode, version, and command inventory (`worker/container/Dockerfile:286-300`). Consequently, a CLI source/version change is an image input and rebuild.

The smallest safe decoupling is an **image-independent, release-managed executable tool in the existing sandbox bundle**, delivered/activated during installation provisioning and materialized for new sessions. Do not make the container fetch an arbitrary binary at startup. Do not use Alchemy's prebuilt-image path for this goal: that avoids local Docker but remains an image rollout (`vendor/alchemy/packages/alchemy/src/Cloudflare/Containers/ContainerProvider.ts:42-53,431-459,522-544`).

There is one important refinement: do not blindly reuse the normal host release executable. `scripts/build-cli.mjs` embeds the deployment archive before compiling the four host assets (`scripts/build-cli.mjs:41-105`), while the current image compiles `cli/scotty.ts` directly (`worker/container/Dockerfile:19-32`). A runtime/container CLI should be a separately identified Linux x64 artifact, built without the deployment archive, and signed/hashed under an explicit runtime-artifact manifest or an explicitly extended versioned manifest. This avoids putting host deployment packaging and authority-shaped commands into session containers.

## Current artifact and coupling map

### Image path

- `worker/container/Dockerfile:4` pins the Cloudflare Sandbox base image. Lines `7-16` install the runtime dependency context; lines `19-27` copy CLI, skills, infrastructure, protocol, worker, and package sources; lines `28-32` build the Codex server and CLI.
- Lines `34-57` pin Node, Pi, and other tool versions. Lines `202-210` copy the compiled CLI, Codex server, Pi packages, tool inventory, and session wrappers into the final image.
- Lines `242-250` label the image with revision, platform, Sandbox, Containers, Alchemy, Pi, Codex, and Node compatibility. There is no CLI artifact digest/version label in this tuple.
- `cli/src/deployment-packaging.ts:19-82` classifies `cli/scotty.ts`, `cli/src`, `worker/src`, and runtime assets as deployment/container inputs. `cli/src/deployment-packaging.mjs:73-82,107-120,307-319` discovers CLI build inputs, materializes the Docker context, and checks the context budget.
- `cli/effect-test/deployment-inputs.test.ts:120-163,275-324` asserts Dockerfile COPY ownership, the final `scotty --version` check, the command inventory, and the pinned Codex packaging. `scripts/check-container-image.test.mjs:148-175,355-390` asserts the full Docker command sequence and the `Scotty CLI` inventory entry.

### Host release path and signed manifests

- `scripts/build-cli.mjs:75-105` creates the embedded deployment archive, validates critical entries, and compiles standalone assets with build metadata. The release workflow builds four assets (`.github/workflows/release-cli.yml:33-93`) and checks the Linux x64 artifact's version, commit, clean state, and `embeddedDeployment: true` (`:72-88`).
- `scripts/make-cli-release.mjs:18-58` requires exactly `darwin/linux` × `arm64/x64`, hashes each executable, and signs `{version, releaseTag, assets}` with Ed25519.
- `cli/src/upgrade.ts:13-48,126-238` strictly decodes the manifest, canonicalizes fields, verifies the Ed25519 signature, selects a platform/architecture, and verifies the selected SHA-256. `cli/src/upgrade-host.ts:91-233` downloads the manifest/asset, checks the digest, probes `--version`, and atomically replaces the host executable. This updater is host-only; it does not update a container or a session bundle.
- `scripts/make-image-release.mjs:124-177` creates a separate image manifest. It binds the image digest, configuration digest, revision, platform, compatibility tuple, and provenance, but not the CLI executable's version or digest.
- The release jobs are independently coupled: the image job needs `verify`, not the four-platform `build` job (`.github/workflows/release-cli.yml:33-37,95-112`); the final GitHub Release waits for both image verification and CLI attestation (`:322-371`). The S1 handoff records this explicitly at `docs/s1-image-publication-handoff.md:36,50-52`.

### Image checks and version coupling

- `worker/container/toolsets/standard.json:209-216` declares `Scotty CLI`, source `first-party compiled CLI`, and pinned `expectedVersion: 0.3.19`.
- `scripts/check-container-image.mjs:481-493` runs every inventory command and checks expected versions. `:822-847` builds the image and runs Pi, native supervisor, Codex, native adapter, packaging, toolchain, Corepack, download, inventory, skills, and size checks. Thus changing the CLI without rebuilding the image creates either stale behavior or a failed version gate.
- The image gate proves image-owned native Pi/Codex/runtime behavior, not delivery of a separately provisioned CLI. The only source matches for `/usr/local/bin/scotty` are the Dockerfile and its packaging/image tests; no worker lifecycle code currently invokes it. It is a user/tool surface, not the Pi/Codex supervisor.

## Deployment delivery versus session startup

**Deployment artifact delivery today:** `scripts/build-cli.mjs` embeds an archive for the host CLI. `cli/src/installation-deployment.ts:448-499` extracts that archive (or uses the source tree) and prepares `.alchemy/scotty-container-context`; `:1213-1278` does this before plan/apply. `infra/cloudflare-stack.ts:52-59,329-335` gives Alchemy the Docker context and Dockerfile. This is build/deploy input delivery, not a file copy into an already-running session.

**Existing skills/tools delivery:** the sandbox bundle already accepts `skills`, `packages`, `tools`, and `extensions` (`cli/src/sandbox-roots.ts:7-14`). `cli/src/sandbox-bundle-builder.ts:94-105,172-210,277` supports a file-shaped executable tool and records mode/digest metadata. `protocol/sandbox-bundle.ts:1-46` maps file tools to `tools/<name>`. `cli/src/sandbox-sync.ts:145-175` uploads the immutable gzip bundle with `If-Match` and an idempotency key. The Worker validates and stores it through `/api/sandbox/bundles/:digest` (`worker/src/index.ts:790-825`); R2 keys are content-addressed and create-only in `worker/src/sandbox/bundle-store.ts:3-8`.

**Session startup:** create resolves and pins the active bundle digest (`worker/src/session/object.ts:1251-1265,1293-1363`), materializes it into a session-specific root (`worker/src/sandbox/bundle-materializer.ts:203-253`), and passes its items/root to the sandbox transition (`worker/src/session-actor/transitions/create-sandbox.ts:409-450`). For Pi, `worker/src/sandbox/auth.ts:119-195,314-320,524-560` validates tool paths and prepends the bundle tools directory to `PATH`; this is the closest existing equivalent to “delivered like skills.”

There are two limits:

1. The active bundle is not applied to existing sessions. A session keeps its pinned digest; access/resume calls `ensurePiSession` (`worker/src/session/object.ts:3172-3191`) and do not refresh or replace the materialized bundle.
2. Codex receives a bundle's skills link in `worker/src/agent/codex/process.ts:224-226`, but the inspected Codex launch path does not add bundle `tools` to `PATH`. If the CLI must be callable from Codex-launched processes as well as the Pi terminal, `worker/src/agent/codex/process.ts` and its launch tests are an additional required change. If terminal/Pi only is intended, the existing tool-path mechanism is sufficient.

## Recommended bounded design

1. Build a dedicated `scotty-runtime-linux-x64` (name illustrative) release asset from the direct CLI entrypoint, without the embedded deployment archive. Require `--version` and `--build-info` to prove the target, release revision, and `embeddedDeployment: false`.
2. Sign its exact bytes and target (`linux/amd64`) with the existing Ed25519 trust root, or add an explicit `runtimeAssets` field to a versioned manifest. Keep the current four host assets and host updater contract unchanged.
3. During `init`/provisioning after the Worker endpoint is available, verify the signed manifest and SHA-256, place the verified executable as a file-shaped `tool` named `scotty`, and activate a new sandbox bundle through the existing CAS/R2 path. The bundle should carry the release identity/digest in its manifest or associated provisioning record; do not infer identity from a username, repository, registry, or account.
4. Leave Pi, Codex, native wrappers, toolchains, and the image inventory as image-owned dependencies. The bundle CLI must not receive real Codex/GitHub credentials or deployment credentials; `AGENTS.md:7-12` remains an invariant.
5. Resolve the command through the bundle `PATH`, not by replacing `/usr/local/bin/scotty`. If absolute `/usr/local/bin/scotty` semantics are required, this design is insufficient and a separate container-init/overlay contract is needed; that is materially larger and riskier.

### Compatibility, integrity, platform, and rollback requirements

- Reject non-Linux/non-x64 assets before upload; run the binary in a Linux amd64 proof environment and verify executable mode and `--version`.
- Verify schema, target uniqueness, release tag, Ed25519 signature, SHA-256, maximum artifact/bundle size, and deterministic bundle digest. The existing verifier provides most primitives but no runtime-artifact distinction (`cli/src/upgrade.ts:13-48,178-253`).
- Add an explicit CLI/runtime compatibility field or gate. The image compatibility labels do not cover the CLI (`worker/container/Dockerfile:242-250`; `scripts/make-image-release.mjs:124-177`). Keep protocol/server/Pi/Codex changes image-coupled unless separately proven compatible.
- Preserve immutable old R2 bundles and CAS activation. A failed upload or activation must leave the prior active digest; new sessions use the new digest only after successful activation. Rollback is a pointer change to the previous digest, not an in-place file overwrite. Existing sessions must retain their old digest.
- Do not claim running-session upgrades. A later packet would need an operation-lease-controlled stop/reseed/restart or an explicit session upgrade state machine, with failure reconciliation. Never mutate a running session's bundle root in place.

## Likely impacted files and checks

**Runtime artifact/release:** `scripts/build-cli.mjs` (or a new narrowly scoped runtime build script), `.github/workflows/release-cli.yml`, `scripts/make-cli-release.mjs`, `cli/src/upgrade.ts`, `cli/src/build-info.ts`, and focused upgrade/build-info tests. Keep the image manifest separate unless it gains an explicit, verified pointer to the runtime asset.

**Provisioning/bundle:** `cli/src/installation-deployment.ts` and/or `cli/src/commands.ts` for the post-deploy provisioning hook; a small release-asset verifier/service; `cli/src/sandbox-bundle-builder.ts` and `cli/src/sandbox-sync.ts`; existing route/config contracts only if the runtime artifact needs explicit metadata. For Codex availability, also `worker/src/agent/codex/process.ts` and its tests. Existing bundle tests already cover executable tools (`cli/effect-test/sandbox-bundle-builder.test.ts:36-54,100-157`) and sync (`cli/effect-test/sandbox-sync.test.ts:14-109`); extend them for release identity, rollback, and CAS conflicts. Add/extend `worker/test/sandbox/sandbox-bundle-store.test.ts`, `worker/test/sandbox/sandbox-bundle-materializer.test.ts`, `worker/test/session-actor/create-sandbox.test.ts`, and `worker/test/integration/routes.test.ts`.

**Image decoupling:** after the new path is proven, remove the CLI build/copy and CLI inventory expectation from `worker/container/Dockerfile`, `worker/container/toolsets/standard.json`, `cli/src/deployment-packaging.{ts,mjs}`, `scripts/check-cli-clean-room.mjs`, `scripts/check-container-image.mjs`, `scripts/check-container-image.test.mjs`, and `cli/effect-test/deployment-inputs.test.ts`. Keep image checks for native Pi/Codex and all other image-owned tools. Do not remove the current path before a fresh-session provisioning proof.

Required proof should include: signed Linux runtime asset verification; deterministic executable bundle and mode; CAS/idempotency/rollback; a fresh installation provisioning a new Pi session and running `scotty --version`; a Codex test if Codex PATH support is included; absence of credentials in artifact/bundle/process surfaces; image check without a CLI rebuild; and a negative test proving existing sessions remain on their pinned digest. Full deployment, registry, and live-session upgrade proofs require separate authorization.

## S2 fit and evidence limits

This fits better as a **separate bounded “CLI artifact decoupling” packet (S2a/sibling)**, not as an implicit part of S2. S2 is explicitly the Docker-free Cloudflare installation and Alchemy prebuilt-image feasibility gate (`docs/plans/multi-provider-session-plan.md:83-97`); the plan separately says image-reuse optimization must account for embedded CLI/version and remain separate unless explicitly requested (`:18-22`). The packet can later provide S2's provisioning hook, while S2 independently proves image selection and rollout/restore compatibility.

Evidence limits: this is source/test inspection only. No fresh image build, signed runtime artifact, deployed installation, public pull, R2/Worker activation, Linux amd64 session, Codex tool-path proof, running-session upgrade, rollback, or Alchemy account spike was performed. The S1 release receipt proves the existing `v0.3.19` image publication and four host CLI manifests, not this proposed delivery shape (`docs/s1-image-publication-handoff.md:5-15,44-52,170-174`).
