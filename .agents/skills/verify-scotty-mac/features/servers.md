# Servers and sign-in

The app remembers Scotty servers, switches between them, and signs in to ones behind Cloudflare Access.

## Behaviors

- **S1** With no saved server the app asks for an address.
- **S2** The footer's `host` button lists saved servers and switches to one.
- **S3** A loopback server needs no sign-in.
- **S4** A server behind Access with no saved token shows the sign-in screen (`sign-in-screen`)
  instead of the list. `sign-in` opens the owner's Access login in the browser and shows
  `sign-in-waiting` with `sign-in-reopen` and `sign-in-cancel`; once the login completes the token
  goes to the Keychain and the list loads. `sign-in-cancel` returns to the screen.
- **S5** A server that isn't behind Access, or a login that fails, shows `sign-in-error` and turns
  `sign-in` into "Try again". `switch-scotty` goes back to the address screen from any sign-in state.
- **S6** A 3xx, 401 or 403 from a signed-in server drops the saved token and returns to S4.

## User entry points

- First launch; the footer `host` button; Settings › Sign out.

## Drive

- S1: launch with an empty `home/` (no `servers.json`) and expect `address-field`.
- S2: add a second entry to `servers.json` before launch; `ax press host`, then `ax press server:<url>`.
- S3: every seed run.
- S4: launch with `servers.json` holding the deployment's URL (`SCOTTY_URL` from
  `work/dev-env.sh`) and no Keychain entry: `ax wait sign-in`, `ax press sign-in`,
  `ax wait sign-in-waiting`, then `ax press sign-in-cancel` and `ax wait sign-in`. The owner finishes
  the login; then expect `row:<id>` rows.
- S5: `ax press switch-scotty`, `ax press address`, `ax type $'example.com\n'`, `ax press sign-in`,
  `ax wait sign-in-error 30`.

## Proof

Screenshots of each screen; for S4 also the browser tab's address (`/cdn-cgi/access/cli?…`).

## Gotchas

- S4's last step (login completes, list loads) is `verified-unreachable` for an agent alone:
  Cloudflare Access login needs the owner at the browser. The screen, the opened page and cancel
  are drivable. A drive leaves an Access tab open in the browser.
- Check the Keychain only for presence (`security find-generic-password -s scotty-mac -a <origin>`
  without `-w`).
- Never copy the Access token into evidence; it lives in the Keychain under `scotty-mac`.
