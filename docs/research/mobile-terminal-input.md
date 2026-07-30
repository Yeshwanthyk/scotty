# Mobile terminal input: lag and invisible text

Research snapshot: 2026-07-29. Primary sources only. Scotty source was inspected at
`c01213f34e58bc51e9cc7c4edba7619fe7aca95a`.

## Conclusion

The highest-probability cause is Scotty's pinned `ghostty-web@0.4.0`, not the
Pi Amp frame.

Two upstream changes made after 0.4.0 match the reported symptoms:

1. Mobile text often arrives through `beforeinput` on the focused hidden
   textarea, while 0.4.0 primarily handles `keydown`. Ghostty Web added
   textarea `beforeinput` handling, deletion/line-break mapping, and
   cross-event deduplication in its
   [Android/mobile input fix](https://github.com/coder/ghostty-web/pull/110).
2. In 0.4.0, PTY output is painted only by the next
   `requestAnimationFrame`. Ghostty Web's
   [echo-latency issue](https://github.com/coder/ghostty-web/issues/161)
   documents sluggish visible echo when the browser defers that frame. The
   merged [fix](https://github.com/coder/ghostty-web/pull/179) marks
   user-originated input and synchronously paints only the first subsequent
   write.

Both fixes are absent from the exact 0.4.0 commit Scotty installs
([9e4e126](https://github.com/coder/ghostty-web/tree/9e4e126d89ac3537d2b2ebec075849851566de9f)).
They are present in the published prerelease
`0.4.0-next.20.g1858a59`; npm's stable tag is still 0.4.0. This makes a pinned
prerelease canary safer than assuming an unreleased `main` is production-ready.

The browser asset is not a pristine copy of the stable npm package. Scotty
commit `4ad8963` removed duplicate canvas width/height assignments after
Ghostty's renderer resize because they overwrote its device-pixel-ratio-aware
backing-store dimensions. Do not replace `worker/public/vendor/ghostty-web.js`
blindly. Regenerate the prerelease JS and WASM together, verify that its resize
path preserves the equivalent high-DPI behavior, and forward-port the local
patch if it does not.

## What happens today

Scotty opens Ghostty Web, fits it to `#terminal`, sends every `onData` value as
binary WebSocket input, and paints only bytes that return from the PTY
(`worker/public/terminal.js:266-316`). There is no local text echo:

`iOS textarea -> Ghostty input -> WebSocket -> Cloudflare PTY -> scotty-attach -> Pi TUI -> PTY output -> Ghostty canvas`

That architecture makes two failures look similar:

- If iOS produces `beforeinput` without a usable `keydown`, no byte reaches Pi.
  The keyboard is visible but nothing appears.
- If the byte reaches Pi, the visible character still waits for the network,
  Pi's differential redraw, the return WebSocket frame, and Ghostty's next
  animation frame.

Ghostty Web 0.4.0 does include its initial
[iOS support](https://github.com/coder/ghostty-web/pull/76): tapping the canvas
focuses a 1-by-1 transparent textarea. But the textarea stays at the terminal's
top-left, and `Terminal.focus()` focuses the parent contenteditable element
rather than the textarea
([0.4.0 source](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/terminal.ts#L376-L410),
[focus source](https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/terminal.ts#L700-L723)).
An open Ghostty Web
[IME fix](https://github.com/coder/ghostty-web/pull/120) reports that
composition events can be missed because the textarea is focused while
listeners are attached to the parent. Therefore the prerelease should improve
ordinary soft-keyboard input and echo, but it does not yet prove complete CJK,
dictation, or predictive-text behavior.

Scotty also relies on `100dvh` and Ghostty's debounced `ResizeObserver`; it has
no `visualViewport` handling (`worker/public/terminal.css:465-469`,
`worker/public/terminal.js:303-315`). WebKit explicitly recommends the Visual
Viewport API for moving a custom editing area or caret above the onscreen
keyboard
([Safari 13 notes](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/#visual-viewport-api)).
Ghostty Web's own iOS demo patch used `visualViewport.resize`, changed the
terminal content height, then refit the terminal
([PR 76](https://github.com/coder/ghostty-web/pull/76)).
The API must be throttled: WebKit still has open reports of unreliable keyboard
viewport geometry and excess resize events while touch-scrolling
([191204](https://bugs.webkit.org/show_bug.cgi?id=191204),
[226689](https://bugs.webkit.org/show_bug.cgi?id=226689)).

## Pi redraw interaction

Pi TUI 0.80.10 is authoritative for the editor contents. Each input updates the
focused editor, requests a render, and is coalesced to a minimum 16 ms render
interval. Its differential output is wrapped in DEC synchronized-output
sequences
([TUI source](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/src/tui.ts#L498-L615),
[render source](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/src/tui.ts#L976-L1028)).
That adds one bounded server-side frame, but it does not explain why mobile
input never arrives.

`pi-amp-ui` wraps the stock editor and now reserves the final terminal column
to avoid pending-wrap redraw drift (`worker/container/pi-packages/sources/pi-amp-ui/layout.ts:10-15`).
Keep that guard for the duplicate-frame symptom, but do not change it in the
first mobile-input test. A Pi frame change cannot repair missing browser
`beforeinput` events or Ghostty's deferred canvas paint.

xterm.js is a useful reference for the mature shape of this boundary. It
focuses a real hidden textarea with `preventScroll`, binds keyboard,
`composition*`, and `input` events directly to it, positions it at the terminal
cursor, and renders in-progress composition beside the cursor
([browser terminal](https://github.com/xtermjs/xterm.js/blob/904ae935269eef5ec6a1415b64463c3d02eff1eb/src/browser/CoreBrowserTerminal.ts#L283-L360),
[event wiring](https://github.com/xtermjs/xterm.js/blob/904ae935269eef5ec6a1415b64463c3d02eff1eb/src/browser/CoreBrowserTerminal.ts#L410-L430),
[composition helper](https://github.com/xtermjs/xterm.js/blob/904ae935269eef5ec6a1415b64463c3d02eff1eb/src/browser/input/CompositionHelper.ts#L15-L283)).
Its source specifically calls out aggressive agent-TUI repainting as a reason
to synchronize the textarea before composition. Switching libraries is not a
guaranteed mobile cure, though: xterm.js still tracks
[limited touch UX](https://github.com/xtermjs/xterm.js/issues/5377) and
[iOS IME punctuation loss](https://github.com/xtermjs/xterm.js/issues/5835).

## Ranked options

1. **Canary the exact Ghostty Web prerelease.** Pin
   `0.4.0-next.20.g1858a59`, regenerate the vendored JS/WASM together, and make
   no Pi or layout changes. This contains the merged mobile `beforeinput` path
   and one-shot synchronous echo render. Audit the generated resize path
   against Scotty's `4ad8963` high-DPI fix before replacing the current bundle.
   Revert the dependency and generated assets as one unit if the canary
   regresses.
2. **Add keyboard-aware viewport fitting.** On `visualViewport.resize` and
   `scroll`, set the terminal workspace to the stable visible height, refit
   once per animation frame, and send one PTY resize after dimensions settle.
   This addresses the editor being behind the keyboard, not dropped input.
3. **Add a visible mobile input tray.** A native textarea above the keyboard
   gives immediate local feedback, plus `Esc`, `Ctrl`, `Tab`, arrows, Paste,
   and Send. Send the committed text as bracketed paste; keep a separate
   "Terminal keys" mode for raw interaction. Do not draw speculative characters
   into the terminal canvas because Pi may transform input, disable echo, or be
   composing.
4. **Evaluate xterm.js behind the same transport contract.** It has a much more
   complete textarea/IME architecture, but the migration changes rendering,
   selection, scrolling, and terminal compatibility. Treat it as a fallback
   spike, not the first fix.
5. **Long term: mobile Pi composer over RPC.** Use a transcript/composer UI for
   ordinary prompts and retain the raw terminal as an advanced view. This gives
   the best phone UX but is a product boundary change, not a terminal patch.

## Smallest vertical slice

Change only the Ghostty dependency and its generated browser assets to the exact
prerelease. Add a tiny browser harness that stubs the WebSocket and asserts:

1. `beforeinput(insertText)`, line break, and backspace each emit exactly once.
2. A `keydown` plus matching `beforeinput` is deduplicated.
3. The first output write after user input paints synchronously once; later bulk
   output stays on the normal render loop.
4. Tapping the canvas focuses the textarea and opens the software keyboard on a
   real iPhone.
5. At device-pixel ratios 1, 2, and 3, the backing-store dimensions scale with
   DPR while the CSS dimensions stay stable; glyphs remain sharp and uncropped
   after a fit, font change, rotation, and keyboard open/close.

Do not include `visualViewport`, the mobile tray, or another Pi wrap patch in
this slice. If ordinary typing becomes visible and responsive, add viewport
fitting next. If it still fails, capture the actual `keydown`, `beforeinput`,
`input`, `composition*`, WebSocket-send, WebSocket-return, and paint timestamps
before changing renderers.

## Mobile acceptance tests

- On iPhone Safari and Chrome, tap once, type `scotty 123` slowly, backspace
  twice, and type `45`. The Pi editor must show the exact final text before
  submit, with no dropped or duplicated characters.
- Measure key event to first matching canvas paint. On stable Wi-Fi, p95 should
  be no more than observed WebSocket round-trip time plus 50 ms, with no
  half-second stalls.
- Test autocorrect off, autocorrect on, dictation, emoji, paste, and one CJK IME.
  Composition text must be visible or the UI must explicitly show a local
  composing surface.
- Open and close the software keyboard, rotate, and resize split-screen. The Pi
  editor and cursor must remain above the keyboard; PTY dimensions must settle
  without resize loops or lost input.
- At 320 px width, type through two wraps, backspace across the wrap, submit,
  and stream output. No duplicate frame, stale border, last-column wrap, or
  scroll jump is acceptable.

## UI/UX recommendations

On phones, show a clear `Tap to type` affordance over the terminal until the
textarea is focused, then change it to `Keyboard active`. Keep connection state
separate from input focus so "Connected" never implies keystrokes are being
accepted.

After the canary, prioritize the visible mobile input tray. Raw terminal input
is optimized for hardware keyboards; a local composer makes typed text,
autocorrect, dictation, and editing legible immediately, while the accessory
keys preserve the terminal actions users still need.
