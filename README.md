# Scotty

Coding-agent sessions in Cloudflare Containers, driven from a phone-friendly web UI and one CLI.

This branch is a rebuild. See [docs/design.md](docs/design.md) for the shape and [docs/plan.md](docs/plan.md) for the steps and their status. The previous implementation is on `main` at `3042018`.

## Get started

You need:

- A Cloudflare account on **Workers Paid**, with **Zero Trust** turned on (the free plan is enough).
- A **domain on that account**. Scotty runs at a name under it, such as `scotty.example.com`, and previews at `<port>-<id>.example.com`.
- A GitHub account, and a ChatGPT plan for Codex or a Claude plan for Claude (or both).
- On your machine (macOS or Linux x64): `cloudflared` and `gh`.

Then:

```sh
brew install yeshwanthyk/scotty/scotty     # or: curl -fsSL https://github.com/Yeshwanthyk/scotty/releases/latest/download/install.sh | sh
scotty init
```

The binary carries everything a deploy uploads. `init` signs you in to GitHub and Cloudflare if needed, asks a few questions (stage name, your email, which Cloudflare account and domain, the address, which agents), deploys, and signs you in to the agents you pick. It ends with `doctor`, which says what works and how to fix what doesn't. One stage per domain: a stage owns its domain's preview address, so `init` refuses a domain another stage uses.

```sh
scotty doctor      # is everything working?
scotty deploy      # update after brew upgrade scotty
scotty teardown    # remove everything from Cloudflare
scotty --help      # every command
```

## Let your agent do it

Paste this into Claude Code, Codex or another coding agent on your machine:

```text
Set up Scotty for me and start a session with it. Install it with
`brew install yeshwanthyk/scotty/scotty`, then run `scotty skill` and follow that guide. Ask me before anything that needs my browser or my accounts. Finish when
`scotty doctor` is green and a session on a repository I name has answered.
```

`scotty skill` prints [skills/scotty/SKILL.md](skills/scotty/SKILL.md), which tells an agent how to set up and drive Scotty. Save it where your agent finds skills to keep it around, for example `scotty skill > ~/.claude/skills/scotty/SKILL.md`.

Open the address from `init` on your phone to start sessions. [docs/setup.md](docs/setup.md) covers working on Scotty from a checkout, building your own image (`scotty deploy --image`) and running the checks.
