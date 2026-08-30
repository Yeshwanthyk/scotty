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
npm run lab -- exec "$RUN_ID" -- read "$SESSION_ID" --last 5 --json
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
