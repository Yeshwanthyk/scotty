# Slice 3 — Declared environment secret

## Orientation

Generalize the proven credential-generation path by exactly one adapter: a declared local environment variable becomes a named encrypted generation and is materialized as one declared environment variable for an unchanged tool. This proves Scotty can synchronize ordinary secrets without turning the Credential DO into a provider framework or scanning the operator's machine.

The existing Sandbox, runner, lifecycle, Codex adapter, and non-secret bundle path remain unchanged.

## Required context

Read [`README.md`](README.md), the Slice 2 handoff, and the actual generation/grant contracts landed in Slice 2. Start from its verified commit and re-run one real Codex response before editing.

## Outcome

```text
[credentials.fixture]
kind = "env"
source = "SCOTTY_FIXTURE_TOKEN"
target = "FIXTURE_TOKEN"

local environment
  -> declared source lookup
  -> encrypted generation
  -> Session grant
  -> existing bootstrap environment
  -> unchanged fixture tool
```

Only names appear in TOML, status, Session records, audit events, and errors. The value exists locally, as ciphertext in the Credential authority, and transiently/materialized in the isolated Sandbox.

## TOML addition

```toml
[credentials.fixture]
kind = "env"
source = "SCOTTY_FIXTURE_TOKEN"
target = "FIXTURE_TOKEN"

[repos]
allowed = ["owner/fixture"]
```

Validation rules:

- credential names are unique and bounded;
- `source` and `target` match a strict environment-name grammar;
- source values are read only during explicit sync;
- absent or empty local values fail before upload;
- errors name the variable but never include its value;
- Session creation can request only credential names declared by the active TOML/config snapshot;
- repository authorization remains a simple exact allowlist checked before Sandbox allocation.

## Contracts and ownership

Reuse Slice 2's generation, encryption, fencing, redacted status, grant, and revocation contracts. Add a tagged adapter description rather than another store:

```text
CredentialDefinition
  name
  kind: pi-auth | env
  source (local only)
  target (non-secret policy)

CredentialGeneration
  name
  generation
  kind
  ciphertext
  contentDigest
  timestamps/revocation

SessionCredentialGrant
  name
  generation
  kind
  target
```

The Session grant may persist the non-secret target name, but never source-machine paths or plaintext. The bootstrap decrypts/materializes only grants committed to that Session.

## Implementation chunks

### 1. Environment adapter at the local boundary

**Behavior:** Extend the TOML and credential-source union with `kind = "env"`. Read the exact declared source through the CLI environment service, encode it as secret bytes, and reuse the existing credential upload command.

**Likely baseline files:** Slice 2's config, credential-source, command, transport, and schema modules plus focused CLI tests.

**Complete when:** missing, empty, malformed, and undeclared variables fail locally without remote effects or value disclosure.

### 2. Reuse generation authority and grant selection

**Behavior:** Store the new kind in the same Credential DO and resolve it through the same generation-fenced Session grant path. Add no provider-specific storage or refresh logic.

**Likely baseline files:** Slice 2's credential contracts/store/routes and Session grant selection.

**Complete when:** create with an undeclared name or revoked generation fails before Sandbox allocation; exact allowed repo and declared name succeed.

### 3. Existing-bootstrap environment materialization

**Behavior:** Add the granted target/value to the existing agent startup environment without serializing it into request files, shell scripts, logs, or command arguments. If the baseline can only establish environment through a generated shell file, use a mode-0600 adapter-owned file outside backup scope and source it without echoing; record that boundary in the handoff.

**Likely baseline files:** `worker/src/container-auth.ts` and the existing Sandbox runtime/start boundary only.

**Complete when:** an unchanged fixture tool observes the target variable and returns a non-secret proof derived from it, while a neighboring undeclared variable is absent.

## Verification

Run formatting, lint, affected typechecks, Slice 2 credential tests, and new boundary tests for missing source, malformed name, undeclared request, revoked generation, redacted errors, and no-allocation policy denial.

Deployed acceptance:

1. Set one non-production fixture secret locally.
2. Run `scotty sync` and record only its redacted generation metadata.
3. Beam the exact allowed fixture repository.
4. Run a fixture tool that proves access through a hash/challenge response without printing the secret.
5. Prove an undeclared credential name and disallowed repository fail before allocation.
6. Inspect terminal/bootstrap output and persisted Session/config/bundle state for absence of plaintext.
7. Vaporize using the unchanged lifecycle.

## Risks and stop conditions

- Keep `env` as the only new adapter. Arbitrary target files, SSH material, client certificates, Docker auth, and device OAuth remain out of scope.
- Do not enumerate or upload the process environment; read only declared sources.
- Do not introduce repo branch/submodule policy beyond the exact repository allowlist.
- Stop if the environment path requires changing the runner or container contract rather than supplying another existing bootstrap input.

## Handoff

Write `docs/plans/handoffs/03-result.md` with the commit, final env schema, exact materialization boundary, pre-allocation denial proof, redaction/leak checks, deployed fixture result, and the credential name chosen for Slice 4's Git proof. Slice 4 starts only from that verified commit.
