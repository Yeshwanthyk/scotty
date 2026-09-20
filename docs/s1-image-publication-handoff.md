# S1 image-publication handoff

## Final receipt — S1 complete

The `v0.3.19` release completed successfully on 2026-09-19. This receipt supersedes all pre-release/unrun statements in the historical sections below.

- Final repair [PR #261](https://github.com/Yeshwanthyk/scotty/pull/261) merged after green CI. Release source revision: `7c84770356f09f9cfbe068a1a12aefa218b88653`.
- [Release run 35465340703](https://github.com/Yeshwanthyk/scotty/actions/runs/35465340703): **success**, including `verify`, native image build/tests/publication, four CLI builds, executable attestations, `image-verify`, and final release.
- [Public release v0.3.19](https://github.com/Yeshwanthyk/scotty/releases/tag/v0.3.19), published `2026-09-19T19:59:52Z`: four Darwin/Linux arm64/x64 executables, `scotty-image-manifest.json`, and `scotty-upgrade-manifest.json`.
- Image platform: **`linux/amd64` only**. Registry digest: `sha256:83068d1f8bc8cb705a70c379ef5cd33c02dd4f920d3166f415a6baa02c0f39a5`. Configuration digest: `sha256:5900adac481951b50f27d3787d1bc88e5387a9d348857fcbfe2a0392ddc16f24`. Obtain the full repository/reference from the published image manifest; maintainer account configuration remains outside source.
- [Image provenance attestation](https://github.com/Yeshwanthyk/scotty/attestations/48674388). Fresh-runner `image-verify` anonymously pulled the actual layers, matched platform/configuration/compatibility labels, and cryptographically bound provenance to the source repository, release workflow, tag, source SHA, and hosted runner.
- Independent post-release checks passed: release manifest tag/revision/platform/digest and four-CLI inventory; Ed25519 upgrade-manifest signature using the repository release public key and canonical encoding; `gh attestation verify --bundle-from-oci` with the expected signer workflow, `refs/tags/v0.3.19`, source SHA, and `--deny-self-hosted-runners`. Registry verification used a temporary Docker config containing exactly `{"auths":{}}` plus a newline, mode `0600`; the config was removed. Scratch evidence was saved under `/tmp/scotty-v0319-receipt.eCG7b3`; durable release/run links above are the restart evidence.
- No deployment or teardown occurred. Existing installation behavior is unchanged. Retain failed `v0.3.17`/`v0.3.18` tags and the partial `v0.3.18` image; use the completed `v0.3.19` manifest for S2.

**Next:** [S2 in the active plan](plans/multi-provider-session-plan.md#s2--cf-no-docker-install), starting with the pinned Alchemy Docker-free feasibility scout. S1 publication authority does not authorize S2 infrastructure changes.

## Historical boundary and state

- Base/initial HEAD: `b9955b36019f2b1f25e90bd45a2c5942085da69b` on `feat/s1-image-publication`.
- Start: the Cloudflare image was built and tested in PR CI, but the tag release had no image publication, public-pull gate, image provenance, or image release manifest.
- Release-repair milestone: current branch `fix/dockerhub-release-auth` starts from merged main `3ae60daa41b243a61a6b205a819fbdf3f5a9dd28`. The failed `v0.3.17` tag remains immutable and must not be moved or removed. The user explicitly authorized local repair and preparation of `v0.3.18`; only the parent operator owns commit, push, PR, merge, tag, and external release actions. This repair performed no registry write, deployment, credential read, or account/installation inference. The user-owned untracked plan and `.quickdiff/` remain unchanged.
- Scope: S1 only. S2+, Linux runner work, MCP, and Daytona remain excluded.
- Current repair boundary: branch `fix/image-attestation-home` starts at merged `v0.3.18` commit `ccf53e63d4be7bc94d8647eef82e42208d24706d`. After independent review, the user authorized the parent to commit/push the repair PR, merge after green CI, and publish `v0.3.19` through the existing release configuration. No teardown or deployment is authorized. Local repair work accessed no credentials and changed no dependencies, vendor files, existing tags, or the published `v0.3.18` image.

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

Current `v0.3.19` repair writes are bounded to `.github/workflows/release-cli.yml`, `scripts/make-image-release.test.mjs`, the root version fields in `package.json` and `package-lock.json`, the Scotty `expectedVersion` in `worker/container/toolsets/standard.json`, and this handoff.

Review-only metadata: `.quickdiff/comments.json` contains the user's open comment and an explanatory reply. The new Docker labels describe existing CF dependencies; they do not install them or claim Linux-runner compatibility. S4 still owns the separately proven Linux image variant.

## Result

The tag release now has an `image` publication job targeting the `image-release` GitHub Environment. It also requires the maintainer-configured `SCOTTY_IMAGE_PUBLICATION_AUTHORIZED=publish-public-image` variable before any build. The workflow cannot prove that the Environment already exists or has required reviewers; that remains maintainer configuration, not an implementation claim. The job builds `linux/amd64` once with the existing `check:container-image` path, exercises the 15-case native Codex suite against that same local tag, records its configuration digest, and only then enters the Docker Hub login/push step. Maintainers supply the repository through `vars.SCOTTY_DOCKERHUB_REPOSITORY` and credentials through `secrets.SCOTTY_DOCKERHUB_{USERNAME,TOKEN}`; no identity is committed. Login uses `--password-stdin`. The first job step creates an owned private publication root at `RUNNER_TEMP/scotty-image-publication`, with `DOCKER_CONFIG` at its `.docker` child, before Buildx or login can run. `HOME` points at that root only for login/push, image attestation, and logout; build and test steps retain the runner home. Normal and guarded `if: always()` cleanup remove the entire owned root, including after initialization or attestation failure.

The immutable registry digest is parsed from the completed `docker push --platform linux/amd64` record. There is no post-push lookup through the mutable tag. The job attests that exact digest. Only fixed-format digest and tested configuration digest remain job outputs. Repository configuration is re-read and revalidated from the `image-release` Environment by `image-verify`; the attestation URL crosses jobs through a one-day artifact, avoiding output masking when a secret username is also the repository namespace.

`image-verify` runs on a fresh Ubuntu runner with a distinct owned root at `RUNNER_TEMP/scotty-anonymous-verification`. Its `.docker/config.json` is explicitly initialized to exactly `{"auths":{}}` plus one newline, mode `0600`. Immediately before both public pull and provenance verification, the guard compares a boolean for those exact bytes and emits only a generic error on mismatch; it never parses or prints unexpected credential content. `HOME` is step-scoped to the anonymous root for those two clients; ambient runner and Podman fixtures therefore cannot supply registry credentials. It anonymously pulls the immutable digest, requires its configuration digest, `linux/amd64` platform, and decoded compatibility labels to match the tested artifact, and cryptographically verifies the OCI provenance with `gh attestation verify`. Verification binds the expected source repository, `.github/workflows/release-cli.yml` signer, tag ref, source commit, hosted runner, and SLSA provenance predicate. Only after all those checks does it emit and upload the `scotty-image-manifest.json` CI artifact. Guarded `if: always()` cleanup removes the entire anonymous root even if writing `GITHUB_ENV` failed.

The image job depends on `verify`, not on the independent four-platform CLI build. Therefore an authorized run can publish a registry image, and successful `image-verify` can upload the image-manifest CI artifact, even if the independent CLI build or executable attestation later fails. Those artifacts are not rolled back. Only the final GitHub Release requires both `attest` and `image-verify`; a failure in either prevents that release.

The image and manifest retain the exact compatibility tuple: Scotty release tag/revision, Cloudflare Sandbox package plus pinned base-image digest, `@cloudflare/containers`, Alchemy, Pi, Codex plus archive SHA-256, Node, and `linux/amd64`. Docker labels make the tuple inspectable after a digest pull. The official Cloudflare Sandbox entrypoint, current tools, Hatch, native Pi/Codex behavior, and local Docker/context installation path are unchanged.

The release helper uses module-scoped Effect Schema decoders for the allow-listed manifest environment and Docker-inspection label JSON. Malformed JSON, null/array values, missing labels, non-string labels, invalid digest/platform/revision/tag/URL values, and mismatched public/tested configuration digests fail closed; extra inspection fields are discarded and never enter the release manifest.

## Prior `v0.3.18` authorized maintainer plan

This pre-run plan is retained as history, not a current verification recipe, and is superseded by the final receipt. Its empty-directory Docker config recipe was strengthened in `v0.3.19` to an explicit empty-auth file used by both clients, as described under Result.

1. For `v0.3.18`, the user explicitly waived required reviewers on the `image-release` Environment; this explicit operator consent replaces the proposed reviewer-protection gate for this release only.
2. The user reports that `SCOTTY_IMAGE_PUBLICATION_AUTHORIZED`, `SCOTTY_DOCKERHUB_REPOSITORY`, and both named Docker Hub secrets are configured. Their values were not read and live authentication remains unverified.
3. The parent operator subsequently pushed the approved `v0.3.18` tag. The failed `v0.3.17` tag remained unchanged.
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

The intended complete receipt was a real digest, manifest, and attestation URL. The later run produced only the digest recorded below; it produced no manifest or attestation receipt.

## Baseline package metadata repair

- Initial failing native CI: [run 35454641687](https://github.com/Yeshwanthyk/scotty/actions/runs/35454641687) at `69c7acf27665d15ff4c7eb469578acea30f24d4c`. Its `container-image` job passed the full `npm run check:container-image` and 15-case `check:codex-native-workflows` gates, and `cli-clean-room` passed. The `check` job failed at `npm run check:pi-packages`: indexed `scotty-browser-test` sources hashed to `081f82ac1f4e1175dba3af90d1843c131f0babc5ac522915e242510cd7fa1078`, while the manifest retained `ca843cd91735fac2c13017d15d34c8eed416e10a0e4cc3cf7a80f95568d6426b`.
- The checker hashes every staged ordinary file under the source directory in Git index order, including mode, relative path, byte length, and blob bytes. The hashed inventory is 11 files: `.gitignore`, `LICENSE`, `README.md`, `index.test.ts`, `index.ts`, `package-lock.json`, `package.json`, `runner.smoke.test.ts`, `runner.test.ts`, `runner.ts`, and `tsconfig.json`.
- History establishes the divergence: commit `0ff88cf8e30b3db7c965e30b9c92ea4ebe1a635c` refreshed the manifest to `ca843…`, which exactly hashes that commit's 11-file source tree. Intended commit `af6db27b9a54b792eb9c34bde499be581984e761` then changed `README.md`, `index.ts`, and `index.test.ts` together to restore inline evidence and correct capture ownership/instructions, with matching source tests, but did not refresh the manifest. That commit's tree, S1 base `b9955b36019f2b1f25e90bd45a2c5942085da69b`, and current HEAD all hash identically to `081f…`; the source inputs did not change during S1.
- The repair changes only `worker/container/pi-packages/manifest.json`, replacing the stale browser-test digest with the proven current indexed-source digest. No package source, runtime payload, package set, checker, dependency, or tool behavior changed; therefore the already-passed native image result remains the relevant runtime proof and no image rebuild was repeated.

## v0.3.17 release preparation

- Final PR #258 CI [run 35455568839](https://github.com/Yeshwanthyk/scotty/actions/runs/35455568839) passed `check`, `cli-clean-room`, and `container-image` at `297752e`; PR #258 then merged as `33979efb6974cb6cced47b11197c7949fe5e99ba`.
- The release bump changes the root package version, both root lockfile version fields, current image-release test fixtures, and the container inventory's first-party `scotty` expected version from `0.3.16` to `0.3.17`. The toolset metadata expansion was explicitly approved because a fresh image gate compares `scotty --version` with that inventory value. Dependencies, lockfile dependency resolution, CLI manifest/signature format, image runtime, and package behavior remain unchanged.
- A `v0.3.17` tag triggers both the public Docker Hub image path and the four-executable CLI GitHub Release path. It does not deploy Scotty infrastructure or sessions. The tag did not exist on the remote when preparation was authorized; this local work neither created nor pushed it.
- Required-reviewer protection is intentionally waived for this release by explicit user consent. The user reports the image-release variables and both secret names are configured, but no value or credential was accessed. Docker Hub authentication, push, public pull, immutable identity, provenance verification, and final GitHub Release remain live gates, not completed evidence.

## Failed v0.3.17 and v0.3.18 repair

- Release run [35457343003](https://github.com/Yeshwanthyk/scotty/actions/runs/35457343003) failed in the image job with Docker CLI/server 28.0.4. `docker login index.docker.io` reported success but stored credentials under the noncanonical `index.docker.io` key; Docker normalized the subsequent Hub push to `https://index.docker.io/v1/`, found no matching credentials, and did not produce a push digest. The downstream `image-verify` and final release jobs were skipped. Logs inspected read-only: `/tmp/scotty-v0317-image-job.log` and `/tmp/scotty-v0317-release-failed.log`.
- The diagnosis is source-backed by Docker CLI v28.0.4 `cli/command/registry/login.go`, `cli/command/registry.go`, and `cli/config/credentials/file_store.go`, plus a credential-free Go reproduction against that version's file store. The repair uses canonical default-Hub `docker login --username … --password-stdin` and `docker logout`, with no registry server argument. Synthetic executable workflow coverage proves exact arguments and token-only stdin.
- The failed run also logged `Skip output 'repository' since it may contain secret.` because the secret Docker username was also a substring of the repository. The workflow no longer publishes repository or attestation URL as job outputs. `image-verify` joins `environment: image-release`, reads `vars.SCOTTY_DOCKERHUB_REPOSITORY` directly, validates it before pull, has no Docker secrets or login, and retains an empty isolated Docker configuration for anonymous pull. Digest and tested image ID remain outputs because both are strictly generated SHA-256 identities. The attestation receipt uses a short-lived artifact and is schema-validated before manifest creation.
- Release metadata advances coherently to `0.3.18`: root package version, both root lockfile fields, current image-release fixtures, and the first-party Scotty tool inventory expectation. No dependency resolution, CLI signature contract, image runtime, or package behavior changes. A `v0.3.18` tag still triggers both public Docker Hub and CLI GitHub Release paths and performs no deployment.
- The user explicitly waived required reviewers and authorized `v0.3.18` preparation/publication after independent review and green CI. Environment variables and secret names are reported configured, but their values and live validity were not accessed. No publication completion is claimed.

## `v0.3.18` live outcome and `v0.3.19` credential repair

- Release run [35460582518](https://github.com/Yeshwanthyk/scotty/actions/runs/35460582518) built and tested the native image; all four CLI builds and CLI attestations passed. Canonical Docker login and push passed. Docker Hub serves the immutable public `linux/amd64` image digest `sha256:c195eaf6f13f51b59fa51893fdceff01a1fc428e2be565f8c3e419179a21de6c`. Image attestation then failed while requesting the Docker Hub `pull,push` token with HTTP 401, so `image-verify` and the final GitHub Release were skipped. The existing `v0.3.18` image and both failed release tags remain untouched; no complete release is claimed.
- The pinned `actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a` delegates to `actions/attest@daf44fb950173508f38bd2406030372c1d1162b1`. That exact action lock resolves `@sigstore/oci` `0.6.0` with SRI `sha512-baUn8bajz7x4sN/I80vWaw6vOEcuU0RmADr+67BK6a3lTpD9Rjt4t21vKr+3qe4BBtSXyKa7gFPCPlqEtDBOPw==`; a freshly downloaded package tarball matched the lock SRI. Its `dist/credentials.js` hard-codes `os.homedir()/.docker/config.json` and ignores `DOCKER_CONFIG`. The workflow had put the intended canonical Docker Hub credential only in an isolated custom Docker config, while the action read the ambient runner home. A synthetic execution of that exact pinned function selected the ambient credential when `HOME` differed, then the intended credential when `HOME` was aligned with the owned publication root. No real credential was used or printed.
- Upgrading the action alone is not the repair: the exact lock for repository-pinned `actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6` (`v4`) resolves `@sigstore/oci` `0.7.2` with SRI `sha512-dhqphH/gjg8IFB0xAeD1Ppb/aSNwA2HUG+7A5mVJwiZt6rn5YoYMVc+esZREdhQLZ1H4JFyGZlTQXaZYx/l7yQ==`. A fresh tarball matched that SRI, and its `dist/credentials.js` retains the same home-only lookup. The bounded fix instead aligns `HOME` with the existing isolated config only for the publication/authentication and image-attestation steps and removes the complete owned root on every path.
- GitHub CLI `2.83.2` uses `go-containerregistry` `0.20.7`'s `authn.DefaultKeychain`. A temporary Go probe imported that exact version and populated synthetic credentials in ambient `$HOME/.docker/config.json`, `REGISTRY_AUTH_FILE`, and `$XDG_RUNTIME_DIR/containers/auth.json`; with the explicit `DOCKER_CONFIG/config.json` equal to `{"auths":{}}`, resolution remained anonymous. This proves local client selection only, not a remote anonymous pull or registry policy.
- Release metadata is prepared consistently at `0.3.19`: root package version, both root lockfile version fields, current image-release fixtures, and the first-party Scotty tool inventory expectation. There are no dependency-resolution or runtime changes. The user subsequently authorized parent-owned `v0.3.19` publication after fresh PR CI passes.

## Verification

Formatting ran before lint. Exact local commands and results:

Current `v0.3.19` repair checks:

- `./node_modules/.bin/oxfmt --disable-nested-config --write .github/workflows/release-cli.yml scripts/make-image-release.test.mjs package.json package-lock.json worker/container/toolsets/standard.json docs/s1-image-publication-handoff.md` — passed before lint; only the allowed files were targeted.
- `npm run lint:skills && npm run lint` — passed with no warnings.
- `node --test scripts/make-image-release.test.mjs scripts/check-cli-clean-room.test.mjs scripts/check-container-image.test.mjs` — passed, 20/20. This executes the workflow initializers, canonical synthetic login/logout, token-only stdin, exact root cleanup after normal and failed `GITHUB_ENV` export, step-scoped home assertions for publication/attestation, and the explicit anonymous config shape. A polluted config containing synthetic auth fails before either Docker or `gh`, and neither its username, password, nor base64 auth appears in stdout/stderr. These stubs do not contact a registry or prove remote authentication.
- `npx vitest run cli/effect-test/command-tree.test.ts` — passed, 14/14, including the CLI version path.
- The metadata probe confirmed `0.3.19` in root package metadata, both root lockfile fields, and the Scotty inventory. Credential-free CLI release probes rejected `v0.3.18`; `v0.3.19` passed tag validation and stopped at the intentionally empty four-asset directory before any signing key read.
- Official `actionlint` v1.7.12 Darwin arm64 archive SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f` matched the published checksum; the temporary binary accepted `.github/workflows/release-cli.yml` and was removed.
- The exact-action SRI probe downloaded `actions/attest@daf44fb950173508f38bd2406030372c1d1162b1/package-lock.json` and `https://registry.npmjs.org/@sigstore/oci/-/oci-0.6.0.tgz`, recomputed SHA-512, and matched `sha512-baUn8bajz7x4sN/I80vWaw6vOEcuU0RmADr+67BK6a3lTpD9Rjt4t21vKr+3qe4BBtSXyKa7gFPCPlqEtDBOPw==`.
- The same probe against repository-pinned `actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6` verified the `@sigstore/oci` `0.7.2` tarball SRI `sha512-dhqphH/gjg8IFB0xAeD1Ppb/aSNwA2HUG+7A5mVJwiZt6rn5YoYMVc+esZREdhQLZ1H4JFyGZlTQXaZYx/l7yQ==` and the unchanged home-only lookup.
- The pinned Node client probe ran the extracted `@sigstore/oci` `0.6.0` `getRegistryCredentials` under `HOME="$ambient" DOCKER_CONFIG="$publish/.docker" node - ...`, then changed `HOME` to the publication root. It returned the synthetic ambient username first and the synthetic intended username second: `sigstore-oci-0.6.0-home-alignment: PASS`. No token value was printed.
- The temporary Go module contained `require github.com/google/go-containerregistry v0.20.7` and ran `HOME="$ambient" GOPATH="$gopath" DOCKER_CONFIG="$anon" REGISTRY_AUTH_FILE="$registry" XDG_RUNTIME_DIR="$xdg" go run .`. Every non-selected location held synthetic auth while `$anon/config.json` was exactly `{"auths":{}}`; `authn.DefaultKeychain` returned an empty authorization: `go-containerregistry-0.20.7-explicit-empty-config: PASS`. The probe downloaded source into a disposable GOPATH and removed it. It proves client selection, not network anonymity or a public pull.
- `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release-cli.yml")'`, `git diff --check`, and the lockfile two-field-only diff check passed. No full local image rebuild ran; fresh PR CI owns that proof.

- `npx oxfmt --disable-nested-config --write .github/workflows/release-cli.yml docs/s1-image-publication-handoff.md scripts/check-cli-clean-room.test.mjs scripts/check-container-image.mjs scripts/check-container-image.test.mjs scripts/make-image-release.mjs scripts/make-image-release.test.mjs` — passed.
- `./node_modules/.bin/oxfmt worker/container/pi-packages/manifest.json docs/s1-image-publication-handoff.md` — passed for the metadata repair.
- `./node_modules/.bin/oxfmt package.json package-lock.json worker/container/toolsets/standard.json scripts/make-image-release.test.mjs docs/s1-image-publication-handoff.md` — passed for release preparation before lint; the lockfile diff remains exactly its two root version fields.
- `./node_modules/.bin/oxfmt .github/workflows/release-cli.yml scripts/make-image-release.mjs scripts/make-image-release.test.mjs package.json package-lock.json worker/container/toolsets/standard.json docs/s1-image-publication-handoff.md` — passed for the `v0.3.18` repair before lint; the lockfile diff remains exactly its two root version fields.
- `node --test scripts/make-image-release.test.mjs scripts/check-cli-clean-room.test.mjs scripts/check-container-image.test.mjs` — passed, 19/19, including executable synthetic Docker login/logout and stdin coverage.
- `npx vitest run cli/effect-test/command-tree.test.ts` — passed, 14/14 for the `0.3.18` CLI version path.
- The release consistency probe confirmed root package metadata, both root lockfile fields, and the Scotty tool inventory at `0.3.18`; credential-free CLI release probes rejected `v0.3.17` and admitted `v0.3.18` through tag validation before intentionally failing on an empty asset directory.
- Checksum verification of the official `actionlint_1.7.12_darwin_arm64.tar.gz` passed against its release checksum; temporary `actionlint` v1.7.12 then accepted `.github/workflows/release-cli.yml` and was removed.
- `node --test scripts/make-image-release.test.mjs scripts/check-cli-clean-room.test.mjs scripts/check-container-image.test.mjs` — passed, 18/18.
- `npx vitest run cli/effect-test/command-tree.test.ts` — passed, 14/14, including CLI `--version` from root package metadata.
- A read-only metadata consistency probe confirmed `package.json`, both root lockfile fields, and the `scotty --version` inventory expectation are exactly `0.3.17`; its first attempt selected a nonexistent lowercase tool display name, then the corrected command selected the `scotty` command entry and passed.
- Credential-free `make-cli-release.mjs` boundary probes rejected stale tag `v0.3.16` as mismatched, accepted `v0.3.17` through tag validation, and then stopped at the intentionally empty four-asset directory before reading any signing key.
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
- Local repair cleanup: temporary synthetic-client fixtures only; no deployment resources were created or removed. Prior partial release state includes the retained `v0.3.17`/`v0.3.18` tags and the published `v0.3.18` image digest recorded above.
- S2 prerequisite is fulfilled by the final `v0.3.19` receipt: public digest, successful anonymous pull, matching configuration/platform, and verified provenance. S2 must still prove Alchemy's prebuilt remote-image path on a fresh Docker-free installation before removing any local context/build path.

## Evidence limits

S1's live publication gates passed in `v0.3.19`; earlier local QEMU and missing-`mermaid` failures remain historical local limitations, not open release gates. Docker-free installation, custom-image deployment/restore compatibility, deployed CF regression, and Linux-runner portability are **not proven by S1**. No S2 implementation, deployment, or teardown is claimed. Local synthetic probes remain client-behavior evidence only; remote publication evidence comes from the final release run.

## Independent review acceptance

The earlier independent verifier accepted the original S1 implementation and subsequent `v0.3.19` home-alignment repair for PR CI, not publication completion. Fresh CI and parent-owned live publication gates subsequently passed as recorded in the final receipt. `.quickdiff/` remains user-owned review metadata; the active plan now records S1 completion and the S2 restart procedure.

Final independent local review accepted the repair for PR CI: 20 focused tests and 14 CLI tests passed, alongside formatting, lint, actionlint, and source/SRI-verified synthetic Sigstore and Go keychain probes. Parent approval to proceed comes from the user's explicit release decision, not from the reviewer or Jev advisory verdict.
