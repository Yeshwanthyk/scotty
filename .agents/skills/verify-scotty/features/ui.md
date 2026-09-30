# Web UI: create, answer, steer, interrupt on a phone

The phone UI runs the core loop and agrees with the API.

## Behaviours

- **U1** `/`, `/sessions`, `/sessions/create` and `/s/<id>` load the UI on a fresh load and on
  reload; an unknown `/api/*` path returns the Worker's JSON 404.
- **U2** Creating a session on `octocat/Hello-World` opens its page, and the answer appears.
- **U3** A steer is shown as `pending` or `delivered`, then answered in a new turn.
- **U4** Interrupt during a running turn ends it as `aborted`.
- **U5** After reload, the session page and the session list show the same title, repository,
  branch and state as `scotty read <id>`.
- **U6** A turn whose agent ran `scotty-attach` shows each image (tapping opens it full size) and
  each video (plays inline) under its reply.

## Entry points

- Browser at 390×844 on `$SCOTTY_URL`, signed in through Access (a browser step for the owner).
- `curl` with `cf-access-token: $(cloudflared access token -app=$SCOTTY_URL)`; never save the
  token or the header.

## Drive

1. For each of `/`, `/sessions`, `/sessions/create`, `/s/<any id>`, `/api/nope`, record the
   status and content type with `curl` into `01-routes.txt` (U1). For each path from
   `rg -o "/api/[A-Za-z0-9/_.{}$()-]*" ui/src | sort -u`, record its status against a real
   session ID: none may be 404.
2. In the browser open `/sessions`, choose New session, enter `octocat/Hello-World` and the
   prompt "Reply with the word UIMARK1 and nothing else.", and submit. Screenshot the session
   page once the answer contains `UIMARK1` (U2).
3. Steer with "Now reply with UIMARK2." Screenshot the request status, then the answered turn
   (U3).
4. Steer with "Count slowly from 1 to 500, one number per line.", press Interrupt while the turn
   is streaming, and screenshot the turn once it shows `aborted` (U4).
5. Reload the session page, then open `/sessions`. Save `scotty read <id>` into `05-show.json`
   and compare it with both screenshots (U5). Save `scotty log <id>` into `06-log.json`.
6. In a session on `$SCOTTY_HATCH_TEST_REPO`, ask for a screenshot and a short video of the app.
   Screenshot the turn with both, tap the image, and play the video (U6).

If the browser shows an Access login, stop and ask the owner to sign in there.
