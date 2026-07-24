# Sandbox setup performance plan

## Status and relationship to the migration packet

This plan records the behavior-preserving work proposed to reduce Scotty session
create and resume latency. It does not authorize an implementation by itself.
Each work package must pass its stated evidence gate before the next package is
evaluated.

`PLAN.md` and `IMPLEMENTATION_DAG.md` continue to define public behavior,
security, state ownership, lifecycle semantics, and credential isolation.
`EFFECT_V4_MIGRATION.md` continues to supersede their infrastructure,
runtime-framework, file-layout, and delivery-order sections. Where this plan
touches migrated code, its implementation must follow the Effect v4 chunk that
owns that code and add the module to the strict Scotty lint override in the same
change.

The central decision is:

- Keep one `ScottySandbox` Durable Object and one isolated Cloudflare container
  per Scotty session.
- Optimize work inside that boundary before introducing speculative warm
  capacity.
- Do not share Scotty sessions through Sandbox SDK execution sessions. Those
  sessions share one filesystem and process space and therefore cannot isolate
  mutually untrusted repository code.
- Do not adopt the SDK bridge warm pool in its current form. Its stopped-container
  reassignment model does not preserve Scotty's authoritative Durable Object
  identity across sleep and resume.

## Goals

1. Attribute create and resume latency to stable, redacted phases.
2. Remove container startup work Scotty does not use.
3. Reduce redundant Git network operations and Sandbox RPC round trips.
4. Reduce redundant auth-file and agent-supervisor setup.
5. Overlap independent Durable Object and container startup work without moving
   authority into runtime memory.
6. Select an instance size from deployed latency and cost evidence rather than
   assumption.
7. Preserve every existing route, CLI shape and exit code, persisted session
   semantic, lifecycle transition, and credential boundary.

## Non-goals

- Changing the public synchronous `up` contract or returning `warm` before the
  managed agent has launched.
- Replacing the official Sandbox SDK with a Scotty-owned container server.
- Sharing a container across Scotty sessions, users, or repositories.
- Moving the authoritative `SessionRecord`, operation lease, credentials,
  schedules, or backup handles out of the Sandbox Durable Object.
- Putting real credentials in the container, Alchemy state, configuration,
  arguments, logs, KV, R2, or API responses.
- Increasing `sleepAfter`, enabling `keepAlive`, or changing hard-cap semantics
  to conceal resume latency.
- Claiming a production improvement from local timing alone.

## Current baseline

### Create

The current create path is serialized:

1. Persist and project the initial `booting` record.
2. Schedule the hard cap.
3. Seed the real credential bundle and session-bound sentinels in Durable Object
   storage.
4. Execute repository discovery and workspace preparation. The first Sandbox
   command also starts the container.
5. Create `.codex`, write `auth.json`, write `config.toml`, set permissions, and
   set Sandbox environment variables through separate SDK operations.
6. Reset Sheppard state through one command.
7. Spawn Sheppard and Codex through another command.
8. Commit and project `warm`.

For a repository other than the baked Rift repository, workspace preparation
currently performs a GitHub metadata request, a full bare clone, a second fetch
of all branch heads, worktree creation, and Git configuration. RPC transport
keeps these operations on one multiplexed connection, but each command still
starts a process, waits for it, and serializes its result.

### Resume

Resume starts a fresh container as part of backup restore, restores
`/workspace/<id>`, rewrites auth/config state that is already present in the
backup, resets Sheppard state outside the backup root, and then launches Codex
resume. Restore duration is not currently separated from container cold-start,
auth setup, or agent launch duration.

### Evidence gap

The repository has lifecycle timestamps, but no canonical phase-duration events
for create or resume. Total request time alone cannot show whether the dominant
cost is Cloudflare container readiness, GitHub traffic, backup restore, process
startup, or Scotty's SDK call sequence. Optimization must therefore begin with
measurement.

## Work package P0 — phase timing and benchmark harness

### Why

Without phase measurements, a change can make a local microbenchmark faster
while leaving deployed p95 unchanged. It can also shift time between phases and
be mistaken for a net improvement. Measurement is first so every later package
has the same baseline and rollback criterion.

### Implementation

Add canonical duration events around these boundaries:

- `session.create.total`
- `session.create.control`
- `sandbox.container.ready`
- `workspace.repo_discovery`
- `workspace.repo_transfer`
- `workspace.worktree`
- `container_auth.seed`
- `agent.launch`
- `session.resume.total`
- `backup.restore`

Use `Clock` in migrated Effect domain code. Keep native host timing limited to
the mandatory Sandbox callback or container-ready boundary. Each event contains
only:

- event name;
- outcome;
- duration in milliseconds;
- session ID;
- create or resume operation kind;
- repository class (`baked` or `remote`), not the repository URL or name;
- container instance type and image version;
- fake-agent or real-agent mode.

Do not log prompts, command strings, repository names or URLs, backup contents,
credential fields, sentinels, auth JSON, environment values, or response
bodies.

Extend the deployed canary to run sequential cold create/resume samples and
record p50, p95, failure count, and phase totals. Run a fake-agent matrix first
to isolate infrastructure and workspace setup, then a smaller real-agent matrix
to prove the end-to-end boundary.

`@cloudflare/sandbox` 0.12.4 adds container labels that may improve
observability. If labels are used, upgrade the package and base image together
in a separate compatibility commit, preserve the image digest pin, and rerun
the full Sandbox contract canary. The performance plan does not otherwise
require that upgrade.

### Safety constraints

- Timing data must not alter the public API or persisted record schema.
- A telemetry failure must never fail or delay the session operation.
- Phase names must be bounded constants; no user-controlled value may become a
  metric name or label.
- Observability must retain the existing redaction proof.

### Exit gate

- At least 20 sequential cold creates and 20 cold resumes complete in a shadow
  stage with phase data.
- Fake-agent and real-agent results can be distinguished.
- p50 and p95 can be calculated per phase.
- The disclosure scan finds no prompt, repository identifier, real credential,
  sentinel, or auth body in logs.

## Work package P1 — disable unused interpreter pools

### Why

The pinned default Sandbox image configures minimum JavaScript and TypeScript
interpreter pools of three processes each. Scotty uses command, file, session,
terminal, backup, and restore APIs; it does not use the Sandbox `runCode`
interpreter API. Starting and retaining unused interpreter workers can consume
startup CPU and memory before Scotty's first useful command.

This is the narrowest optimization because it changes only unused optional
capacity inside each already-isolated container.

### Implementation

Override the base-image defaults in `worker/container/Dockerfile`:

```dockerfile
ENV PYTHON_POOL_MIN_SIZE=0 \
  JAVASCRIPT_POOL_MIN_SIZE=0 \
  TYPESCRIPT_POOL_MIN_SIZE=0
```

Add an executable contract probe that confirms:

- ordinary `exec` still works;
- file read/write still works;
- named sessions and PTY attachment still work;
- backup and restore still work;
- outbound interception still starts correctly;
- no production code calls `runCode`.

Compare container-ready and first-command latency against P0 using the same
image version, instance type, region distribution, repository class, and canary
sequence.

### Safety constraints

- Do not switch to the musl Sandbox image as part of this package. Codex,
  Sheppard, `gh`, backup tooling, and native PTY compatibility require their own
  independent proof before a libc/base-image change.
- Keep the Sandbox npm package and Docker base version paired.
- Do not remove Node, Bun, Git, backup, FUSE, or outbound-interception support
  merely because the interpreter pools are disabled.

### Exit gate

- The deployed Sandbox contract canary passes.
- No `runCode` call exists in production code.
- Container-ready or first-command p95 improves, or the change is shown to
  reduce idle resource use without regressing latency.
- Any regression or missing SDK behavior reverts this package independently.

## Work package P2 — consolidate repository and worktree bootstrap

### Why

The current workspace adapter pays both network and process overhead:

- a GitHub metadata call determines existence and default branch;
- non-baked repositories are cloned bare;
- the freshly cloned repository is fetched again using a different ref mapping;
- cleanup, worktree creation, and Git configuration are separate Sandbox
  commands.

The extra fetch is redundant for a newly cloned repository, while the command
boundaries add sequential RPC/process latency. The repository-existence probe
cannot simply be deleted because Scotty must preserve the distinction between a
missing repository, an authentication failure, and a transient network failure.

### Implementation

Replace the stale, Rift-only `worker/container/bootstrap.sh` contract with one
production workspace bootstrap command used by `Workspace.prepare`.

The command must:

1. Accept validated repository owner/name, session ID, branch, and destination
   paths as separate safe inputs.
2. Use the GitHub sentinel from the command environment; never place the real
   GitHub credential in the container.
3. Determine repository existence and default branch while distinguishing:
   - repository absent;
   - unauthorized or forbidden;
   - rate-limited;
   - transient GitHub/network failure.
4. Remove only the exact `/workspace/<id>` target after the Durable Object has
   authorized a new create operation.
5. For `anomalyco/rift`, fetch the baked bare cache once and create the worktree
   from the refreshed default-branch ref.
6. For other existing repositories, clone the branch data once, configure the
   future remote refspec without immediately repeating the transfer, and create
   the worktree from the already-cloned ref.
7. For an absent repository, initialize the existing empty-repository layout
   and remote exactly as today.
8. Configure the sentinel credential helper, `credential.useHttpPath`, and the
   `.codex/` exclude before returning.
9. Emit one bounded JSON result containing only `repoExists`, `defaultBranch`,
   and `root`.

Decode the result with Schema at the Sandbox boundary. Treat malformed output,
unexpected exit status, and mismatched paths as typed setup failures. Do not
infer success through manual shape probing.

Keep the baked Rift repository for the first benchmark. It is small and
currently avoids a full clone at session creation. Removing it or replacing it
with a shared mutable cache is a separate decision because shared mutable
repository state creates cache-poisoning and cross-session risks.

### Safety constraints

- Preserve latest-default-branch behavior at the moment of create.
- Preserve private repository access through the sentinel egress proxy.
- Preserve existing missing-repository behavior used by later `pr` publishing.
- Do not shallow or filter history unless a separate compatibility proof shows
  that Codex, Git operations, publish, beam-down, and user workflows retain the
  expected repository history and remote branches.
- Do not mount or restore a cross-session mutable cache.
- The bootstrap script must not print the sentinel, auth headers, Git
  credential-helper output, or remote URL credentials.

### Exit gate

- Existing, private, absent, renamed-default-branch, forbidden, rate-limited,
  and transient-failure cases have contract tests.
- Hostile owner/name, session ID, branch, and path fixtures cannot inject shell
  syntax or broaden deletion scope.
- A non-baked create performs no redundant second object transfer.
- Workspace preparation uses one top-level Sandbox command after container
  readiness.
- Workspace phase p95 improves without changing the checked-out SHA or published
  branch behavior.

## Work package P3 — reduce auth seeding round trips

### Why

Container auth currently performs directory creation, two sequential file
writes, a permission command, and a global environment update as separate SDK
operations. The two files are independent after the directory exists, and most
runtime call sites already pass the complete sentinel environment explicitly.

The optimization is not to weaken file permissions or make sentinels secret.
It is to reduce sequential transport/process waits while keeping real
credentials outside the container.

### Implementation

1. Create the `.codex` directory with mode `0700`.
2. Write sentinel `auth.json` and generated `config.toml` concurrently through
   the Sandbox file API.
3. Apply file mode `0600` in one checked command, or use a verified SDK file-mode
   facility if the pinned source exposes one.
4. Build a call-site matrix for every command, managed process, terminal
   session, publish operation, rollout discovery, checkpoint, and beam-down
   operation.
5. Remove global `setEnvVars()` only if the matrix proves that every consumer
   receives its required explicit environment and a deployed reconstruction
   test passes. Otherwise retain it and count it as one required operation.
6. On resume, continue refreshing sentinel auth/config if the deployed image
   can change config semantics between backup creation and restore. Optimize
   the writes; do not blindly trust stale backed-up config.

### Safety constraints

- Keep `auth.json` and `config.toml` under `/workspace/<id>/.codex`.
- Keep directory mode `0700` and file modes `0600`.
- Only sentinel values may be written.
- Never embed the real credential bundle in a shell command, stdin, temporary
  file, or process argument.
- Do not remove explicit command/session environments merely because a global
  environment exists.

### Exit gate

- Container-surface scans still find only session-bound sentinels.
- Auth/config permissions are exact after create and resume.
- Codex, GitHub publish, PTY reconnect, OAuth rotation, and DO reconstruction
  pass.
- Auth-seed p95 improves or the number of sequential transport rounds is
  reduced with no latency regression.

## Work package P4 — combine Sheppard reset and agent launch

### Why

Agent launch currently executes a standalone Sheppard cleanup command followed
by the spawn command. On a fresh container, `/tmp` cannot contain a prior
Sheppard socket. On resume, only `/workspace/<id>` is restored; Sheppard's
socket under `/tmp` and state under `/root` are not restored. A separate reset
round trip therefore normally cleans paths that cannot have survived the
container restart.

Defensive cleanup still matters for a retry in the same runtime, so it should
be folded into the launch operation rather than removed without a lifecycle
proof.

### Implementation

- Build one checked launch command that:
  1. creates the Sheppard state directory;
  2. terminates a matching prior managed Sheppard instance only when its exact
     socket/state contract is present;
  3. removes only the known socket, lock, and state files;
  4. spawns the authoritative agent tab;
  5. returns the bounded Sheppard JSON result.
- Preserve the fake-agent and real-agent command variants.
- Decode the spawn result and require the expected managed tab identity before
  the session can become `warm`.
- Test initial create, resume after managed stop, resume after unexpected host
  loss, same-runtime retry, and concurrent launch rejection.

### Safety constraints

- Do not use broad process-name killing or unbounded file globs.
- Do not mark `warm` merely because the shell command started; retain the
  existing managed-agent readiness contract.
- Keep prompts out of logs and error details.
- Preserve pause/resume/checkpoint ownership of the same Sheppard process group.

### Exit gate

- Agent setup uses one Sandbox command.
- All create/resume/retry lifecycle fixtures attach to exactly one authoritative
  agent tab.
- Checkpoint and reconnect tests pass.
- Agent-launch p95 improves without increasing launch failure rate.

## Work package P5 — overlap independent cold-start work

### Why

Hard-cap scheduling and credential seeding are Durable Object operations that
do not require a running container. Container provisioning can take seconds.
Running these independent operations serially places their full durations on
the critical path even though none consumes the other's result.

Concurrency is introduced only after the individual phases are measured and
simplified, so failure ownership and cleanup remain observable.

### Implementation

After the initial `booting` record is durable and projected, start these
operations concurrently:

```text
                      ┌─ schedule hard cap
durable boot record ──┼─ seed credential bundle
                      └─ start container and wait for control-port readiness
                                      │
                                      ▼
                       workspace → auth → agent → warm
```

Use scoped Effect concurrency in migrated domain code. Preserve the native
Sandbox host call only at the official container boundary. Await all three
results before workspace preparation. If any branch fails:

- fail the same create operation lease;
- cancel or stale-reject the scheduled hard-cap payload as today;
- retain or delete credential state according to the existing failed-create
  contract;
- destroy the failed runtime through the bounded cleanup path;
- never publish `warm`.

Resume may similarly overlap hard-cap rescheduling with container/restore
preconditions only where the pinned backup API permits it. Do not start restore
until the exact container and backup ownership contract has been verified.

### Safety constraints

- The persisted operation lease remains the concurrency authority.
- No fork may update the session status independently.
- No global runtime or in-memory promise becomes authoritative.
- Interruption must reach container startup and other host operations where the
  host exposes a cancellation signal.
- A late completion from a failed or vaporized operation must be rejected by
  nonce and lifecycle guards.

### Exit gate

- Fault injection at every branch and join point proves one final state.
- Vaporize during boot prevents every late container touch.
- Hard-cap scheduling and cleanup remain idempotent.
- Total create p95 improves beyond the sum of noise in the P0 baseline.

## Work package P6 — instance-size experiment

### Why

The current deployment selects `standard-2`. Current Cloudflare documentation
lists it as one vCPU, 6 GiB memory, and 12 GB disk; `standard-3` provides two
vCPUs, 8 GiB memory, and 16 GB disk. More CPU may reduce image initialization,
Git object processing, and agent startup, but it cannot remove network latency
and increases provisioned memory and disk cost.

Changing instance size before removing unused work could pay to run the same
inefficiencies faster. This experiment therefore follows P1–P5.

### Implementation

Deploy identical optimized images to shadow stages using `standard-2` and
`standard-3`. Compare:

- cold create and resume p50/p95;
- container-ready, repository, restore, and agent phase p50/p95;
- failure and timeout rates;
- CPU-active time;
- provisioned memory/disk duration and estimated monthly cost;
- representative build/test duration during an agent session.

Keep request origin, repository class, fake/real agent mode, image digest, and
sample sequence equivalent. Run enough sequential samples to avoid exhausting
`max_instances` or measuring rollout provisioning.

### Safety constraints

- Do not change `max_instances`, sleep, hard-cap, or warm capacity in the same
  experiment.
- Do not infer a result from a single region or one cold start.
- Preserve enough disk for backup restore and representative repository builds.

### Exit gate

Adopt `standard-3` only when the measured latency or interactive-build
improvement meets an explicitly reviewed cost threshold. Otherwise retain
`standard-2`. Record the result either way so the experiment is not repeated
without new evidence.

## Warm pool decision

### Why the stock pool is excluded

The pinned SDK bridge pool maps a logical sandbox ID to a prestarted container
Durable Object. When the assigned container is no longer running, the pool
deletes that assignment and allocates another Durable Object. Scotty stores the
authoritative session record, operation lease, real credential bundle, hard-cap
schedule, and backup handles in the originally assigned Sandbox Durable Object.
Reassignment would therefore route resume to an object that does not own the
session.

Warm containers also count toward the application's running-instance ceiling
and accrue container memory/disk charges while idle. With the current
`max_instances: 10`, a target of one idle warm container reserves ten percent of
the configured concurrency before any user session consumes it.

### Conditions for reconsideration

Revisit a Scotty-specific warm pool only if:

1. P0–P6 are complete and cold-start p95 still misses an approved product
   target.
2. Arrival rate and measured saved latency justify continuous warm cost.
3. A design preserves a stable logical-session-to-authoritative-DO mapping
   across stop and resume.
4. Egress `containerId` still resolves to the one DO that owns the presented
   sentinel and real credential bundle.
5. Prewarmed, unassigned objects contain no credential or user state.
6. Assigned containers are never shared or returned to the clean pool.
7. Pool failure, DO reconstruction, deployment rollout, hard cap, vaporize, and
   backup ownership have deployed contract tests.

That design is an architecture change and requires explicit approval in
`PLAN.md`, `IMPLEMENTATION_DAG.md`, and `EFFECT_V4_MIGRATION.md`; it is not a
performance implementation detail.

## Delivery sequence

Use separate reviewable changes:

1. **Measurement:** P0 timing events, redaction tests, and deployed benchmark
   harness.
2. **Image:** P1 interpreter-pool override and Sandbox contract canary.
3. **Workspace:** P2 bootstrap alignment, Schema decoding, and Git behavior
   contracts.
4. **Auth:** P3 auth-seed round-trip reduction and environment call-site proof.
5. **Agent:** P4 single-operation Sheppard launch and lifecycle fixtures.
6. **Concurrency:** P5 cold-start overlap with fault injection.
7. **Sizing:** P6 shadow-stage A/B and recorded decision.

Formatting precedes lint for every implementation change. Each change runs the
focused tests plus:

```sh
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
```

Container and lifecycle packages additionally run the deployed Sandbox canary
before a production performance claim is made.

## Final acceptance gate

The performance work is complete only when:

- public routes, CLI JSON, exit codes, and session transitions are unchanged;
- one Sandbox Durable Object/container remains the isolation and authority
  boundary for each Scotty session;
- create, resume, checkpoint, hard cap, PTY reconnect, publish, beam-down, and
  vaporize contract tests pass;
- real credentials remain absent from every container and persistence surface;
- fake-agent cold create and resume each improve deployed p95 by at least 20
  percent or at least one second;
- real-agent canaries show no increase in setup failure rate;
- the selected instance size has a recorded latency/cost decision;
- a following Alchemy plan is a no-op;
- results are described as production-proven only after the deployed canary and
  disclosure scan pass.

If the measured gain is below the threshold, keep only changes that independently
reduce resource use or complexity without regression, record the negative
result, and do not introduce a warm pool to force a headline latency number.

## Source evidence

- [Cloudflare Sandbox session management](https://developers.cloudflare.com/sandbox/concepts/sessions/)
  documents that execution sessions share a filesystem and process space and
  are not a security boundary.
- [Cloudflare Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
  documents container placement and the expected cold-start range.
- [Pinned Sandbox 0.12.3 Dockerfile](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/Dockerfile)
  defines the default JavaScript and TypeScript interpreter pool sizes.
- [Pinned Sandbox 0.12.3 warm-pool source](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/bridge/warm-pool.ts)
  defines assignment removal and replacement after a container stops.
- [Cloudflare Container limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/)
  defines the current `standard-2` and `standard-3` resources.
- [Cloudflare Container pricing](https://developers.cloudflare.com/containers/pricing/)
  defines active-container memory, CPU, disk, and egress billing.
