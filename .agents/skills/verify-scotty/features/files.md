# Files the agent makes, in chat

The agent runs `scotty-attach <file> [caption]` in the container. The file goes to R2, then a
`file.attached` event puts it in the current turn of the conversation.

## Behaviours

- **F1** Asked for a screenshot and a video, the agent installs Chromium on demand, captures both
  and attaches them: that turn's `files` has one `image/png` and one `video/webm`.
- **F2** `GET /api/sessions/<id>/files/<file>` answers 200 with the stored type and the event's
  size; the PNG starts with the PNG signature, the webm with `1A 45 DF A3`.
- **F3** A type off the list gets 415, over 25 MB gets 413, and neither writes an event.
- **F4** After `stop`, both files still list and download (they come from R2).

## Entry points

- CLI `scotty new | read --last 3 --role assistant | steer | stop | log`; `read` lists each file as
  `name (type, N bytes) <url>`. e2e: `npm run --silent e2e -- files`.

## Drive

1. Create a session on `$SCOTTY_HATCH_TEST_REPO` with "Start the dev server, take a 390×844
   screenshot of the page and a 5 second video of clicking the counter, and attach both to this
   chat."; read until completed and record the time (F1).
2. `curl` each file URL from `read` with the Access header; save the status, `content-type`, size
   and first bytes (`xxd -l 8`) into `02-files.txt`, not the files' contents in evidence (F2).
3. Steer two `curl -X PUT http://files.internal/` commands (a `text/plain` body; 25 MB + 1 byte of
   `image/png`) and ask for only the status codes; `log <id>` has no new `file.attached` (F3).
4. `stop <id>`, then repeat step 2 (F4). Check them on the phone with [ui](ui.md) U6.

## Gotchas

- The first capture in a session includes the Chromium install (a few minutes). The capture
  folder is outside the repository, so a resumed session installs it again.
