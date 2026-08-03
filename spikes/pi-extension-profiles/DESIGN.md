---
shaping: true
---

# User-installable Pi extension profiles

**Status:** proposed architecture for review; no production implementation

## Source

> how deeply tied is current tui desktop to the pi sandbox. how can we make it such that we can let people add in whatever extension they want for pi rather than use baking it in

> we can includ a few esential ones like pi-subagents, pi-workflows etc

## Decision summary

Scotty should bake a small, audited Pi core into the Container image and let users attach exact, trusted Pi packages through an extension profile.

The native TUI and desktop are not deeply coupled to the current package list. They are remote projections of the sandbox Pi process. Most coupling is in Container packaging and startup:

- every package is copied and installed by `worker/container/Dockerfile`;
- `worker/src/container-auth.ts` contains a fixed `PI_PACKAGES` array;
- each session receives a generated Pi `settings.json` containing those fixed paths;
- credential refresh rewrites that settings file;
- the baked package directories are read-only.

The target should preserve this boundary:

```text
TUI / desktop / browser
        |
        | authenticated Scotty console protocol
        v
Worker + authoritative Session DO
        |
        | revision-fenced constrained Pi projection
        v
Pi --mode rpc inside the sandbox
        |
        +-- audited core packages from the image
        +-- exact user-selected packages from the session profile
```

“Any extension” means any extension the user explicitly trusts. Pi extensions execute arbitrary code with Pi's full process permissions.

## Requirements

| ID  | Requirement                                                                                                                | Status    |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------- |
| R0  | Users can choose trusted Pi extensions without requiring a new Scotty Container image.                                     | Core goal |
| R1  | Scotty retains a small, audited, offline-capable default package set.                                                      | Must-have |
| R2  | The Sandbox Durable Object remains authoritative for a session's exact extension profile and lifecycle revision.           | Must-have |
| R3  | Existing browser, CLI/TUI, desktop, lifecycle, authentication, and credential-isolation contracts remain compatible.       | Must-have |
| R4  | Package installation is reproducible from exact npm versions/integrities or Git commit SHAs; no silent floating updates.   | Must-have |
| R5  | Untrusted package code never gains a new route around Worker/DO authorization, egress policy, or sentinel isolation.       | Must-have |
| R6  | Remote-compatible extension tools, commands, skills, prompts, and basic dialogs can be used from the TUI and desktop.      | Must-have |
| R7  | Pi-native custom TUI components are explicitly classified as degraded/unsupported remotely rather than pretending to work. | Must-have |
| R8  | Existing sessions can resume with the same profile or fail explicitly when it cannot be reproduced.                        | Must-have |

## Current coupling map

### `pi-scotty` terminal UI

**Coupling: medium to Pi's protocol, low to the sandbox implementation.**

`pi-scotty/src/main.ts` creates a local TUI and connects using `HttpConsoleTransport`. It does not start Pi or access the Container directly. `pi-scotty/src/remote-ui-adapters.ts` adapts remote Pi message/tool shapes into generic local rendering.

What already works generically:

- assistant/user/tool transcript projection;
- unknown tool names and arguments with fallback rendering;
- active tool progress;
- `select`, `confirm`, `input`, and `editor` extension dialogs;
- notifications, text statuses, text widgets, and title updates.

What is currently hardcoded:

- `pi-scotty/src/controller.ts` accepts only `/subagents` and `/workflows` as remote extension commands;
- `protocol/pi-console.ts` models only those two command names and allows at most two projected commands;
- the help and command hints name those packages directly.

The TUI also imports Pi `0.83.0` message/TUI components. It is therefore tied to the projected Pi message contract, but not to the list of packages installed in the sandbox.

### Scotty desktop

**Coupling: low to Pi, medium to Scotty's desktop projection.**

The Rust application talks to the Bun sidecar over versioned NDJSON. The sidecar reuses `FleetConsoleController` and `HttpConsoleTransport`. Rust does not hold the paired client credential and does not speak directly to Pi.

Current limitations for arbitrary extensions:

- generic tool transcript rendering works, with special presentation for common tools and a fallback for unknown tools;
- basic blocking extension dialogs can be answered;
- the desktop projection currently omits the TUI's extension statuses/widgets/title surface;
- Pi-native renderers and components cannot cross the sidecar protocol.

### Sandbox Pi process

**Coupling: high to the baked package set.**

`worker/container/scotty-pi-session.mjs` launches:

```text
pi --mode rpc
```

It projects a bounded, sanitized subset of Pi RPC as snapshot + SSE + commands. It already observes package-provided tools and basic RPC extension UI.

The fixed package set is duplicated across:

- `worker/container/pi-packages/manifest.json`;
- `worker/container/pi-packages/settings.json`;
- `worker/src/container-auth.ts`;
- Container image installation and verification in `worker/container/Dockerfile`.

`PI_CODING_AGENT_DIR` is per session under `<session-root>/.pi-agent`, so Pi already has a natural writable location for session-specific npm/git packages. Scotty does not currently expose or preserve a user-selected package manifest there.

## Pi's native package model

Pi already supports package sources such as:

```text
npm:@scope/package@1.2.3
git:github.com/owner/repository@<commit>
/absolute/local/path
```

Packages can contribute extensions, skills, prompts, and themes. Settings support per-resource filters. Pi installs user packages below its agent directory and project packages below `.pi/`.

Important Pi constraints:

- extensions execute arbitrary code with full system permissions;
- project packages load only after project trust;
- packages may run dependency installation;
- `/reload` can reload extensions/resources, but Scotty does not currently expose a general remote reload lifecycle;
- in RPC mode, basic extension dialogs and text surfaces work, while custom components, editors, headers, footers, themes, and tool renderers are degraded or unavailable.

## Recommended package tiers

### Audited core: baked and always available

Recommended initial core:

1. `pi-subagents`
2. `pi-workflows`
3. `pi-askuser`
4. `pi-tasks`

These provide the baseline coordination and remote interaction model Scotty is designed around.

### Starter profile: default-on but removable

- `pi-background-terminals`

It is useful for development but is not required for every session and owns long-lived processes.

### Optional profile packages

- `pi-web-access`;
- Codex compaction;
- additional user-selected npm/GitHub Pi packages.

`pi-amp-ui` should not be a sandbox core dependency. Most of its value is direct terminal UI replacement, while Scotty runs Pi in RPC mode and renders its own TUI/desktop UI. Scotty may continue packaging the shared theme asset independently for client presentation.

## Target architecture

### 1. Extension profile catalogue

Introduce a user-owned extension profile outside Container memory. A profile is configuration, not executable state.

Illustrative shape:

```json
{
  "version": 1,
  "id": "profile_default",
  "name": "My coding setup",
  "packages": [
    {
      "source": "npm:@example/pi-review@1.4.2",
      "integrity": "sha512-...",
      "resources": {
        "extensions": ["extensions/review.ts"],
        "skills": ["skills/review"]
      }
    },
    {
      "source": "git:github.com/example/pi-tools@<40-character-commit>",
      "sourceSha256": "..."
    }
  ]
}
```

A per-user catalogue may live with user/auth-owned configuration, but session creation must copy the exact resolved profile snapshot and digest into the authoritative Session DO record. A later profile edit must not silently mutate an existing session.

Do not store package source code, provider credentials, capability values, or installation logs in the Session DO.

### 2. Session creation

Add an optional profile selection to session creation while preserving all existing fields and defaults.

Flow:

```text
client chooses profile
  -> Worker authenticates profile access
  -> Session DO records resolved package snapshot + digest
  -> Container workspace is prepared
  -> audited core remains available at /opt/scotty/pi-packages
  -> selected packages install into <session-root>/.pi-agent/{npm,git}
  -> generated settings merge core paths + resolved selected packages
  -> Pi starts only after installation and verification succeeds
  -> session becomes warm
```

Installation failure must leave a typed create failure or a recoverable explicit state. It must never silently start with a partial profile.

### 3. Resume and backup

The Session DO's package snapshot is authoritative. The session backup may contain the writable package directories as a cache, but successful restore must verify them against the recorded profile digest.

On resume:

1. restore the session directory;
2. regenerate settings from the authoritative snapshot;
3. verify cached package versions/digests;
4. fetch only missing packages under the same policy;
5. launch Pi;
6. fail explicitly if exact reconstruction is impossible.

Do not infer the profile from whatever files happen to exist after restore.

### 4. Changing a warm session's profile

Do not start with hot installation. The safe first release fixes the package set at session creation.

A later managed update should be a Session DO lifecycle operation:

1. acquire the lifecycle operation lease;
2. quiesce and stop Pi;
3. resolve/install the new exact package set;
4. update the authoritative profile snapshot and increment session revision;
5. regenerate settings;
6. restart Pi with a new epoch;
7. release the operation.

Old client streams and commands become stale through the existing revision/epoch fences.

## Remote extension compatibility

### Tier 1: supported remotely

- custom tools with textual/JSON results;
- lifecycle and tool hooks;
- skills and prompt templates;
- extension slash commands;
- `select`, `confirm`, `input`, and `editor` dialogs;
- notifications;
- text statuses/widgets/title;
- generic tool progress and transcript rendering.

### Tier 2: runs with degraded presentation

- custom tool/message renderers;
- themes intended for Pi's local TUI;
- custom terminal-specific formatting.

Scotty renders these generically and does not execute remote presentation code in the client.

### Tier 3: unsupported remotely

- `ctx.ui.custom()` components and overlays;
- custom editors;
- custom headers and footers;
- direct terminal input ownership;
- anything requiring `ctx.mode === "tui"`.

Packages should check Pi's documented `ctx.mode`/`ctx.hasUI` behavior. Scotty should eventually expose compatibility metadata and warn before enabling a package whose useful surface is TUI-only.

## Console protocol changes

### Generalize command discovery

Replace the `subagents | workflows` literal list with a bounded command descriptor:

```text
name
optional description
source: extension | skill | prompt
canonical source provenance
```

Keep strict limits on count and string size. Do not expose paths that reveal sensitive Container topology.

### Generalize command invocation

Allow a bounded intent such as:

```json
{
  "type": "slash_command",
  "name": "review",
  "arguments": "src/auth.ts"
}
```

Before forwarding it, the sandbox supervisor must verify that the command appears in the current Pi `get_commands` result and belongs to the current epoch. The client cannot turn this into arbitrary shell or raw Pi RPC.

### Improve client presentation

- TUI: derive command completion/help from projected capabilities instead of hardcoded names.
- Desktop sidecar: include bounded command capabilities and extension statuses/widgets/title in its versioned state.
- Desktop UI: render only the basic remote-safe surface.
- Both: retain generic rendering for unknown tools.

## Security model

### Trust statement

Installing a Pi extension is equivalent to running user-approved code in the sandbox. It can read/write the repository, run processes, inspect process-visible sentinels, register or override tools, intercept tool calls, and alter prompts or provider requests.

Scotty cannot safely treat two extensions in the same Pi process as mutually isolated.

### Initial controls

- package/profile management is owner-only or requires a dedicated high-risk scope;
- every installation requires explicit acknowledgement of arbitrary-code execution;
- npm packages use exact versions and recorded integrity;
- Git packages use exact commit SHAs and recorded source digest;
- no `latest`, branches, moving tags, or automatic `pi update --extensions`;
- disable npm lifecycle scripts initially through a Scotty-owned npm wrapper;
- retain current default-deny egress and approved registry/GitHub hosts;
- do not place extension API keys in environment variables, settings, backups, logs, process arguments, KV, R2 metadata, or stack state;
- log identifiers, digests, durations, and typed outcomes—not package output or secrets;
- cap package count, downloaded bytes, install duration, file count, and startup time;
- scan package extraction paths and reject traversal/symlink escapes outside the package root.

Disabling install scripts does not make extension runtime code safe. It only removes one earlier execution point.

### Egress and extension secrets

Current egress permits a bounded host set such as GitHub, npm, OpenAI, Python, Go, and Rust registries. A package that calls Slack, Jira, Linear, or another service will remain blocked.

Do not solve this by allowing arbitrary network access. A later design should add explicit extension capabilities:

```text
package identity + exact host + method scope + secret reference + session/client scope
```

The Worker/DO egress boundary resolves a secret reference only for the approved upstream. The real secret never enters the Container. This is separate from the first extension-profile release.

## Existing partial path

A trusted repository can already contain project-local `.pi/settings.json` package declarations. Pi documents automatic installation of missing project packages after project trust, and Scotty starts Pi in that repository directory.

This is useful for a controlled experiment, but it is not yet a supported Scotty product path because:

- the Session DO does not record the package set;
- package installation/reconstruction is not a lifecycle contract;
- arbitrary extension commands are blocked by the console schema;
- custom remote UI support is incomplete;
- egress and install-script behavior are not package-profile aware;
- credential refresh rewrites global Pi settings;
- no Scotty contract test proves resume, rollback, or credential isolation.

## Implementation slices

### Slice 1: decouple the audited core list

- define one canonical core package manifest;
- generate Container verification and default settings from it;
- remove duplicated hand-maintained arrays;
- keep behavior unchanged.

### Slice 2: remote-compatible generic commands

- project bounded command descriptors;
- validate generic slash-command invocation against current Pi capabilities;
- update TUI completion/help;
- preserve revision/epoch/command-ID fencing.

This slice can be tested with a local package already present in the image.

### Slice 3: profile authority and create-time selection

- add profile catalogue and authorization;
- add optional session-create profile identity;
- snapshot exact resolved package data into Session DO state;
- expose profile digest/status without exposing filesystem paths.

### Slice 4: per-session installer

- use Pi's package semantics through a Scotty-controlled installer/npm wrapper;
- install exact npm/GitHub sources into the session Pi directory;
- enforce limits and no-secret logging;
- generate settings from core + profile;
- add create failure/rollback contract tests.

### Slice 5: resume proof

- restore package cache;
- verify against Session DO snapshot;
- reproduce missing packages;
- prove profile stability across snapshot/resume and image rollout.

### Slice 6: desktop extension surface

- version the sidecar protocol;
- project commands, statuses, widgets, title, and notifications;
- render the supported basic UI;
- keep custom Pi components explicitly unsupported.

### Later: managed profile updates and scoped third-party integrations

Only after create/resume behavior is proven should Scotty support changing packages on a warm session or granting extension-specific egress/secrets.

## Fit check

| Req | Requirement                                                                                                                | Status    | Core + authoritative per-session extension profile |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------- | :------------------------------------------------: |
| R0  | Users can choose trusted Pi extensions without requiring a new Scotty Container image.                                     | Core goal |                         ✅                         |
| R1  | Scotty retains a small, audited, offline-capable default package set.                                                      | Must-have |                         ✅                         |
| R2  | The Sandbox Durable Object remains authoritative for a session's exact extension profile and lifecycle revision.           | Must-have |                         ✅                         |
| R3  | Existing browser, CLI/TUI, desktop, lifecycle, authentication, and credential-isolation contracts remain compatible.       | Must-have |                         ✅                         |
| R4  | Package installation is reproducible from exact npm versions/integrities or Git commit SHAs; no silent floating updates.   | Must-have |                         ✅                         |
| R5  | Untrusted package code never gains a new route around Worker/DO authorization, egress policy, or sentinel isolation.       | Must-have |                         ✅                         |
| R6  | Remote-compatible extension tools, commands, skills, prompts, and basic dialogs can be used from the TUI and desktop.      | Must-have |                         ✅                         |
| R7  | Pi-native custom TUI components are explicitly classified as degraded/unsupported remotely rather than pretending to work. | Must-have |                         ✅                         |
| R8  | Existing sessions can resume with the same profile or fail explicitly when it cannot be reproduced.                        | Must-have |                         ✅                         |

## Open decisions for the next session

1. Should the immutable core be exactly `pi-subagents`, `pi-workflows`, `pi-askuser`, and `pi-tasks`?
2. Should `pi-background-terminals` be default-on or opt-in?
3. Are profiles owner-only initially, or may standard clients select—but not edit—owner-approved profiles?
4. Should v1 accept public npm plus public GitHub only?
5. Is disabling all npm lifecycle scripts acceptable for v1?
6. Should repository `.pi/settings.json` packages be ignored, merged, or require explicit profile approval?
7. Which compatibility metadata should package authors provide, and what can Scotty verify automatically?

## Recommended next action

Start with **Slice 1 and Slice 2**. They remove package-name coupling from the console and establish a generic remote extension contract without yet downloading arbitrary code. Then prototype one exact public npm package at session creation under a disposable profile before designing galleries, hot reload, or third-party secrets.
