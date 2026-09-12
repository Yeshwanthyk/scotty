# Cloud settings structure review

Scope: the current cloud settings path from the installation SandboxConfig Durable Object through Session admission, Pi/Codex startup, and backup resume, plus the credential status API. Reviewed against `yesh-structure-review`, Scotty's Effect skills, and pinned Effect rc.112 patterns and Schema source/tests. This is a source and local-test audit, not deployed runtime proof.

## Keep

- **One installation authority.** `worker/src/sandbox/config-store.ts` updates settings and the active resource digest in one revisioned Durable Object record. `protocol/cloud-settings.ts` decodes bounded settings and excludes reserved runtime keys. The API in `worker/src/index.ts` validates the request before the DO call. Store and route tests cover persistence, stale revisions, and invalid requests.
- **One Session pin.** `worker/src/session/object.ts` resolves the selected profile and pins settings revision, bundle digest, and environment before create admission. `worker/src/session-actor/authority.ts` and `metadata.ts` retain the pin; create reads the pinned digest, and resume uses the retained environment. `worker/test/session/session-create.test.ts` now proves defaults, bundle/environment pinning, and retry after a cloud edit; `worker/test/session/session-actor-lifecycle.test.ts` proves resume uses the old environment.
- **Credential isolation.** `worker/src/credentials/store.ts` upserts one named encrypted credential with an expected version and leaves other declarations intact. The route returns redacted status. Store and route tests cover stale updates and preservation of unrelated credentials.

## Act now

- **Fixed: optional Codex resume configuration.** `worker/src/session-actor/transitions/backup-lifecycle-sandbox.ts` passed `configuration: undefined` as a present field to `CodexSandboxIdentitySchema`. The schema rejected a legacy resume before launching the native thread. The adapter now omits that field when no pin exists. The previously failing backup lifecycle test passes; the full worker suite passes (866 passed, 1 skipped).
- **Fixed: connection status for expired OAuth.** `worker/src/credentials/store.ts` projects `configured: true` for every stored declaration and separately returns `expires`; The final `ui/src/routes/settings.tsx` renders expired OAuth separately using the returned expiry. No credential contract expansion was needed. This is a status presentation issue; the grant path retains expiry metadata.

## Defer

- **Codex checkpoint restart does not pass the pin.** `checkpointAttempt` in `worker/src/session-actor/transitions/backup-lifecycle-sandbox.ts` omits configuration, but `worker/src/session/object.ts` rejects Codex checkpoint. Reopen only if that public capability is enabled.
- **Installed-image and deployed proof.** Local tests establish source behavior and adapter calls. Reopen when a guarded deployment target exists; verify the image and actual Pi/Codex process environment, resource discovery, and resume against the live runtime.

Verification for this review: focused worker tests (82 passed), `npm run typecheck:worker`, `npm run lint:skills`, and `npm run test:worker -- --silent` (866 passed, 1 skipped). Formatting was scoped to edited worker files.
