# Q2 — Worker runtime boundaries

## Orientation

This ticket removes the three current complexity findings in Worker authentication and egress without changing behavior. The seam is deliberately narrow:

- `auth-registry.ts` keeps the Auth Durable Object transaction and persisted authority exactly where they are; only the compound authority-validity predicate becomes a few named pure checks.
- `container-session-egress.ts` keeps routing, source selection, request decoding, Durable Object RPC, and response sanitization in place; only the reserved-origin URL check becomes a named helper.
- `egress.ts` keeps credential lookup, real-token substitution, upstream transport, refresh leasing, rotation persistence, and response construction in place; only OAuth refresh request decoding becomes a small helper.

These are local extractions, not new services or modules. Do not move authority out of Durable Objects, merge the three concerns, redesign adjacent Session code, add routes, or alter an envelope to make the cleanup easier. Stop each extraction as soon as its function is at or below complexity 20.

## Settled scope and contracts

### In scope

- `worker/src/auth-registry.ts`
- `worker/src/container-session-egress.ts`
- `worker/src/egress.ts`
- Existing focused tests in:
  - `worker/test/auth-registry.test.ts`
  - `worker/test/container-session-egress.test.ts`
  - `worker/test/egress.test.ts`

Do not add or edit tests unless a move touches a real contract that the existing suite does not characterize. Do not add speculative negative cases.

### Contracts that must not move or change

- The Auth Durable Object remains the sole owner of browser ownership, client credentials, pairing, transfer, recovery, revocation, and Hatch handoffs. `AUTHORITY_KEY`, transaction atomicity, expiry purging, epoch rules, capacity rules, and digest-only persistence remain unchanged.
- `AuthRegistryFailure.reason` values and messages, `AuthRpcResult`, public HTTP status/error envelopes, client and grant views, and renewal behavior remain byte-for-byte compatible apart from run-specific values.
- Real browser, Pi, Codex, OpenAI, and GitHub credentials remain inside their current authority boundaries. Stored authority contains digests only; containers receive sentinels only; upstream responses never expose rotated real credentials.
- `Sandbox.outboundByHost`, `ALLOWED_HOSTS`, exact host-to-handler routing, default deny, manual redirect behavior, request-body streaming, and native `Response` identity/body behavior remain unchanged.
- `scotty.internal` accepts only the exact reserved HTTPS origin with no port, user info, query, or fragment. It rejects ambient credential/source/proxy headers and derives the source only from `OutboundHandlerContext.containerId` and the SDK `className` where required.
- The source Sandbox Durable Object still decides whether same-repository inspect/steer is authorized. The extraction must not select a target directly, wake a target, add caller-supplied identity, or persist coordination state.
- Request and response bounds, decoded request shapes, `cache-control: no-store`, HTTP statuses, Scotty error envelopes, Hatch/Evidence sanitization, and passive inspect/steer response shapes remain unchanged.
- OAuth refresh still acquires one vault lease, substitutes the real refresh token only for `https://auth.openai.com/oauth/token`, cancels on the existing unsuccessful paths, retries persistence exactly twice after the first attempt, persists rotation before returning the sanitized sentinel response, and preserves upstream non-2xx status handling.
- Do not replace native Cloudflare `Request`, `Response`, stream, Durable Object RPC, or outbound callback boundaries with Effect wrappers. Do not introduce another Effect runtime or storage owner.

## Starting proof

### Clean starting commit and recount

A fresh implementation session must begin from a committed ticket and a clean worktree. During drafting, `HEAD` was `14baadf5` and `docs/plans/quality-cleanup/` was untracked, so that drafting state is **not** an acceptable implementation start.

Before running proof or editing:

```sh
git status --short --branch
test -z "$(git status --porcelain)"
git rev-parse HEAD
git log -1 --oneline
```

Record the exact starting commit in the handoff. If the worktree is not clean, stop rather than hiding, stashing, or absorbing unrelated work.

Recount current Oxlint diagnostics from the live commit:

```sh
npx oxlint --disable-nested-config --format json . > /tmp/q2-oxlint-before.json
node - <<'NODE'
const report = JSON.parse(require("node:fs").readFileSync("/tmp/q2-oxlint-before.json", "utf8"));
const diagnostics = Array.isArray(report) ? report : report.diagnostics ?? [];
const complexity = diagnostics.filter((item) => String(item.code ?? item.ruleId ?? "").includes("complexity"));
console.log(JSON.stringify({ diagnostics: diagnostics.length, complexity: complexity.length }, null, 2));
NODE
```

At drafting commit `14baadf5`, the count was 64, all `eslint(complexity)`, with exactly these three findings:

- `worker/src/auth-registry.ts:1030` — `validAuthority`, complexity 25.
- `worker/src/container-session-egress.ts:480` — `handleContainerSessionEgress`, complexity 26.
- `worker/src/egress.ts:243` — the generator passed to `Effect.fnUntraced` as `proxyOAuthRefreshProgram`, complexity 24.

Earlier Q tickets may change line numbers or the total. Reconfirm the live symbols and use the live count as the baseline; do not force the drafting count.

### Focused characterization

Run the existing tests before editing:

```sh
npx vitest run \
  worker/test/auth-registry.test.ts \
  worker/test/container-session-egress.test.ts \
  worker/test/egress.test.ts
```

Drafting result: 3 files and 47 tests passed. The executor must establish its own result from the clean starting commit.

These tests already cover the contracts being rearranged: authority validation and recovery, digest-only storage and atomic transitions; exact reserved-host routing and same-repository inspect/steer; ambient-authority rejection and bounded response sanitization; native streaming/redirect behavior; sentinel substitution; OAuth cancellation, retry, redaction, and persist-before-response ordering.

### Exact before/after lab proof

Run this sequence before editing and repeat the same sequence after all three chunks. Capture stdout, stderr, and exit status for every command. Substitute only the `RUN_ID` printed by that run's `start`.

```sh
npm run lab -- start
npm run lab -- exec RUN_ID -- doctor --json
npm run lab -- exec RUN_ID -- owner recover --json
npm run lab -- stop RUN_ID
```

`owner recover --json` is the representative affected operation: it enters `POST /api/auth/recovery-grants`, calls `ScottyAuthRegistry.issueRecoveryGrant`, runs the `AuthRegistry` transaction, parses and validates the stored authority, and writes a digest-only recovery grant. It opens a local recovery browser tab; do not consume, copy, or retain the fragment, and let `lab stop` remove the isolated Durable Object state. Compare JSON keys, HTTP/CLI success, exit statuses, no-store behavior visible in tests, and cleanup. Ignore only run ID, PID, host port, expiry, generated credentials, timestamps, and temporary paths.

This lab operation does not prove container egress. Before editing and again after the three chunks, run the repository's existing real Worker/Sandbox/Pi proof against the deliberate current repository `Yeshwanthyk/scotty`:

```sh
DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" \
  npm run test:e2e:local-live -- --no-open --no-hold --repo Yeshwanthyk/scotty
```

This harness performs owner recovery through the Auth Durable Object, creates a real local Sandbox, starts Pi with sentinels, reaches the credential egress programs with a provider request, reseeds the warm session, and performs another provider request. Do not add `--require-response`; the existing harness already distinguishes credential rejection from an unrelated upstream generation failure. It cleans up its temporary Worker and containers.

The local-live harness does not invoke `scotty.internal` peer control. The exact internal routing path remains proved by the focused test `delegates same-repo inspect and steer through context.containerId without credentials or wake` in `worker/test/container-session-egress.test.ts`. Do not claim broader local or deployed peer proof. The SDK interception certificate still requires the separately authorized deployed canary, which is outside this ticket.

If Docker, `gh`, or local Pi auth prerequisites are unavailable, record the block and stop before implementation; do not relabel unit tests as lab proof. On any unexplained before/after divergence, stop at the first difference.

## Live files and symbols

Recheck these names before editing; line numbers may move.

- `worker/src/auth-registry.ts`
  - `AuthAuthoritySchema`, `AuthAuthority`, `makeAuthRegistry`
  - `parseAuthority`, `transact`, `purgeExpired`
  - `validAuthority`
  - `validOwnerTransferRecord`, `validRecoveryGrantRecord`, `validHatchHandoffRecord`
  - `ownerClientId`, `uniqueIds`, `activeClients`
- `worker/src/container-session-egress.ts`
  - `SCOTTY_INTERNAL_HOST`, `CONTAINER_SESSION_ROUTE`
  - `rejectsAmbientAuthority`, `rejectedRequest`
  - `handleContainerSessionEgress`
  - `handleEvidenceJobEgress`, `handleHatchEgress`, `handleHatchRestoreEgress`
  - `sanitizeResponse`
  - `ContainerProxy.fetch`
- `worker/src/egress.ts`
  - `proxyOAuthRefreshProgram`
  - `EgressVault.begin`, `EgressVault.persist`, `EgressVault.cancel`
  - `parseOAuthRefreshRequest`, `parseOAuthUpstreamSuccess`
  - `mediaType`, `formBody`, `sanitizedHeaders`
  - `makeOutboundByHost`, `runEgress`, `egressTransportLayer`
- Boundary callers that are orientation only, not editing targets:
  - `worker/src/auth-object.ts`: `ScottyAuthRegistry.issueRecoveryGrant`, `#run`
  - `worker/src/auth.ts`: `authenticateRequest`, `authRegistry`, `unwrapAuthRpc`
  - `worker/src/session.ts`: `Sandbox.containerSessionRequest`, `Sandbox.outboundByHost`
  - `worker/src/index.ts`: `/api/auth/recovery-grants`, `/api/sessions/:id/inspect`, `/api/sessions/:id/steer`

## Target flow

```text
browser/root auth request
  -> Auth Durable Object RPC
  -> one AuthRegistry storage transaction
  -> decode + purge + named validity checks
  -> digest-only authority write
  -> unchanged AuthRpcResult and HTTP envelope

container outbound request
  -> exact host callback map
  -> named exact-origin check + ambient-authority rejection
  -> unchanged special-route or inspect/steer dispatch
  -> source Sandbox selected only from container context
  -> source Sandbox Durable Object applies session authority
  -> bounded sanitized Response

Pi provider/OAuth request
  -> exact host callback
  -> small request decoder
  -> vault lease and real-token substitution
  -> exact upstream host with manual redirect
  -> cancel or persist rotation under existing rules
  -> sentinel-only response after persistence
```

## Implementation chunks

### Chunk 1 — Name the Auth authority subchecks

**Behavior delivered:** `validAuthority` expresses the same V2 authority invariants through a few named pure predicates instead of one compound expression.

**Files and symbols:** edit only `worker/src/auth-registry.ts`, centered on `validAuthority`. Extract only cohesive checks already present in the expression—for example the Hatch handoff/client relationship, owner-transfer relationship, and recovery-grant epoch relationship. Keep primitive record validators and all callers in place.

**Boundary/state touched:** read-only validation of the Auth Durable Object's decoded authority. No storage key, schema, transaction, purge, mutation, error, or timestamp change.

**Dependency:** none.

**Completion check:** run `worker/test/auth-registry.test.ts` and changed-file Oxlint. `validAuthority` must be at or below 20 and no helper may exceed 20. Compare the boolean conditions directly before moving on. Do not create a validator framework or split the file.

**Risk:** accidentally weakening a conjunction or changing `undefined` handling. Preserve each operand exactly and in equivalent grouping.

### Chunk 2 — Name the exact reserved-origin check

**Behavior delivered:** `handleContainerSessionEgress` delegates only its existing URL-envelope predicate to one pure helper; routing and relay behavior stay in the exported handler.

**Files and symbols:** edit only `worker/src/container-session-egress.ts`. Extract the current conjunction over protocol, hostname, port, username, password, search, and hash from `handleContainerSessionEgress`. Leave ambient-header rejection, special-route ordering, `CONTAINER_SESSION_ROUTE`, request parsing, context validation, source lookup, RPC invocation, and `sanitizeResponse` where they are.

**Boundary/state touched:** native Cloudflare outbound request admission only; no authority or state transition.

**Dependency:** none; do it after Chunk 1 only to keep review and proof linear.

**Completion check:** run `worker/test/container-session-egress.test.ts` and changed-file Oxlint. `handleContainerSessionEgress` must be at or below 20. Do not extract dispatch or invent a router unless this single helper unexpectedly fails the live diagnostic gate; if it fails, stop and discuss rather than broadening the design.

**Risk:** accepting a near-match origin. The helper must retain every existing exact-origin condition.

### Chunk 3 — Isolate OAuth refresh request decoding

**Behavior delivered:** `proxyOAuthRefreshProgram` receives one already-decoded refresh intent containing the current `formEncoded` choice and `OAuthRefreshRequest`, then performs the unchanged lease/upstream/persist/response sequence.

**Files and symbols:** edit only `worker/src/egress.ts`. Extract the existing method/path check, bounded `request.text()` Effect, media-type choice, form-or-JSON conversion, and `parseOAuthRefreshRequest` call into one small local Effect-returning helper. Return an absent/forbidden outcome using an ordinary small value or `Option`; do not add a service, Layer, runtime, or new error hierarchy. Keep `EgressVault`, upstream `HttpClient`, cancellation, persistence retries, response schemas, native transport, and `runEgress` unchanged.

**Boundary/state touched:** untrusted OAuth refresh request decoding before the credential vault lease. No credential is added to logs, arguments, files, or responses.

**Dependency:** none; sequence after Chunk 2.

**Completion check:** run `worker/test/egress.test.ts` and changed-file Oxlint. `proxyOAuthRefreshProgram` and the new helper must each be at or below 20. Confirm the tests still prove form and JSON input, exact upstream URL, real-token substitution, cancellation, three total persistence attempts, redaction, and persist-before-response ordering. Stop once the diagnostic clears; do not restructure the rest of egress.

**Risk:** reading the body twice, changing unsupported-content behavior, or acquiring a lease before validation. The extracted helper must preserve one body read and validation-before-lease ordering.

## Verification matrix

Run formatting before lint so diagnostics refer to final positions.

| Proof | Command | Required result |
|---|---|---|
| Format touched files | `npx oxfmt --disable-nested-config --write worker/src/auth-registry.ts worker/src/container-session-egress.ts worker/src/egress.ts` | Only intended formatting changes |
| Lint-skill policy | `npm run lint:skills` | Pass |
| Focused contracts | `npx vitest run worker/test/auth-registry.test.ts worker/test/container-session-egress.test.ts worker/test/egress.test.ts` | All pass; drafting baseline was 47 tests |
| Worker types | `npm run typecheck:worker` | Pass |
| Dead-code/export check | `npm run knip:check` | Pass |
| Changed-file Oxlint | `npx oxlint --disable-nested-config worker/src/auth-registry.ts worker/src/container-session-egress.ts worker/src/egress.ts` | Zero diagnostics in all three files |
| Real local boundary | repeat the exact lab and local-live commands under **Starting proof** | Same shapes, statuses, isolation, and cleanup as before |
| Full repository gate | `npm run check` | Pass; includes format check, full lint, Knip, all typechecks, full test suites, and secret scan |
| Final recount | repeat the JSON Oxlint recount as `/tmp/q2-oxlint-after.json` | Three scoped findings removed; no new diagnostics |

Do not run a deployment, deployed canary, push, tag, or release. This ticket does not authorize them.

## Expected diagnostic reduction

Expected scoped result: three findings become zero:

- `validAuthority`: 25 -> at most 20.
- `handleContainerSessionEgress`: 26 -> at most 20.
- `proxyOAuthRefreshProgram`: 24 -> at most 20.

Expected repository result is `N -> N - 3`, where `N` is the clean implementation session's live complexity recount. If starting from the drafting baseline without intervening tickets, that is `64 -> 61`. Any new diagnostic, or fewer than three removed without an explained prior change, blocks completion.

Rough line count is not a target. A small increase from named helpers is acceptable; moving code into new files merely to lower a score is not.

## Rollout, commit, and handoff

There is no migration or production rollout. Persisted data, routes, bindings, resource definitions, and deployment configuration do not change.

After all proof passes:

```sh
git diff --check
git status --short
git diff -- worker/src/auth-registry.ts worker/src/container-session-egress.ts worker/src/egress.ts
git add worker/src/auth-registry.ts worker/src/container-session-egress.ts worker/src/egress.ts
git diff --cached --check
git commit -m "refactor: simplify Worker runtime boundaries"
git status --short --branch
```

Include test edits in the commit only if a real touched contract required characterization and explain why in the handoff. Do not include unrelated plan or worktree files.

The handoff must state:

- starting and ending commit IDs;
- before/after total complexity count and the three scoped results;
- the exact focused, lab, local-live, and full-gate commands and outcomes;
- confirmation that public routes/envelopes, Auth and Session Durable Object authority, streaming/manual redirects, routing, and credential isolation did not change;
- any run-specific lab differences judged expected;
- that no deployment or push occurred.

Then stop. Do not start Q6, clean adjacent findings, or redesign Worker runtime ownership in the same session.

## Risks and stop criteria

Stop immediately and discuss if any of the following occurs:

- the implementation session is not clean;
- any helper extraction requires changing a schema, persisted authority shape, route, error message/status, host map, sentinel, vault contract, Session method, or public test expectation;
- a real credential appears in container state, a request to a non-exact upstream, logs, test output, or a response;
- request bodies are buffered outside the existing OAuth body read or native streaming transport changes;
- the single URL helper does not clear the container-session diagnostic and a larger routing redesign appears necessary;
- the OAuth request helper does not clear the diagnostic and a new service/abstraction appears necessary;
- before/after lab or local-live output diverges unexpectedly;
- any focused or full check fails;
- the final reduction is not exactly the three live scoped findings with no new diagnostics.

Do not update expected tests to accept a divergence. Diagnose the first difference or return for discussion.

## Open decisions

No architecture or behavior decision remains open. The only operator input is the deliberate local-live test repository; this packet pins it to the current origin, `Yeshwanthyk/scotty`. If that repository is unsuitable in the fresh session, select another existing disposable `OWNER/NAME` before starting proof and use the exact same value before and after. That choice does not authorize a code or contract change.
