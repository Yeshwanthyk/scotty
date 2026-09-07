---
name: configuring-codex-app-server
description: Configure Scotty's pinned Codex app-server, managed credential sentinels, Session-fenced lifecycle, and native readiness checks. Use when changing Codex selection, runtime startup, authentication projection, or protocol handling.
---

# Configure Codex app-server

The Session Durable Object owns lifecycle, operation leases, grants, runtime generation, and
persisted selection. Native Codex thread and turn IDs are adapter state, not a second authority.

## Ground the boundary

1. Read `AGENTS.md`, `protocol/agent-selection.ts`, `protocol/codex-model-capabilities.ts`, and
   the current Session and Credential Registry contracts.
2. Inspect the pinned native package and protocol evidence in `docs/research/codex-agent-pin.md`.
   The current pin is `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.
3. Trace `worker/src/agent/codex/` through the private runtime server and public Session adapter.
   Use the matching Effect skills and pinned Effect rc.112 source before changing async patterns.
4. Identify each durable owner, native callback, deadline, and unknown-after-dispatch outcome before
   coding. Preserve existing Pi behavior and keep Runner-backed Session creation disabled.

## Selection and credentials

`[agent].default` selects `pi` or `codex`. Explicit CLI fields override only the selected
`[agents.pi]` or `[agents.codex]` profile. Codex requires a supported model and effort; no invented
model default or cross-profile fallback. Read the shared capability catalog rather than maintaining
another model whitelist. Existing Sessions retain their authoritative selection.

Reuse the current `pi-auth` Credential Registry declaration, Session-pinned grant, and managed
egress projection. `protocol/credentials.ts` accepts `pi-auth` and `github-cli`; it does not expose a
`codex-auth` importer. Ordinary config parsing and `beam` do not read credential source files.
Credential synchronization must remain separately authorized and use the existing sync workflow.

Real Codex/GitHub credentials never enter container files, environment, process arguments, archives,
R2, logs, API output, or Alchemy props/state. Codex receives only a Session-bound sentinel. The
managed Responses endpoint is fixed to `https://chatgpt.com/backend-api/codex`; egress checks the
Session grant and substitutes the pinned credential. Do not add native OAuth import, an ambient
`auth.json` search, arbitrary production endpoints, or a native credential-file exception.

## Native process and admission

- Preserve the complete official package and its helpers/resources. Do not flatten it to one binary.
  Models requiring code-mode must pass the packaged helper preflight.
- Use `approvalPolicy: "never"` and `sandbox: "danger-full-access"`. Verify native
  `{ type: "dangerFullAccess" }` readback before prompting. There is no interactive approval mode.
  Reject unexpected native server requests with their exact ID and a bounded explicit failure.
- Verify native model and effort before readiness. Preserve Astra's selected `ultra`; the pinned
  native implementation maps its upstream wire value to `xhigh`. Do not implement a Scotty fallback.
- Keep the private runtime token in its consumed mode-0600 file, never argv, env, URLs, or output.
- Fence admission, reads, and cleanup with the current Session lease and runtime generation.
  A lost admission reply requires readback reconciliation, not another prompt or process launch.
- Use one bounded monotonic startup handshake budget. Keep post-ready request deadlines separate;
  native child cleanup belongs to scopes/finalizers.

The current public vertical supports create, one initial prompt, canonical read, and vaporize.
Native interruption support is not public follow-up/steer support. Codex checkpoint, sleep/resume,
public follow-up, and shared skill discovery remain unavailable. Preserve their explicit guards.
Do not route them through Pi merely because Pi supports them.

## Verify and report

Run the focused tests for the changed boundary and its actual production adapter. For startup or
packaging changes, use the pinned native executable with synthetic upstream and a private throwaway
home. Prove exact settings, prompt admission, terminal response, and owned-process cleanup; exit
code alone is insufficient. Parent/process-group exit is not general descendant containment proof.

For an authorized deployed canary, load `scotty skill show scotty-live-observability`, bind the
release commit and installation, then prove Worker → Session → packaged runtime → canonical read
and owned cleanup. `Warm` means readiness and prompt admission, not a successful model response.
Keep local synthetic proof, installed-image proof, and real-provider/deployed proof separate.

Stop and retain the first safe failure receipt if settings differ, credentials reach a forbidden
surface, ownership drifts, or cleanup remains ambiguous. Never publish success from uncertain
provider state.
