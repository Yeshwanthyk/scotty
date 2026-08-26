---
name: scotty
description: Add or synchronize Scotty skills, command-line tools, and Pi extensions. Use when an agent needs new session capabilities or must publish changed local bundle content.
---

# Sync Scotty capabilities

1. Inspect `~/.config/scotty/scotty.toml`, especially its `[sync]` roots. Place content under those roots, or locally check out Git-backed content there.
   - Skills are directories containing `SKILL.md`.
   - Tools may be executable files or directories; make executable tools executable (`chmod +x`).
   - Extensions may be files or directories.
   - Package directories must already contain runtime dependencies.
2. Run `scotty config check` and fix any reported source error.
3. Run `scotty sync --json`. Treat `items` as the synchronized `{kind, name}` entries and save `digest` as the immutable bundle identity.
4. Create a fresh session using the current bundle and verify the expected skill, tool, or extension there. Existing sessions stay pinned to their original digest.
