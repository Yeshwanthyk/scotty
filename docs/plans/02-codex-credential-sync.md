# Slice 2 — Local Codex auth to a real cloud agent

> **Status:** Historical implementation plan. The current TOML path is `~/.config/scotty/scotty.toml` and the synchronization command is top-level `scotty sync`; the plan below records the original slice intent.

## Orientation

Add the smallest separate secret channel. `scotty sync` reads one declared local Pi/Codex authentication source, uploads an encrypted immutable generation to an installation Credential Durable Object, and lets a new Session pin and materialize that generation through the existing bootstrap. The unchanged agent must produce a real deployed model response.

Content sync from Slice 1 remains non-secret and unchanged. This slice removes sentinel substitution from the selected Codex path; it does not add a transparent proxy, generic broker framework, or new Sandbox service.

## Required context

Read [`README.md`](README.md) and the Slice 1 handoff. Start from the verified Slice 1 commit and re-run its smallest deployed bundle proof before editing.

Cloudflare OS is the design reference for ownership and concurrency:

- `packages/mcp-shared/src/account.ts`: the account DO is the only credential owner; connection generation fences stale async work.
- `packages/gatekeeper-google/src/google.ts`: credential mutation/refresh is serialized and stale mint results are discarded.
- `packages/workshop-backend/src/user.ts`: the kernel stores account capabilities, not account tokens.

Scotty deliberately differs at the last hop: Cloudflare OS performs provider calls inside Gatekeepers for no-network agents; Scotty materializes an explicitly declared credential because Pi/Codex runs unchanged in a networked disposable Sandbox.

## Outcome

```text
local Pi/Codex auth
  -> strict local adapter decode
  -> encrypted generation N
  -> Credential DO commits N
  -> Session pins { name: codex, generation: N }
  -> existing bootstrap writes native auth shape with mode 0600
  -> unchanged deployed Pi/Codex returns a real response
```

No plaintext credential is returned by an API or written to TOML, R2 bundles, logs, Alchemy props/outputs/state, command arguments, or Git configuration.

## TOML addition

Use the actual local path confirmed by the baseline's Pi auth loader; do not guess it from the example.

```toml
[credentials.codex]
kind = "pi-auth"
source = "~/.pi/agent/auth.json"
```

TOML stores the local pointer and credential name only. The target path and permissions are owned by the `pi-auth` adapter and existing bootstrap.

## Credential authority

Persist one installation-scoped model:

```text
credential name
  currentGeneration
  generations[N]
    kind
    ciphertext
    contentDigest
    createdAt
    revokedAt?
```

Required rules:

1. The Credential DO is the only remote owner of ciphertext and current-generation selection.
2. Sync creates a new immutable generation; identical content may return the existing current generation idempotently.
3. Mutation uses an expected current generation or equivalent revision fence. Stale completion cannot become current.
4. Public/list/status responses expose only name, kind, generation, configured/revoked state, digest metadata safe for equality, and timestamps.
5. A Session stores an immutable grant naming the selected generation before Sandbox materialization.
6. Revoked generations cannot be granted to new Sessions.
7. OAuth refresh is deferred unless the deployed Codex proof establishes that a synchronized native auth file cannot operate without it.

Use the smallest wrapping-key boundary already proven by the baseline. Ciphertext may live in DO storage; wrapping material must not enter ordinary Alchemy state or API output. Do not create provider-specific DO classes in this slice.

## Implementation chunks

### 1. Local `pi-auth` adapter and sync orchestration

**Behavior:** Extend the Slice 1 TOML Schema and top-level `scotty sync` orchestration. Read and validate the existing Pi/Codex auth shape through the baseline's existing `cli/src/pi-auth.ts` and `protocol/pi-auth.ts` logic rather than treating arbitrary JSON as valid.

**Likely baseline files:**

- `cli/src/pi-auth.ts`
- `protocol/pi-auth.ts`
- `cli/src/scotty-config-contracts.ts`
- `cli/src/commands.ts`
- CLI transport/schema modules and focused auth tests

Keep content upload and credential upload as separate requests/results internally. Human output may summarize both; JSON output must preserve existing contracts or add a versioned field without changing old meanings.

**Complete when:** local validation reports provider/type/status without printing tokens, and an interrupted/repeated sync is idempotent.

### 2. Encrypted generation authority

**Behavior:** Adapt or replace the baseline `worker/src/credential-vault.ts` / installation Pi auth store with named immutable generations. Delete the sentinel/egress dependency only from the Codex materialization path after the direct path is green.

**Likely baseline files:**

- `worker/src/credential-vault.ts`
- `worker/src/installation-pi-auth-store.ts`
- `worker/src/session/contracts.ts`
- Worker route/RPC wiring
- `infra/cloudflare-stack.ts` and `infra/installation.ts` only for the required DO/binding/migration

**Complete when:** generation creation, same-content replay, stale expected-generation conflict, redacted status, and revocation are covered by focused tests.

### 3. Session grant and existing-bootstrap materialization

**Behavior:** At Session create, resolve the declared `codex` generation, persist its immutable grant, decrypt only for the bounded bootstrap operation, and write the native auth file through the existing runtime file boundary with restricted permissions. Do not place plaintext in Session records or ordinary process arguments.

**Likely baseline files:**

- `worker/src/session/object.ts` and Session contracts/store
- `worker/src/sandbox/auth.ts`
- existing Sandbox runtime adapter

The existing container and runner remain unchanged. Materialization is an input to their established startup path.

**Complete when:** a deployed new Session returns a real model response using the synchronized credential, while a Session created before a newer sync remains pinned to its original generation.

## Verification

Run formatting, lint, affected typechecks, existing auth/session/container tests, and new generation/fencing/redaction tests.

Deployed acceptance:

1. Use an isolated local Scotty config and a non-production installation.
2. Run `scotty sync` with the declared Codex source.
3. Confirm status shows the generation but no plaintext.
4. Create a new Session and request an exact deterministic response.
5. Confirm the real provider/model path, not a fake.
6. Sync the same source again and prove idempotency.
7. Scan Worker logs, CLI output, API captures, R2 bundle objects, Alchemy state, and repository files for forbidden credential material.
8. Vaporize using the unchanged lifecycle.

## Risks and stop conditions

- Stop if the design requires sentinel substitution or arbitrary egress interception.
- Stop if plaintext crosses a log, API read, Alchemy state, R2 bundle, command argument, or Session record.
- Stop rather than adding generalized OAuth refresh. Record the exact observed Codex expiry behavior for a later decision.
- Keep the Credential DO installation-scoped and small; do not create Gatekeeper, provider plugin, approval, or account marketplace abstractions.

## Handoff

Write `docs/plans/handoffs/02-result.md` with the commit, actual local auth source, stored metadata shape, encryption boundary, generation/fencing proof, deployed model response, leak-scan commands, and unresolved expiry behavior. Slice 3 starts only from that verified commit.
