# Scotty browser terminal assets

`terminal.html` is a standalone browser client for the raw Cloudflare Sandbox terminal WebSocket protocol. The Worker is expected to serve it at `/s/:id`, authenticate the initial `?t=` request, set a `Secure; HttpOnly; SameSite` cookie, and redirect to the token-free URL before returning the page. The client never extracts, stores, sends, or logs an authentication token. A defensive head script only removes a stray `t` query key before subresources can load.

The page assumes these same-origin endpoints:

- `GET /api/sessions` returns either an array of session projections or `{ "sessions": [...] }` with `id` and `status` fields.
- `POST /api/sessions/:id/resume` starts restore/resume and returns a successful HTTP status when accepted.
- `GET /api/sessions/:id/pty?cols=N&rows=N` upgrades to the Sandbox terminal WebSocket using the HttpOnly cookie.

The WebSocket uses binary UTF-8 in both directions for terminal I/O. Text frames are JSON controls: server `ready`, `exit`, and `error`; client `resize`. Buffered binary output is rendered even when it arrives before `ready`. Input is only sent after `ready`.

## Vendored Ghostty Web

`vendor/ghostty-web/` is copied from the published `ghostty-web@0.4.0` npm package (MIT, integrity `sha512-0puDBik2qapbD/QQBW9o5ZHfXnZBqZWx/ctBiVtKZ6ZLds4NYb+wZuw1cRLXZk9zYovIQ908z3rvFhexAvc5Hg==`). The ESM distribution embeds the Ghostty WASM payload and also probes the adjacent `ghostty-vt.wasm` as a fallback, so both files are kept local. `__vite-browser-external-2447137e.js` is the package's browser shim used by its fallback loader. No CDN or runtime package registry request is used.

Serve `.js` as JavaScript and `.wasm` as `application/wasm`. If the package is upgraded, replace the three runtime files and `LICENSE` together, then recheck the `init`, `Terminal`, and `FitAddon` exports.
