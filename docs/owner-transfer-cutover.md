# Owner authority production cutover

Status: implementation checklist only. No production migration, owner recovery, root-token
rotation, or deployment is authorized by this document.

This is a one-way persisted-auth migration. Once the production Auth Durable Object writes a
version-2 authority, never deploy a version-1 Worker against it.

## Before requesting production approval

- Record the candidate Git SHA and build a retained rollback artifact from that exact SHA.
- Prove the rollback artifact understands claimed, unclaimed, expired-owner, pending-transfer, and
  pending-recovery version-2 records. It must never authorize from stored scopes.
- Run the full local gate in `AGENTS.md`, including the secret scan and compiled CLI.
- Deploy the full stack to a disposable `scotty-e2e-<32 hex>` stage.
- Seed that stage with a realistic version-1 authority containing multiple admin-scoped clients.
- Prove this exact sequence on the disposable stage:
  `migrate → recover A → reject all V1 cookies → pair B → transfer A to B → reject A and B's old
cookie → recover C → reject B and every pending grant → prove PTY lease cleanup`.
- Destroy the stage and prove there are no Worker, Container, KV, R2, Durable Object, schedule,
  lease, or credential orphans.
- Run a second Alchemy plan and retain its no-op result.
- Put a protected copy of `SCOTTY_TOKEN` somewhere independent of the current laptop and browser
  profile. Treat it as the only break-glass path.

## Approved cutover sequence

Run these only after explicit production approval:

1. Confirm the protected root-token copy works and the updated CLI is installed on the intended
   owner laptop.
2. Run the guarded production deploy with `npm run deploy:production`.
3. Do not open any historical `?t=` links. They must now fail.
4. On the intended primary laptop, recover the named installation through the approved Cloudflare
   profile, then recover browser ownership:

   ```sh
   scotty recover --name <installation-name>
   scotty owner recover
   ```

5. Confirm the recovery page says it will revoke all browser access, then explicitly accept.
6. Verify `/devices` shows exactly one server-derived `Primary` badge and a separate `This device`
   badge on that browser.
7. Pair each trusted standard device from `/devices`. Never share the root token with a browser.
8. Test a target-bound transfer to one disposable standard device and back, proving each old cookie
   fails immediately.
9. Rotate `SCOTTY_TOKEN` through the approved secret-management path because old query URLs may
   remain in history or logs. Update the protected recovery copy.
10. Verify CLI session operations, pairing, transfer, recovery issuance, one-use PTY tickets,
    snapshot, resume, and backup access.

## Abort and rollback

- Before the first version-2 write, aborting the deploy may use the prior artifact.
- After any version-2 write, roll back only to the retained version-2-aware artifact.
- If the owner browser is lost, expired, or unusable, do not promote another client implicitly.
  Run `scotty owner recover`; it revokes all browser credentials but leaves sessions, containers,
  backups, worktrees, and Codex credentials intact.
- Never repair authority by editing scopes, selecting the newest client, copying a cookie, or
  changing the owner ID outside the Auth Durable Object transition.
- If the protected root token is also lost, stop. There is no browser-side or external-identity
  bypass in v1; restore the root secret through the separately approved Cloudflare operator path.
