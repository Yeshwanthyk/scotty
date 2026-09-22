# Setup and updates

[README](../README.md) · [CLI](cli.md) · [Architecture](architecture.md)

## Requirements

- macOS or Linux, on arm64 or x64.
- GitHub CLI (`gh`), authenticated for release downloads and GitHub credential sync.
- A Cloudflare account and a zone for the preview domain used by Hatch and browser evidence.
- Docker for deployment. The signed CLI does not require a source checkout, Node, npm, or Bun.
- A local Pi or Codex credential source for the agent you choose.

Installation names, Cloudflare profiles, preview domains, zone IDs, and repositories are your inputs.
Scotty must not infer them from your machine or account.

## Install the signed CLI

Download the release for your platform and verify its GitHub build provenance **before executing it**:

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
gh attestation verify "$scotty_download_dir/$asset" \
  --repo Yeshwanthyk/scotty \
  --signer-workflow Yeshwanthyk/scotty/.github/workflows/release-cli.yml
```

Continue only if verification succeeds:

```sh
mkdir -p "${HOME}/.local/bin"
install -m 0755 "$scotty_download_dir/$asset" "${HOME}/.local/bin/scotty"
"${HOME}/.local/bin/scotty" --version
```

Add `${HOME}/.local/bin` to your `PATH`. The release assets and provenance are defined in
[the release workflow](../.github/workflows/release-cli.yml).

## Create an installation

Replace the placeholders with values you choose:

```sh
scotty init --name NAME --preview-base DOMAIN --preview-zone-id ZONE_ID
```

`init` authenticates the Cloudflare profile, shows the account and resources, and asks for approval
before deploying. It creates the wildcard DNS and Worker route for Hatch and evidence, uploads the
root Worker secret outside Alchemy state, and saves a mode-0600 local pointer at
`~/.config/scotty/installation.json`.

The prompts collect your agent, model, repositories, application environment, and credential source
paths. Flags include `--profile`, `--agent`, `--model`, `--effort`, `--repos`, `--env`,
`--pi-auth` or `--codex-auth`, and `--github`. Pi and Codex credential sources are mutually exclusive.
Keep source files private; never paste credentials into command arguments or output.

Then check the installation and claim the owner browser:

```sh
scotty doctor --json
scotty owner recover
```

Owner recovery revokes existing browser credentials. To add another browser without replacing the
owner, create a one-use pairing link from `/devices` in the owner browser. Keep `SCOTTY_TOKEN` in a
password manager or another protected recovery location, never in a URL or cookie.

## Start a session

Register a repository if you did not include it during init:

```sh
scotty repo add OWNER/REPO
scotty beam "fix the failing tests" --title "Fix tests" --repo OWNER/REPO --provider cloudflare
```

You can also create sessions in the browser. Repository registration and GitHub credential access
are separate: adding a repository does not grant the credential access to it.

See [CLI](cli.md) for credential sync, session controls, and sandbox resources.

## Update the CLI

```sh
scotty upgrade
scotty --version
scotty --build-info
```

`upgrade` verifies the signed release manifest and executable hash before replacing the CLI. It
updates the bundled agent guides and embedded deployment bundle, but does not change the hosted
Worker or web UI. Main-branch pushes do not publish a release.

Each signed CLI release contains the Worker and web UI built from that release's source. New
installations receive those embedded assets during `scotty init`; init does not fetch UI files from
`main`. Re-running init on an already configured installation does not redeploy them. To update an
existing installation, upgrade the CLI, then follow the deployment steps below. The sandbox Docker
image is a separate release artifact; the web UI is deployed as Worker assets.

`--version` shows the release version. `--build-info` shows the build commit and whether the
executable includes the deployment archive. Use the packaged release for deployment; compiling
`cli/scotty.ts` directly with Bun omits that archive.

## Update the cloud installation

Use the signed executable, the managed installation's Cloudflare profile, and Docker.

```sh
scotty deploy --plan --json
```

The plan command saves a private, one-use authorization record without changing provider or Worker
state. Review its `version`, `plan`, `bundle`, and `changes`. After approval:

```sh
scotty deploy --yes --json
scotty doctor --json
```

Apply recomputes the plan identity and refuses drift before provider writes. It waits for Container
rollout settlement and updates the local installation pointer. Deployment does not rotate the root
token. Publishing [sandbox resources](cli.md#sandbox-resources) is a separate operation.

For Colima on macOS, start Docker yourself if needed:

```sh
colima start default
DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" docker info
```

Use the same `DOCKER_HOST` prefix for plan and apply. Scotty does not change `DOCKER_HOST` for you.

### Deployment failures and proof

Do not bypass a failed deployment guard with a direct Wrangler or Alchemy upload. A Worker upload
does not prove that its Container rollout settled. Fix the reported condition before retrying.

On an ARM Mac, an emulated `linux/amd64` build can fail during `npm ci` with a segmentation fault
or exit code 139. Let the guard finish settlement and its final audit. Retry the same command once
only if that audit proves the existing deployment is healthy. If the second build fails, stop and
diagnose Docker or architecture emulation. Do not retry an ambiguous provider outcome blindly.

Guarded output redacts account IDs, resource IDs, physical resource names, and Worker URLs. It reports
image build, artifact upload, apply, rollout settlement, and final audit progress.

For session proof, choose an explicit repository, create a test session, verify its work, and vaporize
it afterward. The full release gate also requires the local suite, image build, guarded deployment,
and [deployed canary](../e2e/README.md). A successful `doctor` or local test is not that proof.

## Recover or uninstall

On a replacement machine:

```sh
scotty recover --name NAME
```

Cloudflare profile ownership authorizes recovery. After confirmation, Scotty discovers the named
installation and rotates only its root token. A mode-0600 journal is written before the remote
change so interrupted recovery can reuse the same token. Then use `scotty owner recover` to claim
the new browser.

```sh
scotty uninstall
```

Uninstall stops active sessions and removes the Container application and both Workers. It removes
local config only after remote work succeeds. KV and R2 are retained by default. Use `--delete-data`
only when you intend to delete the session index and every backup too.

## Agent guides

```sh
scotty skill show
scotty skill show scotty-live-observability
```

The guides are bundled with the CLI. `init` and `upgrade` do not install skills into your local
coding agent.

For automatic discovery, add a small `SKILL.md` in your agent's configured skill directory that tells
it to run `scotty skill show` and follow the result. Review any existing skill, preserve custom
delegation instructions, and verify discovery in a fresh agent session. This keeps guidance current
without overwriting local skills.

Local skill discovery is separate from a public shared skill catalog, which Scotty does not provide.

## Implementation references

- [CLI commands](../cli/src/commands.ts) and [command tests](../cli/effect-test/command-tree.test.ts)
- [Upgrade verification](../cli/src/upgrade.ts)
- [Installation deployment](../cli/src/installation-deployment.ts)
- [Deployment safety tests](../scripts/deployment-safety.test.mjs)
