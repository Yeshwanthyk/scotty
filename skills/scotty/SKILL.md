---
name: scotty
description: Set up a Scotty installation or synchronize its skills, tools, packages, and extensions. Use when an agent needs to install Scotty, configure Hatch and Evidence, add session capabilities, or publish changed local bundle content.
---

# Set up Scotty

1. Obtain an explicit lowercase installation name, Cloudflare profile, preview DNS base, and the 32-character lowercase Cloudflare zone ID that owns that base. Never infer these values from a username, machine, repository, or Cloudflare account.
2. Run `scotty init --name NAME --profile PROFILE --preview-base DOMAIN --preview-zone-id ZONE_ID`. Review and confirm the displayed account, resources, and Hatch/Evidence domain. Use `--yes` only when the user already authorized non-interactive creation.
3. Treat successful init as the setup boundary: it provisions the wildcard DNS and Worker route used by Hatch and Evidence, enables both capabilities, and saves the private managed installation pointer. Do not create parallel Wrangler resources or manually copy root credentials.
4. Declare Pi and repository-scoped GitHub credential sources in `~/.config/scotty/scotty.toml`, then run `scotty config check`, `scotty sync --json`, and `scotty doctor --json`.
5. Run `scotty owner recover` in the browser that will own the installation. Create a fresh session and verify chat plus `scotty_hatch ensure` before calling setup complete.

# Sync Scotty capabilities

1. Inspect `~/.config/scotty/scotty.toml`, especially its `[sync]` roots. Place content under those roots, or locally check out Git-backed content there.
   - Skills are directories containing `SKILL.md`.
   - Tools may be executable files or directories; make executable tools executable (`chmod +x`).
   - Extensions may be files or directories.
   - Package directories must already contain runtime dependencies.
2. Run `scotty config check` and fix any reported source error.
3. Run `scotty sync --json`. Treat `items` as the synchronized `{kind, name}` entries and save `digest` as the immutable bundle identity.
4. Create a fresh session using the current bundle and verify the expected skill, tool, or extension there. Existing sessions stay pinned to their original digest.
