# Scotty desktop codex-orchestrator architecture

Research date: 2026-08-02

Source snapshots:

- Scotty: `3c22c8d63a74371135fc363ee059b0fc66a1a8c7`
- Comet: `b033110d087ae0f1d1ba607b77d97624165c1986`
- installed Pi: `0.83.0`

Research used local first-party source only. No live Scotty session, deployment, credential, or Pi transcript was read or mutated.

## Implementation status

The thin vertical product slice is implemented on `feat/desktop-codex-orchestrator`:

- one native GPUI fleet window with side-effect-free selection across projected Cloudflare sessions;
- a virtualized T3Code-style chat/work timeline with normalized user, assistant, reasoning, tool, error, notice, and hidden-extension handling;
- waiting-input, prompt/steer/follow-up, abort, create, rename, snapshot, resume, selection-based metadata inspection, and confirmed vaporize controls;
- one compiled Bun sidecar that imports the existing `pi-scotty` controller, state, transport, schemas, redaction, pairing, and receipt checks directly;
- a bounded desktop protocol v2 over private NDJSON child pipes; Rust never receives the paired credential;
- a signed local macOS app bundle with pinned GPUI/Comet sources, notices, and a credential-free fixture smoke path.

The existing paired standard-client credential owns `sessions:read` and `sessions:write`, so lifecycle requests stay in the Bun sidecar behind the same cookie, same-origin, decoding, rotation, and redaction boundary. The Sandbox DO remains authoritative; desktop actions are explicit operator intents and never infer lifecycle from the KV fleet projection.

The MVP intentionally defers deep-link activation, sidecar restart/backoff, Markdown, keychain migration, auto-update, and Comet's motion/sound layers. macOS LaunchServices prevents duplicate bundle instances; all session jumps happen inside the fleet rail.

## Decision

Build **`scotty-desktop` as a native GPUI viewport over the existing Scotty fleet and passive Pi-console protocol**.

Import the tested TypeScript `pi-scotty` controller, schemas, replay reducer, transport, redaction, pairing, and credential store directly into a small compiled Bun sidecar. Connect it to the Rust viewport over private child stdio. The sidecar owns HTTP/SSE, the paired standard-client cookie, decoding, redaction, replay, command receipts, and per-session projection caches. Rust owns the window, navigation, rendering, and draft input.

```text
Scotty.app (Rust / GPUI viewport)
  ├── Scotty shell, rail, transcript, and composer
  ├── Comet-derived theme, menus, window setup, and Geist fonts
  ├── selected session + viewport-only draft
  └── bounded child stdio
        └── scotty-console-sidecar (compiled Bun / shared pi-scotty-core)
              ├── paired standard-client cookie (mode 0600; never sent to Rust)
              ├── fleet + per-session projection caches
              ├── Effect Schema boundary decoding and redaction
              └── HTTPS/SSE
                    └── Scotty Worker -> Sandbox DO -> existing Pi supervisor
```

For v1, “codex orchestrator” describes the desktop interaction model, **not a new local Codex runtime**. Do not import Comet's Codex harness, engine, CRDT store, cloud relay, WorkOS auth, credential slots, or updater. Those components would create a second session/process/credential authority and conflict with Scotty's binding invariants ([Scotty invariants](../../AGENTS.md#scope-and-invariants), [Comet topology](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/ARCHITECTURE.md#1-topology)).

## What “jump to all open sessions” means

These terms must not be collapsed:

| Term                       | Meaning in v1                                                                                  | Authority                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **listed**                 | Present in `GET /api/sessions`; may be stale, cold, stopped, unsupported, or runner-backed     | KV non-secret projection                  |
| **running**                | Authoritative session record is warm and its existing supervisor answers the passive relay     | Sandbox DO + container runtime            |
| **usable**                 | Running Cloudflare session with a valid passive v1 snapshot and supported command capabilities | Sandbox DO snapshot gate                  |
| **selected**               | Desktop locally displays one session and owns its one SSE reader                               | Desktop sidecar cache                     |
| **focused**                | The Scotty desktop window is foreground and the selected session is visible                    | Desktop process / OS                      |
| **resumable**              | Scotty lifecycle allows an explicit resume operation from a backup                             | Sandbox DO; not inferred by desktop       |
| **saved local Pi session** | A JSONL file exists on this machine                                                            | Pi session store; no liveness implication |

The jump contract is **select a projected remote Scotty session without changing that session's lifecycle or Pi owner**. Warm sessions attach to the passive console; sleeping and failed sessions remain inspectable until the operator explicitly chooses Resume. It is not “open this JSONL in another Pi process,” an implicit wake/keepalive, or “find and focus an arbitrary terminal tab.”

Pi's `SessionManager.listAll()` enumerates persisted JSONL files, but `SessionInfo` has no PID, control endpoint, window identity, lock, or liveness field ([session-manager declarations](/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts#L125), [implementation](/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js#L1289)). Opening can rewrite migrations and normal persistence appends without a session-file ownership lock ([open/rewrite](/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js#L610), [append](/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js#L724)). Therefore filesystem discovery cannot safely implement “open sessions.”

Stock Pi RPC is JSONL over the owning process's stdin/stdout; it is not a retroactive attach endpoint ([Pi RPC transport](/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md#transport)). Scotty already supplies the cooperative owner and endpoint: one named supervisor owns one Pi RPC child and exposes capability-protected snapshot/events/command routes ([supervisor](../../worker/container/scotty-pi-session.mjs), [container process ownership](../../worker/src/container-auth.ts)).

## Current authority and execution paths

### State ownership

| State                                                                     | Authority                                              | Desktop behavior                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| Session identity, provider, lifecycle, operation lease, backup generation | Sandbox DO `SessionStore`                              | Read only; never reconstruct from events            |
| Fleet list                                                                | KV `session:*` projection                              | Discovery only; show freshness and unsupported rows |
| Pi transcript, tools, queue, extension execution                          | Sandbox Pi `AgentSession` behind one supervisor        | Snapshot + replay projection only                   |
| Supervisor epoch, replay ring, command receipts                           | Supervisor memory                                      | Volatile and epoch-scoped                           |
| Provider/GitHub credentials and sentinel binding                          | Sandbox DO credential vault                            | Never present in desktop or sidecar                 |
| Paired standard-client credential                                         | Sidecar's mode-0600 config; OS keychain later          | Never cross child stdio or enter logs               |
| Selected session, drafts, scroll, pane widths, filters                    | Desktop/sidecar local cache keyed by Scotty session ID | Non-authoritative and bounded                       |
| Comet source snapshot/provenance                                          | Repository metadata                                    | Build input only; never runtime state               |

This preserves the repository invariant that the Sandbox DO owns authoritative session state and credentials, KV is only a projection, and R2 holds immutable backups ([AGENTS.md](../../AGENTS.md#scope-and-invariants)).

### Existing read path

```text
pi-scotty
  -> ConsoleTransport.listFleet()
  -> GET /api/sessions
  -> FleetConsoleController.select(sessionId)
  -> GET authoritative selected-session metadata
  -> GET /s/:id/console/v1/snapshot       # passive, one raw relay attempt
  -> validate snapshot + contiguous overlap
  -> GET /s/:id/console/v1/events?epoch&since
  -> apply matching-epoch, strictly monotonic events
  -> re-snapshot on epoch or replay gap
```

Evidence: [`FleetConsoleController.select`](../../pi-scotty/src/controller.ts#L175), [`ConsoleTransport`](../../pi-scotty/src/transport.ts), and the [v1 protocol](../pi-console-protocol-v1.md#boundary).

### Existing control path

```text
explicit operator intent
  -> PiConsoleCommandV1 { epoch, commandId, expectedSessionRevision, intent }
  -> Worker + Sandbox DO decode and revalidate authority
  -> existing supervisor deduplicates within its epoch
  -> Pi RPC executes allowlisted intent
  -> verified digest receipt
  -> later SSE/snapshot confirms projected state
```

Evidence: [`FleetConsoleController.sendIntent`](../../pi-scotty/src/controller.ts#L297), receipt verification in [`transport.ts`](../../pi-scotty/src/transport.ts), and [selected-session authority](../pi-console-protocol-v1.md#selected-session-authority).

The desktop must reuse these paths rather than recreate them in Rust.

## Decision matrix

| Shape                                           |                               Comet reuse |                                                                                      Correctness | Cost/update burden | Decision      |
| ----------------------------------------------- | ----------------------------------------: | -----------------------------------------------------------------------------------------------: | -----------------: | ------------- |
| Fork all Comet and replace branding             |                     Highest by line count |     Fails: imports a second engine, session store, auth, credential, sync, and command authority |            Highest | Reject        |
| Native Rust app directly calls Scotty HTTP/SSE  |                         Moderate UI reuse | Possible, but duplicates Effect Schema decoding, replay, redaction, command fencing, and pairing |        Medium-high | Reject for v1 |
| Web frontend inside a native shell              |                    Low direct Comet reuse |           Can reuse Scotty HTTP logic, but does not satisfy the requested Comet/native direction |             Medium | Reject        |
| GPUI viewport + shared `pi-scotty-core` sidecar | High sound UI reuse; zero authority reuse |                                      Preserves existing tested boundary and isolates credentials |             Medium | **Select**    |

The selected shape optimizes for behavioral reuse, not copied line count.

## Comet reuse matrix

Comet is MIT licensed ([LICENSE](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/LICENSE)). Copied or substantially derived files must retain its copyright/license notice; third-party GPUI, font, icon, and dependency notices need a separate audit.

| Comet source                                                                    | Action                                      | Reason / required adaptation                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/ui/src/theme.rs`, bundled Geist assets                                  | Copy/adapt                                  | Backend-neutral visual system; preserve MIT/OFL notices                                                                                                                                                                                                                |
| `crates/ui/src/motion.rs`, `loaders.rs`, `frost.rs`, `edge_fade.rs`, `sound.rs` | Copy/adapt                                  | Mostly presentation; remove Comet-specific IDs/settings and add reduced-motion gate                                                                                                                                                                                    |
| `crates/ui/src/icons.rs`, `app_menus.rs`, `popover.rs`                          | Copy/adapt after license audit              | Native shell primitives; rename app actions and remove unsupported commands                                                                                                                                                                                            |
| `crates/ui/src/lib.rs` window/bootstrap                                         | Adapt                                       | Keep GPUI/Tokio bridge, window lifecycle, Dock reopen, menus, fonts; replace embedded-engine bootstrap ([`run_app`](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/crates/ui/src/lib.rs#L109))                                         |
| `crates/ui/src/shell.rs`, `rail.rs`, `shell/tabs.rs`                            | Adapt heavily                               | Reuse layout and navigation behavior; replace Space/Chat/Session and archive/new-session mutations with Scotty fleet rows and local selection                                                                                                                          |
| `crates/ui/src/transcript.rs`                                                   | Extract presentation techniques, then adapt | Valuable virtualization/markdown/stick-to-bottom code, but imports `comet-doc`, `comet-proto`, Comet state, theme, and motion; not drop-in ([imports](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/crates/ui/src/transcript.rs#L25)) |
| `crates/ui/src/composer.rs`                                                     | Adapt selected controls                     | Keep text input, send/steer/stop morph, drafts, question panel; replace Comet harness/model/repo/branch pickers with snapshot capabilities                                                                                                                             |
| `crates/ui/src/settings.rs`                                                     | Adapt presentation-only settings            | Keep pane/theme/sound/keybinding storage; delete WorkOS/device/account/update settings                                                                                                                                                                                 |
| `crates/proto/src/view.rs`                                                      | Port pure algorithms                        | Sorting, grouping, relative time, and staleness logic are reusable, but operate on Comet entity types ([module contract](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/crates/proto/src/view.rs#L1))                                  |
| `crates/engine/src/instance_lock.rs`                                            | Port pattern only                           | Enforce one desktop viewport and route second-launch activation; never treat it as Pi ownership                                                                                                                                                                        |
| `crates/rpc` envelope/client                                                    | Reuse framing ideas, not WebSocket listener | Its NDJSON request/stream envelope is useful; transport must be child pipes, not unauthenticated localhost WS ([RPC contract](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/crates/rpc/src/lib.rs#L1))                                |
| `scripts/package-macos.sh`, `dist/macos`                                        | Reference only                              | Useful bundle layout; current code-sign/notarization/update proof is insufficient for Scotty                                                                                                                                                                           |
| `crates/harness/src/codex`                                                      | Reject in v1                                | Starts/resumes its own `codex app-server`; cannot attach to existing Pi; failed resume may start fresh, approval is forced to never, and one worktree case escalates sandbox                                                                                           |
| `crates/engine`, `crates/doc`, `crates/sync`, `edge/`                           | Reject                                      | Loro/SQLite/WorkOS/DeviceRoom/SessionRoom authority duplicates Scotty DO/KV/R2/Pi authority                                                                                                                                                                            |
| `crates/engine/src/agent_accounts.rs`                                           | Reject                                      | Stores/swaps real CLI credentials, forbidden by Scotty credential isolation                                                                                                                                                                                            |
| `crates/update`                                                                 | Reject initially                            | Scotty needs signature, Team ID, notarization, and mandatory checksum verification before self-update                                                                                                                                                                  |
| terminal, diff, repo/worktree, attachment modules                               | Defer                                       | They target host-device filesystem/process ownership absent from the passive Scotty console contract                                                                                                                                                                   |

Comet's `comet-ui` crate itself is not directly reusable because it depends on `comet-engine`, `comet-doc`, `comet-rpc`, and `comet-proto` ([Cargo dependencies](https://github.com/zeronsh/comet/blob/b033110d087ae0f1d1ba607b77d97624165c1986/crates/ui/Cargo.toml)). Import selected files into a Scotty-owned crate; do not add the full Comet workspace as a runtime dependency.

## Target boundaries and contracts

### Process boundary

Use one app bundle with two executables:

- `Contents/MacOS/scotty-desktop`: Rust/GPUI viewport;
- `Contents/Resources/scotty-console-sidecar`: compiled Bun executable built from shared TypeScript core.

The viewport creates anonymous stdin/stdout pipes. No TCP port is opened. The paired cookie is loaded by the sidecar from its fixed mode-0600 config path and is never supplied in process args, environment, an RPC frame, crash report, or Rust state. Both processes are one local trust domain, but keeping network credentials behind the existing redaction boundary minimizes accidental UI/log exposure.

The v1 bundle sets `LSMultipleInstancesProhibited` and supports in-window fleet jumps only. Second-launch session activation and deep links are deferred; a future activation endpoint must be local, capability-protected, and unable to proxy console commands or return fleet/transcript data.

### Backend-neutral viewport surface

The sidecar protocol should expose already-decoded Scotty view models, not Pi/Comet runtime objects:

```ts
interface DesktopConsoleBackend {
  subscribeFleet(signal: AbortSignal): AsyncIterable<FleetFrame>;
  select(sessionId: ScottySessionId, signal: AbortSignal): AsyncIterable<SelectedFrame>;
  submit(sessionId: ScottySessionId, intent: PiConsoleRemoteIntentV1): Promise<IntentReceipt>;
  answerUi(sessionId: ScottySessionId, requestId: string, answer: UiAnswer): Promise<IntentReceipt>;
  create(input: CreateSessionInput, requestId: string): Promise<OperationResult>;
  rename(sessionId: ScottySessionId, title: string, requestId: string): Promise<OperationResult>;
  snapshot(sessionId: ScottySessionId, requestId: string): Promise<OperationResult>;
  resume(sessionId: ScottySessionId, requestId: string): Promise<OperationResult>;
  vaporize(sessionId: ScottySessionId, requestId: string): Promise<OperationResult>;
  setDraft(sessionId: ScottySessionId, text: string): void;
  shutdown(): Promise<void>;
}
```

Wire frames are versioned, bounded NDJSON:

```ts
interface SelectionFenceV2 {
  readonly sessionId: string;
  readonly expectedEpoch: string;
  readonly expectedSessionRevision: number;
}

type DesktopRequestV2 =
  | { version: 2; type: "refresh_fleet" }
  | { version: 2; type: "select"; sessionId: string }
  | { version: 2; type: "close" }
  | ({ version: 2; type: "submit"; text: string; forceFollowUp?: boolean } & SelectionFenceV2)
  | ({ version: 2; type: "abort" } & SelectionFenceV2)
  | ({ version: 2; type: "answer"; requestId: string; answer: UiAnswer } & SelectionFenceV2)
  | {
      version: 2;
      type: "create_sandbox";
      requestId: string;
      title: string;
      prompt: string;
      repo: string;
      hardCapSeconds: number;
    }
  | { version: 2; type: "rename_sandbox"; requestId: string; sessionId: string; title: string }
  | {
      version: 2;
      type: "snapshot_sandbox" | "resume_sandbox" | "vaporize_sandbox";
      requestId: string;
      sessionId: string;
    }
  | { version: 2; type: "shutdown" };

type DesktopFrameV2 =
  | { version: 2; type: "ready" }
  | { version: 2; type: "state"; state: DesktopState }
  | {
      version: 2;
      type: "operation";
      requestId: string;
      action: string;
      sessionId?: string;
      status: "started" | "succeeded" | "failed" | "unknown";
      message: string;
    }
  | { version: 2; type: "error"; code: string; message: string }
  | { version: 2; type: "stopped" };
```

Do not send the cookie, internal sandbox capability, provider/GitHub credentials, credential sentinels, raw response headers, loopback coordinates, unredacted errors, or unbounded unknown objects over this boundary.

The TypeScript implementation should be refactored, not duplicated:

```text
pi-scotty-core/
  config + pairing + schemas + redaction
  transport + FleetConsoleState + FleetConsoleController
  viewport-neutral events/commands
       ├── existing pi-tui adapter
       └── sidecar NDJSON adapter
```

The TUI and desktop get the same fleet order, replay semantics, command behavior, and redaction tests.

## Side-effect-free jump algorithm

When the operator clicks a row, tab, command-palette item, notification, or second-launch deep link:

1. Resolve only a Scotty session ID from the current fleet projection; never resolve a Pi JSONL path.
2. Save old draft, scroll anchor, folds, and viewport preference locally under the old Scotty session ID.
3. Increment a local selection generation and cancel the old selected-session reader.
4. Update selected/focused UI state immediately; do not send any remote command.
5. Request authoritative selected-session metadata.
6. If the row is not warm Cloudflare, an operation is active, or passive access is unavailable, display it read-only/unavailable. Do not start, resume, retry through another transport, or inspect the container.
7. Fetch one v1 passive snapshot, validate its bounds, epoch, session revision, and contiguous overlap.
8. Hydrate the selected projection and apply overlap events through the ending sequence.
9. Open one SSE tail after that sequence. Apply only the matching epoch and next sequence; duplicate events are ignored.
10. On gap or epoch change, cancel the stream and re-snapshot. A stale generation may not publish into the newly selected view.
11. Bring the existing Scotty window to the foreground if this jump came through the activation endpoint.

Selection never emits Pi `switch_session`, `new_session`, `fork`, `abort`, `snapshot`, `resume`, `sleep`, `detach`, or a Comet archive mutation. It never touches the old remote Pi process. This matches the existing TUI selection contract ([research](pi-scotty-standalone-fleet-tui.md#session-switching-contract)).

## Freshness, concurrency, and recovery

### Invariants

1. At most one sidecar selected-session SSE reader is active per desktop process.
2. Fleet activity is explicitly timestamped/stale; it is never treated as lifecycle authority.
3. Only the Sandbox DO may authorize lifecycle and command mutation.
4. Commands are explicit operator intents fenced by snapshot epoch and `sessionRevision`.
5. Ambiguous command outcomes are never automatically retried across an epoch change.
6. Every cache, pending UI answer, receipt, draft, and scroll anchor is namespaced by Scotty session ID; volatile items also include epoch/request identity.
7. A desktop crash cannot stop, detach, archive, or resume a remote session.
8. Sidecar exit never replays an in-flight command. V1 shows the disconnect and requires an app restart plus explicit reselection; remote sessions continue unchanged.
9. No local JSONL scan creates an attachable/running row.
10. Unknown messages/tools render through a bounded generic card after redaction.

### Failure behavior

| Failure                                        | Behavior                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sidecar exits                                  | Viewport shows disconnected; reopening the window starts a fresh sidecar; no command replay |
| Rust viewport exits                            | Sidecar receives pipe close and exits; remote Pi continues unchanged                        |
| SSE closes normally                            | Respect passive sleep behavior; show unavailable/stale, do not keep container alive         |
| Epoch changes or replay gap                    | Re-snapshot; clear epoch-scoped pending UI/receipt assumptions                              |
| Session revision stale                         | Show stale response and require a fresh explicit user intent                                |
| Snapshot overlap incomplete                    | Reject snapshot and bounded retry according to the existing controller contract             |
| Second app launch                              | LaunchServices rejects a duplicate bundle instance; session deep links are deferred         |
| Saved local Pi JSONL with no cooperative owner | Show only in a future saved-history surface, never as usable/open                           |

## Production and test call graphs

### Production

```text
operator click / shortcut
  -> GPUI Shell
  -> DesktopConsoleBackend request over child pipes
  -> shared FleetConsoleController
  -> existing ConsoleTransport
  -> Worker paired-client auth
  -> Sandbox DO authority + revision gate
  -> existing passive raw relay
  -> one existing Pi supervisor / AgentSession
  -> bounded projection frame back to GPUI
```

### Test substitution

```text
fake ConsoleTransport
  -> real pi-scotty-core controller/state/reducer
  -> in-memory sidecar framing
  -> Rust fake child transport
  -> real GPUI AppState derivations
  -> frame/snapshot assertions
```

Integration:

```text
fake Worker + fake supervisor
  -> compiled sidecar child
  -> Rust headless viewport model
  -> select A -> select B -> select A
  -> assert independent epochs/caches, one reader, no lifecycle calls
```

The default suite uses no deployment or real credential. A deployed Cloudflare canary remains required to prove passive reads neither start a stopped container nor renew its inactivity deadline ([protocol boundary](../pi-console-protocol-v1.md#boundary)).

## Repository shape

```text
desktop/
  Cargo.toml
  Cargo.lock
  COMET_UPSTREAM.md                 # pinned commit, blob IDs, and adaptations
  THIRD_PARTY_NOTICES.md
  crates/scotty-desktop/
    src/main.rs                     # GPUI viewport
    src/sidecar.rs                  # bounded child and strict wire DTOs
    src/theme.rs                    # Comet-derived theme
    src/app_menus.rs                # adapted native menus
  fixtures/fake-sidecar.mjs
pi-scotty/src/
  controller.ts + state.ts + transport.ts
  desktop-protocol.ts               # bounded, redacted projection
  desktop-sidecar.ts                # direct adapter over shared modules
  desktop-sidecar-main.ts           # config and stdio host boundary
scripts/
  build-scotty-desktop-sidecar.mjs
  package-scotty-desktop.mjs
  check-scotty-desktop.mjs
```

Do not add `/tmp/comet` as a submodule or runtime dependency. Record each imported file and upstream blob hash in `desktop/COMET_UPSTREAM.md`. Keep local product-specific changes reviewable and make upstream refresh an explicit diff exercise.

## Delivery slices

### Slice 0 — shared-core extraction, no UI change

- Move `pi-scotty` transport, schemas, redaction, state, and controller behind a renderer-neutral API.
- Keep current TUI behavior and tests byte/semantics compatible.
- Add bounded child-pipe protocol and fake viewport.
- Demo: existing TUI and a fixture client select two fake sessions through one core.

### Slice 1 — read-only native fleet shell

- Create Rust workspace and import the audited Comet theme, window shell, rail, tabs, loaders, motion, and pure view algorithms.
- List every projected Scotty session; distinguish listed, usable, stale, unsupported, and selected.
- Side-effect-free jump among fake and real paired-session projections.
- Add one-instance activation and optional `scotty desktop SESSION` deep link.
- Demo: jump A -> B while both fake supervisors continue independently.

### Slice 2 — transcript and live projection

- Adapt Comet transcript virtualization/markdown to normalized Scotty messages/tools.
- Add snapshot hydration, live events, reconnect/gap/epoch states, pending UI, status, widgets, and generic fallback cards.
- Preserve per-session draft/scroll/fold caches.
- Demo: two concurrently progressing sessions, including waiting input and an epoch replacement.

### Slice 3 — explicit controls

- Adapt composer send/steer/follow-up/stop morph and extension select/confirm/input/editor panels.
- Drive model/thinking/command affordances only from snapshot capabilities.
- Preserve revision fencing, receipt digest verification, and outcome-unknown behavior.
- Do not add archive/close/resume semantics to Comet tabs; tab close is local view close only.
- Demo: steer A, jump to B, answer B input, return to A without command or cache crossover.

### Slice 4 — hardened distribution

- Build universal/supported macOS app bundle with exact sidecar and resource hashes.
- Sign all nested executables, harden runtime, notarize, staple, and verify Team ID.
- Store paired credential in mode-0600 config initially; migrate to Keychain only as a separately tested change.
- No self-updater until signed update metadata, mandatory checksums, rollback, and provenance are designed.
- Demo: install on a clean machine with no local Pi/Codex executable and pair as a standard client.

A local Codex `app-server` mode is a separate project after v1. It requires an explicit local authority model, launch-time owner registry, approval/sandbox policy, and persistence contract; Comet's harness can then be evaluated independently.

## Verification gates

1. Existing `pi-scotty` tests remain green after core extraction.
2. TUI and desktop contract fixtures produce the same fleet order, selected projection, replay result, redaction result, and command receipt state.
3. Dependency/lint gates reject Comet engine/doc/sync/edge/account/update and Pi runtime/session ownership imports from desktop.
4. Desktop starts with no `pi`, `codex`, or `claude` executable on `PATH`.
5. Selecting between sessions emits no lifecycle, Pi session-control, container-start, keepalive, archive, or abort action.
6. At most one selected-session SSE reader survives rapid A/B switching; stale generations cannot publish.
7. Snapshot tests cover overlap, duplicate, gap, epoch, queue, active tool, pending UI, widget, truncation, and hostile unknown values.
8. Command tests cover accepted, stale revision, duplicate in epoch, digest mismatch, transport ambiguity, and epoch change.
9. Security tests prove paired cookie, root/provider/GitHub credentials, sentinels, transport capability, loopback coordinates, and raw headers cannot enter Rust frames, UI state, logs, crash reports, args, or env.
10. Bounds/fuzz tests cover NDJSON frame size, JSON depth, string controls/ANSI/OSC, cache count, transcript growth, reconnect buffers, and malformed sidecar output.
11. Packaging tests verify copied Comet/OFL notices, exact sidecar hash, nested signatures, Team ID, hardened runtime, notarization, and staple.
12. Deployed canary proves passive snapshot/events do not start a stopped container or renew `sleepAfter`.
13. A crash/quit of either desktop process leaves both fake and deployed remote sessions running unchanged.

Run the repository baseline after each implementation slice:

```sh
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
cargo fmt --manifest-path desktop/Cargo.toml --check
cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path desktop/Cargo.toml
```

## Risks

- **UI extraction cost:** Comet's transcript/composer/shell are coupled to Comet entities and engine RPC. Reuse is substantial but not drop-in; port behavior in narrow slices and retain upstream provenance.
- **Two-language package:** Rust + compiled Bun increases build/signing complexity. It avoids a riskier rewrite of security/replay logic; measure startup and bundle size in Slice 0.
- **GPUI pin:** Comet uses a custom Zed GPUI revision. Pin exactly, audit its license/dependency closure, and plan controlled upgrades rather than tracking Comet HEAD.
- **Passive relay proof:** source contracts are not enough; deployed Cloudflare behavior remains a release gate.
- **Semantic pressure from Comet:** archive, new chat, worktree, terminal, device, account, and update controls look reusable but do not map to Scotty console authority. Hide them until each has a Scotty-owned contract.
- **“Local open sessions” expectation:** filesystem-only Pi sessions cannot be safely focused or attached. Product copy must say “Scotty sessions.”

## Open decisions

Only these product choices remain; they do not change the recommended authority seam:

1. Product name and command: recommendation `Scotty` app plus `scotty desktop [SESSION]`.
2. macOS-only first release versus Linux GPUI packaging in the same milestone: recommendation macOS first, keep Rust contracts portable.
3. Standard-client credential persistence: recommendation retain current mode-0600 file for v1; Keychain later.
4. Whether cold/stopped rows appear in the main rail: recommendation show all listed rows with explicit state, but enable live selection only for usable sessions.
5. Whether “local Codex orchestration” is a later separate mode: recommendation yes, never implicit in the Scotty fleet viewport.

## Rejected local-process shortcut

If a later product must focus arbitrary local Pi/Codex terminals, each owner must cooperatively register at launch:

```text
{ sessionId/path, process identity, random capability, control endpoint, optional window identity }
```

A responding capability endpoint may be focused or steered. An unresponsive record is stale. PID, mtime, JSONL existence, or process-name matching is never ownership proof. Saved sessions without an owner may be shown as history and explicitly forked, but never silently resumed. That registry is unnecessary for Scotty's existing supervised remote sessions and is outside this desktop v1.
