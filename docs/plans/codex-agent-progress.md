# Codex agent progress

## Slice 0

- Created `codex-agent` from `main` at `0f3f6aaa` in the current checkout.
- Initialized Effect and Alchemy reference submodules at required pins; no revision changes.
- Preserved pre-existing untracked paths and read-only runner-portability lane.
- Saved implementation plan in `docs/plans/codex-agent.md`.

### Baseline proof

Before production changes: `npm run fmt:check`, `npm run lint` (including lint:skills), `npm run typecheck`, and `npm run test:all` all exited 0. Full logs: `/tmp/scotty-codex-baseline/`. These are local checks, not deployed proof.

`node e2e/scripts/scan.mjs` exited 0 but compared against zero configured secrets; it is not a credential-leak canary. `bun build cli/scotty.ts --compile --outfile /tmp/scotty-codex-baseline-cli` passed.

### Grounding

Two read-only Luna-high scouts traced current main. Pi's native host is `worker/container/scotty-pi-session.mjs`; `worker/src/sandbox/auth.ts` and Session transitions own current startup/backup integration. Dockerfile deliberately asserts Codex absent. Config strictly accepts version/sync/repos/credentials, with no agent profiles. CLI `--provider` already means runtime placement; do not overload it for model provider. Managed openai-codex OAuth grants already exist and should remain credential authority.

Slice 1 must remain a process/protocol component: no Session/config/Runner edits. Pin and inspect exact release-generated protocol before modeling. Candidate old-lane version 0.153.4 is not verified here. Do not treat mutable upstream docs or scout-reported checksums as sufficient pin proof. Prefer a required bounded subset over implementing unused resume/steering/approval parity. Fail unsupported server requests explicitly and safely.

Later integration must address effective-home skill discovery, Pi-specific conversation and backup paths, settings readback, request-body transport to the child, and exact history restore. No remote resources or deployment were created.

## First Slice 1 workflow: completed execution, blocked acceptance

Run `wf-0233a538-8c90-4373-883b-5c44bd452c64` finished all tasks, but independent audit returned BLOCK. Protocol and image installation were added; host writer stopped without edits. Audit evidence: `/tmp/scotty-slice1-audit/REPORT.md` and reproducible scripts beside it.

- P1: actual 0.153.4 notifications include `emittedAtMs`; strict decoder rejected streamed/completed/interrupted events. Existing 12 unit tests did not cover native envelopes.
- P1: no production process host exists. Native probe established that detached descendants can survive parent process-group SIGKILL; absence of that group is not complete cleanup proof.
- P2: prepared container context omits protocol source; Dockerfile build/COPY alone cannot integrate the bundle.
- Clarification: isolated nonsecret native configuration established high/low effort before prompting and thread/start read it back. The earlier settings blocker was too broad.

User authorized repairs. Protocol and packaging fixes run concurrently, then host implementation and one independent integrated re-audit. No Session/config/Runner scope expansion. Docker daemon was unavailable during first audit; no deployed or real-provider proof exists.

## Repairs and Effect-first replacement (awaiting independent audit)

Protocol repair now accepts bounded native `emittedAtMs`, preserves unrelated strict fields and passes unmodified wire replay plus native high/low probes. Packaging discovers the actual host's transitive graph and bundles with locked dependencies into a standalone Node artifact.

User corrected excessive native-JS lifecycle logic. Cancelled writer sa-10; replacement sa-11 moved async state/deadlines/cleanup to Effect TypeScript in `worker/src/agent/codex/`, with a four-line native launcher. Cancelled partial files are retained only in `/tmp/scotty-effect-host/`, not as a parallel implementation. The replacement's report and exact checks are `/tmp/scotty-effect-host/REPORT.md`. Independent Astra-high audit sa-12 is running; implementation results below are not acceptance.

Writer reports 23 Effect/protocol, 43 macOS native, 15 packaging, and 3 Pi tests passing, plus affected formatting/lint/typechecks. Actual prepared-context Linux image build/smokes/size passed using configured Docker context. Earlier assumption of unavailable Docker from `/var/run/docker.sock` was incorrect; respect configured context. Image size 1,124,167,790 bytes is below existing 1,310,720,000-byte metric budget.

Linux native matrix is 41/43: two real command/descendant tests fail bubblewrap namespace creation. Image now installs required bubblewrap, but no privileges/capabilities/setuid/sandbox policy were changed. Kernel support is not diagnosed from that error alone. Actual Linux command and descendant cleanup remain unproved. Host receipts conservatively report cleanup ambiguous and descendants unverified. No deployment, real credentials or production acceptance.

## YOLO-only correction (awaiting final integrated audit)

User explicitly selected YOLO-only and no approval flow. Cancelled stale audit sa-12; sa-13 aligned pinned request `approvalPolicy: never`, `sandbox: danger-full-access` and strict response `sandbox: { type: dangerFullAccess }` before prompt. Removed mistakenly introduced bubblewrap dependency/checks; outer Docker privileges/security and Scotty credential/egress boundaries were not changed. Unexpected server requests still receive bounded explicit rejection.

Writer report `/tmp/scotty-yolo/REPORT.md` records passing 26 Effect/protocol tests, 15 packaging tests, 49 native tests on each of macOS and emulated Linux, 3 Pi regressions, focused lint/typechecks and rebuilt image checks. Original Linux native-command failures are resolved in YOLO mode. These are writer-reported component proofs, not acceptance or deployed proof. Cleanup receipts remain ambiguous/descendants unverified; exact test fixture cleanup does not establish general containment.

Independent Astra-high integrated audit sa-14 now reviews actual complete diff and reproduces proofs. No commits or deployment. Earlier read-only sandbox/bubblewrap assumptions and namespace blocker are superseded, not current product requirements.

## Slice 1 component accepted

Independent re-audit sa-16: PASS all three P2 repairs and combined Slice 1 component acceptance. Evidence `/tmp/scotty-p2-reaudit/REPORT.md`, exact four-file repair diff SHA-256 `5d77d3a883d19aa2f07d9e403559faa8e639bd9ab07f39b46a5223a958636ab3`. Prior unaffected source hashes match. Old-code failures independently reproduced; current code passes terminal-publication stop/failure interleavings, fatal broken/backpressured diagnostic output, and idle/pending/active clean stdout EOF with owned EOF preserved.

Independent proof: 15 focused Effect tests, 54 native tests per macOS/emulated Linux, focused formatting/lint/skill lint and worker typecheck. Prior unchanged protocol/packaging/Pi/image evidence contributes to component acceptance, not falsely claimed freshly rerun. Exact 45 fixture PIDs and six containers absent. Linux uses fresh staged bundle, not rebuilt image; installed image is older. Emulated Node/ESM SIGSEGV reproduced with no Scotty code, retained as environment limitation; historical unexplained macOS failure remains documented, not claimed fixed.

Scope closure: no remaining reproduced blocker for Slice 1 component. No Session/Runner admission, TOML defaults, real provider/credential/egress, skills, history/resume, general descendant containment or deployment proof yet. P3 optional validation cleanup deferred. No commits or deployments. Next vertical increment: explicit Codex Session create → one response → read → cleanup, preserving Session authority and current Pi path.

## Public vertical: connected proof passed, acceptance blocked

Integrated audit sa-28 (`/tmp/scotty-public-vertical-audit/REPORT.md`) exercised production public Session/actor logic connected to byte-matched installed server and native packaged Codex/helper with synthetic provider. Astra ultra readback, native wire mapping, streaming/completed canonical reads, lost-202 reconciliation without duplicate prompt, and actual exact-container destruction before Gone all passed. Local Cloudflare storage/Registry/provisioning substitutes remain explicit; CLI parsing and managed egress adapter proof are separate, not deployed credentials or production proof.

Blocking repairs: F1 snapshot deadline leaves live/locked body IO; F2 overlapping canonical read can return pre-deletion Warm result without current-authority return fence; F3 old deployment gate still forbids Codex package. One full ops fixture failure remains unattributed and requires sanitized error/cleanup observations, not passing retries. UI warning reproduces with no application imports under UI build-plugin config; separate harness issue. Plan-only formatting was corrected by parent.

sa-29 owns IO cancellation/current-authority fences; sa-30 owns stale deployment test and ops fixture diagnosis. Scopes are disjoint. No broad rearchitecture, optional refactoring, commits or deployment. Acceptance remains blocked until repair/re-audit and combined checks.

## Final public-vertical repair verification

F1/F2 independently PASS in `/tmp/scotty-public-io-reaudit/REPORT.md`: actual Request abort/body cancellation and current-authority return fence reproduce red→green. F3 deployment gate repaired. Ops fixture instrumentation exposed initial handshake sharing a short request deadline with process startup; the exact underlying pre-log stall remains unknown.

Handshake now has one bounded 15s default/cap startup budget separate from post-ready requests, explicitly excluding process creation/helper preflight. First focused review caught wall-clock sensitivity. Two-file correction uses pinned monotonic nanoseconds for all three elapsed-deadline reads, preserving wall time for credential expiry. Permanent backward/forward clock-correction tests were red before fix. Parent inspected incremental diff and independently reran unchanged reviewer suite: 8/8 PASS. Evidence `/tmp/scotty-monotonic-startup-fix/REPORT.md` and `/tmp/scotty-readiness-review/`.

Before this final two-file correction the combined fmt/lint/typecheck/test:all/scan/compiled CLI gate passed (`/tmp/scotty-public-final-gate/`); scan had zero configured secrets. Final-source combined gate is being rerun. Existing image predates latest host timing changes; no new image or deployed proof inferred. No commits/deployment. TOML defaults, skills, followup and durable lifecycle remain future slices.

## Explicit Codex public vertical accepted locally

Final-source combined gate `bt-3` exited 0: fmt:check, lint (including skills), all typechecks, test:all, scan and compiled CLI. Logs/artifact: `/tmp/scotty-public-monotonic-final/`. Ops portion: 186 passed, 17 existing skips; not the total aggregate test count. Scan compared zero configured secrets and is not a leak canary.

Combined with connected local public/native proof and focused independent repairs, explicit Codex create → initial response/read → actual runtime destruction is accepted at local proof tiers. No remaining reproduced blocker for this increment. Latest timing code was not rebuilt into the previously tested image; no deployed/account-availability/general-containment claim. No commits or deployment. Next: TOML default agent and independent model/effort profiles with explicit overrides.
