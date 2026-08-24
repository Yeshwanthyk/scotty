# Owner authority production cutover

Status: implementation checklist only. No production migration, owner recovery, root-identity
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
  `migrate → recover A → reject legacy browser credentials → client pair B → client status B →
transfer A to B → reject A and B's old client credentials → recover C → reject B and every pending
grant → prove PTY lease cleanup`.
- Destroy the stage and prove there are no Worker, Container, KV, R2, Durable Object, schedule,
  lease, or credential orphans.
- Run a second Alchemy plan and retain its no-op result.
- Keep the protected root identity in the OS credential store or the canonical private XDG fallback
  `${XDG_STATE_HOME:-~/.local/state}/scotty/credentials/root` (mode `0600`), independent of the
  current laptop and browser profile. Treat it as the only break-glass path.

## Approved cutover sequence

Run these only after explicit production approval:

1. Confirm the protected root identity works and the updated CLI is installed on the intended
   owner laptop.
2. Run the guarded production deploy with `npm run deploy:production`. It must prove the Container
   is a no-op. If this cutover intentionally creates or changes the Container, review the plan and
   rerun it once with `npm run deploy:production -- --container`.
3. Do not open legacy root-bearer browser handoffs. Browser routes must accept client authority only.
4. On the intended primary laptop, recover the named installation through the approved Cloudflare
   profile, then recover browser ownership:

   ```sh
   scotty recover --name <installation-name>
   scotty owner recover
   ```

5. Confirm the recovery page says it will revoke all browser access, then explicitly accept.
6. Verify `/devices` shows exactly one server-derived `Primary` badge and a separate `This device`
   badge on that browser.
7. From `/devices`, create a one-use pairing value for each trusted standard device. In each
   terminal run `scotty client pair <origin>`, then `scotty client status --json`. Never share the
   root identity, browser credential, or secret-bearing URL with a browser or terminal.
8. Test a target-bound transfer to one disposable standard device and back, proving each old client
   credential fails immediately.
9. Verify every new terminal has the canonical local client identity and do not copy or publish a
   browser credential or secret-bearing URL. Use `scotty client unpair --json` to remove a standard
   client when needed. Rotate the protected root identity only through the approved secret-management
   path if exposure is suspected.
10. Verify CLI session operations, `client pair`, `client status`, transfer, `client unpair` for a
    standard client, recovery issuance, one-use PTY tickets, snapshot, resume, and backup access.

## Abort and rollback

- Before the first version-2 write, aborting the deploy may use the prior artifact.
- After any version-2 write, roll back only to the retained version-2-aware artifact.
- If the owner browser is lost, expired, or unusable, do not promote another client implicitly.
  Run `scotty owner recover`; it revokes all browser credentials but leaves sessions, containers,
  backups, worktrees, and Codex credentials intact.
- Never repair authority by editing scopes, selecting the newest client, copying a browser credential,
  changing the owner ID outside the Auth Durable Object transition.
- If the protected root identity is also lost, stop. There is no browser-side or external-identity
  bypass in v1; restore the root identity through the separately approved Cloudflare operator path.
