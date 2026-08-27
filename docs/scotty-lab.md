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
