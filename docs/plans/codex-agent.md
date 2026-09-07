# Codex agent implementation plan

## Scope and starting point

Build fresh on `codex-agent` from main `0f3f6aaa`. Pi already works: add Codex app-server without a Pi rewrite or backward-compatibility framework. Preserve unrelated untracked work. `.lane/trees/runner-portability` is read-only reference, never a wholesale merge source.

Support default Pi/Codex and independent model/effort settings in `~/.config/scotty/scotty.toml`, plus explicit creation overrides. Confirm exact syntax against current config. Explicit field overrides selected-agent profile; never inherit the other profile. Reject unsupported settings, without fallback. Existing Sessions use their own effective settings on resume, not newly changed local defaults. Preserve existing Pi model controls.

Preserve current VPS Runner behavior; do not enable guarded Runner Sessions. Exclude Box/new provisioning, publication, broad plugin abstractions, ambient credential import, and unapproved deployment/resource creation.

## Architecture

CLI/config resolves validated creation selection. Session remains authoritative for agent identity, effective settings, leases/fences, credential grants, backup and recovery. Dispatch Pi through existing implementation and Codex through a narrow app-server adapter. Placement is independent. Share validated content and Hatch/Evidence domain behavior; keep native startup, effective homes, discovery, tool registration, protocol, and history agent-specific. Do not emulate Pi RPC in Codex.

Verify native settings before initial prompt. Bound messages/output; correlate requests/threads/turns and reject stale events. Distinguish accepted, terminal, failed, and ambiguous outcomes. Reuse managed Session egress; no real credentials in container files/env/args/logs/archives. Never archive all CODEX_HOME or silently replace a missing conversation on resume.

## Slices and acceptance

0. **Baseline:** fresh branch, pinned references, source map, recorded checks and existing failures. Preserve unrelated work and old lane.
1. **Codex process/protocol:** inspect and pin exact binary/protocol; narrow native JSONL process host, strict decoding, settings verification, prompt/terminal response/interrupt/stop. Prove real binary against deterministic synthetic upstreams; malformed/oversized data, wrong IDs, exit/timeout and process cleanup. Component proof only.
2. **Session integration:** minimal schema-owned selection through CLI/Worker/Session/startup; retain Pi dispatch; persist selection and create idempotency; conversation/read/follow-up/interrupt; managed model and Git egress; failure/vaporize cleanup. Prove exact native selection, replay/stale/ambiguous outcomes, actual child Git access, Pi regression. Explicit approval/steering capability policy. Keep incomplete lifecycle admission guarded.
3. **TOML defaults:** selected-agent profiles and CLI overrides with current contracts, no compatibility modes. Separate defaults decoding from sync traversal. Test both defaults, per-field overrides, invalid/missing config/settings, no secrets reads or cross-profile fallback, real CLI help/errors, and Session independence from changed defaults.
4. **Skills/capabilities:** one validated artifact inventory, agent-specific effective-home projection and native registration. Distinguish skills/instructions/executables/Pi extensions/Codex tools. Prove actual discovery/use, instruction loading, Hatch/Evidence invocation, unsafe links, malformed/duplicate skills and missing dependencies. Reference lane has a home/projection mismatch: do not reproduce it.
   5A. **Backup:** observed selected-agent quiescence/stop, bounded approved history, current backup/thread/settings identity, credential-safe content, recoverable interrupted capture; Pi regression.
   5B. **Resume/cleanup:** exact restore in fresh runtime/fence, settings/tools/replay state, readiness before follow-up, convergent owned cleanup. Prove continuity, changed defaults ignored, missing/corrupt history, revoked grants/unavailable models, stale fences and honest ambiguous cleanup.
5. **Lab/E2E:** extend existing lab incrementally, then complete Cloudflare Pi and Codex journeys: selection, native settings, response/retrieval, skills/instructions, Hatch/Evidence, follow-up/interrupt, sleep/resume, credentials and vaporize absence. Explicit target/repo/budget/ownership, bounded polling, redacted receipts, no latest-session inference or implicit deployment. Existing VPS/native/Docker regressions only. Separate local/synthetic/image/deployed proof; deployment requires approval.
6. **Audit/skills:** independent integrated structure/Effect/state/credential/recovery audit, resolve and retest. Invoke maintain-verification-skill for existing `.pi/skills/verify-scotty/`, update and re-drive actual recipes with fresh-agent proof. Improve `.agents/skills/` from concrete verified lessons using reflection/writing guidance; validate against pinned source/tests, links and skill lint.

## Execution and quality

Scouts: Pi harness, `openai-codex/gpt-5.6-luna`, high. Implementation: Pi, `openai-codex/gpt-6-astra`, medium. Verification/audit: Pi, `openai-codex/gpt-6-astra`, high. Parent owns integration. One writer per shared schema/router/lifecycle scope. Auditors read only. Small reviewed workflow tranches with explicit needs/consumes and path ownership; draft approval before execution. Slices 3/4 may overlap after settled contracts only with disjoint scopes. Otherwise serialize.

Before nontrivial Effect work read AGENTS, matching project skill, vendor Effect agent instructions/patterns, and exact implementation/tests. Effect pin `2600f62f4532026928454dcea8d1c48557b3f942` (rc.112); Alchemy pin `e5b1b598392585e0f2d5fa03ac475cd076dbc0f8` (beta.76). Use schema-owned types, typed errors, scoped cleanup, explicit host islands, Effect tests, and strict migrated-domain lint coverage. No unsafe casts, broad suppressions, hidden runtimes or remembered v3 APIs.

Per slice: format before lint, skill lint, focused tests and affected typechecks. Final: npm run typecheck; npm run test:all; node e2e/scripts/scan.mjs; compiled CLI check. Record exact command/results, revision, proof tier and limitations. Preserve unrelated formatter output.

No backward compatibility requirement does not authorize destructive state cleanup. Coordinate CLI/Worker rollout; inspect active Sessions before state changes and obtain disposition approval. Report implementation, merge, deployment and production proof separately.
