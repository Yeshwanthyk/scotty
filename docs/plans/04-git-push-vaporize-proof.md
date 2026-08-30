# Slice 4 — Git push and vaporize proof

## Orientation

Close the MVP with the real operator outcome. Synchronize one narrow non-production Git credential through the already-proven credential path, let an unchanged cloud agent edit and push an isolated fixture branch, independently verify the remote commit, then vaporize through the existing lifecycle and prove compute and credential material are absent.

This slice adds only the Git materialization adapter and complete canary. It does not add OAuth setup, GitHub App issuance, repository mirrors/forks, publish workflows, richer policy, or lifecycle changes.

## Required context

Read [`README.md`](README.md), all prior handoffs, and the actual credential/materialization contracts produced by Slices 2–3. Start from the verified Slice 3 commit. Re-run its Codex and environment-secret proof before editing.

Use a dedicated non-production fixture repository and credential. Never use the Scotty repository or a broad personal credential as the destructive fixture.

## Outcome

```text
local narrow Git credential
  -> scotty sync
  -> encrypted named generation
  -> exact allowed fixture Session grant
  -> Git's normal HTTPS credential mechanism
  -> unchanged cloud agent edit/check/commit/push
  -> independent remote commit verification
  -> vaporize
  -> Sandbox and materialized credentials absent
```

## TOML addition

Use the adapter shape that requires the least new runtime behavior. If the Slice 3 `env` adapter can feed the baseline's existing Git setup without exposing the value in command arguments or Git config, reuse it. Otherwise add one `git-https` adapter with an adapter-owned target; do not add arbitrary Git providers.

```toml
[repos]
allowed = ["owner/scotty-fixture"]

[credentials.github]
kind = "git-https"
source = "SCOTTY_FIXTURE_GITHUB_TOKEN"
```

The credential must be scoped to the fixture repository and the minimum required content permission. A durable fine-grained fixture token is acceptable for this tracer bullet if its scope is narrow and its use is documented; short-lived issuance remains later work.

## Contracts and ownership

- Git remote owns branch and commit truth.
- TOML owns the exact repository allowlist and local credential source name.
- Credential DO owns encrypted generations.
- Session DO pins the selected generation and retains vaporize authority.
- Existing Sandbox owns the working clone, process environment, and temporary credential material.
- Existing lifecycle owns retry and verified `gone`; this slice does not add states or operations.

Materialization must use Git's normal non-interactive HTTPS credential mechanism. The persisted Git config may reference a helper or adapter-owned path but must not contain the token. The token must not appear in the remote URL, argv, shell history, terminal bootstrap output, commit metadata, or repository files.

## Implementation chunks

### 1. Narrow Git adapter

**Behavior:** Map the existing credential grant to the baseline's existing Git HTTPS setup. Prefer adapting `worker/src/sandbox/auth.ts` and its existing credential configuration over introducing a new service. Keep repository URL construction credential-free.

**Likely baseline files:**

- Slice 2–3 credential definition and grant unions
- `worker/src/sandbox/auth.ts`
- existing workspace/Git setup module
- focused Git/config tests

**Complete when:** `git credential`/push can obtain the granted value, while `git remote -v`, Git config output, process arguments, and repository files remain secret-free.

### 2. Deterministic real-agent task

**Behavior:** Add a fixture task that asks the real synchronized Codex/Pi agent to make one deterministic, verifiable change, run a bounded check, commit it on an isolated branch, and push. The task contains no credentials and uses the existing runner/terminal path.

**Likely baseline files:** existing E2E fixture/scenario modules only; no agent protocol changes.

**Complete when:** the agent finishes through the real deployed terminal and an independent GitHub/API or clean clone inspection proves the exact commit and content.

### 3. Teardown and forbidden-surface canary

**Behavior:** Extend the deployed canary to vaporize through the public product operation, wait for terminal state using existing lifecycle semantics, and independently inspect owned state. Forced cleanup may run only after recording a product failure.

Inspect at least:

- Sandbox/provider lookup;
- Session projection and terminal availability;
- materialization paths when provider diagnostics permit it;
- Worker and deployment logs;
- API request/response captures;
- R2 bundle objects and any existing backups;
- Alchemy outputs/state;
- fixture repository, remote URL, Git config, and commit;
- local command output and generated handoff artifacts.

Use hashes/canary markers to scan without printing the real secret.

**Complete when:** public vaporize reports terminal success only after existing absence conditions hold, duplicate vaporize is safe, and the forbidden-surface scan is clean.

## Verification

Run formatting, lint, affected typechecks, all focused config/bundle/credential/session/Git tests from prior slices, the repository's offline E2E suite, CLI clean-room build, and container image check.

Deployed acceptance sequence:

1. Start from a clean isolated local Scotty home/config.
2. Deploy the baseline-derived installation through the guarded production path.
3. Run one `scotty sync` for content, Codex auth, environment fixture, and Git credential.
4. Beam the exact fixture repository.
5. Observe a real Codex/Pi response and deterministic edit/check/commit/push.
6. Reload/reconnect using the existing terminal behavior.
7. Verify the remote branch independently.
8. Vaporize through the public command.
9. Prove provider/resource/credential absence and a clean forbidden-surface scan.
10. Repeat the full path from another clean local config without relying on undeclared machine state.

## Risks and stop conditions

- Stop if the credential must be embedded in a URL, argv, task, repository file, or ordinary Git config value.
- Stop if the test requires broad production repository access.
- Record ambiguous provider cleanup as a failure and let the existing vaporize retry path own recovery.
- Do not add short-lived token issuance, OAuth refresh, GitHub App setup, mirror/fork authority, Publish/PR orchestration, branch-policy framework, or lifecycle changes in this slice.

## Completion and final handoff

Write `docs/plans/handoffs/04-result.md` with:

- final commit and deployed installation/stage names;
- exact fixture repository and branch;
- synchronized bundle digest and credential generation metadata;
- model response and independently verified Git commit;
- every verification command and result;
- forbidden-surface scan method and result;
- vaporize and provider-absence evidence;
- residual risks and the smallest justified next product decision.

The four-slice MVP packet is complete only when this canary passes from a clean local configuration. Do not begin a fifth slice in the same session.
