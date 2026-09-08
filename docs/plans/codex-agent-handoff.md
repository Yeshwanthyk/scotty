# Codex agent handoff: completed work and remaining slices

## Current increment: automatic save and restore (2026-09-08)

The historical implementation and proof statuses below are superseded by current source and the
bundled skills. Codex supports messages, active steering, interruption, and automatic history
save/restore through Session sleep/resume. DO-owned queued follow-ups are now implemented and
locally verified, pending deployment and a deployed queue canary. `steer --follow-up` explicitly
queues work; default `steer` still steers an active turn. Pending items survive eviction and sleep,
and DO alarms dispatch without a browser. Resume restores the same native thread and saved message
receipts without replaying the initial prompt; unknown queue delivery remains visibly unconfirmed
until a matching receipt is available. Standalone checkpoint remains unavailable by user choice;
shared skill discovery remains separate work.

The pinned native runtime passed a two-turn/tool save and fresh-home restore test, followed by a
new tool turn with prior context. Production acceptance still requires the guarded deployment and
a fresh deployed sleep/resume canary. Immediate command output can be absent from pinned native
app-server display events even though the model receives it; ordered received chunks are retained.

## Read this first

The explicit **Codex create → initial response → read → vaporize** increment is implemented and accepted at local proof tiers. The final combined repository gate passed after independent audits and targeted repairs.

**TOML defaults are implemented and locally verified (2026-09-07).** Agent selection uses explicit flags → selected TOML profile → legacy Pi behavior. Pi and Codex profiles remain separate; Pi settings reach native startup and are checked before the initial prompt. Follow-up, skills/capabilities, durable Codex sleep/resume, and maintained full E2E lab recipes remain. All 12 active bundled/project skills have been updated and validated; the local Codex observability skill loads current CLI guidance. The legacy verifier exists only in the protected runner-portability checkout and was not changed. The original defaults draft below is historical.

The production implementation was checkpointed as `2b707719` on `codex-agent`. Skill maintenance is the next checkpoint. The user has authorized release and a live baseline trial; deployment and installed-CLI proof remain pending at this update.

### Latest defaults increment

- TOML: `[agent].default`, `[agents.pi].provider/model/effort`, `[agents.codex].model/effort`. Beam reads configuration without resolving sync roots or reading credential sources. Missing TOML preserves Pi; invalid present configuration fails.
- CLI overrides: `--agent`, `--model`, `--effort`, and Pi-only `--model-provider`; placement `--provider` is unchanged. Overrides apply only to the selected profile. Pi fields can be supplied independently using its existing defaults for omitted fields.
- Pi: selection persists through existing Session authority, seeds native settings, and rejects requested-setting mismatches before consuming the initial prompt. Credential refresh preserves current settings; resume does not force the original creation profile over runtime changes.
- User configuration now selects `codex` / `gpt-6-astra` / `low`. Unsupported pre-existing runner sections are retained as comments. Original private backup: `~/.config/scotty/scotty.toml.before-agent-defaults-20260907`.
- Verification: focused Worker 150/150, Pi supervisor 6/6, CLI beam 13/13; native Pi 0.84 settings readback; pinned native Codex Astra-low synthetic run; exact candidate decode and isolated CLI default selection. Release checks passed in stages after registering the existing bundled Codex main entrypoint with knip: build/package checks, formatting, lint, knip, all typechecks, `test:all`, scan, compiled CLI. Scanner had zero configured secrets and is not a credential-leak canary.
- Receipts and compiled CLI: `/tmp/scotty-toml-defaults/`. No fresh Container image, real provider/account request, or deployed canary was proved by this increment.
- Requested live target: installation `baseline`, repository `Yeshwanthyk/scotty`. Read-only checks found authenticated reachability, an empty Session list, and the wrapping-key binding. Guarded release still requires clean `main` matching `origin/main`; the implementation is checkpointed, with guarded release and the user's installed CLI update pending.

## Checkout and preservation

- Repository: `/Users/yesh/code/personal/scotty`
- Branch: `codex-agent`
- HEAD: `0f3f6aaaf7efee61c5385e196906d4ad176f9234` (original main base)
- Implementation is a dirty tracked/untracked overlay. Immediately before this handoff there were 49 short-status entries; directory entries hide multiple files.
- Read `AGENTS.md`. Recheck status and source before starting.
- `git diff` alone omits new untracked production/tests. Inspect those explicitly; do not stage everything.

These paths were untracked **before this project increment**; preserve and exclude from automatic staging:

```text
.agents/skills/configuring-codex-app-server/
.lane/
docs/plans/handoffs/
docs/plans/runner-portability.md
docs/research/exe-dev-box-runner-provider.md
```

Old `.lane/trees/runner-portability` is read-only reference, not a migration/merge source. It has substantial unrelated uncommitted work. No bulk copying, cherry-picking, cleaning, or resetting.

Project documents authored here:

```text
docs/plans/codex-agent.md
docs/plans/codex-agent-progress.md
docs/plans/codex-agent-handoff.md
docs/research/codex-agent-pin.md
```

This handoff and the latest progress entries supersede earlier planning assumptions about approval modes, bubblewrap installation, synthetic-only models, and unresolved defects that were subsequently fixed.

## User decisions

- Pi already works: preserve it, do not rewrite it for symmetry.
- Add Codex app-server alongside Pi.
- **YOLO-only**: `approvalPolicy: "never"`, `sandbox: "danger-full-access"`; verify native `{ type: "dangerFullAccess" }` readback before prompting.
- No interactive approval flow, approval UI, or selectable inner sandbox policy. Unexpected native server requests receive bounded explicit rejection, never fabricated approvals.
- Use the existing DO-backed authentication/credential architecture. No new Auth DO/store/importer or credential authority. Browser/CLI Auth remains distinct from Session grants and Credential Registry resolution.
- Real model credentials stay outside containers. Existing managed sentinels are placeholders resolved/substituted at existing egress after Session grant checks.
- No backward-compatibility framework. Existing default Pi behavior is nevertheless preserved; do not gratuitously break it.
- Existing VPS registration/service support stays; guarded Runner-backed Session creation remains disabled.
- No Box/provisioning/provider expansion, artifact publication, generic plugin framework, or unrelated cleanup.
- Future default agent and independent model/effort profiles live in `~/.config/scotty/scotty.toml`. Explicit flags override the selected profile only.
- At the end: maintain the existing verification skill, then improve project Effect skills from actual verified lessons.
- No deployment, real credential sync, or remote resource mutation without separate authorization.

## What is implemented

### 1. Pinned complete native runtime and model capabilities

- Codex release `rust-v0.153.4`, source commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.
- Full official primary Linux package under `/opt/codex`; `/usr/local/bin/codex` symlinks to its entrypoint.
- Linux package: `codex-package-x86_64-unknown-linux-musl.tar.gz`, SHA-256 `a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821`.
- Manifest, helper, path tools and resources retained; no flattened loose-binary installation.
- Code-mode helper readiness is checked before work for models that need it. Astra code-mode execution has native synthetic proof.
- `protocol/codex-model-capabilities.ts` projects 11 pinned catalog entries with model-specific efforts. Unknown/unsupported pairs fail closed, no older-model-only whitelist.
- Bundled `codex-resources/bwrap` belongs to the complete upstream package. No system bubblewrap dependency, privilege expansion or nested-sandbox requirement is introduced; execution remains YOLO.
- Astra `ultra` is retained in selection/readback; native pinned Codex maps its upstream wire effort to `xhigh`. This is source-grounded native behavior, not Scotty fallback.

### 2. Effect-first process component

```text
worker/container/scotty-codex-session.mjs (thin launcher)
  → bundled worker/src/agent/codex/main.ts
  → process.ts / session.ts / framing.ts / errors.ts
  → real Codex app-server over bounded stdio
```

- Schema-owned bounded protocol, including actual native notification `emittedAtMs`.
- Explicit launch selection, model/effort/workspace/private runtime directory and Session-managed sentinel grant projection.
- Fixed managed Responses endpoint `https://chatgpt.com/backend-api/codex`; sentinel env-key auth; no ambient native OAuth/auth-file import, arbitrary production URL or helper auth process.
- Expired selections and upstream rejection fail explicitly. No new refresh implementation or claim of real-account availability.
- Exact native settings before readiness/prompt, correlation, deadlines, bounded streams, interrupted/failing turns and scoped process cleanup.
- One shared handshake budget: optional bounded `startupTimeoutMs`, default/cap 15s, monotonic elapsed time. It excludes process creation/helper preflight and cleanup; post-ready request deadlines remain separate.
- Stop receipts retain descendant uncertainty; parent process/group exit is not full cleanup proof.

### 3. Private Session runtime bridge and packaging

```text
worker/container/scotty-codex-server.mjs
  → bundled worker/src/agent/codex/server.ts
  → runtime.ts / token-file.ts
  → existing Effect process component
```

- Private authenticated health, one initial prompt admission, bounded read snapshot and stop.
- Generation fence plus private consumed token file, no control token in argv/env/URL/output.
- Prompt acceptance and terminal completion are separate. Lost response means reconcile snapshot, not replay blindly.
- Node Effect HTTP server owns callbacks/scopes; native token-file flags remain a small justified host adapter.
- Both executable dependency graphs are included in the actual prepared container context and bundled with existing locked dependencies.
- Image checks preserve Pi/Playwright safety and unchanged size budget. Latest reported pre-timing-change image size: 1,153,977,495 bytes below 1,310,720,000.

### 4. Explicit public Session vertical

Example for a CLI built from this branch, **not an instruction to run against the existing deployment**:

```sh
scotty beam "one prompt" --title "Codex task" --repo OWNER/REPO \
  --provider cloudflare --agent codex --model gpt-6-astra --effort high --detach
scotty read SESSION_ID
scotty vaporize SESSION_ID --yes
```

- `--provider` remains placement. Codex requires explicit model/effort. Default Pi path remains.
- Selection is persisted through Session reservation, identity and idempotency.
- Existing hard-cap/lease/grant/runtime authority governs create and recovery.
- Native Request adapter and SandboxRuntime forward bounded POST bodies with interruption signals.
- Create becomes Warm after verified settings and initial prompt admission, not after waiting for an answer.
- Lost admission reply reconciles without duplicate prompt or launch.
- Canonical read exposes streaming/completed/failed/aborted; CLI and UI decoders accept the actual states.
- Remote read rechecks current authority before returning. Delete/lease/proof changes reject stale publication with 409.
- Read deadlines cancel/release underlying fetch/body I/O without cancelling generation-owned admitted work.
- Vaporize uses existing actual runtime destruction and owned-state/grant absence, not host.stop as evidence of Gone.
- Codex follow-up/steer and checkpoint/sleep/resume remain unavailable; guards prevent accidental Pi lifecycle fallback. Check exact existing envelopes before changing them.

## Main source map

| Concern                                   | Paths                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent selection / protocol / capabilities | `protocol/{agent-selection,codex-app-server,codex-model-capabilities,conversation}.ts`                                                                |
| Effect native host                        | `worker/src/agent/codex/{main,process,session,framing,errors}.ts`                                                                                     |
| Private bridge                            | `worker/src/agent/codex/{runtime,server,token-file}.ts`                                                                                               |
| Session adapter / canonical projection    | `worker/src/agent/codex/{sandbox,conversation}.ts`                                                                                                    |
| Session authority / transitions           | `worker/src/session/object.ts`, `worker/src/session-actor/`, `worker/src/session/contracts.ts`, `worker/src/index.ts`                                 |
| Interruptible native transport            | `worker/src/sandbox/runtime.ts`, `worker/src/shared/bounded-http.ts`                                                                                  |
| CLI                                       | `cli/src/{commands,schemas,dependencies}.ts`                                                                                                          |
| Image / context                           | `worker/container/Dockerfile`, `cli/src/deployment-packaging.{ts,mjs}`, `scripts/{prepare-container-context,check-container-image}*.mjs`              |
| UI boundary                               | `ui/src/data/conversation-client.ts` and test                                                                                                         |
| Tests                                     | `worker/test/agent/codex/`, `worker/test/protocol/`, `worker/test/egress/codex-managed.test.ts`, public routes, native supervisor and packaging tests |

## Acceptance and proof limits

### Passed

- Exact native package/protocol/model evidence, macOS and emulated Linux native component matrices, code-mode execution, bounded failure/interruption/cleanup fixtures.
- Connected local proof through **real public Session/actor code → installed byte-matched private server → real native Codex/helper → canonical response → actual exact-container destruction before Gone**.
- Connected test covers streaming before terminal, Astra selection, discarded first 202, exactly one prompt, idempotent replay/conflict, failed destroy retaining state, and successful retry cleanup.
- Independent audits found concrete defects; focused repairs were independently verified, including wall-clock correction reproduction.
- Final combined source gate `bt-3` exited 0: `fmt:check`, `lint` including skills, all typechecks, `test:all`, scanner and compiled CLI.
- `test:all` final ops portion: 186 passed, 17 existing skips. This is **not** the total aggregate test count.
- Parent independently reran the unchanged final deadline-review suite: 8/8 passed.

Final gate logs/artifact: `/tmp/scotty-public-monotonic-final/` (compiled CLI `scotty`).

### Not proved / not done

- No deployed Worker/DO canary, real provider/account availability, real credential rotation or managed-egress deployment proof.
- Local connected proof uses in-memory Cloudflare host/storage/Registry substitutes; Docker deletion is real local container destruction, not Cloudflare SDK deletion.
- CLI parsing/compilation and existing egress adapter tests are separate from that connected HTTP harness; do not claim one deployed CLI-to-provider proof.
- Native provider is synthetic loopback; no real credentials/home mounts.
- General descendant containment is not proved. Exact test-owned PID/container absence is proved where recorded.
- Latest host timing fix was tested from source but **not rebuilt into the previously tested image**. Rebuild/identify the artifact before future installed-image or deployment claims.
- Scanner used zero configured secrets: not a credential-leak canary.
- Earlier concurrent fake-process pre-log stall remains causally unattributed. Distinct readiness/request budgets have deterministic coverage and the original concurrent ops gate now passes; do not claim diagnosed scheduler overload.
- UI test shutdown warning reproduces with an empty test under UI build-plugin configuration. Decoder is not necessary for that warning; plugin cleanup remains separate.
- Local emulated Linux Node/ESM SIGSEGV was independently reproduced without Scotty code. Do not infer bare-metal or emulated-runtime reliability.

## Evidence to retain

These `/tmp` reports may disappear. Persist concise receipts/repro scripts in the maintained lab before relying on them across machines; do not copy raw transcripts indiscriminately.

| Evidence                                                                | Report                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Initial component acceptance / fatal fiber, publication race, EOF fixes | `/tmp/scotty-p2-reaudit/REPORT.md`                                                      |
| Existing-auth managed launch                                            | `/tmp/scotty-managed-launch/REPORT.md`                                                  |
| Complete package / Astra capabilities                                   | `/tmp/scotty-codex-packaging-proof/REPORT.md`                                           |
| Private runtime bridge                                                  | `/tmp/scotty-runtime-bridge/REPORT.md`                                                  |
| Installed server packaging                                              | `/tmp/scotty-final-runtime-packaging/REPORT.md`                                         |
| Public vertical implementation                                          | `/tmp/scotty-public-vertical/REPORT.md`                                                 |
| Connected public/native integrated audit                                | `/tmp/scotty-public-vertical-audit/REPORT.md`                                           |
| Cancellation/current-authority independent acceptance                   | `/tmp/scotty-public-io-reaudit/REPORT.md`                                               |
| Stale gate / retained ops diagnosis                                     | `/tmp/scotty-integrated-gate-fixes/REPORT.md`                                           |
| Deadline review and permanent monotonic correction                      | `/tmp/scotty-readiness-review/REPORT.md`, `/tmp/scotty-monotonic-startup-fix/REPORT.md` |

## TOML defaults: original draft (superseded by the latest increment)

Original target excerpt (the actual user Codex effort is now `low`):

```toml
[agent]
default = "codex"

[agents.pi]
provider = "openai-codex"
model = "YOUR_PI_MODEL"
effort = "high"

[agents.codex]
model = "gpt-6-astra"
effort = "medium"
```

Precedence: explicit agent → configured default → Pi. Explicit fields override only that agent's profile. No cross-profile fallback or invented model defaults. Existing Sessions use authoritative effective settings, not newly edited local defaults. Pi's model provider must not collide with placement `--provider`.

**Original gap, now closed:** Pi selection previously represented identity only. The latest increment applies and verifies Pi profile settings end to end while preserving its existing controls and defaults.

Prepared four-task workflow:

```text
Selection / precedence contract
             │
      ┌──────┴────────┐
      ▼               ▼
TOML / CLI        Pi apply / verify
      └──────┬────────┘
             ▼
      Integrated audit
```

- `contract`: shared selection schema, tests, concise contract document. No dependencies.
- `defaults`: CLI/config schema/loading/precedence/help/tests. Needs and consumes contract.
- `pi-settings`: minimal Worker/Session/Pi application/readback and tests. Needs and consumes contract. Disjoint from CLI writer.
- `audit`: read-only integrated proof. Needs both writers, consumes all three results.

Draft ID: `draft_9bb1c91b77f3`.
Execution digest: `8116a48e8a9729cfb170e2e402a4f156090a8074217e4bf40e62f9e162a77951`.
Review command: `/workflow-draft draft_9bb1c91b77f3`.

**Unapproved / unstarted.** User requested a handoff after seeing the draft, not approval. Approval metadata is session/project-bound: in a new session, re-ground and prepare/review a fresh draft rather than blindly approving this ID. Inspect exact owned paths before use; filenames in a draft are not proof files exist. No defaults contract document has been written yet.

## Remaining slices after defaults

1. **Public follow-up / interruption:** extend beyond one initial prompt with Session-fenced command identity, replay/unknown outcomes and observable terminal interruption. Native component support alone is not public support.
2. **Skills/instructions/capabilities:** effective home discovery, shared validated content, agent-native registration, Hatch/Evidence invocation. Prove actual discovery/use, not file existence; do not copy global user skills.
3. **Durable Codex lifecycle:** quiesce/history allowlist/current backup, exact restore in a fresh runtime/fence, effective settings continuity, meaningful follow-up and cleanup. No archive of entire CODEX_HOME or silent new conversation on resume.
4. **Maintained lab and real journey proof:** convert ad hoc connected proofs into existing lab recipes; exercise both agents through public CLI with bounded budgets, explicit owned resources, redacted receipts and exact cleanup. Deployment/real credential canary requires approval.
5. **Final verification/Effect skills maintenance:** invoke maintain-verification-skill for existing `.pi/skills/verify-scotty/`; re-drive with a fresh agent. Then update relevant `.agents/skills/` from verified corrections using reflection/writing guidance and pinned source. Align stale rc.109 references/approval assumptions only where verified. Do not create competing skills or speculative universal rules.

## How to continue efficiently

- Keep each increment observable. Do not add another framework or build all future lifecycle methods at once.
- Ground real wire envelopes, native package layout and actual prepared build graph before implementation.
- Effect TypeScript owns async state/errors/scopes/deadlines; native callbacks/flags remain thin explicit adapters. Bundled `.mjs` is an artifact, not an excuse for a Promise-based domain core.
- Test failure reporting failure, yielding-state races, clean EOF with live child, cancellation at real Request/body boundary and post-I/O authority freshness while implementing.
- Use monotonic Clock for elapsed deadlines; wall Clock for timestamps/credential expiry.
- Parallelize only settled contracts/disjoint writers. One integrated audit per meaningful increment; focused red→green re-review for findings, not repeated broad audits.
- Preserve failed evidence and label test layers honestly. Do not use retries, extra privileges, swallowed errors or generic timeout increases to make acceptance green.
- Review complete tracked/untracked scope before any commit. No automatic `git add .`, cleanup, reset or publication. A clean scoped checkpoint is desirable once authorized.

Requested runtimes:

| Role               | Harness | Model                       | Effort |
| ------------------ | ------- | --------------------------- | ------ |
| Scouts             | Pi      | `openai-codex/gpt-5.6-luna` | high   |
| Implementation     | Pi      | `openai-codex/gpt-6-astra`  | medium |
| Verification/audit | Pi      | `openai-codex/gpt-6-astra`  | high   |

Pinned references (read-only): Effect `2600f62f4532026928454dcea8d1c48557b3f942` / rc.112; Alchemy `e5b1b598392585e0f2d5fa03ac475cd076dbc0f8` / beta.76.

## Fresh-session starting instruction

Read this handoff and current AGENTS, inspect the dirty `codex-agent` branch including untracked source, and preserve unrelated work. Do not restart Codex host implementation: its explicit public one-turn vertical is locally accepted. TOML defaults are complete at the local proof tiers above. Next resolve the scoped release checkpoint and guarded deployment before the requested baseline trial; do not claim that the installed CLI or Worker contains this overlay. Keep interactive follow-up and durable Codex lifecycle as later small slices.
