![Scotty](assets/brand/scotty-hero-16x9.png)

# Beam up a task. From anywhere.

Run coding agents across your repos without tying up your machine. Start sessions, follow
progress, and steer the work from your browser or terminal. Work with several agents at once
and try the apps they build.

## Features

- **Pi and Codex** — choose the agent for each session and use your existing credentials.
- **Custom skills** — bring your own instructions and workflows into your sandboxes.
- **Pi extensions** — add your own extensions and packages.
- **Custom Docker images** — select a pinned image for your sandbox environment.
- **Live app previews** — open and use the apps your agents build.
- **Terminal access** — work directly in a sandbox from your browser.
- **Agent-to-agent coordination** — let agents check on and steer other sessions.
- **Checkpoint and resume** — save a workspace and pick it up later.
- **Browser evidence** — review before-and-after screenshots, checks, and recorded video.
- **Browser and CLI control** — start sessions, follow progress, and steer the work.

See the [full feature map](docs/features.md) for details and current limits.

## Setup

You’ll need Docker, an authenticated GitHub CLI, and a Cloudflare account with a domain for app previews.

[Install the signed CLI](docs/setup.md#install-the-signed-cli). Already installed? Run `scotty upgrade`
to update the CLI. For cloud updates and agent skill discovery, see [Setup and updates](docs/setup.md).

Create your installation:

```sh
scotty init --name NAME --preview-base DOMAIN --preview-zone-id ZONE_ID
scotty doctor --json
scotty owner recover
```

`init` guides you through agent selection, credentials, and repositories. It shows the Cloudflare
resources before asking you to approve deployment.

Copy this prompt into your coding agent:

```text
Set up Scotty for me:
https://github.com/Yeshwanthyk/scotty

Read the README and its linked installation guide. Install the latest
signed CLI using the guide's provenance verification instructions.
No source checkout is needed. Run `scotty skill show` and follow the
bundled setup guide.

Ask me for the installation name, Cloudflare profile, preview domain
and zone ID, agent credentials, and GitHub repositories to register.
Never infer these values or print credentials.

Before changing Cloudflare resources, show me the target account,
resource plan, and command. Wait for my approval.

Run `scotty doctor --json`, open browser owner recovery, and help me
start a session in a repository I choose.
```

## Documentation

- [Setup and updates](docs/setup.md) — installation, credentials, deployment, and recovery.
- [CLI](docs/cli.md) — repositories, sessions, resources, and agent guides.
- [Features](docs/features.md) — capabilities and limits, linked to code and tests.
- [Architecture](docs/architecture.md) — system map, state ownership, and security.
- [Hatch and browser evidence](docs/hatch.md) — live apps, screenshots, and video.
- [Roadmap](docs/roadmap.md) — shipped work, pending proof, and next steps.
- [Development](docs/development.md) — contributor setup, local lab, and testing.
