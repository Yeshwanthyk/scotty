---
title: Define the alpha release gates
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by:
  - Define the trusted-runner parity contract
  - Define the CLI and TUI contract
  - Define the minimum browser surface
  - Define the single-executable boundary
  - Define the clean state and schema cutover
---

## Question

Which focused checks run for each change, which checks gate Publish, which deployed canary proves the complete repository and Session lifecycle on each provider, and what complete end-result walkthrough must pass before the alpha can ship?

## Inherited proof requirements

The gates must prove owner revision checks, operation replay, projection repair, missing immutable
payload handling, baseline and atomic checkpoint creation, same-Session Resume, inactivity and
repeatable hard caps, Credential-object encryption, future-Session generations, OAuth refresh, dormant Hatch activation, Hatch generation
revocation, authenticated screenshot and video capture and display, interrupted capture, exact
checked Publish points, Publish/Vaporize races, ambiguous provider results, proven deletion, orphan
cleanup, dirty-work exclusion, agent-created commit selection, check mutation isolation, failed-check
blocking, fresh merge previews, base drift and merge conflict, public and private exact-commit
refresh, moving-ref detection, deterministic Fork replay, repeated Publish, fast-forward pull-
request updates, preserved human metadata, external branch conflicts, ambiguous push and pull-
request recovery, exact branch cleanup, provider-local sentinel brokers, operation-token replacement
and revocation, forbidden credential
surfaces, Cloudflare Artifacts behavior, and Runner parity. Deterministic local tests are the first
gate; provider facts require the guarded disposable deployed canary.

## Inherited repository cleanup gate

The alpha gate must prove that `spikes/` no longer exists, promoted production code and canaries
run from their owning locations, package scripts reference those locations, retained findings live
under `docs/research/`, and no source, test, config, or build path still imports the removed tree.

## Inherited staged-result gate

Deployment and credential canaries must assert the full staged failure envelope at validation,
preflight, plan, preparation, apply, activation, verification, broker, and cleanup boundaries. A
generic provider failure, guessed rollback, missing retained-state report, or secret-bearing error
fails the alpha gate.

## Inherited Sandbox setup gate

The alpha gate must prove setup without local Pi, Pi-setting allowlist rejection, no hardcoded
provider/model/thinking, standard config generation, deterministic Plugin ordering and collision
failure, one Pi RPC process, Session-only model and thinking Resume, standard tool inventory,
absence of `gh` and real credentials, dormant Hatch and capture activation, staged startup failure,
same-image local tests, image settlement, and provider-parity canaries.

## Inherited local-state gate

The gate must prove XDG overrides, keychain and private-file credential fallback, exact permissions,
secret-free journals, remote reconciliation, unresolved retention, diagnostic and cache bounds,
automatic pruning, narrow self-unpair, root retention through ambiguous uninstall, clean legacy
removal, Runner receipt bounds, memory-only sentinels, and absence of raw Pi, GitHub, custom, or
Session credentials from every local tree.

## Inherited trusted-Runner gate

The Runner gate must prove one-use setup grants, local proof before registration activation,
identity replacement, exact executable/protocol/image/Pi/setup digests, light health, capacity
races and reservation replay, accepting/draining/disabled behavior, Docker and egress isolation,
typed operations with no general host execution, native Pi RPC, every credential broker, exact
Fork Git and Publish, atomic checkpoint and Resume, idle and hard caps, the five-minute offline
lease, Hatch HTTP and WebSocket relay, screenshot and video capture, drain and update, normal
removal, lost-host abandon, receipt bounds, and forbidden credential surfaces. A connected Runner
without this proof must not be offered for Session creation.

## Inherited clean-cutover gate

The gate must prove that each merged slice has one owner and one schema, with no replaced writer,
reader, decoder, command, provider route, test, feature flag, or compatibility helper. It must
prove the complete removal of the desktop and sidecar, legacy local roots, old Session states,
direct credential and GitHub paths, parallel Pi startup, production Runner host execution, and
`spikes/` dependencies.

Before the fresh end-result canary, the guarded development reset must show its sanitized plan,
preserve external GitHub state, clear only proven Scotty-owned resources, verify absence, and
report exact retained cleanup debt. The release proof then starts from one fresh canonical
Installation. Partial reset, ambiguous deletion, or reliance on old deployed state fails the gate.

## Resolution

Alpha uses four proof levels. A small proof runs close to each change. Expensive provider proof
runs only when its provider contract is ready. Cloudflare is implemented and proven first. Trusted
Runner production implementation starts only after the complete Cloudflare canary passes. Runner
proof is the final provider phase. Both providers must pass before the first alpha ships.

Passing means a fresh result from the exact candidate. A failed check produces the smallest clean
vertical fix and a new candidate. Scotty does not turn a failed candidate green through a blind
rerun. Remote ambiguity is reconciled against the authoritative owner before cleanup or another
run begins.

### Gate 1: every agent-owned pull request

Each pull request runs the smallest deterministic set that proves its complete vertical slice:

- formatting for changed source;
- the changed module's lint rules, including any matching Scotty Effect skill rules;
- affected TypeScript builds and typechecks;
- focused unit, Schema boundary, service contract, operation replay, race, and recovery tests;
- affected host-adapter contract tests with deterministic fakes;
- credential, path, log, response, Alchemy-state, and generated-output scans when the slice touches
  a protected boundary;
- exact old-path absence checks for the schema, command, reader, writer, route, state, or test that
  the slice replaces; and
- focused executable, image, browser-asset, or protocol checks when those release inputs change.

The pull request must show the command and result for every relevant check. It must say why an
otherwise expected check did not run. Unrelated provider canaries do not run for a pure local or
documentation change. A partial implementation, skipped affected proof, unexplained flake, or
remaining replaced path prevents merge.

### Gate 2: integrated deterministic baseline

The integration branch and every release candidate run the full repository baseline in final
formatted source order:

```text
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
```

Release CI also builds and probes all four supported native executable targets, inventories and
secret-scans the exact OCI image, checks its signed manifest and digest, validates embedded Worker
and browser assets, and runs the static clean-cutover searches. The gate proves that `spikes/`, the
desktop and sidecar, old local roots, old Session states, migration unions, direct credential and
GitHub paths, parallel Pi startup, general production Runner execution, dead commands, and
compatibility packaging no longer exist or remain referenced.

This baseline uses deterministic clocks, fakes, and contract adapters for races, replay, provider
ambiguity, and failures. It does not claim a real provider fact from a fake.

### Publish gate inside the product

Publish validates one Prepared Publish point. It runs only the administrator-declared check policy
against the exact agent-created commit in an isolated clean worktree. Scotty does not infer extra
commands, create a commit, repair dirty work, or let a check mutate the Session Fork. A changed
commit, base, Fork revision, deployed snapshot, credential generation, check policy, result, or
evidence requires a new preparation.

Every required check must finish successfully. A missing tool, timeout, mutation, dirty exclusion,
failed check, stale merge preview, base drift, conflict, unknown result, or ambiguous provider write
blocks Publish with the common staged result. The repository bridge then proves the exact
controlled branch and pull request result. It reconciles an ambiguous push or pull-request write
before retry. Publish proof is identical for Cloudflare and Runner Sessions because GitHub and the
Config-owned repository operation remain authoritative.

### Gate 3A: Cloudflare first

After shared contracts are stable, implementation completes the Cloudflare product path. Changes
to Cloudflare deployment, lifecycle, storage, credentials, repository flow, image, runtime, Hatch,
capture, or cleanup run the affected guarded Cloudflare canary. The complete Cloudflare canary
must pass before trusted Runner production work begins.

The complete canary starts from dedicated disposable fixtures and proves:

- setup without local Pi, Node, Docker, Bun, or `gh`;
- strict config validation, standard config generation, Plugin order and collision handling,
  atomic snapshot activation, image settlement, and staged deployment failures;
- owner and paired-client Auth, encrypted named Credential generations, protected Import, Codex
  OAuth refresh, future-Session replacement, Session generation isolation, and every provider-local
  broker without a forbidden plaintext surface;
- public and private exact-commit Mirror refresh, moving-ref detection, deterministic Fork creation
  and replay, normal agent Git, exact checked Publish, repeated fast-forward pull-request updates,
  preserved human metadata, external conflicts, ambiguous-write recovery, and branch/Fork cleanup;
- owner revision checks, one operation lease, replay, projection repair, missing immutable payloads,
  orphan reconciliation, and truthful staged results;
- Create through baseline Checkpoint, Warm work, Snapshot, Sleep, same-Session Resume, inactivity
  shutdown, repeatable hard caps, and current Checkpoint recovery;
- dormant Hatch and capture for backend work, explicit Hatch HTTP and WebSocket activation,
  generation revocation, authenticated screenshot and video storage and display, interrupted
  capture, and cleanup;
- Publish/Vaporize races, failed and ambiguous provider effects, exact R2 and Artifacts ownership,
  proven Vaporize, and repeatable cleanup; and
- one supervised Pi RPC process, configured model and thinking, standard tool inventory, no `gh`,
  and no real credential in compute, files, environment, arguments, Git config, logs, responses,
  state, backups, evidence, or Alchemy data.

Cloudflare passing establishes the deployed reference behavior. It does not waive Runner parity or
permit a Cloudflare-only alpha release.

### Gate 3B: trusted Runner last

Trusted Runner production implementation begins only after Gate 3A passes. Runner work reuses the
proven shared contracts and Cloudflare behavior. Focused local Docker, protocol, broker, watchdog,
receipt, and host-adapter tests run with its implementation. The deployed Runner canary runs as the
final provider phase, not during Cloudflare development.

The complete Runner canary repeats the same repository, credential, lifecycle, Publish, Hatch,
capture, checkpoint, Resume, and cleanup product proof. It also proves one-use setup grants,
identity replacement, exact release and capability digests, light health, orchestrator capacity
races, reservation replay, accepting/draining/disabled modes, Docker and egress isolation, no
general host execution, native Pi RPC, five-minute offline control lease, local hard-cap watchdog,
outbound Hatch relay, update, normal removal, lost-host abandon, receipt bounds, and forbidden
Runner-local credential surfaces.

Runner-backed Session creation remains disabled until this canary passes for the exact release.
Failure returns to a focused Runner vertical fix and a new candidate. It does not reopen or bypass
the proven Cloudflare contract unless the failure identifies a shared-contract defect; such a
defect requires the affected Cloudflare proof again.

### Canary fixtures and cleanup

Deployed proof uses a dedicated Cloudflare test account or stage, a dedicated Linux Runner,
dedicated public and private GitHub fixture repositories, canary-only credential generations, and
one unique run ID. It never operates on a normal development Session, personal repository, or
personal credential.

Each run records a sanitized resource ledger before mutation. Cleanup verifies each owned Session,
container, process, Hatch generation, evidence object, workspace backup, Fork, controlled branch,
projection, identity, reservation, and temporary deployment. A failed cleanup blocks fixture reuse.
The run retains its sanitized result and exact cleanup debt. It retains no secret, prompt,
workspace content, unsafe URL, raw provider response, or credential-bearing configuration.

### Gate 4: fresh release acceptance

After both provider canaries pass, the exact release candidate runs from the clean-cutover state.
The guarded development reset prints its sanitized plan, preserves external GitHub state, clears
only proven Scotty-owned development resources, and verifies absence. The candidate then deploys
one fresh canonical Installation.

A release agent runs one repeatable automated walkthrough and records sanitized machine-readable
results. The walkthrough proves:

1. verified installation of one native executable into an empty home without local Pi, Node,
   Docker, Bun, `gh`, a desktop application, a sidecar, or a Scotty checkout;
2. resumable setup, browser ownership, terminal pairing, standard configuration, Pi and GitHub
   login, one custom Credential, Sync, readiness, and a first real Pi response;
3. public and private repository registration and one full Cloudflare Session from Create through
   Git work, dormant and active Hatch/capture, evidence display, Checkpoint, Sleep, Resume, Publish,
   and proven Vaporize;
4. the same complete Session outcome on the certified named Runner;
5. credential replacement affecting only future Sessions, safe client revocation and root
   recovery behavior, clear staged failure output, projection repair, and interrupted-operation
   reconciliation; and
6. signed update behavior, final cleanup, Runner removal or retained registration as declared by
   the fixture, and proven uninstall without losing unresolved cleanup authority.

A human then reviews the terminal setup, TUI interaction, browser handoff, Hatch, screenshot,
video, evidence, pull request, errors, and cleanup report. The human does not manually reproduce
every deterministic race. Human rejection blocks release even when automation passed.

### Failure and candidate policy

Every failed check keeps its result. The team finds the first contract divergence, implements the
smallest complete vertical fix, and creates a new candidate. It may replay the same remote operation
identity only after the authoritative owner and provider effect prove that replay is safe. This is
reconciliation, not a blind test rerun.

An unexplained flake, generic provider error, guessed rollback, secret-bearing result, stale proof,
failed cleanup, retained unknown resource, ambiguous write, skipped required check, or difference
between the tested and released executable, image, snapshot, protocol, or assets blocks alpha.

This decision completes the alpha specification. It defines proof and release acceptance. It does
not implement product code, run the destructive reset, or approve a release candidate.

## Decision trail

- Run focused deterministic checks for every agent-owned vertical pull request.
- Run affected deployed Cloudflare canaries only for changes that can alter Cloudflare facts.
- Complete and prove Cloudflare before beginning trusted Runner production implementation.
- Run the complete deployed Runner canary as the final provider phase.
- Require both providers before the first alpha ships.
- Use dedicated disposable Cloudflare, Runner, GitHub, and Credential fixtures.
- Use automation for repeatability and a human acceptance pass for the final experience.
- Treat a failed test as a request for the smallest clean vertical fix and a new candidate, not a
  blind rerun.
- Reconcile remote ambiguity and prove cleanup before another run or fixture reuse.
