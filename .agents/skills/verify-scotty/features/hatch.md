# Hatch: previews and the dev environment

A dev server in a session opens at `https://<port>-<id>.<base>` behind Access. The agent sets the
repository up through `.agents/setup` and brings it back after a resume.

## Behaviours

- **H1** `hatch <id> <port>` prints the preview URL for a running session; the page is served with
  Host `localhost:<port>`, WebSockets work, and an anonymous request gets Access's 302.
- **H2** An unknown port is 404, an unknown session 502, and a stopped session 502 with
  `hatch` answering `not_running`.
- **H3** On `$SCOTTY_HATCH_TEST_REPO` (no `.agents/setup`), "Set up this repo's dev environment,
  start the dev server, and reply with only its URL." gives a preview URL that serves Vite, and
  leaves `.agents/setup` that ends by printing `Ready: <URL>`.
- **H4** After `stop`, "Bring the dev server back up and reply with only its URL." serves again.

## Entry points

- CLI `scotty hatch | new | steer | stop`, `curl` with the Access header (never saved). e2e:
  `npm run --silent e2e -- hatch` (H1, H2) and `hatch-env` (H3, H4).

## Drive

1. Create a session on `$SCOTTY_HATCH_TEST_REPO` with the H3 prompt; read until completed; `curl`
   the URL from the reply and record the status and whether the body has `/@vite/client` (H3).
2. `hatch <id> 5173` matches the URL; the same `curl` without the header gets 302 (H1).
3. `hatch <id> 7000` → 404 page; a made-up session ID in the host → 502 (H2).
4. Steer "Run `.agents/setup` and reply with only its last line": `Ready: <URL>` (H3).
5. `stop <id>`; the URL gives 502 and `hatch` exits nonzero with `not_running` (H2). Steer the H4
   prompt and `curl` again (H4). Record the times for setup and resume.

## Gotchas

- The phone opens the preview after one Access login; there is no separate token.
