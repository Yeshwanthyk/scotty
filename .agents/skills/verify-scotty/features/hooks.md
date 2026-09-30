# Hooks

A signed webhook creates a session, or steers the one that already uses its key. Every delivery
is recorded, accepted or not.

## Behaviours

- **K1** `connect webhook <name>` prints a `whsec_` secret once and the hook URL; `connections`
  lists the connection without the secret.
- **K2** Two signed deliveries to `/hooks/<name>` with one `key` give one session with two turns;
  the session's origin names the connection.
- **K3** A bad signature (or a timestamp older than 5 minutes) is answered 401 and `deliveries`
  lists it as rejected with the reason.
- **K4** The same key with a different repo or agent is 409.
- **K5** The UI (Settings, Connections) lists the connection and its deliveries, each linked to
  its session.

## Entry points

- CLI `scotty connect | connections | deliveries | rm connection | create --session-key`. e2e:
  `npm run --silent e2e -- hooks`.

## Drive

1. `connect webhook demo --json` into `01-connect.json`; keep the secret (K1). `connections`
   does not show it.
2. Sign a body `{repo, prompt, key}` with Standard Webhooks (HMAC-SHA256 of
   `<id>.<timestamp>.<body>`, key is the base64 after `whsec_`) and POST it to the URL twice with
   new ids (K2); `ls` shows one session, `read <id>` two turns.
3. POST with a wrong signature: 401; `deliveries --connection demo` lists it rejected (K3).
4. POST the same key with another repo: 409 (K4).
5. Open Settings, Connections in the UI (K5). `rm connection demo` to clean up.

## Gotchas

- What broke: `scotty deliveries` gives the reason for a rejection; `scotty log <id>` the session.
- `/hooks/*` is the only path outside Cloudflare Access; a 302 to a login means the bypass app
  was not made, so redeploy.
- A hit on an unknown connection name is 404 and not recorded.
