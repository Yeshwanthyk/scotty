# Scotty lab migration gate

The minimal lab is the repository-wide baseline compatibility gate for every future complexity
slice. Run
it around each coherent file or behavior change, not only changes to the lab itself. A slice must
be small enough that any divergence has one plausible change set to inspect.

## Required before/after flow

Run this exact flow **before moving code** and again **after the move is complete**:

```sh
npm run lab -- start
npm run lab -- exec RUN_ID -- doctor --json
npm run lab -- stop RUN_ID
```

Use the `RUN_ID` printed by that run's `start`. Capture stdout, stderr, and exit status for all three
commands. Both runs must use the real production Worker configuration through Wrangler local mode
and the actual Bun `cli/scotty.ts` entry point. Do not replace this gate with mocks, a fake Worker,
or a deployed stage. `doctor` proves the CLI/Worker handoff but does not create a Sandbox instance.

## Test transcript reads

`exec` forwards the complete `read` invocation to the real CLI. First configure the running lab
with one deliberately chosen disposable repository. `setup` writes only private credential source
pointers into the isolated CLI home and runs the real `scotty sync --json`:

```sh
npm run lab -- setup "$RUN_ID" --repo OWNER/DISPOSABLE_REPO
```

The local Pi auth file and GitHub CLI login must already be available. Their credential values do
not enter the lab manifest, CLI environment, TOML file, output, or repository. Create one disposable
session through the existing `exec` path:

```sh
BEAM_OUTPUT="$(npm run lab -- exec "$RUN_ID" -- \
  beam "Reply with exactly LAB_READ_INITIAL_READY." \
  --title "CLI read lab proof" \
  --repo OWNER/DISPOSABLE_REPO \
  --provider cloudflare \
  --cap 30m \
  --detach \
  --json)"
SESSION_ID="$(printf '%s\n' "$BEAM_OUTPUT" | tail -n 1 | jq -r '.id')"
```

Then read a bounded snapshot with:

```sh
READ_OUTPUT="$(npm --silent run lab -- exec "$RUN_ID" -- \
  read "$SESSION_ID" --last 5 --json)"
printf '%s\n' "$READ_OUTPUT"
SEQUENCE="$(printf '%s\n' "$READ_OUTPUT" | jq -er '.sequence')"
```

The result contains the session `id`, current `epoch` and `sequence`, readable `messages`, and the
snapshot `truncated` flag. Save `sequence` as the next passive cursor. To test follow mode, start
this in one terminal:

```sh
npm run lab -- exec "$RUN_ID" -- \
  read "$SESSION_ID" --since "$SEQUENCE" --last 5 --follow --json
```

Then send one message from another terminal:

```sh
npm run lab -- exec "$RUN_ID" -- \
  steer "$SESSION_ID" "Reply with exactly LAB_READ_READY." --json
```

The first terminal must print only a new or changed user or assistant message. Stop it with
Control-C after `LAB_READ_READY` appears. Do not resend an ambiguous `steer`. Use `inspect --json`
when the test needs state, active tools, queues, pending UI, or protocol details instead of readable
transcript text.

Always vaporize the disposable session and run `npm run lab -- stop "$RUN_ID"`, including after a
failed read or interrupted follow. A one-shot read proves the passive Worker route and current Pi
snapshot. It does not prove follow behavior; that requires the separate `steer` and changed-message
observation above.

Use the same representative CLI operation on both sides when a slice affects behavior beyond
`doctor`; add its arguments after `exec RUN_ID --`. A Sandbox or session-lifecycle slice must use a
deliberately chosen test repository and exercise the affected real local lifecycle; do not claim
Sandbox proof from `doctor`. Compare command availability, the mandatory `exec` `--` separator,
JSON shapes, exit statuses, Worker readiness, credential isolation, process ownership checks, and
cleanup results. Run-specific values such as the run ID, PID, temporary paths, generated token,
and timestamps may differ; their formats and security properties may not.

**Stop the slice immediately on any unexplained divergence.** Do not add more complexity, update the
expected result, or continue migration work until the first difference is understood and either
fixed or explicitly approved as a contract change. If `start` fails, still run `stop` for any
persisted run and resolve `cleanup-pending` before continuing.

Only commit the slice after the second run and the relevant static checks pass. This gate is
local-only and does not authorize deployment.

## Lifecycle evidence driver

The lab also exposes one active-run lifecycle driver. It resolves the run only from the exact
private `.scotty-lab/run.json` manifest; lifecycle commands do not accept or infer an installation,
account, deployment, or run identity.

```sh
npm run lab -- lifecycle create-and-ready --repo OWNER/DISPOSABLE_REPO
npm run lab -- lifecycle checkpoint --session SESSION_ID
npm run lab -- lifecycle sleep-resume --session SESSION_ID
npm run lab -- lifecycle runtime-loss --session SESSION_ID
npm run lab -- lifecycle hard-cap --session SESSION_ID
npm run lab -- lifecycle vaporize --session SESSION_ID
npm run lab -- lifecycle full --repo OWNER/DISPOSABLE_REPO
```

`create-and-ready` invokes the real CLI `beam` command through the isolated lab configuration and
records a valid returned session ID before checking whether the result is warm. All later lifecycle
commands require that exact session ID in the active run's evidence manifest. Session
`6ffa0a512819` is protected and is rejected by both lifecycle commands and the general lab `exec`
path. Vaporize can target only a session recorded as owned by the active run.

`checkpoint` invokes the real CLI `snapshot` command. A manual snapshot stops Pi and interactive
terminals while writing the backup, then restores the warm runtime; it is not the sleep transition.
`sleep-resume` uses the authenticated public `POST /api/sessions/:id/sleep` route through the exact
loopback lab host and root token, records its sanitized response and HTTP status, then invokes the
real CLI `resume` command. It never writes Durable Object storage or desired state directly.

Every run retains private evidence under `.scotty-lab/evidence/RUN_ID/`, outside the ephemeral
temporary root. Directories are mode `0700`; `run.json` and `commands.jsonl` are mode `0600` and
updated by atomic replacement. The run manifest records session ownership, scenario results, and
the final stop cleanup result. Command records contain only the driver's allow-listed argv,
sanitized stdout and stderr, exit code or signal, Effect-clock timestamps, scenario, and ownership
context. They do not capture the process environment, credential values, authorization headers, or
arbitrary forwarded `exec` traffic. `stop` removes the runtime temporary root but preserves this
evidence directory.

The guarded fault vocabulary is:

```text
after-intent-commit
before-provider-dispatch
after-provider-dispatch
before-observation-commit
after-observation-commit
runtime-stopped
supervisor-lost
provider-response-lost
alarm-duplicated
```

Pass a value as `--fault VALUE` to any lifecycle scenario. Fault controls are not yet exposed by
the actor runner, so every requested fault fails as a recorded `not-available` result before any
lifecycle action. `runtime-loss` and `hard-cap` likewise return recorded `not-available` results;
the lab does not simulate desired state or write internal storage. `full` runs the supported public
create, checkpoint, sleep, resume, and vaporize steps in order. It retains all evidence after the
owned session is gone.

The evidence manifest also marks actor authority revision, operation journal, and provider snapshot
observations as `not-available`. Current evidence proves only the local public HTTP/CLI paths and
their observed outputs. It does not prove internal actor revision/journal ordering, provider state,
fault recovery, hard-cap alarm behavior, deployed behavior, or absence of post-response provider
ambiguity.
