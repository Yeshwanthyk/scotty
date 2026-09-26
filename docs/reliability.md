# Reliability board

Working tracker for making Scotty reliable piece by piece. One card per focused session and PR.

- Evidence is cited as of `c9bb5da` (v0.3.31).
- Full scout reports are local only, in `work/reliability/clean/s-*.out.md` (gitignored).

## How to work

Cards live in `docs/board.json`. Manage them with the board CLI and look at them in the HTML view. This file holds only the rules, the recurring mistakes and the piece map that every card session reads.

```sh
npm run -s board -- html --open   # kanban view: filters, card detail, copy-able start prompt
npm run -s board -- next          # Next cards whose deps are done
npm run -s board -- prompt R-02   # the prompt that starts a session on a card
```

1. **Start a session:** paste `board prompt <id>` (or the prompt copied from the HTML view) into a new session. The session runs `board show` and `board start`.
2. **Work:** re-verify the cited `path:line`s first, since line numbers drift. Cards marked ⚠ change a public contract, persisted state or core lifecycle, so the design is approved before any code is written.
3. **Handoff:** before a session stops, even mid-way, it runs `board log <id> "done …; next …; open …; branch/PR"`. The next session's prompt includes the last notes.
4. **Finish:** each card ends with its **Proof**, an e2e or deployed test, plus deletion of whatever the fix made obsolete. After merge, run `board done <id> --pr N` and update the tags in the piece map.
5. **New findings** go in as new cards with `board add <id> "<title>"`. Don't patch them inside an unrelated card.

Other commands: `ls [column|prefix]`, `show`, `move <id> <column> [--at N]`, `add … [--col C] [--dep ID] [--contract]`. The data file can be overridden with `BOARD_FILE`.

## Rules

- **Root fixes only.** A patch that adds a fence, a timeout, a retry or a special case needs a card that removes the cause. Otherwise it is a bandaid, and bandaids must be labeled `bandaid:` in the commit.
- **No backward compatibility.** This is a new product: delete compat decoders, legacy fields and alias paths. A persisted-shape change ships with an explicit reset note, not a migration.
- **E2E proves behavior.** Keep unit tests only for:
  - pure branchy logic, such as the reducer, CAS and drain math;
  - security or parsing boundaries;
  - deterministic interleavings that e2e cannot force.

  Everything else becomes session-harness, deployed or browser e2e.

- **Every test must catch a regression.** A test stays only if a plausible bug that breaks state, security or a public contract would fail it, and no other test that runs in CI fails on the same bug. Every card applies this to the tests it touches, both the ones it adds and the ones it edits.
  - **Delete:**
    - tests that check how source code is spelled (regex or grep over source);
    - tests that exercise fixtures or mocks rather than code;
    - assertions that repeat a path another test already covers;
    - guards for host inputs the platform cannot produce;
    - checks of constants and config.
  - **Before deleting,** cite the covering CI test as `file:line` and the assertion it makes. Local-only or env-gated tests (Quint replay, the deployed canary) do not count as coverage.
  - **Fixtures:** one builder per domain under `worker/test/support/`. Don't add a new fixture unless a kept test needs it.
  - **New tests:** name the regression in the title ("rejects an early deadline alarm"), not the mechanism.

- **Fix types at the root; never launder them.** Lint enforces `typescript/consistent-type-assertions` (never) and `typescript/no-non-null-assertion` across the repo.
  - Fix the cause, even if that means a narrow change to a production signature: make the parameter the shape the code actually reads, decode with Schema, or use a real type guard. Before blaming a host type, check the tsconfig libs (the CLI once hid Bun's `WebSocket` options overload by including `DOM`).
  - **Forbidden:**
    - moving a cast into a helper;
    - `unknown → T` functions;
    - suppressions that give "native host boundary" as the reason for a cast in test fakes;
    - silent fallbacks that change behavior (`?? ""`, `: new WebSocket(url)` without its options).
  - A suppression is allowed only on a native host callback signature that Scotty cannot own. It must be adjacent and rule-specific, and give the host contract as its reason.

- **Delegated work is not done until the orchestrator verifies it.** Whoever dispatches an implementer owns the result.
  - The prompt must allow root fixes, and must say that a new suppression, cast helper or fallback counts as a failure the implementer reports instead of working around.
  - Before accepting the result:
    - grep the diff for new `oxlint-disable`, `as`, `(value: unknown):` helpers and `??` or `instanceof` fallbacks;
    - read every production hunk for behavior changes;
    - run the full `npm run test:all` outside the implementer's sandbox.
  - Redo anything below the bar with a stronger model or higher effort. Never forward an implementer's self-report as verification.

- **Effect v4 rc.112 source first** (`vendor/effect`, `.agents/skills/*`):
  - Use `Context.Service` classes and `Effect.fnUntraced`.
  - Use `Clock` and an ID service, not `Date.now` or `crypto.randomUUID`.
  - Use `Result` or typed errors, not throwing parsers.
  - Decode every boundary with Schema.
  - `runPromise` is allowed only in a host island. There must be one per host, not one per route.
- **Authority is singular.** Each fact has exactly one durable owner; everything else is a projection derived from committed authority. UI and CLI never reconcile competing sources.
- **Time is a budget, not knobs.** Deadlines derive from one persisted policy; don't add independent constants.
- **Quint before fences** (a local design tool; `npm run spec`, never in CI). A change to lifecycle, lease, alarm or idempotency behavior updates the relevant Quint model first, and the model must fail on the old behavior.

## Recurring mistake classes (229 fix commits since 2026-06)

| Class                          | Count | Examples                        | Why it recurs                                                                         | Prevention                                                                                                         |
| ------------------------------ | ----- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Lifecycle fencing / recovery   | 79    | adc5e63 43f0545 fade743         | Callbacks, alarms, HTTP retries and provider replies overlap; each gets its own fence | Durable intent → one provider action → observed commit; the actor derives wakes and projections (R-05, R-06, M-01) |
| Provider / host contract drift | 36    | 709f04e 597096a 6a5f0e9         | Mocks erase native races; SDK types leak into the actor                               | `SandboxProvider` with `success\|rejected\|unknown`; contract tests hit real adapters (R-07)                       |
| Deploy / artifact skew         | 30    | f1b6dd3 1bc84c9 a09f256         | New provider states get patched in; two watchers; timeout reported as failure         | One deploy-run state machine with receipts (R-08)                                                                  |
| Evidence lifecycle             | 29    | d12116b 2e45667 c017f4a         | Recorder, R2 and UI settle independently                                              | Actor-reconciled outbox (R-11)                                                                                     |
| Credential authority           | 21    | 893ed14 f30b21c 94c42e3         | Compat migrations reintroduce old ownership, then get reverted                        | The grant is the sole capability record; clean cutover (R-09)                                                      |
| UI / projection convergence    | 17    | db4bac4 803364e 47b5cc0         | KV is best-effort, but the UI and list treat it as truth                              | Authoritative list; server-owned operation state (R-02, R-15)                                                      |
| CLI                            | 13    | cc5bf74 2215715 3a3fa39         | Error-regex recovery, scattered local journals                                        | Server-owned idempotency; one installation-state owner (R-01, R-13)                                                |
| Reverts                        | 4     | 6a5f0e9 c017f4a 94c42e3 6f4210a | Contract changes tried through compat branches                                        | No compat branches (C-01)                                                                                          |
| Timing knobs                   | —     | 3be0300 e81ada3 9c7ecfc         | Drain, backup margin and sweep timeouts are tuned independently                       | One budget policy (R-05, M-02)                                                                                     |

## Ops (not cards)

- Re-run busy Codex with a 5-minute cap on v0.3.31. Use a new title so it gets a new session ID. Expect `Sleeping` with a confirmed backup.
- Claude live e2e per `work/handoff-claude.md`.
- Vaporize `c31ef4f2a9e6` (Failed) and `3d89357c1221` (Pi probe) **only with approval**. Keep `c31ef4f2a9e6` until R-03 has used it as a repro.

## Piece map

Pipeline: **CLI** (registered, runs anywhere) → **Worker** (API/UI, Auth DO) → **Credentials** (Registry DO, egress) → **Session** (Sandbox DO: actor, host, backup, hard cap) → **SandboxConfig DO** → **Provider/agents** (Cloudflare now; VPS/Modal/Daytona runners later) → **Deploy**. Hatch/Evidence and the UI sit on top.

Invariant tags: **C** = enforced by construction, **K** = runtime check, **T** = test-only, **U** = unenforced.

| Piece             | Solid (C/K)                                                                            | Weak (T/U)                                                                                            | Cards          |
| ----------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------- |
| CLI               | plan fingerprint recheck on apply                                                      | idempotency key poisoned on definitive failure (U); journals scattered; shallow doctor                | R-01 R-13      |
| Worker / API      | Auth DO transactional; credential digests only                                         | list trusts KV (U); error mapping duplicated 3×                                                       | R-02 C-02 R-15 |
| Credentials       | sentinels only in container; crypto contract tests                                     | session-side grant reconstruction duplicated; plaintext `string` crosses RPC                          | R-09           |
| Session actor     | one transition at a time (C); rev/nonce/phase CAS (K); Sleeping ⇒ confirmed backup (K) | Failed with no exit but Vaporize (U); unknown outcomes only test-checked (T)                          | R-03 R-07 M-01 |
| Host / alarms     | hard-cap fence and early re-arm (K)                                                    | re-arm gives up after 60 s and logs (U); projection skipped on Gone (U); host duplicates actor policy | R-05 R-06      |
| Backup / hard cap | owned attempt IDs, restore-verify marker (K)                                           | 3-minute reserve is a heuristic (U); SDK promise not cancellable                                      | R-05 R-07      |
| SandboxConfig     | revisioned settings, signed pins, create-only R2 (K)                                   | GitHub API discovery with fallback bandaids; repo repair best-effort                                  | R-12 R-14      |
| Provider / agents | sidecar one-turn admission (C); gen/thread/turn fences (K)                             | no provider-neutral contract (U); checkpoint interrupts the turn; Claude untested live                | R-04 R-07      |
| Deploy            | image digest and tag identity (K)                                                      | release plan not bound to the apply (U); optional compat evidence (U)                                 | R-08           |
| Hatch / Evidence  | generation/epoch fences, permit checks (K)                                             | R2 deletion eventual only (U); 20+ `as Effect` casts                                                  | R-10 R-11      |
| UI                | request serials, abort, generation fences (K)                                          | uncorrected list rows trusted (U); hand-written decoders                                              | R-02 R-15 D-*  |
