# Capability bundles for Scotty sandboxes

Research note — 2026-08-12. This is a source-grounded comparison for a narrow
capability-bundle feature: an installation-owned set of Agent Skills and Pi
extensions that can be added, updated, or removed and then becomes available in
every new sandbox without rebuilding or redeploying the container image or
Cloudflare infrastructure.

## Executive recommendation

Build one installation-owned **capability catalog** and one immutable **bundle
revision** per change. Keep the catalog and revision metadata in the installation
control plane; keep the immutable bundle payload in R2 (or the installation's
existing artifact store); at session creation, materialize the selected revision
into the sandbox and configure Pi to load those local resources. New sessions
read the current installation revision. Existing warm sessions do not silently
change: they need an explicit reload when Pi supports it, or a stop/restart and
reseed when an extension's code or dependency set changed.

The first version should support only:

* installation-scoped bundles, not arbitrary per-session package management;
* explicit add, update, remove, list, and revision/pin selection;
* skills (`SKILL.md` plus bounded resources) and Pi extensions/packages;
* immutable content digests and source provenance;
* fail-closed validation and trust approval before code is loaded;
* deterministic precedence and duplicate-name rejection;
* a clear reload/restart status for warm sessions.

This shape reuses the useful part of Amp and Pi while preserving Scotty's
authoritative Sandbox Durable Object and credential boundaries. It does **not**
turn R2 into executable authority, let a container fetch arbitrary code, or
make a global mutable singleton responsible for all sessions.

## What the primary sources establish

### Amp: scope, precedence, publication, and reload

Amp's current manual defines skills as directories containing instructions and
optional resources. A project skill lives in `.agents/skills/`; a personal/global
skill is installed under `~/.config/agents/skills/`. Amp supports installing from
an npm/git/local source and can publish personal or workspace skills through
separate Git repositories. New threads load a published skill automatically;
the current thread can explicitly reload it. The manual says the source
repository is changed and committed before publishing, and repository owners can
require signed commits. [Amp Owner's Manual — Agent Skills](https://ampcode.com/manual#agent-skills)

Amp's precedence is first match by frontmatter `name`: global user directories
win project directories, compatibility directories, configured extra paths,
built-ins, and repositories. This is useful as a policy concept, but the full
ordering is too broad for Scotty. Scotty should use a smaller explicit ordering
and reject ambiguous duplicate identities rather than let an unexpected local
copy mask an installation-approved capability. [Amp precedence and reload](https://ampcode.com/manual#agent-skills)

Amp's manual also makes an important lifecycle distinction: listing skills from
another shell does not reload an existing session; the running session needs a
reload operation. The current manual documents `amp skills list`, JSON output,
and `reload_skills`, while the current Amp product note says newer Amp removed
its own add/remove/update subcommands and expects a separate skills tool for
management. Therefore, copy the *separation of management from runtime reload*,
not a particular Amp CLI command set. [Amp reload behavior](https://ampcode.com/manual#agent-skills),
[Amp Neo lifecycle note](https://ampcode.com/news/neo)

Amp's Agent Skills announcement describes the core optimization: metadata is
available for discovery, while specialized instructions are loaded lazily when
needed. [Amp Agent Skills announcement](https://ampcode.com/news/agent-skills)

### Agent Skills: portable shape and progressive disclosure

The Agent Skills specification defines a directory with a required `SKILL.md`
and optional `scripts/`, `references/`, and `assets/` directories. Frontmatter
requires a lowercase `name` (1–64 characters) and non-empty `description` (up
to 1024 characters); optional fields include `license`, `compatibility`,
`metadata`, and experimental `allowed-tools`. The specification recommends
loading metadata first, then the full instructions on activation, then optional
resources only as needed. It also recommends relative references from the skill
root and validating a skill with `skills-ref validate`. [Agent Skills
specification](https://agentskills.io/specification)

For Scotty this is a good on-disk interchange format, not a trust model. A
valid `SKILL.md` can still instruct an agent to run dangerous commands. The
bundle gate must validate both structure and provenance, and must classify
scripts as executable content even when the package is nominally “just a skill.”

### Pi: package declarations, pinning, scope, and runtime resources

Pi packages bundle extensions, skills, prompt templates, and themes. A package
can declare exact resource paths in `package.json` under `pi`, including
`extensions` and `skills`; otherwise Pi applies conventional discovery rules.
Pi supports npm, git, and local sources. Its documented install/remove/update
commands manage a settings file, with global settings in `~/.pi/agent/settings.json`
and project settings in `.pi/settings.json`; project settings can be shared and
missing packages are installed on startup. [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Pi's pinning rules are directly reusable: npm specs with a version are pinned;
git specs with a tag or commit are pinned; update does not move pinned refs. To
move a pinned git package, the operator supplies a new ref explicitly. Pi also
reconciles a changed git checkout before loading it. [Pi package sources and
pinning](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Pi explicitly warns that packages run with full system access: extensions are
arbitrary code and skills can instruct the model to take actions. Its security
policy says Pi relies on users installing trustworthy extensions and loading
trustworthy skills. This is a critical Scotty distinction: a remote installation
must add a provenance/trust gate instead of inheriting Pi's local-user trust
assumption. [Pi package security warning](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md),
[Pi security policy](https://github.com/earendil-works/pi/blob/main/SECURITY.md)

Pi extensions can be global (`~/.pi/agent/extensions/`) or project-local
(`.pi/extensions/`) and can be hot-reloaded with `/reload`. The extension API's
`resources_discover` event runs at startup and reload, and can contribute skill,
prompt, and theme paths. A loaded extension can register a tool after startup,
and Pi says those new tools are refreshed immediately; code loaded from an
extension package still needs a restart/reload boundary when the package itself
changes. [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

The current Scotty image already uses this native Pi shape: `piSettings()` puts
an ordered package list in the session's settings, and `PI_PACKAGES` names the
image-installed extension packages (`worker/src/container-auth.ts:8-19,
58-74`). Several checked-in packages declare Pi extensions and/or skills in
their `package.json` `pi` field (`worker/container/pi-packages/sources/*/package.json`).
That means a bundle manifest can stay close to Pi's package model while keeping
the installation catalog outside the image.

## Scotty's current authority and the seam to extend

The current implementation is image-owned and deployment-coupled:

* `DEPLOYMENT_INPUTS` and `CONTAINER_INPUTS` include `worker/container`, so a
  package change currently participates in image/deployment input hashing
  (`cli/src/deployment-inputs.ts:7-32`).
* The Dockerfile copies skills and Pi packages into `/opt/scotty`, runs
  dependency installation, performs offline Pi package discovery, and makes
  `/opt/scotty/pi-packages` and `/opt/scotty/skills` read-only
  (`worker/container/Dockerfile:122-127,135-165,171-200`).
* Per-session seeding symlinks both `$CODEX_HOME/skills` and
  `$PI_CODING_AGENT_DIR/skills` to the image's `/opt/scotty/skills`, and writes
  the Pi settings/package list into the session home
  (`worker/src/container-auth.ts:168-195`).
* The package manifest records repository commits, source SHA-256 digests, image
  paths, and npm integrity (`worker/container/pi-packages/manifest.json:1-94`).
  This is a strong provenance pattern to retain, but the image manifest is not
  a mutable installation catalog.
* `Bindings` already separate per-session Sandbox DO authority, KV listing, and
  R2 buckets (`worker/src/bindings.ts:6-26`). The project instructions state
  that Sandbox DO storage is authoritative, KV is a non-secret list projection,
  and R2 contains immutable backups. A capability catalog should follow that
  model, with a DO-owned revision pointer/operation lease and immutable R2
  bundle objects, not container files or Effect memory as authority.

The likely narrow seam is:

```text
installation catalog + revision pointer (authoritative control plane)
              |
              v
immutable bundle manifest + payload (R2, digest addressed)
              |
              v
Sandbox create -> verify digest -> materialize local bundle -> Pi settings
              |
              v
Pi startup/reload (skills + extensions)
```

The existing `/opt/scotty/skills` remains the immutable built-in baseline. The
installation bundle should be mounted/materialized at a separate path (for
example, a session-local `.scotty/capabilities/<revision>/`) and added to Pi's
package/resource settings. Do not replace the baseline symlink with mutable R2
content, and do not let a user-selected bundle alter the image's credential or
network policy.

## Proposed capability-bundle contract

### Identity and manifest

Give every item a stable installation-local ID and kind (`skill` or
`pi-package`), plus:

* source type and locator (registry, git URL, or uploaded archive);
* immutable version/ref and resolved commit/version;
* SHA-256 digest of the normalized archive/content;
* declared name, description, license, compatibility, and resource paths;
* dependency lock data for Pi packages;
* trust decision and approving principal;
* added/updated timestamps and supersession metadata.

Validate the Agent Skills frontmatter and relative resource paths, validate Pi
package manifests against the checked-in/native Pi shape, reject path traversal,
symlinks, duplicate IDs, duplicate skill names, and package declarations that
escape the bundle root. Keep the source archive and manifest immutable after
publication. Updating creates a new revision; removing creates a new revision
without the item. Never mutate bytes in place while a session can be reading
them.

### Precedence

Use this intentionally small order:

1. Scotty built-ins from the image (`/opt/scotty/skills` and the fixed package
   set), always present and versioned with the image.
2. Installation-approved bundle items, ordered by manifest order.
3. Session-local project resources, only if the existing Pi trust policy allows
   them and only for that session.

Within an installation bundle, duplicate skill names or duplicate extension
resource identities should be a validation error. If compatibility with Pi
requires shadowing, make it an explicit manifest field and surface the winning
identity in `list`; never rely on directory traversal order. This differs from
Amp's broad first-match precedence because remote execution needs deterministic
review and no accidental masking.

### Pinning and updates

Expose `bundle revision` as the primary pin. A session record should retain the
revision it was created with, while new sessions use the installation's current
revision unless the caller explicitly selects an older retained revision.

For each item, preserve Pi's useful pin rules: exact npm versions and git tags or
commits do not float during update. “Update” should resolve a new source, produce
a new digest and revision, and require an explicit approval. A failed download,
decode, dependency install, or digest check must leave the current revision
untouched.

### Reload, restart, and session behavior

Classify a revision change:

* **Skills-only:** safe to materialize and ask a warm Pi session to reload its
  resources if the supported runtime exposes that operation. Existing turns
  keep their already-loaded context; later turns see the new resource set.
* **Extension source/config change:** requires Pi `/reload` (or an equivalent
  supervisor action), with a bounded status/receipt. If reload fails, keep the
  old process and report the old revision as active.
* **Dependency/runtime/image change:** requires quiesce, reseed, and restart;
  never replace a running extension directory underneath the process.

For a sleeping session, do not wake it merely to update capabilities. Record the
new installation revision for future sessions. On resume, either retain the
session's pinned revision or require an explicit “resume with current revision”
operation that is visible in the session record and guarded by the existing
operation lease.

### Executable trust and credentials

Skills can contain scripts, and Pi extensions execute arbitrary code. Treat every
Pi package as executable, even if its primary payload is markdown. Require a
source allowlist or explicit operator approval, inspect archive contents, record
license/provenance, verify a digest before materialization, and run package
installation without lifecycle scripts unless a reviewed exception exists.

The bundle path must not receive real Codex/GitHub credentials. The current
Scotty session environment uses sentinels and an egress boundary
(`worker/src/container-auth.ts:82-85, agentEnv()` near the end of the file;
`worker/src/egress.ts`). New extension tools inherit that boundary. Do not place
secrets in manifests, R2 metadata, package settings, command arguments, logs, or
the bundle archive.

## Cloudflare primitive fit (only what is needed)

Cloudflare Durable Objects are a single-threaded, globally unique instance with
persistent storage and are intended for stateful coordination. The Cloudflare
guidance recommends one object per logical coordination atom, not one global
singleton. That maps to an installation capability catalog DO (or an existing
installation authority) holding the current revision, immutable revision
records, idempotency, and an operation lease. [Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

R2's Worker binding supports read/list/write/delete and conditional reads/writes,
but Cloudflare explicitly says bucket authorization must be implemented by the
Worker. Use R2 only for digest-addressed immutable bundle payloads; authorize all
reads through the installation/session boundary and never expose a raw bucket
key as a capability. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)

If a future asynchronous publish/cleanup operation needs wake-up, Durable Object
alarms provide at-least-once execution with retries, but handlers must be
idempotent and there is only one alarm per object. Do not use an alarm as the
catalog itself or as proof that a provider operation completed. [Durable Object
alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

## What not to copy

* **Do not copy Amp's broad precedence chain.** Compatibility directories,
  built-ins, personal repositories, and extra search paths are useful for a
  local desktop product but create hidden masking in a remote installation.
  Keep Scotty's three explicit layers and reject duplicates.
* **Do not copy Pi's local-user trust boundary.** Pi warns that packages execute
  with full system access. Scotty must add provenance, digest, approval, and
  archive/path gates before an extension reaches a sandbox.
* **Do not copy Pi's package manager into every sandbox.** Per-sandbox `pi
  install`, arbitrary network fetches, mutable npm/git checkouts, and automatic
  install-on-startup would bypass installation ownership, make reproducibility
  impossible, and create a new credential/egress review surface.
* **Do not make R2 or the container authoritative.** A bundle directory is a
  materialized cache. The installation catalog/revision and session pin belong
  in the control plane; R2 is immutable payload storage.
* **Do not overwrite `/opt/scotty/skills` or the fixed package list.** Those are
  the image's reviewed baseline today (`worker/src/container-auth.ts:8-19`,
  `worker/container/Dockerfile:122-127`). Add a separate installation layer.
* **Do not infer that a reload succeeded because files changed.** Pi documents
  reload as an explicit runtime event; Scotty needs a receipt/status tied to the
  session revision. If the extension process did not reload, report the prior
  active revision.
* **Do not treat Agent Skills metadata as executable safety.** `name`,
  `description`, and `license` are discovery/interoperability metadata, not a
  sandbox permission model.
* **Do not redeploy Cloudflare infrastructure for each capability change.** The
  point of this bundle is to keep the Worker/DO/image stable while changing
  installation-owned, digest-verified content. Image changes remain necessary
  for baseline/runtime/toolchain changes.

## Smallest proof ladder before implementation is called ready

1. Pure manifest tests: valid/invalid Agent Skills, package declarations,
   traversal/symlink rejection, duplicate identity rejection, digest mismatch,
   and revision immutability.
2. Control-plane contract: add/update/remove/list, idempotency, current revision,
   session pin, failed publish leaves the old revision active.
3. Materialization test: a new sandbox receives exactly the selected revision,
   with no real credentials, no network fetch, and no image mutation.
4. Pi integration test: startup discovers the bundle; skill-only reload changes
   later resource discovery; extension change reports reload/restart status;
   failure preserves the old active revision.
5. Lifecycle test: sleeping sessions are not woken by catalog changes; resume
   behavior is explicit; concurrent edits serialize through the installation
   authority.
6. Deployed canary: add a harmless test skill and Pi extension to the managed
   installation, create a new sandbox without rebuilding/deploying the image,
   prove the capability is loaded, then remove it and prove a later sandbox no
   longer loads it. Inspect the exact artifact digest and session revision.

The local tests and fake transport are not deployment proof. The final canary
must prove the live installation revision, live sandbox materialization, and
the absence of credential or arbitrary-network leakage.

## Source index

* Amp Owner's Manual: https://ampcode.com/manual#agent-skills
* Amp Agent Skills announcement: https://ampcode.com/news/agent-skills
* Amp current lifecycle note: https://ampcode.com/news/neo
* Agent Skills specification: https://agentskills.io/specification
* Pi Packages: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
* Pi Extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
* Pi security policy: https://github.com/earendil-works/pi/blob/main/SECURITY.md
* Cloudflare Durable Object rules: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
* Cloudflare Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
* Cloudflare R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-usage/

