# Forgetting recent repositories on the Sessions page

Research snapshot: 2026-07-29. Scotty was inspected at
`30a038b7a0481c9c6bd4f5ab087f76f0ed8db9e0`. This note uses only Scotty's
current source, tests, and binding lifecycle contracts.

## Decision

Add a way to **forget a repository from Recent repositories**, not to “remove a
GitHub project.”

The items shown under the Repository field are suggestion history. Scotty does
not currently have a GitHub Project or installed-repository aggregate. A
repository name is stored on each session, and a separate non-authoritative KV
projection remembers recently used names. The session list's “project” groups
are derived from session records at render time
([`mergeRepositorySuggestions` and `groupSessionsByRepository`](../../worker/public/session-form.js#L27-L67);
[`renderRepositorySuggestions` and `render`](../../worker/public/sessions.html#L1922-L1944)).

“Forget” should therefore have this exact product meaning:

- Remove the repository only from the recent-repository suggestions.
- Leave every existing booting, warm, sleeping, or failed session unchanged.
  Those sessions remain listed under their repository group and remain
  attachable, resumable, downloadable, or vaporizeable under the existing
  lifecycle rules.
- Do not stop or destroy a Sandbox or runner runtime.
- Do not alter the session's `repo`, default branch, `scotty/<session-id>`
  branch, worktree, Codex/Pi thread, or operation lease.
- Do not delete or rotate a session credential bundle.
- Do not delete session KV projections, R2 backups, schedules, or the
  authoritative Sandbox Durable Object record.
- Do not delete, archive, rename, or change permissions on the GitHub
  repository, and do not delete pushed branches or pull requests.
- Keep manual `owner/name` entry available. The next successful creation of a
  session for the forgotten repository should add it to recents again.

This boundary follows [Scotty's ownership model](../../AGENTS.md#scope-and-invariants): the Sandbox
DO is authoritative for session lifecycle and credentials, KV is only a list projection, R2 holds
immutable backups, and the container filesystem is disposable session working state. Source-control
publishing is outside Scotty's HTTP and lifecycle orchestration, so a recents mutation cannot own
GitHub branch or pull-request cleanup.

## Where Recent repositories comes from

After `POST /api/sessions` creates or replays the authoritative session,
`createTrackedSession` calls `trackRepoBestEffort` with the returned `repo` and
resolved `defaultBranch`
([`worker/src/index.ts`, `createTrackedSession`](../../worker/src/index.ts#L768-L785)).
Tracking is deliberately best effort: its failure is ignored and does not turn
a successful session creation into an error
([`worker/src/repo-projection.ts`, `trackRepoBestEffort`](../../worker/src/repo-projection.ts#L53-L59);
[`worker/test/routes.test.ts`, repository-tracking route test](../../worker/test/routes.test.ts#L511-L551)).

`RepoProjection` writes this non-secret record:

```text
key:   repo:<owner/name>
value: { version: 1, repo, defaultBranch, lastUsedAt }
```

It uses the same `SESSIONS` KV namespace as session-list projections, but a
different prefix. Listing decodes and validates records, orders them by
`lastUsedAt` descending, and strips storage-only fields
([`worker/src/contracts.ts`, `REPO_KV_PREFIX`, `RepoProjectionSchema`, and `RepoViewSchema`](../../worker/src/contracts.ts#L8-L9);
[`worker/src/repo-projection.ts`, `kvRepoProjectionStorage` and `makeRepoProjection`](../../worker/src/repo-projection.ts#L22-L115);
[`worker/test/repo-projection.test.ts`](../../worker/test/repo-projection.test.ts#L21-L93)).

`GET /api/repos`, guarded by `sessions:read`, returns that projection
([`worker/src/index.ts`, `GET /api/repos`](../../worker/src/index.ts#L365-L377)).
The Sessions page fetches it once on startup. Repository history is explicitly
optional; manual entry remains usable when the fetch fails
([`worker/public/sessions.html`, `refreshRepositories`](../../worker/public/sessions.html#L2268-L2283);
[`worker/public/sessions.html`, startup calls](../../worker/public/sessions.html#L2645-L2648)).

The UI then merges tracked repositories first and current session projections
second, deduplicates case-insensitively, and renders the first five
([`worker/public/session-form.js`, `mergeRepositorySuggestions`](../../worker/public/session-form.js#L27-L46);
[`worker/public/sessions.html`, `renderRepositorySuggestions`](../../worker/public/sessions.html#L1922-L1944)).
That session fallback is the main trap for removal: deleting only
`repo:<owner/name>` would make a repository with any listed session reappear
immediately.

## What is missing today

Removal does not exist at any layer:

- `RepoProjectionStorage` supports `get`, `list`, and `put`, but no `delete`.
- `RepoProjection` supports `upsert` and `list`, but no `forget`.
- The HTTP API exposes only `GET /api/repos`.
- Each recent-repository chip has only one action: copy its name into the
  repository input.

These current surfaces are visible together in
[`worker/src/repo-projection.ts`](../../worker/src/repo-projection.ts#L22-L65),
[`worker/src/index.ts`](../../worker/src/index.ts#L336-L397), and
[`worker/public/sessions.html`](../../worker/public/sessions.html#L1922-L1944).

## Smallest correct contract

Add a repository-history deletion operation at the projection boundary:

```text
DELETE /api/repos/:owner/:name
required scope: sessions:write
success: { "repo": "owner/name", "forgotten": true }
```

The route should validate the reconstructed `owner/name` with the same
`parseRepo` contract used for session creation
([`worker/src/contracts.ts`, `parseRepo`](../../worker/src/contracts.ts#L570-L576)).
It should be idempotent: an already-absent repository still returns success.
This is deletion of optional display metadata, not a session lifecycle
transition, so it must not address a Sandbox DO.

Conceptually, the implementation needs:

1. `delete(key)` on `RepoProjectionStorage`.
2. `forget(repo)` on `RepoProjection`.
3. An authenticated `DELETE /api/repos/:owner/:name` route using
   `sessions:write`. Standard clients already receive `sessions:read` and
   `sessions:write`
   ([`worker/src/auth-registry.ts`, `STANDARD_AUTH_SCOPES`](../../worker/src/auth-registry.ts#L14-L22)).
4. A separate remove control beside each suggestion. The suggestion itself is
   already a button, so the remove affordance must be a sibling button rather
   than a nested interactive element.
5. On success, remove the entry from `trackedRepositories` and rerender, which
   naturally reveals the sixth-most-recent repository if one exists.
6. Stop using current sessions as an implicit source for **recent
   suggestions**. Sessions should continue to drive the project-group list, but
   `mergeRepositorySuggestions` must not reintroduce a deliberately forgotten
   repository. The tracked projection becomes the suggestion source; manual
   entry remains the fallback.

No tombstone or new authoritative “Project” model is needed for this behavior.
A later successful session creation already upserts the projection and is the
natural explicit signal to make the repository recent again.

## Identity and concurrency details

Current KV keys preserve submitted casing, while the UI treats repository names
case-insensitively. It is therefore possible for legacy keys such as
`repo:ExampleUser/scotty` and `repo:exampleuser/SCOTTY` to coexist even though
the UI renders one suggestion
([`worker/src/repo-projection.ts`, upsert key](../../worker/src/repo-projection.ts#L71-L83);
[`worker/public/session-form.js`, case-insensitive identity](../../worker/public/session-form.js#L31-L43)).
Forgetting must remove every projection whose repository identity matches
case-insensitively, or migrate future keys to a normalized identity while
cleaning up legacy aliases. Deleting only the displayed exact-case key is not
sufficient.

KV is an eventually consistent projection and may lag without changing authoritative transitions
([`AGENTS.md`](../../AGENTS.md#scope-and-invariants)).
The page should optimistically suppress the successfully forgotten identity for
the remainder of the current view so a stale read cannot make the chip bounce
back. If a concurrent session creation for the same repository completes after
the forget, its later tracking write should win and make the repository recent
again.

If forgetting fails, keep or restore the chip and show an inline error. Do not
clear the repository input if it currently contains the same name: forgetting
history must not discard a draft session.

## UX and copy

Use a small remove icon paired with the repository chip:

```text
Accessible label: Forget ExampleUser/ziggy from recent repositories
Tooltip: Remove from recents
Success: Removed ExampleUser/ziggy from recent repositories.
Detail: Existing workspaces and GitHub content were not changed.
Failure: Could not remove ExampleUser/ziggy from recent repositories. Try again.
```

Do not show a destructive confirmation dialog. The operation removes
reconstructable suggestion metadata only, manual entry still works, and a later
session recreates the recency record. A destructive-looking confirmation would
wrongly imply that Scotty is deleting a repository or workspace.

Keep the existing session-level confirmation for vaporize completely separate.
That route destroys the runtime, deletes owned backups and the per-session
credential bundle, removes the session KV projection, and persists `gone`
([`worker/src/index.ts`, `DELETE /api/sessions/:id`](../../worker/src/index.ts#L447-L451);
[`worker/src/session.ts`, `continueVaporizeSessionProgram`](../../worker/src/session.ts#L1284-L1335);
[`worker/test/session-down-vaporize.test.ts`](../../worker/test/session-down-vaporize.test.ts#L161-L212)).

## Acceptance cases

The smallest proof should cover:

1. With no sessions, forgetting a recent repository removes its chip and
   reveals the next suggestion.
2. With warm or sleeping sessions for that repository, forgetting removes only
   the chip; the project group and every session remain unchanged.
3. Case variants are all forgotten by one request.
4. Repeating the request succeeds.
5. A KV deletion failure leaves the chip visible and reports a safe error.
6. A stale `/api/repos` response does not make the chip bounce back in the same
   page view.
7. Manual entry of the forgotten repository still works.
8. The next successful session creation for it makes it recent again.
9. Forgetting does not call Sandbox/runner lifecycle RPC, session projection
   deletion, R2 deletion, credential deletion, schedules, or GitHub publishing
   operations.
