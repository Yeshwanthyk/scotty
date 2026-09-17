# OpenClaw research source provenance

## Scope

Research OpenClaw's cloud/remote agent architecture and compare it with Scotty without changing production code or weakening Scotty's authority and credential boundaries.

## Source acquisition

- `opensrc --help`: executable unavailable globally.
- `npx --yes opensrc --help`: succeeded; inspected `fetch --help` and `path --help`.
- `npx --yes opensrc fetch openclaw/openclaw`: reported fetching `main` to `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`.
- GitHub's commits API reported `main` at [`1482bf19a763acc59470faf3425b3cf559018b2c`](https://github.com/openclaw/openclaw/commit/1482bf19a763acc59470faf3425b3cf559018b2c), commit timestamp `2026-09-16T14:25:53Z`.
- Attempting `opensrc fetch openclaw/openclaw@1482bf19a763acc59470faf3425b3cf559018b2c` warned that the ref could not be found and fell back to the default branch. Its SHA-shaped cache directory is therefore **not proof of a pinned checkout**.
- Downloaded the [exact commit archive](https://api.github.com/repos/openclaw/openclaw/tarball/1482bf19a763acc59470faf3425b3cf559018b2c) directly from GitHub. Research source: `/tmp/openclaw-provenance.8W7wWd/openclaw-openclaw-1482bf1/`.
- Compared relative file paths and SHA-256 file-content hashes across the archive and the opensrc `main` cache: **not equal** (43,646 archive files vs 32,337 cached files, including changed shared paths). This establishes the cache is unsuitable for this latest-source research; the cache discrepancy's cause was not diagnosed.
- Stopped the initial scouts and restarted all three against the exact archive. No findings from the stale snapshot should be used.

The `/tmp` archive is disposable. Reproduce it using the exact commit archive URL above. Source citations should use the immutable GitHub commit, not `main`.

## Comparison baseline

Scotty commit: `709f04e3c8720021fe1073ce8ffd61cfa712ccb2`. Working tree was clean before research.

## Research lanes

All scouts use Pi harness, `openai-codex/gpt-5.6-luna`, high reasoning effort:

- `openclaw-cloud-topology.md`: deployment, ownership, remote execution, sandbox provisioning, persistence.
- `openclaw-agent-lifecycle.md`: runtime, subagents, jobs, transport, recovery, cancellation, concurrency.
- `openclaw-security-operations.md`: authentication, credentials, isolation, approvals, diagnostics, operational evidence.

Research is source-level evidence, not deployed validation. No deployments, credentials, or production implementation changes are authorized by this investigation.
