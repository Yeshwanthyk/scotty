# Rivet and agentOS fit for Scotty

Research snapshot: 2026-07-26. Rivet was inspected at
[`826c7ea10cb99c0e72c546f19ee395b03d1c5039`](https://github.com/rivet-dev/rivet/commit/826c7ea10cb99c0e72c546f19ee395b03d1c5039),
agentOS at
[`9953769ec67d98a1ab7a0e52677c86444c14d536`](https://github.com/rivet-dev/agentos/commit/9953769ec67d98a1ab7a0e52677c86444c14d536),
and Scotty's pinned Pican at
[`fd933857afe58d842db8adfd6a7f1ea64e2bac0d`](https://github.com/Yeshwanthyk/pican/commit/fd933857afe58d842db8adfd6a7f1ea64e2bac0d).
Only first-party documentation and source are used for external claims.

## Decision

Rivet can fit Scotty as the stateful agent harness between Scotty's Session
Durable Object and an execution sandbox. It cannot replace the execution
sandbox for the current Pican binary and native coding tools.

The useful architecture is:

```text
browser / CLI
      |
Cloudflare Worker
      |
Scotty Session DO
  product session ID and public lifecycle
  operation leases, hard cap, credential vault
  active/previous R2 backup authority
      |
Rivet actor + agentOS
  turn queue and idempotency
  transcript/event sequence
  agent-adapter session and workflow state
      |
execution sandbox
  disposable workspace
  native tools, builds, tests, and processes
```

This is a credible later architecture track, not a provider substitution inside
the current S1–S5 vertical. Finish the Pican service, authenticated `/s/:id`
proxy, pin, Cloudflare create canary, and sleep/resume/down proof first. Then
spike the split above with a fake agent and synthetic credentials.

The distinction matters:

- [Rivet Actors](https://github.com/rivet-dev/rivet/blob/826c7ea10cb99c0e72c546f19ee395b03d1c5039/README.md)
  are lightweight stateful processes with SQLite, queues, workflows,
  scheduling, HTTP, and WebSockets. They are a good harness and orchestrator,
  not isolated native Linux workspaces.
- [agentOS](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/README.md)
  is a separate project built on Rivet Actors. It runs agent adapters and
  WASM/V8 workloads in lightweight virtual machines and can attach a full
  sandbox when native execution is needed.

Running Pican inside a Rivet deployment container as an ordinary host child
process would erase the isolation and per-session resource boundary Scotty is
trying to buy. It would also make Rivet actor state and Pican state compete for
the same harness role.

## The clean authority split

Keep the existing Scotty authority unless the public contract is deliberately
redesigned.

The Session DO owns:

- the Scotty session ID and immutable execution placement;
- public `booting | warm | sleeping | failed | gone` state;
- operation leases, idle policy, hard-cap schedule, and vaporize progress;
- real Codex/GitHub credentials and sentinel validation;
- the current and previous R2 backup generations;
- the mapping to Rivet actor ID and current sandbox resource.

This preserves the current
[state ownership and credential invariants](../../IMPLEMENTATION_DAG.md) and
[Effect migration authority model](../../EFFECT_V4_MIGRATION.md).

The Rivet actor owns only harness protocol state:

- accepted turn IDs, ordering, and idempotency;
- durable transcript entries and a monotonically increasing event sequence;
- agent-adapter private session/load state;
- workflow steps, permission requests, and retry state.

It must not publish Scotty lifecycle state, persist real credentials, choose a
compute provider, decide the spend hard cap, or promote an R2 backup.

The execution sandbox owns no durable product state. It holds the workspace and
native processes, is checkpointed to R2 under a Session DO lease, and is
disposable after the checkpoint commits.

That gives each layer one reason to be stateful. An observed actor sleep or
sandbox exit is input to the Session DO's state machine, not an authoritative
Scotty transition.

### Pican makes this a redesign, not a swap

Current Pican is already more than a UI. It owns the Codex app-server process,
session workers, chat queue, runtime status, transcript projections, and live
SSE fan-out. Its Codex client launches
[`codex app-server --stdio`](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/codex/client.go),
and its HTTP server holds connected clients and live runtime state
([server source](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/server/server.go)).

If Pican stays unchanged in the sandbox, the Rivet actor is only another
orchestrator/proxy. It does not honestly own turns or transcripts and adds a
second durable coordinator beside the Session DO.

If the Rivet actor becomes the harness authority, Pican must become a thin
client/UI projection over that protocol, or be replaced for hosted sessions.
The agentOS Codex adapter is not Pican's existing runtime: it starts its own
[`codex-exec` ACP adapter](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/software/codex/src/adapter.ts),
not `codex app-server --stdio`, and the
[Codex package is explicitly beta](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/software/codex/agentos-package.json).

Therefore the harness-outside-sandbox design should be evaluated as a new
vertical after S5, not inserted between S3 and S4.

## Why current Pican still needs a full sandbox

Scotty pins a statically linked Linux/amd64 Pican executable in
[`worker/container/pican-linux-amd64.lock.json`](../../worker/container/pican-linux-amd64.lock.json).
agentOS cannot run arbitrary native ELF binaries. Its
[documented limitations](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/limitations.md)
exclude arbitrary downloaded binaries, normal package managers, native
toolchains absent from its registry, Docker, and `inotify`/`fs.watch`.
Custom software must instead be built for
[`wasm32-wasip1`](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/custom-software/building-wasm.md).

Pican's current source depends on `modernc.org/sqlite` and `fsnotify`
([`go.mod`](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/go.mod)),
uses Unix process groups and signals for supervised agent processes
([Codex process control](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/codex/process_unix.go)),
and has several direct `fsnotify` watchers, including
[task updates](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/server/tasks_watcher.go),
[workflow updates](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/server/workflows_watcher.go),
and [Claude transcripts](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/claude/watcher.go).

A local proof against the pinned source confirmed this is not only a packaging
change:

```sh
GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 \
  go build -trimpath -o /tmp/pican.wasm ./cmd/pican
```

The build fails because the pinned `modernc.org/libc` dependency excludes its
`errno`, `pthread`, `signal`, `stdio`, `time`, and `unistd` packages on WASI.
The archived source also lacked generated embedded UI assets, which is a
separate reproducibility issue. Porting Pican would require storage, process,
watcher, and agent-adapter changes; it would not make the existing binary
lighter.

agentOS's own recommendation is the hybrid: use its VM for the lightweight
harness and
[mount a full sandbox](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/sandbox.md)
for native binaries, browsers, heavy compilation, and native extensions.

## What the hybrid gives Scotty

`@rivet-dev/agentos-sandbox` can lazily create an external sandbox, mount its
filesystem into the actor VM, and expose provider-agnostic process operations
through `agentos-sandbox` bindings. Its documented providers include Docker,
local, E2B, Daytona, Vercel, Cloudflare, Modal, ComputeSDK, and Sprites
([sandbox integration](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/sandbox.md)).

That can reduce full-sandbox time if many turns only need transcript,
reasoning, network, or lightweight WASM tools. It does not guarantee that a
normal Codex shell call runs in the external sandbox. The exposed integration
is an explicit command/process binding plus a mounted filesystem. Scotty must
prove that every tool requiring native execution is routed through it. A
prompt convention is not a security boundary.

The integration's default lifecycle also conflicts with Scotty until adapted.
RivetKit `agentOS()` starts a fresh sandbox for each actor VM and destroys it
when that VM is disposed. It intentionally rejects sharing an already-connected
sandbox client between actor VMs
([sandbox lifecycle](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/sandbox.md)).

Meanwhile, agentOS preserves its own filesystem, session catalog, and completed
history across actor sleep, but running commands, shells, adapter processes,
subscriptions, and in-progress deltas do not survive
([persistence and sleep](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/persistence.md)).
Its default actor idle sleep is 30 seconds.

Scotty therefore needs an explicit coordinated sequence:

```text
Session DO acquires checkpoint lease
  -> actor rejects/queues new turns
  -> pause sandbox processes and flush workspace
  -> upload immutable R2 checkpoint
  -> Session DO promotes backup generation
  -> actor and sandbox may sleep/dispose
  -> Session DO publishes sleeping
```

Wake must create a fresh external sandbox, restore the DO-approved R2
generation, restart the adapter, load the harness session, and only then publish
`warm`. Provider persistence may optimize this, but cannot replace R2 authority.

## HTTP, SSE, WebSocket, and terminal implications

Keep `/s/:id` on the Cloudflare Worker. The Worker should authenticate the
browser, resolve the Session DO, and forward only an internal actor capability.
Do not expose an agentOS preview URL as Scotty's session URL. Preview tokens are
persisted in actor SQLite, and the current agentOS actor deliberately bypasses
the caller's `onBeforeConnect` for preview paths
([actor source](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/packages/agentos/src/actor.ts)).

Finite HTTP actions map cleanly to Rivet actor actions or `onRequest`. Streaming
does not map to Scotty's current proxy without an adapter. Scotty currently
returns the Sandbox SDK's streaming `Response` directly
([Pican service](../../worker/src/pican.ts)), while Pican's `/events` endpoint
requires an `http.Flusher` and holds a long-lived SSE connection
([event handler](https://github.com/Yeshwanthyk/pican/blob/fd933857afe58d842db8adfd6a7f1ea64e2bac0d/internal/server/events.go)).

The current agentOS actor exposes chunked `vmFetchStreamStart`,
`vmFetchStreamRead`, and `vmFetchStreamCancel` actions
([actor source](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/packages/agentos/src/actor.ts)).
A Worker could wrap those in a `ReadableStream`, but Scotty would own
backpressure, cancellation, reconnect, and cursor semantics. The stronger
harness design is to persist transcript events with a sequence, return a
snapshot plus `afterSequence` replay, and use SSE only as a live tail.

Rivet Actors also support
[raw WebSocket handlers](https://github.com/rivet-dev/rivet/blob/826c7ea10cb99c0e72c546f19ee395b03d1c5039/website/src/content/docs/actors/websocket-handler.mdx)
and
[connection authentication](https://github.com/rivet-dev/rivet/blob/826c7ea10cb99c0e72c546f19ee395b03d1c5039/website/src/content/docs/actors/authentication.mdx).
For Scotty, the Worker should terminate or proxy the WebSocket and issue a
short-lived, session-bound ticket. It should not give the browser a reusable
Rivet publishable key or actor credential.

Hibernating actor WebSockets preserve a transport, not a running agentOS shell
or external sandbox process. The documented sandbox bindings support text
stdin and log reads but do not expose PTY resize. Scotty's browser-terminal
contract still needs a host bridge or a provider-native PTY with input, output,
resize, cancellation, disconnect, and reconnect proof.

## Credential and security gate

agentOS is explicit that it is beta and still under security review. The
sidecar/kernel is trusted infrastructure, multiple VMs may share a sidecar
process, and the deployment host must already be hardened
([security model](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/security-model.md)).

More importantly for Scotty, the per-VM actor database is trusted plaintext.
Session environment values, MCP credentials, prompts, messages, and permission
payloads may be stored without encryption or redaction
([persistence](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/persistence.md)).
The current Codex guide expects `OPENAI_API_KEY` and optionally
`OPENAI_BASE_URL` in session environment
([Codex guide](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/agents/codex.md)),
while agentOS's hosted
[LLM gateway is not yet available](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/llm-gateway.md).

Scotty must keep real credentials in the Session DO and send only a
session-bound sentinel and broker base URL to the actor and sandbox. Before any
real token is used, prove:

- the actor SQLite database, snapshots, history, configuration, logs, errors,
  and Rivet observability contain no real token;
- only the Scotty broker destinations are reachable, including redirect, DNS,
  IPv6, raw TCP, and WebSocket negatives;
- refresh commits the rotated credential to the Session DO before a sanitized
  response reaches the harness;
- neither actor sleep nor sandbox recreation can turn a sentinel into a
  reusable cross-session capability.

This is the same credential boundary as the current Cloudflare vertical, not a
reason to relax it.

## Deployment and operational fit

agentOS can run on Rivet Cloud, a self-hosted Rivet deployment, or as
`agentos-core` embedded in a Node backend
([deployment options](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/website/public/docs/docs/deployment.md)).
Embedding Core alone does not provide Rivet actor persistence, routing, or
lifecycle; Scotty would have to supply those.

The managed path deploys a Dockerized RivetKit server to Rivet Compute
([deployment guide](https://github.com/rivet-dev/rivet/blob/826c7ea10cb99c0e72c546f19ee395b03d1c5039/website/src/content/docs/deploy/rivet-compute.mdx)).
Self-hosting keeps the control plane open source but makes Scotty responsible
for its availability and storage. Edge placement is currently supported on
Rivet Cloud and Cloudflare Workers, and actors select the nearest region unless
one is specified
([edge networking](https://github.com/rivet-dev/rivet/blob/826c7ea10cb99c0e72c546f19ee395b03d1c5039/website/src/content/docs/general/edge.mdx)).

For Scotty, choose and persist one actor region and co-locate its execution
sandbox. Do not let client geography create a new actor in a different region
on reconnect. Region, actor ID, and sandbox provider identity belong in the
Session DO record.

The agentOS packages inspected here are version `0.0.1`
([package source](https://github.com/rivet-dev/agentos/blob/9953769ec67d98a1ab7a0e52677c86444c14d536/packages/agentos/package.json)).
Combined with the beta security model and beta Codex adapter, that makes it a
spike dependency, not a production replacement today.

## Smallest useful spike after S5

Use a fake agent and synthetic credentials:

1. Create one Session DO and one Rivet harness actor. Prove the DO is the only
   publisher of Scotty lifecycle and backup generation.
2. Route authenticated `/s/:id` HTTP through the Worker to the actor. Persist a
   transcript sequence and prove snapshot, replay-after-cursor, and live tail
   across disconnect.
3. Lazily create an external sandbox. Run one native command that writes the
   mounted workspace and return its result through the actor.
4. Force actor sleep. Before sandbox disposal, checkpoint through a DO lease,
   promote the R2 generation, and publish `sleeping`.
5. Wake into a fresh sandbox, restore the exact workspace, reload the actor
   transcript, and complete another turn without duplicate execution.
6. Prove terminal input/output/resize/reconnect. Treat missing PTY resize as a
   blocker, not a UI detail.
7. Scan actor SQLite, Rivet state/observability, sandbox files/env/process args,
   R2, Worker responses, and logs for the synthetic real credential. Only the
   sentinel may cross the Session DO boundary.

If that passes, compare idle cost and wake latency against the completed
Cloudflare/Pican S5 canary. Until then, Rivet is a promising harness layer that
still depends on a sandbox, not a lighter drop-in Sandbox SDK replacement.

## Replacing the Session DO entirely

One Rivet actor could instead own product lifecycle, harness state, transcript,
credentials, and workspace coordination. That is conceptually cleaner than
two durable coordinators because it removes cross-system authority handoffs.

It is also contract-breaking. Scotty would need to re-prove or redesign:

- public route and CLI behavior over a new session locator;
- auth ownership and browser credential rotation;
- transaction and lease semantics for create, checkpoint, resume, and
  vaporize;
- hard-cap scheduling and stale-callback rejection;
- sentinel credential storage and refresh without plaintext actor persistence;
- KV projection and R2 backup generation ordering;
- Cloudflare Worker reconstruction and actor-region failure behavior;
- terminal and SSE reconnect semantics.

That may be the right v2 if the actor is meant to be the single product
authority. It should not be smuggled into the current S1–S5 implementation as
an execution optimization.
