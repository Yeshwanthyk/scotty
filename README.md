# Scotty

Scotty moves durable coding sessions between your machines and an on-demand Cloudflare workspace.

```text
scotty beam up
scotty beam down <id>
scotty beam vaporize <id>
scotty beam resume <id>
```

`up` is the only command that does not take a session id. It captures the current local coding-agent session, wakes the cloud copy, and prints the stable id and phone URL. When Scotty's SSH gateway is configured, it also prints the exact SSH command for Termius. All later lifecycle operations use that id exactly.

Inside the cloud terminal, `beam pr [--title <text>] [--base <branch>] [--draft]` creates the pull request through Scotty's session-scoped Worker route. The sandbox receives no operator token or real GitHub key. The internal `beam` executable is Scotty's transport engine; it is not a separate Cloudflare project.

## Semantics

- `up` delegates the portable session capture to `beam push`. Use `--session provider:id` only when the current repository has multiple local agent sessions.
- Local session uploads require a committed repository with a reachable private Git remote named `origin`. Scotty reports an actionable error before any cloud state is created when that remote is missing.
- `down <id>` delegates to `beam pull`, including its divergence checks and final cloud flush, and materializes the session on the machine running Scotty.
- `vaporize <id>` calls Scotty's safe suspend route. Scotty flushes Git and agent state, creates a native Cloudflare `/workspace` backup, verifies its R2 pointer, and only then destroys compute. The same operation runs automatically after the configured idle timeout.
- `resume <id>` restores the workspace backup and wakes the durable session. If the backup is missing or expired, Scotty safely falls back to the Git/R2 backbone. The phone URL and id do not change.

To create a new cloud session without a local agent transcript, keep the same public verb:

```text
scotty beam up --project owner/repo --provider codex --prompt "implement the issue"
```

## Configuration

Scotty reads `~/.config/scotty/config.json`. Existing `~/.config/beam/config.json` files remain a compatibility fallback. Environment overrides are available as `SCOTTY_API_URL`, `SCOTTY_TOKEN`, and `SCOTTY_GATEWAY_HOST`; legacy `BEAM_*` names also work.

The `beam` executable must be on `PATH` for `up` and `down`. Set `SCOTTY_BEAM_BIN` to override its location.

Read-only support commands are available without adding more lifecycle mutations:

```text
scotty beam list [--all]
scotty beam status <id>
scotty beam help [command]
```

Every command also accepts `--json`, so Mob and other automation can consume the same lifecycle without scraping terminal text.

## Development

```text
bun install
bun run check
```
