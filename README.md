# Scotty

Coding-agent sessions in Cloudflare Containers, driven from a phone-friendly web UI and one CLI.

This branch is a rebuild. See [docs/design.md](docs/design.md) for the shape and [docs/plan.md](docs/plan.md) for the steps and their status. The previous implementation is on `main` at `3042018`.

## Get started

You need:

- A Cloudflare account on **Workers Paid**, with **Zero Trust** turned on (the free plan is enough).
- A **domain on that account**. Scotty runs at a name under it, such as `scotty.example.com`, and previews at `<port>-<id>.example.com`.
- A GitHub account, and a ChatGPT plan for Codex or a Claude plan for Claude (or both).
- On your machine: [Node 22](https://nodejs.org), [Bun](https://bun.sh), `git`, and `brew install cloudflared gh`.

Then:

```sh
git clone https://github.com/Yeshwanthyk/scotty.git && cd scotty
git switch rebuild/core
npm install
bun cli/main.ts init
```

`init` signs you in to GitHub and Cloudflare if needed, asks a few questions (stage name, your email, which Cloudflare account and domain, the address, which agents), deploys, and signs you in to the agents you pick. It ends with `doctor`, which says what works and how to fix what doesn't. Run commands from this folder: it keeps the deploy state that `deploy` and `teardown` need. One stage per domain: a stage owns its domain's preview address, so `init` refuses a domain another stage uses.

```sh
bun cli/main.ts doctor      # is everything working?
bun cli/main.ts deploy      # update after git pull
bun cli/main.ts teardown    # remove everything from Cloudflare
bun cli/main.ts --help      # every command
```

Open the address from `init` on your phone to start sessions. [docs/setup.md](docs/setup.md) covers building your own image and running the checks.
