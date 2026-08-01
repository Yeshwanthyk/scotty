# Standalone `pi-scotty` fleet TUI

Research date: 2026-08-01

Source snapshots:

- Scotty: `f9ea3d087114ed766adc51c9bfb2c08585794bb4`
- published Pi `0.83.0`: tag `v0.83.0`, commit
  `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- latest local Pi reference:
  `4488ad55c18f07ae89a489096c90de8667b3adfb`

No production calls, deployments, real-session operations, or live Scotty mutations
were used for this research.

## Decision

Build `pi-scotty` as a **standalone Scotty binary with a Scotty-owned remote
projection model**, rendered with the **published
`@earendil-works/pi-tui@0.83.0`** package.

Do not run it as Pi's `InteractiveMode`. Do not create a local `AgentSession`. Do
not load sandbox extensions on the host. Do not use Pi's post-release client,
protocol, or composable-server APIs. The client/protocol packages and newer
server implementation are outside the published `v0.83.0` contract.

```text
pi-scotty executable
  ├── paired Scotty client credential
  ├── fleet inventory + per-session local view cache
  ├── Scotty HTTP/SSE transport
  ├── snapshot/event reducer owned by Scotty
  └── published @earendil-works/pi-tui@0.83.0 renderer
          │
          ▼
Scotty Worker
  └── session Sandbox DO
        └── private supervisor HTTP bridge
              └── one pi 0.83.0 --mode rpc process
                    ├── AgentSession owner
                    ├── transcript/tool owner
                    └── extension owner
```

The TUI is a projection and command client. Pi inside each sandbox remains the
agent, transcript, tool, queue, and extension owner. The Sandbox DO remains the
session lifecycle and credential owner.

## Why this is the right seam

Scotty already has the required anti-corruption boundary:

- the sandbox supervisor starts one `pi --mode rpc` process and owns its JSONL
  stdin/stdout ([supervisor](../../worker/container/scotty-pi-session.mjs#L52-L68));
- a full snapshot comes from Pi `get_state`, `get_messages`, model, and thinking
  RPC calls ([snapshot](../../worker/container/scotty-pi-session.mjs#L201-L233));
- live Pi events are wrapped in `{epoch, sequence}` and retained in a bounded
  replay ring ([event ring](../../worker/container/scotty-pi-session.mjs#L84-L92));
- the Worker proxies snapshot, event, and command traffic without forwarding the
  browser cookie, root bearer, or internal transport token
  ([public proxy](../../worker/src/index.ts#L585-L621),
  [private capability injection](../../worker/src/session.ts#L1392-L1428));
- commands are restricted to prompt, steer, follow-up, abort, extension UI
  responses, model, and thinking controls
  ([allowlist](../../worker/container/scotty-pi-session.mjs#L21-L35)).

The existing browser worklog is already a proof that this seam can support a
remote UI. It hydrates from snapshot, applies monotonic SSE events, re-snapshots
on epoch/replay gaps, keeps per-session caches, and switches views without Pi's
session-file switching API
([projection](../../worker/public/terminal.js#L69-L232),
[event reducer](../../worker/public/terminal.js#L341-L405),
[switching](../../worker/public/terminal.js#L1436-L1475)).

## Why Pi's own interactive TUI cannot be reused wholesale

Pi's `InteractiveMode` is both controller and renderer. It directly owns a local
`AgentSessionRuntime`, `AgentSession`, `SessionManager`, `ExtensionRunner`, model
runtime, settings, editor, transcript components, and extension UI binding. It
is not parameterized over a remote-session interface
([latest interactive mode](https://github.com/badlogic/pi-mono/blob/4488ad55c18f07ae89a489096c90de8667b3adfb/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L348-L390)).

Using it would either:

1. create a second local agent/session owner;
2. require extensive remote tool/session overrides; or
3. make `ctx.switchSession()` operate on local Pi JSONL files.

All three violate the required ownership model.

The reusable part is `@earendil-works/pi-tui`: terminal lifecycle, components,
focus, overlays, editor, lists, Markdown, and differential rendering. The
published `0.83.0` export surface contains `TUI`, `ProcessTerminal`, `Editor`,
`SelectList`, `Markdown`, `Container`, and related primitives
([published exports](https://github.com/badlogic/pi-mono/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/tui/src/index.ts#L1-L114)).
The npm package is MIT licensed, requires Node 22.19+, and resolves to the same
release commit.

## Do not use the latest remote Pi stack

The local reference checkout is useful design evidence, not an approved
runtime dependency:

- `packages/protocol` was added after `v0.83.0` at `56eb685b`;
- `packages/client` was added after `v0.83.0` at `33bc0a7b`;
- `packages/server` existed at `v0.83.0`, but its newer composable protocol
  implementation followed at `2e60d3cb`;
- coding-agent remote coordination followed at `a3ec51d2`;
- neither `@earendil-works/pi-client@0.83.0` nor
  `@earendil-works/pi-protocol@0.83.0` exists in npm.

The new `RemoteSession` is also not a substitute for `AgentSession` or
`InteractiveMode`. It provides normalized remote transcript/control state but
omits extension UI, extension events, custom renderers, session-tree behavior,
and most of the existing RPC command surface
([latest remote session](https://github.com/badlogic/pi-mono/blob/4488ad55c18f07ae89a489096c90de8667b3adfb/packages/coding-agent/src/client/remote-session.ts),
[latest transcript reducer](https://github.com/badlogic/pi-mono/blob/4488ad55c18f07ae89a489096c90de8667b3adfb/packages/coding-agent/src/client/transcript.ts)).

Scotty already owns the narrower protocol it needs. Replacing it with the new Pi
stack would add version skew and a provider-neutral session/lease model without
solving extension UI fidelity.

## State ownership

| State                                                                   | Authority                   | TUI behavior                                          |
| ----------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| Session lifecycle, execution binding, operation lease, backups, failure | Sandbox DO `SessionStore`   | Read only; never infer lifecycle from SSE             |
| Fleet list                                                              | KV `session:*` projection   | Discovery only; display projection freshness          |
| Real GitHub/provider credentials                                        | Sandbox DO credential vault | Never present in `pi-scotty`                          |
| Pi transcript and tool state                                            | Sandbox Pi `AgentSession`   | Hydrate from supervisor snapshot                      |
| Prompt queues                                                           | Sandbox Pi `AgentSession`   | Render from snapshot/events; never add a second queue |
| Extension execution/state                                               | Sandbox Pi extension runner | Render serializable outputs/fallbacks only            |
| SSE replay ring and command receipts                                    | Sandbox supervisor memory   | Treat as volatile and epoch-scoped                    |
| Selected session, draft, scroll, filters                                | Local `pi-scotty` process   | Cache by Scotty session ID only                       |

The DO session record is authoritative for one session
([record schema](../../worker/src/contracts.ts#L104-L134),
[transactional store](../../worker/src/session-store.ts#L22-L136)). KV is a
non-secret list projection
([projection](../../worker/src/session-projection.ts#L52-L107)). Therefore the
fleet screen may use `/api/sessions` for discovery.

`GET /api/sessions/:id` reads the DO, but currently returns a
`SessionProjection`; it omits the record's active lifecycle operation/lease
([projection conversion](../../worker/src/contracts.ts#L611-L631)). Status alone
is not enough to enable controls safely. Before controls ship, add a versioned,
non-secret selected-session view containing an operation/control revision and
have every command revalidate that revision server-side.

## Required protocol shape

Keep the public surface Scotty-owned and version it independently from Pi.
Decode every HTTP/SSE payload as untrusted data.

### Fleet inventory

`GET /api/sessions` remains the discovery source and includes title, repository,
branch, lifecycle, projected agent state, last agent event, and projection time.
The TUI must visually distinguish stale/unknown activity.

For authoritative selected-session lifecycle metadata, use:

```text
GET /api/sessions/:id
```

This reads the session DO, not KV
([route](../../worker/src/index.ts#L495-L499)), but its current response omits the
DO operation lease. Treat it as authoritative only for the fields it exposes;
add the control revision described above before enabling mutations.

### Passive live snapshot

Retain the current route shape:

```text
GET /s/:id/rpc/snapshot
```

but define a concrete versioned snapshot rather than relying on the browser's
current permissive shape probing:

```ts
interface PiSessionSnapshotV1 {
  version: 1;
  epoch: string;
  baseSequence: number;
  sequence: number;
  state: PiSessionState;
  messages: readonly unknown[];
  overlapEvents: readonly PiEventEnvelope[];
  activeTools: readonly ActiveToolProjection[];
  queue: PiQueueProjection;
  pendingUi: readonly ExtensionUiRequest[];
  extensionSurface: {
    statuses: Readonly<Record<string, string>>;
    widgets: readonly StringWidgetProjection[];
    title?: string;
  };
  capabilities: {
    models: readonly ModelProjection[];
    thinkingLevels: readonly string[];
    commands: readonly CommandProjection[];
  };
}
```

Snapshot is the base authority for the live projection. Snapshot collection is
not atomic today: events can arrive while Pi answers `get_messages`. Preserve
`baseSequence` plus the bounded overlap events through the ending `sequence`
(the current supervisor already collects them), hydrate messages/state, then
apply those overlap events before opening SSE after `sequence`. The supervisor
must verify that overlap events are contiguous from `baseSequence + 1` through
`sequence`; its 2,000-event ring can otherwise truncate a busy snapshot without
a gap signal. Reject/retry a non-contiguous snapshot instead of returning it. An
atomic future snapshot could replace this overlap contract. SSE remains only a
replayable tail.

### Live events

```text
GET /s/:id/rpc/events?epoch=<snapshot.epoch>&since=<snapshot.sequence>
```

Rules:

1. reject/retry unless overlap events form the complete contiguous range from
   `baseSequence + 1` through `sequence`;
2. hydrate snapshot state, then apply its overlap events in sequence order;
3. apply only a matching epoch and strictly increasing sequence;
4. ignore duplicate sequence numbers;
5. fetch a fresh snapshot on `scotty_epoch_changed` or `scotty_replay_gap`;
6. never reconstruct authority from an event-only connection;
7. keep UI request identity as `(scottySessionId, requestId)`.

The current supervisor already emits epoch/gap signals
([replay](../../worker/container/scotty-pi-session.mjs#L313-L351)).

### Commands

```text
POST /s/:id/rpc/command
{
  "commandId": "host-generated UUID",
  "command": { ...allowed intent... }
}
```

Keep the existing allowlist. Do not expose Pi `switch_session`, `new_session`,
`fork`, arbitrary `bash`, direct tool execution, or container transport.

A command receipt is only reliable inside one supervisor epoch because the
current receipt cache is memory-only
([receipts](../../worker/container/scotty-pi-session.mjs#L46-L50),
[deduplication](../../worker/container/scotty-pi-session.mjs#L258-L293)). The
TUI must not automatically retry a mutation after an epoch change or ambiguous
network failure. Re-snapshot, show "outcome unknown," and let the operator make
the next explicit decision.

## Safety prerequisites before the TUI is safe

### 1. Make read access genuinely passive

Current snapshot/event access calls `preparePiSessionAccess()`, which calls
`ensurePiSession()`. `ensurePiSession()` may refresh auth files, write a
transport token, and start the named supervisor when it is absent
([access preparation](../../worker/src/session.ts#L306-L326),
[ensure implementation](../../worker/src/container-auth.ts#L203-L242)).

That means viewing a warm session can currently start a Pi process. It does not
resume a sleeping lifecycle record, but it still violates the stricter rule
that viewing/switching must not mutate the remote process.

`containerFetch()` itself can auto-start an unhealthy/stopped container, track
in-flight requests, and renew `sleepAfter`. The passive console therefore bypasses
both Sandbox and Container `containerFetch()` and uses one direct
`ctx.container.getTcpPort(PI_SESSION_PORT).fetch()` attempt from the authoritative
Sandbox Durable Object. The optional `ctx.container.running` check is advisory and
only fails fast; there is no process lookup, retry, fallback, or start path. A stop
race or absent/not-listening supervisor returns typed
`provider_passive_relay_unavailable`.

The Durable Object derives the loopback transport token from its credential vault,
forwards only bounded allowlisted request headers, and strips the token from the
response. Raw SSE may terminate at the normal `sleepAfter`; neither reads nor
commands renew activity. This is implemented as a best-effort native no-start,
no-renew relay, but staging still must prove those properties against the deployed
Cloudflare runtime before production proof is claimed.

Then split the contract:

- **passive read gate**: require authoritative `warm`, Cloudflare provider, no
  lifecycle operation, and a successful single raw request to the already-running
  supervisor; otherwise return an unavailable/conflict response without starting
  or keeping alive anything;
- **lifecycle start gate**: only create/resume/recovery paths may seed or start
  Pi;
- snapshot, events, activity reads, and session switching use only the proven
  passive transport.

Commands should also fail closed if the supposedly warm Pi process is absent.
A control request must not silently become process recovery.

### 2. Make snapshot cover the whole volatile projection

The current snapshot includes Pi state, messages, model/thinking capabilities,
pending blocking UI, and only events that overlap snapshot collection
([snapshot](../../worker/container/scotty-pi-session.mjs#L201-L233)). It does
not authoritatively include:

- active tool update state;
- queued steer/follow-up contents;
- extension status values;
- string widget values;
- extension title;
- task/subagent/workflow activity derived from those surfaces.

The browser reducer currently probes some queue/activity aliases and pending UI,
but not the proposed `activeTools` or nested `extensionSurface` shape
([browser hydration](../../worker/public/terminal.js#L173-L232)). The supervisor
also does not provide a complete reduced surface. A client that attaches after
the original event can therefore miss current volatile UI state.

Add a small in-memory supervisor reducer for these fields and include its full
state in every snapshot. Preserve the overlap-event contract above. Do not
persist it in the DO, KV, or R2. Pi messages and session files remain transcript
authority.

`pendingUi` also needs a cancellation contract. Pi 0.83 removes timed-out or
signal-aborted dialogs internally without emitting a cancellation event, while
the supervisor currently removes them only after a host response or quiesce.
Mirror explicit timeouts, clear requests on settled/abort/epoch boundaries, and
treat an unacknowledged response as stale. Signal-driven cancellation still has
no exact wire representation in 0.83; either constrain bundled headless dialogs
to observable lifetimes or add a Scotty-owned cancellation signal without
changing Pi's published package. This must be resolved before claiming pending
UI is authoritative.

## Fleet activity

`SessionProjectionSchema` already carries `agentState` and
`lastAgentEventAt`, but `SessionStore.updateAgentActivity()` currently has no
production caller
([schema](../../worker/src/contracts.ts#L165-L194),
[unused update](../../worker/src/session-store.ts#L311-L334)). Fleet activity is
therefore stale lifecycle metadata today.

Recommended progression:

1. show lifecycle plus explicitly stale/unknown projected activity from
   `/api/sessions`;
2. add a passive, lightweight activity snapshot for already-running warm
   sessions;
3. refresh warm rows with bounded concurrency and no process start;
4. open the full transcript SSE only for the selected session.

Do not open every full transcript stream merely to animate the fleet list. Do
not add a second durable activity store. If the list projection is updated from
passive observations, keep `projectedAt`/`lastAgentEventAt` visible so freshness
is explicit.

A useful derived activity state is:

- `working`: Pi is streaming and has no blocking UI;
- `waiting`: Pi has a pending blocking extension request;
- `completed`: Pi is settled with no queued turn;
- `tool-stalled`: an active tool exceeds the documented stall threshold;
- `unknown`: no fresh passive observation exists.

The reducer must derive this from snapshot/event facts, not optimistic TUI
commands.

## Extension compatibility

"Support all Scotty extensions" must mean:

1. every extension continues to execute inside the sandbox;
2. every tool call/result has a generic host rendering;
3. every serializable RPC UI request is supported;
4. TUI-only extension presentation has an explicit headless fallback.

It cannot mean transporting arbitrary `ctx.ui.custom()` component code. Pi RPC
intentionally cannot serialize custom components, headers, footers, editors,
autocomplete providers, themes, raw terminal interception, or custom
message/tool renderers
([RPC UI adapter](https://github.com/badlogic/pi-mono/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L135-L309),
[RPC UI request union](https://github.com/badlogic/pi-mono/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/modes/rpc/rpc-types.ts#L238-L273)).

Loading the same extensions on the host is not a solution. It would execute
sandbox extension code with host filesystem/process access, duplicate extension
state, and still lack the sandbox's real `AgentSession`.

### Current bundled extensions

| Extension            | Remote functional behavior                                                    | TUI-specific degradation                                                                               |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AskUser              | Uses ordered RPC `select`/`input` fallback and remains blocking               | Rich batched custom component becomes standard dialogs                                                 |
| Subagents            | Tools remain sandbox-owned; `/subagents` has select/input headless flow       | Native takeover dashboard becomes dialogs/text                                                         |
| Workflows            | Tool execution remains sandbox-owned; `/workflows` has select/notify fallback | Native dashboard becomes dialogs/text                                                                  |
| Background terminals | Tools remain sandbox-owned; `/ps` emits text notification outside TUI         | Native picker/detail and current component-factory activity widget are unavailable                     |
| Tasks                | Task tools/results remain available                                           | Current widget uses a component factory and is ignored by RPC                                          |
| Web access           | Tools/results and string activity widgets are portable                        | Sandbox-local browser curator URLs are unreachable from the host                                       |
| Codex compaction     | Tool behavior/results are generic RPC events                                  | No required custom host UI                                                                             |
| Amp UI               | Underlying Pi events/messages remain available                                | Chrome, folding, theme, custom editor/footer/header are TUI-only and intentionally skipped in RPC mode |

Evidence:

- AskUser documents standard dialogs as its canonical non-TUI degradation path
  ([fallback](../../worker/container/pi-packages/sources/pi-askuser/index.ts#L360-L364));
- background terminals explicitly notify with a text list outside TUI, but its
  running-count widget is also a component factory ignored by RPC
  ([fallback](../../worker/container/pi-packages/sources/pi-background-terminals/extensions/background-terminals/index.ts#L421-L444),
  [widget](../../worker/container/pi-packages/sources/pi-background-terminals/extensions/background-terminals/index.ts#L84-L111));
- subagents runs a headless dialog outside TUI
  ([fallback](../../worker/container/pi-packages/sources/pi-subagents/extensions/subagents/index.ts#L1188-L1221));
- workflows uses text/select/notify outside TUI
  ([fallback](../../worker/container/pi-packages/sources/pi-workflows/extensions/workflows/index.ts#L319-L366));
- the task widget currently registers a component factory
  ([widget](../../worker/container/pi-packages/sources/pi-tasks/src/ui/task-widget.ts#L330-L341));
- Amp installs its chrome only when `ctx.mode === "tui"`
  ([guard](../../worker/container/pi-packages/sources/pi-amp-ui/index.ts#L218-L233)).

Before claiming complete bundled-extension support, adapt both task and
background-terminal packages to emit string widget lines in non-TUI mode and add
a compatibility test requiring a headless fallback for every bundled use of
`ctx.ui.custom()` or component factory UI.

The web curator currently publishes sandbox-local URLs. Force remote fleet use
to `workflow: "none"` or `"auto-summary"` until Scotty has a separately secured,
same-origin curator proxy; never expose loopback/sandbox coordinates to the
host.

Unknown future tools/messages must render as bounded generic text/JSON cards.
Extension-specific host renderers are optional enhancements, never a condition
for preserving tool execution.

## Authentication

Do not read or use Scotty's root bearer in `pi-scotty`. Worklog routes
intentionally require a registered client cookie and reject root-query/browser
shortcuts
([client-cookie requirement](../../worker/src/auth.ts#L83-L98),
[root-query rejection](../../worker/src/index.ts#L887-L895)).

Use the existing device-pairing authority:

1. the owner creates a one-use pairing link from the trusted Devices UI;
2. the operator pastes the pairing credential into `pi-scotty`;
3. `pi-scotty` consumes it through `POST /api/auth/pairings/consume` with exact
   origin, same-origin fetch metadata, and JSON content type;
4. store only the issued standard client credential in a host-specific,
   mode-`0600` file (or OS keychain later);
5. send it only as `Cookie: __Host-scotty=...` to that exact normalized origin;
6. redact it from errors, diagnostics, process arguments, URLs, and logs.

Paired clients receive only `sessions:read` and `sessions:write`, not owner
access scopes
([standard scopes](../../worker/src/auth-registry.ts#L14-L21),
[pairing consumption](../../worker/src/auth-registry.ts#L462-L503)). Cookie
mutations retain existing origin/fetch-metadata checks
([mutation security](../../worker/src/index.ts#L845-L873)).

Never expose or store:

- root bearer;
- GitHub/provider credentials;
- sentinel values;
- `x-scotty-pi-session`;
- direct sandbox/loopback coordinates.

Pi can print container-visible credential sentinels through tools/messages.
Redact known sentinel values at the supervisor projection boundary before any
snapshot/event serialization, then test that they cannot enter TUI state,
requests, logs, or diagnostics.

## Independent packaging

Ship `pi-scotty` from the Scotty repository as a second compiled Bun entrypoint,
or as `scotty tui` plus a `pi-scotty` binary alias. It should reuse Scotty's
config/error/redaction primitives but have its own paired-client credential
store and streaming transport.

Pin exactly:

```json
"@earendil-works/pi-tui": "0.83.0",
"@earendil-works/pi-coding-agent": "0.83.0"
```

Bundle both into the executable. Coding-agent imports are restricted to its
released UI components and theme helpers: message/tool presentation and safe
extension selectors. Do not instantiate or import Pi runtime ownership surfaces
such as `InteractiveMode`, `AgentSession`, `AgentSessionRuntime`,
`SessionManager`, SDK tool/session factories, or RPC clients. Continue to forbid:

- `@earendil-works/pi-client`;
- `@earendil-works/pi-protocol`;
- `@earendil-works/pi-server`;
- coding-agent deep imports into local tools, sessions, runtime, or config.

Tool calls use Scotty-owned presentation-only `pi-tui` text and Markdown cards.
`ToolExecutionComponent` is forbidden because it transitively constructs local
built-in tool definitions even when used only to render. The executable remains
independent of any local `pi` command, `PI_CODING_AGENT_DIR`, local Pi session
files, model/provider credentials, and local Pi extensions.

`initTheme` resolves `theme/dark.json` and `theme/light.json` beside a Bun
compiled executable. The build copies the exact 0.83.0 assets there so the
binary runs without a local Pi installation.

## Session switching contract

Switching the selected Scotty session is local UI state only:

1. save the old session's draft, scroll, snapshot, epoch, and sequence locally;
2. close only the old local HTTP/SSE reader;
3. select the new Scotty session ID;
4. fetch its authoritative lifecycle metadata and passive live snapshot;
5. connect its SSE tail;
6. leave the old sandbox Pi process and session untouched.

Never send `switch_session`, `abort`, snapshot, sleep, resume, or detach as part
of selection. Pending requests and command receipts must remain namespaced by
Scotty session ID.

Pi 0.83 RPC still exposes local session-control actions to sandbox extension
command contexts: `newSession`, `fork`, `navigateTree`, `switchSession`, and
`reload`. Add an extension-admission scan/test that rejects every bundled or
future Scotty extension calling them in RPC mode, or disable those actions in
the sandbox RPC host. A permitted `prompt` can invoke slash commands, so merely
omitting their direct RPC commands from Scotty's public allowlist is not
sufficient.

## Target call graphs

### Read path

```text
operator starts pi-scotty
  -> load paired client credential
  -> GET /api/sessions                         # discovery projection
  -> render fleet list
  -> operator selects warm Cloudflare session
  -> GET /api/sessions/:id                     # authoritative exposed fields
  -> read operation/control revision           # new DO-backed contract
  -> GET /s/:id/rpc/snapshot                   # proven passive; no start/keepalive
  -> reduce full snapshot
  -> GET /s/:id/rpc/events?epoch&since
  -> apply monotonic projection updates
  -> re-snapshot on epoch/gap
```

### Control path

```text
operator explicitly submits intent
  -> validate selected session + current snapshot state
  -> POST /s/:id/rpc/command with stable commandId
  -> Worker validates paired cookie + origin + JSON
  -> Sandbox DO injects private session capability
  -> supervisor validates allowlist + deduplicates in current epoch
  -> Pi RPC executes prompt/steer/follow-up/abort/UI response
  -> response receipt + subsequent SSE projection
```

### Test path

```text
fake Worker / fake supervisor fixtures
  -> typed snapshot/event/command decoder tests
  -> reducer replay/gap/epoch tests
  -> paired-cookie/origin/redaction tests
  -> headless extension compatibility tests
  -> PTY/tmux TUI interaction tests
  -> no-local-pi packaging smoke test
```

## Rejected alternatives

| Alternative                                       | Decision | Reason                                                                                                |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Local Pi `/scotty` extension as the fleet runtime | Reject   | Couples to a local Pi session/runtime and invites `ctx.switchSession` misuse                          |
| Pi `InteractiveMode` over remote overrides        | Reject   | Interactive mode assumes a local `AgentSession`; remote tool/session overrides violate ownership      |
| Latest Pi client/protocol/composable-server stack | Reject   | Client/protocol and newer server APIs are post-`v0.83.0`, unreleased, and missing extension UI parity |
| Load sandbox extensions on host                   | Reject   | Executes untrusted/runtime-specific code locally and duplicates extension state                       |
| Direct sandbox/SSH/PTY control                    | Reject   | Makes the host a remote tool/process owner and risks credential/capability leakage                    |
| Vendor the full latest Pi TUI/coding-agent UI     | Reject   | Use only exact released 0.83.0 UI/theme exports; unreleased code is a moving fork                     |
| Persist transcript/events in DO/KV                | Reject   | Duplicates Pi authority and turns projection into a second durable transcript                         |

A tiny optional local Pi extension may later do nothing more than spawn the
standalone `pi-scotty` binary for `/scotty`. It must not contain fleet state,
remote tools, credentials, or session switching logic. The standalone binary
remains the product boundary.

## Delivery slices

### Slice 0: harden the existing remote contract

- Resolve and prove an atomic no-start/no-keepalive read transport.
- Expose a DO-backed operation/control revision and revalidate commands.
- Define/decode race-safe `PiSessionSnapshotV1` with overlap events.
- Resolve pending-UI timeout/abort cancellation authority.
- Add supervisor projection for active tools, queues, blocking UI, status,
  string widgets, and title.
- Bound snapshot/SSE sizes, decoder depth, transcript/cache growth, and
  reconnect buffers; strip ANSI/OSC/control sequences from every remote string
  before applying trusted TUI styling.
- Redact credential sentinels at the projection boundary.
- Add command outcome-unknown behavior across epoch changes.
- Adapt task and background-terminal widgets for RPC string output.
- Force web curator to non-interactive modes until a secure proxy exists.

### Slice 1: read-only standalone fleet TUI

- Build `pi-scotty` with published `pi-tui@0.83.0` and UI-only `pi-coding-agent@0.83.0` exports.
- Pair as a standard Scotty client.
- Render every lifecycle row and explicit activity freshness.
- Select only warm Cloudflare sessions with an already-running supervisor.
- Render transcript, thinking, tools, and reconnect behavior.

### Slice 2: operator controls and extension UI

- Prompt, steer, follow-up, and explicit abort.
- Blocking select/confirm/input/editor requests.
- Notifications, status, string widgets, title, and editor text.
- Per-session drafts/scroll/cursors with side-effect-free switching.
- Generic unknown tool/message rendering.

### Slice 3: fleet activity and polish

- Passive bounded activity refresh for warm sessions.
- Command palette from sandbox extension commands.
- Accessibility/keybinding/tmux coverage and terminal-size handling.
- Optional thin `/scotty` launcher extension.

Expected effort: roughly **4–6 focused engineering days** after the contract
decisions below are accepted; runner-session parity is separate work.

## Verification gates

1. `PI_VERSION` remains exactly `0.83.0`.
2. Dependency gate permits only named released coding-agent UI/theme exports and
   rejects Pi runtime ownership APIs plus client/protocol/server packages.
3. Binary packages exact dark/light 0.83.0 theme assets, starts with no `pi`
   executable on `PATH`, and does not access `PI_CODING_AGENT_DIR`.
4. Read/switch tests prove no start, resume, sleep, snapshot, abort, or detach
   call occurs.
5. Snapshot + replay tests cover overlap, duplicate events, gaps, epoch changes,
   active tools, queues, pending UI, and extension surfaces.
6. Command tests cover accepted, rejected, duplicate-in-epoch, and
   outcome-unknown-after-epoch behavior.
7. Auth tests prove root, GitHub/provider credentials, sentinels, and internal
   transport capability never enter TUI state/requests/logs.
8. Every bundled extension loads in RPC mode without `extension_error`; every
   `ctx.ui.custom()`/component-widget use has a tested non-TUI fallback, and no
   extension can call local session-control actions (`newSession`, `fork`,
   `navigateTree`, `switchSession`, or `reload`).
9. Fuzz/bounds tests cover hostile ANSI/OSC strings, oversized/deep JSON,
   unbounded transcript/event input, and sentinel leakage.
10. Switching between two fake warm sessions leaves both fake Pi processes
    running and independently progressing without renewing either sleep lease.
11. No deployed/live environment is needed for the default verification suite.

## Decisions still needed before implementation

Slice 0 is **not implementation-ready** until decisions 1–3 below have concrete,
testable mechanisms. The standalone TUI seam remains the recommendation.

1. **Passive transport:** obtain an atomic no-start/no-keepalive SDK primitive,
   design a supervisor-initiated wake-free relay, or block live viewing.
2. **Control authority:** define the selected-session operation/control revision
   and stale-command response.
3. **Pending UI authority:** define cancellation behavior that covers timeout,
   turn abort/settle, process epoch, and signal abort under Pi 0.83.
4. **Binary UX:** canonical `pi-scotty`, `scotty tui`, or both pointing to one
   implementation. Recommendation: both.
5. **Credential persistence:** mode-`0600` file now, OS keychain later.
   Recommendation: file now, matching existing CLI portability.
6. **Fleet activity freshness:** lightweight passive endpoint versus explicit
   stale/unknown list state in v1. Recommendation: ship explicit freshness in
   Slice 1, add bounded passive refresh in Slice 3.
7. **Renderer:** published 0.83 main-screen primitives now versus vendored
   unreleased alternate-screen source. Recommendation: published package now.
8. **Runner sessions:** list them but mark worklog control unsupported until a
   native runner Pi RPC transport exists.
9. **Web curator:** keep it disabled/headless for fleet sessions until a
   same-origin proxy is separately designed and security-reviewed.
