# Effect 4 RC and Alchemy upgrade assessment

Date: 2026-08-16

## Decision summary

- **Upgrade Effect, but not as a registry fix.** Move Scotty from Effect `4.0.0-beta.103` (`dff25449…`) to the latest tagged RC, `4.0.0-rc.109` (`b5946ece…`), in its own migration. This reduces version drift and moves Scotty onto Effect's presumed-final v4 interfaces.
- **Do not expect Effect to fix the Cloudflare Container Registry `401`.** Effect does not own registry credential issuance or Docker authentication.
- **Alchemy `2.0.0-beta.72` does not contain a fix for this `401`.** It upgrades Alchemy's Effect floor to beta.105 and hardens container pushes for platform selection and transient `500` responses, but its short-lived registry-credential and isolated Docker-config authentication path is materially unchanged.
- **Treat the registry fix separately.** The narrowest supported route is to push the image with Cloudflare's official tooling and pass Alchemy an immutable, already-pushed registry reference through Alchemy's public `image` contract. This keeps Alchemy as the only resource reconciler. Alternatively, fix/upstream Alchemy's registry authentication to match Wrangler's successful login path.
- **Upgrade Alchemy separately after Effect.** Target `v2.0.0-beta.72` (`4465e353603ab71b279a66c4fcd3ecc1488aa090`) only after re-validating Scotty's beta.67 patch and direct `@distilled.cloud/cloudflare` integration.

## What the Effect RC changes

The Effect announcement tagged `4.0.0-rc.108` and states that broad breaking changes are no longer planned and interfaces are presumed final. The current RC dist-tag has since advanced to `4.0.0-rc.109` at commit `b5946ece2b33a4468ef927a39821d7c3db463af3`.

Primary sources:

- [Effect 4 RC announcement](https://www.effect.website/blog/releases/effect/40-rc)
- [Effect rc.109 tag](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.109)
- [Effect migration guide](https://github.com/Effect-TS/effect/blob/b5946ece2b33a4468ef927a39821d7c3db463af3/MIGRATION.md)
- [beta.103 → rc.109 comparison](https://github.com/Effect-TS/effect/compare/dff25449dfc927f2cce912c329f343cfb5365f88...b5946ece2b33a4468ef927a39821d7c3db463af3)

Concrete Scotty-facing breaks found in the tagged source:

1. `Schema.TaggedErrorClass` becomes `Schema.TaggedError`, and `Schema.ErrorClass` becomes `Schema.Error` ([Effect commit `592dd361`](https://github.com/Effect-TS/effect/commit/592dd361645739ac0cd8e6babb084cd27403c172)). Scotty has usages in CLI, Worker contracts/evidence code, skills, and documentation.
2. `Command.withHidden` becomes `Command.unlisted` ([Effect commit `dd9f891e`](https://github.com/Effect-TS/effect/commit/dd9f891e23f316abb6192893008f0e33ece9d97d)). Scotty uses `withHidden` in `cli/src/commands.ts`.
3. `Schema.toArbitrary` becomes the curried arbitrary factory and replaces `toArbitraryLazy` ([Effect commit `1416ccd4`](https://github.com/Effect-TS/effect/commit/1416ccd474bc9da8979f51b72b5e53fb3ac56edf)). Scotty has no direct production call site, but test guidance should reflect the new form.
4. Platform package source directories moved under `packages/platform/*`; published npm package names remain unchanged. Any repository-source paths in instructions must be updated.
5. Upstream testing guidance now states that `it.effect` and `it.live` already provide and close a `Scope`; tests should not wrap those bodies in `Effect.scoped`.

`Effect.fnUntraced`, the class form of `Context.Service`, core HTTP subpaths, and the `@effect/vitest` public test surface remain available. The migration is real but bounded and mostly mechanical.

## Why Effect cannot fix the registry `401`

The failed deployment established a narrow contrast:

- Alchemy built the image and uploaded the Worker, but Docker failed a Cloudflare registry blob `HEAD` request with `401 Unauthorized` while using Alchemy-created temporary credentials.
- `wrangler containers push` successfully pushed the identical image and digest using the existing Cloudflare login.

Effect does not issue Cloudflare registry credentials, create Docker authentication files, or push OCI images. No beta.103 → rc.109 Effect change touches this path. Therefore the Effect upgrade and the registry failure are independent.

## What changed in Alchemy after beta.67

Scotty pins Alchemy `v2.0.0-beta.67` at `da667f7d46751fe93952cfeb49768e6eb8212693`. The latest tagged v2 release inspected is `v2.0.0-beta.72` at `4465e353603ab71b279a66c4fcd3ecc1488aa090`.

Primary sources:

- [Alchemy releases](https://github.com/alchemy-run/alchemy/releases)
- [beta.67 → beta.72 comparison](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.67...v2.0.0-beta.72)
- [Effect beta.105 upgrade commit](https://github.com/alchemy-run/alchemy/commit/6bbadc1b86b0cd3ecdf97fe4f6c34ffc9180eb0b)
- [Current v2 Container provider](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Cloudflare/Containers/ContainerProvider.ts)
- [Current v2 Docker implementation](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Docker/Docker.ts)

Relevant changes:

- beta.71 raises Alchemy's Effect dependency floor to `4.0.0-beta.105`; it does not itself adopt an Effect RC.
- Container pushing gains explicit platform selection and bounded retry for transient `500`/internal-server errors. That does not handle `401`.
- The push still calls Cloudflare's registry-credentials endpoint with pull/push permissions and a 60-minute expiration, then writes base64 basic auth into an isolated `DOCKER_CONFIG` and invokes Docker push.
- Wrangler requests registry credentials and performs a real `docker login --password-stdin` against the normal Docker credential path. In this incident, that path succeeded.
- Alchemy's pre-pushed image support already existed before beta.67. A target-registry image reference is accepted as-is, and Alchemy skips pull/build/push while retaining ownership of the Container application and rollout.

No post-beta.67 release or source change found in the v2 line fixes temporary registry credential rejection, changes the 60-minute TTL, adopts Wrangler login, or retries `401`.

## Recommended migration sequence

### 1. Fix deployment transport independently

Use one of these, in preference order:

1. **Public pre-pushed-image contract:** push a Linux/amd64 image using Cloudflare's official tooling, record its immutable digest reference, and provide that reference to Alchemy's `Container`/`ContainerApplication` `image` property. Alchemy remains the sole resource/state reconciler.
2. **Upstream Alchemy fix:** reproduce the difference between isolated base64 auth and Wrangler's login, then patch/upstream Alchemy to use a credential flow accepted by Cloudflare. Preserve redaction and improve the currently empty deployment diagnostic cause.

Do not assume a dependency bump fixed the path without reproducing an Alchemy-owned push.

### 2. Effect RC migration

Update together:

- `effect`, `@effect/platform-node`, `@effect/platform-bun`, and `@effect/vitest` to `4.0.0-rc.109`.
- `vendor/effect` to `b5946ece2b33a4468ef927a39821d7c3db463af3`.
- Root `AGENTS.md` pin and source-path guidance.
- Scotty's Effect skills and copied patterns, especially error modeling, CLI, and testing.
- All `Schema.TaggedErrorClass` and `Command.withHidden` usages.
- The npm lockfile and the single-Effect-version assertion.

Copy only relevant upstream pattern changes; do not overwrite Scotty-specific invariants.

### 3. Alchemy beta.72 migration

Update together:

- `alchemy` to `2.0.0-beta.72`.
- `vendor/alchemy` to tag commit `4465e353603ab71b279a66c4fcd3ecc1488aa090`.
- Direct `@distilled.cloud/cloudflare` to the version required by beta.72, eliminating the current duplicate-version skew.
- `patches/alchemy+2.0.0-beta.67.patch` and `scripts/apply-dependency-patches.mjs`: verify whether each patch hunk is upstream, re-derive only the remaining behavior, and rename the patch for beta.72.
- Pin-asserting deployment tests and generated container context.

This Alchemy migration improves compatibility and reduces skew, but it must not be presented as the registry-auth fix.

## Risk and proof boundaries

- Effect RC migration risk is mainly compile-time API renames and Schema error behavior.
- Alchemy migration risk is higher because Scotty carries a version-specific patch and directly consumes Distilled Cloudflare APIs.
- The decisive proof for registry remediation is an Alchemy deployment that completes without Wrangler performing resource reconciliation. A pre-push may use Wrangler only for image transport if Alchemy consumes the immutable image and still owns the Container application, Worker bindings, rollout, and state.
