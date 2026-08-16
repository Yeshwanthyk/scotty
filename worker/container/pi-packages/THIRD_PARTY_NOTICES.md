# Container Pi package notices

The container includes the exact source and npm pins recorded in [`manifest.json`](manifest.json).

- `pi-subagents` is MIT licensed. See `sources/pi-subagents/LICENSE` and
  `sources/pi-subagents/NOTICE.md`.
- `scotty-browser-test` is first-party Scotty code under the repository MIT license. See
  `sources/scotty-browser-test/LICENSE`.
- `playwright-core` is Apache-2.0 licensed. Its package license is installed with the pinned npm
  package used by `scotty-browser-test` in the container image.
- `scotty-hatch` is first-party Scotty code under the repository MIT license. See
  `sources/scotty-hatch/LICENSE`.
- `@ogulcancelik/pi-codex-compaction` is MIT licensed. Its package license is installed with the
  pinned npm package in the container image.

The image install projection is Scotty-owned and does not rewrite the Git-tracked vendor
checkouts. At image build it omits `@anthropic-ai/claude-agent-sdk` from `pi-subagents`, so
Claude Code and Codex CLI backends are not shipped. Keep `pi-codex-compaction`; it supports
Pi's `openai-codex` provider, not the Codex CLI.
