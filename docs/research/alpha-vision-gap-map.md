# Scotty alpha vision-to-current gap map

Date: 2026-08-22
Status: current-system audit and alpha-shaping input; no product code changed

## Executive conclusion

Scotty has a strong correctness core, but the alpha product boundary is not yet coherent.

The strongest parts are the pieces that are hardest to retrofit later:

- safe installation with a private journal and ambiguous-apply recovery;
- one authoritative Session Durable Object with fenced lifecycle operations;
- browser ownership, pairing, transfer, recovery, and revocation;
- a remote TUI that does not own Pi or credentials;
- immutable installation-scoped skill and Pi-package bundles; and
- checkpoint, resume, hard-cap, and vaporize behavior that avoids claiming success from ambiguous provider state.

The alpha blockers are mostly **contract mismatches and excess surface**, not missing infrastructure:

1. **Credential behavior does not match the stated sentinel model.** The production egress path authorizes by current installation-wide origin mapping and does not validate a session sentinel or the session's committed environment snapshot. The implemented per-session vault is not wired into production.
2. **The setup story is split and internally inconsistent.** The README installs Scotty, the embedded Skill starts after installation, public docs still call removed `scotty auth` commands, and no command derives complete readiness.
3. **The shipped base is not thin.** The image includes a broad language toolchain, Chromium/Playwright, Xvfb, ffmpeg, Hatch, evidence, subagents, and compaction. The web surface is also a 16k-line multi-feature application bundled directly into the Worker.
4. **Provider capability is not truthful.** Cloudflare is the only usable session provider. Runner registration and transport exist, but creation is rejected. Cloudflare and runner have typed branches, but they do not share one complete lifecycle contract. Modal and Daytona have no implementation.
5. **There are too many alpha product surfaces.** CLI, TUI, browser worklog, Hatch/evidence/Showcase, provider/stats/environment pages, and a substantial native desktop application all compete for completion.

The recommended alpha is:

> **CLI + TUI as the primary operator experience, a minimal browser authority surface for ownership and pairing, one Cloudflare runtime, one thin Pi container, installation-scoped Skills/Pi packages, and a single derived readiness report.**

Keep the browser worklog available if it is already required for the live session experience, but strip Hatch/evidence/Showcase and secondary dashboards from the alpha promise. Keep desktop source as an experiment; do not include desktop distribution or parity in the alpha gate.

---

## 1. The intended first-user journey

A new user should be able to point an agent at one public Scotty setup Skill or bootstrap document. The agent should safely orchestrate everything except human-owned identity, credentials, browser authority, and destructive consent.

```text
Human points agent at Scotty setup entry
                  |
                  v
        install + verify CLI
                  |
                  v
       inspect plan and choices  <---- human: installation name/profile
                  |
                  v
         deploy installation     <---- human: approve Cloudflare plan
                  |
                  v
      configure model/Git auth   <---- human: secure login or private stdin
                  |
                  v
     derive installation health
                  |
                  v
      establish browser owner    <---- human: approve global revocation
                  |
                  v
         pair this terminal      <---- human: one-use secret, no echo
                  |
                  v
               READY
                  |
                  v
       create and use a session
```

Readiness should be derived, not stored as a second setup state machine:

```text
CLI_INSTALLED
  + DEPLOYED
  + CREDENTIALS_READY
  + SANDBOX_SYNCHRONIZED
  + WORKER_REACHABLE
  + OWNER_ESTABLISHED
  + CURRENT_CLIENT_PAIRED
  = READY
```

Each component already has, or can have, an authoritative owner. The root-authenticated CLI cannot observe every fact today. Owner state and the separate TUI client need new redacted status checks. A future setup report can compose those checks without adding another setup journal.

---

## 2. What a user actually experiences today

### Current path

```text
README release snippet
  -> download binary with GitHub CLI
  -> scotty skills show
  -> docker info / gh auth status / scotty --version
  -> scotty init --name NAME --profile PROFILE
  -> scotty env set GH_TOKEN ... --secret --stdin
  -> scotty env set OPENAI_API_KEY ... --secret --stdin
  -> scotty env set OPENCODE_API_KEY ... --secret --stdin
  -> scotty sandbox sync
  -> scotty doctor
  -> scotty owner recover
  -> owner opens /devices and creates one-use pairing
  -> scotty tui pair ORIGIN
  -> scotty tui
  -> scotty beam up ... --provider cloudflare
```

### What is good

- `scotty init` requires a user-supplied installation name and does not infer identity.
- It plans before applying, rejects unsafe fresh plans, requires typed confirmation, writes a private journal before mutation, rechecks account identity and plan fingerprint, settles the container rollout, writes the local pointer mode `0600`, and synchronizes the sandbox bundle (`cli/src/commands.ts`, `init`; `cli/src/installation-deployment.ts`).
- Machine stdout and error envelopes are stable and separate from human output (`cli/src/main.ts`, `cli/src/core.ts`).
- The embedded operating Skill is real and emitted exactly by `scotty skills show` (`cli/skills/scotty/SKILL.md`; `cli/src/commands.ts`, `skillsShow`).
- Owner recovery and pairing keep one-use values in browser/terminal boundaries (`worker/src/auth-registry.ts`; `worker/src/index.ts`; `tui/src/pairing.ts`).

### Gaps

#### 2.1 The agent entry is split

`README.md` provides the binary installation path. `scotty skills show` starts after the CLI has been installed. A user cannot yet point an agent at one versioned entry that covers download, verification, setup, readiness, and first use.

**Correction shape:** publish one bootstrap Skill at a stable repository/release URL and embed the same source in the CLI. Its first branch installs and verifies the signed binary; after that it delegates to `scotty skills show`.

#### 2.2 Public instructions disagree with the live command tree

`README.md` and `desktop/README.md` still instruct `scotty auth sync`; the current command tree has no `auth` command. The live mechanism is `scotty env set`. `docs/research/scotty-init-setup-experience.md` also records an older intermediate design.

This is an immediate clean-install blocker, not cosmetic documentation debt.

#### 2.3 `doctor` proves too little

`scotty doctor` proves local config parsing, root-token authentication, and Worker reachability. It does not prove:

- required Git/model credentials;
- usable Pi provider authentication;
- active sandbox digest convergence;
- browser ownership;
- current terminal pairing; or
- an end-to-end Pi response.

The Skill knows this, but the product has no single readiness projection.

#### 2.4 Human install output stops too early

After deployment, init prints the config path and asks the user to set three environment variables. The richer phase instrument proposed in `docs/research/scotty-init-setup-experience.md` is not implemented.

A completion message should show what exists, where local pointers live, which state owner owns each remote fact, what remains incomplete, and the next exact action.

Recommended compact output:

```text
Scotty home

Local
  root pointer     ~/.scotty.json                 ready
  paired client    ~/.config/scotty/tui.json      not paired

Cloudflare
  Worker           reachable                      ready
  Sandbox config   digest 7e3a… · revision 4       synchronized
  credentials      GitHub · OpenAI                 incomplete
  browser owner    none                            incomplete

Runtime
  provider         Cloudflare Sandbox
  Pi base          0.84.0
  extras           2 skills · 1 Pi package

Next
  Configure provider credentials, then establish the owner browser.
```

---

## 3. Current system map

```text
LOCAL MACHINE

  scotty CLI
    |-- ~/.scotty.json                 root bearer + installation pointer
    |-- ~/.config/scotty/tui.json      paired client credential
    |-- ~/.config/scotty/sandbox.json  desired extra Skills/Pi packages
    |
    +---------------- HTTPS -------------------------------+
                                                           |
CLOUDFLARE                                                  v

  Worker / API / static assets
    |
    |-- Auth Durable Object
    |     owner, clients, pairing, transfer, recovery, revocation
    |
    |-- SandboxConfig Durable Object
    |     active sandbox digest
    |     repository registry
    |     current installation environment + real secret values
    |
    |-- KV
    |     non-secret list/repository/stats projections
    |
    |-- R2
    |     immutable backups, evidence, sandbox bundles
    |
    +-- one Sandbox Durable Object per session
          authoritative SessionRecord
          operation lease + nonce
          hard-cap metadata
          backup handles
          Pi transport token
          applied environment snapshot with static placeholders
          |
          +-- Cloudflare Sandbox container
                /workspace/<session-id>
                Pi settings + AGENTS.md
                scotty-pi-session RPC supervisor
                Pi process
                session sentinel/placeholder environment
                |
                +-- ContainerProxy egress
                      current implementation resolves credential
                      from SandboxConfig by destination origin
```

### Authoritative state

| State                           | Owner                                           | Projection or runtime observation        |
| ------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Installation resources          | Alchemy/Cloudflare resources                    | local `~/.scotty.json` pointer           |
| Browser authority               | Auth Durable Object                             | browser/TUI client cookie/config         |
| Sandbox digest and repositories | SandboxConfig Durable Object                    | local desired bundle; KV repo projection |
| Current environment authority   | SandboxConfig Durable Object                    | redacted environment view                |
| Session lifecycle and lease     | Session Sandbox Durable Object                  | KV fleet row                             |
| Workspace/Pi process            | container runtime under Session DO control      | console snapshots/events                 |
| Checkpoints                     | R2 immutable objects + handles in SessionRecord | download/beam-down result                |

### Important ownership drift

`AGENTS.md` says the Session Sandbox Durable Object owns the per-session credential vault and that SandboxConfig does not own GitHub credentials. Current production code stores installation environment secrets in the SandboxConfig Durable Object and does not wire `EnvironmentSecretVault` into the Session DO. This contract must be resolved before alpha; documentation and code cannot both remain authoritative.

---

## 4. Session lifecycle state machine

```text
                     create failure
                          |
                          v
ABSENT --create--> BOOTING --------------------------> FAILED
                    |  create/setup/runtime phases       |
                    |                                    | recoverable resume
                    v                                    |
                   WARM <---------- resume <--------- SLEEPING
                    |  \
                    |   +-- snapshot: stop Pi, back up,
                    |   |              restart Pi, stay warm
                    |   |
                    |   +-- sleep / hard cap ----------> SLEEPING
                    |
                    +-- vaporize operation/retry ------> GONE
```

Every lifecycle operation that can race with external runtime work uses one persisted operation lease with a nonce. This includes create, snapshot or sleep, resume, environment refresh, Hatch and evidence work, beam down, and vaporize. Metadata changes such as rename use SessionStore serialization but do not take this lease. External completions must still match the lease before committing. Vaporize stays in the current status with a `vaporize` operation until it commits `gone`; there is no stored `deleting` status. It retains retry state until owned runtime, backups, evidence, idempotency records, and projections are gone (`worker/src/session-store.ts`; `worker/src/session.ts`).

### Keep this design

- Hard cap is armed before create commits.
- Snapshot quiesces and stops Pi before synchronization and backup.
- Resume requires the current backup and reuses the session's pinned sandbox digest.
- Ambiguous provider destruction is not success.
- KV remains a projection, not authority.

These are alpha strengths, not simplification targets.

---

## 5. Credential and environment flow: the largest correctness gap

### Intended/documented shape

```text
installation credential
  -> session-specific sentinel
  -> sentinel in container env
  -> outbound request carries sentinel
  -> session vault validates sentinel + origin + session
  -> proxy substitutes real credential
```

### Current production shape

```text
SandboxConfig environment authority (real secret, current revision)
  |
  +-- create/refresh --> SessionRecord.environment
  |                       one static "scotty-injected" placeholder for every secret
  |
  +-- every egress request --> resolve by destination origin
                                |
                                +-- Session DO checks only "record exists, not gone"
                                +-- no sentinel input
                                +-- no applied-revision check
                                +-- no snapshot membership check
                                +-- global environment only
                                +-- inject current installation credential
```

Evidence:

- `ENVIRONMENT_INJECTED_PLACEHOLDER = "scotty-injected"` in `worker/src/environment-contracts.ts`.
- The environment refresh state machine updates `SessionRecord.environment` and restarts Pi (`worker/src/session.ts`, environment refresh programs; `worker/src/container-auth.ts`, `refreshEnvironment`).
- Egress asks the session DO to resolve only `{ origin }` (`worker/src/egress.ts`).
- The session DO delegates to `SandboxConfig.resolveCredentialForOrigin` without consulting its committed environment snapshot (`worker/src/session.ts`, `resolveCredentialForOriginProgram`).
- `EnvironmentSecretVault` has reconcile/commit/replay/resolve behavior and tests, but no production integration (`worker/src/environment-secret-vault.ts`).

### Consequences

1. “Refresh required” is true for process environment but false for secret use.
2. A warm session can use a newly configured credential without adopting the new environment revision.
3. Removing a secret from a session snapshot does not itself remove egress authority if the installation still maps the origin.
4. The placeholder is not an authentication capability.
5. Repository-scoped secret materialization and global-only egress resolution have different semantics.
6. The stated per-session vault owner is not the live owner.

### Recommended target

Do not make the environment store itself the credential system. Separate three concepts:

```text
Plain Environment Authority
  owner: SandboxConfig DO
  values: non-secret process configuration
  semantics: revisioned snapshot; explicit refresh for warm sessions

Installation Credential Broker
  owner: dedicated installation-scoped DO/service
  values: API keys/OAuth records, origin policy, rotation state
  semantics: real values never leave broker/egress boundary

Session Credential Bindings
  owner: Session DO
  values: opaque session capability, credential reference, allowed origins,
          source revision, revoked/active state
  semantics: capability is committed with session lifecycle and revocable
```

Target egress:

```text
container sends opaque session capability in the provider's normal auth field
  -> proxy extracts and removes capability
  -> Session DO verifies capability + destination + active session binding
  -> credential broker reads/refreshes the real credential
  -> refresh commits before a sanitized provider response returns
  -> proxy injects the real credential and forwards
```

This keeps convenient rotation without copying real values into every session, while restoring actual session-bound authorization. It also makes the environment refresh contract understandable: plain env changes require refresh; credential value rotation does not; credential grant/revocation follows explicit session-binding policy.

### Alpha decision required

The current Skill configures API keys, but the model allowlist advertises `openai-codex/*`, whose Pi provider uses OAuth rather than `OPENAI_API_KEY` (pinned Pi source under `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`). Choose one before alpha:

- **API-key alpha:** expose only providers that can actually authenticate through the credential broker; remove unavailable Codex OAuth models from the default projection.
- **Codex-subscription alpha:** implement the broker-owned OAuth record, refresh transaction, sanitized response, and provider-specific request adaptation before advertising `openai-codex`.

Do not retain a UI-visible provider that the setup flow cannot make usable.

---

## 6. Container: authority is thin, image is not

The runtime ownership boundary is good: the Session DO owns state and lifecycle; the container owns only files and processes. The image contents are the problem.

### Currently baked into every session

- Pi and the Scotty RPC supervisor;
- Git and GitHub CLI;
- Node, npm, Bun, Corepack, pnpm;
- Python through uv;
- Go;
- C/C++ build tools and pkg-config;
- rg, fd, ast-grep, jq, yq, qsv, shellcheck;
- Chromium/Playwright, Xvfb, and ffmpeg;
- `pi-subagents`;
- Codex compaction;
- `scotty-browser-test`;
- `scotty-hatch`;
- a compiled copy of the entire Scotty CLI.

See `worker/container/Dockerfile`, `worker/container/toolsets/standard.json`, `worker/container/pi-packages/manifest.json`, and `worker/src/container-auth.ts::PI_PACKAGES`.

The enforced image budget is 1.25 GiB (`cli/src/deployment-packaging.ts::CONTAINER_IMAGE_BUDGET`), which is evidence that the current target is a full workstation image, not a thin Pi base.

### Customization that already works

`scotty sandbox add/remove/list/sync` supports:

- checked local Skill directories;
- Git-backed Pi packages pinned to a resolved commit;
- deterministic archives and digests;
- bounded file and bundle sizes;
- installation-scoped activation; and
- session pinning of the active digest at create time.

This is a good core mechanism (`cli/src/sandbox-*`; `worker/src/sandbox-config-*`; `worker/src/sandbox-bundle-*`).

### Missing customization

- optional tool/toolchain profiles;
- user-declared OS packages or container layer extension;
- per-session selection among profiles;
- a clear statement that an updated bundle affects new sessions while resume reuses the session's pinned digest;
- a supported path for extra tools that are not Pi packages.

### Recommended image split

```text
scotty-core
  Cloudflare Sandbox base
  Pi
  scotty-pi-session
  git + minimal shell/CA/process tools
  one small JS runtime required by Pi
  no Hatch, evidence, browser, desktop, runner, subagents, or broad toolchains

installation profile: coding-standard
  search/data tools
  GitHub CLI
  selected JS/Python/Go toolchains

optional capability packs
  browser-evidence = Chromium + Xvfb + ffmpeg + scotty-browser-test
  hatch            = scotty-hatch
  subagents        = pi-subagents
  language packs   = python | go | native-build | bun

installation bundle
  user Skills + pinned Pi packages
```

Cloudflare may require image-level layers rather than runtime package installation. If so, model profiles as explicit image variants selected by installation/session policy, not as arbitrary `apt install` in untrusted repositories.

For the first alpha, ship one `core` image and at most one explicitly named `standard` image. Make `standard` a product choice, not an invisible default.

---

## 7. Product surfaces

### TUI

**Keep and make primary for alpha.**

The TUI is a remote client over the same authenticated console protocol. Independence checks prevent it from owning a local Pi runtime, process execution, or credential files beyond its paired-client config (`tui/src`; `scripts/check-tui-independence.mjs`). Pairing and epoch/revision-fenced commands are already strong.

### Browser

The browser UI is not a package today; it is a large static asset tree deployed with the Worker. `worker/public` contains roughly 16,000 lines of HTML/CSS/JS. The terminal alone includes worklog, composer, model controls, summary, Hatch/evidence, subagent/workflow activity, and delivery controls.

**Alpha split:**

- keep minimal `/recover`, `/pair`, `/owner-transfer`, and `/devices` authority pages;
- keep `/sessions` and the browser worklog only if they are part of the selected primary path;
- defer environment/providers/stats dashboards, Hatch, evidence, Showcase, workflow/subagent visualization, and rich summary until the base loop is proven;
- move the optional web console toward its own package/build boundary instead of making all static UI inseparable from the control Worker.

### Desktop

The desktop app is architecturally clean but not bare bones: it contains thousands of lines of native GPUI code for transcript rendering, Markdown, selection, attachments, syntax highlighting, settings, menus, and sidecar management (`desktop/crates/scotty-desktop/src`). It is not in the CLI release workflow and lacks distribution signing/notarization proof.

**Recommendation:** retain the source, remove desktop from the alpha product promise and default verification gate, and do not invest in parity. Delete it only if maintaining the source measurably blocks the core; deletion is not required to simplify the shipped alpha.

### Alpha product boundary

```text
Required
  CLI install/deploy/status/lifecycle
  TUI pair + fleet + Pi worklog
  minimal browser owner/pair/device pages
  Cloudflare runtime
  checkpoint/resume/vaporize
  sandbox Skill/Pi-package sync

Optional but available
  browser worklog

Hidden/deferred
  runner placement
  desktop distribution
  Hatch/evidence/Showcase
  stats/providers dashboards
  broad multi-language image profile
```

---

## 8. Multi-provider execution

### Current reality

- Provider schema is a closed union: `cloudflare | runner` (`worker/src/contracts.ts`).
- CLI and TUI create only Cloudflare sessions.
- `/api/sessions` rejects runner-backed create.
- `/api/providers` can report a connected runner as `available`, which is misleading because placement is still impossible.
- Cloudflare and runner have typed execution bindings and provider-specific branches. They do not share one complete lifecycle interface, and runner cannot create a Session. Modal and Daytona have no implementation.

### Do not build a plugin framework yet

First make provider capability truthful:

```text
cloudflare  sessionCreation=true  snapshot=true  resume=true  passivePi=true
runner      registration=true     sessionCreation=false
```

Then define one narrow runtime port from the lifecycle behavior already proven by Cloudflare:

```text
RuntimeProvider
  prepare(session intent) -> placement receipt
  create(receipt) -> runtime identity | ambiguous
  start(runtime, seed) -> health/epoch | ambiguous
  inspect(runtime) -> observed state
  stop(runtime) -> stopped | ambiguous
  destroy(runtime) -> gone | ambiguous
  capabilities -> snapshot/resume/passivePi/hatch/evidence
```

The Session DO must remain the lifecycle authority. Providers return receipts and observations; they do not own session state.

Build this boundary only while adding the second real provider. A good sequence is:

1. finish native Pi RPC transport for trusted runners;
2. extract the provider port while moving Cloudflare and runner behind it;
3. prove the shared lifecycle contract;
4. add Modal or Daytona as the third implementation.

Do not advertise provider availability from connectivity alone. Report capability plus readiness.

---

## 9. Ranked gap list

### P0 — resolve before alpha

1. **Remove the unconditional three-secret gate.** Session create currently requires `GH_TOKEN`, `OPENAI_API_KEY`, and `OPENCODE_API_KEY`. Require repository access plus at least one login path that works with the selected model.
2. **Choose and implement one credential authority model.** Wire true session capabilities or explicitly simplify to a broker model; remove the dead/bypassed sentinel story.
3. **Make model authentication truthful.** Support both API keys and Codex OAuth through Pi's login code. Show only models that have a usable login.
4. **Repair the setup contract.** Remove nonexistent `scotty auth` instructions, add one bootstrap entry, and align README, desktop docs, research status, Skill, E2E, and command help.
5. **Add a derived readiness command/report.** It must distinguish deployed from usable without storing a second setup state machine.
6. **Restore one executable alpha proof.** Prove install/configure/pair/create/Pi response/snapshot/resume/vaporize against the actual image and deployed Cloudflare boundary. The local-live harness still calls the removed `/api/auth/pi` route. Public setup documents separately call the removed `scotty auth sync` command.
7. **Make provider reporting truthful.** Runner is registration/control-only until creation and Pi transport pass.

### P1 — alpha scope and operability

7. **Select the primary surface.** Prefer CLI + TUI; make browser authority pages minimal and explicitly classify browser worklog as required or optional.
8. **Split the container into core and optional capability packs/profiles.** Measure image size and cold-start time as release evidence.
9. **Define sandbox bundle freshness semantics.** State exactly which sessions adopt a new digest and when.
10. **Improve init progress and completion output** without changing stable JSON, exit codes, journal, or recovery contracts.
11. **Reduce web alpha scope.** Defer Hatch/evidence/Showcase and secondary dashboards; establish a package boundary for optional web UI.
12. **Exclude desktop distribution/parity from alpha gates.** Retain source unless its maintenance blocks the core.

### P2 — after the Cloudflare alpha is trustworthy

13. Complete runner native Pi transport and lifecycle contract.
14. Extract a provider adapter while adding the second real implementation.
15. Add Modal/Daytona based on measured need and provider capabilities.
16. Reintroduce optional Hatch/evidence packs and richer browser/desktop surfaces.

---

## 10. Keep / act now / defer

| Area                                   | Decision          | Reason                                           |
| -------------------------------------- | ----------------- | ------------------------------------------------ |
| Init lock/journal/plan fingerprint     | Keep              | Strong ambiguous-apply safety                    |
| Session DO lifecycle + operation lease | Keep              | Correct authoritative ownership                  |
| Snapshot/resume/vaporize               | Keep              | Explicit recovery and no false success           |
| Auth DO owner/pair/transfer/recovery   | Keep              | Strong browser authority isolation               |
| TUI transport and pairing              | Keep              | Thin remote client with fenced commands          |
| Immutable sandbox bundles              | Keep              | Good user customization primitive                |
| Credential sentinel/live-origin split  | Act now           | Stated and actual authority disagree             |
| Provider/model readiness               | Act now           | UI/setup can expose unusable capability          |
| Setup docs/bootstrap/readiness         | Act now           | Clean user reaches removed commands              |
| Container contents                     | Act now           | Full workstation conflicts with thin-base vision |
| Browser worklog                        | Decide now        | Coherent but large; must be required or optional |
| Runner control plane                   | Defer session use | Real groundwork, creation intentionally disabled |
| Desktop distribution                   | Defer             | Second product without release proof             |
| Hatch/evidence/Showcase                | Defer             | Valuable add-on, not core durable Pi loop        |
| Modal/Daytona                          | Defer             | No adapter seam or second proven provider yet    |

---

## 11. Verification performed for this audit

- Four Luna/high scout reviews traced onboarding, runtime/container composition, state/credentials, and provider/product surfaces. This document does not link persistent scout logs.
- The parent review inspected the live command tree, embedded Skill, Dockerfile/tool manifest, Worker routes, environment stores, egress path, Session DO credential resolver, TUI/desktop boundaries, and pinned Pi provider auth metadata.
- `./dist/scotty --help`, `skills --help`, `init --help`, and `beam up --help` were inspected.
- One scout ran focused command-tree and Worker route tests; both passed.
- One scout directly confirmed `scotty auth sync --json` is rejected as an unknown command with exit code `2`.
- No deployment, Docker image build, or destructive/external action was run.

## Final recommendation

Do not start with Modal, Daytona, desktop polish, or a provider plugin framework.

Start with the first contract divergence:

1. settle credential authority and provider authentication;
2. make setup derive a truthful ready/not-ready picture;
3. prove the Cloudflare + Pi + TUI lifecycle end to end;
4. cut the image and UI down to the selected alpha surface;
5. then extract provider placement while completing runners.

That order turns Scotty from a broad, impressive system into a small alpha whose promises are all true.
