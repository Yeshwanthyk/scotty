# Cloudflare Artifacts Git path — research evidence

Research snapshot: 2026-08-22. This is planning evidence only. No product code, configuration, tickets, map, or `CONTEXT.md` was changed.

## Short verdict

**The claimed path is technically supported, but only as a composed design, not as one Cloudflare “per-Session Git” primitive.**

1. **GitHub → Artifacts baseline/mirror:** **Yes for a one-time import**, including a documented public GitHub HTTPS example. **No source proof of an ongoing GitHub mirror/synchronizer.**
2. **Per-Session Fork:** **Yes as an application mapping**: `repo.fork(name, options)` is a first-party Artifacts primitive, and Cloudflare’s pinned Sandbox SDK ships a “one Artifacts repo per sandbox” example. **There is no Artifacts API that knows Scotty Sessions; the Session→repo identity and lifecycle are application-owned.**
3. **Normal Git clone/push:** **Yes.** Artifacts exposes standard Git smart HTTP; `read` tokens clone/fetch/pull and `write` tokens additionally push. Cloudflare Sandbox can execute the same commands in its container. A trusted runner can use the same remote/token with a normal Git client, subject to network and secret-handling controls.
4. **Narrow token lifecycle:** **Yes for mint, list/inspect, and revoke; no atomic “replace” primitive.** `read`/`write` repo scope and TTL are explicit. Rotation is a composed **mint-new → switch consumer → revoke-old** sequence. “Immediate” revocation needs a deployed experiment to establish propagation behavior.
5. **Real GitHub credential out of Session compute:** **Yes for the Artifacts-mediated path.** The proof-of-concept passes an Artifacts repo token/remote into Sandbox compute, not a GitHub credential. This does **not** prove a private-GitHub import path or a credentialless Artifacts-token proxy; the documented import flow is for public HTTPS remotes.

## Exact repository pins and inspected source

### Scotty package pins

The repository has two relevant declarations:

- `package.json:62-73`: `alchemy: 2.0.0-beta.72`, `@alchemy.run/cloudflare-runtime: 2.0.0-beta.72`, `@cloudflare/sandbox: 0.12.3`, and `@cloudflare/workers-types: 5.20260719.1`.
- `worker/package.json:11-16`: `@cloudflare/containers: 0.3.5`, `@cloudflare/sandbox: 0.12.3`, `effect: 4.0.0-rc.109`, `hono: 4.12.31`.
- `package-lock.json:633-642` pins the installed `@cloudflare/sandbox` tarball to `0.12.3` with integrity `sha512-4yx+PtBCZBrS3eZteefwBfGOm+8MTZahLH8/fG/qsvqoNflzno9780FsM6HZf02gGuoDy+s9jQrXbg/h5gEvgw==`.
- `package-lock.json:11323-11339` records the worker workspace and its exact `@cloudflare/containers@0.3.5` tarball.
- `node_modules/@cloudflare/sandbox/package.json` identifies the upstream repository as `https://github.com/cloudflare/sandbox-sdk`; npm metadata reports the `0.12.3` `gitHead` as [`696388b24c1c59a19b484a9e8066dc431addf617`](https://github.com/cloudflare/sandbox-sdk/commit/696388b24c1c59a19b484a9e8066dc431addf617).

### Pinned Alchemy vendor

- `vendor/alchemy` is submodule commit [`4465e353603ab71b279a66c4fcd3ecc1488aa090`](https://github.com/alchemy-run/alchemy/commit/4465e353603ab71b279a66c4fcd3ecc1488aa090), released as `2.0.0-beta.72` (`vendor/alchemy/package.json`; commit subject `chore(release): 2.0.0-beta.72`).
- The generic `packages/alchemy/src/Artifacts.ts:8-22` is **not Cloudflare Artifacts**. It says: “**Per-resource in-memory artifacts shared across a single `Plan.make -> apply` execution**” and “**artifacts are ephemeral and must never be required for correctness on a later deploy**.” Its API is only the in-memory `get`, `set`, and `delete` cache at `Artifacts.ts:34-50`.
- Separately, this pinned Alchemy commit **does** contain a thin Cloudflare Artifacts binding adapter:
  - `packages/alchemy/src/Cloudflare/Artifacts/Namespace.ts` declares a binding marker that emits `{ type: "artifacts", name, namespace }` and says the namespace is implicit and the first repo write conjures it.
  - `packages/alchemy/src/Cloudflare/Artifacts/ReadWriteNamespace.ts:71-110` exposes Effect-native `createToken`, `listTokens`, `revokeToken`, `fork`, `create`, `delete`, and `import` surfaces.
  - `packages/alchemy/src/Cloudflare/Artifacts/ReadWriteNamespaceBinding.ts` wraps the native Worker binding and registers the `type: "artifacts"` binding; `packages/cloudflare-runtime/src/core/bindings/Artifacts.ts` emits the same remote binding descriptor.
  - `packages/alchemy/test/Cloudflare/Artifacts/Binding.test.ts` is an entitlement-gated live test. Its documented round trip is only deploy → create/list/get/delete, and its fixture route (`test/Cloudflare/Artifacts/fixtures/routes.ts`) returns only repo metadata and a boolean `hasToken`; the test does **not** exercise Git clone/fetch/push, import, fork, token expiry, or revocation.
- There is a version/documentation boundary: the pinned Alchemy source says “**Namespaces on Cloudflare are implicit: there is no `POST /namespaces` endpoint**” (`Namespace.ts:62-67`), while the current first-party REST docs now document `POST /artifacts/namespaces`. The adapter’s binding surface remains useful evidence for create/import/fork/token method names, but namespace provisioning and all Git/token behavior still need to be checked against the deployed service.

## Source proof from the pinned Cloudflare Sandbox SDK

The source snapshot for `@cloudflare/sandbox@0.12.3` is the upstream commit [`696388b24c1c59a19b484a9e8066dc431addf617`](https://github.com/cloudflare/sandbox-sdk/tree/696388b24c1c59a19b484a9e8066dc431addf617).

### Git operations in Sandbox

The published type declaration in `node_modules/@cloudflare/sandbox/dist/sandbox-BhIQBik-.d.ts` exposes:

- `Sandbox.gitCheckout(repoUrl, options)` with `branch`, `targetDir`, `depth`, `sessionId`, and `cloneTimeoutMs` (`~1419-1433` and `~3103-3111`).
- `Sandbox.createSession(options)` and `Sandbox.deleteSession(sessionId)` (`~1436-1437`); explicit session-bound execution exposes `ExecutionSession.exec`, `startProcess`, file methods, and related operations (`~1130-1176`).
- `exec(command, options)` supports per-command `env`, `cwd`, timeout, streaming, and cancellation (`~358-405`).

The pinned SDK source/test paths provide behavioral evidence:

- [`packages/sandbox/src/sandbox.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/src/sandbox.ts) wires the public `gitCheckout` API to the Git client and supports `sessionId` (`~5052`, `~5989-5990`).
- [`packages/sandbox/tests/git-client.test.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/tests/git-client.test.ts:39) tests successful public clone, branch selection, target directory, shallow `depth`, timeout, invalid inputs, and error mapping. The test quote at `:40-65` is: “**should clone public repositories successfully**”; it calls `client.checkout('https://github.com/facebook/react.git', 'test-session')`.
- [`packages/sandbox-container/tests/services/git-service.test.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox-container/tests/services/git-service.test.ts:146) verifies that the container service constructs a normal `git clone` command, including `--filter=blob:none`, branch, depth, timeout, URL validation, and a caller-selected `sessionId` (`:167-199`, `:221-244`).
- [`tests/e2e/git-clone-workflow.test.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/tests/e2e/git-clone-workflow.test.ts:101) runs real GitHub clone coverage, including a depth-1 shallow clone and checks `git rev-list --count HEAD == 1` and `git rev-parse --is-shallow-repository == true` (`:117-168`). These tests prove the Sandbox clone path, not Artifacts service availability in Scotty’s deployment.

### Pinned SDK example: Artifacts repo per Sandbox

Cloudflare’s exact-version example is [`examples/git-repo-per-sandbox/src/index.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/git-repo-per-sandbox/src/index.ts):

- The example declares `ArtifactsRepo.createToken(scope?: 'write' | 'read', ttl?: number)` (`:14-25`) and a Worker `Artifacts` binding with `get(name)` and `create(name)` (`:36-44`).
- It maps the Sandbox ID to the Artifacts repo name: `getSandbox(env.Sandbox, sandboxID)` (`:172-177`), then creates or gets the repo and mints a `write` token with TTL `3600` (`:184-210`).
- It derives an authenticated Artifacts remote and sets it into the sandbox with `sandbox.setEnvVars({ ARTIFACTS_GIT_REMOTE: ... })` (`:214-220`). The example explicitly extracts the token secret from the `?expires=` suffix (`:168-170`).
- Its command script clones if needed and then performs ordinary Git operations: `git clone "$ARTIFACTS_GIT_REMOTE"` (`:242-248`), `git add`, `git commit`, and `git push origin "HEAD:$DEFAULT_BRANCH"` (`:249-257`).
- The example README summarizes the proof: “**Create one Artifacts repo per sandbox and let the sandbox push to that repo with a normal Git remote**,” “**Clone the repo inside the sandbox and push a commit back to Artifacts**,” and “**The sandbox receives an authenticated Git remote through `ARTIFACTS_GIT_REMOTE`**” ([README](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/git-repo-per-sandbox/README.md:1-11,65-71)).
- The example’s `wrangler.jsonc` binds `ARTIFACTS` to an Artifacts namespace and provisions the Sandbox Durable Object/container (`:10-30`): [wrangler.jsonc](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/git-repo-per-sandbox/wrangler.jsonc).

This is strong source proof for a **repo-per-Sandbox** design. It is not proof that Artifacts itself understands a Scotty Session, or that a fork is automatically created when a Session starts.

## First-party Cloudflare Artifacts API evidence

All URLs below are official `developers.cloudflare.com` documentation.

### GitHub import / baseline

- [Artifacts home](https://developers.cloudflare.com/artifacts/) says: “**Artifacts stores versioned file trees behind a Git-compatible interface. Create repositories programmatically, import existing repositories, and hand off a URL to any standard Git client.**” It also says Artifacts can “**Fork from a shared baseline and diff or merge the results later**.”
- [Import repositories](https://developers.cloudflare.com/artifacts/guides/import-repositories/) says: “**Artifacts imports public HTTPS remotes through the REST API or the Workers binding. After import, the repo has a normal Artifacts remote URL and can be cloned, forked, or issued repo-scoped tokens like any other repo.**” Its example imports `https://github.com/cloudflare/workers-sdk`.
- [Workers binding reference](https://developers.cloudflare.com/artifacts/api/workers-binding/) defines `artifacts.import({ source: { url, branch, depth }, target: { name, opts } })`, and its example is `importFromGitHub()` with `url: "https://github.com/cloudflare/workers-sdk"`.
- [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) gives the exact import route: `POST /artifacts/namespaces/:namespace/repos/:name/import`; body fields are `url`, optional `branch`, `depth`, and `read_only`. The documented example is:

  ```text
  POST .../artifacts/namespaces/default/repos/react-mirror/import
  {"url":"https://github.com/facebook/react","branch":"main","depth":100}
  ```

  It returns `remote` and an initial token. The same page warns that import can remain in progress and follow-up calls can return `409 Conflict`.

**Interpretation:** this proves a one-time GitHub-to-Artifacts import/baseline. It does **not** prove a continuously synchronized mirror, webhook, upstream tracking ref, or automatic GitHub push-back. Those would require a separate application loop or a deployed experiment showing such behavior.

### Per-Session Fork

- [Workers binding reference](https://developers.cloudflare.com/artifacts/api/workers-binding/) defines `repo.fork(name, { description?, readOnly?, defaultBranchOnly? })` and says: “**`fork()` returns metadata for the new repo.**”
- [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) gives the exact route `POST /artifacts/namespaces/:namespace/repos/:name/fork` with `name`, `description`, `read_only`, and `default_branch_only`; the response includes the new repo remote, initial token, and object count.
- The `ArtifactsRepoInfo.source` field in the generated binding type ([exact pinned generated type](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/git-repo-per-sandbox/worker-configuration.d.ts:10031-10050)) records a fork source such as `artifacts:namespace/repo`.

**Interpretation:** `fork()` is a real repo-to-repo primitive suitable for `baseline → Session repo`. “Per-Session” is an application convention: use a validated, collision-safe session-derived repo name, persist the mapping, authorize the caller, and delete/retain it according to Session lifecycle. Cloudflare does not provide a `forkForSession(sessionId)` operation.

### Normal Git clone, fetch, pull, and push

- [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) defines the standard remote as `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git` and says: “**Use the returned repo `remote` with a regular Git client for `clone`, `fetch`, `pull`, and `push`.**”
- It documents Bearer-header auth with `git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" ...` and recommends it over putting credentials in the remote URL.
- The same page defines scopes: `read` permits `git clone`, `git fetch`, and `git pull`; `write` permits those plus `git push`.
- [Get started with Workers](https://developers.cloudflare.com/artifacts/get-started/workers/) demonstrates both local normal Git push and clone against the Artifacts remote, with `http.extraHeader`.

**Interpretation:** Cloudflare Workers can mint/authorize the repo credential and Cloudflare Sandbox/container or a trusted runner can run the standard Git client. A trusted runner is not a special Cloudflare API capability; it is ordinary Git-over-HTTPS use of the same Artifacts remote and repo token. Network egress, runner trust, token delivery, and cleanup remain deployment/application concerns.

### Narrow token mint, rotation/replace, and revoke

Workers binding methods (documented at [workers-binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)):

- `repo.createToken(scope?: 'write' | 'read', ttl?: number)` → structured `{ id, plaintext, scope, expiresAt }`.
- `repo.listTokens()` → token metadata without plaintext.
- `repo.revokeToken(tokenOrId)` → `Promise<boolean>`.

The generated type comments at the exact pinned SDK snapshot add the limits: token TTL defaults to 86,400 seconds, minimum 60 seconds, maximum 31,536,000 seconds; token metadata states are `active`, `expired`, or `revoked`; and `revokeToken` accepts plaintext or ID ([worker-configuration.d.ts](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/git-repo-per-sandbox/worker-configuration.d.ts:10115-10147)).

REST equivalents at [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/):

- `POST /artifacts/namespaces/:namespace/tokens` with `{ repo, scope: 'read'|'write', ttl }` returns `{ id, plaintext, scope, expires_at }`.
- `GET /artifacts/namespaces/:namespace/repos/:name/tokens?state=...` lists token metadata.
- `DELETE /artifacts/namespaces/:namespace/tokens/:id` revokes a token.

The docs explicitly state: “**Repo-scoped Artifacts tokens authenticate Git access**,” and the Git protocol page says token strings carry an expiry suffix such as `art_v1_<hex>?expires=<unix_seconds>`.

**Interpretation:** least-privilege minting and explicit revocation are source-proven. There is no documented atomic rotate/replace method: rotation must mint a new token, update every consumer, then revoke the old token. The API contract documents revocation, but not a bound on revocation propagation or whether an already-admitted Git request can finish. “Immediate revoke” therefore remains a live deployed property to measure, not a source-level guarantee.

## Credential boundary assessment

### What is source-proven

- The Artifacts import documentation is explicitly for **public HTTPS remotes** and the binding type documents `REMOTE_AUTH_REQUIRED` for an authenticated source. Therefore the documented import path does not require passing a real GitHub credential to the Sandbox Session.
- The pinned Sandbox example places only the Artifacts authenticated remote in the Sandbox environment (`ARTIFACTS_GIT_REMOTE`) and uses that remote for clone/push. It never puts a GitHub token in the Session.
- The example redacts the Artifacts token secret from stdout/stderr before returning output (`src/index.ts:85-86,164-169`).
- The Git protocol documentation recommends `http.extraHeader` over a credential-bearing remote URL, reducing persistence in Git config and logs. The pinned example uses a URL form for simplicity, so the safer header form should be preferred in any Scotty design.

### What is not source-proven

- A private GitHub repository import with GitHub OAuth/PAT held only by a Worker or control-plane service. The official import docs say public HTTPS; the SDK type errors include `REMOTE_AUTH_REQUIRED`, not a GitHub-secret reference mechanism.
- That an Artifacts token is a “sentinel” or credentialless capability. The pinned example passes the actual short-lived Artifacts token secret into Sandbox environment state. This keeps the **real GitHub credential** out, but it does not keep every Git credential out of compute.
- That a trusted runner can receive a token without it appearing in process arguments, environment, shell history, Git config, logs, or crash output. The normal Git protocol proves connectivity, not Scotty’s required secret-isolation invariant.
- That revocation is effective synchronously at the exact instant the control-plane call returns.

## Live deployed experiment required before claiming proof

A source review is enough to claim API availability, but not the following operational guarantees:

1. **Import readiness:** import a public GitHub test repository; observe `importing`/`409` behavior; wait for `ready`; verify the Artifacts remote clones and its commit/tree matches the selected branch/depth.
2. **Fork isolation:** fork a known baseline with `default_branch_only`; verify commit ancestry/content, independent writes, and the exact behavior for concurrent forks and name collisions.
3. **Cloudflare Sandbox path:** in a deployed Worker/Sandbox, create a Session, inject only a short-lived Artifacts token using the safer header form, clone, commit, push, then inspect output, environment, process listings, Git config, and filesystem for accidental token leakage.
4. **Trusted-runner path:** perform the same clone/push from a controlled runner and prove token delivery, no persistence, log redaction, and cleanup under success, timeout, retry, and crash.
5. **Token lifecycle:** mint `read` and `write` tokens with the shortest supported TTL; verify read cannot push, write can push, old token fails after revoke, and a newly minted replacement works. Measure revocation latency and behavior for in-flight requests.
6. **Credential isolation:** exercise a private GitHub source only through the proposed control-plane path (if one is designed); verify the real GitHub credential is absent from Session env/files/process args/logs/Git config/API responses and is never included in Artifacts or Sandbox inputs.

## Live proof result

The throwaway proof under `work/artifacts-git-proof/` ran against the account selected by the
existing local Scotty pointer and used public `Yeshwanthyk/scotty` at `main` as its source. The
final run passed and then verified cleanup.

It proved one Worker-bound flow end to end:

1. import the GitHub source at depth one;
2. wait for the imported repository;
3. create a separate Session-shaped Fork;
4. clone the Fork with a read token through normal Git smart HTTP;
5. reject a push made with the read token;
6. accept a push made with a write token;
7. mint a replacement write token and revoke the old token;
8. reject the first old-token push attempted 114 ms after revocation returned;
9. accept a push with the replacement token; and
10. delete both repositories, destroy the temporary Worker, and remove local Alchemy state.

The imported and forked `main` commit matched GitHub commit
`3f9c127427b18407d04157d0c1a950316c907879`. The proof supplied Artifacts credentials to Git only
through per-process authorization-header environment entries. It checked that token values did not
enter the remote URL, Git config, captured output, clone files, proof files, or Alchemy state.

This result proves the deployed public-import, Fork, Git scope, replacement, revocation, and cleanup
path. It does not prove a private GitHub import, ongoing Mirror refresh, or Scotty's future
Session-sentinel proxy. Those remain application-owned mechanisms.

## Evidence ledger
## Evidence ledger

| Claimed capability | Source result | Confidence boundary |
|---|---|---|
| GitHub → Artifacts | `Artifacts.import()` and REST `.../repos/:name/import`; official examples use public GitHub HTTPS | One-time import is proven; ongoing mirror is not |
| Per-Session fork | `repo.fork()` / REST `/fork`; exact SDK example maps Sandbox ID to repo | Session mapping/lifecycle is Scotty-owned |
| Normal clone/push | Standard Artifacts smart HTTP; `read`/`write` scopes; Sandbox example runs `git clone` and `git push` | Deployed egress and runner controls need testing |
| Narrow token mint/revoke | `createToken`, `listTokens`, `revokeToken`; REST POST/GET/DELETE routes | No atomic replace; immediate propagation needs testing |
| Real GitHub credential out of Session | Public import + Artifacts-only remote/token in exact Sandbox example | Private-source control-plane design and all leakage invariants need testing |

## Primary sources

- Repository pins: [`package.json`](../../package.json), [`worker/package.json`](../../worker/package.json), [`package-lock.json`](../../package-lock.json).
- Alchemy pinned commit: [`vendor/alchemy` at `4465e353603ab71b279a66c4fcd3ecc1488aa090`](https://github.com/alchemy-run/alchemy/tree/4465e353603ab71b279a66c4fcd3ecc1488aa090); local source [`packages/alchemy/src/Artifacts.ts`](../../vendor/alchemy/packages/alchemy/src/Artifacts.ts).
- Cloudflare Sandbox pinned package source/tests: [`@cloudflare/sandbox@0.12.3` commit](https://github.com/cloudflare/sandbox-sdk/tree/696388b24c1c59a19b484a9e8066dc431addf617), especially [`examples/git-repo-per-sandbox/src/index.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/examples/git-repo-per-sandbox/src/index.ts), [`packages/sandbox/tests/git-client.test.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox/tests/git-client.test.ts), and [`packages/sandbox-container/tests/services/git-service.test.ts`](https://github.com/cloudflare/sandbox-sdk/blob/696388b24c1c59a19b484a9e8066dc431addf617/packages/sandbox-container/tests/services/git-service.test.ts).
- Official Cloudflare docs: [Artifacts](https://developers.cloudflare.com/artifacts/), [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [Import repositories](https://developers.cloudflare.com/artifacts/guides/import-repositories/), [Get started with Workers](https://developers.cloudflare.com/artifacts/get-started/workers/), and [Sandbox Git workflows](https://developers.cloudflare.com/sandbox/guides/git-workflows/).
