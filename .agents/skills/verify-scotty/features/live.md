# Live

An open session page and the session list update by push; nothing polls.

## Behaviours

- **V1** A socket on `/api/sessions/<id>/live` gets a `snapshot` frame first, with `seq`, the
  session view and the conversation.
- **V2** While the turn runs, frames show it `streaming`, then `completed` with the reply; `seq`
  never goes down.
- **V3** A socket on `/api/sessions/live` gets a `session` frame for a new session.
- **V4** `stop <id>` is pushed to both sockets with `authority.stop.reason: "user"`.
- **V5** A new session socket starts from a snapshot whose `seq` is at least the last one seen;
  `rm <id>` sends `removed` on the list socket.

## Entry points

- UI: the session page and the sidebar. API: `GET /api/sessions/live`, `GET
/api/sessions/<id>/live` (WebSockets). e2e: `npm run --silent e2e -- live` (about a minute).

## Drive

1. Open the list socket with the Access token (`cf-access-token`), saving every frame to
   `$EVIDENCE/01-list.jsonl` (V3, V5).
2. Create a scripted session on `_scotty/fixture` with prompt `sleep 5\nsay live-reply`; open its
   socket, saving frames to `02-session.jsonl` until a frame shows the turn completed (V1, V2).
3. `stop <id>`; wait for the stopped frame in both files (V4).
4. Open a second session socket into `03-reconnect.jsonl` and compare its first `seq`; `rm <id>`
   and find `removed` in `01-list.jsonl` (V5).
5. In the UI, open the session page and keep the network panel open: after the first load there
   are no repeating requests to `/api/sessions/<id>` or `/conversation`.

## Gotchas

- A live socket is not use: an open page does not keep a session from sleeping.
- Pushes are coalesced to one per 250 ms, so a burst of events is one frame, not one per event.
- The client sends nothing; any message closes the socket (1008).
