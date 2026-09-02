---
name: scotty
description: Set up, diagnose, deploy, or operate Scotty cloud agents when cross-command authority, lifecycle recovery, Hatch readiness, credential pinning, or proof level matters. Use CLI help for command syntax; use this skill for sequencing, ambiguity, and completion criteria.
---

# Operate Scotty

Read current CLI help before acting; the executable and live config are authoritative for syntax.
Use the signed executable for a release. Use checkout source only when the user selects an exact
commit, and never deploy from a dirty worktree.

Names, Cloudflare targets, credential sources, repositories, and session IDs are user-supplied.
Never infer them. Show the exact target and obtain approval immediately before remote mutation.
Redact secrets, recovery fragments, authenticated links, cookies, and nonces.

## Reason from authority

Keep these owners separate:

- Local TOML declares capability sources, repository policy, and credential-source pointers.
- Installation state owns the deployed resource identity and registered repositories.
- The credential registry owns grants, refresh leases, and immutable credential versions.
- Each Session Durable Object owns lifecycle, operation, backup, Hatch, and session-grant state.
- KV, lists, browser summaries, container files, and process memory are projections, not authority.

Identify the owner before interpreting disagreement. A fresh session is not a fresh registry lease,
credential version, or bundle; sessions remain pinned to their original grants and digest.

Distinguish `accepted`, `queued`, `running`, `completed`, `failed`, and `ambiguous`. Admission does
not prove completion. A timeout or lost response after possible dispatch is ambiguous: inspect the
owner before retrying. Never conclude from a stale projection alone.

## Set up an installation

Use this order, adapting command arguments from current help:

1. Verify executable provenance and freshness, prerequisites, Cloudflare target, GitHub access, and
   repository.
2. Validate mode-0600 local TOML before `init`. It contains pointers and policy, never credentials.
   A repository-scoped GitHub grant must be no broader than the allow-list.
3. Review the exact init plan before approval. If resource creation succeeds but final config or
   bundle sync fails, preserve the installation pointer, fix the local cause, and run `sync`; do not
   rerun create-only init.
4. Sync, register the repository, and establish browser ownership. Local allow-list, credential
   scope, synchronized grant, and deployed registration are separate checks; registration repairs
   none of the others.
5. Create a fresh session and prove repository access, Pi work, and any intended Hatch service.

Complete only when config validation, sync, doctor, registration, browser ownership, and one fresh
warm session agree. Stop on multiple matching Pi grants, missing GitHub identity, or binding
overwrite ambiguity; never select, fabricate, or replace authority implicitly.

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

Snapshot, recoverable stop, and vaporize differ. Vaporize is permanent and requires approval for
the exact ID immediately before execution. Capture evidence first because deletion removes its route.

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

Queue and steer are different intents. Fence actions by session, epoch, and command/revision. Never
replay ambiguity. After accepted steer or follow-up, observe terminal output before claiming it ran;
final message and tool-result events reconcile streamed projections.

## Close out

Report the target, owner outcome, remaining projections, relevant versions, and highest proof tier.
Recognize authority and reconciliation defects; do not normalize them as manual recovery.
