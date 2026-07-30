# Lightweight single-session Pi web UI slices

Research date: 2026-07-30

Source snapshots:

- Scotty: `b9165511a85c77427fc7c9230ab3e56846d3e89a`
- Pican: `d12fbfa7e653b6a9dd725673e67db82f9a3629c6`
- local Pi reference: `027a5847901b5dde30270abaa1041046cd2b4b55`
  (`0.82.1`)
- target Pi package: `@earendil-works/pi-coding-agent@0.83.0`, npm
  `gitHead` `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- t3code: `50871eb5de641ffd41b1f9d0151668982d276393`

## Decision

Replace Ghostty Web with a purpose-built UI for the one Pi session running in
the selected Scotty sandbox.

Do not put Pican back in the image. Do not build a provider-neutral agent
server. Do not persist a second copy of the conversation in the Sandbox
Durable Object.

Run exactly one Pi process in its supported headless mode:

```text
mobile or desktop browser
  -> authenticated Scotty HTTP + SSE
  -> Sandbox DO lifecycle/auth boundary
  -> loopback-only, zero-dependency supervisor
  -> one pi --mode rpc process
  -> the existing Pi session, extensions, tools, queue, and session file
```

The supervisor should use Node's built-in `http` and `child_process` modules.
Node is already in the container because Pi runs on it. It needs no framework,
database, WebSocket package, runtime catalog, scheduler, or peer layer.

Pi's session file remains authoritative for messages and continuation. Pi's
in-memory session remains authoritative for the current turn and prompt queues.
The Sandbox Durable Object remains authoritative for Scotty lifecycle,
credentials, and runtime ownership. The supervisor is only a volatile
transport/projection adapter.

## Why Pi RPC is the seam

Pi RPC exists specifically for embedding Pi in another UI. It accepts JSONL
commands on stdin and emits correlated responses plus every
`AgentSessionEvent` on stdout
([RPC mode](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-mode.ts),
[protocol types](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-types.ts)).

The existing protocol already has:

- prompt, steer, follow-up, abort, and queue-mode commands;
- `get_state`, `get_messages`, `get_entries`, and session statistics;
- message, thinking, tool-call, tool-result, compaction, retry, and queue
  lifecycle events;
- stable request IDs and tool-call IDs;
- extension UI requests for select, confirm, input, editor, notify, status,
  string widgets, and editor text.

Scotty currently launches interactive Pi through a PTY. The browser receives
rendered terminal bytes rather than agent events
([`scotty-pi-shell`](../../worker/container/scotty-pi-shell),
[`terminal.js`](../../worker/public/terminal.js),
[`/s/:id/terminal`](../../worker/src/index.ts)).
This is why the current mobile surface has to emulate terminal input and cannot
render the transcript or tools as native web UI.

Cloudflare Sandbox background processes expose lifecycle and output logs but no
writable stdin
([Sandbox `Process`](../../node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts)).
The small supervisor is therefore necessary: it owns Pi's stdin/stdout pipes,
then exposes a loopback HTTP command endpoint and an SSE event endpoint.
Scotty can reach it with the Sandbox SDK's `containerFetch`; the browser cannot
reach the loopback port directly.

On first launch, the supervisor starts `pi --mode rpc`, consumes the existing
initial-prompt file, and sends that prompt through RPC. On resume it starts
`pi --mode rpc --continue`. It must never run an interactive Pi process and an
RPC Pi process against the same session.

## What to reuse from Pican and t3code

Pican is useful as a rendering reference, not as runtime code. Its transcript
model keeps stable message and tool-call indexes, reconciles full snapshots
with live deltas, separates assistant content from tool rows, and specializes
workflow/subagent tool cards
([session data](../../../pican/web/src/session/data/session-data.svelte.ts),
[`SessionEntry`](../../../pican/web/src/components/session/SessionEntry.svelte),
[`ToolCall`](../../../pican/web/src/components/session/ToolCall.svelte)).
Its HTTP commands plus SSE events are also a better fit for this small surface
than introducing another WebSocket server
([live events](../../../pican/web/src/session/live/live-events.ts)).

t3code reinforces three correctness rules without providing code Scotty should
copy:

1. render chat messages separately from evolving activity/tool rows;
2. correlate tool updates by stable tool-call ID;
3. establish a sequenced snapshot plus live tail without a reconnect gap
   ([architecture](https://github.com/pingdotgg/t3code/blob/50871eb5de641ffd41b1f9d0151668982d276393/docs/architecture/overview.md),
   [thread subscription](https://github.com/pingdotgg/t3code/blob/50871eb5de641ffd41b1f9d0151668982d276393/apps/server/src/ws.ts#L1245-L1351)).

Do not copy t3code's provider adapters, generic event union, event-store/reactor
stack, environment supervisor, offline cache, Electron/mobile layers, or
multi-thread orchestration. Scotty has one known runtime and one selected
session.

## Selected UI direction

The chosen direction is the focused work log:

- one full-width chronological transcript for user messages, Pi text,
  reasoning, and every tool call;
- completed tools collapse to a compact status row keyed by tool-call ID;
- an expanded edit shows file path, insertion/deletion totals, unified hunks,
  old/new line numbers, and horizontally scrollable code on narrow screens;
- running commands show a bounded live tail, while failures keep their exit
  state and error output in place;
- task lists, subagent transcripts, and workflow progress live behind the
  session `…` drawer instead of permanently narrowing the transcript;
- AskUser remains inline because Pi cannot continue until it receives a
  response.

The composer is one responsive component, not separate desktop and mobile
implementations. Desktop uses Enter to send and Shift+Enter for a newline.
Touch layouts use a 16px textarea, 44px minimum controls, explicit Send, compact
Queue, safe-area padding, and newline-first keyboard behavior. The production
implementation still needs real-browser proof for autosizing, IME composition,
virtual-keyboard movement, draft retention, and scroll anchoring before it can
be called as smooth as the reference UI.

The supervisor can keep a bounded in-memory event ring with
`{epoch, sequence}` cursors. On startup it hydrates a compact projection from
Pi `get_messages`. On browser attach it registers the subscriber, captures one
projection/sequence snapshot, sends that snapshot, then sends later events.
If the supervisor epoch changed, the browser discards its cursor and accepts a
fresh snapshot. Nothing needs to be duplicated into Durable Object storage.

## Existing Pi feature compatibility

Scotty already installs Pi tasks, subagents, workflows, background terminals,
AskUser, web access, compaction, and Amp UI packages
([`PI_PACKAGES`](../../worker/src/container-auth.ts)).
RPC mode loads the same extensions and streams their ordinary tool calls and
results through the main session.

The lightweight compatibility target is:

- Pi's `queue_update`, `steer`, and `follow_up` are the queue. Do not add a
  second queue service.
- Subagent spawn/wait/check/cancel/list calls render as inline tool activities.
  The existing non-TUI `/subagents` fallback uses RPC select/input/confirm/editor
  dialogs and can show the child transcript tail
  ([subagent fallback](../../worker/container/pi-packages/sources/pi-subagents/extensions/subagents/index.ts)).
- Workflow calls render inline. The existing non-TUI `/workflows` fallback uses
  RPC select and notify dialogs
  ([workflow fallback](../../worker/container/pi-packages/sources/pi-workflows/extensions/workflows/index.ts)).
- AskUser is a first-class inline blocking interaction. Its non-TUI path already
  degrades the extension's richer terminal component into ordered RPC
  `select`/`input` requests. The client must return one
  `extension_ui_response` with the same request ID, then keep the resolved tool
  result in the transcript. Preserve the extension's question context, option
  descriptions, custom answers, optional skips, multi-select commits, and
  completed/dismissed/cancelled/no-UI distinction
  ([AskUser contract](../../worker/container/pi-packages/sources/pi-askuser/README.md),
  [RPC fallback](../../worker/container/pi-packages/sources/pi-askuser/index.ts)).
- The current task widget passes a TUI component factory to `setWidget`.
  RPC intentionally ignores component factories. Make the smallest package
  change to emit string lines in non-TUI mode, or initially show task tool
  calls without a persistent widget
  ([task widget](../../worker/container/pi-packages/sources/pi-tasks/src/ui/task-widget.ts)).
- Amp chrome and folding are terminal presentation only. Reproduce none of it;
  render the same underlying Pi messages and events with simple web components.

This supports the existing Pi features without moving their execution or state
ownership into Scotty.

## Delivery slices

### Slice 1: one Pi 0.83 RPC process

Pin the container to Pi `0.83.0`. Add the zero-dependency loopback supervisor
and a named Sandbox process. It starts exactly one Pi child, owns JSONL
framing/correlation, exposes health, command, snapshot, and SSE endpoints, and
keeps a bounded `{epoch, sequence}` replay ring.

Keep Ghostty as a temporary fallback during this slice only. The acceptance
proof is:

1. `pi --version` is exactly `0.83.0`;
2. all installed Pi packages load without `extension_error` after the TypeBox
   dependency upgrade in `0.83.0`;
3. fresh creation consumes the initial prompt once;
4. restart with `--continue` returns the same Pi session ID and messages;
5. supervisor or Pi exit makes readiness fail closed.

### Slice 2: read-only transcript and tool stream

Add one authenticated same-origin Scotty route that proxies the supervisor's
snapshot/SSE stream. Replace the `/s/:id` body with a minimal transcript:
user/assistant messages, visible thinking, one evolving collapsible row per
tool-call ID, edit hunks with insertion/deletion totals, bounded command output,
errors, connection state, and auto-scroll that does not fight the reader.

The browser holds only a projection. On refresh or epoch mismatch it takes a
fresh Pi snapshot. On an ordinary reconnect it resumes after the last
sequence. The acceptance proof disconnects during a streaming tool call,
reconnects, and shows one complete tool row with no lost or duplicated text.

### Slice 3: composer, queue, steer, and stop

Add a native textarea and four allowed commands:

- Send while idle -> `prompt`
- Queue after the current run -> `follow_up`
- Steer after the current assistant/tool step -> `steer`
- Stop -> `abort`

When Pi is idle, the composer has one Send action. While Pi is active, the
secondary control becomes a two-choice delivery menu: **Steer after this step**
or **Queue after this turn**. The primary submit button adopts the selected
verb, so the user never has to infer whether Send means steer or queue.

An accepted steer gets a short `Steering next` receipt above the composer until
Pi consumes it, then appears in the transcript as an ordinary user turn marked
`Steered`. Follow-ups render as an ordered queue above the composer with
remove controls; when consumed they become ordinary user turns marked
`From queue`. The UI derives both pending lists from Pi `queue_update`, not
optimistic browser state alone.

Render `queue_update` and disable impossible actions from Pi `get_state`.
Every browser command gets a Scotty command ID and a correlated Pi response;
retries must not accidentally submit the same user message twice. This slice
is the point where the web UI can replace normal terminal use on a phone.

The composer autosizes to a bounded height, preserves an unsent draft across
reconnects, never sends during IME composition, and keeps the latest transcript
position stable while it grows. Desktop Enter sends and Shift+Enter inserts a
newline; touch layouts use explicit Send and let Enter insert a newline. Mobile
controls are at least 44px and respect the bottom safe area and visual keyboard.
Acceptance covers a narrow iPhone viewport, a desktop fine-pointer viewport,
paste, multiline input, attachment selection, queue acknowledgement, failed
send retry, reconnect, and opening/closing the keyboard without losing the
composer or jumping the transcript.

### Slice 4: AskUser, extension dialogs, and hidden activity

Render RPC select, confirm, input, editor, notify, status, string-widget, and
editor-text requests. Treat each blocking request ID as single-use: reconnect
can re-render an unanswered request, but the first accepted response closes it
and later responses are rejected.

Render `ask_user` inline in the transcript because Pi is blocked on it. Use the
tool arguments for the rich card and the matching RPC `select`/`input` request
as the response boundary. When the tool result arrives, replace the pending
state with its structured answer receipt; never infer intent from dismissed,
cancelled, timed-out, or no-UI results.

Keep ordinary tool calls inline, including the row that spawned a task,
subagent, or workflow. Put the secondary task list, child transcripts, and
workflow progress behind the session `…` menu so the preferred full-width
work-log layout remains focused on narrow and wide screens. Keep unknown tools
in a generic JSON/text card so new Pi packages still work.

Use the existing headless subagent/workflow dialogs for inspection and
takeover. Add the non-TUI string task widget adaptation if persistent task
status is still needed. The overflow drawer is scoped to the one Pi session;
do not add global workflow, task, or subagent dashboards.

The acceptance proof runs one queued follow-up; AskUser single-select,
multi-select, custom-answer, skip, dismiss, cancel, and reconnect cases; one
subagent with transcript inspection; and one workflow, all within the same Pi
session.

### Slice 5: lifecycle cutover and Ghostty removal

Make create, resume, snapshot, sleep, hard-cap, and vaporize own the named
supervisor and its Pi child. Snapshot must stop the supervisor and all Pi child
processes before `sync`; resume must restore the same session with
`--continue`. Generalize the current terminal-access gate into
single-session-interaction access while preserving cookie, same-origin,
credential sentinel, and warm-session rules.

After mobile and lifecycle parity passes, remove the PTY route, Ghostty JS/WASM,
terminal input helpers/styles, and the Ghostty dependency. The final sandbox
contains Pi, its existing extensions, and the small supervisor—no Pican and no
browser terminal runtime.

## Explicit non-goals

- No Pican binary, Go server, SQLite, watchers, scheduler, peers, or catalog.
- No t3code multi-provider/event-store architecture.
- No second Pi process and no terminal/RPC dual attachment.
- No duplicated durable transcript or queue in KV, R2, or the Sandbox DO.
- No global task, workflow, subagent, repository, or fleet UI inside the
  selected session page.
