# Scotty passive Pi console protocol v1

The standalone fleet console uses a Scotty-owned protocol. It does not use unpublished Pi client,
protocol, or server packages. Pi remains pinned to `0.83.0` and runs only inside the sandbox.

## Boundary

The public boundary is:

```text
GET  /s/:id/console/v1/snapshot
GET  /s/:id/console/v1/events?epoch=E&since=N
POST /s/:id/console/v1/command
```

This is the only browser/server console surface. There is no compatibility route or fallback to a
start-capable transport.

The authoritative Sandbox Durable Object uses `ctx.container.getTcpPort(PI_SESSION_PORT).fetch()`
directly for this boundary. It never uses the Sandbox SDK or Container `containerFetch()` wrappers,
which can start the container, track in-flight activity, and renew `sleepAfter`. It may consult
`ctx.container.running` only as an advisory fail-fast check; it never performs a process preflight.
Each request gets exactly one raw fetch attempt with no retry or fallback. A stopped container, a
stop/start race, or an absent/not-listening supervisor returns:

```json
{
  "version": 1,
  "status": "unavailable",
  "reason": "provider_passive_relay_unavailable",
  "retryable": false
}
```

The Durable Object derives the supervisor transport token from its existing credential vault and
adds it only to the internal loopback request. It forwards only `Accept`, `Content-Type`, and
`Last-Event-ID` values of at most 8 KiB each. Browser cookies, `Authorization`, root/provider/GitHub
credentials, caller supplied transport tokens, and other internal headers are never forwarded. The
native relay adds a DO-internal non-capability marker that suppresses the supervisor's 15-second SSE
heartbeat; public callers cannot supply or forward that marker. The internal target is
`http://127.0.0.1:${PI_SESSION_PORT}/{snapshot|events|command}` with the original query preserved.
The token is removed from relayed responses. Local contract tests may substitute an injected relay;
production defaults to the native raw relay.

Raw SSE intentionally ends when the container reaches its normal `sleepAfter`. The console does not
keep the stream or container alive and does not renew activity. Staging must prove that raw relay
requests neither start a stopped container nor renew its inactivity deadline before production proof
is claimed.

## Selected-session authority

The Sandbox Durable Object stores an opaque, non-secret `sessionRevision` beside the authoritative
`SessionRecord`. Every committed record write atomically increments that revision, including writes
that acquire, update, or release a lifecycle operation and writes that change session status. Legacy
records begin at revision `0`; the next write publishes revision `1`.

A successful snapshot includes the current `sessionRevision`. This is the only Durable Object control
metadata added to the Pi projection. The session record, operation nonce, credentials, provider
runtime details, and backup authority are never exposed through this protocol.

Every command must copy that value into `expectedSessionRevision`. The Sandbox Durable Object
strictly decodes and bounds the command, then atomically rereads both `SessionRecord` and revision.
It rejects the command before the passive relay when the revision changed, the session is not warm,
an operation is active, the provider is unsupported, or authority cannot be decoded. Revision
mismatch returns HTTP `409`:

```json
{
  "version": 1,
  "status": "stale",
  "expectedSessionRevision": 7,
  "sessionRevision": 8,
  "retryable": false
}
```

The client must refresh its selected-session snapshot and require a new operator intent; it must not
silently replay the stale mutation. Validation does not start, wake, renew, or inspect the container.

## Snapshot and replay

A v1 snapshot includes `sessionRevision`, `baseSequence`, ending `sequence`, and `overlapEvents`. The supervisor accepts
an overlap only when it is the complete contiguous range `baseSequence + 1 ... sequence`; otherwise
it retries collection and returns a typed snapshot failure after bounded attempts. SSE is only a
tail after a valid snapshot.

The volatile reducer bounds and sanitizes active tools, steering/follow-up queues, extension status,
string widgets, title, blocking UI, capabilities, transcript count, string size, object depth, and
event replay. ANSI, OSC, terminal-unsafe C0 controls, DEL/C1 controls, known credential forms, and
Scotty sentinel forms are removed before serialization. TAB/LF/CR remain available to multiline
transcript renderers; single-line console chrome normalizes them to spaces before terminal output.

Pi 0.83 emits explicit dialog timeouts but emits no event for signal-driven cancellation. The
supervisor proves cleanup for explicit timeout, observable Pi response/close events, abort, quiesce,
settle, process exit, epoch replacement, and bounded overflow. A successful stdin write for an
`extension_ui_response` produces a `delivered` receipt with an `unconfirmed` outcome and leaves the
request pending. Snapshots therefore report the remaining platform gap as:

```json
{
  "pendingUiAuthority": {
    "status": "partial",
    "reason": "pi_0_83_signal_cancellation_unobservable"
  }
}
```

No client may treat `pendingUi` as complete while that state is present.

## Commands

Versioned commands carry the supervisor `epoch`, a UUID `commandId`, the selected snapshot's
`expectedSessionRevision`, and an explicit intent. Command bodies are limited to 8 MiB and decoded
at both the public Worker and authoritative Sandbox Durable Object boundaries. The `prompt`,
`steer`, and `follow_up` intents can include up to four PNG, JPEG, WebP, or GIF images with at most
5 MiB of decoded image data in total. Each image contains only its MIME type and base64 data.
Paths and file names are not part of the protocol. Image data remains part of the canonical command
digest but never appears in receipts. Ordinary prompt intents beginning with `/` are rejected.
Only `slash_command` intents for `subagents` and `workflows` are translated to Pi prompt input.
Fold is local console state and is not part of the remote command schema, so it never reaches Pi.

Receipts include `version`, `epoch`, `commandId`, and a canonical SHA-256 `commandDigest`. Reusing a
command ID with a different digest is rejected. The memory-only receipt cache is scoped to one
supervisor epoch; clients must report an ambiguous outcome rather than retrying across epoch changes.
Delivered extension UI responses remain disabled in clients until a later authoritative event or
snapshot removes the pending request.
