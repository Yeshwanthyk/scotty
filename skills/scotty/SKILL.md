---
name: scotty
description: Set up, deploy, verify, or synchronize a Scotty installation using only the signed Scotty executable. Use when an agent needs to install Scotty, configure Hatch and Evidence, publish a reviewed release, add session capabilities, or verify a deployed sandbox.
---

# Set up Scotty

1. Obtain an explicit lowercase installation name, Cloudflare profile, preview DNS base, and the 32-character lowercase Cloudflare zone ID that owns that base. Never infer these values from a username, machine, repository, or Cloudflare account.
2. Run `scotty init --name NAME --profile PROFILE --preview-base DOMAIN --preview-zone-id ZONE_ID`. Review and confirm the displayed account, resources, and Hatch/Evidence domain. Use `--yes` only when the user already authorized non-interactive creation.
3. Treat successful init as the setup boundary: it provisions the wildcard DNS and Worker route used by Hatch and Evidence, enables both capabilities, and saves the private managed installation pointer. Do not create parallel Wrangler resources or manually copy root credentials.
4. Declare Pi and repository-scoped GitHub credential sources in `~/.config/scotty/scotty.toml`, then run `scotty config check`, `scotty sync --json`, and `scotty doctor --json`.
5. Run `scotty owner recover` in the browser that will own the installation. Create a fresh session and verify chat plus `scotty_hatch ensure` before calling setup complete.

# Deploy Scotty

1. Run `scotty upgrade` so the installed executable contains the intended signed release.
2. Run `scotty deploy --plan --json`. Review `version`, `plan`, `bundle`, and every entry in `changes`. This command does not write provider or Worker state; it saves a private one-use authorization record for the exact provider plan and capability bundle.
3. Obtain explicit authorization for that exact plan. Then run `scotty deploy --yes --json`. Never add `--yes` without the preceding reviewed plan. If Scotty reports `deployment_plan_changed`, stop and review a fresh `--plan`; do not bypass the mismatch.
4. Treat success as provider rollout settlement plus publication of the reviewed bundle. Run `scotty doctor --json` for the connected installation.
5. For full sandbox proof, obtain an explicit `OWNER/REPO`; never infer one. Run `scotty beam` with that repository, verify the session, then run `scotty vaporize SESSION_ID --yes --json`. The signed executable owns this workflow; do not require a source checkout, Node, npm, or a repository deploy script.

# Sync Scotty capabilities

1. Inspect `~/.config/scotty/scotty.toml`, especially its `[sync]` roots. Place content under those roots, or locally check out Git-backed content there.
   - Skills are directories containing `SKILL.md`.
   - Tools may be executable files or directories; make executable tools executable (`chmod +x`).
   - Extensions may be files or directories.
   - Package directories must already contain runtime dependencies.
2. Run `scotty config check` and fix any reported source error.
3. Run `scotty sync --json`. Treat `items` as the synchronized `{kind, name}` entries and save `digest` as the immutable bundle identity.
4. Create a fresh session using the current bundle and verify the expected skill, tool, or extension there. Existing sessions stay pinned to their original digest.
