# Effect 4 RC and Alchemy upgrade assessment

Date: 2026-08-16
Updated: 2026-09-02

## Decision summary

- **Upgrade Effect, but not as a registry fix.** Scotty now targets Effect `4.0.0-rc.112` (`2600f62f…`). This reduces version drift and keeps Scotty on Effect's presumed-final v4 interfaces.
- **Do not expect Effect to fix the Cloudflare Container Registry `401`.** Effect does not own registry credential issuance or Docker authentication.
- **Alchemy `2.0.0-beta.76` does not contain a fix for this `401`.** Its scoped temporary `DOCKER_CONFIG` preserves Scotty's credential-isolation requirements, but the registry-credential path still requires the narrow TTL backport.
- **Treat the registry fix separately.** The narrowest supported route is to push the image with Cloudflare's official tooling and pass Alchemy an immutable, already-pushed registry reference through Alchemy's public `image` contract. This keeps Alchemy as the only resource reconciler. Alternatively, fix/upstream Alchemy's registry authentication to match Wrangler's successful login path.
- **Upgrade Alchemy together with its compatibility set.** Target `v2.0.0-beta.76` (`e5b1b598392585e0f2d5fa03ac475cd076dbc0f8`), Effect rc.112, and `@distilled.cloud/cloudflare` rc.8, while retaining only revalidated patches.

## What the Effect RC changes

The Effect announcement tagged `4.0.0-rc.108` and states that broad breaking changes are no longer planned and interfaces are presumed final. Scotty's coordinated pin is `4.0.0-rc.112` at commit `2600f62f4532026928454dcea8d1c48557b3f942`.

Primary sources:

- [Effect 4 RC announcement](https://www.effect.website/blog/releases/effect/40-rc)
- [Effect rc.112 tag](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.112)
- [Effect migration guide](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/MIGRATION.md)
- [rc.109 → rc.112 comparison](https://github.com/Effect-TS/effect/compare/b5946ece2b33a4468ef927a39821d7c3db463af3...2600f62f4532026928454dcea8d1c48557b3f942)

Concrete Scotty-facing breaks found in the tagged source:

1. `Schema.TaggedErrorClass` becomes `Schema.TaggedError`, and `Schema.ErrorClass` becomes `Schema.Error` ([Effect commit `592dd361`](https://github.com/Effect-TS/effect/commit/592dd361645739ac0cd8e6babb084cd27403c172)). Scotty has usages in CLI, Worker contracts/evidence code, skills, and documentation.
2. `Command.withHidden` becomes `Command.unlisted` ([Effect commit `dd9f891e`](https://github.com/Effect-TS/effect/commit/dd9f891e23f316abb6192893008f0e33ece9d97d)). Scotty uses `withHidden` in `cli/src/commands.ts`.
3. `Schema.toArbitrary` becomes the curried arbitrary factory and replaces `toArbitraryLazy` ([Effect commit `1416ccd4`](https://github.com/Effect-TS/effect/commit/1416ccd474bc9da8979f51b72b5e53fb3ac56edf)). Scotty has no direct production call site, but test guidance should reflect the new form.
4. Platform package source directories moved under `packages/platform/*`; published npm package names remain unchanged. Any repository-source paths in instructions must be updated.
5. Upstream testing guidance now states that `it.effect` and `it.live` already provide and close a `Scope`; tests should not wrap those bodies in `Effect.scoped`.
6. In rc.112, `Flag.boolean` omission produces `MissingOption`; optional switches must use `Flag.withDefault(false)` explicitly.

`Effect.fnUntraced`, the class form of `Context.Service`, core HTTP subpaths, and the `@effect/vitest` public test surface remain available. The migration is real but bounded and mostly mechanical.

## Why Effect cannot fix the registry `401`

The failed deployment established a narrow contrast:

- Alchemy built the image and uploaded the Worker, but Docker failed a Cloudflare registry blob `HEAD` request with `401 Unauthorized` while using Alchemy-created temporary credentials.
- `wrangler containers push` successfully pushed the identical image and digest using the existing Cloudflare login.

Effect does not issue Cloudflare registry credentials, create Docker authentication files, or push OCI images. No Effect change through rc.112 owns this path. Therefore the Effect upgrade and the registry failure are independent.

## What changed in Alchemy after beta.67

Scotty previously pinned Alchemy `v2.0.0-beta.72` at `4465e353603ab71b279a66c4fcd3ecc1488aa090`. The coordinated pin inspected here is `v2.0.0-beta.76` at `e5b1b598392585e0f2d5fa03ac475cd076dbc0f8`.

Primary sources:

- [Alchemy releases](https://github.com/alchemy-run/alchemy/releases)
- [beta.72 → beta.76 comparison](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.72...v2.0.0-beta.76)
- [Effect beta.105 upgrade commit](https://github.com/alchemy-run/alchemy/commit/6bbadc1b86b0cd3ecdf97fe4f6c34ffc9180eb0b)
- [Current v2 Container provider](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Cloudflare/Containers/ContainerProvider.ts)
- [Current v2 Docker implementation](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Docker/Docker.ts)

Relevant changes:

- beta.76 requires Effect `4.0.0-rc.112` or newer.
- Container pushing gains explicit platform selection and bounded retry for transient `500`/internal-server errors. That does not handle `401`.
- The push still calls Cloudflare's registry-credentials endpoint with pull/push permissions and a 60-minute expiration, then writes base64 basic auth into an isolated `DOCKER_CONFIG` and invokes Docker push.
- Wrangler requests registry credentials and performs a real `docker login --password-stdin` against the normal Docker credential path. In this incident, that path succeeded.
- Alchemy's pre-pushed image support already existed before beta.67. A target-registry image reference is accepted as-is, and Alchemy skips pull/build/push while retaining ownership of the Container application and rollout.

Beta.76 still does not fix temporary registry credential rejection, shorten the 60-minute TTL, or retry `401`. Its scoped temporary `DOCKER_CONFIG` already isolates the inline registry auth entry from shared Docker configuration and removes it with the enclosing scope; a `docker login --password-stdin` patch is neither necessary nor desirable because it can route through a shared credential helper. Scotty retains four safety backports: stable Durable Object binding diffing, plan-safe Worker export serialization, 15-minute registry credentials, and lazy typed workerd loading.

## Recommended migration sequence

### 1. Fix deployment transport independently

Use one of these, in preference order:

1. **Public pre-pushed-image contract:** push a Linux/amd64 image using Cloudflare's official tooling, record its immutable digest reference, and provide that reference to Alchemy's `Container`/`ContainerApplication` `image` property. Alchemy remains the sole resource/state reconciler.
2. **Upstream Alchemy fix:** reproduce the difference between isolated base64 auth and Wrangler's login, then patch/upstream Alchemy to use a credential flow accepted by Cloudflare. Preserve redaction and improve the currently empty deployment diagnostic cause.

Do not assume a dependency bump fixed the path without reproducing an Alchemy-owned push.

### 2. Effect RC migration

Update together:

- `effect`, `@effect/platform-node`, `@effect/platform-bun`, and `@effect/vitest` to `4.0.0-rc.112`.
- `vendor/effect` to `2600f62f4532026928454dcea8d1c48557b3f942`.
- Root `AGENTS.md` pin and source-path guidance.
- Scotty's Effect skills and copied patterns, especially error modeling, CLI, and testing.
- All `Schema.TaggedErrorClass` and `Command.withHidden` usages.
- The npm lockfile and the single-Effect-version assertion.

Copy only relevant upstream pattern changes; do not overwrite Scotty-specific invariants.

### 3. Alchemy beta.76 migration

Update together:

- `alchemy` and its `@alchemy.run/*` packages to `2.0.0-beta.76`.
- `vendor/alchemy` to tag commit `e5b1b598392585e0f2d5fa03ac475cd076dbc0f8`.
- Direct `@distilled.cloud/cloudflare` to `1.0.0-rc.8`, eliminating duplicate-version skew.
- Rebase the still-required patch inventory to beta.76 paths and source; do not retain superseded hunks.
- Pin-asserting deployment tests and generated container context.

This Alchemy migration improves compatibility and reduces skew, but it must not be presented as the registry-auth fix.

## Risk and proof boundaries

- Effect RC migration risk is mainly compile-time API renames and Schema error behavior.
- Alchemy migration risk is higher because Scotty carries a version-specific patch and directly consumes Distilled Cloudflare APIs.
- The decisive proof for registry remediation is an Alchemy deployment that completes without Wrangler performing resource reconciliation. A pre-push may use Wrangler only for image transport if Alchemy consumes the immutable image and still owns the Container application, Worker bindings, rollout, and state.
