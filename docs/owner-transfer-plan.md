# Scotty single-owner registration and transfer plan

Status: implementation approved 2026-07-24. Production migration and recovery remain separate
operator-approved gates.

This packet replaces Scotty's browser-side multi-admin model with the settled token-registration
model:

- Browser registration uses opaque, independently revocable client credentials.
- Exactly one registered browser is the owner after initialization.
- Only the owner can register, list, revoke, or promote devices.
- Moving ownership to an accessible registered device requires explicit owner transfer and target
  acceptance.
- Losing the owner device requires a short-lived recovery grant issued with `SCOTTY_TOKEN`.
- Passkeys, user accounts, email recovery, and external identity providers are out of scope.

The live infrastructure, session, credential-isolation, ownership, and lifecycle contracts are in
[`AGENTS.md`](../AGENTS.md).

## 1. Current baseline and retained behavior

The audited baseline is `366f8a4` on `main`.

Keep these existing properties:

- The singleton Auth Durable Object named `account` owns browser registrations, pairing grants,
  revocation, and terminal tickets.
- Auth Durable Object storage persists credential digests only. Raw browser credentials and grant
  tokens exist only at issuance and presentation boundaries.
- Ordinary pairing grants are random, five-minute, single-use fragment tokens.
- A paired browser receives its own 30-day `__Host-scotty` credential in a `Secure`, `HttpOnly`,
  `SameSite=Strict`, path-root cookie.
- Terminal connections require a five-minute, one-use ticket bound to the registered browser and
  Scotty session.
- Revoked browsers fail authenticated HTTP immediately. Their terminal heartbeat fails, and the
  Sandbox Durable Object kills the isolated PTY process when the 45-second attachment lease
  expires.
- `SCOTTY_TOKEN` remains the CLI and break-glass root credential. It continues to authorize
  operational session API calls through `Authorization: Bearer`.

Replace these current properties:

- Stored `access:read` and `access:write` scopes are not ownership.
- `registerBootstrapClient` must not mint additional administrators.
- The root token must not be accepted from a browser cookie or `?t=` query parameter.
- Worker-side scope checks must not authorize a later, unauthenticated Auth Durable Object
  mutation.
- Owner logout, owner expiry, and v1 migration must not silently leave an ambiguous successor.
- The fake Worker, CLI browser launcher, route tests, and deployed canary must stop treating the
  root token as a browser credential.

## 2. Trust model and security boundary

The trusted computing base is:

- The deployed Worker and singleton Auth Durable Object code.
- Cloudflare's Worker secret binding containing `SCOTTY_TOKEN`.
- Auth Durable Object transactional storage.
- The current owner browser profile while its client credential remains secret.
- The operator's protected copy of `SCOTTY_TOKEN`, normally stored in mode-`0600`
  `~/.scotty.json` and backed up outside the laptop.

The token model cannot distinguish the operator from malware holding the same bearer credential.
Possession is authority:

- A stolen owner cookie can act as the owner until transfer, recovery, revocation, or expiry.
- A stolen `SCOTTY_TOKEN` is root and can perform break-glass recovery.
- If both the owner credential and every protected copy of `SCOTTY_TOKEN` are lost, recovery is
  intentionally impossible.

The implementation must prevent a standard client, stale owner request, intercepted transfer for a
different target, replayed grant, or concurrent transition from becoming owner.

## 3. Domain language

Use these terms consistently in code, API responses, UI, tests, and documentation:

- **Root credential:** deploy-time `SCOTTY_TOKEN`; CLI bearer and break-glass authority, never a
  browser session.
- **Client:** one registered browser with one opaque credential.
- **Standard client:** a client allowed to read/write sessions and connect terminals, but not
  manage device authority.
- **Owner:** the one claimed client whose ID is stored in authoritative ownership state.
- **Pairing grant:** a one-use capability that creates a standard client.
- **Owner transfer:** a target-bound, two-party transition from the current owner to an existing
  standard client.
- **Recovery grant:** a root-issued, one-use capability that creates a replacement owner when the
  old owner is unavailable.
- **Ownership epoch:** a monotonically increasing integer invalidating grants issued under older
  ownership.

Do not use "admin," "primary token," "main browser," or stored access scopes as domain authority.
The UI may describe the owner as the "Primary device."

## 4. Authoritative state

The Auth Durable Object remains the only authority. KV, browser UI state, CLI output, Worker
memory, and terminal attachment records must not decide ownership.

The version-2 stored shape is conceptually:

```ts
type OwnershipState =
  | {
      readonly state: "unclaimed";
      readonly epoch: number;
    }
  | {
      readonly state: "claimed";
      readonly ownerClientId: string;
      readonly epoch: number;
    };

interface AuthClientRecordV2 {
  readonly id: string;
  readonly credentialDigest: string;
  readonly label: string;
  readonly scopes: ReadonlyArray<StandardAuthScope>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly userAgent?: string;
  readonly revokedAt?: string;
}

interface OwnerTransferRecord {
  readonly id: string;
  readonly credentialDigest: string;
  readonly sourceOwnerClientId: string;
  readonly targetClientId: string;
  readonly ownerEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface RecoveryGrantRecord {
  readonly id: string;
  readonly credentialDigest: string;
  readonly ownerEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface AuthAuthorityV2 {
  readonly version: 2;
  readonly ownership: OwnershipState;
  readonly clients: ReadonlyArray<AuthClientRecordV2>;
  readonly pairings: ReadonlyArray<PairingGrantRecordV2>;
  readonly ownerTransfer?: OwnerTransferRecord;
  readonly recoveryGrant?: RecoveryGrantRecord;
  readonly terminalTickets: ReadonlyArray<TerminalTicketRecord>;
}
```

The exact Effect Schema syntax must be verified against pinned Effect beta.99 before coding.
Schema owns the derived TypeScript types.

Stored client scopes must be exactly the standard set:

```text
sessions:read
sessions:write
terminal:connect
```

`access:read` and `access:write` may remain in public client views for compatibility, but only as
derived values when `client.id === ownership.ownerClientId`. They must never be persisted in v2 or
accepted as authorization for an Auth Durable Object command.

## 5. Invariants

The Auth Durable Object validates these invariants whenever it decodes or writes authority:

1. Ownership is either unclaimed or references exactly one existing, non-revoked client.
2. Ownership epoch is a non-negative safe integer and increases on every successful transfer or
   recovery.
3. Every stored v2 client has exactly the standard scope set; no stored client carries owner
   authority.
4. At most one unexpired owner transfer and one unexpired recovery grant exist.
5. A pending transfer references the current owner, current epoch, and an existing active
   non-owner target.
6. Pairing, transfer, recovery, client, and terminal-ticket IDs are unique within their record
   classes.
7. Only digests are stored for client and grant secrets.
8. Expired grants and tickets cannot be consumed at the exact expiry boundary.
9. The current owner record is retained if its credential expires; it cannot authenticate, and
   only root recovery can replace it.
10. No operation except transfer acceptance or recovery consumption changes the claimed owner.

An invalid stored authority fails closed as `invalid_authority`. Code must not repair ambiguity by
selecting a client.

## 6. Credential lifecycle

Standard client credentials retain the current fixed 30-day lifetime.

The owner credential uses a sliding 30-day lifetime:

- Successful owner authentication inside the final seven days extends `expiresAt` to 30 days from
  the current Effect `Clock`.
- The Worker refreshes the same hardened cookie after the Auth Durable Object reports an extension.
- Sliding renewal keeps the same secret to avoid multi-tab rotation races.
- Owner transfer and recovery always rotate or create a fresh secret because privilege changes
  require session rotation.
- An owner unused for 30 days becomes unable to authenticate. Its record remains claimed so no
  standard client can inherit ownership; `scotty owner recover` is required.

Purging removes expired standard clients, pairings, transfers, recovery grants, and tickets. It
does not delete the claimed owner record. Purging a transfer target also clears that transfer.

## 7. Auth Durable Object command boundary

Every owner command receives the caller's raw client credential and performs authentication,
ownership validation, and mutation inside one storage transaction.

The registry interface becomes conceptually:

```text
authenticate(clientCredential)

issuePairing(ownerCredential, pairingCandidate)
consumePairing(pairingCredential, clientCandidate)

listClients(ownerCredential)
revokeClient(ownerCredential, targetClientId)

startOwnerTransfer(ownerCredential, targetClientId, transferCandidate)
cancelOwnerTransfer(ownerCredential, transferId)
acceptOwnerTransfer(targetCredential, transferCredential, replacementSecret)

issueRecoveryGrant(rootCredential, recoveryCandidate)
consumeRecoveryGrant(recoveryCredential, ownerClientCandidate)

issueTerminalTicket(clientCredential, sessionId, ticketCandidate)
consumeTerminalTicket(ticketCredential, sessionId)
```

The Worker must not authorize an owner command by passing a client ID, scope list, `isOwner`
boolean, or previously authenticated client view. Those are staleable observations.

`SCOTTY_TOKEN` is stable outside Auth Durable Object state, so it has no ownership race. The Worker
validates the bearer form, and the Auth Durable Object RPC boundary independently compares the
presented root credential against its Worker secret binding before issuing a recovery grant. The
root value is never persisted or returned.

## 8. Transition contracts

### 8.1 Register a standard client

Trigger: the owner creates a pairing and the target browser consumes it.

Owner command:

- Authenticate the presented client credential.
- Require that client to be the current owner.
- Require no capacity violation.
- Persist a five-minute pairing digest with no caller-supplied scopes.
- Return the raw pairing credential once.

Consume command:

- Parse and hash the pairing credential.
- Require an unexpired digest match.
- Create a standard 30-day client.
- Remove the pairing in the same transaction.
- Return the new client credential once.

Concurrent consumption has exactly one winner.

### 8.2 Start an owner transfer

Trigger: the current owner chooses "Make primary" for an existing standard client.

Preconditions:

- The actor credential authenticates as the current owner.
- The target exists, is active, is not the owner, and is not expired.
- No unexpired transfer is already pending. The owner must cancel it or wait for expiry.

Write:

- Generate a 256-bit random transfer secret.
- Persist only its digest.
- Bind the transfer to source owner ID, exact target client ID, and current epoch.
- Set a five-minute expiry.

Publication:

- Return `/owner-transfer#token=...` once with `Cache-Control: no-store`.
- The Devices page may render the existing QR representation and copy action.
- Client-list and transfer-status reads expose metadata only, never the secret or digest.

### 8.3 Accept an owner transfer

Trigger: the exact target browser explicitly accepts the fragment link.

Preconditions checked in one transaction:

- The target client credential is valid and belongs to `targetClientId`.
- Transfer secret digest matches and is unexpired.
- Current owner equals `sourceOwnerClientId`.
- Current epoch equals `ownerEpoch`.
- Source and target records are still valid.

Write:

- Replace the target credential digest with a digest for a newly generated secret.
- Reset target expiry to 30 days.
- Set the target as owner.
- Increment ownership epoch.
- Revoke the old owner.
- Remove every pending pairing, transfer, and terminal ticket belonging to the old or target
  credential.

Publication:

- Return the rotated owner credential once.
- Replace the target's browser cookie in the same HTTP response.
- The old owner fails every later owner and client authentication.

Opening the link on the wrong browser must return the same generic invalid-transfer response as an
invalid or expired token. It must not disclose the expected target.

### 8.4 Cancel an owner transfer

Trigger: the current owner cancels the pending transfer.

The Auth Durable Object authenticates the owner credential, matches the transfer ID, removes the
record, and returns success. Cancellation racing acceptance has one serialized winner.

### 8.5 Revoke a standard client

Trigger: the owner confirms revocation.

The Auth Durable Object authenticates the owner credential and rejects attempts to revoke the
current owner. It revokes the target, clears its terminal tickets, and clears a transfer targeting
it.

Owner self-revocation and owner logout return a conflict instructing the user to transfer ownership
or use recovery. Standard-client logout retains the current behavior.

### 8.6 Recover ownership

Trigger: the operator has no usable owner browser and runs `scotty owner recover`.

Issue:

- Accept only `Authorization: Bearer SCOTTY_TOKEN`.
- Reject root cookies and root query parameters.
- Generate a 256-bit, five-minute recovery credential.
- Persist only its digest, expiry, and current epoch.
- Replace any older recovery grant.
- Return `/recover#token=...` once to the CLI.

Consume:

- Require exact same-origin browser submission.
- Require an unexpired digest and epoch match.
- Revoke every existing client.
- Clear every pairing, transfer, recovery grant, and terminal ticket.
- Create a new client with a fresh credential.
- Claim that client as owner and increment the epoch.
- Return the owner credential once in the hardened cookie.

Recovery is intentionally a destructive access reset. Existing session records, backups,
containers, worktrees, and Codex credentials are unaffected.

## 9. Concurrency, replay, and ordering

Auth Durable Object storage transactions provide the serialization boundary.

Required order behavior:

- Pairing consume versus pairing consume: one creates the client; the other sees no grant.
- Transfer accept versus transfer accept: one changes owner and epoch; the other sees no transfer
  or a stale epoch.
- Transfer accept versus recovery consume: recovery wins if second and resets all clients;
  transfer fails if second because recovery cleared it and changed the epoch.
- Pair issue versus transfer accept: if pairing wins first, acceptance clears it; if transfer wins
  first, the old owner credential fails.
- Owner mutation already admitted by Worker versus transfer: the Auth Durable Object rechecks the
  credential and owner in its transaction, so a stale request fails.
- Revoke target versus transfer acceptance: if revoke wins, acceptance has no active target; if
  acceptance wins, the old owner's revoke credential is invalid.
- Ownership cycling back to an earlier client cannot revive an older grant because its epoch is
  stale.

Retries of non-idempotent grant issuance may create a new grant only after the caller knows the
previous request failed before acceptance. HTTP routes should support an idempotency key for
owner-transfer and recovery-grant issuance, or return outcome-unknown on a lost response rather
than silently issuing multiple capabilities.

## 10. HTTP boundary

Keep existing routes unless explicitly replaced below.

Add:

```text
POST   /api/auth/owner-transfers
GET    /api/auth/owner-transfers/current
DELETE /api/auth/owner-transfers/:id
POST   /api/auth/owner-transfers/accept

POST   /api/auth/recovery-grants
POST   /api/auth/recovery-grants/consume

GET    /owner-transfer
GET    /recover
```

Change:

- `POST /api/auth/pairings`, `GET /api/auth/clients`, and
  `DELETE /api/auth/clients/:id` pass the client credential into owner-authorized Auth Durable
  Object commands.
- `GET /api/auth/me` and client-list views add `role: "owner" | "standard"`. Existing `scopes`
  remain, with access scopes derived for the owner only.
- `POST /api/auth/logout` rejects the current owner and continues to revoke standard clients.
- `/devices` requires a claimed owner client. Root bearer is not a browser owner.
- `/sessions` and `/s/:id` accept registered client cookies only.
- PTY WebSocket upgrade accepts a one-use terminal ticket only.

Remove:

- `registerRootBrowser`.
- `registeredRootBrowserRedirect`.
- Root-token comparison against `__Host-scotty`.
- `allowRootQuery`.
- `?t=SCOTTY_TOKEN` on pages and PTY routes.

Every unsafe cookie-authenticated method requires:

- Exact `Origin` equality with the Scotty origin.
- `Sec-Fetch-Site: same-origin` when the browser supplies Fetch Metadata.
- Expected JSON `Content-Type` for JSON bodies.
- No-store responses.

Root bearer CLI calls do not require `Origin`. Public pairing and recovery consumption still
require exact same-origin submission.

Auth token failures remain generic. No error distinguishes unknown ID, wrong secret, wrong target,
expired grant, or already-consumed grant.

## 11. Browser flows and CSP

### Devices

`/devices` shows:

- One "Primary" badge derived from the server's owner view.
- A separate "This device" badge for the current cookie.
- "Make primary" on active standard devices.
- "Revoke" on standard devices.
- Pending-transfer target, expiry, copy/QR actions, and cancellation.

The UI never infers authority from label, user agent, list order, last-seen time, or local state.

### Transfer

`/owner-transfer`:

- Reads the token from the fragment.
- Calls `history.replaceState` before any network operation.
- Requires an explicit user click; link scanners and prefetchers must not transfer ownership.
- Submits with the target's existing client cookie.
- Replaces that cookie with the rotated owner credential.
- Shows a generic invalid/expired/wrong-device error.

### Recovery

`/recover`:

- Reads and removes the fragment before network activity.
- Explains that all existing browser access will be revoked.
- Requires explicit confirmation.
- Creates the fresh owner cookie and redirects to `/sessions`.

### Critical-page policy

Move executable inline scripts for `/devices`, `/pair`, `/owner-transfer`, and `/recover` into
static JavaScript assets. Serve these pages with:

```text
default-src 'none'
script-src 'self'
style-src 'self' 'unsafe-inline'
connect-src 'self'
img-src 'self' data:
base-uri 'none'
frame-ancestors 'none'
form-action 'none'
```

Keep `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
and `X-Frame-Options: DENY`. The terminal may retain its separate WebSocket/WASM policy.

## 12. CLI contract

Add:

```text
scotty owner recover [--json]
```

Behavior:

- Resolve host and root token through the existing flag, environment, and `~/.scotty.json`
  precedence.
- POST to `/api/auth/recovery-grants` with bearer auth.
- Validate the same-origin recovery URL and expiry with Effect Schema.
- Open the URL through `BrowserLauncher`.
- Never print the tokenized URL or recovery credential.
- Human output reports that recovery opened and its expiry.
- JSON output includes only `{ "opened": true, "expiresAt": "..." }`.

Change `browserUrl` so `scotty beam up` and `scotty attach` open clean `/s/:id` URLs without receiving or
injecting the root token. Their existing safe JSON output remains unchanged.

On a replacement laptop the operator flow is:

```text
scotty recover --name <installation-name>
scotty owner recover
```

The operator recovers installation access through the approved Cloudflare profile. The CLI rotates
`SCOTTY_TOKEN`, stores it in the local mode-0600 config, and does not provide it to the browser.

## 13. Version-1 migration

Decode persisted authority as `AuthAuthorityV1 | AuthAuthorityV2`.

The migration from v1:

- Preserves valid unexpired clients as standard clients long enough for session access.
- Removes stored access scopes.
- Sets ownership to unclaimed with epoch zero.
- Clears legacy pairing and terminal tickets rather than carrying capabilities across the security
  boundary.
- Never selects an owner from existing admin scopes, current cookie, list order, label, user agent,
  creation time, or last-seen time.
- Writes v2 transactionally on the first successful v2-aware operation.

After deployment, existing browsers may continue standard session access, but device management is
unavailable until root recovery claims an owner. Recovery then revokes all legacy clients,
including the browser consuming the recovery link, before creating its fresh owner credential.

The migration is one-way. Once any authority record is written as v2, the old v1 Worker must not be
deployed against that Auth Durable Object.

Before production:

- Produce and retain a v2-aware rollback artifact.
- Rehearse migration from a seeded v1 authority containing multiple admin clients.
- Prove the rollback artifact reads claimed, unclaimed, expired-owner, and pending-grant v2 states
  without reverting to stored-scope authorization.
- Add an operator-visible cutover checklist and record the deployed version.

## 14. Production cutover

Use the disposable Alchemy full-stack canary first.

Cutover sequence:

1. Deploy the complete dual-decoder implementation to a disposable stage seeded with a realistic
   v1 multi-admin authority.
2. Prove recovery creates one owner, old cookies fail, a standard client can be paired, ownership
   can transfer, and stale credentials cannot perform owner commands.
3. Prove terminal heartbeats fail after recovery and isolated PTY processes are killed within the
   45-second lease bound.
4. Prepare the v2-aware rollback artifact, production command transcript, and protected
   `SCOTTY_TOKEN` copy.
5. Deploy production, immediately run `scotty owner recover` on the intended owner browser,
   re-pair trusted devices, then rotate `SCOTTY_TOKEN` because older query URLs may exist in
   history or logs.

Do not run destructive recovery tests against a shared or production host. The current
`deployed-routes` test must become disposable-only or use a non-mutating pre-provisioned client
credential.

## 15. Implementation waves

### Wave 0 — approve contracts

Files:

- `docs/owner-transfer-plan.md`
- `AGENTS.md`

Work:

- Approve this packet.
- Replace the binding multi-admin/root-query language.
- Record the explicit public HTTP, CLI, and persisted-auth contract changes.
- Record the one-way migration and v2-aware rollback rule.

Gate: documentation describes one model with no passkey or root-query ambiguity.

### Wave 1 — Auth Durable Object state engine

Files:

- `worker/src/auth-registry.ts`
- `worker/src/auth-object.ts`
- `worker/test/auth-registry.test.ts`
- new `worker/test/auth-ownership-machine.test.ts`

Work:

- Add v1/v2 Schema decoding and v2 validation.
- Add derived owner views, sliding owner renewal, transfer, recovery, and actor-authenticated owner
  commands.
- Keep randomness and Promise conversion in the existing Durable Object host island.
- Use Effect `Clock`, typed `AuthRegistryFailure`, digest-only persistence, and the existing
  transaction abstraction.

Gate: deterministic domain, concurrency, replay, expiry, malformed-storage, and migration tests
pass before routes change.

### Wave 2 — Worker HTTP boundary

Files:

- `worker/src/auth.ts`
- `worker/src/index.ts`
- `worker/test/routes.test.ts`
- `worker/test/contracts.test.ts`

Work:

- Add owner-transfer and recovery routes.
- Remove browser root token paths.
- Pass actor credentials to Auth Durable Object commands.
- Add cookie-mutation same-origin policy and error mappings.
- Refresh extended owner cookies.

Gate: route tests prove no root query/cookie path, no split owner authorization, correct cookie
rotation, and generic grant failures.

### Wave 3 — browser and CLI flows

Files:

- `worker/public/devices.html`
- `worker/public/pair.html`
- new static JS and owner-transfer/recovery pages
- `cli/src/commands.ts`
- `cli/src/pure.ts`
- `cli/src/schemas.ts`
- CLI tests

Work:

- Implement owner display, transfer, cancellation, target acceptance, and recovery confirmation.
- Externalize critical inline scripts and apply the strict auth-page CSP.
- Add `scotty owner recover`.
- Open clean session URLs and keep all credential-bearing URLs out of stdout and JSON.

Gate: browser helpers remove fragments before fetch; CLI tests prove recovery URL secrecy and clean
attach/up URLs.

### Wave 4 — fake, deployed proof, and cutover

Files:

- `e2e/support/fake-worker.mjs`
- `e2e/tests/protocol-security.test.mjs`
- `e2e/tests/deployed-routes.test.mjs`
- `e2e/tests/deployed.test.mjs`
- `e2e/README.md`
- deployment/operator documentation

Work:

- Replace fake root-cookie shortcuts with the owner/recovery protocol.
- Make all destructive auth proof disposable-stage-only.
- Seed v1 multi-admin state and exercise migration, recovery, pairing, transfer, stale-cookie
  rejection, and terminal cleanup.
- Perform the production cutover only after the disposable gate and explicit operator approval.

Gate: full local suite, secret scan, compiled CLI, disposable deployed canary, and no-op Alchemy
plan pass.

## 16. Proof strategy

### Domain tests

Use `@effect/vitest`, `it.effect`, `assert`, `TestClock`, and the existing serialized in-memory
authority storage.

Cover:

- V1 migration, clean initialization, claimed validation, and malformed persistence.
- Owner renewal and expired-owner recovery without implicit succession.
- One-use pairing, transfer, recovery, and terminal tickets at exact expiry boundaries.
- Target substitution, stale epochs, owner cycling, credential rotation, and replay.
- Every concurrent transition pair listed in section 9.

### Structured machine test

Quint is not currently installed. Add a small deterministic TypeScript state-machine test that
enumerates reachable ownership states and transition sequences. It must assert:

- At most one claimed owner.
- The claimed owner references a valid retained client.
- Only transfer acceptance and recovery consumption change owner.
- An owner change through transfer always selects the bound target.
- Epoch never decreases.
- No stale owner operation succeeds after transfer or recovery.

Keep mutation counterexamples in the test description:

- Removing target binding lets another client redeem the transfer.
- Removing the epoch guard revives a stale transfer after ownership cycles.
- Separating authorization from mutation lets a revoked owner commit a queued command.

If Quint becomes available, encode the same minimal machine in `.qnt` and run parse, typecheck, and
bounded invariant exploration.

### Boundary tests

Prove:

- Root bearer remains valid for CLI session operations and recovery issuance.
- Root cookie and `?t=` fail everywhere.
- Cookie mutations fail without same-origin headers.
- Standard clients receive `401` for every owner route.
- Transfer/recovery fragments never reach request URLs, responses, logs, history, JSON output, or
  error messages.
- Public client views show exactly one derived owner.

### Deployed proof

The disposable canary must execute:

```text
seed v1 multi-admin authority
→ deploy v2
→ recover owner A
→ reject every v1 cookie
→ pair standard B
→ transfer A to B
→ reject A
→ issue and consume root recovery for C
→ reject B and every pending grant
→ prove PTY cleanup
→ destroy stage with zero orphans
```

## 17. Required verification

Run formatting before lint:

```sh
npm run fmt
npm run lint:skills
npm run lint
npm run typecheck
npm run test:all
node e2e/scripts/scan.mjs
bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli
```

Before production, additionally run the disposable deployed workflow from `e2e/README.md`, inspect
the immediate Alchemy plan for no unexpected changes, and destroy the disposable stage.

## 18. Definition of done

This work is complete only when:

- Persisted v2 authority can represent no more than one owner and validates that invariant.
- Only an Auth Durable Object transaction authenticated with the current owner credential can
  issue pairings, list/revoke clients, or start/cancel transfer.
- Transfer requires the bound target's credential, rotates it, revokes the old owner, and defeats
  replay and stale epochs.
- Root recovery uses bearer `SCOTTY_TOKEN`, never exposes it to the browser, and resets all browser
  authority.
- Moving to a new laptop works through standard pairing plus transfer when the old owner is
  available, or `scotty owner recover` when it is not.
- Existing session, backup, credential-isolation, terminal framing, CLI JSON, and lifecycle
  contracts remain intact except for the explicitly approved auth changes.
- V1 migration and the v2-aware rollback path have deployed disposable evidence.
- Binding docs, UI copy, fake protocol, tests, and operator instructions describe the same model.

## 19. Stage gate

Implementation was approved on 2026-07-24. Wave 0 binding-document edits and Waves 1–4 local and
disposable-stage work are authorized.

Production migration, destructive recovery against production, root-token rotation, and production
deployment remain separate operator-approved gates after local and disposable proof.
