# Scotty

![Scotty](ui/src/assets/brand/scotty-hero-16x9.png)

Codex and Claude sessions in Cloudflare Containers, driven from your phone or one CLI. It runs on your own Cloudflare account, behind Cloudflare Access, for one user.

- **Sessions** on any GitHub repository: steer them, review their diffs, open the ports they serve. A stopped session resumes where it left off.
- **Skills** from GitHub repositories, and instructions every session gets.
- **Webhooks and schedules** start, wake or end sessions.
- **Blueprints** set up a whole workflow in one step: a PR reviewer, or a Linear issue worker ([blueprints/](blueprints/), or Settings → Blueprints).
- **Connections** let sessions call APIs and MCP servers without seeing the tokens.
- **An MCP server** at `https://<host>/mcp`, so claude.ai, ChatGPT, Claude Code or Codex can drive sessions.

## Set up

You need:

- A Cloudflare account on Workers Paid, with Zero Trust on (the free plan is enough), and a domain on it.
- GitHub, and a ChatGPT plan (for Codex) or a Claude plan (for Claude).
- `cloudflared` and `gh`, on macOS or Linux x64.

```sh
brew install yeshwanthyk/scotty/scotty
# or: curl -fsSL https://github.com/Yeshwanthyk/scotty/releases/latest/download/install.sh | sh
scotty init
```

`init` signs you in to GitHub and Cloudflare, asks for a stage name, your email, the domain and the agents, deploys, and ends with `doctor`. One stage per domain.

On your phone, open the address `init` prints. To install it as an app, tap Share → Add to Home Screen in Safari.

## Use

```sh
scotty doctor                          # is everything working?
scotty new owner/repo "fix the flaky test" [--agent claude]
scotty ls / read <id> / steer <id> "…"
scotty skills add owner/repo           # then: scotty skills on <name>
scotty blueprint install pr-reviewer.json --repo owner/repo < secrets.json
scotty automation add <name> <repo> <prompt> --cron "0 9 * * 1"
scotty deploy                          # after brew upgrade scotty
scotty teardown                        # remove everything from Cloudflare
scotty --help                          # every command
```

## Let your agent do it

Paste this into Claude Code or Codex:

```text
Set up Scotty for me and start a session with it. Install it with
`brew install yeshwanthyk/scotty/scotty`, then run `scotty skill` and follow that guide. Ask me before anything that needs my browser or my accounts. Finish when
`scotty doctor` is green and a session on a repository I name has answered.
```

`scotty skill` prints [skills/scotty/SKILL.md](skills/scotty/SKILL.md), the guide for an agent.

## Develop

[docs/setup.md](docs/setup.md) covers working from a checkout, building the image, running the checks and cutting a release. [docs/design.md](docs/design.md) is the design; [docs/plan.md](docs/plan.md) is the work queue.
