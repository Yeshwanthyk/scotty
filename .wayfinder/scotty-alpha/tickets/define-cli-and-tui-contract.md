---
title: Define the CLI and TUI contract
status: closed
label: wayfinder:prototype
mode: HITL
assignee: yesh
blocked_by:
  - Define the first-use and readiness contract
  - Define the canonical Session lifecycle
  - Define the config and Plugin contract
---

## Question

What command tree, human output, agent JSON, errors, exit codes, pairing flow, connection flow, status view, and diagrams make setup and daily Session use clear without duplicating authority in the TUI?

## Inherited lifecycle contract

The stable states are `provisioning`, `warm`, `stopped`, and `gone`. Creating, Snapshotting,
Sleeping, Resuming, and Vaporizing are views of the current operation. Stopped results must show
the stop reason, current checkpoint, recovery action, runtime deadline outcome, and next safe
command. Repository results must name the immutable GitHub repository identity, requested base
ref, verified source commit, Fork, freshness, and typed bridge or unsupported-feature blocker.

## Inherited credential and failure contract

The CLI manages reserved `pi` and `github` credentials plus administrator-named custom records,
Plugin requirement bindings, future-Session generation replacement, validation, and retirement.
Human and JSON results must expose the exact stage, code, target, last proven effect, retained
state, ambiguity, safe retry, human action, operation ID, and sanitized cause without exposing any
secret value, ciphertext, token, or unsafe URL.

## Inherited Publish contract

Publish selects an agent-created commit. It never creates a hidden commit or guesses which dirty
files belong. Human and JSON views must show the selected head, verified base, dirty excluded
paths, exact check policy and result, controlled branch, pull request, preserved human state,
ambiguity, conflict, last proven effect, safe retry, and cleanup result. Publish success means the
exact branch head and expected open pull request were verified; it does not mean merged.

## Inherited setup contract

The CLI must generate and validate the standard config without local Pi, ask for provider, model,
and thinking choices, plan Plugin changes, show collisions, and expose each setup and readiness
stage. The TUI connects to the Session's one Pi RPC supervisor. Session-only model and thinking
changes persist for Resume but never rewrite Installation config.


## Resolution

Use explicit noun-first commands and make a clean alpha cut. Remove the old `beam`, top-level
`ls`, `inspect`, `steer`, `attach`, `env`, `sandbox`, `tools`, `init`, `deploy`, `upgrade`, and
`tui pair` public contracts when their canonical replacements land. Do not retain aliases. Remove
`beam down`; local Codex continuation is not part of the durable alpha Session or Publish model.

The canonical command tree is:

```text
scotty
├── setup
├── readiness
├── config
│   ├── show
│   ├── validate
│   ├── plan
│   └── sync
├── credential
│   ├── list
│   ├── status NAME
│   ├── login pi
│   ├── import pi|github
│   ├── add NAME
│   ├── replace NAME
│   ├── validate NAME
│   ├── remove NAME
│   ├── retire NAME GENERATION
│   └── bind REQUIREMENT CREDENTIAL
├── repository
│   ├── add OWNER/NAME
│   ├── list
│   ├── show OWNER/NAME
│   ├── refresh OWNER/NAME [--base REF]
│   └── remove OWNER/NAME
├── session
│   ├── create --repository OWNER/NAME [--base REF]
│   │          --provider cloudflare|runner:NAME [--cap DURATION]
│   ├── list
│   ├── show ID
│   ├── snapshot ID
│   ├── sleep ID
│   ├── resume ID
│   ├── publish ID --commit SHA [--checks POLICY]
│   └── vaporize ID
├── client
│   ├── pair ORIGIN
│   ├── status
│   └── unpair
├── owner
│   └── recover
├── runner
│   ├── setup NAME
│   ├── list
│   ├── show NAME
│   ├── drain NAME
│   ├── enable NAME
│   ├── disable NAME
│   ├── update
│   ├── remove NAME
│   └── serve
├── tui [SESSION]
├── skills
│   └── show
├── doctor
├── update [--check]
└── uninstall
```

Named Runner commands remain normal alpha commands. Session selection uses one provider grammar:
`cloudflare` or `runner:NAME`. The Runner contract must satisfy the separately defined parity gate;
registration or connection alone still cannot make a Runner create-capable.

### Setup, readiness, and configuration

`scotty setup` is one resumable first-use command, not a `plan/apply/resume` sub-tree and not a
second authoritative state machine. It finds the next safe stage from the canonical local pointer,
operation journal, and deployed owners. It shows one material plan before the first mutation,
preserves every proven effect, and resumes at the exact failed or human-blocked stage.

When `~/.config/scotty/config.json` does not exist, interactive `setup` collects only the
user-chosen Installation name and explicit Cloudflare account, writes the minimum strict config,
then plans. Noninteractive setup requires that file to exist and requires explicit approval for a
material plan. Browser and OAuth pauses return `human_action_required`; they are successful safe
pauses, exit `0`, and include purpose, expiry, completion condition, retained state, and the exact
resume command.

`scotty readiness` freshly evaluates the settled capability facts. It does not mutate them or
store a Ready state. `scotty doctor` remains local executable, file-permission, host-tool, and
connectivity diagnosis; it must not stand in for readiness.

`config show`, `validate`, `plan`, and `sync` operate on the one strict private config and active
deployed snapshot. They do not grow imperative `add` or `remove` commands for Plugins. Sync owns
the immutable preparation, complete plan, approval, revision check, atomic activation, and typed
failure result already defined by the config contract.

### Credentials, repositories, and Sessions

Credential commands use protected TTY or standard-input collection and never accept plaintext in
argv, environment, output, journals, or diagnostics. `login pi` reuses Pi API-key or Codex OAuth
behavior. `import pi|github` shows sanitized source identity and requires explicit approval.
`add`, `replace`, `validate`, `remove`, `retire`, and `bind` expose the Credential-object generation
and future-Session rules without returning values, ciphertext, or unsafe references.

Repository views always name immutable GitHub identity, requested base ref, verified source commit,
Mirror freshness, and a typed bridge or unsupported-feature blocker. Session Create revalidates
these facts, creates a prompt-free Warm Session, and reports its exact provider, deployed snapshot,
Fork, baseline checkpoint, and pinned requirement status.

During the first-use journey, the first successfully created Session enters the TUI so the human
can send the first prompt and receive the required response proof. Later interactive Create calls
return the TUI fleet with the new Session selected rather than silently entering it. `--json`
always returns the created Warm Session result and never starts an interactive TUI.

`session list` and the TUI fleet contain `provisioning`, `warm`, and `stopped` Sessions. Gone
Sessions are absent; `session show ID` may return the policy-retained tombstone. Session views show
stable lifecycle separately from operation progress. A Stopped result includes stop reason,
current checkpoint, runtime-deadline outcome, freshness of provider evidence, retained or possibly
unretained work, and exactly one next safe recovery action.

Publish is CLI-only for alpha. It selects one explicit agent-created commit, presents the prepared
point and check policy, excludes dirty paths visibly, requires approval, and returns controlled
branch, pull request, preserved human metadata, ambiguity, last proven effect, safe retry, and
cleanup. The TUI may display Publish state and its exact CLI command but does not prepare or approve
Publish. Vaporize remains a confirmed CLI operation and cannot pass an open or ambiguous Publish.

### Human and machine results

Human output is concise by default. It names the target and outcome and, when relevant, the stage,
retained valid state, ambiguity, required human action, and exact next command. Full evidence is
available through `--json` and detailed `show` or `status` commands. TTY progress may update in
place, but it never reports an effect before the owning operation proves it.

Machine output requires explicit `--json`; redirecting stdout does not change format. Every parsed
noninteractive command emits exactly one terminal JSON value, not a progress stream. Long work
returns an operation ID that a later view can observe. The common envelope is:

```json
{
  "schemaVersion": 1,
  "command": "session resume",
  "outcome": "success | human_action_required | blocked | failed | ambiguous | conflict",
  "target": {},
  "stage": "preflight | plan | prepare | apply | activate | verify | ...",
  "operationId": "op_...",
  "lastProvenEffect": {},
  "retainedState": {},
  "ambiguity": null,
  "safeRetry": false,
  "humanAction": null,
  "nextCommand": null,
  "sanitizedCause": null,
  "data": {}
}
```

Fields remain present with `null`, `false`, or an empty typed value when not applicable. `data` is
the command-specific success or observation payload. The envelope never carries a credential,
ciphertext, sentinel, provider token, raw provider response, unsafe URL, or secret-bearing cause.

Keep the stable exit taxonomy:

| Exit | Meaning |
|---:|---|
| `0` | Success, including a truthful `human_action_required` pause |
| `1` | Operational failure, blocked result, provider ambiguity, timeout, or invalid response |
| `2` | Usage, local configuration, explicit cancellation, or missing noninteractive approval |
| `3` | Target not found |
| `4` | Authentication or authorization failure |
| `5` | Wrong state, revision conflict, lease conflict, or another safe coordination conflict |

The envelope's typed code and stage are authoritative; exit codes are only coarse process classes.
Help and version remain human text unless their own explicit JSON form is later specified.

`scotty skills show` prints the release-matched embedded canonical operating Skill as Markdown by
default. With `--json`, it uses the universal envelope and returns the Skill content plus its
executable release identity and digest in `data`. `scotty update --check` observes the signed stable
release manifest without mutation; `scotty update` verifies and atomically installs the newer
executable.

Public `--host`, `--token-file`, and `SCOTTY_TOKEN` overrides are removed. Commands resolve the
selected Installation through protected local state. Any future support override must be a
separate guarded diagnostic boundary, not a global alternate authority path.

### Pairing and connection

The browser owner issues one-use pairing authority. `scotty client pair ORIGIN` collects the
credential or code without echo, validates exact origin, consumes it once, stores the standard
client credential with private permissions, and supports the same human and JSON terminal result
contract. `client status` freshly proves this terminal's paired-client relationship. The root token
never enters the TUI, a cookie, a URL, or pairing state.

`scotty tui` opens the fleet; `scotty tui SESSION` connects directly when allowed. Connection is a
client relationship with explicit `connecting`, `connected`, `reconnecting`, `stale`, and
`unavailable` views; it is not Session lifecycle. Commands remain fenced by runtime epoch and
expected Session revision. A stale receipt refreshes and requires resubmission. An unknown outcome
is never repeated automatically.

The TUI owns only the connected work surface:

- fleet and selected-Session projections;
- lifecycle plus current-operation overlay;
- repository, Fork, checkpoint, hard-cap, and recovery summary;
- transcript, core Pi tool activity and pending UI, prompt, steer, follow-up, abort, and Session
  switching;
- one rich `pi-subagents` projection; and
- the concise first-response proof banner.

Other core Pi behavior stays in sync through generic Pi protocol rendering. Remove the dedicated
workflow projection and do not promise arbitrary extension widgets as built-in Scotty behavior.
Declared Pi extensions may still use the generic pending-UI protocol defined by their pinned setup.

The TUI may request Snapshot, Sleep, and Resume through a command palette or slash actions. It
shows confirmation where interruption or stopping matters, sends the canonical backend request,
and renders the authoritative operation result; it never predicts success or owns lifecycle state.
Installation mutation, readiness repair, config and credential administration, owner recovery,
pairing issuance, repository refresh, Publish approval, Vaporize confirmation, and root authority
stay outside the TUI.

```text
private config ── setup/config/credential/repository CLI ──► control plane owners
                                                                  │
paired client ── scotty tui ──► command receipt + event stream ────┤
       ▲                         (epoch + revision fenced)          │
       │                                                           ▼
browser owner ── issues pairing                         Session + operation records

TUI projection = read owners + submit requests
TUI projection ≠ lifecycle, repository, credential, or readiness authority
```

The throwaway logic prototype exercised three contract cases: interrupted first use across an
expired human handoff; a hard-cap stop whose final checkpoint fails while the prior checkpoint
remains current; and an ambiguous Publish that blocks Vaporize until exact branch and pull-request
inspection settles it. The selected contract kept CLI JSON, human output, TUI projection, retained
state, and next safe action aligned in all three.

## Refined local-state and pairing contract

`client unpair` revokes only the calling terminal through Auth and removes its local credential
after proof. It cannot remove the browser owner, another client, or root authority. `doctor` also
reports canonical XDG roots, permissions, retention, blocked pruning, and unresolved reconciliation.
Safe local pruning runs automatically; alpha adds no broad local inspect, prune, or reset subtree.
`uninstall` proves remote Installation deletion before it removes root recovery and other local
state. Local journals are resume hints and never replace a fresh owner read.


## Refined Runner commands

Any paired terminal may issue a one-use Runner setup grant. `show` distinguishes registration,
desired mode, connection, certification, light health, capacity, assignments, and create-capable
status. Drain, enable, disable, update, and removal expose their staged authoritative results.
`serve` is the internal service entrypoint. A capacity blocker never queues or changes provider.
