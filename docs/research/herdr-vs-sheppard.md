# Herdr versus Sheppard for Scotty

Research snapshot: 2026-07-23. The inspected revisions were Scotty
`d88287f8e42b2c19fca2087b9e9861c4a8cc4649`, the local Sheppard checkout
`2a7c6f835071088d8156189fa737a6b08d3ff8f0`, and the Herdr `v0.7.5` release
`ef4c23f5775bb8cfec05f05d0844226ff959a07a`.

## Recommendation

Do not replace Sheppard with Herdr to improve phone smoothness. There is no
source evidence or benchmark showing that the swap would reduce Scotty's
phone-side latency, and most of the rendering and input path would not change.
The browser would still use Scotty's authenticated Sandbox PTY WebSocket,
`ghostty-web`, touch-to-mouse translation, visual-viewport resizing, and mobile
composer ([PTY route](../../worker/src/index.ts#L291-L321),
[terminal page](../../worker/public/terminal.html#L688-L768),
[touch handling](../../worker/public/terminal.html#L1317-L1403)).

Herdr is the stronger general-purpose agent multiplexer. Its responsive
single-column UI and global agent switcher could improve navigation if one
Scotty Sandbox is intentionally expanded to contain several agents,
workspaces, tabs, or panes. Scotty v1 currently owns one managed Codex agent per
Sandbox, while cross-session navigation already lives on Scotty's sessions
page. In that product shape, Herdr adds capability and migration surface but
little phone value.

Keep Sheppard for v1. Reconsider Herdr as a separate, measured multi-agent
spike, after Herdr can satisfy Scotty's quiesced-checkpoint contract without
moving lifecycle authority out of the Sandbox Durable Object.

## Current Scotty architecture

Sheppard is not just decoration around the terminal:

1. Scotty resets a session-private Sheppard daemon, spawns the Codex command as
   the known managed tab `tab-1`, and uses `sheppard pause` / `resume` as
   lifecycle primitives ([agent runtime](../../worker/src/agent-runtime.ts#L3-L32)).
2. Every browser attachment gets an independent Cloudflare Sandbox execution
   session whose shell is `scotty-attach`. That script verifies `tab-1`, then
   starts a full Sheppard client ([attach script](../../worker/container/scotty-attach#L4-L24)).
3. Before backup, the Sandbox DO asks Sheppard to stop the managed process
   group, runs `sync`, creates the immutable backup, and resumes on success or
   rollback ([checkpoint](../../worker/src/session.ts#L809-L855)). This is a
   correctness boundary, not an optional UI feature.
4. The container pins a checked Sheppard Linux amd64 binary rather than
   downloading runtime code ([Dockerfile](../../worker/container/Dockerfile#L28-L36)).

The local Sheppard source implements pause and continue with `SIGSTOP` and
`SIGCONT` against the child process group
(`/Users/yesh/code/personal/sheppard/internal/ptyx/pty.go:220-239`). Its phone
UI switches below a narrow-width threshold to one equally divided thumb row:
`Switch`, `New`, `Talk`, and `Menu`
(`/Users/yesh/code/personal/sheppard/internal/client/tui_rails.go:10-45`;
`internal/client/tui_input.go:450-473`). `Talk` keeps dictated or pasted text
private for review before an explicit push
(`/Users/yesh/code/personal/sheppard/internal/client/composer_test.go:15-64`).
Scotty's outer web composer already provides a similar review-before-send
surface, so that particular feature need not depend on the inner multiplexer.

## Capability comparison

Sheppard fits Scotty's present contract closely: one predictable managed tab,
explicit process-group suspension, durable result/status semantics, a compact
phone rail, and a small command surface already adapted by Scotty. It also
supports multiple projects and tabs, but its main advantage here is that its
lifecycle operations match checkpointing exactly.

Sheppard's active tab and scroll offset are client-local, but its PTY geometry
isn't fully independent: the most recently active interactive client owns the
underlying tab size until ownership moves. Herdr's direct-attach contract is
stricter still: only one client can write to a terminal, and a second writer
must take over and disconnect the first.

Herdr `v0.7.5` is substantially broader. It has workspaces, tabs, tiled panes,
agent detection and status rollups, named agents, mouse navigation, a socket
API, persistent client/server sessions, and direct attachment to one
server-owned terminal ([release README](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/README.md#L25-L32),
[agent-start API](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/api/schema/agents.rs#L163-L174),
[direct attach](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/docs/next/website/src/content/docs/persistence-remote.mdx#L123-L151)).
Its Codex integration can report session identity and restore an agent
conversation after a Herdr server restart. That overlaps Scotty's resume
machinery, but must not become authoritative over Scotty's DO record and
backup handle.

Herdr has real phone-specific implementation, not just a claim in its README.
At 64 columns or fewer it replaces the desktop sidebar and tab bar with a
two-row status header, a full-width terminal, and a scrollable switcher that
lists agents, spaces, tabs, and actions
([threshold](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/config.rs#L38-L42),
[mobile layout](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/ui.rs#L322-L375),
[mobile switcher](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/ui/mobile.rs#L473-L590)).
That is better information architecture for scanning many agents. Sheppard's
single thumb row is simpler for controlling one agent.

The blocking gap is quiescence. Herdr's public API can start, prompt, read,
wait for, attach to, and close agents/panes, but the `v0.7.5` source and
generated API contain no public equivalent of Sheppard's process-group
`pause`/`resume`; its platform signal abstraction exposes hangup, terminate,
and kill, not `SIGSTOP`/`SIGCONT`
([Linux signals](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/platform/linux.rs#L317-L325)).
Stopping the Herdr server is not a substitute: Herdr documents that a full
server stop loses the original pane processes and reconstructs layout and,
where integrated, agent conversation state
([session restore](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/docs/next/website/src/content/docs/session-state.mdx#L20-L76)).

The released Herdr `v0.7.5` binary is AGPL-3.0-or-later with a commercial
license option, so a network-service deployment needs an explicit compliance
decision
([manifest](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/Cargo.toml#L1-L8),
[license](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/LICENSE)).
The unreleased `master` branch has since changed its manifest and license file
to Apache-2.0, but Scotty should not make a production licensing decision from
unreleased source.

## Phone UI and smoothness impact

Replacing the full Sheppard client with the full Herdr client would visibly
change the inner TUI. Herdr would add a compact agent-status header and a much
richer switcher; it would also consume two terminal rows and expose concepts
that a one-agent Scotty session does not currently need. Direct terminal attach
would avoid that chrome, but would also remove the mobile switcher and most of
the reason to adopt Herdr.

The swap alone would not change Scotty's browser transport, WebSocket hop,
Ghostty WASM renderer, mobile keyboard controls, touch gestures, or viewport
settling. Herdr does coalesce dirty render notifications in its pane runtime,
which is a sensible implementation detail
([render notification](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/pane.rs#L1783-L1803)),
but that is not comparative performance evidence. A richer Herdr screen could
send either fewer coalesced updates or more changed cells than Sheppard. The
net result over Scotty's nested terminal path is unknown.

The only defensible smoothness decision is an A/B measurement on the same
iPhone, browser, network, Sandbox image, Codex workload, terminal dimensions,
and Ghostty bundle. Measure key-to-echo and output-to-paint latency, resize and
keyboard-open stalls, dropped or reordered input, reconnect time, bytes sent,
container CPU, and container memory. No current source establishes a winner.

## Migration risks and a safe spike

The first risk is backup consistency: externally scraping a Herdr child PID
and signaling it would couple Scotty to private process topology and could
miss descendants. The spike needs either an upstream public suspend/resume
operation with process-group semantics or a small Scotty-owned process
supervisor whose group ownership is explicit and independently contract-tested.

The second risk is state and credential isolation. Herdr owns config, logs, and
session metadata outside Scotty's authoritative DO. Pane screen-history
persistence must remain disabled because Herdr itself warns that saved terminal
contents can include secrets, tokens, prompts, and command output
([history warning](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/docs/next/website/src/content/docs/session-state.mdx#L26-L38)).
All Herdr paths and logs would need the same sentinel and backup scans as the
current container.

The third risk is contract churn: creation becomes server startup plus
workspace/pane discovery plus agent start; attachment must choose full UI
versus direct terminal; restore must recreate Herdr without letting its saved
state override the DO; and concurrent browser clients need explicit input and
resize ownership tests. Herdr documents only one writable owner for direct
terminal attach, with takeover required for another client, which differs from
Scotty's current allowance for several terminal attachment leases.

A useful spike should therefore stay outside production code and prove, in
order: pinned Linux-amd64 packaging; deterministic server/workspace/agent
creation; public or Scotty-owned whole-process-group quiescence; backup and
Codex resume after forced container loss; two phone clients and takeover
behavior; credential/log scans; then the A/B mobile measurements above. Adopt
Herdr only if the product is moving to multiple agents per Sandbox and those
proofs show a material phone improvement. Otherwise, spend the effort directly
on Scotty's existing terminal page and Sheppard mobile rail, where the actual
phone path is already under Scotty's control.
