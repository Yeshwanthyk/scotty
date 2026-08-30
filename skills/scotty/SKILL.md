---
name: scotty
description: Set up, deploy, verify, or synchronize a Scotty installation from a verified release or an explicitly approved exact checkout. Use when an agent needs to install Scotty, configure Hatch and Evidence, publish a reviewed release, add session capabilities, or verify a deployed sandbox.
---

# Set up Scotty

1. Obtain an explicit lowercase installation name, Cloudflare profile, preview DNS base, and the 32-character lowercase Cloudflare zone ID that owns that base. Never infer these values from a username, machine, repository, or Cloudflare account.
2. Run `scotty init --name NAME --profile PROFILE --preview-base DOMAIN --preview-zone-id ZONE_ID`. Review and confirm the displayed account, resources, and Hatch/Evidence domain. Use `--yes` only when the user already authorized non-interactive creation.
3. Treat successful init as the setup boundary: it provisions the wildcard DNS and Worker route used by Hatch and Evidence, enables both capabilities, and saves the private managed installation pointer. Do not create parallel Wrangler resources or manually copy root credentials.
4. Declare Pi and repository-scoped GitHub credential sources in `~/.config/scotty/scotty.toml`, then run `scotty config check`, `scotty sync --json`, and `scotty doctor --json`.
5. Run `scotty owner recover` in the browser that will own the installation. Create a fresh session and verify chat plus `scotty_hatch ensure` before calling setup complete.

# Deploy Scotty

1. Choose one exact deployment source.
   - For a published release, run `scotty upgrade` and use the verified signed executable.
   - For an explicitly approved unreleased checkout, use `bun cli/scotty.ts` from a clean detached worktree at the intended commit. Record that commit. Never let an older installed executable deploy newer checkout sources, and never deploy from a dirty worktree.
2. With the chosen executable, run `scotty deploy --plan --json` for a release or `bun cli/scotty.ts deploy --plan --json` for a checkout. Review `version`, `plan`, `bundle`, and every entry in `changes`. This command does not write provider or Worker state; it saves a private one-use authorization record for the exact provider plan and capability bundle.
3. If `changes` includes `SandboxContainer`, expect apply to read authoritative session readiness. Wait for active work to finish and checkpoint affected sessions. Do not infer safety from `scotty list`, bypass a missing readiness route, or treat a 404 as an empty session set.
4. Obtain explicit authorization for that exact plan. Then run `scotty deploy --yes --json` for a release or `bun cli/scotty.ts deploy --yes --json` for a checkout. Never add `--yes` without the preceding reviewed plan. If Scotty reports `deployment_plan_changed` or consumes a plan after a failed preflight, stop and review a fresh plan; do not bypass the mismatch.
5. Treat success as provider rollout settlement plus publication of the reviewed bundle. Run `scotty doctor --json` or `bun cli/scotty.ts doctor --json`, then run the matching plan command again and require `changes: []`.
6. For full sandbox proof, obtain an explicit `OWNER/REPO`; never infer one. Run `beam` with that repository, verify the session, then run `vaporize SESSION_ID --yes --json`. For a signed release, do not require a source checkout, Node, npm, or a repository deploy script.

# Sync Scotty capabilities

1. Inspect `~/.config/scotty/scotty.toml`, especially its `[sync]` roots. Place content under those roots, or locally check out Git-backed content there.
   - Skills are directories containing `SKILL.md`.
   - Tools may be executable files or directories; make executable tools executable (`chmod +x`).
   - Extensions may be files or directories.
   - Package directories must already contain runtime dependencies.
2. Run `scotty config check` and fix any reported source error.
3. Run `scotty sync --json`. Treat `items` as the synchronized `{kind, name}` entries and save `digest` as the immutable bundle identity.
4. Create a fresh session using the current bundle and verify the expected skill, tool, or extension there. Existing sessions stay pinned to their original digest.

# Read and steer sessions

1. Use `scotty read SESSION_ID` to read the latest user or assistant message without waking the session. Use `--last N` for bounded context and `--role user|assistant` when only one side is needed. Do not use the full `inspect` snapshot for ordinary transcript reads.
2. Use the returned `sequence` as the cursor. Run `scotty read SESSION_ID --since SEQUENCE --json` to check for a newer snapshot, or add `--follow` to stream new or changed readable messages as JSON lines. A sequence cursor indicates snapshot change; it is not a wall-clock timestamp or a per-message sequence.
3. Use `scotty inspect SESSION_ID --json` only for state, active tools, queues, pending UI, truncation, or protocol diagnosis. Treat `truncated: true` from `read` as notice that older messages fell outside the bounded passive snapshot.
4. Use `scotty steer SESSION_ID "MESSAGE" --json` for one new instruction. Read again after acceptance. Never retry an ambiguous steer automatically, and do not treat an accepted receipt as proof that Pi completed the work.
