# Slice 1 — TOML to synchronized skill

> **Status:** Historical implementation plan. The current operator surface is `scotty config check` plus top-level `scotty sync`, backed by `~/.config/scotty/scotty.toml`. The plan below records the original slice intent; retired CLI module references have been updated to their current owners.

## Orientation

Make the existing working bundle path operator-readable and prove it through one deployed Session. Replace the legacy sandbox JSON/source-management surface with a small TOML input at `~/.config/scotty/scotty.toml`. `scotty sync` builds one deterministic non-secret archive containing skills, user-space tools, and allowed Pi extensions, publishes it through the existing bundle authority, and makes a new Session pin it.

This slice changes configuration and bundle input only. The existing deployment, container, runner, terminal, Session lifecycle, bundle storage authority, and materializer remain the starting implementation.

## Required context

Read [`README.md`](README.md) first. Implement from the verified commit descended from `e8bcaa3d`, not from an unproved reconstruction. Inspect the live baseline before renaming commands or schemas; preserve public JSON and exit behavior and make the top-level `scotty sync` additive where compatibility requires it.

## Outcome

```text
scotty.toml
  -> strict decode
  -> deterministic sanitized manifest
  -> immutable archive + digest
  -> existing upload/current-pointer authority
  -> new Session pins digest
  -> existing bootstrap exposes one skill, tool, and extension to Pi
```

A second sync with identical inputs produces the same digest. Credential material cannot enter the manifest or archive.

## Target TOML surface

```toml
version = 1

[sync]
skills = ["~/.pi/agent/skills"]
packages = []
tools = ["~/.pi/agent/tools"]
extensions = ["~/.pi/agent/extensions"]

[repos]
allowed = ["owner/fixture"]
```

Only these keys are required in this slice. Preserve credential tables as unknown/future only if the same change also strictly decodes them without reading values; otherwise add them in Slice 2. Reject unknown keys, duplicate semantic names, unresolved placeholders, missing roots, paths outside declared roots, and unsupported file types before network or provider effects.

## Contracts and ownership

- TOML owns local source paths and the exact repository allowlist.
- The generated manifest owns relative paths, modes, sizes, and content digests.
- R2 owns immutable archive bytes by digest.
- The existing remote Bundle/SandboxConfig authority owns the verified current pointer.
- Each Session records one digest before Sandbox allocation.
- Fixed destination layout remains owned by the existing container/bootstrap; TOML cannot configure it.

Content categories:

| Input               | Bundle behavior                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Skill directory     | Preserve the complete skill directory beneath a deterministic skill name                      |
| Tool directory      | Include unprivileged scripts/executables with normalized safe modes                           |
| Extension directory | Include allowed Pi extension source/package content without running install hooks during sync |
| Native dependency   | Reject with a diagnostic directing the operator to the image path                             |

## Sensitive exclusions

The walker must fail closed for credential-bearing or runtime-local material, including auth files, environment dumps, session histories, logs, caches, `.git`, dependency trees not explicitly part of an extension, sockets, devices, FIFOs, and symlinks that escape a declared root. Do not rely only on filename exclusions: resolve each entry beneath its root and build the archive from the validated manifest.

## Implementation chunks

### 1. TOML boundary

**Behavior:** Parse TOML as unknown and decode it with the repository's Effect Schema. Resolve `~` and relative paths locally without writing resolved machine paths into remote state.

**Likely baseline files:**

- `cli/src/scotty-config-contracts.ts`
- `cli/src/scotty-config.ts`
- `cli/src/commands.ts`
- `cli/src/main.ts`
- `skills/scotty/SKILL.md`
- focused config tests under `cli/effect-test/`

Use one small TOML parser and immediately Schema-decode its output. Remove the legacy JSON config as an authority after all callers move; a one-time read-only diagnostic may point users to the new path but must not create two writable formats.

**Complete when:** `scotty config check` accepts the target TOML, rejects secrets/unknown keys/unsafe paths, and causes no remote side effects.

### 2. Deterministic three-category bundle

**Behavior:** Adapt the existing bundle builder/walker to skills, tools, and extensions. Generate the internal manifest, normalize ordering and modes, archive only validated entries, and preserve existing digest/upload/read-back/CAS behavior.

**Likely baseline files:**

- `cli/src/{scotty-bundle,sandbox-bundle,sandbox-walk,sandbox-archive,sandbox-sync}.ts`
- `worker/src/sandbox-{config-contracts,config-store,bundle-store,bundle-materializer}.ts`
- existing focused bundle and sync tests

**Complete when:** identical trees yield the same digest; one-byte changes yield a new digest; sensitive and escaping entries go red before upload.

### 3. Existing-runtime proof

**Behavior:** Add only the bootstrap mapping necessary for the existing runner/Pi process to see all three categories at fixed destinations. Do not add a daemon, runner protocol, image abstraction, or active-session refresh.

**Likely baseline files:** `worker/src/sandbox/auth.ts` and the existing bundle materializer only if their current mapping lacks one category.

**Complete when:** a newly created deployed Session can invoke one fixture skill, execute one fixture tool, and load one fixture extension from its pinned digest.

## Verification

Run formatting, lint, affected CLI/Worker typechecks, and the existing focused config/bundle/materializer tests. Add boundary tests for deterministic digest, unsafe symlink, forbidden auth file, missing root, unknown TOML key, and duplicate source name.

Deployed acceptance:

1. Deploy or reuse the isolated baseline installation.
2. Sync a fixture skill, tool, and extension.
3. Record the returned digest and changed manifest entries.
4. Create a new Session and confirm its persisted digest.
5. Use the real terminal/Pi path to prove all three fixtures.
6. Sync unchanged inputs and prove the digest is unchanged.
7. Vaporize through the existing lifecycle.

## Risks and stop conditions

- Stop if bundle work requires redesigning the container, runner, or Session lifecycle.
- Stop if a credential file appears in manifest, archive, R2, logs, or API output.
- Stop if sync causes an infrastructure deployment.
- Defer active-session refresh; new-session pinning is sufficient here.

## Handoff

Write `docs/plans/handoffs/01-result.md` in the implementation checkout. Include the commit, final TOML schema, command compatibility decision, fixture names, digest proof, deployed Session ID (non-secret), checks run, and any baseline file names that differ from this plan. Slice 2 starts only from that verified commit.
