---
name: scotty
description: Set up, diagnose, deploy, or operate Scotty cloud agents when cross-command authority, lifecycle recovery, Hatch readiness, credential pinning, or proof level matters. Use CLI help for command syntax; use this skill for sequencing, ambiguity, and completion criteria.
---

# Operate Scotty

Read current CLI help before acting; the executable and live config are authoritative for syntax.
Use the signed executable for a release. Use checkout source only when the user selects an exact
commit, and never deploy from a dirty worktree.

Names, Cloudflare targets, credential sources, repositories, and session IDs are user-supplied.
Never infer them. Bind remote mutations to the explicit target and authorized task scope; obtain
approval when that scope is missing. Do not request the same authorization again.
Redact secrets, recovery fragments, authenticated links, cookies, and nonces.

## Reason from authority

Keep these owners separate:

- The local installation pointer names deployed resources and carries root access.
- Cloud settings own agent defaults and application environment; the installation registry owns repositories.
- The credential registry owns grants, refresh leases, and immutable credential versions.
- Each Session Durable Object owns lifecycle, operation, backup, Hatch, and session-grant state.
- KV, lists, browser summaries, container files, and process memory are projections, not authority.

Identify the owner before interpreting disagreement. A fresh session is not a fresh registry lease,
credential version, or bundle; sessions remain pinned to their original grants and digest.

Distinguish `accepted`, `queued`, `running`, `completed`, `failed`, and `ambiguous`. Admission does
not prove completion. A timeout or lost response after possible dispatch is ambiguous: inspect the
owner before retrying. Never conclude from a stale projection alone.

## Upgrade and load guidance

Run `scotty upgrade` to install the latest published signed CLI and its bundled guides. Confirm
`scotty --version` and `scotty --build-info`; deployment requires `embeddedDeployment: true`.
Then read `scotty skill show` and, for live diagnostics, `scotty skill show scotty-live-observability`.
Upgrade does not deploy the Worker: review `deploy --plan --json` before an authorized
`deploy --yes --json`. The executable deploys its bundled release code, not current Git main.
Keep the managed installation/profile, Cloudflare auth, and Docker available.
Use `scotty sandbox push` with explicit `--skills-root`, `--package`, `--tools-root`, or
`--extensions-root` paths when publishing local resources.

Host-agent loaders are separate from the bundled guides. `init` and `upgrade` do not write them.
For automatic discovery, use the host agent's configured filesystem skill directory and a small
loader that runs `scotty skill show`; preserve existing custom loaders. Confirm discovery in a
fresh agent session. Container skills mount automatically. Filesystem discovery does not require
Scotty's public shared skill catalog.

## Set up an installation

Use this order, adapting command arguments from current help:

1. Verify executable provenance and freshness, prerequisites, Cloudflare target, GitHub access, and
   repository.
2. Collect the explicit installation name, preview DNS base and zone, default agent/model, repository,
   ordinary application environment, and optional private local credential sources. Keep Pi and
   Codex auth sources mutually exclusive; use a single active agent credential.
3. Review the exact init plan before approval. Init saves cloud defaults and registers the supplied
   repositories after deployment. If cloud setup fails after the local pointer is saved, retry init
   with the same name and setup flags; the CLI resumes setup without reprovisioning.
4. Confirm cloud settings, repository registration, any refreshed credential, and browser ownership.
5. Create a fresh session and prove repository access, Pi work, and any intended Hatch service.

Complete only when cloud setup, doctor, registration, browser ownership, and one fresh
warm session agree. Stop on multiple matching Pi grants, missing GitHub identity, or binding
overwrite ambiguity; never select, fabricate, or replace authority implicitly.

## Select an agent

Inspect `scotty beam --help` and cloud Settings. Precedence is explicit
`--agent`, then the saved cloud default. Use `pi` or `codex`; `codex-app-server` is not a config
value.

Cloud Codex settings own model and effort; Pi settings own provider, model, and effort. Flags
`--model` and `--effort` override only the selected profile; Pi's `--model-provider` overrides its
model provider. `--provider` remains execution placement. Beam reads cloud settings without reading local credential sources or resolving bundle
directories. The credential kinds are `pi-auth` and `github-cli`; `--codex-auth` refreshes the sole
agent credential with a local Codex OAuth source.

Codex supports creation, passive read, terminal follow-up messages, active-turn steering,
interruption, sleep/resume, and vaporize. `scotty steer` selects a new message when idle and native
steering while a turn is active. Correlate its returned turn ID with canonical read; an accepted message is not
terminal completion. A delivery-unknown response requires inspection before another submission.
Codex requires a supported model/effort pair and runs with approvals disabled and danger-full-access
inside the Scotty runtime. Sleep automatically saves conversation history through the Session
backup; resume continues the same native thread with its earlier messages and tool history.
Standalone checkpoint and Scotty's public shared skill catalog remain unavailable for Codex. Native
filesystem skills are separate. Pi keeps its
current controls.

Cloud settings changes affect new Sessions. Pi verifies requested settings before its first prompt; native
saved Session settings remain current on resume. A successful beam proves admission, so read until
the intended terminal response before claiming the agent completed work.

## Configure and repair Hatch

Hatch is a service inside a warm session, not a Cloudflare resource. The Session Durable Object owns
configuration and exposure; the extension owns its process group. `hatch.toml` is desired config,
not runtime proof.

Verify Hatch as a ladder:

1. Root config loads with argv, workspace-contained cwd, declared port, no secrets, and health path.
2. `scotty_hatch ensure` was actually invoked; a config file alone starts nothing.
3. The owned local process is running and loopback health succeeds on the declared endpoint.
4. Authoritative desired, observed, exposure, and generation agree.
5. Public DNS, TLS, and Worker routing are ready.
6. Authenticated Open Hatch handoff works. Never publish its URL.

For repair, read authoritative status once, inspect sanitized bounded logs, and correct the first
divergence. Prefer a repository fix over an inline override. Do not start a competing server,
expose a port manually, kill unrelated processes, bypass the Worker, or loop on ensure. Generation,
nonce, and expected-state checks belong inside the owner transaction; never apply stale cleanup to
a newer generation.

If local config is absent while authoritative state may exist, do not conclude `not_configured` or
recreate it. Report the disagreement and diagnose the Session boundary. Finish only when local
health, owner state, public readiness, and secure handoff pass; name any unproved rung.

## Diagnose lifecycle and clean up

Start from the Session owner, operation, backup, and generation. Projected `booting` without a
progressing operation is not healthy. When dispatch may have occurred, preserve evidence and
reconcile or escalate; do not invent a retry or force a transition.

In an operator environment, load the built-in `scotty-live-observability` skill for live canaries,
authority divergence, deployment verification, or ambiguous provider outcomes.

Snapshot, recoverable stop, and vaporize differ. Vaporize is permanent. Confirm the exact ID is
within the authorized cleanup scope before execution. Capture evidence first because deletion
removes its route.

Judge vaporize by authoritative `gone` and owned-resource deletion. Check backup, grant,
Hatch/evidence, schedules, and list projection separately. Stale list data does not negate deletion,
but cleanup has not converged until it clears. Reconcile ambiguous results before retrying.

## Deploy and prove

Bind approval to one source, plan, digest, and target. Establish checkpoint safety for affected
sessions. On drift or ambiguous provider output, obtain a fresh observed plan; never assume a timed
out operation stopped.

Track proof explicitly:

`source/static -> focused test -> local lab/browser -> release artifact -> deployed control plane -> live canary`

Creation and a clean follow-up plan do not prove Container readiness. Production requires rollout,
public readiness, and a Worker-to-Session-to-Container canary. Keep local health, fake E2E, previews,
and source tests at their actual tier. Report merge, release, install, deployment, and canary
independently.

## Read, inspect, and steer

Use passive read for transcript context and inspect for lifecycle, queues, tools, and protocol state.
Never wake a session to read; `wrong_state` is not permission to resume. A read sequence is a
snapshot cursor, not a time or message ID.

For Codex, `scotty steer SESSION MESSAGE --follow-up --idempotency-key ID` explicitly queues a
message after the current turn. Reuse the same ID and text when retrying that queue admission;
the CLI generates an ID when omitted. The browser offers “Queue after this turn” while working;
default submission still steers. Queue acceptance confirms durable storage, not native execution.
The Session DO owns pending items and retained receipts, bounded to 100 IDs and 96 KiB of serialized
admission state. Its alarm drains pending work without an open browser. Pending work survives DO
eviction and sleep; resume checks readiness before dispatch. Ordinary interrupt preserves queued
work, while vaporize removes it.

An unconfirmed-delivery notice means the queue is waiting for a matching native receipt. Across
resume, receipt reconciliation may confirm a saved admission but cannot start a replacement turn;
absent or unknown receipts retain the item. Inspect the conversation before submitting another
message under a new ID. Fence actions by session, epoch, and command/revision. After accepted steer
or follow-up, observe terminal output before claiming it ran; final message and tool-result events
reconcile streamed projections.

## Close out

Report the target, owner outcome, remaining projections, relevant versions, and highest proof tier.
Recognize authority and reconciliation defects; do not normalize them as manual recovery.
