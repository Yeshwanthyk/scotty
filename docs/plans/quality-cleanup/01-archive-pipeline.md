# Q1 — Sandbox bundle archive pipeline

## Orientation

This ticket removes the five current complexity findings in the sandbox bundle archive path without
changing the archive format, accepted sources, validation policy, or public failures.

The cohesive path is:

```text
local source
  -> walkSandboxTree / walkSandboxItem
  -> buildSandboxBundle / buildScottyTomlBundle
  -> createDeterministicTarGz
  -> PUT /api/sandbox/bundles/:digest
  -> worker validateSandboxArchive
  -> immutable bundle storage
```

Keep the runtime edges separate. The CLI uses Node filesystem and zlib APIs and reports `CliError`;
the Worker uses `DecompressionStream`, bounded reads, and `SandboxArchiveInvalid`. Extract small
local helpers around TAR-member decoding, v2 manifest expectation building, and tree-entry handling.
Do not create a cross-runtime archive framework or change which layer owns a limit.

`cli/src/archive.ts` is explicitly out of scope. It validates beam-down/rollout archives and is not
part of the sandbox bundle pipeline.

## Settled scope and starting proof

### Scope

Production files:

- `cli/src/sandbox-archive.ts`
- `cli/src/sandbox-walk.ts`
- `worker/src/sandbox/archive.ts`

Focused tests:

- `cli/effect-test/sandbox-bundle.test.ts`
- `cli/effect-test/scotty-bundle.test.ts`
- `cli/effect-test/sandbox-sync.test.ts`
- `worker/test/sandbox/sandbox-archive.test.ts`
- the existing sandbox-bundle upload case in `worker/test/integration/routes.test.ts`
- the existing `sandbox add` and `sandbox sync` cases in `cli/test/cli.test.ts`

Direct callers are evidence, not refactor scope: `cli/src/sandbox-prepare.ts`,
`cli/src/scotty-bundle.ts`, `cli/src/sandbox-sync.ts`, `worker/src/index.ts`, and
`worker/src/sandbox/bundle-materializer.ts`.

Do not redesign manifests, storage, synchronization, materialization, session creation, or CLI
commands. Add or adjust a characterization only when a helper move touches an already-live contract.
Do not add speculative malformed-input cases.

### Clean starting commit and recount

The planning snapshot is `14baadf5768792c28992b79d038055037cb960bf` on `main`. At that
snapshot, `npm run lint` reports 64 complexity findings. The scoped findings are:

| File and live function                                 | Complexity |
| ------------------------------------------------------ | ---------: |
| `cli/src/sandbox-walk.ts` — `walkSandboxTree`          |         23 |
| `cli/src/sandbox-archive.ts` — `parseSandboxTar`       |         28 |
| `cli/src/sandbox-archive.ts` — `expectedV2Files`       |         30 |
| `worker/src/sandbox/archive.ts` — `parseSandboxTar`    |         30 |
| `worker/src/sandbox/archive.ts` — `validateV2Manifest` |         30 |

A fresh implementation session must not assume that snapshot is still HEAD. Before editing:

```sh
git status --short
git branch --show-current
git rev-parse HEAD
npm run lint 2>&1 | tee /tmp/scotty-q1-before-lint.txt
```

Start only after this reviewed plan and its DAG are committed, from the intended `main` commit with a
clean worktree. Do not discard plan files or other work to make it clean. Recount both the repository
total and findings in the three scoped production
files. If the baseline moved, record the new commit and counts in the handoff; preserve the same
five-symbol scope rather than pulling in adjacent findings. Run the focused tests below before the
lab flow.

### Exact deterministic archive fixture

Before editing, save one fixed builder result outside the worktree:

```sh
bun -e 'import { writeFileSync } from "node:fs"; import { createDeterministicTarGz } from "./cli/src/sandbox-archive.ts"; const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, skills: [], piPackages: [] }) + "\n"); const built = createDeterministicTarGz([{ path: "manifest.json", type: "file", modeClass: "regular", bytes }]); writeFileSync("/tmp/scotty-q1-before.tar", built.tar); writeFileSync("/tmp/scotty-q1-before.tar.gz", built.archive); console.log(built.digest)'
shasum -a 256 /tmp/scotty-q1-before.tar /tmp/scotty-q1-before.tar.gz
```

After editing, generate the same fixture again and require exact equality:

```sh
bun -e 'import { writeFileSync } from "node:fs"; import { createDeterministicTarGz } from "./cli/src/sandbox-archive.ts"; const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, skills: [], piPackages: [] }) + "\n"); const built = createDeterministicTarGz([{ path: "manifest.json", type: "file", modeClass: "regular", bytes }]); writeFileSync("/tmp/scotty-q1-after.tar", built.tar); writeFileSync("/tmp/scotty-q1-after.tar.gz", built.archive); console.log(built.digest)'
cmp /tmp/scotty-q1-before.tar /tmp/scotty-q1-after.tar
cmp /tmp/scotty-q1-before.tar.gz /tmp/scotty-q1-after.tar.gz
shasum -a 256 /tmp/scotty-q1-after.tar /tmp/scotty-q1-after.tar.gz
```

Keep the printed TAR digest with the before/after evidence. A `cmp` difference is a stop condition.

### Exact before/after lab flow

Create one minimal accepted Skill outside the repository and reuse the same bytes and absolute path
for the before and after runs:

```sh
SOURCE_DIR="$(mktemp -d)"
mkdir "$SOURCE_DIR/release-notes"
cat > "$SOURCE_DIR/release-notes/SKILL.md" <<'EOF'
---
name: release-notes
description: Draft release notes.
---

# Release notes
EOF
```

Before editing, run this exact sequence. Replace `RUN_ID` with the value printed by `start` and
capture stdout, stderr, and exit status for every command:

```sh
npm run lab -- start
npm run lab -- exec RUN_ID -- doctor --json
npm run lab -- exec RUN_ID -- sandbox add "$SOURCE_DIR/release-notes" --json
npm run lab -- exec RUN_ID -- sandbox sync --json
npm run lab -- stop RUN_ID
```

Run the same five commands in a new lab after the implementation, using that run's new `RUN_ID`.
The lab supplies `SCOTTY_HOST`, `SCOTTY_TOKEN`, and an isolated CLI home. Compare:

- `sandbox add`: one `release-notes` Skill and `remote.status: "not_queried"`;
- `sandbox sync`: exit 0, `fileCount: 1`, the same 64-lowercase-hex digest before and after, and
  `remote.status: "synchronized"` with the same active digest;
- no credential in stdout or stderr;
- `stop`: `status: "stopped"` with no cleanup errors.

Run IDs, PIDs, lab-owned temporary paths, and timestamps may differ. Always stop the run, including
after an intermediate failure. If any other observation diverges, stop at the first difference; do
not update expectations or continue the cleanup.

## Contracts to preserve

### Deterministic bytes and digest

- `encodeUstarArchive` sorts members by UTF-8 path order and emits the same USTAR header fields,
  canonical modes (`0755` directories/executables, `0644` regular files), zero uid/gid/mtime,
  payload padding, and two terminal zero blocks.
- `splitTarName` keeps the current USTAR name/prefix behavior. Do not add a new long-path encoding.
- `gzipDeterministic` remains level 9, clears gzip timestamp bytes, and sets the OS byte to 255.
- `createDeterministicTarGz` continues to return the TAR bytes, gzip bytes, and lowercase SHA-256 of
  the **uncompressed TAR**. The digest is not a hash of the gzip representation.
- Identical accepted source bytes and mode classes must produce byte-for-byte identical TAR and gzip
  output and the same digest.

### Limits and accepted inputs

Keep each existing owner and value:

- archive member payload: at most 8,388,608 bytes;
- archive path: non-empty, at most 240 current string units, relative `/` form, with no NUL,
  backslash, empty component, `.` component, or `..` component;
- Worker gzip request/store bound: 48 MiB in the existing route/store callers;
- Worker decompressed TAR bound: 96 MiB;
- Worker archive file count: at most 8,192 payload files plus `manifest.json`;
- legacy Skill walk: 8 MiB/file, 4 MiB total, 128 files;
- legacy package walk: 8 MiB/file, 64 MiB total, 4,096 files;
- TOML item walk: the existing package-sized limits;
- complete CLI bundle: 8,192 payload files, enforced by the existing builders.

The TAR validators continue to accept regular file type `0` or `48` and directory type `53`, with a
valid checksum, mode in `0..07777`, complete payload bounds, safe unique paths, and no hard links,
symlinks, or other member types. Do not start validating currently ignored USTAR fields.

The walker continues to accept only ordinary files/directories rooted inside the configured source,
reject symlinks and hard links, detect a changed file across `lstat`/open/read, apply the existing
excluded-basename and optional credential-path policies, and preserve current `node_modules` and
executable-script options. Preserve deterministic UTF-8 ordering and the point at which file-count
and byte totals are charged.

Both validators continue to accept strict schema-v1 and schema-v2 manifests. Preserve v1 support.
For v2, keep item identity, kind/shape rules, item and file digests, archive-path projection,
materialized file/directory coherence, and rejection of duplicate items, duplicate projected files,
and unlisted directories. Preserve the current CLI and Worker contract schemas rather than trying
to reconcile adjacent schema differences in this ticket.

### Public errors

Preserve exact current error codes, exit/status mapping, messages, and hints:

- CLI walk/build failures remain `sandbox_source_invalid`, `sandbox_package_unsupported`, or
  `sandbox_bundle_too_large`, with usage exit 2 where currently used.
- CLI archive validation remains `sandbox_archive_invalid`, exit 1, with
  `Rebuild the sandbox bundle, then retry.` for the current validation failures.
- Worker validation remains `SandboxArchiveInvalid { message }`.
- `PUT /api/sandbox/bundles/:digest` continues to expose that message through the existing HTTP 400
  `bad_request` envelope. Add one narrow assertion for an existing malformed archive message to the
  live upload route test if it still lacks that assertion; do not create a new failure matrix.
- `sandbox-bundle-materializer.ts` must continue to classify the unchanged Worker messages as
  `invalid_archive`, `digest_mismatch`, or `too_large`; `sandbox-sync.ts` must continue its existing
  mapping to CLI public errors.

No public route, JSON shape, persisted sandbox configuration, storage key, or activation behavior
changes in this ticket.

## Concrete live symbols

Recheck these names against live code before editing:

- CLI TAR build/validation: `TarMember`, `ParsedTarMember`, `encodeUstarArchive`,
  `gzipDeterministic`, `createDeterministicTarGz`, `parseSandboxTar`, `gunzipSandboxArchive`,
  `expectedFiles`, `expectedV2Files`, `validateSandboxArchive`, `field`, `headerChecksum`,
  `parentDirectories`, and `invalidV2Archive`.
- CLI source walk: `SandboxWalkOptions`, `WalkedSandboxFile`, `readRegularFile`,
  `walkSandboxTree`, `walkSandboxItem`, `skipRelativePath`, `modeClassFor`, `inodeKey`, and
  `staysInsideRoot`.
- Worker validation: `SandboxArchiveInvalid`, `ParsedTarMember`, `parseSandboxTar`,
  `gunzipSandboxArchive`, `readBoundedUncompressed`, `validateV2Manifest`, and
  `validateSandboxArchive`.
- Production entry points proving the seam: `buildSandboxBundle`, `buildScottyTomlBundle`,
  `synchronizeLocalSandbox`, the `PUT /api/sandbox/bundles/:digest` route, and
  `materializeDigest`.

New helper names are local implementation details. Prefer phase names that state one existing job,
such as decoding one TAR header/member, collecting one v2 item expectation, or visiting one walked
path. Do not export a helper unless an existing focused test needs the public symbol.

## Implementation chunks

### Chunk 1 — Make source walking a small dispatcher

**Behavior:** Preserve the current depth-first queue, ordering, exclusions, inode checks, source
stability checks, mode classification, and limit accounting while reducing `walkSandboxTree` below
the complexity gate.

**Files and symbols:** `cli/src/sandbox-walk.ts`; start at `walkSandboxTree` and reuse
`readRegularFile`, `skipRelativePath`, `inodeKey`, and `staysInsideRoot`.

**Mechanism:** Move one-path classification and/or directory expansion into local Effect helpers.
Keep the queue and aggregate `files`/`totalBytes` state visibly owned by `walkSandboxTree`; do not
introduce a generic filesystem abstraction or change traversal order.

**Dependency and completion check:** No dependency on later chunks. Run the source-walk and bundle
preparation tests, CLI typecheck, and changed-file Oxlint. Complete when behavior is unchanged and
`walkSandboxTree` is at complexity 20 or below.

### Chunk 2 — Separate CLI TAR decoding from manifest expectation checks

**Behavior:** Preserve deterministic archive bytes and the complete CLI v1/v2 validation result and
`CliError` surface.

**Files and symbols:** `cli/src/sandbox-archive.ts` and existing assertions in
`cli/effect-test/sandbox-bundle.test.ts` / `cli/effect-test/scotty-bundle.test.ts`; start at
`parseSandboxTar`, `expectedV2Files`, and `validateSandboxArchive`.

**Mechanism:** Extract local operations for decoding/validating one TAR member and for applying one
v2 item's expectations/member-shape checks. Keep `parseSandboxTar` as the offset/seen/member
orchestrator and `expectedV2Files` as the expected-file/directory orchestrator. Do not alter
`encodeUstarArchive`, `gzipDeterministic`, or error text.

**Dependency and completion check:** May build on Chunk 1 tests but not its implementation details.
Run deterministic round-trip, v1/v2 validation, malformed archive, and prepared bundle tests. Compare
TAR bytes, gzip bytes, and digest for the same fixture before and after. Complete when both scoped CLI
archive findings are gone and no replacement finding appears.

### Chunk 3 — Mirror the validation phases at the Worker boundary

**Behavior:** Preserve upload-time and materialization-time validation, Worker-only limits, returned
`manifestJson`/`members`, and public error classification.

**Files and symbols:** `worker/src/sandbox/archive.ts`, `worker/test/sandbox/sandbox-archive.test.ts`, and the
focused upload case in `worker/test/integration/routes.test.ts`;
start at `parseSandboxTar`, `validateV2Manifest`, and `validateSandboxArchive`. Use
`worker/src/index.ts` and `worker/src/sandbox/bundle-materializer.ts` only to verify unchanged callers
and mappings.

**Mechanism:** Apply the same phase boundaries as Chunk 2 with Worker-local helpers and
`SandboxArchiveInvalid`. Do not share Node zlib, Effect execution, hashing, limit ownership, or error
construction across runtimes.

**Dependency and completion check:** Depends on the CLI phase names/shape being understood, not on a
shared module. Run Worker archive tests, Worker typecheck, synchronization tests, and changed-file
Oxlint. Complete when both scoped Worker findings are gone and the full add/sync lab flow matches its
baseline.

## Verification matrix

### Focused baseline and after checks

Run before editing and after all chunks:

```sh
npx vitest run \
  cli/effect-test/sandbox-bundle.test.ts \
  cli/effect-test/scotty-bundle.test.ts \
  cli/effect-test/sandbox-sync.test.ts \
  worker/test/sandbox/sandbox-archive.test.ts
npx vitest run worker/test/integration/routes.test.ts --testNamePattern 'reads and uploads sandbox bundles'
(cd cli && bun test test/cli.test.ts --test-name-pattern 'sandbox add,|sandbox add persists|sandbox add rejects|sandbox add allows|sandbox sync uploads')
npm run typecheck:cli
npm run typecheck:worker
```

After editing, format before lint and then require zero findings in the scoped production files:

```sh
npm run fmt
npm run lint:skills
npx oxlint --disable-nested-config --deny-warnings \
  cli/src/sandbox-archive.ts \
  cli/src/sandbox-walk.ts \
  worker/src/sandbox/archive.ts
```

Then run the exact second lab flow from the starting-proof section.

### Full verification and recount

After the focused checks and second lab pass:

```sh
npm run knip:check
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
npm run lint 2>&1 | tee /tmp/scotty-q1-after-lint.txt
```

`npm run lint` is expected to remain nonzero because unrelated baseline complexity findings remain.
Acceptance is: no non-complexity regression, no finding in the three scoped production files, no new
finding elsewhere, and the repository count reduced only by the scoped findings. Do not clean up an
adjacent diagnostic to make the count prettier.

## Expected diagnostic reduction

If the baseline remains 64, this ticket removes exactly five findings and leaves 59. All five scoped
functions must be at complexity 20 or below. The existing `cli/src/archive.ts` finding remains and is
not a failure of this ticket because it belongs to beam-down/rollout behavior.

If an earlier ticket changed the total, expected after-count is `fresh recount - scoped findings at
start`, with zero scoped findings added. Record both numbers and the exact remaining scoped output in
the handoff.

## Commit, handoff, and stop

After every focused/full check and the second lab flow meet the criteria:

1. Review `git diff` and confirm only the three scoped production files and their focused tests
   changed. Do not include `cli/src/archive.ts` or unrelated formatting.
2. Create one coherent commit, for example `refactor: simplify sandbox archive pipeline`.
3. Confirm `git status --short` is empty.
4. Hand off the starting and ending commit, before/after complexity counts, the five removed
   diagnostics, focused/full command results, and the before/after lab digest and JSON/exit comparison.
5. State explicitly that no deployment, push, tag, or canary was run or authorized.
6. Stop the session. Do not begin Q2 or opportunistic cleanup.

Stop without committing if the worktree was not clean at the start, deterministic TAR or gzip bytes
change, the digest changes for unchanged input, an accepted input or public error changes, a focused
or full check introduces a regression, the lab diverges, cleanup remains pending, or any scoped
function still exceeds complexity 20. Preserve the first failing evidence for discussion rather than
broadening the ticket.

## Open decisions

None. The implementation should use small runtime-local helpers, preserve the current duplicated
CLI/Worker policy boundaries, and leave any future shared parser or manifest-schema unification to a
separately shaped change.
