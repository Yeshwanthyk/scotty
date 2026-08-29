# Scotty

Scotty runs Pi in a persistent Cloudflare Sandbox workspace, presents its live worklog at an
authenticated `/s/<id>` URL, checkpoints the workspace to R2, and can resume, archive a rollout,
or permanently destroy the session.

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
          | fixed managed handles only        |
          +------------------+-----------------+
                             |
                             v
          +------------------------------------+
          | ContainerProxy allowlisted egress |
          | Registry-backed exact egress       |
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
- `assets/brand/` — app icons, favicons, hero/social art, and agent glyphs.
- `e2e/` — direct static contract checks, the local-live harness and helper tests, deployed route
  checks, and an explicitly gated deployed canary.
- `spikes/` — executable probes for the upstream Sandbox contracts.

## Security model

Repository code is untrusted. Real Pi provider and GitHub credentials stay in the credential Registry. The container receives fixed managed handles only. Registry-backed `ContainerProxy` serves allowlisted exact-origin egress, sanitizes OAuth refresh responses before they return to the container, and denies all other outbound traffic.

Browser authority is separate from the root credential. `SCOTTY_TOKEN` is accepted only as a CLI
bearer and break-glass recovery credential; it is never accepted from a cookie, browser URL, or
`?t=`. The singleton Auth Durable Object stores exactly one owner client ID plus an ownership
epoch. Other browsers are standard clients. Pairing creates standard access, ownership transfer is
bound to one existing target browser, and root recovery revokes every browser credential before
creating a fresh owner. Raw client, pairing, transfer, and recovery secrets are never persisted.
For each paired device, the Auth Durable Object retains a server client ID, credential digest,
neutral or user-supplied label, scopes, created, expiry, and last-seen times, optional user agent,
and revocation time. The default standard-client label contains no hostname.

The browser never receives container credentials. For Cloudflare sessions, the Worker authenticates
the terminal WebSocket and attaches it to the Sandbox native PTY running Pi. Pi and Codex receive
only fixed managed provider and GitHub handles.

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
npm run test:e2e:local-live:helpers
node --test scripts/sessions-shell.test.mjs

# Format touched files and finish with the complete repository gate
npx oxfmt --disable-nested-config --write README.md worker/src/sandbox-runtime.ts
npm run check
```

Replace these paths with the files under change. `npm run check` verifies pinned Effect and Pi
packages, formatting, lint, every typecheck and test suite, and the repository secret scan. The
default suites do not use Cloudflare, Pi provider, or GitHub credentials.

### Minimal local lab

Use the repository-local lab when you need to run the real CLI against the production Worker in
Wrangler local mode with Docker-backed Sandbox support:

```sh
npm run lab -- start
npm run lab -- exec RUN_ID -- doctor --json
npm run lab -- stop RUN_ID
```

`start` requires Docker and Bun. It uses isolated temporary Wrangler state and CLI `HOME`, passes a
run-specific Wrangler worker name, and
prints a JSON run ID and host after `/health` passes. Commands forwarded through `exec` use the
actual CLI and can exercise real local Sandbox lifecycles; `doctor` alone does not create one.
`stop` removes only Sandbox containers named for that worker. The private `.scotty-lab/run.json`
manifest contains no credentials; ephemeral
mode-0600 files under the system temporary directory hold the generated root token, Wrangler
inputs, and redacted startup log until `stop`. `exec` forwards arguments directly to
`cli/scotty.ts` without a shell and preserves its stdio and exit status.

Every future complexity slice must follow the before/after representative-flow gate in
[`docs/scotty-lab.md`](docs/scotty-lab.md) and halt immediately on unexplained divergence.

When a change crosses the real Worker/Sandbox/Pi boundary, also run the local-live loop. It uses
temporary Wrangler state and Docker containers and does not touch deployed Scotty resources:

```sh
DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" \
  npm run test:e2e:local-live -- --no-open --no-hold
```

This requires a healthy Docker daemon. It proves fresh-start managed-credential wiring; provider
credential proof requires a deployed Registry. Add
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
stores the local pointer in mode-0600 `~/.config/scotty/installation.json`. The installation name is required and is
never inferred from a username, machine, repository, or Cloudflare account.

For a clean first run:

1. Run `scotty init --name NAME` and confirm the displayed Cloudflare account and resource names.
2. Declare the Pi and GitHub credential sources in `scotty.toml`, then run `scotty sync`.
3. Run `scotty doctor --json`.
4. Run `scotty owner recover` on the browser that will own the installation.
5. If another browser needs access, open `/devices` in the owner browser and create a one-use pairing link.
6. Use `scotty beam` to start a session and open its authenticated worklog in your browser.

`sync` uses the account, Worker name, and origin saved by `init`. It fails before reading local
credential sources if Cloudflare does not match that saved installation.

On a replacement machine, run `scotty recover --name NAME`. Cloudflare profile ownership is the
recovery authority. The CLI first discovers and displays the resource mapping. It rotates only the
root token after confirmation. It writes a mode-0600 recovery journal before the remote change, so
a stopped command can reuse the same token. A pre-existing deployment whose physical or Alchemy
logical names differ from the generic convention can be recovered with a private
`--adoption-manifest PATH`; `.scotty-adoption.json` is ignored by Git.

Use `scotty deploy` for normal updates. It reads the managed installation from `~/.config/scotty/installation.json`,
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

2. Ensure Cloudflare authentication is available. Docker is required only for an intentional
   Container release. On macOS with Colima:

   ```sh
   colima start default
   DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" docker info
   ```

3. Run the guarded deployment for the installation. Omit `SCOTTY_ADOPTION_MANIFEST` when the
   installation uses Scotty's default resource names. Production requires the installation's
   explicit Hatch/Evidence preview topology and always enables Evidence. Put that topology in the
   private adoption manifest, or provide `SCOTTY_PREVIEW_BASE` and `SCOTTY_PREVIEW_ZONE_ID`.

   ```sh
   DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" \
   SCOTTY_INSTALLATION_NAME=home \
   SCOTTY_ADOPTION_MANIFEST="${HOME}/.config/scotty/production-adoption.json" \
     npm run deploy:production
   ```

   The default command requires the Container plan to be a no-op and does not open Docker. When
   the release intentionally changes the Container image or configuration, review that plan and
   authorize it explicitly:

   ```sh
   DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" \
   SCOTTY_INSTALLATION_NAME=home \
   SCOTTY_ADOPTION_MANIFEST="${HOME}/.config/scotty/production-adoption.json" \
     npm run deploy:production -- --container
   ```

4. Require the command to finish successfully. It runs `npm run check`, audits the current
   Container inventory, builds a dependency-minimal image context, and runs an Alchemy plan before
   applying anything. A normal release stops unless `SandboxContainer` is a no-op. An explicitly
   authorized Container release waits for the exact rollout and health counters to converge. Both
   paths audit the deployed inventory again.

5. Verify the connected installation from the freshly built CLI:

   ```sh
   npm run build:cli
   ./dist/scotty doctor --json
   ```

Do not substitute a direct Wrangler production upload for this runbook. A Worker upload alone does
not prove that the Container rollout converged or that runtime inventory remained healthy. If the
guard fails, fix the reported Git, test, audit, or rollout condition and rerun the same command; do
not bypass it with a direct Alchemy or Wrangler deployment. Do not add `--container` merely to get
past a failed no-op check; first confirm that the image or Container configuration is intended to
change.

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
`beam → Pi worklog → snapshot → resume → vaporize`.

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
./dist/scotty beam "fix the failing tests" --title "Fix tests" --repo owner/project --provider cloudflare --json
./dist/scotty vaporize SESSION_ID --yes --json
./dist/scotty inspect SESSION_ID --json
./dist/scotty steer SESSION_ID "check the focused tests" --json
./dist/scotty upgrade
./dist/scotty uninstall
./dist/scotty skills
```

### Hatch and Showcase

Hatch is the authenticated live app for the current sandbox. The sandbox agent starts it with
`scotty_hatch ensure` and keeps that process running. Open it from the paired session shell's
**Open Hatch** control, or open the session URL with `/hatch/open` appended. Do not copy or share the
wildcard preview URL, handoff token, route nonce, or Hatch cookie.

Browser evidence uses a separate temporary server on a different port from Hatch. Before changing
visible behavior, define one bounded flow with at most three observable checks. Run that exact
viewport, action, and assertion graph once with video disabled. Make the change, then run the same
graph with video enabled. Both runs use Scotty's fixed local evidence runner with headed Chromium on
an isolated X display inside the sandbox. It captures each step as PNG and, when requested, ffmpeg
records the same live pixels as WebM; it does not stitch screenshots or use rrweb replay. Stop only
the temporary server and leave Hatch running.

The agent's latest update must include the exact structured `scotty-hatch:<hatchId>` reference and
both `scotty-evidence:<jobId>` references from the same conversation. Summary then shows the live
Hatch control and one private Showcase link. Showcase contains matched before/after screenshots,
passed assertions, and the actual WebM recorded by the after browser run. Do not blindly retry a
failed evidence run; change the failure cause or session state first.

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

The command uses the installation in `~/.config/scotty/installation.json`, registers the required name with the
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

## E2E

The repository does not ship a fake or default offline E2E suite. The direct static contract and
local-live helper tests are included in `npm run test:all`:

```sh
npm run test:e2e:static
npm run test:e2e:local-live:helpers
```

The real local Worker, Sandbox, and Pi loop is explicit and requires Docker, `gh auth`, and Pi
credentials; see `e2e/README.md`:

```sh
npm run test:e2e:local-live -- --no-open --no-hold
```

The non-mutating deployed route check and destructive deployed canary are also explicit:

```sh
npm run test:e2e:deployed-routes
npm run test:e2e:deployed
```

The canary uses the stage-isolated `spikes/infra/full-stack-canary.run.ts` stack and requires every
stage-scoped gate documented in `e2e/README.md`. Its production Worker host check fails closed.
