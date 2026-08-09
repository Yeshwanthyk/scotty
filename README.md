# Scotty

Scotty runs Pi in a persistent Cloudflare Sandbox workspace, presents its live worklog at an
authenticated `/s/<id>` URL, checkpoints the workspace to R2, and can resume, beam down, or
permanently destroy the session.

![Scotty](assets/brand/scotty-hero-16x9.png)

## Architecture

```text
 Browser                                                CLI
 owner/client cookie                              root bearer token
    |                                                       |
    +-------------------------+-----------------------------+
                              v
                 +---------------------------+
                 | Cloudflare Worker         |
                 | Hono API + static assets  |
                 | browser/CLI auth boundary |
                 +-----+-----------+---------+
                       |           |
             +---------+           +----------------------+
             v                                            v
 +------------------------+                    +-----------------------+
 | Auth Durable Object    |                    | Runner control plane  |
 | one owner + epoch      |                    | registry + runner DOs |
 | paired browser clients |                    +-----------+-----------+
 +------------------------+                                |
                                                           v
                                                 trusted Linux runner
                                                 (registration/control)

                 one Durable Object per Cloudflare session
                              |
                              v
                 +---------------------------+
                 | Sandbox Durable Object    |
                 | AUTHORITATIVE             |
                 | session state             |
                 | credentials + lifecycle   |
                 +-----+----------+----------+
                       |          |
              projects |          | immutable checkpoints
                       v          v
                +-----------+  +-----------+
                | KV        |  | R2        |
                | non-secret|  | backups   |
                | projection|  +-----------+
                +-----------+
                       |
                       v
          +------------------------------------+
          | Cloudflare Sandbox + Container    |
          | persistent workspace              |
          | scotty-pi-shell + Pi RPC worklog  |
          | session-bound sentinels only      |
          +------------------+-----------------+
                             |
                             v
          +------------------------------------+
          | ContainerProxy allowlisted egress |
          | sentinel -> credential substitution |
          +------------------+-----------------+
                             |
                         GitHub + Pi providers
```

The Sandbox Durable Object is the source of truth. KV is only a non-secret list, repository, and
stats projection; R2 stores immutable backups. The Container application runs the workspace and Pi
process but does not own session state or real credentials. The trusted-runner lane currently
supports registration and lifecycle control; runner-backed session creation remains disabled until
it has the native Pi RPC worklog transport.

## Components

- `worker/` — Hono API, Sandbox Durable Object, credential-isolating egress proxy, direct Pi RPC
  lifecycle and worklog, and trusted-runner control plane.
- `cli/` — Effect-native Bun CLI and embedded `scotty skills` guide.
- `pi-scotty/` — passive terminal fleet console and shared desktop sidecar.
- `desktop/` — macOS GPUI viewport for switching among existing warm Scotty sessions.
- `assets/brand/` — app icons, favicons, hero/social art, and agent glyphs.
- `e2e/` — credential-free fake-service E2E suite plus an explicitly gated deployed canary.
- `spikes/` — executable probes for the upstream Sandbox contracts.
- [`PORTABLE_EXECUTION_PLAN.md`](PORTABLE_EXECUTION_PLAN.md) — active Cloudflare, runner,
  Example runner, Box, connection-control, and multi-provider delivery plan.

## Security model

Repository code is untrusted. Real Pi provider and GitHub credentials stay in Worker secrets or per-session Durable Object storage. The container receives session-bound sentinels only. `ContainerProxy` replaces sentinels on allowlisted egress, sanitizes OAuth refresh responses before they return to the container, and denies all other outbound traffic.

Browser authority is separate from the root credential. `SCOTTY_TOKEN` is accepted only as a CLI
bearer and break-glass recovery credential; it is never accepted from a cookie, browser URL, or
`?t=`. The singleton Auth Durable Object stores exactly one owner client ID plus an ownership
epoch. Other browsers are standard clients. Pairing creates standard access, ownership transfer is
bound to one existing target browser, and root recovery revokes every browser credential before
creating a fresh owner. Raw client, pairing, transfer, and recovery secrets are never persisted.
For each paired device, the Auth Durable Object retains a server client ID, credential digest,
neutral or user-supplied label, scopes, created, expiry, and last-seen times, optional user agent,
and revocation time. The default `pi-scotty` label contains no hostname.

The browser never receives container credentials. For Cloudflare sessions, the Worker authenticates
the terminal WebSocket and attaches it to the Sandbox native PTY running Pi. Pi and Codex receive
only session-bound provider and GitHub sentinels.

Residual limitation: any allowed package registry is still a potential source/prompt exfiltration channel. Keep `ALLOWED_HOSTS` in `worker/src/egress.ts` minimal for the target repository.

## Agent setup and test loops

Read [`AGENTS.md`](AGENTS.md) before changing Scotty. It defines the public-contract, state,
credential, Effect v4, Alchemy, formatting, and verification invariants. When changing a
non-trivial Effect or Alchemy pattern, follow its source-first instructions before editing.

Requirements are the Node version pinned in [`.nvmrc`](.nvmrc), npm, Bun, and Git. Docker is
required only for the real local Sandbox loop, the Wrangler rollback probe, and production
deployment. Cloudflare authentication is required only for disposable deployed probes or
production deployment.

For a normal local checkout:

```sh
git submodule update --init vendor/effect vendor/alchemy
npm ci --no-audit --no-fund
npm run check
```

On macOS, build the ad-hoc-signed development desktop bundle with:

```sh
npm run build:desktop
open dist/Scotty.app
```

Desktop uses the same mode-0600 paired-client config as `pi-scotty` at
`~/.config/pi-scotty/config.json`. See [`desktop/README.md`](desktop/README.md) for fixture testing,
pairing, platform requirements, and distribution limitations.

For a fresh Linux agent environment, [`.agents/setup`](.agents/setup) installs the pinned Node
version, initializes the reference-source submodules, and runs `npm ci`. A resumed agent can use
[`.agents/resume`](.agents/resume) to fail fast when its cached environment is incomplete:

```sh
./.agents/setup
./.agents/resume
```

### Fast feedback loop

Start with the smallest test that owns the contract. Keep it running while editing, format the
touched files, then run the full gate once before handoff.

1. Run the focused test once before editing to establish the baseline.
2. Start its watch mode and make the smallest contract-preserving change.
3. Format only the touched files while iterating.
4. Rerun the focused test plus its nearest package suite.
5. Run `npm run check` before handing off, committing, or opening a PR.

```sh
# Worker or Durable Object: one pass, then watch mode
npx vitest run worker/test/sandbox-runtime.test.ts
npx vitest worker/test/sandbox-runtime.test.ts

# Effect CLI, Bun CLI, Node E2E, or operations
npx vitest run cli/effect-test/command-tree.test.ts
bun test cli/test/cli.test.ts
node --test e2e/tests/local-live-script.test.mjs
node --test scripts/sessions-shell.test.mjs

# Format touched files and finish with the complete repository gate
npx oxfmt --disable-nested-config --write README.md worker/src/sandbox-runtime.ts
npm run check
```

Replace these paths with the files under change. `npm run check` verifies pinned Effect and Pi
packages, formatting, lint, every typecheck and test suite, and the repository secret scan. The
default suites do not use Cloudflare, Pi provider, or GitHub credentials.

When a change crosses the real Worker/Sandbox/Pi boundary, also run the local-live loop. It uses
temporary Wrangler state and Docker containers and does not touch deployed Scotty resources:

```sh
DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" \
  npm run test:e2e:local-live -- --no-open --no-hold
```

This requires a healthy Docker daemon, authenticated `gh`, and mode-0600
`~/.pi/agent/auth.json`. It proves both fresh-start auth hydration and warm-session reseeding. Add
`--require-response` only when the local network permits model traffic from the container.

A Wrangler dry run remains as a local rollback probe. It builds the Sandbox image and therefore
requires a healthy Docker daemon:

```sh
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
```

For interactive local Worker development only, use:

```sh
npx wrangler dev --config worker/wrangler.jsonc
```

Wrangler is not a production infrastructure or deployment path.

## Cloudflare deployment

The standalone CLI owns installation. Run `scotty init --name NAME`; it asks Alchemy to authenticate
the selected Cloudflare profile, shows the target account and resources, deploys only after
confirmation, generates and uploads the root Worker secret without putting it in Alchemy state, and
stores the local pointer in mode-0600 `~/.scotty.json`. The installation name is required and is
never inferred from a username, machine, repository, or Cloudflare account.

For a clean first run:

1. Run `scotty init --name NAME` and confirm the displayed Cloudflare account and resource names.
2. Sign in to OpenAI or OpenAI Codex with Pi, then run `scotty auth sync`.
3. Run `scotty doctor --json`.
4. Run `scotty owner recover` on the browser that will own the installation.
5. Open `/devices` in that owner browser and create a one-use pairing link.
6. On each terminal or desktop device, run `pi-scotty pair ORIGIN` and paste the link when asked.
7. Run `pi-scotty`, or build and open the desktop app.

`auth sync` uses the account, Worker name, and origin saved by `init`. It fails before reading local
Pi credentials if Cloudflare does not match that saved installation. The pairing prompt does not
echo its one-use credential. See [`desktop/README.md`](desktop/README.md) for the desktop build.

On a replacement machine, run `scotty recover --name NAME`. Cloudflare profile ownership is the
recovery authority. The CLI first discovers and displays the resource mapping. It rotates only the
root token after confirmation. It writes a mode-0600 recovery journal before the remote change, so
a stopped command can reuse the same token. A pre-existing deployment whose physical or Alchemy
logical names differ from the generic convention can be recovered with a private
`--adoption-manifest PATH`; `.scotty-adoption.json` is ignored by Git.

Use `scotty deploy` for normal updates. It reads the managed installation from `~/.scotty.json`,
checks the current Docker context, and shows the Alchemy resource plan. It asks for confirmation
only when the plan has changes. A non-interactive deployment with changes needs `--yes`. Deployment
never generates or changes the root token. On interactive macOS, Scotty offers to start Colima when
the current Docker context is unavailable. It never changes `DOCKER_HOST`.

Use `scotty uninstall` to remove the Container application and both Workers. It removes the local
config only after the remote work succeeds. KV and R2 remain by default. Pass `--delete-data` only
when the session index and every backup must also be deleted. Both modes stop all active sessions.

Alchemy declares the Worker, Durable Objects, Container application, KV namespace, R2 bucket,
assets, bindings, migrations, and retained-resource policy. Defaults are derived from the
installation name: `scotty-NAME-worker`, `scotty-NAME-runner`, `scotty-NAME-sandbox`,
`scotty-NAME-sessions`, and `scotty-NAME-backups`. No Cloudflare account ID, workers.dev hostname,
Container UUID, or runner instance name is committed.

### Production runbook

Production deploys are local-only and forward-only. The guarded wrapper refuses CI, any branch
other than `main`, a dirty worktree, or a local `main` that differs from `origin/main`.

1. Fast-forward a clean local `main` to the reviewed GitHub state.

   ```sh
   git switch main
   git fetch origin main
   git merge --ff-only origin/main
   git status --short --branch
   ```

2. Ensure Docker and Cloudflare authentication are available. On macOS with Colima:

   ```sh
   colima start default
   DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" docker info
   ```

3. Run the guarded deployment for the installation. Omit `SCOTTY_ADOPTION_MANIFEST` when the
   installation uses Scotty's default resource names.

   ```sh
   DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" \
   SCOTTY_INSTALLATION_NAME=home \
   SCOTTY_ADOPTION_MANIFEST="${HOME}/.config/scotty/production-adoption.json" \
     npm run deploy:production
   ```

4. Require the command to finish successfully. It runs `npm run check`, audits the current
   Container inventory, builds an isolated image context, deploys through Alchemy, waits for the
   exact Container rollout and health counters to converge, and audits the deployed inventory
   again.

5. Verify the connected installation from the freshly built CLI:

   ```sh
   npm run build:cli
   ./dist/scotty doctor --json
   ```

Do not substitute a direct Wrangler production upload for this runbook. A Worker upload alone does
not prove that the Container rollout converged or that runtime inventory remained healthy. If the
guard fails, fix the reported Git, test, audit, or rollout condition and rerun the same command; do
not bypass it with a direct Alchemy or Wrangler deployment.

On an ARM Mac, the emulated `linux/amd64` image build can rarely stop during `npm ci` with a
segmentation fault or exit code 139. Let the guarded command finish its rollout settlement and final
audit. If the guard proves that production remains healthy, rerun the same guarded command once.
There is no automatic retry because a failed deployment can leave unclear provider state. If the
second build fails, stop and diagnose the Docker VM or architecture emulation. Do not retry with a
direct Alchemy or Wrangler command.

Normal guarded output redacts Cloudflare account IDs, resource IDs, physical resource names, and Worker URLs.
It also prints one short message when the Container image builds, artifacts upload, the Cloudflare
update applies, the rollout settles, and the final audit runs.

The current Cloudflare gate is forward-only: the full local suite and Colima-backed image build must
pass with the pinned Pi version, then the guarded deployment and deployed canary must prove
`beam up → Pi worklog → snapshot → resume → vaporize`.

## CLI

Install the current signed release on macOS or Linux with GitHub CLI:

```sh
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=scotty-darwin-arm64 ;;
  Darwin-x86_64) asset=scotty-darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) asset=scotty-linux-arm64 ;;
  Linux-x86_64) asset=scotty-linux-x64 ;;
  *) echo "Unsupported platform" >&2; exit 1 ;;
esac
scotty_download_dir=$(mktemp -d)
gh release download --repo Yeshwanthyk/scotty --pattern "$asset" --dir "$scotty_download_dir"
mkdir -p "${HOME}/.local/bin"
install -m 0755 "$scotty_download_dir/$asset" "${HOME}/.local/bin/scotty"
"${HOME}/.local/bin/scotty" --version
```

After the first install, `scotty upgrade` verifies the signed release manifest and executable hash
before replacing the current binary. Add `${HOME}/.local/bin` to `PATH` to invoke it as `scotty`.
Contributors can instead run `npm run build:cli` and use `./dist/scotty` directly.

```sh
npm run build:cli
./dist/scotty init --name home
./dist/scotty recover --name home
./dist/scotty deploy
./dist/scotty doctor --json
./dist/scotty owner recover
./dist/scotty beam up "fix the failing tests" --title "Fix tests" --repo owner/project --provider cloudflare --json
./dist/scotty beam down SESSION_ID --json
./dist/scotty beam vaporize SESSION_ID --yes --json
./dist/scotty inspect SESSION_ID --json
./dist/scotty steer SESSION_ID "check the focused tests" --json
./dist/scotty upgrade
./dist/scotty uninstall
./dist/scotty skills
```

### Hatch and screenshots

Hatch is the authenticated live app for the current sandbox. The sandbox agent starts it with
`scotty_hatch ensure` and keeps that process running. Open it from the paired session shell's
**Open Hatch** control, or open the session URL with `/hatch/open` appended. Do not copy or share the
wildcard preview URL, handoff token, route nonce, or Hatch cookie.

Browser evidence must use a separate temporary server on a different port from Hatch. Run one
bounded `scotty_browser_test`, stop only the temporary server, and leave Hatch running. The agent's
latest update must include the exact structured `scotty-hatch:<hatchId>` and
`scotty-evidence:<jobId>` references from the same conversation. Summary then shows the live Hatch
control and retained screenshots. Do not blindly retry a failed evidence run; change the failure
cause or session state first.

For a trusted Linux VPS, first build or pull the pinned runtime image and sign in with `gh`.
Then run the repeatable user-service setup:

```sh
./dist/scotty runner setup \
  --name "$RUNNER_NAME" \
  --root /home/runner/.local/state/scotty-runner \
  --image sha256:<64-lowercase-hex> \
  --codex-auth /home/runner/.codex/auth.json \
  --source-binary /absolute/path/to/dist/scotty
```

`inspect` passively reads a warm session without starting or waking its container. `steer` takes a
fresh passive snapshot and submits one bounded prompt against that exact epoch and session revision;
stale or ambiguous outcomes are never retried automatically. On a local machine these commands use
the configured Worker and root bearer token. Inside a Scotty sandbox they instead use the exact
`https://scotty.internal` origin without loading or forwarding root credentials or source identity.
The source Sandbox Durable Object derives authority only from the Cloudflare container context and
allows a different target only when both authoritative session records have exactly the same
repository identity. This coordination is request-scoped; it has no mailbox or persisted
coordination state.

The installed `cloudflare/sandbox:0.12.3` HTTPS interceptor's trust of the reserved origin cannot be
proven by local tests. A deployed same-repository inspect/steer canary remains a production gate; the
local suite is not production proof.

The command uses the installation in `~/.scotty.json`, registers the required name with the
control plane, receives a one-time runner credential, imports the current GitHub CLI login,
installs runner-only credential files, writes and restarts the hardened systemd user service, and
fails if the service is not active. Pass `--replace` only when moving or reinstalling an existing
runner; that rotates its credential and disconnects the old machine. Use `scotty runner list` to
inspect registrations and `scotty runner remove NAME --yes` after all assigned sessions are gone.
The runner credential is never accepted as a command argument or stored in Worker configuration.
Runner-backed session creation remains disabled until the runner link has a native Pi RPC worklog
transport; registration and lifecycle control are intentionally available first.

Run `scotty owner recover` once on the intended primary browser after a fresh deployment or when
moving to a replacement laptop. Keep `SCOTTY_TOKEN` in a password manager or another protected
recovery location. `scotty attach <id>` opens the Pi worklog at the clean session URL and requires
an already paired browser. Sleeping sessions must be resumed from Home before the worklog opens.
See
[`docs/owner-transfer-cutover.md`](docs/owner-transfer-cutover.md) before production migration.

## E2E

```sh
node e2e/scripts/run.mjs
```

The destructive deployed canary uses the stage-isolated
`spikes/infra/full-stack-canary.run.ts` stack and requires every stage-scoped gate documented in
`e2e/README.md`. Its production Worker host check fails closed.
