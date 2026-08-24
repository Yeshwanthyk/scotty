---
title: Define the thin Sandbox setup
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the config and Plugin contract
  - Define the credential and login state machine
---

## Question

Which exact binaries, Pi features, browser support, Hatch support, Skills, extensions, startup rules, and diagnostics belong in the base image, and which must move to optional administrator-installed Plugins?

## Inherited repository contract

Every Session receives the protected Git helper or local protocol needed to present its stable
sentinel to provider-local Git, model, and scoped HTTPS brokers. It stores no real credential or
provider token in environment, files, Git config, arguments, logs, or repository content. Pi and
Plugin setup contains only sentinel-shaped descriptors and typed credential requirements.

## Resolution

Scotty uses three setup layers. The immutable base contains only universal runtime and safety
capabilities. Product-owned Hatch and evidence capture are installed but dormant. One pinned
deployed snapshot selects administrator-controlled Pi behavior, Skills, extensions, and Sandbox
tool Plugins for each new Session.

### Standard configuration without local Pi

Local Pi is not a prerequisite. `scotty init` generates a safe standard configuration, asks the
administrator to select a Pi provider, model, and thinking level, and writes those non-secret
choices into `~/.config/scotty/config.json`. An administrator may edit the same file directly.
Scotty does not silently import `~/.pi/agent/settings.json`.

The private config gains one `pi` object. It uses Pi's setting names for an explicit allowlist of
behavior settings. `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` are required for
the alpha setup. Optional allowed settings cover:

- thinking display and token budgets;
- retry, compaction, and branch-summary behavior;
- steering and follow-up delivery;
- safe terminal, image, and Markdown display;
- a built-in theme and ordinary non-secret UI preferences; and
- model cycling within the selected provider.

Sync strictly validates those settings against the pinned Pi release. Unknown or blocked Pi keys
fail validation. The generated standard turns Pi telemetry, analytics, update checks, and package
installation off.

Scotty owns and replaces all Pi settings for credentials, auth, packages, extensions, Skills,
prompts, themes from paths, built-in tool policy, project trust, shell paths or command prefixes,
package-manager commands, proxy or network routing, Session directories, executable resource
paths, and Scotty RPC transport. The config and deployed snapshot contain no auth file, secret,
host path, or usable credential reference.

Repository `AGENTS.md` remains context. Repository `.pi` settings, packages, extensions, Skills,
prompts, themes, system prompt files, and `.agents/skills` do not load automatically. Executable or
instruction resources enter a Session only through the administrator-approved deployed snapshot.

### Immutable base

Every offered provider supplies the same versioned base capabilities:

- its provider runtime and operating-system isolation;
- CA certificates, a basic shell, and required core utilities;
- a pinned Node runtime and pinned Pi core;
- one Scotty Pi RPC supervisor and its framed control protocol;
- the Scotty runtime adapters and protected model, Git, and scoped HTTPS broker helpers;
- Git for the Session's own Artifacts Fork, without `gh` or direct GitHub authentication; and
- the product-owned Hatch and browser-evidence extensions plus Chromium, Playwright, Xvfb, and
  ffmpeg.

Hatch, Chromium, Xvfb, ffmpeg, and capture processes remain stopped until a Hatch or evidence job
requests them. Backend work pays image size but no active process cost. The capability remains
available later in the same Session.

The base has no real credential, provider token, `GH_TOKEN`, direct GitHub helper, Codex CLI,
Codex-specific config, arbitrary package installer, or model/provider/thinking hardcode. Provider
and model requests cross only the typed Session broker. Git reaches only the Session Fork through
the sentinel broker.

### Standard setup and Plugins

The generated config enables a versioned built-in `standard` Sandbox tool Plugin. It contains the
current broad coding set:

- Node, npm, Bun, Corepack, and pnpm;
- Python, `uv`, and `uvx`;
- Go and `gofmt`;
- C and C++ build tools, `make`, and `pkg-config`;
- Git, `rg`, `fd`, `ast-grep`, `jq`, `yq`, `qsv`, and `shellcheck`.

It excludes `gh` and every direct GitHub credential path. The administrator may omit `standard`
or add validated built-in or local-path Sandbox tool Plugins. Alpha never runs an arbitrary
package-manager or shell installation command during Sync or Session startup. A tool Plugin bundles
its immutable commands and declares exact readiness probes.

The product-owned Hatch and browser extensions always load because they implement required
Session capabilities; they are not administrator Plugins. The generated setup also selects the
built-in Pi-only subagents extension and its Skill. Administrators may remove subagents or select
other approved Pi extension and Skill Plugins. The current Codex compaction package is removed;
Pi core owns configured compaction.

Setup order is explicit, but it is not hidden override precedence. Sync rejects duplicate Plugin
IDs, Skill names, Pi extension identities, tool command names, or resource destinations. The
failure names both owners and requires a config change.

### Snapshot and Session materialization

Sync resolves the base release, sanitized Pi behavior settings, built-in and local Plugin bundles,
ordered setup, manifests, command inventories, readiness probes, and credential requirements. It
shows one plan, prepares immutable content, verifies it, and atomically activates one digest-pinned
snapshot. A failed preparation leaves the previous snapshot active.

Session Create pins the active snapshot and required credential generations. It creates or
recovers the exact Artifacts Fork, materializes only the pinned non-secret content, writes a
Session-local sanitized Pi settings file, links the selected resources, establishes broker
descriptors and sentinels, and runs exact readiness probes. Container files remain disposable;
the snapshot and Session record remain authoritative.

Existing Sessions keep their base release, setup snapshot, and Plugin content through Resume. A
later Sync affects only new Sessions. Referenced old image and bundle content remains available
until no Warm or Stopped Session needs it.

### One Pi process and mutable Session preferences

Every Session has one supervised Pi process in RPC mode. The TUI, terminal client, automation,
Hatch tools, and evidence tools use that process. Scotty removes the second direct interactive Pi
startup path. Session Create sends no initial prompt; the connected user sends the first prompt.

The Session starts with the provider, model, and thinking level from its pinned snapshot. The
provider remains pinned to the Session's Pi credential grant. A user may select another available
model for that provider and may change the thinking level. The Session record owns those current
choices, Resume restores them, and the change never rewrites Installation config or the deployed
snapshot.

### Diagnostics and failure behavior

Checks are staged and bounded:

1. local config decoding and Pi-setting allowlist validation;
2. Plugin source, manifest, collision, command, and credential-requirement validation;
3. deterministic bundle and image build checks, version inventory, and secret scan;
4. snapshot upload, activation, and re-read proof;
5. Session materialization, Fork checkout, broker, Pi RPC, tool, Hatch-capability, and capture-
   capability probes; and
6. one real first response only in the first-use proof after the user connects.

Scotty never skips a selected Skill, extension, tool, or failed probe. Before Session authority is
committed, a failure keeps Create in its retryable operation with no false Session success. After
commit, an unsafe or incomplete runtime becomes truthfully Stopped. Every failure returns its code,
stage, target item, last proven effect, retained state, bounded redacted logs, ambiguity, safe retry,
required human action, and operation ID.

### Local development and proof

Local development runs the same production container image, manifests, setup materializer, Pi RPC
supervisor, probes, and lifecycle contracts. Explicit fake brokers and local immutable stores
replace external providers. Fixtures never become a second config or state authority. Local tests
prove deterministic setup, failure, replay, Resume, dormant capability activation, and cleanup.

Guarded deployed canaries prove Cloudflare Sandbox behavior, broker isolation, real Artifacts Git,
Hatch routing, Chromium screenshots, video capture, backup and Resume, image settlement, and
provider cleanup. A provider cannot be offered for Session creation until it passes the same
contract.

This decision defines the product and setup contract. It does not implement it.

## Decision trail

- Require no local Pi installation.
- Put safe Pi behavior settings in Scotty's private config instead of silently importing them.
- Remove hardcoded provider, model, thinking, trust, and Codex configuration.
- Keep Hatch and browser capture built in but dormant, including for backend work.
- Ship the broad coding toolset as one removable built-in Plugin.
- Enable Pi-only subagents in the generated standard setup.
- Use one supervised Pi RPC process for every client path.
- Reject Plugin and resource collisions instead of applying hidden precedence.
- Run the production image and contracts in local development with explicit fake adapters.
- Stop safely and return staged evidence when any selected setup item fails.

## Refined host-local boundary

A container-local `.scotty` directory is disposable Session runtime material. It does not preserve
the retired host `~/.scotty` state root and cannot contain a real credential, grant, token, or
persisted sentinel. Host setup uses the canonical XDG config, state, and cache roots.
