---
name: scotty
description: Use when a user asks to install, initialize, configure, finish setup (finish-setup), recover, deploy, upgrade, uninstall, diagnose, launch, observe, operate, inspect, steer, attach, checkpoint, resume, beam down, vaporize, customize, authenticate, pair, use, or remove a Scotty installation or session.
---

# Scotty operating Skill

Use the existing Scotty CLI and Worker as the state machine. Compose their results; do not invent a
second setup journal, session model, or authority path. Read the current command help when a flag is
not shown here.

## Operating contract

Operational commands return one JSON value on stdout when `--json` is requested or stdout is not a
TTY. Help and `scotty skills show` are text exceptions. Keep progress out of machine stdout.
Failures are one redacted stderr envelope:

```json
{ "error": { "code": "<code>", "message": "<message>", "hint": "<next action>" } }
```

Exit codes are stable: `0` success, `1` generic or network failure, `2` usage/configuration,
`3` not found, `4` authentication, and `5` wrong state. Treat the envelope as authoritative. Retry
`2`, `4`, or `5` only after changing the input, human-approved credentials, or persisted state. Do
not automatically retry an ambiguous provider result.

Session JSON is the projection for decisions. `warm` means ready; say **working** only when
`agentState` is exactly `working`. A returned session URL is the live Pi worklog. Use it as returned;
never construct a preview, recovery, pairing, handoff, route-nonce, or Hatch URL.

The Sandbox Durable Object owns the session record, mutation lease, credential vault, backups, and
hard-cap metadata. The installation-scoped SandboxConfig owns the Pi seed, sandbox digest, and
repository registry; the local installation pointer is only a locator. Container files and runtime
memory are observations, not authority. Only one lifecycle operation may mutate a session. Snapshot
quiesces Pi before backup; vaporize keeps retry state until owned data is gone.

## Human checkpoints

The agent probes, parses, and reports. The human supplies identity, authority, and approval:

| Checkpoint        | Agent does                                                                                 | Human does                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Installation      | Ask for a unique 2–32 character lowercase name; validate it                                | Choose the name; it is never derived from a machine, user, repository, or account              |
| Cloudflare        | Ask whether the named local profile is authorized                                          | Choose the profile and complete its login; provide a profile name, never a provider credential |
| Preview/evidence  | Keep the default path unless requested                                                     | Supply both preview base and zone ID explicitly when enabling that topology                    |
| Docker            | Run `docker info`; offer a detected user-level start after approval                        | Approve a safe start or complete any install, privileged, GUI, or first-run action             |
| GitHub            | Run status probes and wait                                                                 | Complete `gh auth login` in the human's own terminal                                           |
| Mutations         | Show the plan or impact and ask before `--yes`, deployment, recovery, removal, or vaporize | Approve the named resource change; `--yes` skips confirmation, not validation                  |
| Browser authority | Explain owner recovery and revocation                                                      | Complete the browser recovery or ownership flow                                                |
| Pairing           | Give the verified origin and wait for confirmation                                         | Create the one-use pairing value and enter it at the no-echo prompt in the human terminal      |

Credentials stay in their owning terminal, browser, Worker secret boundary, or designated private
credential store. Ask whether a secure human action is complete, never for a real credential value.
One-use links, cookies, recovery values, provider secrets, and runner credentials never enter chat,
agent-supplied arguments, logs, or reports.

## Setup: ask, act, verify

Setup ends at a paired, usable terminal. It is a branch of this Skill, not a new command or a
replacement for the existing installation and session lifecycle.

### 1. Probe and collect choices

Run safe probes:

```sh
docker info
gh auth status
scotty --version
```

Ask for the installation name and Cloudflare profile before choosing a target. If evidence topology
is requested, ask for the explicit preview base and zone ID as a pair. If Docker is unavailable,
offer only an already-installed user-level runtime after human approval; do not install software or
elevate privileges. If GitHub login is missing, ask the human to run `gh auth login` locally.

**Done when:** prerequisites are healthy, or the human has one exact secure action to complete.

### 2. Create or recover the installation

For a new, empty installation, obtain explicit authorization for the displayed account and resource
topology, then run:

```sh
scotty init --name NAME --profile PROFILE --yes
```

If the human explicitly enabled the evidence topology, pass both supplied topology values with
`--enable-evidence`. `init` validates the plan, writes a private journal before apply, settles the
container, saves the managed pointer, and synchronizes the sandbox. Its machine result is:

```json
{
  "configPath": "<private-config-path>",
  "installationName": "<name>",
  "profile": "<profile>",
  "accountId": "<account-id>",
  "workerName": "<worker-name>",
  "host": "<origin>",
  "rootTokenRotated": true
}
```

If an apply is interrupted, preserve the journal and follow its typed hint. If the pointer was
committed but sandbox synchronization failed, report **installed; setup incomplete** and retry
`scotty sandbox sync`; do not roll back or create another installation.

If the installation already exists or this is a replacement device, stop and confirm that branch.
Inspect the displayed resource mapping, then run only after approval:

```sh
scotty recover --name NAME --profile PROFILE --yes
```

Recovery rotates local access for the existing resources and writes the same redacted result shape.
It does not guess an installation or adopt arbitrary resources.

**Done when:** the managed pointer is private and the installation Worker accepts sandbox
synchronization.

### 3. Synchronize the sandbox and verify health

Run:

```sh
scotty sandbox sync --json
scotty doctor --json
```

Interpret the results, do not print their hidden values:

- `sandbox sync` reports `schemaVersion`, bundle `digest`, `bytes`, `fileCount`, configured
  `skills`, `piPackages`, and `remote.status` plus `remote.activeDigest`.
- `doctor` must return `ok: true`, normally with `mode: "managed"` and installation/profile/resource
  identifiers. It proves config identity, reachability, and root-authenticated Worker access; it
  does not prove browser ownership or pairing.

**Done when:** `sandbox sync` returns a digest with remote active state `synchronized` (or its typed
divergence is reported for human choice) and `doctor` returns `ok: true` in managed mode.

### 4. Establish browser authority and pair

Explain before invoking recovery: `scotty owner recover` opens a short browser flow and revokes every
existing browser credential. After the human approves that consequence, run:

```sh
scotty owner recover --json
```

The only machine result is `{ "opened": true, "expiresAt": "<timestamp>" }`. The human completes the
opened browser flow. Never relay its URL or value.

Give the human the exact verified Worker origin as a local instruction. They open the device page,
create a one-use pairing value, and in their own terminal run:

```sh
scotty tui pair ORIGIN
scotty tui
```

They paste the value at the no-echo prompt. The agent waits for confirmation that the paired-client
configuration was written privately and the fleet console opened.

**Done when:** the intended browser owns the installation and the current human terminal can open
`scotty tui`. Report identifiers, redacted provider metadata, `doctor` status, owner completion, and
paired readiness—not credentials or links.

## Launch and observe

Start a Cloudflare session with a short outcome title and an explicit GitHub repository:

```sh
scotty beam up "PROMPT" --title "OUTCOME" --repo OWNER/NAME \
  --provider cloudflare --cap 4h --detach --json
```

Use `--new-repo` only when the human asks for a missing-repository workspace. The stable launch
projection contains `id`, `title`, `url`, `branch`, `provider`, and `status`. Keep the exact `id`.
If it is `booting`, poll `scotty ls --json`, select only that ID, and stop at `warm`, `sleeping`, or
`failed` (or after a bounded three-minute wait, such as 36 five-second polls). A launch is complete
only after the final status is observed. For failure, report `failure.code`, `failure.message`, and
`failure.recoverable` when present, then one concrete next action.

`scotty ls --json` is the fleet projection for **observe**. It includes session identity, title,
status, provider, repository/branch, cap timestamps, agent state, sandbox digest, and a typed failure
when available. Do not treat a cached row as proof of live Pi state; use `inspect` for that.

**Done when:** the exact session ID has a terminal observation for this action, or the still-booting
state and bounded timeout are explicitly reported.

## Inspect, steer, and attach

Inspect is passive and must not wake Pi:

```sh
scotty inspect ID --json
```

Use its versioned snapshot, `epoch`, `sequence`, `sessionRevision`, messages, active tools, queue,
pending UI, capabilities, and truncation markers as the current observation. Do not send a steer
based only on `ls`.

Inspect immediately before a bounded natural-language steer:

```sh
scotty steer ID "MESSAGE" --json
```

A successful result is `{ "id": "<id>", "status": "accepted", "commandId": "<id>", "epoch": "<epoch>", "sessionRevision": <n> }`.
A `stale` result carries a reason and `retryable: false`; refresh with `inspect` and obtain a new
human-approved instruction before trying again. An `unavailable` result carries a typed reason and
`retryable`; change the state or wait for the reported condition. An `ambiguous` result means the
provider outcome is unknown: inspect first and never retry it automatically. Stale/unavailable set
exit `5`; ambiguous sets exit `1`.

Inside a Scotty sandbox, inspect/steer use the sandbox-internal session authority. Outside one, use
the configured authenticated Worker. The message must be non-empty, natural language, and not a
slash command.

Open a warm session in the paired browser:

```sh
scotty attach ID --json
```

The result is `{ "id": "<id>", "url": "<sanitized-session-path>", "opened": true }`. Call the URL
the **live Pi worklog**. `attach` opens it; it does not mint a credential handoff. Use the paired
terminal's `scotty tui` to switch among existing warm sessions.

**Done when:** the requested observation, accepted steer, or opened worklog is represented by its
validated result; stale or unknown outcomes remain visible as such.

## Hatch and browser evidence

Inspect the repository application and install its locked dependencies before naming selectors or
starting a server. Define one bounded declarative flow with at most three observable checks.

Use the first-party tools inside a warm session:

- `scotty_hatch ensure` owns one permanent application service on an allowed port; `status` and
  `close` observe or close that Hatch. Keep the service running for the human's live view.
- Open Hatch from the paired worklog's **Open Hatch** control. The session path plus `/hatch/open`
  opens it. Never copy, guess, or publish the wildcard preview origin, handoff token, route nonce,
  or Hatch cookie.
- `scotty_browser_test` runs one bounded browser flow.
- Keep the exact same viewport, steps, and assertions. Run it before the change with
  `capture.video: false`, then after the change with `capture.video: true`. The after run must
  produce one actual WebM recording; screenshots or replay events are not a substitute.

In the final session update, include each exact structured `scotty-hatch:<hatchId>` and
`scotty-evidence:<jobId>` reference at most once, only when returned by the first-party tool for the
current conversation. Never invent, alter, repeat, or replace a reference with a URL, port, path,
argument, cookie, or credential. A passing before run plus a passing after run with the same flow and
viewport creates a private Showcase.

**Done when:** the app remains available through Hatch, both evidence runs have matching flow and
viewport, the after run has real WebM, and every published reference is exact, current, and private.

## Lifecycle: snapshot, resume, down, vaporize

The normal state path is `booting -> warm -> sleeping -> booting -> warm`; failures may enter
`failed`, and vaporize ends at `gone`.

- Checkpoint a warm session with `scotty snapshot ID --json`. Read the returned `id`, `status`, and
  optional `backupId`; snapshot stops Pi before synchronization and backup.
- Restore a sleeping or recoverably failed session with `scotty resume ID --json`. Resume requires
  the current backup. If it returns `booting`, observe the exact ID with `scotty ls --json`.
- From the matching local Git repository, run `scotty beam down ID --json`. Read `branch`, `sha`,
  `rolloutPath`, and `resumeCmd`; run a non-null `resumeCmd` only when the human wants local
  continuation. Do not compose a rollout or resume command.
- Before permanent deletion, snapshot the work and obtain explicit approval. Then run
  `scotty beam vaporize ID --yes --json`; success is exactly `{ "id": "<id>", "status": "gone" }`.

Vaporize retries until owned state is gone and never claims success from an ambiguous provider
state. Do not use it as a substitute for a checkpoint. Interrupted lifecycle work retains retry
state or publishes a typed failure.

**Done when:** the returned state matches the requested transition, or the typed pending/failure
state and one safe next action are reported.

## Repositories and environment

Repository registration verifies GitHub identity before a launch that uses the catalogue:

```sh
scotty repo add OWNER/NAME --json
scotty repo list --json
scotty repo remove OWNER/NAME --json
```

Use only `OWNER/NAME`; never replace it with a guessed owner or local path. The list is a projection,
not a credential store.

The public environment family manages global or repository-scoped values:

```sh
scotty env list --json
scotty env set NAME VALUE --json
scotty env set NAME --secret --stdin --json
scotty env remove NAME --json
scotty env refresh ID --json
```

Never put a secret value on argv. Use the write-only stdin path. A running session may need
`env refresh` after its repository or global environment revision changes.

**Done when:** the repository or environment projection confirms the intended revision and no secret
value appeared in command arguments or output.

## Sandbox customization

The standard image toolset and built-in Pi packages remain available. Extra Skills and Git-backed Pi
packages are installation-scoped sources:

```sh
scotty sandbox add SOURCE [--ref REF] --json
scotty sandbox remove NAME --json
scotty sandbox list --json
scotty sandbox sync --json
```

A local Skill source contains its checked-in `SKILL.md`. A Git package requires an explicit ref that
resolves to a commit; do not use a moving ref as the lock. `sandbox list` shows local desired sources
and remote status. `sandbox sync` builds a deterministic bundle, reports its digest, and activates
that immutable digest in the installation. `remote.status` distinguishes `not_queried`,
`unavailable`, `synchronized`, and `diverged`.

New sessions pin the active digest. Removing a source or activating a newer bundle does not rewrite
a running session, its built-in image tools, or an existing backup; resume restores the session's
original pin.

**Done when:** the desired source list is valid, sync returns a digest, and remote active state is
`synchronized` or its typed divergence is reported for human choice.

## Browser authority

Session model credentials come from the installation environment authority (`scotty env set
GH_TOKEN --secret` and `scotty env set OPENAI_API_KEY --secret`); sessions receive only per-session
sentinels, never real values.

The Auth Durable Object owns the browser owner, standard clients, pairing, transfer, recovery, and
revocation. It stores credential digests only. The root authority is bearer-only and recovery
authority; it is not a browser cookie or a URL. A standard paired client has session read/write
scope; owner-only browser management must stay in the primary browser or the recovery flow.

`doctor` and a session URL do not prove browser authority. `owner recover` revokes all existing
browser credentials, and the human must finish the browser flow before pairing a new terminal. Keep
pairing values and browser cookies in the human browser/terminal boundary.

**Done when:** browser ownership is confirmed by the human rather than inferred from a URL.

## Tools and runners

Inspect the standard image toolset with:

```sh
scotty tools list --json
scotty tools doctor --json
```

`tools list` returns the standard manifest. `tools doctor` returns `{toolset,ok,tools}`; each tool
has `name`, `status`, `version`, and `expectedVersion`. Status is `ok`, `missing`, `failed`, or
`version-mismatch`; a non-`ok` report is nonzero and is not a success to paper over.

Runner registration is available, but runner-backed session creation remains disabled until native
Pi RPC transport and deployed lifecycle proof exist. For the supported runner surface:

- `scotty runner setup` registers and installs a trusted user service from explicit, digest-pinned
  inputs and human-owned private local sources.
- `scotty runner serve` serves one explicitly named runner over its outbound control connection.
- `scotty runner list --json` reports each runner's desired state, connection state, last-seen time,
  and assigned session count.
- `scotty runner remove NAME --yes --json` disables and unregisters a runner only after its assigned
  sessions are gone.

Runner names are user-supplied. Never infer them from an account, repository, username, or machine.
Keep runner credentials and provider source files on the human-managed host boundary.

**Done when:** tools are healthy, or each typed missing/version/connection result has a concrete
remediation; runner creation is not presented as available.

## Installation lifecycle and diagnostics

- `scotty deploy --yes --json` plans and applies managed code/resource changes for the saved
  installation. Show the changed plan first and obtain human authorization; credentials remain
  unchanged.
- `scotty upgrade --json` verifies the signed release manifest and executable hash before replacing
  the current CLI.
- `scotty recover` is the existing-installation access rotation described in Setup; preserve its
  journal and typed failure.
- `scotty uninstall --yes --json` stops active sessions and removes compute while retaining KV/R2
  data by default. Add `--delete-data` only after explicit approval to delete retained indexes,
  backups, and evidence objects too.
- `scotty doctor --json` is the first diagnostic for local config, reachability, and root-authenticated
  access. Follow its typed hint; do not delete local state to hide a failure.

For an interrupted apply, snapshot, resume, auth rotation, or deletion, preserve retry state. Change
the relevant input, authorized credential state, or persisted session state before retrying. Never
report success when the provider's final state is unknown.

**Done when:** the installation command's machine result, retained-data choice, and any pending
recovery work are explicit and human-approved.

## Embedded guide

`scotty skills` shows this command group's help. `scotty skills show` emits this exact Markdown source
and is Markdown-only. It does not contact the network or install another guide; use it as the single
source for this operating model.
