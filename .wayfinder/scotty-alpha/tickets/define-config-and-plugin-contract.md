---
title: Define the config and Plugin contract
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the first-use and readiness contract
---

## Question

What is the one canonical private config and deployed snapshot shape, and what minimum common fields and type-specific fields must every administrator-controlled Plugin declare?

## Resolution

Scotty has one strict, declarative private configuration at
`~/.config/scotty/config.json`. It replaces `~/.scotty.json` and
`~/.scotty/sandbox.json`. Its alpha schema contains only:

- `schemaVersion: 1`;
- the user-chosen Installation name and explicit Cloudflare account ID;
- administrator-controlled Plugin declarations;
- one ordered Sandbox setup; and
- one strict `pi` object containing allowed non-secret Pi behavior settings.

It does not contain credentials, tokens, Cloudflare resource identifiers, deployment observations,
repositories, named Runners, Sessions, paired clients, login state, environment values, or startup
shell commands. Cloudflare authentication, root authority, paired-client credentials, and other
live credentials remain in their dedicated stores and flows. There are no product configuration
profiles.

The canonical shape is:

```json
{
  "schemaVersion": 1,
  "installation": {
    "name": "home",
    "cloudflareAccountId": "account-id"
  },
  "pi": {
    "defaultProvider": "provider-id",
    "defaultModel": "model-id",
    "defaultThinkingLevel": "medium"
  },
  "plugins": [
    {
      "id": "cloudflare",
      "type": "compute-provider",
      "enabled": true,
      "source": { "kind": "builtin", "name": "cloudflare" }
    },
    {
      "id": "my-extension",
      "type": "pi-extension",
      "enabled": true,
      "source": { "kind": "path", "path": "/absolute/local/path" }
    }
  ],
  "sandboxSetup": {
    "piExtensions": ["my-extension"],
    "skills": [],
    "sandboxTools": []
  }
}
```

This wiring means Sync copies the enabled local extension directory into an immutable bundle; the
Sandbox setup then selects that extension by Plugin ID.

Each Plugin declaration has exactly four common fields:

- `id`: a stable, installation-local identifier;
- `type`: exactly one of `compute-provider`, `pi-extension`, `skill`, or `sandbox-tool`;
- `enabled`: whether Sync should resolve and apply it; and
- `source`: either a product `builtin` name or an absolute local `path`.

Cloudflare compute, runner compute, and the standard toolset are typed built-in Plugins. The
Cloudflare compute Plugin must be explicitly declared and enabled for alpha. Named Runner
registrations are live control-plane state, not Plugin declarations. Registration or connectivity
does not make runner compute ready.

Type-specific metadata belongs to validated Plugin content rather than being duplicated in the
private config:

- compute-provider capability and runtime metadata is product-owned and built in;
- a Pi extension exposes valid Pi package metadata and entrypoints;
- a Skill exposes a valid `SKILL.md`; and
- a Sandbox tool declares its bundled executable commands and readiness probes.

Alpha accepts built-ins and local paths only. It does not clone remote sources, query package
registries, or run arbitrary package-manager or shell installation scripts. Sync reads an enabled
local directory, validates it according to its Plugin type, creates an immutable bundle, uploads
that bundle, and records its digest. The local path is never deployed. A disabled declaration may
remain even when its local path is unavailable, but it cannot be referenced by the Sandbox setup
and is not resolved into the active snapshot.

The Sandbox setup contains ordered Plugin-ID lists for Pi extensions, Skills, and Sandbox tools.
Every entry must resolve to a distinct enabled Plugin of the matching type. Compute providers are
installation Plugins and do not appear in those lists. Alpha startup customization is the ordered
loading of those Plugins; it has no arbitrary startup commands or environment block.

Sync strictly decodes the whole config and rejects unknown fields, schema versions, Plugin types,
duplicate IDs, unresolved references, and type mismatches. It then validates every enabled Plugin,
resolves built-ins, bundles local content, presents one complete source-and-change plan for
approval, prepares every immutable input, and atomically activates one deployed snapshot with a
revision check. Failure before activation leaves the previous snapshot active.

The active deployed snapshot binds to the Installation name and has this normalized shape:

```json
{
  "schemaVersion": 1,
  "installationName": "home",
  "revision": 5,
  "configDigest": "sha256:...",
  "pi": {
    "defaultProvider": "provider-id",
    "defaultModel": "model-id",
    "defaultThinkingLevel": "medium"
  },
  "plugins": [
    {
      "id": "cloudflare",
      "type": "compute-provider",
      "source": {
        "kind": "builtin",
        "name": "cloudflare",
        "releaseDigest": "sha256:..."
      },
      "manifest": {}
    },
    {
      "id": "my-extension",
      "type": "pi-extension",
      "source": { "kind": "bundle", "digest": "sha256:..." },
      "manifest": {}
    }
  ],
  "sandboxSetup": {
    "piExtensions": ["my-extension"],
    "skills": [],
    "sandboxTools": []
  }
}
```

`manifest` is the validated type-specific metadata supplied by the built-in or bundled content.
The snapshot contains only:

- its alpha schema version and revision;
- the digest of normalized desired configuration;
- resolved manifests and immutable built-in-release or content-bundle digests for enabled Plugins;
  and
- the resolved ordered Sandbox setup.

It contains no local paths, credentials, readiness observations, repositories, Runner
registrations, clients, Sessions, or Cloudflare resource identifiers. There is one active snapshot,
not an authoritative configuration-history system. Rollback restores an earlier local config and
Syncs it as a new revision.

New Sessions use the active snapshot. Existing Sessions retain the snapshot and immutable content
they started with through Resume. Plugin changes, disabling, and removal therefore affect new
Sessions only; referenced old content remains available until no Session needs it. The
authoritative-state ticket will assign ownership of the active snapshot and activation record.

## Refined thin-Sandbox contract

The `pi` object is part of desired configuration and the active deployed snapshot. It contains
only the behavior-setting allowlist defined by the thin Sandbox decision. It never contains Pi
auth, packages, executable resource paths, project trust, shell commands, proxy or network state,
Session paths, telemetry state, or Scotty transport controls. `scotty init` can generate safe
defaults and ask for provider, model, and thinking choices without requiring local Pi.

The generated standard config selects the built-in `standard` Sandbox tool Plugin and the Pi-only
subagents extension and Skill. Product-owned Hatch and browser evidence capabilities remain
image-resident and dormant rather than appearing as administrator Plugins.

## Refined credential manifest contract

A validated Plugin manifest may declare a non-secret credential requirement ID, typed delivery
adapter, and target scope. The private config and deployed snapshot never contain a value or usable
secret reference. The administrator binds requirements to named Credential-object records, and
Session Create pins the current generation for each selected requirement.

## Refined local-root contract

`config.json` is the only desired-input file under the XDG config root. Operational journals,
diagnostics, credentials, and caches do not enter the configuration schema. Host `~/.scotty`,
`~/.scotty.json`, and `~/.scotty/sandbox.json` are fully retired rather than retained as fallback
readers.
