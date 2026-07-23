# Scotty browser terminal assets

`terminal.html` is a standalone browser client for the raw Cloudflare Sandbox terminal WebSocket protocol. The Worker serves it at `/s/:id` only after registered-browser authentication. During migration, an old root-token cookie or `?t=` bootstrap link is exchanged once for an independent `Secure; HttpOnly; SameSite=Strict` browser credential and redirected to the clean URL. The client never reads the browser credential.

`devices.html` is the administrator-only registered-browser manager. It creates five-minute one-use pairing links and renders their QR matrix locally. `pair.html` removes the link fragment before consuming it and receives a browser-specific credential cookie.

The page assumes these same-origin endpoints:

- `GET /api/sessions` returns either an array of session projections or `{ "sessions": [...] }` with `id` and `status` fields.
- `POST /api/sessions/:id/resume` starts restore/resume and returns a successful HTTP status when accepted.
- `POST /api/sessions/:id/pty-ticket` uses the HttpOnly cookie to mint a five-minute one-use ticket.
- `GET /api/sessions/:id/pty?cols=N&rows=N&ticket=…` atomically consumes that ticket and upgrades to the Sandbox terminal WebSocket.

The WebSocket uses binary UTF-8 in both directions for terminal I/O. Text frames are JSON controls: server `ready`, `exit`, and `error`; client `resize`. Buffered binary output is rendered even when it arrives before `ready`. Input is only sent after `ready`.

On phone-sized viewports, the client uses a native textarea composer for agent prompts. The browser handles selection, paste, dictation, autocorrection, and IME composition; submitting pastes the complete draft through Ghostty's bracketed-paste support, sends Enter, and dismisses the software keyboard. The composer and compact terminal-key tray overlay the terminal instead of changing its geometry. Software-keyboard height changes clip the stable PTY viewport rather than reflowing the remote TUI, and new output preserves manual scrollback until the reader taps `Latest`. The keyboard button exposes exactly four one-tap controls: Esc, Tab, Ctrl-C, and Enter.

## Vendored Ghostty Web

`vendor/ghostty-web/` is copied from the published `ghostty-web@0.4.0` npm package (MIT, integrity `sha512-0puDBik2qapbD/QQBW9o5ZHfXnZBqZWx/ctBiVtKZ6ZLds4NYb+wZuw1cRLXZk9zYovIQ908z3rvFhexAvc5Hg==`). The ESM distribution embeds the Ghostty WASM payload and also probes the adjacent `ghostty-vt.wasm` as a fallback, so both files are kept local. `__vite-browser-external-2447137e.js` is the package's browser shim used by its fallback loader. No CDN or runtime package registry request is used.

Serve `.js` as JavaScript and `.wasm` as `application/wasm`. If the package is upgraded, replace the three runtime files and `LICENSE` together, then recheck the `init`, `Terminal`, and `FitAddon` exports.
