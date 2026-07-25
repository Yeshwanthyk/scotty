# T3 Code device trust and recovery

Researched 2026-07-24 against the installed T3 Code Nightly app and current
`pingdotgg/t3code` source.

## Conclusion

T3 Code has two related but distinct trust models.

The direct environment server does not designate a primary browser or primary
laptop. The machine that launches and controls the server is the recovery
authority. Its desktop shell or CLI gets a privileged bootstrap credential and
exchanges that credential for an administrator session. A normal pairing link
can only create an operational client session, so a paired phone or browser
cannot mint more devices or revoke administrators.

T3 Connect adds a durable human identity above individual devices. Clerk owns
the signed-in user identity and desktop passkeys. A client generates a DPoP key,
then exchanges its Clerk credential for an access token bound to that key. This
makes a stolen token insufficient without the corresponding device key and lets
the relay manage registered devices for an account.

For Scotty, the useful pattern is therefore not "pick a primary laptop." It is:

1. Keep ordinary browser and phone registrations scoped and independently
   revocable.
2. Put device-management authority behind a durable owner identity that is not
   stored only on one laptop.
3. Require an owner assertion or step-up to create another administrator.
4. Keep the deploy-time root credential as an offline, CLI-only break-glass
   path.
5. Consider proof-bound credentials for native clients, but keep browser
   credentials in Secure HttpOnly cookies.

For a single-user Scotty deployment, WebAuthn credentials stored by the Auth
Durable Object can provide the durable owner layer without adopting Clerk. The
owner should register at least two authenticators: a synced platform passkey
and a separate hardware security key or another trusted-device passkey.

## Evidence

The installed app at `/Applications/T3 Code (Nightly).app` reports version
`0.0.29-nightly.20260724.893` and commit `ece05087a70e`. Its packaged server and
desktop source maps contain the same environment-auth and desktop-bootstrap
components described below.

Current upstream was inspected at commit
`38cfc25e5422e468303f2010f639cf3de9ad89ba`.

- [Remote access](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/docs/user/remote-access.md)
  recommends a trusted private network, exchanges one-time owner pairing tokens
  for per-device sessions, and uses host-side `t3 auth` for issuance and
  revocation.
- [Environment authentication](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/docs/cloud/environment-auth.md)
  grants ordinary pairs only operational scopes. Desktop and CLI administrative
  bootstraps additionally receive `access:read`, `access:write`, and
  `relay:write`.
- [Desktop local environment auth](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts)
  reads the desktop bootstrap credential from the desktop-managed backend,
  exchanges it for a bearer session, and keeps that session in the desktop
  backend process.
- [T3 Connect Clerk setup](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/docs/cloud/t3-connect-clerk.md)
  defines one Clerk identity across web, desktop, and mobile, encrypted Electron
  token persistence, and native desktop passkeys.
- [Relay contracts](https://github.com/pingdotgg/t3code/blob/38cfc25e5422e468303f2010f639cf3de9ad89ba/packages/contracts/src/relay.ts)
  exchange a Clerk token for a DPoP access token bound to the client's proof
  key and expose account-scoped device registration and revocation.

## Recovery implication

Direct T3 Code recovers through control of the environment host: reopen the
desktop shell, use the CLI locally or over SSH, and issue or revoke access from
there. It does not provide a separate passkey-based owner recovery plane for a
self-hosted environment.

T3 Connect recovers through the Clerk account and its configured sign-in and
passkey recovery paths. Replacing a laptop does not transfer authority from an
old "primary" device; the owner signs in on the new machine, registers its
device key, and revokes the old device.
