---
title: Scotty alpha specification
label: wayfinder:map
tracker: local-markdown
---

## Destination

Produce an approved alpha specification for Scotty. It must settle the first-user journey, product surfaces, runtime, compute, repository flow, credentials, state ownership, clean code target, and release proof so implementation does not need to make product or architecture decisions.

## Notes

- Plan decisions. Do not implement product changes inside this map.
- Use plain human language and the shared terms in [`CONTEXT.md`](../../CONTEXT.md).
- Use `grilling` and `domain-modeling` for human decisions.
- Use `stateful-systems`, `yesh-how`, and `yesh-architect` for state and architecture decisions.
- Use Luna high for scouts and research, Sol medium for implementation and verification, and Luna max for small tasks.
- Local ticket metadata uses `status`, `label`, `mode`, `assignee`, and `blocked_by`. An open ticket with no assignee and no open blockers is on the frontier.

## Decisions so far

- [Set the alpha destination](tickets/set-alpha-destination.md) — Produce an approved human-first alpha specification that also gives agents stable CLI contracts.
- [Choose the alpha product surfaces](tickets/choose-alpha-product-surfaces.md) — Lead with CLI and TUI, keep a small browser surface, retain Hatch support, and remove the desktop application.
- [Choose the alpha compute scope](tickets/choose-alpha-compute-scope.md) — Ship Cloudflare and trusted runners with the same core lifecycle and explicit provider selection.
- [Choose the runtime and configuration model](tickets/choose-runtime-configuration-model.md) — Use Pi, one private config, one deployed snapshot, one Sandbox setup, and administrator-controlled typed Plugins.
- [Choose the model login boundary](tickets/choose-model-login-boundary.md) — Reuse Pi login for API keys and Codex OAuth instead of building a parallel authentication system.
- [Choose the repository model](tickets/choose-repository-model.md) — Keep GitHub authoritative and give each Session an isolated Cloudflare Artifacts Fork.
- [Choose Publish and repository cleanup](tickets/choose-publish-and-cleanup.md) — Publish only when requested, create a GitHub pull request, and delete the Session Fork on Vaporize.
- [Choose the Session credential lifecycle](tickets/choose-session-credential-lifecycle.md) — Use a stable immutable Session grant with pinned credential generations and sentinel-only compute access.
- [Set the clean-code gate](tickets/set-clean-code-gate.md) — Keep one canonical schema and remove superseded code at every implementation stage.
- [Choose the alpha proof boundary](tickets/choose-alpha-proof-boundary.md) — Use the full product walkthrough as end-result proof rather than as every canary check.
- [Define the first-use and readiness contract](tickets/define-first-use-contract.md) — Guide one resumable path from an installed executable through a freshly evaluated Ready Installation to a first real response in a Connected Session.
- [Prove the Cloudflare Artifacts Git path](tickets/prove-artifacts-git-path.md) — Keep Artifacts for isolated Session Forks; the pinned stack proves Git and token primitives while Scotty must own private Mirror refresh and sentinel access.
- [Define the config and Plugin contract](tickets/define-config-and-plugin-contract.md) — Use one strict private config, built-in or local-path typed Plugins, atomic Sync, and one active digest-pinned snapshot for new Sessions.
- [Define the authoritative state model](tickets/define-authoritative-state-model.md) — Give every mutable fact one owner, keep immutable payloads separate, and treat readiness, projections, caches, and runtime state as non-authoritative.
- [Define the canonical Session lifecycle](tickets/define-session-lifecycle.md) — Use four stable states, complete R2-backed checkpoints, bounded Warm activations, same-Session Resume, dormant Hatch and capture capabilities, and proven Vaporize cleanup.
- [Define the CLI and TUI contract](tickets/define-cli-and-tui-contract.md) — Use explicit noun-first commands, one resumable setup, universal terminal results, and a TUI limited to connected Pi work plus truthful lifecycle projections.
- [Choose the GitHub–Artifacts bridge and Session Git boundary](tickets/choose-github-artifacts-bridge.md) — Refresh exact verified GitHub commits through one Scotty bridge and give Warm Sessions sentinel-only access to their own Fork through a provider-local broker.
- [Define the credential and login state machine](tickets/define-credential-state-machine.md) — Store one Installation wrapping key in Account Secrets Store, keep encrypted general credential generations in a Credential object, and deliver only through typed provider-local brokers.
- [Define the Mirror, Fork, and Publish state machine](tickets/define-repository-state-machine.md) — Let agents own explicit commits, validate exact prepared points, safely create or update controlled GitHub pull requests, and prove repository cleanup.
- [Define the thin Sandbox setup](tickets/define-thin-sandbox-setup.md) — Use one supervised Pi runtime, safe config-driven behavior, a removable standard tool Plugin, and built-in dormant Hatch and capture capabilities.
- [Define local state retention and cleanup](tickets/define-local-state-retention-cleanup.md) — Use standard config, state, and cache roots; keep only device identity credentials locally; reconcile secret-free journals remotely; and prune only disposable state.
- [Define the trusted-runner parity contract](tickets/define-runner-parity-contract.md) — Certify the exact Docker Runner release, let the orchestrator reserve capacity, relay full lifecycle and Hatch capability, and keep creation disabled until deployed parity proof passes.

- [Define the clean state and schema cutover](tickets/define-clean-cutover.md) — Replace and delete each old contract in one agent-owned slice, then use a guarded development reset before a fresh canonical deployment.

- [Define the alpha release gates](tickets/define-alpha-release-gates.md) — Prove Cloudflare first, build and prove trusted Runner last, then require both provider canaries plus automated and human acceptance before alpha.

- [Define the minimum browser surface](tickets/define-browser-alpha-surface.md) — Preserve the current browser product; flow in only requirements already settled by the alpha contracts.
- [Define the single-executable boundary](tickets/define-single-executable-boundary.md) — Ship one native CLI/TUI binary with embedded deployment payloads and a signed GHCR Sandbox image digest while deployed browser and state owners remain remote.

## Not yet specified

None. The current alpha questions are sharp enough to live in decision tickets.

## Out of scope

- Multiple installation profiles.
- Live credential or grant changes to an existing Session, except Codex OAuth refresh within its pinned generation.
- Credential delivery protocols beyond Pi, GitHub, Artifacts Git, and exact-origin HTTPS-header injection.
- Changing the Sandbox setup of an existing Session.
- Compatibility layers for unpublished V2 or V3 state.
- Automatic Publish after every Session.
- Reintroducing or maintaining a desktop application or desktop compatibility layer.
- Modal or Daytona implementation.
- Plugin distribution, signing, and upgrade systems beyond the minimum alpha manifest.
- Long-term Artifacts recovery and scale policy beyond deterministic cleanup on Vaporize.
- Git LFS and submodule materialization.
- Running the complete product walkthrough for every canary.
