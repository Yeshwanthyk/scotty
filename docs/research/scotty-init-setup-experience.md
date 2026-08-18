# Scotty init and embedded operating Skill

Date: 2026-08-18
Status: selected product shape; research only

## Decision

Keep the product simple:

1. **Improve `scotty init` as an installation command.** Give it clear preflight, plan, deployment progress, and completion UI without turning it into a multi-step setup wizard.
2. **Put the complete Scotty operating model in one embedded Skill.** Reintroduce `scotty skills show` so an AI agent can load how to install, configure, operate, observe, recover, and safely remove Scotty.
3. **Make human checkpoints explicit in the Skill.** The agent performs safe probes and commands. It asks the human for user-owned names and choices, pauses for secure login/browser flows, and never asks for real credentials in chat.
4. **Make setup one branch of the Skill, not the whole Skill.** Setup ends at a paired, usable terminal; the same Skill then owns sessions, lifecycle, Hatch/evidence, auth, ownership, sandbox customization, tools, runners, upgrades, recovery, and uninstall.

There will be no `scotty setup` command and no post-deploy wizard state added to `init`. Existing commands remain the mechanisms; the comprehensive `scotty` Skill is their agent-facing orchestration and explanation layer.

## Research method

Four DeepSeek V4 Flash scouts inspected the current init path, clean-room completeness, mature CLI onboarding patterns, and lifecycle/security risks. Follow-up DeepSeek scouts researched Docker runtime startup and the removed embedded-skills surface. The parent review verified material claims directly against repository source/tests and primary documentation.

Corrections made during verification:

- Init journal/resume behavior **is tested** by `init resumes an apply-started journal with the same token` in `cli/test/cli.test.ts`.
- The root token does not remain in two local files after success. The init journal is removed after `~/.scotty.json` is committed (`cli/src/commands.ts:611-635`).
- Init does perform a functional Worker/root-auth check: sandbox sync calls the deployed Worker and uploads the digest (`cli/src/commands.ts:636-646`). It does not prove Pi auth, ownership, pairing, or a real terminal session.
- The standard Pi packages are image-local (`worker/container/pi-packages/manifest.json`, `settings.json`, and `worker/container/Dockerfile:217-220`). An empty sandbox customization config means no additional operator packages, not an empty standard toolset.
- Cloudflare profile authentication is delegated to Alchemy through `ALCHEMY_PROFILE` (`cli/src/installation-deployment.ts:382-411`). The UX gap is broad error guidance, not necessarily absent authentication.

## Current installation transaction

`scotty init` in `cli/src/commands.ts:398-653` already has a strong safety core:

1. requires a user-supplied installation name;
2. rejects direct `--host` and `--token-file` credentials;
3. validates optional preview/evidence topology;
4. verifies Docker and GitHub CLI auth;
5. takes a per-installation lock;
6. reads a private init journal;
7. plans against the selected Cloudflare profile;
8. rejects a non-empty or destructive fresh plan;
9. shows account/resource topology and requires typed-name confirmation interactively;
10. records `prepared` then `apply_started` in a mode-0600 journal;
11. rechecks account identity and plan fingerprint before apply;
12. waits for Container rollout settlement;
13. uploads root/GitHub tokens as Worker secrets outside Alchemy state;
14. verifies resource bindings;
15. commits the private installation pointer;
16. removes the init journal;
17. synchronizes the sandbox bundle; and
18. emits stable machine or human output.

The lock + journal + plan fingerprint + deep account recheck should remain untouched. UI work belongs around this transaction, not in a replacement deployment mechanism.

## Contracts to preserve

| Contract                                            | Evidence                             | Required behavior                                                                                            |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Names are user-supplied and never inferred          | `AGENTS.md`; `commands.ts:294-310`   | The agent must ask the human for the installation name.                                                      |
| Non-TTY stdout automatically uses JSON              | `commands.ts:268-284`                | Progress never contaminates machine stdout.                                                                  |
| Init success JSON is stable                         | init tests in `cli/test/cli.test.ts` | Preserve `configPath`, `installationName`, `profile`, `accountId`, `workerName`, `host`, `rootTokenRotated`. |
| Error envelope and exit codes are stable            | `cli/src/main.ts`; `cli/src/core.ts` | Preserve `{error:{code,message,hint}}` on stderr and exit codes 0–5.                                         |
| `--yes` bypasses confirmation, not validation       | `commands.ts:526-553`                | Agents may use `--yes` only after explicit human authorization.                                              |
| Interactive creation requires the exact name        | `commands.ts:534-553`                | Retain typed-name confirmation for humans.                                                                   |
| Init is create-only                                 | `commands.ts:425-427,510-524`        | Existing remote state routes to `recover`; the Skill explains the branch.                                    |
| Ambiguous apply resumes safely                      | journal flow and resume test         | The Skill reruns the same init inputs; it does not delete journals speculatively.                            |
| Local config is a pointer, not deployment authority | repository invariants                | The Skill derives state from commands and remote owners, not a new checklist store.                          |
| Secrets avoid args/logs/chat/Alchemy state          | repository invariants                | Skill prompts request human actions, never token values.                                                     |
| Sandbox-sync failure leaves install committed       | init partial-success test            | The Skill labels this “installed; setup incomplete” and retries `sandbox sync`.                              |

## Improve `init`, but keep it bounded

The ideal human TTY output is a small line-oriented deployment instrument:

```text
Scotty install

Checking
  ✓ Docker            29.2.1 · colima
  ✓ GitHub            authenticated
  ✓ Cloudflare        profile default

Review
  Installation        home
  Account             0123…cdef
  Compute             worker · runner · sandbox
  Storage             KV · R2

Create home? Type home: _

Installing
  ✓ Prepared deployment
  ✓ Applied Cloudflare resources
  ✓ Container rollout healthy
  ✓ Uploaded Worker secrets
  ✓ Verified bindings
  ✓ Saved ~/.scotty.json (0600)
  ✓ Synchronized sandbox

Installed home
Next: load the Scotty Skill with `scotty skills show`.
```

Guidelines:

- Use real domain progress, not fake timers.
- Keep plain text as the semantic base; color and animation are optional decoration.
- Honor `NO_COLOR`, `TERM=dumb`, stream TTY state, and a textual-progress mode.
- Wrap for narrow terminals and avoid large continually rewritten regions.
- Never print credentials or recovery/pairing URLs.
- Keep the existing machine result exactly unchanged.
- Label installation success accurately; the Skill owns readiness, not init.

## Docker startup policy

The current `ensureDocker` (`cli/src/commands.ts:323-352`) runs `docker info`, then on interactive macOS offers `colima start`, retries `docker info`, and otherwise returns `docker_unavailable`. Linux release binaries exist, but Linux receives no equivalent startup help.

Keep the policy conservative:

1. Run `docker info` first.
2. If it fails, identify an **already-installed** runtime with high confidence.
3. Offer a non-privileged start only with human confirmation.
4. Retry `docker info` after the start.
5. If startup needs installation, sudo, or a first-run GUI, give the exact next action and fail safely.

| Runtime                       | Detect/start guidance                                 | Scotty policy                                                                                    |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Colima on macOS               | `colima start`                                        | Keep the current bounded offer.                                                                  |
| Docker Desktop                | Prefer official `docker desktop start` when available | Offer only after detection; first launch may still require the human GUI/license/privilege flow. |
| Rootless Docker on Linux      | `systemctl --user start docker`                       | Offer when the rootless user unit is present.                                                    |
| System Docker Engine on Linux | `sudo systemctl start docker`                         | Show guidance only; Scotty and the agent do not invoke sudo.                                     |
| OrbStack                      | `orb start`                                           | Optional offer only when confidently detected.                                                   |
| Rancher Desktop               | `rdctl start`                                         | Optional offer only when detected and configured for the Docker/Moby engine.                     |

The Scotty Skill's setup branch uses the same rule: it may start an already-installed, user-level runtime after permission. It does not install Docker products or elevate privileges.

Primary sources:

- [Colima commands](https://colima.run/docs/commands/)
- [Docker Desktop CLI](https://docs.docker.com/desktop/features/desktop-cli/)
- [Docker Engine daemon start](https://docs.docker.com/engine/daemon/start/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [OrbStack commands](https://docs.orbstack.dev/machines/commands)
- [Rancher Desktop rdctl](https://docs.rancherdesktop.io/references/rdctl-command-reference/)

## Reintroduce the comprehensive embedded Scotty Skill

`scotty skills` does not exist in the current command tree. Its removal is asserted by `cli/test/cli.test.ts:2650-2658`, while `README.md:79,368` still refer to an embedded guide. The selected shape intentionally reintroduces a narrower surface:

```text
scotty skills             show command help
scotty skills show        emit the embedded Scotty Skill as Markdown
```

The command should restore and modernize the former comprehensive embedded Skill rather than create a setup-only document. Recommended file:

```text
cli/skills/scotty/SKILL.md
```

The file should be imported as text into the compiled CLI, following the repository's previous embedded-skill pattern. `scotty skills show` should emit the exact source so an agent can load it without a second installation or network fetch.

The Skill should be **model-invoked** when installed or placed in an agent context. Its frontmatter description should trigger when a user asks to install, configure, operate, inspect, steer, checkpoint, resume, beam down, vaporize, recover, customize, diagnose, upgrade, or remove Scotty. The top stays short and routes to co-located branches with explicit completion criteria.

### Skill coverage

The former `cli/skills/scotty/SKILL.md` already covered most of this surface before commit `b4d8a435` removed the command while introducing sandbox customization. Restore that single-source operating guide and update it for the current command tree.

| Branch                 | What the Skill must teach                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Setup                  | Prerequisites, init/recover, sandbox sync, Pi auth, doctor, ownership, pairing, ready-state proof           |
| Launch and observe     | `beam up --detach --json`, exact-ID polling, status interpretation, bounded completion                      |
| Inspect and steer      | Passive inspect, revision-bound steer, sandbox-internal authority, stale/ambiguous handling                 |
| Open and use           | `attach`, live Pi worklog naming, paired-browser expectations, TUI use                                      |
| Lifecycle              | snapshot, resume, beam down, vaporize, state transitions, explicit destructive consent                      |
| Hatch and evidence     | Hatch ownership, before/after browser evidence, structured references, private Showcase rules               |
| Repositories           | Add/list/remove registry entries and repository identity requirements                                       |
| Sandbox customization  | `sandbox add/remove/list/sync`, immutable digest behavior, image built-ins versus extras                    |
| Auth and ownership     | auth status/sync/reseed, owner recovery/transfer/revocation, secret-safe human handoffs                     |
| Tools and runners      | tool manifest/doctor, runner setup/list/remove, user-supplied runner names, disabled runner-backed creation |
| Installation lifecycle | deploy, upgrade, recover, uninstall, retained data defaults, diagnostics and safe retries                   |

`scotty skills show` emits this complete Skill. Do not add a catalog, downloader, or installation framework in the first slice. A single authoritative Skill is the simplest useful surface; it can gain named subskills later only if the document becomes too large to remain reliable.

### Why a Skill instead of more init behavior

- Existing commands already own each secure mechanism.
- Agents are good at running checks, interpreting stable JSON, and resuming explicit steps.
- Human judgment remains visible at names, account authorization, credential login, recovery, and pairing.
- No second state machine or setup journal is introduced.
- The procedure can evolve without changing init's persisted/session contracts.
- The same Skill can be shown by the CLI, consumed by an external setup/operations agent, and optionally added to an agent sandbox later.

## Agent/human contract

The Skill must label each checkpoint so the agent knows whether to act, ask, or wait.

| Step                | Agent owns                                                              | Human owns                                                                         | Safe interaction                                                                        |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Installation name   | Ask, validate, pass to CLI                                              | Choose the name                                                                    | “What installation name should I use? Use 2–32 lowercase letters, numbers, or hyphens.” |
| Cloudflare profile  | Ask whether `default` is correct                                        | Choose/identify the profile and authorize login                                    | Ask for the profile **name**, never an API token.                                       |
| Preview/evidence    | Keep the default path simple; ask only when requested                   | Supply explicit preview base and zone ID if desired                                | Never infer topology from identity or account.                                          |
| Docker              | Run `docker info`; detect runtime; offer safe user-level start          | Approve a detected start or perform privileged/GUI setup                           | Agent does not install a runtime or invoke sudo.                                        |
| GitHub CLI          | Run `gh auth status`                                                    | Complete `gh auth login` locally when needed                                       | “Run `gh auth login` in your own terminal, then tell me when it succeeds.”              |
| Pi credentials      | Check only supported status/metadata                                    | Complete Pi login locally                                                          | The agent never reads credential values into chat.                                      |
| Deployment          | Run `scotty init ... --yes` after approval; parse JSON/error code       | Authorize creation under the selected profile                                      | `--yes` follows explicit approval and never bypasses checks.                            |
| Pi sync             | Run `scotty auth sync` and `auth status`                                | Finish login first                                                                 | Report provider `id/type/adapter`, not secrets.                                         |
| Health              | Run `scotty doctor --json` and retry sandbox sync if needed             | —                                                                                  | Completion requires `ok: true` plus successful auth sync.                               |
| Owner recovery      | Explain revocation, then invoke only after confirmation                 | Approve and finish the opened browser flow                                         | Recovery revokes every existing browser credential; never relay the recovery URL.       |
| Pairing             | Provide the Worker origin and instructions                              | Create the one-use link, run `scotty tui pair ORIGIN`, paste at the no-echo prompt | Pairing credentials stay in the human's terminal and browser, never chat.               |
| Ready               | Verify paired config/TUI launch outcome without exposing its credential | Launch/use `scotty tui`                                                            | Setup is complete when the current terminal is paired and usable.                       |
| Destructive cleanup | Explain retained data and request explicit authorization                | Approve uninstall and optional data deletion                                       | Never infer consent for `--delete-data`.                                                |

## Setup branch of the Skill

When the setup branch fires, the embedded Scotty Skill should execute this compact sequence.

### 1. Probe

- Confirm the Scotty binary/version.
- Run `docker info`.
- Run `gh auth status`.
- Check whether local Pi auth is available without displaying its contents.
- Ask for the installation name and Cloudflare profile.

Completion: every prerequisite is healthy or the human has one exact secure action to perform.

### 2. Install or resume

- Ask for explicit deployment approval.
- Run `scotty init --name NAME --profile PROFILE --yes`.
- On an init journal failure, preserve the journal and follow its typed hint.
- On `installation_not_empty`, determine whether this is a replacement machine/existing installation; use `scotty recover --name NAME` only with human confirmation.
- On sandbox sync failure after pointer commit, run `scotty sandbox sync` rather than repeating or rolling back deployment.

Completion: the managed pointer exists privately and the installation Worker accepts sandbox synchronization.

### 3. Synchronize Pi auth

- If Pi login is incomplete, ask the human to perform it locally.
- Run `scotty auth sync`.
- Run `scotty auth status --json`.

Completion: at least one supported provider is reported and sync is not partial, or each failed warm-session reseed is explicitly reported.

### 4. Verify

- Run `scotty doctor --json`.
- Require `ok: true` and managed mode for this installation.

Completion: config identity and root-authenticated Worker access are proven. The Skill should state that this is not yet paired-terminal readiness.

### 5. Establish ownership

- Explain that owner recovery revokes existing browser credentials.
- Ask for confirmation.
- Run `scotty owner recover` and ask the human to complete the browser flow.

Completion: the human confirms the intended browser owns the installation.

### 6. Pair this terminal

- Give the human the exact Worker origin from the verified managed config.
- Ask them to open `/devices`, create a one-use pairing link, and run `scotty tui pair ORIGIN` in their own terminal.
- Keep the one-use credential out of agent context.

Completion: the paired-client configuration is written privately and `scotty tui` can open.

### 7. Finish

Report:

- installation name;
- Cloudflare profile/account and Worker host (identifiers only);
- Docker runtime used;
- Pi providers by redacted metadata;
- doctor result;
- owner browser completed;
- terminal paired; and
- next command: `scotty tui`.

## CLI UX benchmark patterns retained

Primary-source patterns support this split:

- [GitHub CLI environment controls](https://cli.github.com/manual/gh_help_environment) distinguish prompt-disabled automation, textual progress, and accessible prompting.
- [GitHub CLI auth](https://cli.github.com/manual/gh_auth_login) keeps secure login in a dedicated flow rather than accepting secrets on argv.
- [Terraform apply](https://developer.hashicorp.com/terraform/cli/commands/apply) separates review/approval from apply and treats saved approval as security-sensitive.
- [Wrangler structured output](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) keeps machine records separate from human progress.

Scotty already exceeds most peers on ambiguous-apply recovery. The Skill should preserve that strength rather than simulate its own recovery logic.

## Implementation slices

### Slice 1 — Restore the comprehensive Skill through `skills show`

- Add the Effect CLI `skills` group and `show` subcommand.
- Restore and update `cli/skills/scotty/SKILL.md`, then embed it in the compiled binary.
- Emit the exact Markdown source.
- Remove only `skills` from the removed-command assertion; preserve the other removed aliases.
- Add root/subcommand help and exact-content tests.
- Update stale README references to `scotty skills show`.

Demo: an agent runs one local command and receives the complete, current Scotty operating model.

### Slice 2 — Contract-test every Skill branch

- Update the previous operating Skill with the setup/human-gate branch and current sandbox/repository/runner surfaces.
- Pin each branch's critical commands and completion criteria in tests.
- Prove the Skill contains no credential-shaped values.
- Prove it is a valid `SKILL.md` with model-invoked triggers for install/init/configure/recover/finish-setup.

Demo: a clean agent can drive setup and then operate Scotty safely without rediscovering command semantics from the README.

### Slice 3 — Improve init presentation

- Add an injectable, secret-free progress reporter.
- Keep exact JSON/error/exit behavior.
- Render checks, review, real deployment phases, partial success, and final next action.
- Add plain/accessible/narrow-terminal snapshots.

Demo: human init is clear; agent init remains one machine-readable result.

### Slice 4 — Generalize Docker startup help

- Extract runtime detection/start selection into a testable boundary.
- Keep Colima behavior.
- Add only confidently detected non-privileged starts.
- Provide exact guidance for privileged/GUI cases.

Demo: supported macOS/Linux users get the right runtime-specific action without Scotty installing software or elevating privileges.

## Test obligations

- Existing init result JSON, error envelope, exit codes, journal semantics, and partial-success behavior remain exact.
- `scotty skills show` emits byte-for-byte embedded Markdown and survives compiled/clean-room builds.
- Bare `scotty skills` and `skills show --help` follow the Effect command tree.
- Removed top-level aliases other than the intentionally restored `skills` remain rejected.
- The Skill covers every registered public command family and names the setup-critical commands: `init`, `sandbox sync`, `auth sync`, `auth status`, `doctor`, `owner recover`, `tui pair`, and `tui`.
- The Skill asks for installation name/profile and includes explicit recovery/pairing/destructive human gates.
- Secret scan covers the embedded Skill and progress events.
- Docker detection/start cases are deterministic and never run sudo or package installation.
- `--json`/non-TTY init stdout remains exactly one JSON document even during deployment logs.
- Run formatting, lint skills, lint, CLI typecheck/tests, offline E2E, secret scan, and standalone CLI compilation.

## Bottom line

The simplest complete product is not a larger wizard. It is:

- a polished, safe `scotty init` for installation;
- one comprehensive embedded `scotty` Skill available through `scotty skills show`;
- stable JSON commands an agent can compose; and
- explicit human gates for names, provider authorization, browser ownership, pairing, and destructive choices.

That gives AI agents enough procedure to set Scotty up reliably while keeping credentials and authority with the human and the existing owners.
