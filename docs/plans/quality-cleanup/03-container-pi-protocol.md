# Q3 — Container Pi protocol

## Orientation

The container Pi path currently works, but two files mix three different kinds of work:

1. `worker/container/scotty-pi-protocol.mjs` validates and sanitizes Pi/browser wire values while also maintaining pending-UI and projection state.
2. `worker/container/scotty-pi-session.mjs` owns the native Node process and HTTP server while also deciding snapshot, command, replay, and quiesce transitions.

This ticket makes the existing seams explicit without changing the design: keep wire decoding and encoding pure, keep session transitions separate from callbacks that perform I/O, and leave `scotty-pi-session.mjs` as the native host adapter. Keep the separation inside these two files; do not add a framework, service layer, class hierarchy, or new source module merely to move code.

The result must preserve byte-delimited Pi JSONL, RPC request/response behavior, HTTP/SSE records, session-local state, child-process ownership, and credential isolation. This is a behavior-preserving complexity cleanup, not a protocol version, browser projection, session lifecycle, or Container redesign.

## Settled decisions

- Scope production edits to:
  - `worker/container/scotty-pi-protocol.mjs`
  - `worker/container/scotty-pi-session.mjs`
- Keep `worker/container/scotty-jsonl.mjs` as the existing LF framing boundary. Do not rewrite it or move framing into a new abstraction.
- Keep the current exported protocol API and observable records stable unless an additional private pure helper is needed to make a live decision legible.
- Prefer small named functions and data-directed dispatch over classes or generalized codecs.
- Keep mutable session state owned by the one supervisor process. Do not persist it or move authority out of the session Sandbox Durable Object.
- Keep native Node APIs in `scotty-pi-session.mjs`: environment reads, token-file consumption, `spawn`, child streams, timers, HTTP server, SSE writes, and signal handling.
- Use the existing tests as characterization. Add or edit a test only if a moved live contract is not already asserted; do not invent negative paths.
- Do not migrate either file to Effect or add either file to the strict migrated-production Oxlint override.
- Do not redesign TUI/browser consumers, Worker routes, `ContainerAuth`, shared console contracts, or adjacent session lifecycle code.

## Scope and contracts to preserve

### Wire and RPC

- Pi stdin/stdout remains one JSON object per LF-delimited record; Unicode separators and chunk boundaries remain valid record content.
- RPC IDs still correlate exactly one response, use the current 30-second timeout, and reject outstanding requests when the child exits.
- Unmatched valid Pi messages still enter event handling; malformed stdout still appends one `scotty_protocol_error` event and retains only the bounded diagnostic tail.
- `normalizeCommand` keeps protocol version, epoch, command ID, expected revision, image limits, slash-command translation, and current error codes unchanged.
- Receipt and in-flight maps remain keyed by `epoch + commandId`; each entry retains `commandIntentDigest`. The same key and digest replays or shares the in-flight Promise, while the same key with a different digest returns `command_id_conflict`.
- HTTP status codes, JSON error envelopes, snapshot shape, receipt shape, SSE `id`/`data` records, heartbeat behavior, event ordering, and truncation limits remain byte-for-byte equivalent apart from run-specific values.
- `extension_ui_response` remains `delivery: "unconfirmed"`; do not upgrade this contract during cleanup.

### Session transitions

- `epoch` remains process-local and random; `sequence` remains monotonic; the event ring remains bounded to `PI_CONSOLE_MAX_EVENTS`.
- Snapshot still brackets its RPC reads with `baseSequence` and `endSequence`, requires a complete contiguous overlap, and retries at most `snapshotAttempts` times.
- Pending UI tracking, expiry, overflow cancellation, delivery marking, settlement clearing, and projection clearing retain their current ordering.
- Quiesce still marks the session quiescing first, cancels pending UI, aborts only a streaming Pi state, polls until non-streaming, and then permits the caller to continue shutdown.
- Initial prompt consumption, `--continue`, readiness, close, force-kill, and child-exit behavior remain unchanged.

### Process and credential ownership

- The supervisor remains the sole owner of the `pi --mode rpc` child and its stdin/stdout/stderr.
- `SCOTTY_PI_SESSION_TOKEN_FILE` is read once, validated, and unlinked before serving authenticated protocol routes.
- `x-scotty-pi-session` remains required outside `/health` and is compared with equal-length `timingSafeEqual` buffers.
- `SCOTTY_PI_BINARY` and `SCOTTY_PI_SESSION_TOKEN_FILE` remain removed from the child environment.
- Real Codex and GitHub credentials must not enter child arguments, protocol events, HTTP responses, logs, or persisted container state. Existing session-bound sentinel sanitization remains in force.

## Target flow

```text
Pi stdout bytes
  -> existing LF record parser
  -> pure JSON record decode / extension-event normalization
  -> session transition (resolve RPC OR update UI/projection/event state)
  -> bounded event envelope
  -> native SSE writer

HTTP command bytes
  -> native bounded body reader
  -> pure command-envelope decode/normalization
  -> session transition (quiesce/replay/in-flight/delivery decision)
  -> native Pi stdin JSONL write
  -> pure receipt/error value
  -> native bounded JSON response

snapshot request
  -> session snapshot transition
  -> native RPC calls
  -> pure sanitization/capability projection/overlap check
  -> stable snapshot value
  -> native bounded JSON response
```

No new authority or storage is introduced. Pure helpers return values; transition functions update only the existing process-local maps, sets, reducers, and flags; host adapters alone touch Node streams, HTTP objects, timers, files, processes, and signals.

## Starting proof

Run this ticket in a fresh session.

### 1. Establish a clean starting commit

```sh
git switch main
git status --short --branch
BASE_COMMIT="$(git rev-parse HEAD)"
printf 'BASE_COMMIT=%s\n' "$BASE_COMMIT"
git merge-base --is-ancestor 14baadf5768792c28992b79d038055037cb960bf HEAD
```

`git status --porcelain` must be empty before editing. Do not reset, clean, or discard someone else's work to obtain that state. The DAG baseline was `14baadf5768792c28992b79d038055037cb960bf`; the actual clean starting commit may be newer because this plan or an independent DAG branch landed first. Record the exact `BASE_COMMIT` in the handoff.

### 2. Recount live complexity

```sh
./node_modules/.bin/oxlint --disable-nested-config . \
  > /tmp/q3-oxlint-before.txt 2>&1 || test "$?" -eq 1
grep -c 'eslint(complexity)' /tmp/q3-oxlint-before.txt
grep -E 'worker/container/scotty-pi-(protocol|session)\.mjs.*eslint\(complexity\)' \
  /tmp/q3-oxlint-before.txt
```

At drafting commit `14baadf5`, the repository has 64 complexity findings and these files own eight:

| File                     | Live symbol                                          | Complexity |
| ------------------------ | ---------------------------------------------------- | ---------: |
| `scotty-pi-protocol.mjs` | `browserValidTranscript`                             |         25 |
|                          | `browserValidChild`                                  |         43 |
|                          | `canonicalizePiSubagentsActivity`                    |         21 |
|                          | `normalizeExtensionUiEvent`                          |         56 |
|                          | inner `reduce` returned by `createProjectionReducer` |         31 |
|                          | `validIntent`                                        |         37 |
| `scotty-pi-session.mjs`  | `snapshotAttempt`                                    |         34 |
|                          | `createServer` request callback                      |         34 |

Use the recount, not this table, as execution truth. If the target findings changed, re-open the live functions and update the implementation sequence before editing; do not refactor stale line numbers.

### 3. Run focused characterization

```sh
npx vitest run worker/test/scotty-pi-protocol.test.mjs
node --test scripts/pi-session-supervisor.test.mjs
npx vitest run \
  worker/test/container-auth.test.ts \
  worker/test/session-auth-reseed.test.ts \
  worker/test/pi-console-protocol.test.ts \
  worker/test/session-worklog.test.ts
```

The first two are the direct protocol/supervisor proof. The surrounding tests protect Container process ownership, token/sentinel handling, Worker-facing console records, and worklog behavior.

### 4. Capture the exact real local lab proof

Use one already-authorized disposable GitHub repository. Set it explicitly; never derive it from a user, machine, installation, or Cloudflare account.

```sh
export QUALITY_REPO='OWNER/DISPOSABLE_REPO'
export PROOF_SIDE='before' # use "after" for the second run
export EVIDENCE="/tmp/q3-container-pi-protocol-$PROOF_SIDE"
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"
set -euo pipefail

run_capture() {
  label="$1"
  shift
  set +e
  "$@" >"$EVIDENCE/$label.stdout" 2>"$EVIDENCE/$label.stderr"
  code="$?"
  set -e
  printf '%s\n' "$code" >"$EVIDENCE/$label.status"
  return "$code"
}

run_capture start npm run lab -- start
RUN_ID="$(jq -r '.runId' "$EVIDENCE/start.stdout")"
SESSION_ID=''

cleanup_lab() {
  original_status="$?"
  trap - EXIT
  set +e
  if test -n "$SESSION_ID"; then
    run_capture cleanup-vaporize npm run lab -- exec "$RUN_ID" -- \
      beam vaporize "$SESSION_ID" --yes --json || true
  fi
  if test -n "$RUN_ID"; then
    run_capture cleanup-stop npm run lab -- stop "$RUN_ID" || true
  fi
  exit "$original_status"
}
trap cleanup_lab EXIT

run_capture doctor npm run lab -- exec "$RUN_ID" -- doctor --json

run_capture beam-up npm run lab -- exec "$RUN_ID" -- beam up \
  'Reply with exactly Q3_INITIAL_READY and do nothing else.' \
  --title 'Q3 Pi protocol proof' \
  --repo "$QUALITY_REPO" \
  --provider cloudflare \
  --cap 30m \
  --detach \
  --json
SESSION_ID="$(jq -r '.id' "$EVIDENCE/beam-up.stdout")"

# Passive snapshot path.
run_capture inspect-initial npm run lab -- exec "$RUN_ID" -- inspect "$SESSION_ID" --json
jq -e --arg id "$SESSION_ID" \
  '.id == $id and .version == 1 and (.epoch | type == "string") and
  (.sequence | type == "number") and (.messages | type == "array")' \
  "$EVIDENCE/inspect-initial.stdout"

# Command path: fresh snapshot -> normalized command -> Pi JSONL RPC -> receipt.
run_capture steer npm run lab -- exec "$RUN_ID" -- steer "$SESSION_ID" \
  'Reply with exactly Q3_STEER_READY and do nothing else.' --json
jq -e --arg id "$SESSION_ID" '.id == $id and .status == "accepted"' \
  "$EVIDENCE/steer.stdout"

# Poll only by repeating passive inspect; do not resend the command.
for attempt in $(seq 1 60); do
  run_capture "inspect-$attempt" npm run lab -- exec "$RUN_ID" -- inspect "$SESSION_ID" --json
  if jq -e '(.state.isStreaming == false) and
    any(.messages[]?; .role == "assistant" and ((.content | tostring) | contains("Q3_STEER_READY")))' \
    "$EVIDENCE/inspect-$attempt.stdout" >/dev/null; then
    printf '%s\n' "$attempt" >"$EVIDENCE/settled-attempt"
    break
  fi
  sleep 2
done
test -s "$EVIDENCE/settled-attempt"

run_capture vaporize npm run lab -- exec "$RUN_ID" -- beam vaporize "$SESSION_ID" --yes --json
SESSION_ID=''
run_capture stop npm run lab -- stop "$RUN_ID"
RUN_ID=''
trap - EXIT
```

If any command after `start` fails, still attempt `beam vaporize` when a session ID exists and always run `stop`; resolve `cleanup-pending` before proceeding. Capture stdout, stderr, and status for every command. Before and after must use the same repository, title, prompts, cap, assertions, and polling bound. Compare stable shapes, statuses, event/snapshot semantics, and cleanup. Run IDs, session IDs, epochs, sequences, PIDs, paths, tokens, and timestamps may differ. Stop at the first unexplained difference instead of changing expectations.

This is local proof through the production Worker configuration, actual CLI entry point, a real local Sandbox session, Pi RPC JSONL, passive snapshot, command delivery, child-process shutdown, and cleanup. It is not deployed proof and does not authorize deployment.

## Files and concrete starting symbols

### `worker/container/scotty-pi-protocol.mjs`

- Wire bounds and sanitization: `PI_CONSOLE_*`, `sanitizeRemoteString`, `sanitizeRemoteValue`, `sanitizeRemoteEvent`.
- Browser widget decoding: `browserValidTranscript`, `browserValidTool`, `browserValidQueued`, `browserValidUsage`, `browserValidChild`, `browserValidTerminal`, `canonicalizePiSubagentsActivity`, `normalizePiSubagentsActivityWidget`.
- Extension-event decoding: `optionalTimeout`, `normalizeExtensionUiEvent`.
- Session projection transitions: `createPendingUiTracker`, `createProjectionReducer`, `completeSnapshotOverlap`.
- Command decoding: `validImages`, `validIntent`, `normalizeCommand`.
- Capability projection: `filterRemoteCommands`.

### `worker/container/scotty-pi-session.mjs`

- Native bootstrap and ownership: environment constants, token-file read/unlink, `childEnv`, `spawn`, signal handlers, `close`.
- Native wire I/O: `jsonResponse`, `writeSse`, `sendRpc`, `sendRpcWithoutResponse`, `stdoutRecords`, child stream handlers, `readJsonBody`, `hasTransportCapability`.
- Session transitions: `appendEvent`, `rememberReceipt`, `handlePiMessage`, `snapshotAttempt`, `snapshot`, `quiesce`, `executeCommand`, `handleCommand`.
- HTTP host boundary: the `createServer` callback and route bodies.

### Existing proof

- `worker/test/scotty-pi-protocol.test.mjs`
- `scripts/pi-session-supervisor.test.mjs`
- `worker/test/container-auth.test.ts`
- `worker/test/session-auth-reseed.test.ts`
- `worker/test/pi-console-protocol.test.ts`
- `worker/test/session-worklog.test.ts`

## Implementation chunks

### Chunk 1 — Make wire decoding visibly pure

**Behavior delivered:** The same accepted and rejected Pi/browser command and event values and the same sanitization, with branch-heavy decoding split into small method- or variant-specific helpers. Existing JSONL, HTTP, and SSE encoders remain the separate, already-small host writers.

**Files and symbols:**

- `worker/container/scotty-pi-protocol.mjs`
  - split the live branches in `browserValidTranscript`, `browserValidChild`, `canonicalizePiSubagentsActivity`, `normalizeExtensionUiEvent`, and `validIntent` into narrowly named pure helpers;
  - keep the current public functions as stable entry points;
  - avoid a generic schema/codec DSL or broad renaming.

**Execution path:** HTTP/Pi input -> bounded parse/normalize -> existing normalized value or existing error/drop decision; existing output value -> `JSON.stringify` plus the same delimiter or HTTP/SSE framing.

**Dependency:** None.

**Completion check:**

```sh
npx vitest run worker/test/scotty-pi-protocol.test.mjs
node --test scripts/pi-session-supervisor.test.mjs
```

**Risk:** Accidental shape drift from rebuilding objects in a different order or treating `undefined`, `null`, and invalid values alike. Compare assertions and supervisor records exactly; do not loosen a decoder to simplify it.

### Chunk 2 — Isolate session transitions from effects

**Behavior delivered:** Pending UI, projection, snapshot, receipt/replay, in-flight command, and quiesce decisions remain in small transition functions; native reads/writes are passed in or called by a thin orchestrator rather than interleaved with decision branches.

**Files and symbols:**

- `worker/container/scotty-pi-protocol.mjs`
  - decompose only the branch-heavy inner `reduce` in `createProjectionReducer` into explicit event transition helpers while preserving its returned API and bounded maps.
- `worker/container/scotty-pi-session.mjs`
  - separate snapshot response projection from `snapshotAttempt`'s RPC calls;
  - leave `handlePiMessage`, `executeCommand`, `handleCommand`, `quiesce`, receipt/replay, and in-flight command structure unchanged;
  - retain the same maps, sets, flags, retry counts, receipt keys, and pending-UI authority value.

**Execution path:** normalized input -> one transition decision -> existing state mutation -> requested native effect -> stable output value.

**Dependency:** Chunk 1 establishes the pure input/output functions consumed here.

**Completion check:**

```sh
npx vitest run worker/test/scotty-pi-protocol.test.mjs
node --test scripts/pi-session-supervisor.test.mjs
npx vitest run worker/test/pi-console-protocol.test.ts worker/test/session-worklog.test.ts
```

**Risk:** Reordering a mutation around an awaited RPC can change replay, pending-UI, overlap, or shutdown behavior. Preserve current ordering first; simplify only after the focused proof stays green.

### Chunk 3 — Thin the native host callbacks

**Behavior delivered:** Child stream callbacks and HTTP route callbacks perform native I/O and delegate decisions to the helpers from chunks 1–2. Routes, status codes, response limits, authentication, SSE subscription lifetime, and process shutdown remain unchanged.

**Files and symbols:**

- `worker/container/scotty-pi-session.mjs`
  - replace the branch-heavy `createServer` callback with small exact route handlers or one simple dispatcher;
  - keep `/health` before capability auth and preserve auth ordering for `/snapshot`, `/events`, `/command`, and `/quiesce`;
  - keep child creation, stream listeners, `server.listen`, `close`, and signal handlers as direct Node host code.

**Execution path:** native HTTP/process event -> exact route or stream adapter -> transition/helper -> native response/write.

**Dependency:** Chunks 1 and 2 provide stable helpers; do not create a second server or process owner.

**Completion check:**

```sh
node --test scripts/pi-session-supervisor.test.mjs
npx vitest run worker/test/container-auth.test.ts worker/test/session-auth-reseed.test.ts
./node_modules/.bin/oxlint --disable-nested-config \
  worker/container/scotty-pi-protocol.mjs \
  worker/container/scotty-pi-session.mjs
```

**Risk:** Route precedence or response-finalization drift. Keep one response owner per request and retain the current early returns.

## Verification matrix

### Focused proof after implementation

Run formatting before lint so diagnostics refer to final lines:

```sh
npm run fmt
npm run lint:skills
npx vitest run worker/test/scotty-pi-protocol.test.mjs
node --test scripts/pi-session-supervisor.test.mjs
npx vitest run \
  worker/test/container-auth.test.ts \
  worker/test/session-auth-reseed.test.ts \
  worker/test/pi-console-protocol.test.ts \
  worker/test/session-worklog.test.ts
npm run typecheck:worker
npm run knip:check
./node_modules/.bin/oxlint --disable-nested-config \
  worker/container/scotty-pi-protocol.mjs \
  worker/container/scotty-pi-session.mjs
```

The changed-file Oxlint command must exit zero. No inline complexity suppression is acceptable.

### Exact after lab proof

Repeat the complete script in **Starting proof §4** with:

```sh
export PROOF_SIDE='after'
```

Use the same `QUALITY_REPO` and assertions. Compare `/tmp/q3-container-pi-protocol-before` and `/tmp/q3-container-pi-protocol-after`, ignoring only the listed run-specific values. If they diverge, stop at the first difference and do not proceed to the full suite or commit.

### Full repository proof

```sh
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run knip:check
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
```

Do not deploy. A passing local lab and full suite do not replace the guarded Alchemy deployment/canary required for production proof.

### Complexity recount

```sh
./node_modules/.bin/oxlint --disable-nested-config . \
  > /tmp/q3-oxlint-after.txt 2>&1 || test "$?" -eq 1
grep -c 'eslint(complexity)' /tmp/q3-oxlint-after.txt
grep -E 'worker/container/scotty-pi-(protocol|session)\.mjs.*eslint\(complexity\)' \
  /tmp/q3-oxlint-after.txt || true
```

Expected reduction: all eight target findings disappear and no diagnostic is added. If no earlier DAG branch changed the baseline, the repository count moves from 64 to 56; otherwise it moves from the recounted `N` to `N - 8`. Rough file length is only a cohesion signal: do not chase line count with extra modules or abstractions.

## Rollout and commit

This slice changes no persisted format and needs no migration or staged rollout. Local proof is sufficient to commit the cleanup; deployment remains separate and user-authorized.

After every verification above passes:

```sh
git diff --check
git status --short
git diff -- \
  worker/container/scotty-pi-protocol.mjs \
  worker/container/scotty-pi-session.mjs \
  worker/test/scotty-pi-protocol.test.mjs \
  scripts/pi-session-supervisor.test.mjs
git add worker/container/scotty-pi-protocol.mjs worker/container/scotty-pi-session.mjs
# Add either test file only if a real touched contract required characterization.
git commit -m "refactor(container): separate Pi protocol transitions"
git status --short --branch
```

The commit must contain one coherent behavior-preserving slice and leave a clean worktree. Do not include unrelated files, this plan, generated lab evidence, or formatting churn outside the touched files.

## Risks

- **Record drift:** rebuilding normalized objects can change omitted versus `null` fields or JSON key order. Preserve exact fixtures and supervisor assertions.
- **Ordering drift:** moving an await or mutation can change snapshot overlap, deduplication, pending UI, or shutdown. Keep transition order visible and unchanged.
- **Hidden second owner:** a generalized transport/session object could accidentally own timers, process lifetime, or responses. Keep one supervisor, one child, and one server.
- **Scope growth:** widget semantics, Pi version naming, browser behavior, Worker routes, and Effect migration are adjacent but not part of this ticket.

## Known out-of-scope contract literal

No implementation decision remains open for this ticket. One adjacent wording inconsistency exists: the snapshot emits

```json
{
  "status": "partial",
  "reason": "pi_0_83_signal_cancellation_unobservable"
}
```

while current test descriptions refer to Pi 0.84. Preserve the exact field and value. Whether to rename it is a separate contract decision and does not gate this refactor.

## Handoff and stop criteria

Handoff must state:

- exact `BASE_COMMIT` and final commit;
- target complexity recount before and after, plus repository total before and after;
- the seam actually produced, naming the final live helpers and which code remains native I/O;
- focused, changed-file, typecheck, Knip, full-suite, scan, and compiled-CLI results;
- before/after lab evidence directories, session operation used, comparison result, vaporize result, and lab stop/process-ownership result;
- whether tests changed and the real contract that required it;

Stop and do not commit if any of the following is true:

- the starting worktree is not clean;
- the target live symbols or contracts no longer match this plan;
- any before/after lab record differs beyond listed run-specific values;
- the real local session cannot be vaporized or lab cleanup remains pending;
- any focused or full verification fails;
- either target file still has a complexity diagnostic or a new diagnostic appears;
- the change requires a third production source file, protocol version change, public shape change, new state owner, credential movement, adjacent system redesign, or speculative failure handling.

After one verified commit and concise handoff, stop. Do not begin Q5, deploy, push, or continue opportunistic cleanup in the same session.
