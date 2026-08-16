# AGENTS.md

Read this before changing Scotty.

## Scope and invariants

- Preserve public HTTP routes and error envelopes, CLI JSON shapes and exit codes, persisted session semantics, workspace and branch conventions, browser handoff, and credential isolation unless the user explicitly approves a contract change.
- Installation and runner names are user-supplied. Never infer them from a username, machine, repository, or Cloudflare account. Local config is a pointer, not deployment authority. Repository state contains no account identity, deployed resource identifier, or real credential.
- The session Sandbox Durable Object owns the session record, operation lease, per-session credential vault and rotation, backup handles, and hard-cap metadata. The installation-scoped SandboxConfig Durable Object owns the Pi seed record and repository registry; it does not own the GitHub credential or session sentinels. KV is a non-secret list projection. R2 contains immutable backups. Container files and Effect runtime memory are never authoritative.
- The Auth Durable Object owns one browser owner, standard clients, pairing, transfer, recovery, and revocation. It stores credential digests only. The root token is bearer and recovery authority only, never a cookie or URL. Root recovery revokes every browser credential.
- Only one operation lease may mutate a session. Create arms the hard cap before commit. Snapshot stops Pi before sync and backup. Resume requires the current backup. Vaporize retries until owned state is gone. Interrupted work retains retry state or publishes a typed failure. Never report success from ambiguous provider state.
- Real Codex/GitHub credentials must never enter container env/files/process args/logs/Git config/KV/R2/API responses or Alchemy props, outputs, and state. Containers receive session-bound sentinels only. OAuth rotation commits before the sanitized response returns.
- Runner registration is available. Runner-backed session creation remains disabled until native Pi RPC transport and deployed lifecycle proof exist.

## Effect v4: source first

Effect is pinned for this repository at `vendor/effect`, commit `b5946ece2b33a4468ef927a39821d7c3db463af3`, corresponding to the `4.0.0-rc.109` package set. Treat the submodule as read-only reference source. The Effect RC migration plan and its Scotty-facing API breaks are recorded in `docs/research/effect-4-rc-alchemy-upgrade.md`.

Before adding or changing any non-trivial Effect pattern:

1. Read `vendor/effect/.agents/AGENTS.md`.
2. Read the relevant pattern in `vendor/effect/.patterns/`, especially `effect.md` and `testing.md`.
3. Search `vendor/effect/ai-docs/src/` and `vendor/effect/migration/` for orientation.
4. Inspect the actual implementation in `vendor/effect/packages/effect/src/` and its tests. Source and tests outrank remembered APIs or third-party examples.
5. Search for an analogous established pattern before inventing an abstraction. If none exists, record the decision and trade-off before coding.

Do not rely on Effect v3 docs or add legacy `@effect/platform` / `@effect/schema` packages. In v4, platform and schema APIs live in `effect` and `effect/unstable/*`; verify every import against the pinned source.

## Alchemy v2: one Cloudflare model

Alchemy is pinned as read-only reference source at `vendor/alchemy`, commit `4465e353603ab71b279a66c4fcd3ecc1488aa090`, the exact `2.0.0-beta.72` release commit installed by this repository. Scotty uses Alchemy's Effect-native v2 model as the single source for Cloudflare infrastructure and ordinary runtime integration: Worker, HTTP API, bindings, KV, R2, assets, Durable Object migrations, Container application, stages, state, deployment, and integration tests. Do not preserve parallel Wrangler/Hono/manual-binding implementations after their Alchemy replacements pass the migration gates.

Before changing a non-trivial Alchemy pattern:

1. Read the relevant guide under `vendor/alchemy/website/src/content/docs/`.
2. Inspect the actual provider/runtime implementation in `vendor/alchemy/packages/alchemy/src/` and its tests.
3. Verify it compiles against Scotty's exact Effect rc.109 resolution.
4. Prefer its public API. If it lacks a required Sandbox capability, implement the smallest Scotty-owned Effect service or Alchemy custom provider; do not use unstable private bindings as the lasting design.

Alchemy does not replace the official `@cloudflare/sandbox` runtime class. The Sandbox SDK requires its own subclass and native PTY/stream callback signatures. Keep those as minimal host islands that immediately delegate to Scotty Effects. Build the external-Sandbox-DO/Container association with Alchemy's public resource binding contracts; do not add a second reconciler for resources Alchemy already owns.

Never put real Codex/GitHub credentials in Alchemy stack outputs, state, `Config.redacted`, Container configuration, or ordinary resource props. `Redacted` prevents display but Alchemy state encoding retains encrypted secret values. Scotty must add a secret-reference/provider boundary that persists only identifiers or digests; containers still receive session-bound sentinels only.

## Executor and effect-cf references

Executor is a comparative implementation reference, not a Scotty dependency. Before copying an Executor pattern, inspect its source and verify it against pinned Effect rc.109 and Scotty's Cloudflare Sandbox constraints.

Use Executor primarily for:

- Effect service/layer and typed-error boundaries.
- Cloudflare host adapters that keep native `Request`, `Response`, WebSocket, stream, and Durable Object boundaries explicit.
- Effect-aware testing and runtime ownership.
- oxfmt/oxlint rules that prevent unsafe Effect escape hatches.

Do not copy its product/package complexity, broad plugin architecture, or unrelated custom lint rules.

`effect-cf` is comparative source, not an approved dependency. Its `0.16.0` release is tested against Effect beta.77, not Scotty's rc.109 pin. Alchemy supplies Scotty's Cloudflare Effect bridge; do not add a second competing Worker/Durable Object runtime.

## Effect design rules

- Convert the async domain core where typed errors, services, retries, scopes, clocks, or concurrency add correctness. Do not wrap pure parsing, HTML, CLI rendering, raw Cloudflare callbacks, or trivial synchronous transforms merely for uniformity.
- Use class syntax for `Context.Service`.
- Prefer `Effect.fnUntraced` for reusable functions that would otherwise only return `Effect.gen`.
- Never use `try/catch` inside `Effect.gen`; model failures with `Effect.tryPromise`, `Effect.try`, `Effect.catch*`, `Result`, or `Cause`.
- Use `return yield*` for terminal failures/interruption.
- Use `Clock` and `TestClock`, not direct wall-clock calls in migrated domain logic.
- Put resource cleanup in scopes/finalizers. Do not create a global runtime whose lifecycle can outlive a Worker request or hide Durable Object state.
- Use Alchemy's event scopes and Effect HTTP/DO/RPC bridges. Convert Effects to Promises only in the official Sandbox SDK callback islands or CLI boundary where Alchemy cannot own the host signature. Preserve interruption signals where the host provides them.
- Decode untrusted HTTP, env, KV, R2, OAuth, CLI, and archive data with Schema at the boundary. Avoid unsafe casts, `any`, non-null assertions, and manual shape probing.

## Effect remediation skills

Use the project skills under `.agents/skills` when a matching lint diagnostic or design task appears:

- [`modeling-effect-errors`](.agents/skills/modeling-effect-errors/SKILL.md) for typed failures, tagged errors, and recovery.
- [`decoding-effect-boundaries`](.agents/skills/decoding-effect-boundaries/SKILL.md) for Schema decoding and unknown inputs.
- [`deriving-schema-types`](.agents/skills/deriving-schema-types/SKILL.md) for schema-owned TypeScript types.
- [`inferring-value-types`](.agents/skills/inferring-value-types/SKILL.md) for object API types inferred from their owning runtime factories or values.
- [`wrapping-promise-clients`](.agents/skills/wrapping-promise-clients/SKILL.md) for Promise SDK adapters.
- [`testing-effect-programs`](.agents/skills/testing-effect-programs/SKILL.md) for `@effect/vitest`, `it.effect`, `assert`, and `TestClock`.
- [`maintaining-typescript-safety`](.agents/skills/maintaining-typescript-safety/SKILL.md) for casts, host/runtime boundaries, and execution ownership.
- [`modeling-effect-cli`](.agents/skills/modeling-effect-cli/SKILL.md) for typed commands, nested subcommands, flags, help, parser output, and exit behavior.
- [`routing-effect-http`](.agents/skills/routing-effect-http/SKILL.md) for Effect HTTP routing with native Cloudflare host types.

Raw fetch follows the same domain/host split as Effect execution. Migrated Effect domain modules use `HttpClient` and `HttpClientRequest` from `effect/unstable/http` for outbound HTTP. Native Cloudflare `Request`, `Response`, WebSocket, and stream handling; Worker handler methods; ASSETS and service-binding `.fetch` methods; egress native streaming proxy fetch; and CLI host-boundary fetch remain explicit host adapters. Enable `scotty/no-raw-fetch` only in the strict migrated-production override, not globally or for tests and host modules.

Start remediation at the diagnostic's referenced skill, inspect rc.109 source and tests, make the smallest behavior-preserving fix, then run `npm run fmt`, `npm run lint:skills`, the focused test, and the affected typecheck. Boundary suppressions must be adjacent, rule-specific, and explain the native host contract.

Every newly migrated Effect domain module must be added to the strict Scotty override in `.oxlintrc.json` in the same change. Do not classify legacy Worker, CLI, or E2E modules as migrated merely to expand lint coverage.

## Formatting, lint, and tests

- Use oxfmt and oxlint. Do not format or lint `vendor/**`, generated assets, tldraw archives, or `work/**`.
- Run formatting before lint because lint output should refer to final source positions.
- Do not copy Executor's entire custom lint plugin. Adopt only rules that enforce Scotty's approved invariants, starting with no explicit `any`, no unsafe double casts, no Effect escape hatches in domain modules, no raw wall clock in migrated code, and no untyped thrown errors.
- Effect-returning tests use `@effect/vitest`, `it.effect`, and `assert`. Pure synchronous tests use regular `it`. Never use `Effect.runSync` in tests.
- Every storage, egress, container, backup, OAuth, and API adapter must satisfy a shared contract test. Fake E2E supplements but does not replace tests that execute production adapters.

Current baseline verification:

```sh
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
```

Production proof requires the guarded Alchemy deployment and full deployed canary. A local fake or reachable host is not enough.
