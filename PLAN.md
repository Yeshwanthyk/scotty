# Scotty v1 plan

This file defines Scotty's public behavior and security constraints. `EFFECT_V4_MIGRATION.md`
governs the implementation framework and infrastructure model.

## Outcome

A user installs the standalone `scotty` CLI, chooses a Cloudflare profile and required installation
name, and gets an isolated deployment with no repository-owned account identifiers. The same CLI
creates durable Pi sessions, opens their authenticated browser worklog, checkpoints them, restores
them, downloads their work, and destroys them.

A machine-local config is a convenience pointer, not deployment authority. A replacement machine
can reconnect with:

```sh
scotty init --name NAME --existing
```

Cloudflare authentication proves account access. Recovery rotates the root token and writes a fresh
mode-0600 `~/.scotty.json`.

## Public CLI contract

The primary flow is:

```sh
scotty init --name NAME
scotty doctor
scotty beam up "PROMPT" --title "TITLE" --repo OWNER/REPO --provider cloudflare
scotty ls
scotty attach SESSION
scotty snapshot SESSION
scotty resume SESSION
scotty beam down SESSION
scotty vaporize SESSION
```

The installation name is always explicit. CLI JSON shapes and exit codes are stable contracts.
Human output may improve without changing JSON behavior.

Runner administration is also CLI-owned:

```sh
scotty runner setup --name NAME ...
scotty runner list
scotty runner remove NAME --yes
```

Runner names are created and managed by the control plane. No runner instance name is committed or
stored as Worker configuration. Runner-backed session creation is disabled until the runner link
has a native Pi RPC transport.

## Installation ownership

Alchemy owns ordinary Cloudflare resources: Worker, assets, bindings, KV, R2, Durable Object
migrations, Container application, stages, state, and deployment. Resource names are derived from
the installation name.

The repository must not contain a Cloudflare account ID, workers.dev hostname, Container name,
Container UUID, root token, runner credential, or a user-specific installation name. Adoption of an
older deployment uses a private ignored manifest.

Production deployment uses the guarded release command:

```sh
SCOTTY_INSTALLATION_NAME=NAME npm run deploy:production
```

It refuses CI and unsafe Git state, runs verification, deploys through Alchemy, and audits rollout
settlement.

## Session behavior

Each session has one authoritative Sandbox Durable Object. It owns:

- session identity and immutable provider binding;
- lifecycle state and one operation lease;
- credential authority;
- workspace and checkpoint metadata;
- hard-cap scheduling and destructive cleanup.

KV contains only a non-secret list projection. R2 contains immutable backup generations. Provider
runtime memory is never authoritative.

Cloudflare sessions prepare `/workspace/<id>`, seed Pi settings and session-bound credentials, start
one loopback-only `pi --mode rpc` supervisor, and publish `warm` only after its health check and
initial prompt acceptance succeed. The authenticated browser page projects Pi messages, thinking,
tools, extension UI, and queue state through Worker-authenticated HTTP and SSE routes. Snapshot
quiesces and stops Pi, syncs the filesystem, writes a new immutable backup, rotates current/previous
handles, then resumes the same Pi session. Resume restores the current backup, reseeds
container-only configuration, and starts `pi --continue`. Vaporize removes runtime, credentials,
backups, projection, and authority.

## Credential isolation

Real Pi provider and GitHub credentials remain in Worker secrets or per-session Durable Object
storage. They must never enter container files as real values, process arguments, logs, KV, R2,
Alchemy outputs/state, or API responses.

The container receives session-bound sentinels. Default-deny egress replaces a valid sentinel only
for an allowlisted upstream and sanitizes responses before returning them. Repository code is
untrusted.

Browser credentials are separate from the root CLI credential. The root credential is accepted only
as a bearer credential and break-glass recovery authority, never from cookies or URLs. Pairing,
ownership transfer, recovery, and revocation remain Auth Durable Object operations.

## Container contents

The image includes pinned Pi, the lightweight Pi RPC supervisor, the standalone Scotty CLI, standard tools, bundled
skills, and the eight configured Pi extensions. Source-based extensions are ordinary vendored
container source with upstream repository and commit metadata in
`worker/container/pi-packages/manifest.json`; consumers do not initialize those repositories.

## Release acceptance

A releasable revision passes formatting, skill lint, lint, typecheck, all local tests, secret scan,
standalone CLI build, container build, guarded production deployment, and the stage-isolated
deployed canary. Host reachability alone is not readiness; the acceptance probe must exercise the
actual session and worklog contract.
