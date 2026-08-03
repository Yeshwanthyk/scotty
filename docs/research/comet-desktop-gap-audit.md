# Comet → Scotty Desktop presentation gap audit

Audited Comet [`d8ca6de`](https://github.com/zeronsh/comet/tree/d8ca6de11ee525541f6f74b1254432993d24ab2d) against Scotty Desktop on `feat/desktop-codex-orchestrator`.

## Boundary

Adopt presentation mechanics only. Keep Scotty's existing authority chain:

```text
Rust GPUI viewport → bounded desktop protocol v2 → Bun sidecar
→ fenced Pi Console → Sandbox Durable Object
```

Do not import Comet's engine, Loro documents, RPC, durable command queue, terminal ownership, account/auth, device rooms, sync, or document state. Comet's topology makes those foundational rather than reusable UI utilities ([architecture](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/ARCHITECTURE.md), [engine](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/engine/src/lib.rs)).

## Current status

Scotty now has:

- bounded Markdown parsing for assistant and reasoning messages;
- headings, emphasis, strong text, lists, quotes, code blocks, links, and task markers;
- individually expandable tool rows;
- Rust-local expansion state keyed by session and stable tool ID;
- compact collapsed rows and bounded expanded input/output;
- virtualized transcript rows, passive session switching, unseen counts, and jump-to-latest.

## Prioritized gaps

| Priority | Gap                                                                                                                                       | Comet source                                                                                                                                                                                                                                                                                                                                                                                                                | Scotty-safe adaptation                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Real native multiline composer: caret, range selection, IME, undo/redo, clipboard, word navigation, mouse selection, internal scrolling   | [`composer.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/composer.rs)                                                                                                                                                                                                                                                                                                   | Extract only GPUI input mechanics into a Scotty-owned editor. Keep drafts in Rust and submit through existing fenced commands.                           |
| P1       | Stable block-level transcript rows and minimal streaming splices                                                                          | [`transcript.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/transcript.rs)                                                                                                                                                                                                                                                                                               | Derive local display rows keyed by `(TranscriptItem.id, block_index)`; do not add protocol state.                                                        |
| P1       | Interaction-grade Markdown: text selection, code copy, horizontal code scroll, language labels, syntax color, half-streamed marker repair | [`markdown/render.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/markdown/render.rs), [`markdown/mend.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/markdown/mend.rs), [`markdown/selection.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/markdown/selection.rs) | Extend Scotty's small parser/renderer. Keep all content bounded and raw HTML inert.                                                                      |
| P1       | Consecutive tool grouping with aggregate count/status and one fold                                                                        | [`transcript.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/transcript.rs)                                                                                                                                                                                                                                                                                               | Group adjacent projected tools locally. Auto-open live groups; preserve an explicit user override. Keep individual tool IDs/statuses.                    |
| P1       | Pending questions integrated into the composer                                                                                            | [`composer.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/composer.rs)                                                                                                                                                                                                                                                                                                   | Reuse the native editor for Scotty `Input`/`Editor`; add keyboard choices for existing `Select`/`Confirm`; answer only through fenced protocol commands. |
| P2       | Sidebar resizing/collapse, titlebar navigation, richer loading/empty/error states                                                         | [`shell.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/shell.rs), [`loaders.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/loaders.rs)                                                                                                                                                                                | Add Rust-local layout state and retry affordances; do not turn navigation into lifecycle authority.                                                      |
| P2       | Appearance/shortcut/notification settings                                                                                                 | [`settings.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/settings.rs), [`sound.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/sound.rs)                                                                                                                                                                              | Local settings only: theme, shortcuts, layout, completion/waiting sounds. No accounts or runtime settings.                                               |
| P2       | Reduced-motion-aware panel, notice, streaming, and follow animation                                                                       | [`motion.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/motion.rs)                                                                                                                                                                                                                                                                                                       | Add a small Scotty motion layer after row identity is stable.                                                                                            |
| P2       | Complete native Edit/View/About menus                                                                                                     | [`app_menus.rs`](https://github.com/zeronsh/comet/blob/d8ca6de11ee525541f6f74b1254432993d24ab2d/crates/ui/src/app_menus.rs)                                                                                                                                                                                                                                                                                                 | Add clipboard actions after the native editor and local View/Appearance actions.                                                                         |

## Recommended order

1. Native input correctness.
2. Stable Markdown display rows plus code copy/selection.
3. Consecutive tool grouping.
4. Pending-input composer replacement.
5. Sidebar/shell states and settings.
6. Streaming motion and notifications.

## Reuse and provenance

Comet is MIT-licensed, and both projects use the same GPUI fork/revision. Scotty's checked-in provenance currently pins Comet `b033110…`; copying code or assets introduced by `d8ca6de…` requires updating `desktop/COMET_UPSTREAM.md`, `desktop/comet-provenance.json`, notices, and blob checks before merge. Presentation recipes may instead be rewritten as Scotty-owned code without importing Comet runtime types.
