# pi-background-terminals

Private Pi package for running and managing long-lived shell commands while the agent continues working. It provides `bg_start`, `bg_status`, `bg_list`, `bg_kill`, and an interactive `/ps` process viewer.

## Install locally

```sh
pi install /Users/yesh/code/personal/pi-background-terminals
```

Reload an existing Pi session with `/reload`.

## Behavior

`bg_start` runs a non-interactive command in its own process tree and captures its output. The extension limits concurrent processes to eight, shows their status in `/ps`, sends one completion message when a command settles, and terminates every tracked process during session shutdown or reload.

Use regular shell commands for short work. Background terminals are for dev servers, watchers, and streaming builds that should keep running after the current turn.

## Development

```sh
npm install
npm run check
npm test
```

## Included documentation

The upstream implementation guide is preserved at [extensions/background-terminals/docs/implementation-guide.md](extensions/background-terminals/docs/implementation-guide.md). It describes the original monorepo implementation and therefore contains historical references to its sibling workflow and subagent extensions; this package is self-contained and does not require either one.

## Provenance and licensing

See [NOTICE.md](NOTICE.md). The upstream repository had no declared license at the extracted revision, so this package is private, local, and `UNLICENSED`.
