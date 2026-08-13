---
shaping: true
status: ready
---

# Installation sandbox customization plan

## Implementation handoff

Implement the smallest user-owned customization layer for Scotty's existing Cloudflare sandbox.
The operator manages one local JSON document containing additional Agent Skill directories and
pinned Git repositories containing Pi packages. Scotty synchronizes that desired state into the
operator's Cloudflare installation. Every newly created session pins and materializes the active
sandbox configuration before Pi starts.

This plan does not change execution providers, session UI, credentials, or the required Scotty Pi
packages. It removes the current `scotty skills` command that prints an embedded Markdown skill and
replaces it with one `scotty sandbox` command group.

The target experience is:

```sh
scotty init

scotty sandbox add ./agent-skills/release-notes
scotty sandbox add https://github.com/acme/pi-review-tools.git --ref v1.2.0
scotty sandbox list

# Direct JSON edits are also supported.
$EDITOR ~/.scotty/sandbox.json
scotty sandbox sync

scotty beam up owner/repository
```

The first `init` performs the one-time infrastructure deployment. Later `sandbox add`, `sandbox
remove`, and `sandbox sync` operations must not run Alchemy, rebuild the container image, or deploy
the Worker.

## Destination

A complete implementation satisfies all of these statements:

1. The Cloudflare resources belong to the user and remain provisioned by `scotty init`.
2. Scotty's reviewed, GUI-critical Pi packages remain immutable image inputs and always load first.
3. A user may add an Agent Skill by selecting a local directory containing `SKILL.md`.
4. A user may add a Pi package from a proper Git repository at an explicit tag or commit.
5. Scotty resolves and prepares all inputs on the CLI machine. A sandbox never clones a repository,
   resolves a floating dependency, or runs a package installer.
6. Synchronization creates one deterministic, immutable sandbox bundle and makes its digest the
   installation's active sandbox configuration.
7. A new Session records that digest before runtime preparation and receives exactly those bytes.
8. Create retries and resume reuse the Session's recorded digest instead of following a newer
   installation configuration.
9. User additions cannot remove, reorder, or replace Scotty's required image packages.
10. A failed synchronization or failed materialization is visible and never reports success from
    ambiguous state.

## Deliberate non-goals

- Do not add a public `capabilities` concept or command.
- Do not build a marketplace, team/workspace scope, sharing service, or discovery UI.
- Do not add arbitrary npm package sources. Pi packages come from Git repositories only in v1.
- Do not accept floating branches as persisted package identity.
- Do not support monorepo subpaths, Git submodules, Git LFS, package build scripts, alternate package
  managers, or repositories that require a compilation step in v1.
- Do not install dependencies in a Session container.
- Do not live-update warm Sessions or wake sleeping Sessions when configuration changes.
- Do not implement automatic bundle garbage collection. Retain old immutable objects in v1.
- Do not reduce or reorganize the built-in Pi package set in this work.
- Do not change the existing project-local `.pi`/`.agents` trust policy in this work. Record it as a
  separate security decision; do not claim this plan protects against project-local shadowing.
- Do not work on runner, Hetzner, exe.dev, Modal, Daytona, or other execution providers here.
- Do not commit, push, deploy, or run a destructive deployed canary without explicit authorization.

## Domain language

Use these terms consistently in code, API shapes, tests, and documentation:

**Sandbox configuration**: The operator's desired additions, stored locally as JSON. It contains
Skill sources and Pi package sources. It is not deployment authority after synchronization.

**Skill source**: A local directory containing one valid Agent Skill rooted at `SKILL.md`.

**Pi package source**: A Git repository containing a valid Pi package. The local configuration stores
the repository and its resolved commit.

**Sandbox bundle**: The deterministic immutable archive produced from one sandbox configuration.
This is an internal transport/cache artifact, not a product surface.

**Sandbox bundle manifest**: The decoded inventory and provenance for a sandbox bundle, including
every selected Skill, Pi package, resolved source, file inventory, size, and digest.

**Active sandbox digest**: The bundle digest currently selected for new Sessions in one installation.

**Pinned sandbox digest**: The active digest copied into a Session record during create. This value
does not change implicitly.

Do not use `capability`, `catalog`, `personal`, `workspace`, `publish`, or `activate` in the public CLI.
Internal helpers may use `publish` only for the upload/commit protocol when that is clearer than
`sync`.

## Public CLI contract

### Remove the old command

The current bare `scotty skills` command prints the compile-time contents of
`cli/skills/scotty/SKILL.md`. Remove that command from the root command tree. Remove the embedded
asset/import and delete the obsolete Skill file if nothing else references it.

This public contract change is explicitly approved by the user. Preserve all unrelated CLI shapes,
JSON envelopes, and exit behavior.

### Add one command group

```text
scotty sandbox add <source> [--ref <tag-or-commit>]
scotty sandbox remove <name>
scotty sandbox list
scotty sandbox sync
```

All commands participate in the existing global `--json` behavior.

#### `sandbox add`

- If `<source>` resolves to a local directory, it must contain `SKILL.md` and is treated as a Skill.
- If `<source>` is a supported HTTPS or SSH Git URL, `--ref` is required and it is treated as a Pi
  package repository.
- Reject ambiguous sources instead of guessing.
- Resolve a Git tag or commit to a full commit SHA during `add` and persist the resolved SHA. Preserve
  the user-supplied ref only as display/provenance metadata.
- Reject branch-only or moving symbolic refs when they cannot be proven to resolve to a commit.
- Derive the Skill name from decoded `SKILL.md` frontmatter.
- Derive the Pi package name from decoded `package.json`.
- Reject duplicate names across the corresponding source kind.
- Atomically update the local JSON, then run the same operation as `sandbox sync`.
- If remote synchronization fails, keep the valid local desired state and return a typed error that
  says the installation still uses the previous digest. A later `sandbox sync` must be sufficient.

#### `sandbox remove`

- Remove one Skill or Pi package by its unique configured name.
- Reject an unknown or ambiguous name without changing the file.
- Atomically update the local JSON, then synchronize it.
- Removing an item creates a new bundle; it never mutates or deletes an older bundle.

#### `sandbox list`

- Read and validate the local JSON.
- Also query the installation when credentials are available.
- Human output distinguishes local desired state from the active remote digest and reports whether
  they are synchronized.
- JSON output must have a versioned typed shape. It must never include the root bearer, repository
  credentials, local Git credential configuration, or archive contents.
- If local state is valid but the remote status request is unavailable, return the local list plus a
  typed remote-status warning only if existing CLI envelope conventions support partial results;
  otherwise fail without pretending synchronization.

#### `sandbox sync`

- Validate and resolve the complete local document.
- Prepare all sources in a fresh temporary directory.
- Build the deterministic bundle and manifest.
- If the calculated digest already equals the remote active digest, report a no-op and upload
  nothing.
- Otherwise upload the immutable bundle and manifest, then atomically commit the digest as active.
- On any failure before active-pointer commit, the previous active digest remains authoritative.
- On an ambiguous response after commit, query status by idempotency key/digest before deciding the
  outcome.

### Init and deploy integration

- `scotty init` creates an empty `~/.scotty/sandbox.json` when it does not exist, with mode `0600`.
- After infrastructure creation, root-token upload, verification, and local installation pointer
  persistence succeed, `init` invokes the same sandbox synchronization service.
- A synchronization failure must not pretend that the already-created infrastructure was rolled
  back. Return a typed partial-setup failure with the exact recovery command `scotty sandbox sync`.
- `scotty deploy` invokes the same synchronization service after a successful deployment/inspection.
- Deployment may add or update the one-time bindings needed by this feature. A later standalone
  `sandbox sync` must never invoke deployment code.
- Do not couple local CLI executable upgrade to sandbox synchronization.

## Local JSON contract

Use a separate private file rather than extending `~/.scotty.json`. The existing file remains an
installation pointer and root credential only.

Path:

```text
~/.scotty/sandbox.json
```

Initial shape:

```json
{
  "schemaVersion": 1,
  "skills": [],
  "piPackages": []
}
```

Representative populated shape:

```json
{
  "schemaVersion": 1,
  "skills": [
    {
      "name": "release-notes",
      "path": "/Users/example/agent-skills/release-notes"
    }
  ],
  "piPackages": [
    {
      "name": "pi-review-tools",
      "repository": "https://github.com/acme/pi-review-tools.git",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "requestedRef": "v1.2.0"
    }
  ]
}
```

Rules:

- Decode the entire document with Effect Schema and reject excess properties.
- Derive TypeScript types from their Schemas.
- Require a full 40-character lowercase Git commit in persisted state.
- Persist canonical absolute Skill paths. Do not copy local Skill content into the config file.
- Names must follow Pi/Agent Skills constraints and be unique within their collection.
- Sort entries by name before persistence and bundle construction.
- Write via a sibling temporary file, `fsync` as supported by the existing filesystem boundary, rename
  atomically, then enforce `0600`.
- Never interpolate repository credentials or tokens into the JSON.
- Direct user edits are supported; every command decodes again before acting.
- A missing file is equivalent to the empty v1 document only for `init` and first use. A malformed
  existing file is an error and must not be overwritten.

## Required built-in base

Keep `PI_PACKAGES` and the image package pin manifest unchanged in the first implementation. The
required list currently includes Scotty's versions of tasks, subagents, workflows, background
terminals, AskUser, web access, compaction, Amp UI, browser testing, and Hatch.

The generated Pi settings must always order packages as:

```text
PI_PACKAGES (image-reviewed, current order)
then installation Pi package paths (manifest name order)
```

The merged Skill directory must always include the image-reviewed `/opt/scotty/skills` entries before
installation Skill entries.

At local sync time:

- Reject a configured Skill name that collides with a built-in Skill name.
- Reject a configured Pi package name that collides with a required Pi package name.
- Reject duplicate configured extension/package identities.
- Record that this collision guarantee applies to synchronized installation additions. Project-local
  resources currently have their own Pi trust/precedence behavior and are outside this plan.

At container preflight time, prove every required package is still visible before starting the Pi RPC
supervisor. Do not rely only on local publication validation.

## Source preparation

All source resolution happens on the CLI machine in a new temporary directory. Cleanup belongs to a
scope/finalizer and must run after success, failure, or interruption.

### Skill directory

For each configured Skill:

1. Resolve and confirm the configured root is a directory.
2. Decode `SKILL.md` frontmatter and verify its name matches the configured name.
3. Walk the directory without following symlinks.
4. Allow ordinary files and directories only.
5. Reject sockets, devices, FIFOs, hard-link ambiguity, and every symlink in v1.
6. Reject paths that are absolute after normalization, contain `..`, contain NUL, or escape the root.
7. Apply explicit per-file, per-Skill, file-count, and total-bundle limits.
8. Exclude transient files through an explicit fixed list only; do not silently honor arbitrary local
   ignore files in v1.
9. Record each normalized relative path, byte size, mode class, and SHA-256 in the manifest.
10. Treat executable files or a `scripts/` directory as executable content in status output and
    manifest metadata. Agent Skills validity is not a safety claim.

### Git-backed Pi package

For each configured Pi package:

1. Clone the repository using an argv-based process call and the user's normal local Git credential
   helpers. Never place credentials in argv, logs, JSON, or the bundle.
2. Disable terminal prompting for non-interactive operation and return a typed auth/source failure.
3. Fetch and checkout the exact persisted commit in detached state.
4. Verify `HEAD` equals that commit.
5. Reject submodules and Git LFS pointer payloads in v1.
6. Decode `package.json`; require its name to match the configured name and require a valid `pi`
   resource declaration or Pi's supported conventional layout.
7. Reject package resource paths that leave the repository root.
8. If runtime dependencies exist, require `package-lock.json` and run the pinned, repository-approved
   npm command as an argv call equivalent to `npm ci --omit=dev --ignore-scripts` in the staging copy.
9. Never run lifecycle or arbitrary build scripts. A package requiring build output not present in the
   repository is unsupported in v1.
10. Remove `.git` and package-manager caches from the staged copy.
11. Walk and inventory the final prepared directory using the same file-type, path, count, and size
    constraints as Skills.
12. Record repository, requested ref, resolved commit, package manifest identity, lock digest, file
    inventory, and prepared content digest.

Do not reuse a mutable checkout between sync operations. Do not modify the user's source Skill
directory or Git repository.

## Deterministic bundle format

Construct one archive containing:

```text
manifest.json
skills/<skill-name>/...
pi-packages/<package-name>/...
```

Requirements:

- Manifest schema version starts at 1.
- Sort entries and file paths bytewise.
- Normalize archive modification times, ownership, group, and permission classes.
- Do not include local absolute paths in the remote manifest. Preserve source path only in local list
  output; remote provenance for a Skill is its declared name and content digest.
- Preserve Git repository URL, requested ref, and resolved commit for Pi packages, after stripping
  any URL userinfo.
- Calculate per-file digests, per-item digests, and one digest for the final normalized archive.
- Use a bounded format supported by both the CLI host and the pinned container without downloading a
  new extractor. Prefer deterministic `tar.gz`; verify the actual available tar/gzip behavior before
  fixing the format contract.
- Include the manifest inside the archive and upload the same decoded manifest separately for control
  plane inspection.
- Bundle identity is the final lowercase SHA-256 digest. Never use timestamps as identity.

Before coding the archive boundary, define adversarial fixtures for `../`, absolute paths, duplicate
members, type changes, symlinks, hard links, oversized expansions, truncated archives, manifest/file
disagreement, and digest disagreement.

## Cloudflare storage and authority

The local JSON is desired state, not runtime authority. A Session cannot read the operator's laptop,
and create retries must not consult mutable local state.

Add two installation-owned resources in the one-time deployment:

1. A dedicated R2 bucket for immutable sandbox bundle archives and manifests.
2. A SQLite-backed installation Sandbox Configuration Durable Object namespace.

Do not use KV as authority. Do not overload the session backup bucket or evidence artifact bucket.
Do not put archive bytes in Durable Object storage.

The Sandbox Configuration Durable Object has one fixed logical installation object because each
deployed installation already has its own namespace. It owns:

- schema version;
- active sandbox digest or the explicit built-ins-only state;
- immutable manifest metadata for known digests, or stable references to those manifests;
- the last synchronization idempotency key and terminal result;
- a single mutation lease/revision for compare-and-set commit.

R2 keys are digest addressed, for example:

```text
sandbox-bundles/sha256/<digest>/bundle.tar.gz
sandbox-bundles/sha256/<digest>/manifest.json
```

Objects under a digest are immutable. Upload with a create-only condition. If the object already
exists, verify its metadata/digest instead of overwriting it. V1 never automatically deletes these
objects.

### Synchronization transaction

1. CLI sends the decoded manifest, archive size/digest, and an idempotency key through a root-only
   endpoint.
2. Worker decodes and bounds all headers/body/manifest fields before storage use.
3. Worker streams the bounded body to the immutable R2 key. Use the R2 checksum contract when the
   pinned Workers types support SHA-256 verification; otherwise verify through a bounded streaming
   digest adapter before accepting success.
4. Worker verifies the separate manifest agrees with digest-addressed object metadata.
5. Only after immutable objects exist does the Sandbox Configuration DO compare-and-set the active
   pointer and persist the idempotent terminal result.
6. The response returns the active digest and whether the operation uploaded, activated, or was a
   no-op.

If upload succeeds but activation fails, the object is harmless retained data and the old pointer
remains active. If the response is lost after activation, retry/query by idempotency key and digest.
Never infer activation from R2 object presence.

Expose only root-authenticated management routes. Session creation may read the active digest through
an internal binding/RPC boundary. Browser clients and standard paired clients receive no bundle
management scopes in v1.

## Session lifecycle integration

### Persisted session contract

Extend the authoritative Session record with an optional field such as:

```ts
readonly sandboxBundle?: {
  readonly digest: string
  readonly manifestVersion: 1
}
```

Derive the TypeScript type from its Effect Schema. Absence means the built-ins-only configuration for
legacy records. Do not use `active`, `latest`, a local path, or an R2 key as the persisted identity.

Add the digest to safe session inspection/JSON output so tests and operators can prove which bundle
was selected. Do not expose bundle contents or local source paths.

### Create ordering

The create workflow must follow this order:

1. Validate create input and acquire the existing create/operation authority.
2. Read the active sandbox digest and manifest metadata from the Sandbox Configuration authority.
3. Arm the hard cap and commit the initial Session record including the selected digest.
4. Prepare repository/workspace and credentials using existing behavior.
5. Materialize and verify the Session's recorded sandbox bundle.
6. Seed Pi/Codex settings and merged Skill paths.
7. Run the required-package preflight.
8. Start the existing Pi RPC supervisor.
9. Commit warm success and projection using existing lifecycle rules.

A create retry begins from the recorded Session digest. It must not reread the installation's active
digest after initial-record commit.

If materialization fails, preserve the existing typed create retry/failure semantics. Never silently
fall back to built-ins or a newer digest.

### Snapshot, sleep, and resume

- Synchronizing installation configuration never wakes or mutates a Session.
- Snapshot continues to quiesce and stop Pi before sync/backup.
- Materialized bundle files may be included in the whole-session backup, but the immutable R2 bundle
  remains their source of truth.
- Resume restores the current Session backup, then rematerializes or fully verifies the Session's
  recorded digest before reseeding and starting Pi.
- If the pinned bundle is missing or invalid, return a typed recoverable failure. Do not substitute
  the installation's current active digest.
- Do not add an “upgrade Session configuration” operation in v1.

### Vaporize

- Delete Session-owned workspace/backup/runtime state through existing retry semantics.
- Do not delete shared sandbox bundle objects or Sandbox Configuration history.
- Do not infer bundle retention from KV projections.

## Container materialization

Materialize under the authoritative Session root, for example:

```text
/workspace/<session-id>/.scotty/sandbox/<digest>/
  manifest.json
  skills/...
  pi-packages/...
```

Use a sibling staging directory and rename only after every check succeeds. Required behavior:

1. Stream the R2 archive into the container without giving the container R2 credentials.
2. Verify archive digest before extraction.
3. List and validate archive members before extraction.
4. Reject absolute paths, traversal, duplicates, symlinks, hard links, devices, FIFOs, unexpected
   roots, excessive files, excessive bytes, and manifest disagreement.
5. Extract without preserving owner, group, setuid/setgid, or unsafe modes.
6. Recompute and verify all manifest file digests after extraction.
7. Make the finalized bundle tree non-writable before Pi loads it.
8. Keep a small verified marker containing only digest and manifest schema version. A marker is a
   cache hint, not authority; resume must still ensure content agreement.

The current `SandboxRuntime` supports only string writes. Extend the smallest runtime boundary needed
to stream an R2 body through the native Cloudflare Sandbox `writeFile` stream contract. Preserve
native streams at the host boundary and wrap transport failures as typed Effects.

Do not make the container fetch a public or presigned object URL. Do not expose the R2 key to Pi.

## Pi and Codex seeding

Replace the direct Skill symlinks to `/opt/scotty/skills` with a Session-local merged Skill directory:

```text
/workspace/<session-id>/.scotty/merged-skills/
```

Populate it deterministically with links to reviewed built-in Skill directories followed by links to
verified installation Skill directories. Because collisions were rejected, every link name is
unique. Point both `$CODEX_HOME/skills` and `$PI_CODING_AGENT_DIR/skills` at the merged directory.

Generate Pi settings from:

```ts
packages: [...PI_PACKAGES, ...verifiedInstallationPackagePaths]
```

Do not mutate `/opt/scotty/skills`, `/opt/scotty/pi-packages`, or the checked-in image package
settings. Do not call `pi install` in the Session.

Run an offline, bounded preflight after seeding and before supervisor start. At minimum it must prove:

- all required Pi packages remain discoverable;
- every configured package path stays under the verified digest directory;
- every configured Skill path stays under the merged/verified directories;
- no settings entry points to a mutable temporary staging directory.

The main Pi supervisor remains one persistent `pi --mode rpc` child. No reload command or browser
protocol change is needed because v1 applies configuration only before Pi starts.

## API contracts and failures

Add versioned Schemas for:

- local sandbox configuration;
- Skill source and resolved Skill metadata;
- Pi package source and resolved Git/package metadata;
- bundle manifest and file inventory;
- sync request metadata and response;
- remote sandbox configuration status;
- Session sandbox bundle pin;
- every new typed error envelope code.

Suggested failure codes, adjusted to existing naming conventions:

```text
sandbox_config_invalid
sandbox_source_invalid
sandbox_source_auth_failed
sandbox_git_ref_invalid
sandbox_package_unsupported
sandbox_name_conflict
sandbox_bundle_too_large
sandbox_bundle_digest_mismatch
sandbox_bundle_upload_failed
sandbox_bundle_activation_conflict
sandbox_bundle_unavailable
sandbox_bundle_materialization_failed
sandbox_bundle_preflight_failed
```

Do not leak process stderr wholesale. Redact repository URLs containing userinfo and bound all
messages. Distinguish source preparation, upload, activation, materialization, and preflight so the
recovery action is clear.

## Expected file and symbol seams

The implementer must recheck current HEAD before editing. Start with these likely seams rather than
inventing parallel infrastructure:

### CLI

- `cli/src/commands.ts`: remove old `skills`; add the `sandbox` command group; integrate init/deploy.
- `cli/src/pure.ts` and `cli/skills/scotty/SKILL.md`: remove embedded Skill output and dead asset.
- `cli/src/schemas.ts`: decoded CLI/API response shapes.
- `cli/src/dependencies.ts`: private local-file access if it matches existing ownership.
- `cli/src/services.ts`: source preparation, bundle builder, and synchronization service contracts.
- New focused modules such as `cli/src/sandbox-config.ts`, `cli/src/sandbox-sources.ts`, and
  `cli/src/sandbox-sync.ts`; keep pure decoding/normalization separate from process/filesystem hosts.
- `cli/test/cli.test.ts` and focused Effect tests: public grammar, JSON, exit codes, config safety,
  process boundaries, deterministic fixtures, and sync recovery.
- `cli/src/deployment-inputs.ts`: remove obsolete embedded Skill input if it is no longer needed; do
  not put the user's local sandbox JSON into the deployment archive.

### Infrastructure

- `infra/installation.ts`: deterministic user-chosen installation resource names for the new bucket
  and DO namespace; update adoption/recovery shapes deliberately.
- `infra/cloudflare-stack.ts`: one R2 resource, one SQLite-backed DO export/binding, Worker bindings,
  and deployment fingerprint/proof.
- `worker/src/bindings.ts`: typed bindings and any non-secret resource-name metadata actually needed.
- Local test/deployment bindings and Alchemy integration tests.

### Worker authority and routes

- New `worker/src/sandbox-config-contracts.ts`: Schemas and derived types.
- New `worker/src/sandbox-config-store.ts`: authoritative state transitions and idempotency.
- New `worker/src/sandbox-config-object.ts`: minimal Durable Object RPC host adapter.
- New `worker/src/sandbox-bundle-store.ts`: R2 immutable-object Effect service and typed failures.
- `worker/src/index.ts`: root-only sync/status routes and internal authority wiring.
- Export the new Durable Object through the same Alchemy/Worker entrypoint convention as existing
  Auth, Runner Registry, and Session objects.

### Session runtime

- `worker/src/contracts.ts`: optional pinned digest on the versioned Session record and safe output.
- `worker/src/session.ts`: initial pin, phase-aware create replay, materialize-before-seed/start,
  resume verification, and failure reconciliation.
- New `worker/src/sandbox-bundle-materializer.ts`: bounded stream, validation, extraction, verification,
  atomic finalize, and preflight.
- `worker/src/sandbox-runtime.ts`: the smallest streaming write capability.
- `worker/src/container-auth.ts`: merged Skill directory and additive verified package paths.
- `worker/src/workspace.ts`: Session-root paths only; do not make workspace state authoritative.
- Session projection/API serializers: expose only the selected digest where useful.

### Container

- Reuse existing `tar`, `gzip`, `sha256sum`, `find`, and Pi binaries only after verifying their exact
  image availability/behavior.
- Do not change the built-in package sources or their pin manifest in the initial slice.
- Add a tiny image-local validation script only if a carefully argv-built command cannot provide a
  testable boundary. Keep it general to the bundle contract and cover it with hostile fixtures.

## Vertical implementation slices

Each slice must be end-to-end enough to demonstrate one behavior. Preserve the existing dirty CLI
work and adjust to it rather than reverting it.

### Slice 1: Local JSON and CLI grammar

Implement Schemas, atomic private-file persistence, old-command removal, and `sandbox add/remove/list`
against local state. Use fake Git/filesystem/process services. Do not contact Cloudflare yet.

Acceptance:

- Empty first-use file is created as v1 and mode `0600`.
- Direct malformed edits fail without overwrite.
- Skill addition derives the decoded name.
- Git addition persists a resolved commit, never a floating ref.
- Add/remove are deterministic and idempotent where appropriate.
- Bare `scotty skills` is an unknown command with the existing bad-usage exit contract.

### Slice 2: Deterministic source preparation

Implement safe Skill walking, detached Git preparation, Pi package validation, locked dependency
installation without scripts, manifest construction, deterministic archive output, and collision
checks.

Acceptance:

- Identical inputs produce identical manifest and archive digests.
- Source mutations change the digest.
- Hostile paths/types/archives and oversized inputs fail closed.
- No source directory is modified.
- No credential appears in config, manifest, argv capture, stdout, stderr, or error output.

### Slice 3: Installation storage and sync

Provision the dedicated R2 bucket and Sandbox Configuration DO. Implement root-only status/sync,
immutable upload, checksum agreement, compare-and-set activation, and idempotent reconciliation. Wire
`sandbox sync`; make add/remove call it.

Acceptance:

- First empty sync establishes built-ins-only/empty-additions state.
- Repeated identical sync is a no-op.
- Concurrent different syncs serialize; a stale expected revision cannot overwrite a newer one.
- Upload failure and activation failure leave the old active digest.
- Lost-response retry reports the committed result without duplicate mutation.
- Standalone sync does not execute Alchemy or image build code.

### Slice 4: Session pin and materialization

Persist the active digest in initial Session authority, stream and validate the bundle, materialize it
atomically, merge Skills, generate additive Pi settings, preflight, and start Pi.

Acceptance:

- A new Session receives exactly the digest active at initial-record commit.
- Changing installation state during a create retry does not change its pinned digest.
- Materialization failure never starts Pi or reports warm success.
- Built-in packages remain first and present.
- A configured Skill is discoverable by Pi and through the Codex Skill path.
- A configured Pi extension registers its expected headless RPC surface.
- Container environment/files/logs contain no real Codex/GitHub credential introduced by the bundle
  flow.

### Slice 5: Resume and cleanup semantics

Make snapshot/resume/vaporize preserve the pin and shared-object ownership rules.

Acceptance:

- Installation sync does not touch or wake sleeping/warm Sessions.
- Resume uses the pinned digest after backup restore.
- Missing/corrupt pinned data is a typed visible failure with retry state.
- Vaporize deletes Session-owned materialization/backup state but not shared bundle objects.

### Slice 6: Init/deploy integration and full proof

Invoke sandbox synchronization after successful init/deploy, preserve partial-success reporting, and
add the fake/local and guarded deployed proof.

Acceptance:

- Fresh `init` produces an immediately usable built-ins-only installation plus local sandbox JSON.
- A populated local config is synchronized during init/deploy.
- A sync failure after successful deployment gives an exact retry command and does not corrupt the
  installation pointer.
- After initial deployment, adding a harmless Skill and Pi extension and running only `scotty sandbox
  sync` makes them available to a newly created live sandbox.
- Updating/removing them and syncing again affects a later new sandbox without Worker/image deploy.

## Verification matrix

Run the smallest focused check after each slice, then the repository baseline before declaring the
plan implemented.

### Focused local proof

- Schema decoding and excess-property rejection.
- CLI parser/help/stdout/stderr/JSON/exit-code snapshots.
- Mode `0600`, atomic write, interruption, and malformed-file preservation.
- Git argv capture, detached commit resolution, auth failure, redaction, and cleanup.
- Skill and Pi package fixture validation.
- Deterministic archive reproduction across two clean temporary roots.
- Hostile archive/path/type/size/digest fixtures.
- R2 create-only/checksum and DO state-machine contract tests.
- Route authentication, body bounds, idempotency, and lost-response reconciliation.
- Create initial-pin ordering and replay tests.
- Container materializer, merged Skills, Pi settings, and required-package preflight tests.
- Resume/vaporize ownership tests.
- Credential-negative and egress-negative scans.

### Repository baseline

```sh
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
```

Also run the existing Pi package pin check and any Alchemy no-op/integration gate affected by new
resources. Formatting precedes lint. Do not format or lint `vendor/**`.

### Guarded deployed proof

Local fakes do not prove this feature. With explicit deployment/destructive-test authorization:

1. Deploy the one-time storage/DO changes to a disposable installation.
2. Record the deployed Worker/container version and initial active sandbox status.
3. Add one harmless Skill fixture and one harmless headless Pi extension fixture.
4. Run `scotty sandbox sync` only. Prove no Worker or container deployment occurred.
5. Create a Session and record its sandbox digest.
6. Prove the Skill is discoverable and the extension's expected RPC command/tool surface is present.
7. Update both sources, sync again without deployment, and create a second Session.
8. Prove the first and second Sessions have different expected digests and the second sees the new
   content.
9. Remove both, sync, create a third Session, and prove it contains only the required base.
10. Run credential-negative inspection and verify no Git/npm resolution occurred in any Session.

Do not call the feature complete without this canary. Report local/fake proof separately from deployed
proof.

## Documentation and completion handoff

Update user documentation only after command and JSON contracts stabilize. Document:

- the private JSON path and complete schema;
- direct-edit plus `sandbox sync` workflow;
- add/remove/list examples;
- exact Git/package constraints;
- the difference between required built-ins and installation additions;
- that changes apply to new Sessions only;
- source review/executable-code warning;
- failure recovery and how to prove the active digest;
- uninstall retention/deletion behavior for the new R2/DO resources.

At final handoff, explicitly classify:

- what works now;
- what remains intentionally unsupported;
- which checks passed;
- whether a deployed no-redeploy canary ran;
- committed, staged, unstaged, pushed, and deployed state;
- any unrelated pre-existing worktree changes that were preserved.

## Implementer cautions

- Recheck live HEAD, branch, origin, and dirty state before editing. This plan was written against
  `29e43917ab156f0beaa722e4a89ab485b05edf35` with unrelated CLI WIP already present.
- The CLI WIP touches `commands.ts`, deployment inputs, installation deployment/services, and CLI
  tests. Preserve it and integrate rather than reverting it.
- Follow the repository's Effect v4 and Alchemy source-first rules before introducing new patterns.
- Decode local JSON, Git/package manifests, HTTP bodies, R2 metadata, DO state, archive manifests, and
  process results at their boundaries.
- Keep native Request, Response, ReadableStream, R2, Durable Object, and Sandbox callbacks as thin
  host adapters; run typed domain Effects within the approved ownership boundary.
- Keep real credentials out of bundle bytes, manifests, R2 metadata, DO state, command arguments,
  logs, API responses, Alchemy props/state/outputs, and container state.
- Preserve the Session operation lease, hard-cap-before-commit rule, backup authority, and typed
  retry/failure semantics.
- Never use KV or a local file as remote authority.
- Never report synchronization success from archive upload alone; the Sandbox Configuration DO
  commit is the terminal authority.

