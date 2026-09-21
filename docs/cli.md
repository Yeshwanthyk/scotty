# CLI

[README](../README.md) · [Install and setup](setup.md) · [Features](features.md)

Examples use the signed `scotty` executable. Run `scotty --help` or a command's `--help` for its
complete options. Use `--json` where supported for machine-readable output.

## Repositories and credentials

```sh
scotty repo add OWNER/REPO
scotty repo list
scotty repo remove OWNER/REPO
```

Registering a repository does not grant GitHub access. The credential must already cover it.
Refresh credentials from local sources:

```sh
scotty sync --github
scotty sync --codex-auth /private/path/to/codex/auth.json
# Or, for Pi:
scotty sync --pi-auth /private/path/to/pi/auth.json
```

`--github` reads the current GitHub CLI login. Alternatively, use
`--github-token-file /private/path/to/token`. Use one GitHub source at a time.

Pi and Codex auth sources are mutually exclusive: only one agent credential can be active. Source
files must be private, regular files, not symlinks. Sync refreshes credentials in the cloud vault;
it does not change application defaults or expand the credential's repository access.

## Sessions

Start a session with an explicit repository, title, and provider:

```sh
scotty beam "fix the failing tests" \
  --title "Fix tests" --repo OWNER/REPO --provider cloudflare
```

Use `--agent pi` or `--agent codex` to override the cloud default. Other options include `--model`,
`--effort`, `--cap 30m`, and `--detach` to avoid opening the browser. Cloudflare is the only enabled
session provider.

```sh
scotty list
scotty attach SESSION_ID
scotty inspect SESSION_ID --json
scotty read SESSION_ID --last 5 --json
scotty steer SESSION_ID "check the focused tests" --json
scotty interrupt SESSION_ID
scotty checkpoint SESSION_ID
scotty resume SESSION_ID
```

`attach` opens the authenticated session URL in an already paired browser. Resume sleeping sessions
before opening the worklog. `read` also supports `--since N` and `--follow`.

`inspect` reads a warm session without starting or waking its container. `steer` takes a fresh
snapshot and submits the prompt against that session's epoch and revision. Stale or ambiguous
outcomes are not retried automatically. Use `--follow-up` to queue a follow-up and an
`--idempotency-key` when the caller needs an explicit request identity.

To permanently destroy a session after confirming its ID:

```sh
scotty vaporize SESSION_ID --yes --json
```

## Agent-to-agent coordination

An agent inside a Scotty sandbox can inspect, read, steer, and interrupt another session through
`https://scotty.internal`. The source Sandbox object derives identity from the container context;
the agent does not load or forward the installation's root credential.

Current restrictions:

- The source must be a warm Cloudflare session with no active lifecycle operation.
- Source and target must have exactly the same repository identity.
- Internal session creation is also restricted to the source repository and Cloudflare provider.
- Coordination is request-scoped; there is no persisted mailbox.

These restrictions are enforced by the [session object](../worker/src/session/object.ts) and
covered by [container egress tests](../worker/test/egress/container-session-egress.test.ts).
The Sandbox interceptor's reserved-origin behavior also needs a deployed canary; local tests alone
are not production proof.

## Sandbox resources

Skills, Pi packages, tools, and extensions can be published for new sessions. This is separate from
installing a skill into your local coding agent.

The released whole-catalog command is:

```sh
scotty sandbox push \
  --skills-root ./skills \
  --package ./packages/my-pi-package \
  --tools-root ./tools \
  --extensions-root ./extensions
```

Repeat flags for multiple roots. **This replaces the complete published catalog.** Omitted
categories are removed, so include everything you intend to retain.

Skills are directories containing `SKILL.md`. Pi packages declare their resources in `package.json`.
Do not include credentials, `.env` files, private keys, or logs in published resources.

### Individual resource commands

These commands landed on `main` in [PR #263](https://github.com/Yeshwanthyk/scotty/pull/263).
They are not in v0.3.22; check `scotty resources --help` before using them with an installed release.

```sh
scotty resources list
scotty resources put skill ./skills/my-skill
scotty resources put extension ./extensions/my-extension.ts
scotty resources put package ./packages/my-pi-package
scotty resources remove skill my-skill
```

Unlike `sandbox push`, these update one catalog entry. A skill must be a directory; an extension or
tool can be a file or directory. Package identity comes from `package.json`; other names come from
the path basename. Changes apply to new sessions.

See [resource contracts](../protocol/resources/cloud-resources.ts),
[bundle preparation](../cli/src/sandbox-bundle-builder.ts), and
[server resource tests](../worker/test/sandbox/cloud-resources.test.ts).

## Custom images

Use an immutable OCI image reference with `init --image REPOSITORY@sha256:DIGEST`.
Deployment also accepts `--image managed` to select the managed image policy. Custom images must
satisfy Scotty's runtime compatibility requirements; an arbitrary Docker image is not a supported
substitute.

Start from the [provided image definition](../worker/container/Dockerfile) and check the
[image compatibility contract](../protocol/runtime/runtime-image-compatibility.ts). The
[roadmap](roadmap.md) separates implemented image selection from pending custom-image and
Docker-free deployment proof.

## Runner registration

Runner registration and service management are available. **Runner-backed sessions are disabled**
until the native transport and lifecycle gates are complete.

On a trusted Linux machine, prepare the pinned runtime image and authenticate `gh`, then run:

```sh
scotty runner setup \
  --name "$RUNNER_NAME" \
  --root /home/runner/.local/state/scotty-runner \
  --image sha256:<64-lowercase-hex> \
  --codex-auth /home/runner/.codex/auth.json \
  --source-binary /absolute/path/to/scotty
```

Replace all placeholders and use absolute paths. Setup registers the chosen name, receives a
one-time credential, imports the GitHub CLI login, writes runner-only credential files, and starts
a hardened systemd user service. It fails if the service is not active.

Use `--replace` only when replacing an existing runner: it rotates the credential and disconnects
the old machine. Runner credentials are not accepted as command arguments or stored in Worker
configuration.

```sh
scotty runner list
# Only after all assigned sessions are gone:
scotty runner remove NAME --yes
```

## Installation and guides

See [setup](setup.md) for `init`, `doctor`, owner recovery, upgrades, deployment, recovery, and
uninstall. Read the bundled guides with:

```sh
scotty skill list
scotty skill show
scotty skill show scotty-live-observability
```

## Sources and tests

- [Command definitions](../cli/src/commands.ts)
- [Command tests](../cli/effect-test/command-tree.test.ts) and [CLI tests](../cli/test/cli.test.ts)
- [Credential sync tests](../cli/effect-test/scotty-sync.test.ts)
- [Sandbox sync tests](../cli/effect-test/sandbox-sync.test.ts)
- [Runner command tests](../cli/test/runner-command.test.ts)
