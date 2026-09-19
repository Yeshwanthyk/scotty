# S1 image-publication handoff

## Boundary and state

- Base/initial HEAD: `b9955b36019f2b1f25e90bd45a2c5942085da69b` on `feat/s1-image-publication`.
- Start: the Cloudflare image was built and tested in PR CI, but the tag release had no image publication, public-pull gate, image provenance, or image release manifest.
- Local verification milestone: implementation and independent review completed without registry writes, deployment, credential access, or account/installation inference. The user-owned untracked `docs/plans/multi-provider-session-plan.md` was not changed. Subsequent commit, branch push, and PR CI are user-authorized; image publication, release tags, merge, and deployment are not.
- Scope: S1 only. S2+, Linux runner work, MCP, and Daytona remain excluded.

## Changed files

- `.github/workflows/release-cli.yml`
- `worker/container/Dockerfile`
- `scripts/check-container-image.mjs`
- `scripts/check-container-image.test.mjs`
- `scripts/check-cli-clean-room.test.mjs`
- `scripts/make-image-release.mjs` (new)
- `scripts/make-image-release.test.mjs` (new)
- `docs/s1-image-publication-handoff.md` (new)

`.github/workflows/ci.yml` and `scripts/make-cli-release.mjs` remain unchanged. The signed CLI upgrade manifest still covers exactly the four executables.

Review-only metadata: `.quickdiff/comments.json` contains the user's open comment and an explanatory reply. The new Docker labels describe existing CF dependencies; they do not install them or claim Linux-runner compatibility. S4 still owns the separately proven Linux image variant.

## Result

The tag release now has an `image` publication job targeting the `image-release` GitHub Environment. It also requires the maintainer-configured `SCOTTY_IMAGE_PUBLICATION_AUTHORIZED=publish-public-image` variable before any build. The workflow cannot prove that the Environment already exists or has required reviewers; that remains maintainer configuration, not an implementation claim. The job builds `linux/amd64` once with the existing `check:container-image` path, exercises the 15-case native Codex suite against that same local tag, records its configuration digest, and only then enters the Docker Hub login/push step. Maintainers supply the repository through `vars.SCOTTY_DOCKERHUB_REPOSITORY` and credentials through `secrets.SCOTTY_DOCKERHUB_{USERNAME,TOKEN}`; no identity is committed. Login uses `--password-stdin`. The first job step creates a private Docker configuration from `RUNNER_TEMP` and exports it through `GITHUB_ENV`, before Buildx or login can run; cleanup after attestation and guarded `if: always()` cleanup remove the exact job-specific `RUNNER_TEMP` path without depending on successful environment export.

The immutable registry digest is parsed from the completed `docker push --platform linux/amd64` record. There is no post-push lookup through the mutable tag. The job attests that exact digest and passes only non-secret repository, digest, tested configuration digest, and attestation URL outputs to dependent `image-verify`.

`image-verify` runs on a fresh Ubuntu runner with a distinct Docker configuration initialized in its first step from `RUNNER_TEMP` through `GITHUB_ENV`. The initializer removes any prior path and creates an empty private directory; the pull step also asserts that no Docker credential file exists. It anonymously pulls the immutable digest, requires its configuration digest, `linux/amd64` platform, and decoded compatibility labels to match the tested artifact, and cryptographically verifies the OCI provenance with `gh attestation verify`. Verification binds the expected source repository, `.github/workflows/release-cli.yml` signer, tag ref, source commit, hosted runner, and SLSA provenance predicate. Only after all those checks does it emit and upload the `scotty-image-manifest.json` CI artifact. Guarded `if: always()` cleanup removes the exact anonymous configuration path even if writing `GITHUB_ENV` failed.

The image job depends on `verify`, not on the independent four-platform CLI build. Therefore an authorized run can publish a registry image, and successful `image-verify` can upload the image-manifest CI artifact, even if the independent CLI build or executable attestation later fails. Those artifacts are not rolled back. Only the final GitHub Release requires both `attest` and `image-verify`; a failure in either prevents that release.

The image and manifest retain the exact compatibility tuple: Scotty release tag/revision, Cloudflare Sandbox package plus pinned base-image digest, `@cloudflare/containers`, Alchemy, Pi, Codex plus archive SHA-256, Node, and `linux/amd64`. Docker labels make the tuple inspectable after a digest pull. The official Cloudflare Sandbox entrypoint, current tools, Hatch, native Pi/Codex behavior, and local Docker/context installation path are unchanged.

The release helper uses module-scoped Effect Schema decoders for the allow-listed manifest environment and Docker-inspection label JSON. Malformed JSON, null/array values, missing labels, non-string labels, invalid digest/platform/revision/tag/URL values, and mismatched public/tested configuration digests fail closed; extra inspection fields are discarded and never enter the release manifest.

## Intended authorized maintainer demo

1. Create and protect the `image-release` GitHub Environment with required reviewers; this repository does not assert that it already exists or is protected.
2. Configure `SCOTTY_IMAGE_PUBLICATION_AUTHORIZED=publish-public-image` and `SCOTTY_DOCKERHUB_REPOSITORY=index.docker.io/<maintainer-namespace>/<public-repository>` as environment variables, and configure the two environment secrets named above.
3. After review, push an already-approved `vMAJOR.MINOR.PATCH` tag and observe the release workflow.
4. On another machine without Docker Hub credentials, download `scotty-image-manifest.json`, then run. GitHub CLI authentication is separately required for `gh attestation verify`; CI supplies only a step-scoped `GH_TOKEN` for verification, not Docker Hub credentials.

```sh
image_ref="$(jq -r .image.reference scotty-image-manifest.json)"
test "$(jq -r .image.platform scotty-image-manifest.json)" = linux/amd64
DOCKER_CONFIG="$(mktemp -d)" docker pull --platform linux/amd64 "$image_ref"
docker image inspect "$image_ref" --format '{{.Os}}/{{.Architecture}} {{json .Config.Labels}}'
gh attestation verify "oci://$image_ref" \
  --bundle-from-oci \
  --repo <source-owner>/<source-repository> \
  --signer-workflow github.com/<source-owner>/<source-repository>/.github/workflows/release-cli.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --source-digest <release-commit-sha> \
  --deny-self-hosted-runners
```

The resulting real digest, manifest, and attestation URL are the S1 publication receipt. None is fabricated or recorded here.

## Baseline package metadata repair

- Initial failing native CI: [run 35454641687](https://github.com/Yeshwanthyk/scotty/actions/runs/35454641687) at `69c7acf27665d15ff4c7eb469578acea30f24d4c`. Its `container-image` job passed the full `npm run check:container-image` and 15-case `check:codex-native-workflows` gates, and `cli-clean-room` passed. The `check` job failed at `npm run check:pi-packages`: indexed `scotty-browser-test` sources hashed to `081f82ac1f4e1175dba3af90d1843c131f0babc5ac522915e242510cd7fa1078`, while the manifest retained `ca843cd91735fac2c13017d15d34c8eed416e10a0e4cc3cf7a80f95568d6426b`.
- The checker hashes every staged ordinary file under the source directory in Git index order, including mode, relative path, byte length, and blob bytes. The hashed inventory is 11 files: `.gitignore`, `LICENSE`, `README.md`, `index.test.ts`, `index.ts`, `package-lock.json`, `package.json`, `runner.smoke.test.ts`, `runner.test.ts`, `runner.ts`, and `tsconfig.json`.
- History establishes the divergence: commit `0ff88cf8e30b3db7c965e30b9c92ea4ebe1a635c` refreshed the manifest to `ca843…`, which exactly hashes that commit's 11-file source tree. Intended commit `af6db27b9a54b792eb9c34bde499be581984e761` then changed `README.md`, `index.ts`, and `index.test.ts` together to restore inline evidence and correct capture ownership/instructions, with matching source tests, but did not refresh the manifest. That commit's tree, S1 base `b9955b36019f2b1f25e90bd45a2c5942085da69b`, and current HEAD all hash identically to `081f…`; the source inputs did not change during S1.
- The repair changes only `worker/container/pi-packages/manifest.json`, replacing the stale browser-test digest with the proven current indexed-source digest. No package source, runtime payload, package set, checker, dependency, or tool behavior changed; therefore the already-passed native image result remains the relevant runtime proof and no image rebuild was repeated.

## Verification

Formatting ran before lint. Exact local commands and results:

- `npx oxfmt --disable-nested-config --write .github/workflows/release-cli.yml docs/s1-image-publication-handoff.md scripts/check-cli-clean-room.test.mjs scripts/check-container-image.mjs scripts/check-container-image.test.mjs scripts/make-image-release.mjs scripts/make-image-release.test.mjs` — passed.
- `./node_modules/.bin/oxfmt worker/container/pi-packages/manifest.json docs/s1-image-publication-handoff.md` — passed for the metadata repair.
- `npm run check:pi-packages` — reproduced the CI mismatch before the edit, then passed after the manifest-only correction: 0 externally vendored, 2 first-party, and 0 pinned npm Pi packages.
- `node --test scripts/check-pi-packages.test.mjs worker/container/pi-packages/sources/scotty-browser-test/index.test.ts` — passed, 16/16.
- `npm run lint:skills` — passed; 38 rule sources, 8 diagnostic skill references, and 9 required skills verified.
- `npm run lint` — passed with no warnings.
- `node --test scripts/check-cli-clean-room.test.mjs scripts/check-container-image.test.mjs scripts/make-image-release.test.mjs` — passed, 18/18, including executable cleanup checks for normal initialization and failed `GITHUB_ENV` export.
- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release-cli.yml")'` — parsed successfully.
- `npm run typecheck` — Worker, contracts, CLI, and lab passed; UI then failed because the existing local install cannot resolve `mermaid` from `ui/src/components/MermaidDiagram.tsx`.
- `npm run test:ops` — passed: 235 tests, 213 passed, 22 skipped, 0 failed.
- `npm run check:container-image` — Docker 29.2.1 built and loaded the `linux/amd64` image, and the preceding Pi/native/package probes ran; the full gate failed under local amd64-on-arm64 QEMU when Node 24/libuv aborted during the pnpm toolchain probe (`uv__io_poll: Assertion 'errno == EEXIST' failed`). This is not asserted as a complete image-gate pass.
- `npm run check:codex-native-workflows` — passed independently against that exact loaded image, 15/15 native Codex cases.
- `docker run --rm --platform linux/amd64 --network=none --entrypoint du scotty-container:ci -sbx /` — measured `3546092078` bytes, below the existing 3,660 MiB budget.
- `docker image inspect scotty-container:ci ...` — confirmed `linux/amd64` and the expected Pi `0.84.0`, Codex `0.154.0`, and revision labels.
- `git diff --check` — passed.

Both earlier background terminals settled: the combined image/native gate failed at the QEMU pnpm probe, and the independent native gate exited 0. The expensive image build was not repeated for the workflow-only review fixes. No reviewer-provided `actionlint` executable remained in PATH, Homebrew, the repository, `/private/tmp`, or the current user's temporary/cache/bin directories. The official v1.7.12 Darwin arm64 release was downloaded to a temporary directory and `actionlint .github/workflows/release-cli.yml` passed; the temporary directory was then removed. The pinned `actions/attest-build-provenance` action definition and the installed `gh 2.83.2` `attestation verify` flags were inspected read-only before wiring verification.

## Parent integration review

- Re-ran all 18 focused tests, formatting, lint, workflow YAML parsing, `actionlint` v1.7.12, and `git diff --check`; passed.
- Corrected the push parser against [Moby's tagged push record](https://github.com/moby/moby/blob/v28.5.2/daemon/containerd/image_push.go): `<tag>: digest: sha256:... size: ...`. It rejects a mismatched release tag, missing record, or multiple records. Tests use that source-backed output format; a live push remains unrun.
- Added step-scoped `GH_TOKEN` after checking [GitHub CLI verification](https://github.com/cli/cli/blob/v2.83.2/pkg/cmd/attestation/verify/verify.go): `--bundle-from-oci` does not disable the CLI authentication check. Registry pull remains anonymous and isolated from this GitHub API token.
- Inspected the local image directly: `linux/amd64`, revision label `development`. This is local image proof, not an immutable release-commit receipt.

## Inventory, removals, and follow-on

- Image consumers found: the Alchemy `ContainerPlatform` context in `infra/cloudflare-stack.ts`, CLI deployment context preparation in `cli/src/deployment-packaging.{ts,mjs}`, compiled CLI input ownership in `scripts/build-cli.mjs`, clean-room/image/native checks, and the new maintainer release job.
- Pinned Alchemy `ContainerApplication.ts` and `ContainerProvider.ts` were inspected read-only. No provider, registry framework, reconciler, dependency, vendor file, local install path, tool, or image consumer was removed.
- CF tool impact: none intended; the same current image is labeled and published, not minimized or replaced in deployment configuration.
- Cleanup IDs/resources: none; no external resources were created.
- S2 prerequisite: an authorized run must supply a real public digest, successful anonymous pull, matching configuration/platform evidence, and verifiable provenance. S2 must then prove Alchemy's prebuilt remote-image path on a fresh Docker-free installation before removing any local context/build path.

## Evidence limits

Fresh-runner anonymous pull, registry publication, cryptographic OCI provenance verification, GitHub Environment existence/protection, and maintainer release publication are **BLOCKED pending explicit authorization and configuration**. No live digest, push record, attestation receipt, or public manifest exists from this work. Local success is not a deployment or publication claim.

## Independent review acceptance

The independent verifier accepted the local implementation for user-authorized PR CI after repairing invalid job-level `runner.temp` expressions, testing initializer-failure cleanup against actual workflow snippets, and correcting partial-publication wording. Final focused checks passed 18/18; formatting, lint, YAML parsing, and checksum-verified actionlint v1.7.12 passed. This accepts the local patch for native Linux CI, not S1 publication completion. The user authorized committing the scoped S1 files, pushing `feat/s1-image-publication`, and opening a PR against `main`; `.quickdiff/` and the user-owned plan remain outside the commit.
